import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const DIM = 768;

/** Hoisted per `vi.mock`'s own requirement — see `vector-snapshot.test.ts` for the same pattern.
 * Controls `readVectorSnapshot`/`writeVectorSnapshot` return values per test, and a fake
 * `StorageDriver` so each test can assert whether Postgres was actually touched. */
const mocks = vi.hoisted(() => ({
  readVectorSnapshot: vi.fn(),
  writeVectorSnapshot: vi.fn(async (_kbId: string, _payload: unknown) => {}),
  getGeneration: vi.fn(async () => 1),
  getAllChunkVectors: vi.fn(async () => [] as { id: string; embedding: Buffer }[]),
}));

vi.mock("../storage/vector-snapshot.js", () => ({
  readVectorSnapshot: mocks.readVectorSnapshot,
  writeVectorSnapshot: mocks.writeVectorSnapshot,
}));

vi.mock("../storage/index.js", () => ({
  getStorageDriver: () => ({
    getGeneration: mocks.getGeneration,
    getAllChunkVectors: mocks.getAllChunkVectors,
  }),
}));

function makeNormalizedVector(seed: number): Float32Array {
  const v = new Float32Array(DIM);
  for (let i = 0; i < DIM; i++) v[i] = Math.sin(i + seed) + 2;
  let sumSquares = 0;
  for (let i = 0; i < v.length; i++) sumSquares += v[i]! * v[i]!;
  const norm = Math.sqrt(sumSquares);
  for (let i = 0; i < v.length; i++) v[i] = v[i]! / norm;
  return v;
}

function packVector(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

/**
 * `PRODUCT_CONFIG.cloudMode` is derived from `DATABASE_URL` presence at module-import time
 * (`src/lib/config.ts`), so this suite follows `storage/index.test.ts`'s established convention:
 * set a SYNTHETIC (never real/live) `DATABASE_URL`, `vi.resetModules()`, then dynamically
 * `import()` `vector-index.js` fresh so it re-reads a cloud-mode-true config snapshot. This is
 * why every test below imports the module under test itself, rather than a shared top-level
 * import (unlike `vector-index.test.ts`, which deliberately stays in local/non-cloud mode).
 */
describe("vector-index — cloud-mode snapshot read-through (D3-18, plan 03-07)", () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    mocks.readVectorSnapshot.mockReset();
    mocks.writeVectorSnapshot.mockReset().mockImplementation(async () => {});
    mocks.getGeneration.mockReset().mockImplementation(async () => 1);
    mocks.getAllChunkVectors.mockReset().mockImplementation(async () => []);
    process.env.DATABASE_URL = "postgresql://user:pass@ep-test-88888.us-east-1.aws.neon.tech/neondb";
    vi.resetModules();
  });

  afterEach(() => {
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    vi.resetModules();
  });

  it("uses a valid, generation-matching snapshot and never calls driver.getAllChunkVectors", async () => {
    const { getVectorIndex } = await import("./vector-index.js");
    const vector = makeNormalizedVector(1);
    mocks.getGeneration.mockResolvedValue(5);
    mocks.readVectorSnapshot.mockResolvedValue({
      generation: 5,
      dim: DIM,
      chunkIds: ["snap-chunk-1"],
      flatCorpus: vector,
    });

    const index = await getVectorIndex("kb-snapshot-hit");

    expect(index.chunkIds).toEqual(["snap-chunk-1"]);
    expect(index.size).toBe(1);
    expect(mocks.getAllChunkVectors).not.toHaveBeenCalled();
    expect(mocks.writeVectorSnapshot).not.toHaveBeenCalled(); // a snapshot HIT never re-writes
  });

  it("falls through to Postgres and writes a fresh snapshot when readVectorSnapshot returns null (miss/stale/unreachable)", async () => {
    const { getVectorIndex } = await import("./vector-index.js");
    mocks.getGeneration.mockResolvedValue(7);
    mocks.readVectorSnapshot.mockResolvedValue(null);
    mocks.getAllChunkVectors.mockResolvedValue([
      { id: "pg-chunk-1", embedding: packVector(makeNormalizedVector(2)) },
    ]);

    const index = await getVectorIndex("kb-snapshot-miss");

    expect(index.chunkIds).toEqual(["pg-chunk-1"]);
    expect(mocks.getAllChunkVectors).toHaveBeenCalledTimes(1);
    expect(mocks.writeVectorSnapshot).toHaveBeenCalledTimes(1);
    const [kbId, payload] = mocks.writeVectorSnapshot.mock.calls[0]!;
    expect(kbId).toBe("kb-snapshot-miss");
    const typedPayload = payload as { generation: number; chunkIds: string[] };
    expect(typedPayload.generation).toBe(7);
    expect(typedPayload.chunkIds).toEqual(["pg-chunk-1"]);
  });

  it("corrupting the stored snapshot bytes still yields a correct index — falls through to Postgres silently (T-03-07-02)", async () => {
    const { getVectorIndex } = await import("./vector-index.js");
    mocks.getGeneration.mockResolvedValue(9);
    // Simulates a snapshot that DECODED successfully (readVectorSnapshot's own structural checks
    // passed) but whose float bytes are corrupted — e.g. a non-unit-norm vector, the exact
    // failure mode decodeVectorSnapshot's byte-length/JSON checks alone cannot catch. This is
    // getVectorIndex's OWN corruption defense (the assertNormalized loop over snapshot data),
    // not vector-snapshot.ts's — see that module's separate corrupted-bytes coverage for the
    // decode-level cases (bad magic, truncated float section, etc).
    const corruptedVector = new Float32Array(DIM); // all zeros — norm 0, fails assertNormalized
    mocks.readVectorSnapshot.mockResolvedValue({
      generation: 9,
      dim: DIM,
      chunkIds: ["corrupt-chunk-1"],
      flatCorpus: corruptedVector,
    });
    mocks.getAllChunkVectors.mockResolvedValue([
      { id: "pg-chunk-recovered", embedding: packVector(makeNormalizedVector(3)) },
    ]);

    const index = await getVectorIndex("kb-corrupted-snapshot");

    // The corrupted snapshot must NEVER surface as a thrown error — it silently falls through to
    // the real Postgres rebuild, which succeeds and produces a CORRECT index.
    expect(index.chunkIds).toEqual(["pg-chunk-recovered"]);
    expect(index.size).toBe(1);
    expect(mocks.getAllChunkVectors).toHaveBeenCalledTimes(1);
    // The successful Postgres rebuild re-writes a fresh, valid snapshot afterward.
    expect(mocks.writeVectorSnapshot).toHaveBeenCalledTimes(1);
  });

  it("a genuine Postgres-sourced normalization failure still throws KDL-EMBED-003 (not silently swallowed)", async () => {
    const { getVectorIndex } = await import("./vector-index.js");
    const { AppError } = await import("../errors.js");
    mocks.getGeneration.mockResolvedValue(11);
    mocks.readVectorSnapshot.mockResolvedValue(null); // no snapshot — must hit Postgres
    mocks.getAllChunkVectors.mockResolvedValue([
      { id: "bad-pg-chunk", embedding: packVector(new Float32Array(DIM)) }, // zero vector, fails assertNormalized
    ]);

    await expect(getVectorIndex("kb-real-corruption")).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(AppError);
      expect((err as InstanceType<typeof AppError>).code).toBe("KDL-EMBED-003");
      expect((err as InstanceType<typeof AppError>).message).toContain("bad-pg-chunk");
      return true;
    });

    // A real source-of-truth failure must NOT be masked by a snapshot write attempt.
    expect(mocks.writeVectorSnapshot).not.toHaveBeenCalled();
  });

  it("records a real lastRebuildDurationMs whether served from a snapshot hit or a Postgres miss", async () => {
    const { getVectorIndex, getLastRebuildDurationMs, resetLastRebuildDurationMsForTests } = await import(
      "./vector-index.js"
    );
    resetLastRebuildDurationMsForTests();
    expect(getLastRebuildDurationMs()).toBeNull();

    mocks.getGeneration.mockResolvedValue(2);
    mocks.readVectorSnapshot.mockResolvedValue({
      generation: 2,
      dim: DIM,
      chunkIds: ["snap-1"],
      flatCorpus: makeNormalizedVector(4),
    });

    await getVectorIndex("kb-duration");
    expect(getLastRebuildDurationMs()).not.toBeNull();
  });
});
