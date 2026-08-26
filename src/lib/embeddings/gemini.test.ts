import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertNormalized } from "../retrieval/normalize.js";

// Stub the SDK entirely — these tests must make zero network calls and consume zero quota.
const embedContentMock = vi.fn();

vi.mock("@google/genai", () => ({
  GoogleGenAI: vi.fn(function GoogleGenAI() {
    return { models: { embedContent: embedContentMock } };
  }),
}));

// Imported once, after the mock above is hoisted into place — every test shares this module
// instance, matching the singleton nature of the module-level firstBatchMeanRawNorm state.
const { embedDocuments, embedQuery } = await import("./gemini.js");

const ORIGINAL_ENV = process.env.GEMINI_API_KEY;

beforeEach(() => {
  process.env.GEMINI_API_KEY = "test-key-not-real";
  embedContentMock.mockReset();
});

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = ORIGINAL_ENV;
});

function makeVector(dim: number, fill = 0.1): number[] {
  return new Array(dim).fill(fill);
}

describe("embedDocuments / embedQuery", () => {
  it("embedDocuments passes taskType RETRIEVAL_DOCUMENT and outputDimensionality 768", async () => {
    embedContentMock.mockResolvedValueOnce({
      embeddings: [{ values: makeVector(768) }],
    });
    await embedDocuments(["hello world"]);

    expect(embedContentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gemini-embedding-001",
        contents: ["hello world"],
        config: expect.objectContaining({
          taskType: "RETRIEVAL_DOCUMENT",
          outputDimensionality: 768,
        }),
      }),
    );
  });

  it("embedQuery passes taskType RETRIEVAL_QUERY and outputDimensionality 768", async () => {
    embedContentMock.mockResolvedValueOnce({
      embeddings: [{ values: makeVector(768) }],
    });
    await embedQuery("what is the warranty period?");

    expect(embedContentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gemini-embedding-001",
        contents: ["what is the warranty period?"],
        config: expect.objectContaining({
          taskType: "RETRIEVAL_QUERY",
          outputDimensionality: 768,
        }),
      }),
    );
  });

  it("normalizes a deliberately non-unit vector to L2 norm within 1e-6 of 1.0", async () => {
    const nonUnit = new Array(768).fill(0);
    nonUnit[0] = 3;
    nonUnit[1] = 4; // raw L2 norm = 5, deliberately non-unit
    embedContentMock.mockResolvedValueOnce({ embeddings: [{ values: nonUnit }] });
    const [vector] = await embedDocuments(["chunk text"]);

    let sumSquares = 0;
    for (let i = 0; i < vector!.length; i++) sumSquares += vector![i]! * vector![i]!;
    const norm = Math.sqrt(sumSquares);
    expect(Math.abs(norm - 1.0)).toBeLessThan(1e-6);
  });

  it("{ skipNormalization: true } returns the raw non-unit vector, and assertNormalized on it throws", async () => {
    const nonUnit = new Array(768).fill(0);
    nonUnit[0] = 3;
    nonUnit[1] = 4;
    embedContentMock.mockResolvedValueOnce({ embeddings: [{ values: nonUnit }] });
    const [vector] = await embedDocuments(["chunk text"], { skipNormalization: true });

    let sumSquares = 0;
    for (let i = 0; i < vector!.length; i++) sumSquares += vector![i]! * vector![i]!;
    expect(Math.sqrt(sumSquares)).toBeCloseTo(5, 6);
    expect(() => assertNormalized(vector!)).toThrow();
  });

  it("throws naming the offending index when a returned vector has the wrong dimension", async () => {
    embedContentMock.mockResolvedValueOnce({
      embeddings: [{ values: makeVector(768) }, { values: makeVector(512) }, { values: makeVector(768) }],
    });
    await expect(embedDocuments(["a", "b", "c"])).rejects.toThrow(/index 1/);
  });

  it("retries exactly once on a 429 followed by a 200", async () => {
    const rateLimitError = Object.assign(new Error("Too Many Requests"), { status: 429 });
    embedContentMock
      .mockRejectedValueOnce(rateLimitError)
      .mockResolvedValueOnce({ embeddings: [{ values: makeVector(768) }] });
    const result = await embedDocuments(["retry me"]);

    expect(embedContentMock).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(1);
  });

  it("throws with the HTTP status in the message once retries are exhausted", async () => {
    vi.useFakeTimers();
    try {
      const serverError = Object.assign(new Error("Internal Server Error"), { status: 503 });
      embedContentMock.mockRejectedValue(serverError);

      const pending = expect(embedDocuments(["always fails"])).rejects.toThrow(/503/);
      await vi.runAllTimersAsync();
      await pending;
    } finally {
      vi.useRealTimers();
    }
  });

  it("splits a batch larger than the configured per-request text count into multiple requests, reassembled in input order", async () => {
    const total = 101; // config batch size defaults to 100 — this forces a two-request split
    const texts = Array.from({ length: total }, (_, i) => `chunk-${i}`);

    embedContentMock.mockImplementation(async ({ contents }: { contents: string[] }) => ({
      embeddings: contents.map((text: string) => {
        const idx = Number(text.split("-")[1]);
        const values = new Array(768).fill(0);
        values[0] = 1;
        values[1] = idx; // encodes the original index in the ratio to component 0
        return { values };
      }),
    }));
    const vectors = await embedDocuments(texts);

    expect(embedContentMock).toHaveBeenCalledTimes(2);
    expect(embedContentMock.mock.calls[0]![0].contents).toHaveLength(100);
    expect(embedContentMock.mock.calls[1]![0].contents).toHaveLength(1);
    expect(vectors).toHaveLength(total);

    for (let i = 0; i < total; i += 25) {
      const ratio = vectors[i]![1]! / vectors[i]![0]!;
      expect(ratio).toBeCloseTo(i, 5);
    }
  });

  it("does not make a network call — the SDK constructor itself is the only call recorded", async () => {
    embedContentMock.mockResolvedValueOnce({ embeddings: [{ values: makeVector(768) }] });
    await embedQuery("no network here");
    // fetch/undici is never touched directly by this module; embedContentMock stands in for the
    // SDK's own HTTP layer entirely, so a call count assertion is sufficient evidence.
    expect(embedContentMock).toHaveBeenCalledTimes(1);
  });
});
