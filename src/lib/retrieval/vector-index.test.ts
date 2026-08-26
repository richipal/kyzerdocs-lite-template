import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../errors.js";

const DIM = 768;

/** Hoisted, mutable fake storage state — `vi.mock` factories run before this file's other
 * top-level statements, so the mock functions this test spies on must be created inside
 * `vi.hoisted` and referenced by both the mock factory and the test body. */
const mocks = vi.hoisted(() => {
  const chunksByKb = new Map<string, Map<string, Buffer>>();
  const generationByKb = new Map<string, number>();

  function ensure(kbId: string): void {
    if (!chunksByKb.has(kbId)) chunksByKb.set(kbId, new Map());
    if (!generationByKb.has(kbId)) generationByKb.set(kbId, 0);
  }

  const getAllChunkVectors = vi.fn(async (kbId: string) => {
    ensure(kbId);
    return Array.from(chunksByKb.get(kbId)!.entries()).map(([id, embedding]) => ({ id, embedding }));
  });

  const getGeneration = vi.fn(async (kbId: string) => {
    ensure(kbId);
    return generationByKb.get(kbId)!;
  });

  const upsertChunks = vi.fn(
    async (chunks: Array<{ id?: string; knowledgeBaseId: string; embedding: Buffer }>) => {
      for (const c of chunks) {
        ensure(c.knowledgeBaseId);
        const id = c.id ?? `auto-${chunksByKb.get(c.knowledgeBaseId)!.size}`;
        chunksByKb.get(c.knowledgeBaseId)!.set(id, c.embedding);
        generationByKb.set(c.knowledgeBaseId, (generationByKb.get(c.knowledgeBaseId) ?? 0) + 1);
      }
    },
  );

  function reset(): void {
    chunksByKb.clear();
    generationByKb.clear();
    getAllChunkVectors.mockClear();
    getGeneration.mockClear();
    upsertChunks.mockClear();
  }

  return { chunksByKb, generationByKb, getAllChunkVectors, getGeneration, upsertChunks, reset };
});

vi.mock("../storage/index.js", () => ({
  getStorageDriver: () => mocks,
}));

const { getVectorIndex, invalidateVectorIndex, getLastRebuildDurationMs, resetLastRebuildDurationMsForTests } =
  await import("./vector-index.js");

function makeVector(fill: (i: number) => number, dim = DIM): Float32Array {
  const v = new Float32Array(dim);
  for (let i = 0; i < dim; i++) v[i] = fill(i);
  return v;
}

function normalizedVector(seed = 0): Float32Array {
  const v = makeVector((i) => Math.sin(i + seed) + 2);
  let sumSquares = 0;
  for (let i = 0; i < v.length; i++) sumSquares += v[i]! * v[i]!;
  const norm = Math.sqrt(sumSquares);
  for (let i = 0; i < v.length; i++) v[i] = v[i]! / norm;
  return v;
}

function packVector(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

/** A vector scaled to the measured raw `gemini-embedding-001` L2 norm (0.589, D2-02) — a
 * deliberately non-normalized vector that a normalization regression could plausibly produce. */
function measuredRawNormVector(): Float32Array {
  const v = new Float32Array(DIM);
  v[0] = 0.589;
  return v;
}

describe("vector-index — getVectorIndex/invalidateVectorIndex", () => {
  beforeEach(() => {
    mocks.reset();
    invalidateVectorIndex();
    resetLastRebuildDurationMsForTests();
  });

  afterEach(() => {
    invalidateVectorIndex();
    resetLastRebuildDurationMsForTests();
  });

  it("builds once on first call and reuses the cache across 100 calls with no intervening write", async () => {
    const kbId = "kb-rebuild";
    await mocks.upsertChunks([{ id: "c1", knowledgeBaseId: kbId, embedding: packVector(normalizedVector(1)) }]);

    for (let i = 0; i < 100; i++) {
      await getVectorIndex(kbId);
    }
    expect(mocks.getAllChunkVectors).toHaveBeenCalledTimes(1);
  });

  it("rebuilds exactly once more after a write bumps the generation counter", async () => {
    const kbId = "kb-rebuild-2";
    await mocks.upsertChunks([{ id: "c1", knowledgeBaseId: kbId, embedding: packVector(normalizedVector(1)) }]);

    for (let i = 0; i < 100; i++) {
      await getVectorIndex(kbId);
    }
    expect(mocks.getAllChunkVectors).toHaveBeenCalledTimes(1);

    await mocks.upsertChunks([{ id: "c2", knowledgeBaseId: kbId, embedding: packVector(normalizedVector(2)) }]);

    await getVectorIndex(kbId);
    expect(mocks.getAllChunkVectors).toHaveBeenCalledTimes(2);
  });

  it("throws AppError KDL-EMBED-003 naming the offending chunk id for a non-normalized stored vector", async () => {
    const kbId = "kb-denorm";
    await mocks.upsertChunks([
      { id: "good-chunk", knowledgeBaseId: kbId, embedding: packVector(normalizedVector(3)) },
      { id: "bad-chunk", knowledgeBaseId: kbId, embedding: packVector(measuredRawNormVector()) },
    ]);

    await expect(getVectorIndex(kbId)).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe("KDL-EMBED-003");
      expect((err as AppError).message).toContain("bad-chunk");
      return true;
    });
  });

  it("maintains independent indexes per knowledge base id", async () => {
    const kbA = "kb-a";
    const kbB = "kb-b";
    await mocks.upsertChunks([
      { id: "a1", knowledgeBaseId: kbA, embedding: packVector(normalizedVector(10)) },
      { id: "a2", knowledgeBaseId: kbA, embedding: packVector(normalizedVector(11)) },
    ]);
    await mocks.upsertChunks([{ id: "b1", knowledgeBaseId: kbB, embedding: packVector(normalizedVector(12)) }]);

    const indexA = await getVectorIndex(kbA);
    const indexB = await getVectorIndex(kbB);

    expect(indexA.size).toBe(2);
    expect(indexB.size).toBe(1);
    expect(indexA.chunkIds).toEqual(["a1", "a2"]);
    expect(indexB.chunkIds).toEqual(["b1"]);
    for (const id of indexA.chunkIds) expect(indexB.chunkIds).not.toContain(id);
  });

  it("returns size 0 for an empty knowledge base without throwing", async () => {
    const index = await getVectorIndex("kb-empty");
    expect(index.size).toBe(0);
    expect(index.chunkIds).toEqual([]);
    expect(index.flatCorpus.length).toBe(0);
  });

  it("uses an explicit driverOverride instead of the storage/index.js singleton when provided", async () => {
    const kbId = "kb-override";
    const altGetAllChunkVectors = vi.fn(async () => [
      { id: "override-chunk", embedding: packVector(normalizedVector(99)) },
    ]);
    const altGetGeneration = vi.fn(async () => 1);
    const altDriver = { getAllChunkVectors: altGetAllChunkVectors, getGeneration: altGetGeneration } as never;

    const index = await getVectorIndex(kbId, altDriver);

    expect(index.chunkIds).toEqual(["override-chunk"]);
    expect(altGetAllChunkVectors).toHaveBeenCalledTimes(1);
    expect(altGetGeneration).toHaveBeenCalledTimes(1);
    // The singleton's own getAllChunkVectors must not have been touched by this call.
    expect(mocks.getAllChunkVectors).not.toHaveBeenCalled();
  });

  it("getLastRebuildDurationMs is null before any rebuild and a real number after one (S-5)", async () => {
    expect(getLastRebuildDurationMs()).toBeNull();

    const kbId = "kb-rebuild-duration";
    await mocks.upsertChunks([{ id: "c1", knowledgeBaseId: kbId, embedding: packVector(normalizedVector(1)) }]);
    await getVectorIndex(kbId);

    const duration = getLastRebuildDurationMs();
    expect(duration).not.toBeNull();
    expect(typeof duration).toBe("number");
    expect(duration!).toBeGreaterThanOrEqual(0);
  });

  it("lays out flatCorpus and chunkIds consistently with size and dim", async () => {
    const kbId = "kb-layout";
    await mocks.upsertChunks([
      { id: "l1", knowledgeBaseId: kbId, embedding: packVector(normalizedVector(20)) },
      { id: "l2", knowledgeBaseId: kbId, embedding: packVector(normalizedVector(21)) },
      { id: "l3", knowledgeBaseId: kbId, embedding: packVector(normalizedVector(22)) },
    ]);

    const index = await getVectorIndex(kbId);
    expect(index.dim).toBe(DIM);
    expect(index.size).toBe(3);
    expect(index.flatCorpus.length).toBe(index.size * index.dim);
    expect(index.chunkIds.length).toBe(index.size);
  });
});
