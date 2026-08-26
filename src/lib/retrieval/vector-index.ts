/**
 * RET-02 in-memory vector index lifecycle — the risk this plan actually targets, not cosine
 * compute (see `.planning/research/ARCHITECTURE.md` Pattern 1). Rebuilding the index on every
 * query would pass every correctness test and still be unusable; this module builds lazily on
 * first request, caches the result across queries, and invalidates only when the storage
 * driver's per-KB generation counter (RET-02, `02-02-SUMMARY.md`) moves.
 *
 * The array-packing-plus-assertion internals port the pattern from
 * `evals/src/ladder/lite-pipeline.ts`'s `buildLiteIndex` (lines 46-83) — that function lacks a
 * lifecycle (it rebuilds every call); this module adds exactly that, and nothing else.
 *
 * D2-02: normalization is mandatory at index-build time, not just at ingest or in the eval
 * harness. Every vector loaded here is checked for dimension and passes `assertNormalized`
 * before it enters the corpus — a normalization regression must throw here, loudly, as
 * `KDL-EMBED-003`, naming the offending chunk, rather than silently degrading every cosine score
 * computed against this index.
 *
 * REVISED (plan 03-07, D3-18): the "never persist" stance below was written when this was an
 * estimate. It has been measured since, and the number changed the decision: a genuinely cold
 * rebuild at the product's 20,000-chunk target scale measured p95 6478.52ms over Neon's WebSocket
 * transport against a pre-registered 3000ms budget (HTTP fails outright at this scale — see
 * `pg-client.ts`'s header). `src/lib/storage/vector-snapshot.ts` — a Blob-backed read-through
 * cache, invalidated on the SAME generation counter this module's in-memory cache already uses —
 * was added on the strength of that specific number, not speculatively. The original reasoning
 * below is preserved because it is still correct about what this module does NOT become: a
 * second, independent invalidation surface. A snapshot miss/corruption/staleness always falls
 * through to exactly the code path described next, silently.
 *
 * The built index was never persisted to disk or an external store prior to 03-07 —
 * ARCHITECTURE.md Pattern 1 reasoned that reserializing tens of thousands of vectors would not be
 * meaningfully faster than reading rows back from the driver and rebuilding, on the assumption
 * that the driver read itself was fast. That assumption is what 03-COLDSTART.md's numbers
 * refuted for the HTTP transport (which cannot complete the read at all past a hard platform size
 * cap) and complicated for WebSocket (which completes, but not within budget). A cold rebuild
 * from the driver must always REMAIN correct on its own — Phase 3's cloud/serverless mode has no
 * other ultimate source of truth — the snapshot is additive, not a replacement.
 */

import { PRODUCT_CONFIG } from "../config.js";
import { AppError } from "../errors.js";
import { getStorageDriver } from "../storage/index.js";
import type { StorageDriver } from "../storage/index.js";
import { readVectorSnapshot, writeVectorSnapshot } from "../storage/vector-snapshot.js";
import { assertNormalized } from "./normalize.js";

export interface VectorIndex {
  flatCorpus: Float32Array;
  chunkIds: string[];
  dim: number;
  generation: number;
  size: number;
}

const DIM = PRODUCT_CONFIG.embedding.outputDimensionality;

/** Module-level cache, one entry per knowledge base id — never shared across kb ids (T-02-06-03).
 * Lazily populated; nothing runs at module load or process start. */
const cache = new Map<string, VectorIndex>();

/** Last real cold-rebuild duration observed by THIS process, in milliseconds — a measurement of
 * this deployment, never a copy of `03-COLDSTART.md`'s benchmark numbers (UI-STANDARDS.md S-5).
 * `null` until the first rebuild happens; `GET /api/health` (plan 03-07, Task 3) omits its
 * `indexRebuild` field entirely while this is `null`, rather than inventing a placeholder. */
let lastRebuildDurationMs: number | null = null;

/** Read by `GET /api/health` — see this file's header comment on `lastRebuildDurationMs`. */
export function getLastRebuildDurationMs(): number | null {
  return lastRebuildDurationMs;
}

/** Test-only reset — mirrors `invalidateVectorIndex()`'s existing test-support role. */
export function resetLastRebuildDurationMsForTests(): void {
  lastRebuildDurationMs = null;
}

/** Packs driver rows into one flat `Float32Array` plus a parallel `chunkIds` array, asserting
 * each row's byte length and unit-norm before it enters the corpus (D2-02). Throws
 * `AppError("KDL-EMBED-003")` naming the offending chunk on ANY failure — this is the
 * authoritative validation path for data read directly from Postgres, so it must be loud, unlike
 * a snapshot decode failure (see `readVectorSnapshot`'s caller below, which treats the equivalent
 * failure as a silent cache miss instead). */
function packAndValidateRows(rows: { id: string; embedding: Buffer }[]): { flatCorpus: Float32Array; chunkIds: string[] } {
  const expectedBytes = DIM * 4;
  const flatCorpus = new Float32Array(rows.length * DIM);
  const chunkIds: string[] = new Array(rows.length);

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;

    if (row.embedding.byteLength !== expectedBytes) {
      throw new AppError("KDL-EMBED-003", {
        message: `Chunk ${row.id} has ${row.embedding.byteLength} embedding bytes, expected ${expectedBytes} (${DIM} dims x 4 bytes).`,
      });
    }

    const vector = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, DIM);
    try {
      assertNormalized(vector);
    } catch (err) {
      throw new AppError("KDL-EMBED-003", {
        message: `Chunk ${row.id} failed its normalization check — a stored vector was not unit-length.`,
        cause: err,
      });
    }

    flatCorpus.set(vector, i * DIM);
    chunkIds[i] = row.id;
  }

  return { flatCorpus, chunkIds };
}

/**
 * Returns the cached vector index for `kbId`, rebuilding it first if this is the first request
 * for that kb id or the storage driver's generation counter has moved since the cached index was
 * built. Never rebuilds on every call — that is exactly the query-time cost this module exists
 * to eliminate.
 *
 * `driverOverride` (plan 03-07, D3-18): defaults to the process-wide `getStorageDriver()`
 * singleton for every real caller. `scripts/measure-coldstart.mts` is the one caller that passes
 * an explicit driver — it needs to time a cold rebuild against BOTH Neon transports in the same
 * process, and `getStorageDriver()`'s singleton is pinned to `DEFAULT_PG_TRANSPORT` with no way to
 * select a transport per call. Passing a driver built for a specific transport (via
 * `createPgClient(url, transport)`) exercises this exact production code path — the same
 * byte-length/normalization assertions below run either way — without duplicating this function's
 * packing loop in the measurement script.
 */
export async function getVectorIndex(kbId: string, driverOverride?: StorageDriver): Promise<VectorIndex> {
  const driver = driverOverride ?? getStorageDriver();
  const currentGeneration = await driver.getGeneration(kbId);

  const cached = cache.get(kbId);
  if (cached && cached.generation === currentGeneration) {
    return cached;
  }

  const rebuildStart = performance.now();

  // Snapshot read-through (D3-18, plan 03-07): only attempted in cloud mode, and only ever a
  // pure optimization — see vector-snapshot.ts's header for the full silent-fallback contract.
  // Even a structurally-valid snapshot still runs through packAndValidateRows-equivalent
  // assertions below (assertNormalized per row) before being trusted, via the try/catch: a
  // snapshot that decodes cleanly but carries corrupted FLOAT bytes (not caught by
  // decodeVectorSnapshot's structural checks alone) must still fall through to Postgres, silently
  // — never surface as KDL-EMBED-003 to a caller, since that code path is reserved for genuine
  // Postgres-sourced corruption (the actual source of truth).
  if (PRODUCT_CONFIG.cloudMode) {
    const snapshot = await readVectorSnapshot(kbId, currentGeneration);
    if (snapshot) {
      try {
        for (let i = 0; i < snapshot.chunkIds.length; i++) {
          const vector = snapshot.flatCorpus.subarray(i * DIM, (i + 1) * DIM);
          assertNormalized(vector);
        }
        const index: VectorIndex = {
          flatCorpus: snapshot.flatCorpus,
          chunkIds: snapshot.chunkIds,
          dim: snapshot.dim,
          generation: currentGeneration,
          size: snapshot.chunkIds.length,
        };
        cache.set(kbId, index);
        lastRebuildDurationMs = performance.now() - rebuildStart;
        return index;
      } catch {
        // Corrupted snapshot bytes (T-03-07-02) — fall through to the real Postgres rebuild
        // below, silently. Deliberately NOT re-thrown: this is a cache failure, not a data
        // failure.
      }
    }
  }

  const rows = await driver.getAllChunkVectors(kbId);
  const { flatCorpus, chunkIds } = packAndValidateRows(rows);

  const index: VectorIndex = {
    flatCorpus,
    chunkIds,
    dim: DIM,
    generation: currentGeneration,
    size: rows.length,
  };
  cache.set(kbId, index);
  lastRebuildDurationMs = performance.now() - rebuildStart;

  if (PRODUCT_CONFIG.cloudMode) {
    // Written AFTER the caller already has a correct in-memory result — a failed or slow write
    // never blocks this request from returning, but IS awaited so the write is durable before
    // this (potentially short-lived serverless) invocation ends, benefiting every future cold
    // start until the next generation bump.
    await writeVectorSnapshot(kbId, { generation: currentGeneration, dim: DIM, chunkIds, flatCorpus });
  }

  return index;
}

/** Drops the cached index for `kbId`, or every cached index when called with no argument. Used
 * by tests and by an explicit re-index flow (e.g. after an embedding model change, D2-10) — the
 * normal write path never needs this, since the generation counter check above already picks up
 * every `upsertChunks`/`deleteDocument`. */
export function invalidateVectorIndex(kbId?: string): void {
  if (kbId) {
    cache.delete(kbId);
  } else {
    cache.clear();
  }
}
