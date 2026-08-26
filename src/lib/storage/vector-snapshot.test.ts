import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeVectorSnapshot, encodeVectorSnapshot, type VectorSnapshotPayload } from "./vector-snapshot.js";

/** Hoisted, per `vi.mock`'s own requirement that anything its factory references must be created
 * inside `vi.hoisted` — `vi.mock` calls are hoisted above regular `const` declarations by
 * vitest's transform, so a plain `const` object of `vi.fn()`s declared below a `vi.mock` call
 * would hit a temporal-dead-zone error (same pattern `vector-index.test.ts` uses). */
const blobMocks = vi.hoisted(() => ({
  put: vi.fn(),
  get: vi.fn(),
  del: vi.fn(),
}));

vi.mock("@vercel/blob", () => ({
  put: (...args: unknown[]) => blobMocks.put(...args),
  get: (...args: unknown[]) => blobMocks.get(...args),
  del: (...args: unknown[]) => blobMocks.del(...args),
}));

const DIM = 768;

function makeNormalizedVector(seed: number): Float32Array {
  const v = new Float32Array(DIM);
  for (let i = 0; i < DIM; i++) v[i] = Math.sin(i + seed) + 2;
  let sumSquares = 0;
  for (let i = 0; i < v.length; i++) sumSquares += v[i]! * v[i]!;
  const norm = Math.sqrt(sumSquares);
  for (let i = 0; i < v.length; i++) v[i] = v[i]! / norm;
  return v;
}

function makePayload(chunkCount: number, generation = 3): VectorSnapshotPayload {
  const flatCorpus = new Float32Array(chunkCount * DIM);
  const chunkIds: string[] = new Array(chunkCount);
  for (let i = 0; i < chunkCount; i++) {
    flatCorpus.set(makeNormalizedVector(i), i * DIM);
    chunkIds[i] = `chunk-${i}`;
  }
  return { generation, dim: DIM, chunkIds, flatCorpus };
}

describe("vector-snapshot — encodeVectorSnapshot/decodeVectorSnapshot", () => {
  it("round-trips a small payload byte-exactly", () => {
    const payload = makePayload(3);
    const buf = encodeVectorSnapshot(payload);
    const decoded = decodeVectorSnapshot(buf);

    expect(decoded.generation).toBe(payload.generation);
    expect(decoded.dim).toBe(payload.dim);
    expect(decoded.chunkIds).toEqual(payload.chunkIds);
    expect(Array.from(decoded.flatCorpus)).toEqual(Array.from(payload.flatCorpus));
  });

  it("round-trips a zero-chunk (empty kb) payload without throwing", () => {
    const payload = makePayload(0);
    const decoded = decodeVectorSnapshot(encodeVectorSnapshot(payload));
    expect(decoded.chunkIds).toEqual([]);
    expect(decoded.flatCorpus.length).toBe(0);
  });

  it("throws on a buffer too short to contain a header", () => {
    expect(() => decodeVectorSnapshot(Buffer.alloc(4))).toThrow(/too short/i);
  });

  it("throws on a bad magic number (arbitrary corrupted bytes)", () => {
    const buf = Buffer.alloc(64);
    buf.writeUInt32LE(0xdeadbeef, 0);
    expect(() => decodeVectorSnapshot(buf)).toThrow(/bad snapshot magic/i);
  });

  it("throws when the float section is truncated (bytes cut off mid-payload)", () => {
    const payload = makePayload(5);
    const buf = encodeVectorSnapshot(payload);
    const truncated = buf.subarray(0, buf.byteLength - 100); // chop off the tail of the float data
    expect(() => decodeVectorSnapshot(truncated)).toThrow(/float section/i);
  });

  it("throws when the declared chunk count doesn't match the ids array (corrupted header)", () => {
    const payload = makePayload(5);
    const buf = encodeVectorSnapshot(payload);
    const corrupted = Buffer.from(buf);
    corrupted.writeUInt32LE(999, 12); // lie about the chunk count in the header
    expect(() => decodeVectorSnapshot(corrupted)).toThrow(/ids section/i);
  });

  it("throws on a payload with the ids-JSON section flipped to garbage bytes", () => {
    const payload = makePayload(5);
    const buf = encodeVectorSnapshot(payload);
    const corrupted = Buffer.from(buf);
    // Flip every byte in the ids-JSON region (right after the 20-byte header) to break JSON.parse.
    for (let i = 20; i < 20 + 30 && i < corrupted.byteLength; i++) {
      corrupted[i] = 0xff;
    }
    expect(() => decodeVectorSnapshot(corrupted)).toThrow();
  });
});

describe("vector-snapshot — readVectorSnapshot/writeVectorSnapshot/deleteVectorSnapshot (mocked @vercel/blob)", () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalBlobToken = process.env.BLOB_READ_WRITE_TOKEN;

  beforeEach(() => {
    blobMocks.put.mockReset();
    blobMocks.get.mockReset();
    blobMocks.del.mockReset();
    // A synthetic, non-secret token — flips PRODUCT_CONFIG.cloudMode/storage.blobToken on for
    // this suite only. Never a real credential (test-cloud-env.ts's convention is for LIVE
    // credentials specifically; this is a fake value used purely to exercise the "token present"
    // branch against a fully mocked @vercel/blob).
    process.env.DATABASE_URL = "postgresql://user:pass@ep-test-99999.us-east-1.aws.neon.tech/neondb";
    process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_test_synthetic_token";
    vi.resetModules();
  });

  afterEach(() => {
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    if (originalBlobToken === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
    else process.env.BLOB_READ_WRITE_TOKEN = originalBlobToken;
    vi.resetModules();
  });

  it("writeVectorSnapshot calls put() with access: private and never throws even if put() rejects", async () => {
    blobMocks.put.mockRejectedValueOnce(new Error("network blip"));
    const mod = await import("./vector-snapshot.js");
    const payload = makePayload(2);

    await expect(mod.writeVectorSnapshot("kb-1", payload)).resolves.toBeUndefined();
    expect(blobMocks.put).toHaveBeenCalledTimes(1);
    const [, , options] = blobMocks.put.mock.calls[0]!;
    expect((options as { access: string }).access).toBe("private");
  });

  it("readVectorSnapshot returns null when get() returns null (no object at that pathname)", async () => {
    blobMocks.get.mockResolvedValueOnce(null);
    const mod = await import("./vector-snapshot.js");

    const result = await mod.readVectorSnapshot("kb-1", 5);
    expect(result).toBeNull();
  });

  it("readVectorSnapshot returns null when get() rejects (network/auth failure)", async () => {
    blobMocks.get.mockRejectedValueOnce(new Error("unreachable"));
    const mod = await import("./vector-snapshot.js");

    const result = await mod.readVectorSnapshot("kb-1", 5);
    expect(result).toBeNull();
  });

  it("readVectorSnapshot returns null when the stored snapshot's generation is stale", async () => {
    const mod = await import("./vector-snapshot.js");
    const payload = makePayload(2, /* generation */ 3);
    const buf = mod.encodeVectorSnapshot(payload);
    blobMocks.get.mockResolvedValueOnce({
      statusCode: 200,
      stream: new Response(new Uint8Array(buf)).body,
      headers: new Headers(),
      blob: {},
    });

    // Ask for generation 4 — the stored snapshot is generation 3 (stale).
    const result = await mod.readVectorSnapshot("kb-1", 4);
    expect(result).toBeNull();
  });

  it("readVectorSnapshot returns null when the stored bytes are corrupted, never throws (T-03-07-02)", async () => {
    const mod = await import("./vector-snapshot.js");
    const corrupted = Buffer.from([0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00]);
    blobMocks.get.mockResolvedValueOnce({
      statusCode: 200,
      stream: new Response(new Uint8Array(corrupted)).body,
      headers: new Headers(),
      blob: {},
    });

    await expect(mod.readVectorSnapshot("kb-1", 1)).resolves.toBeNull();
  });

  it("readVectorSnapshot returns the full payload when generation matches and bytes are valid", async () => {
    const mod = await import("./vector-snapshot.js");
    const payload = makePayload(4, 7);
    const buf = mod.encodeVectorSnapshot(payload);
    blobMocks.get.mockResolvedValueOnce({
      statusCode: 200,
      stream: new Response(new Uint8Array(buf)).body,
      headers: new Headers(),
      blob: {},
    });

    const result = await mod.readVectorSnapshot("kb-1", 7);
    expect(result).not.toBeNull();
    expect(result!.generation).toBe(7);
    expect(result!.chunkIds).toEqual(payload.chunkIds);
    expect(Array.from(result!.flatCorpus)).toEqual(Array.from(payload.flatCorpus));
  });

  it("deleteVectorSnapshot never throws even if del() rejects", async () => {
    blobMocks.del.mockRejectedValueOnce(new Error("not found"));
    const mod = await import("./vector-snapshot.js");
    await expect(mod.deleteVectorSnapshot("kb-1", 1)).resolves.toBeUndefined();
  });

  it("writeVectorSnapshot/readVectorSnapshot/deleteVectorSnapshot are no-ops when no blob token is configured", async () => {
    delete process.env.BLOB_READ_WRITE_TOKEN;
    vi.resetModules();
    const mod = await import("./vector-snapshot.js");

    await mod.writeVectorSnapshot("kb-1", makePayload(1));
    const readResult = await mod.readVectorSnapshot("kb-1", 1);
    await mod.deleteVectorSnapshot("kb-1", 1);

    expect(readResult).toBeNull();
    expect(blobMocks.put).not.toHaveBeenCalled();
    expect(blobMocks.get).not.toHaveBeenCalled();
    expect(blobMocks.del).not.toHaveBeenCalled();
  });
});
