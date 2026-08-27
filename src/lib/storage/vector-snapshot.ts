/**
 * Blob-backed read-through snapshot cache for the flattened vector index (D3-18, plan 03-07).
 *
 * Built because the measured numbers called for it, not speculatively:
 *   - `03-COLDSTART.md` — Neon's HTTP transport FAILS OUTRIGHT (HTTP 507, hard 64MiB response
 *     cap) at the product's 20,000-chunk target scale; the WebSocket transport completes but
 *     misses the pre-registered 3000ms p95 budget (p95 6478.52ms).
 *   - `scripts/blob-put-spike.mts` — `@vercel/blob`'s `put()` CAN write a ~60MB
 *     internally-generated buffer (RESEARCH assumption A2, now closed empirically).
 *
 * Re-measured after being built and wired in (`03-COLDSTART.md`'s "Snapshot-warm cold rebuild"
 * section, `scripts/measure-coldstart.mts --snapshot-only`): a steady-state cold rebuild served
 * from a warm snapshot measured p95 3168.35ms at 20,000 chunks — a ~51% reduction from the raw
 * WebSocket-transport number (6478.52ms), but STILL a marginal FAIL against the pre-registered
 * 3000ms budget (168.35ms / 5.6% over). Reported honestly, not rounded down to a pass: this is
 * the best number this mitigation produces, and D3-18's "documented mitigation" allowance is why
 * it still satisfies the requirement despite not clearing the budget outright — see
 * `03-COLDSTART.md`'s "Road taken" section for the full reasoning.
 *
 * Writes the flattened `Float32Array` plus its parallel `chunkIds` array as ONE binary object,
 * keyed by kb id and stamped with the generation counter it was built from — the SAME counter
 * `getVectorIndex`'s in-memory cache already keys on (`upsertChunks`/`deleteDocument` bump it),
 * so there is one invalidation concept, not two. Read back via `get(pathname, { access: "private"
 * })` and `arrayBuffer()` — no JSON, no hex encoding, no per-row round trip. The store is PRIVATE
 * (verified live against the real store, RESEARCH.md's "Live cloud verification" section); this
 * module is server-only and never hands a snapshot URL to a browser (T-03-07-03).
 *
 * A pure optimization, never a source of truth: `readSnapshot` returns `null` on ANYTHING other
 * than a fully-valid, current-generation snapshot — a missing object, a network failure, a
 * corrupted/truncated payload, or a stale generation all fall through to the same `null`, and
 * `vector-index.ts`'s caller falls through to the real Postgres rebuild silently (T-03-07-02).
 * `writeSnapshot` never throws either — a failed write must not turn a successful Postgres
 * rebuild into a failed request.
 */

import { del, get, list, put } from "@vercel/blob";
import { PRODUCT_CONFIG } from "../config.js";
import { resolveBlobAuth } from "./blob-auth.js";

/** ASCII "KDSN" (KyzerDocs Snapshot) as a little-endian uint32 — a cheap structural check that
 * rejects garbage before any length-derived slicing runs. */
const SNAPSHOT_MAGIC = 0x4e53444b;
const HEADER_BYTES = 5 * 4; // magic, generation, dim, chunk count, ids-json byte length — all uint32

export interface VectorSnapshotPayload {
  generation: number;
  dim: number;
  chunkIds: string[];
  flatCorpus: Float32Array;
}

/** The snapshot's Blob KEY includes the generation counter (plan 03-07's own acceptance
 * criterion) — `vector-snapshots/{kbId}/{generation}.bin`, not one fixed pathname per kb. This
 * means a stale-generation read is a plain 404 from `get()` (no object at that exact key), and
 * `readVectorSnapshot`'s embedded-generation check inside the payload is a second, redundant
 * integrity check rather than the ONLY thing preventing a stale read. */
function snapshotPathname(kbId: string, generation: number): string {
  return `vector-snapshots/${encodeURIComponent(kbId)}/${generation}.bin`;
}

/**
 * Packs `payload` into one `Buffer`: a fixed-size header (magic, generation, dim, chunk count,
 * ids-JSON byte length), the ids array JSON-encoded (small — ~tens of bytes per id, negligible
 * next to the float data), then the RAW `Float32Array` bytes with zero re-encoding. The float
 * section is the ~99% of this payload's size and is never JSON/hex — that is the entire point of
 * this cache versus the Postgres HTTP path it replaces.
 */
export function encodeVectorSnapshot(payload: VectorSnapshotPayload): Buffer {
  const idsJson = Buffer.from(JSON.stringify(payload.chunkIds), "utf8");
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt32LE(SNAPSHOT_MAGIC, 0);
  header.writeUInt32LE(payload.generation >>> 0, 4);
  header.writeUInt32LE(payload.dim >>> 0, 8);
  header.writeUInt32LE(payload.chunkIds.length >>> 0, 12);
  header.writeUInt32LE(idsJson.byteLength >>> 0, 16);
  const floatBytes = Buffer.from(
    payload.flatCorpus.buffer,
    payload.flatCorpus.byteOffset,
    payload.flatCorpus.byteLength,
  );
  return Buffer.concat([header, idsJson, floatBytes]);
}

/**
 * Inverse of `encodeVectorSnapshot`. Throws (never returns a partially-valid result) on ANY
 * structural inconsistency — bad magic, a truncated ids section, a chunk-count mismatch, or a
 * float section that isn't exactly `size * dim * 4` bytes. Every throw here is a corruption
 * signal `readSnapshot` turns into a silent `null`, per this file's header.
 */
export function decodeVectorSnapshot(buf: Buffer): VectorSnapshotPayload {
  if (buf.byteLength < HEADER_BYTES) {
    throw new Error(`snapshot too short to contain a header: ${buf.byteLength} bytes`);
  }
  const magic = buf.readUInt32LE(0);
  if (magic !== SNAPSHOT_MAGIC) {
    throw new Error(`bad snapshot magic: 0x${magic.toString(16)}`);
  }
  const generation = buf.readUInt32LE(4);
  const dim = buf.readUInt32LE(8);
  const chunkCount = buf.readUInt32LE(12);
  const idsByteLength = buf.readUInt32LE(16);

  const idsStart = HEADER_BYTES;
  const idsEnd = idsStart + idsByteLength;
  if (buf.byteLength < idsEnd) {
    throw new Error(`snapshot truncated before ids section end (${idsEnd} > ${buf.byteLength})`);
  }

  let chunkIds: unknown;
  try {
    chunkIds = JSON.parse(buf.subarray(idsStart, idsEnd).toString("utf8"));
  } catch (cause) {
    throw new Error(`snapshot ids section is not valid JSON: ${String(cause)}`);
  }
  if (!Array.isArray(chunkIds) || chunkIds.length !== chunkCount || !chunkIds.every((id) => typeof id === "string")) {
    throw new Error("snapshot ids section did not decode to a string[] of the declared length");
  }

  const floatStart = idsEnd;
  const expectedFloatBytes = chunkCount * dim * 4;
  const floatSection = buf.subarray(floatStart, floatStart + expectedFloatBytes);
  if (floatSection.byteLength !== expectedFloatBytes) {
    throw new Error(
      `snapshot float section is ${floatSection.byteLength} bytes, expected ${expectedFloatBytes} (${chunkCount} x ${dim} x 4)`,
    );
  }

  // Float32Array requires its buffer offset to be a multiple of 4 — Buffer.subarray() preserves
  // the parent's alignment only when floatStart is itself a multiple of 4, which it always is
  // here (HEADER_BYTES and idsByteLength are both under our own control as uint32 lengths, but
  // guard explicitly rather than assume).
  if (floatSection.byteOffset % 4 !== 0) {
    const aligned = Buffer.from(floatSection); // copies onto a fresh, 4-aligned buffer
    return { generation, dim, chunkIds, flatCorpus: new Float32Array(aligned.buffer, aligned.byteOffset, chunkCount * dim) };
  }

  const flatCorpus = new Float32Array(floatSection.buffer, floatSection.byteOffset, chunkCount * dim);
  return { generation, dim, chunkIds, flatCorpus };
}

/**
 * Writes `payload` to this kb+generation's snapshot object (a NEW key every generation bump, per
 * this file's own key-includes-generation contract), then best-effort deletes EVERY other
 * generation's object for this kb.
 *
 * Deleting only `generation - 1` was not enough and leaked in practice. The generation counter
 * advances on every corpus change, but a snapshot is only written when a rebuild actually happens —
 * so generations are routinely skipped, and each skipped one leaves an object nothing will ever
 * delete. A real deployment was found holding snapshots for generations 1, 10, 23 and 63 with only
 * 63 current: 62MB of dead objects at 20k chunks, growing silently on the buyer's storage bill
 * (03-UAT F10).
 *
 * Still best-effort and never awaited-into-correctness: a failed cleanup leaves harmless extra
 * objects (never served, since reads target the CURRENT generation's exact key), not a bug. The
 * main write never throws either — a failed write is a lost optimization, not a failed rebuild,
 * since the caller already has the correct in-memory result from the Postgres rebuild that just
 * completed.
 */
export async function writeVectorSnapshot(kbId: string, payload: VectorSnapshotPayload): Promise<void> {
  const auth = resolveBlobAuth();
  if (!auth) return; // no Blob credentials of any kind — nothing to write to.
  try {
    const buf = encodeVectorSnapshot(payload);
    await put(snapshotPathname(kbId, payload.generation), buf, {
      access: "private",
      ...auth,
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "application/octet-stream",
    });
  } catch {
    // Pure optimization — swallow. A future rebuild will simply miss the snapshot and pay the
    // Postgres cost again, which is exactly today's (pre-snapshot) behavior.
    return;
  }
  try {
    // List this kb's snapshots and drop everything that is not the generation just written. A
    // prefix list is one extra round trip on a path that already moved tens of megabytes, and it
    // is the only way to catch generations that were skipped rather than superseded.
    const existing = await list({ prefix: `vector-snapshots/${encodeURIComponent(kbId)}/`, ...auth });
    const keep = snapshotPathname(kbId, payload.generation);
    await Promise.all(
      existing.blobs
        .filter((b) => b.pathname !== keep)
        .map((b) => del(b.url, { ...auth }).catch(() => undefined)),
    );
  } catch {
    // best-effort — a failed sweep leaves harmless extra objects, never read.
  }
}

/**
 * Reads the kb+generation-exact snapshot object and returns it ONLY if it decodes cleanly AND its
 * embedded generation matches `expectedGeneration` (a second, redundant check — the key itself
 * already targets the exact generation, so this also guards against a key/payload mismatch bug).
 * Returns `null` for every other outcome — no object at that key (the normal case for a stale or
 * not-yet-written generation), a network/auth failure, or a decode error — so the caller's
 * fallback to the real Postgres rebuild is always silent and never distinguishes "corrupt" from
 * "just not there yet" (T-03-07-02: neither should ever surface as an error to a caller).
 */
export async function readVectorSnapshot(kbId: string, expectedGeneration: number): Promise<VectorSnapshotPayload | null> {
  const auth = resolveBlobAuth();
  if (!auth) return null;
  try {
    const got = await get(snapshotPathname(kbId, expectedGeneration), { access: "private", ...auth, useCache: false });
    if (!got || got.statusCode !== 200 || !got.stream) return null;
    const buf = Buffer.from(await new Response(got.stream).arrayBuffer());
    const payload = decodeVectorSnapshot(buf);
    if (payload.generation !== expectedGeneration) return null; // key/payload mismatch — treat as absent
    return payload;
  } catch {
    return null;
  }
}

/** Best-effort delete of a kb's snapshot object at a specific generation (defaults to the most
 * recently written one is NOT assumed — callers must pass the generation explicitly). Used by
 * measurement/test cleanup, never on the hot path (the write path's own previous-generation
 * cleanup handles production lifecycle). Never throws; a leftover snapshot is harmless — it is
 * only ever served by an exact-generation key match. */
export async function deleteVectorSnapshot(kbId: string, generation: number): Promise<void> {
  const auth = resolveBlobAuth();
  if (!auth) return;
  try {
    await del(snapshotPathname(kbId, generation), { ...auth });
  } catch {
    // best-effort
  }
}
