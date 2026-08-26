import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RetrievedChunkWithMeta } from "../retrieval/search.js";

const generateObjectMock = vi.fn();

vi.mock("ai", () => ({
  generateObject: (...args: unknown[]) => generateObjectMock(...args),
}));

vi.mock("./model.js", () => ({
  judgeModel: vi.fn(() => "stub-judge-model"),
}));

function makeChunk(overrides: Partial<RetrievedChunkWithMeta> = {}): RetrievedChunkWithMeta {
  return {
    chunkId: overrides.chunkId ?? "chunk-1",
    documentId: overrides.documentId ?? "doc-1",
    filename: overrides.filename ?? "policy.pdf",
    pageNumber: overrides.pageNumber ?? 1,
    sectionTitle: overrides.sectionTitle ?? null,
    charStart: overrides.charStart ?? 0,
    charEnd: overrides.charEnd ?? 50,
    content: overrides.content ?? "Some retrieved content.",
    similarity: overrides.similarity ?? 0.75,
    rank: overrides.rank ?? 0,
  };
}

describe("checkGroundedness", () => {
  beforeEach(() => {
    generateObjectMock.mockReset();
  });

  it("empty chunk array: grounded false, no judge call, judged false", async () => {
    const { checkGroundedness } = await import("./groundedness.js");
    const verdict = await checkGroundedness("what is the policy?", []);

    expect(verdict.grounded).toBe(false);
    expect(verdict.judged).toBe(false);
    expect(generateObjectMock).not.toHaveBeenCalled();
  });

  it("below-prefilter: grounded false, no judge call, judged false", async () => {
    const { checkGroundedness } = await import("./groundedness.js");
    const chunks = [makeChunk({ similarity: 0.2 }), makeChunk({ similarity: 0.1, chunkId: "c2" })];
    const verdict = await checkGroundedness("unrelated question", chunks);

    expect(verdict.grounded).toBe(false);
    expect(verdict.judged).toBe(false);
    expect(verdict.prefilterTopScore).toBeCloseTo(0.2);
    expect(generateObjectMock).not.toHaveBeenCalled();
  });

  it("above-prefilter: exactly one judge call, judged true", async () => {
    generateObjectMock.mockResolvedValue({ object: { grounded: true, rationale: "Contains the fact." } });
    const { checkGroundedness } = await import("./groundedness.js");
    const chunks = [makeChunk({ similarity: 0.8 })];

    const verdict = await checkGroundedness("what is the policy?", chunks);

    expect(generateObjectMock).toHaveBeenCalledTimes(1);
    expect(verdict.judged).toBe(true);
    expect(verdict.grounded).toBe(true);
    expect(verdict.rationale).toBe("Contains the fact.");
  });

  it("fail-closed: a thrown error from the judge call yields grounded false, not a throw", async () => {
    generateObjectMock.mockRejectedValue(new Error("model returned invalid JSON"));
    const { checkGroundedness } = await import("./groundedness.js");
    const chunks = [makeChunk({ similarity: 0.9 })];

    const verdict = await checkGroundedness("what is the policy?", chunks);

    expect(verdict.grounded).toBe(false);
    expect(verdict.judged).toBe(true);
    expect(verdict.rationale).toMatch(/could not be parsed/i);
  });

  it("fail-closed: a resolved object missing the grounded field yields grounded false, not a default true", async () => {
    generateObjectMock.mockResolvedValue({ object: { rationale: "no grounded field here" } });
    const { checkGroundedness } = await import("./groundedness.js");
    const chunks = [makeChunk({ similarity: 0.9 })];

    const verdict = await checkGroundedness("what is the policy?", chunks);

    expect(verdict.grounded).toBe(false);
    expect(verdict.judged).toBe(true);
  });

  it("prefilterTopScore always reflects the max similarity among the retrieved chunks", async () => {
    generateObjectMock.mockResolvedValue({ object: { grounded: false, rationale: "not found" } });
    const { checkGroundedness } = await import("./groundedness.js");
    const chunks = [
      makeChunk({ similarity: 0.65, chunkId: "a" }),
      makeChunk({ similarity: 0.91, chunkId: "b" }),
      makeChunk({ similarity: 0.7, chunkId: "c" }),
    ];

    const verdict = await checkGroundedness("what is the policy?", chunks);
    expect(verdict.prefilterTopScore).toBeCloseTo(0.91);
  });
});
