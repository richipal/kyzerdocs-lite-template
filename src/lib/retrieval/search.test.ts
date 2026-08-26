import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const DIM = 768;

/** A single unit vector: 1.0 at `dim`, zero elsewhere, packed as a `Buffer` the way the storage
 * driver stores embeddings. */
function unitVector(dim: number): Float32Array {
  const v = new Float32Array(DIM);
  v[dim] = 1;
  return v;
}

function packVector(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

interface SeedChunk {
  id: string;
  documentId: string;
  content: string;
  vector: Float32Array;
  charStart?: number;
  charEnd?: number;
  pageNumber?: number | null;
  sectionTitle?: string | null;
}

/** Hoisted fake storage driver — vi.mock factories run before this file's other top-level
 * statements, so all shared mutable state and spies live inside vi.hoisted. */
const fake = vi.hoisted(() => {
  const KB = "kb-search-test";
  const chunksById = new Map<
    string,
    {
      id: string;
      knowledgeBaseId: string;
      documentId: string;
      chunkIndex: number;
      content: string;
      charStart: number;
      charEnd: number;
      pageNumber: number | null;
      sectionTitle: string | null;
      embedding: Buffer;
    }
  >();
  const documents = new Map<string, { id: string; filename: string }>();
  let generation = 0;

  function seed(chunks: SeedChunkInternal[], docs: Array<{ id: string; filename: string }>): void {
    for (const d of docs) documents.set(d.id, d);
    for (const c of chunks) {
      chunksById.set(c.id, {
        id: c.id,
        knowledgeBaseId: KB,
        documentId: c.documentId,
        chunkIndex: 0,
        content: c.content,
        charStart: c.charStart,
        charEnd: c.charEnd,
        pageNumber: c.pageNumber,
        sectionTitle: c.sectionTitle,
        embedding: c.embedding,
      });
    }
    generation += 1;
  }

  interface SeedChunkInternal {
    id: string;
    documentId: string;
    content: string;
    embedding: Buffer;
    charStart: number;
    charEnd: number;
    pageNumber: number | null;
    sectionTitle: string | null;
  }

  function reset(): void {
    chunksById.clear();
    documents.clear();
    generation = 0;
    getGeneration.mockClear();
    getAllChunkVectors.mockClear();
    getChunksByIds.mockClear();
    searchKeyword.mockClear();
    listDocuments.mockClear();
  }

  const getGeneration = vi.fn(async (_kbId: string) => generation);

  const getAllChunkVectors = vi.fn(async (_kbId: string) =>
    Array.from(chunksById.values()).map((c) => ({ id: c.id, embedding: c.embedding })),
  );

  const getChunksByIds = vi.fn(async (ids: string[]) =>
    ids.map((id) => chunksById.get(id)).filter((c): c is NonNullable<typeof c> => c !== undefined),
  );

  /** Simple case-insensitive substring match over raw chunk content against the raw (not FTS5-
   * sanitized) query string — enough to prove hybrid fusion without re-implementing FTS5 syntax
   * in a fake. */
  const searchKeyword = vi.fn(async (_kbId: string, query: string, limit: number) => {
    const q = query.toLowerCase();
    const matches = Array.from(chunksById.values()).filter((c) => c.content.toLowerCase().includes(q));
    return matches.slice(0, limit).map((c, rank) => ({ id: c.id, rank }));
  });

  const listDocuments = vi.fn(async (_kbId: string) => Array.from(documents.values()));

  return { KB, seed, reset, getGeneration, getAllChunkVectors, getChunksByIds, searchKeyword, listDocuments };
});

vi.mock("../storage/index.js", () => ({
  getStorageDriver: () => ({
    getGeneration: fake.getGeneration,
    getAllChunkVectors: fake.getAllChunkVectors,
    getChunksByIds: fake.getChunksByIds,
    searchKeyword: fake.searchKeyword,
    listDocuments: fake.listDocuments,
  }),
}));

/** Query embedding is fully controlled: aligned with axis 0 by default, or a deliberately
 * non-unit vector when `skipNormalization` is requested (D2-02/VAL-03 negative control). */
const embedQueryMock = vi.fn(async (_text: string, opts?: { skipNormalization?: boolean }) => {
  if (opts?.skipNormalization) {
    const v = new Float32Array(DIM);
    v[0] = 3;
    v[1] = 4; // norm = 5, not 1.0
    return v;
  }
  return unitVector(0);
});

vi.mock("../embeddings/gemini.js", () => ({
  embedQuery: embedQueryMock,
}));

const rrfModule = await import("./rrf.js");
const rrfSpy = vi.spyOn(rrfModule, "reciprocalRankFusion");

const mmrModule = await import("./mmr.js");
const mmrSpy = vi.spyOn(mmrModule, "selectDiverse");

const cosineModule = await import("./cosine.js");
const topKSpy = vi.spyOn(cosineModule, "topK");

const { retrieve } = await import("./search.js");
const { invalidateVectorIndex } = await import("./vector-index.js");

beforeEach(() => {
  fake.reset();
  invalidateVectorIndex();
  embedQueryMock.mockClear();
  rrfSpy.mockClear();
  mmrSpy.mockClear();
  topKSpy.mockClear();
});

afterEach(() => {
  invalidateVectorIndex();
});

describe("retrieve() — hybrid read path", () => {
  it("calls embedQuery, topK, searchKeyword, reciprocalRankFusion and selectDiverse exactly once, in that order, with rrfK === 60", async () => {
    fake.seed(
      [
        {
          id: "chunk-1",
          documentId: "doc-1",
          content: "hello world",
          embedding: packVector(unitVector(0)),
          charStart: 0,
          charEnd: 11,
          pageNumber: 1,
          sectionTitle: "Intro",
        },
      ],
      [{ id: "doc-1", filename: "guide.txt" }],
    );

    await retrieve(fake.KB, "hello");

    expect(embedQueryMock).toHaveBeenCalledTimes(1);
    expect(topKSpy).toHaveBeenCalledTimes(1);
    expect(fake.searchKeyword).toHaveBeenCalledTimes(1);
    expect(rrfSpy).toHaveBeenCalledTimes(1);
    expect(mmrSpy).toHaveBeenCalledTimes(1);

    // vi's invocationCallOrder is a single global counter shared across every mock/spy in the
    // test run, so comparing it across these five spies proves relative call order without
    // wrapping (and thereby double-invoking) any of the real, pass-through-by-default spies.
    const order = [
      embedQueryMock.mock.invocationCallOrder[0]!,
      topKSpy.mock.invocationCallOrder[0]!,
      fake.searchKeyword.mock.invocationCallOrder[0]!,
      rrfSpy.mock.invocationCallOrder[0]!,
      mmrSpy.mock.invocationCallOrder[0]!,
    ];
    const sorted = [...order].sort((a, b) => a - b);
    expect(order).toEqual(sorted);

    expect(rrfSpy.mock.calls[0]![1]).toBe(60);
  });

  it("carries every citation field through untouched: pageNumber, sectionTitle, charStart survive retrieval", async () => {
    fake.seed(
      [
        {
          id: "chunk-meta",
          documentId: "doc-meta",
          content: "the warranty period is two years",
          embedding: packVector(unitVector(0)),
          charStart: 42,
          charEnd: 75,
          pageNumber: 7,
          sectionTitle: "Warranty Terms",
        },
      ],
      [{ id: "doc-meta", filename: "policy.pdf" }],
    );

    const results = await retrieve(fake.KB, "warranty period", { finalK: 5 });

    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.pageNumber).not.toBeNull();
      expect(r.sectionTitle).not.toBeNull();
      expect(typeof r.charStart).toBe("number");
      expect(typeof r.charEnd).toBe("number");
    }
    const hit = results.find((r) => r.chunkId === "chunk-meta");
    expect(hit).toBeDefined();
    expect(hit!.pageNumber).toBe(7);
    expect(hit!.sectionTitle).toBe("Warranty Terms");
    expect(hit!.charStart).toBe(42);
    expect(hit!.charEnd).toBe(75);
    expect(hit!.filename).toBe("policy.pdf");
    expect(hit!.documentId).toBe("doc-meta");
  });

  it("hybrid: a chunk absent from the cosine top-N still surfaces via its exact rare keyword", async () => {
    // 6 "noise" chunks tightly aligned with the query direction (axis 0) so their cosine
    // similarity dwarfs the target's, plus 1 "target" chunk with a much lower cosine similarity
    // (axis-100-dominant) that only the FTS arm can find, via a rare keyword absent from every
    // noise chunk.
    const noiseChunks: SeedChunk[] = [];
    for (let i = 0; i < 6; i++) {
      const v = unitVector(0);
      v[1 + i] = 0.0001; // tiny per-chunk perturbation, keeps cosine ~1.0 but ids distinguishable
      noiseChunks.push({
        id: `noise-${i}`,
        documentId: "doc-noise",
        content: `Filler passage number ${i} about unrelated topics.`,
        vector: v,
      });
    }

    const targetRaw = new Float32Array(DIM);
    targetRaw[0] = 0.3;
    targetRaw[100] = 1;
    let sumSquares = 0;
    for (let i = 0; i < DIM; i++) sumSquares += targetRaw[i]! * targetRaw[i]!;
    const norm = Math.sqrt(sumSquares);
    for (let i = 0; i < DIM; i++) targetRaw[i] = targetRaw[i]! / norm;

    fake.seed(
      [
        ...noiseChunks.map((c) => ({
          id: c.id,
          documentId: c.documentId,
          content: c.content,
          embedding: packVector(c.vector),
          charStart: 0,
          charEnd: c.content.length,
          pageNumber: null,
          sectionTitle: null,
        })),
        {
          id: "target",
          documentId: "doc-target",
          content: "The activation code is zephyrus9000 and unlocks the premium tier.",
          embedding: packVector(targetRaw),
          charStart: 0,
          charEnd: 10,
          pageNumber: null,
          sectionTitle: null,
        },
      ],
      [
        { id: "doc-noise", filename: "noise.txt" },
        { id: "doc-target", filename: "activation.txt" },
      ],
    );

    const results = await retrieve(fake.KB, "zephyrus9000", {
      vectorTopN: 5,
      ftsTopN: 5,
      fusedTopK: 10,
      finalK: 10,
    });

    expect(results.some((r) => r.chunkId === "target")).toBe(true);
  });

  it("negative control: retrieve throws via assertNormalized when the query path skips normalization (D2-02/VAL-03)", async () => {
    fake.seed(
      [
        {
          id: "chunk-1",
          documentId: "doc-1",
          content: "hello world",
          embedding: packVector(unitVector(0)),
          charStart: 0,
          charEnd: 11,
          pageNumber: null,
          sectionTitle: null,
        },
      ],
      [{ id: "doc-1", filename: "guide.txt" }],
    );

    await expect(retrieve(fake.KB, "hello", { skipQueryNormalization: true })).rejects.toThrow(
      /L2 norm assertion failed/i,
    );
  });
});
