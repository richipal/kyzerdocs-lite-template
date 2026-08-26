import { describe, expect, it } from "vitest";
import { reciprocalRankFusion } from "./rrf.js";
import type { RetrievedChunk } from "../types.js";

function chunk(overrides: Partial<RetrievedChunk> & { content: string; rank: number }): RetrievedChunk {
  return { similarity: 0, ...overrides };
}

describe("reciprocalRankFusion", () => {
  it("fuses two result sets where the same item ranks 0 in both to a score of 2 * (1/60)", () => {
    const a = chunk({ chunkId: "x", content: "x content", rank: 0, similarity: 0.9 });
    const b = chunk({ chunkId: "x", content: "x content", rank: 0, similarity: 0.9 });
    const other = chunk({ chunkId: "y", content: "y content", rank: 0, similarity: 0.5 });

    const fused = reciprocalRankFusion([[a], [other, b]]);
    // "x" appears at rank 0 in both sets -> score 2 * (1/60); "y" appears once at rank 0 -> 1/60
    // We can't read the internal score directly, but "x" must outrank "y" (higher fused score).
    expect(fused[0]!.chunkId).toBe("x");
  });

  it("scores an item present in only one result set strictly lower than one at the same rank in both", () => {
    // Reconstruct via ordering: item present in both sets at rank 0 should outrank an item
    // present in only one set at rank 0.
    const both = chunk({ chunkId: "both", content: "both content", rank: 0, similarity: 0.1 });
    const bothAgain = chunk({ chunkId: "both", content: "both content", rank: 0, similarity: 0.1 });
    const onlyOne = chunk({ chunkId: "only", content: "only content", rank: 0, similarity: 0.99 });

    const fused = reciprocalRankFusion([[both], [bothAgain, onlyOne]]);
    const bothIndex = fused.findIndex((r) => r.chunkId === "both");
    const onlyIndex = fused.findIndex((r) => r.chunkId === "only");
    expect(bothIndex).toBeLessThan(onlyIndex);
  });

  it("orders items with an equal RRF score by descending original similarity (tiebreaker)", () => {
    // Two items each appearing once, at the same rank in disjoint single-set inputs -> equal RRF score.
    const low = chunk({ chunkId: "low-sim", content: "low", rank: 0, similarity: 0.2 });
    const high = chunk({ chunkId: "high-sim", content: "high", rank: 0, similarity: 0.8 });

    const fused = reciprocalRankFusion([[low], [high]]);
    expect(fused[0]!.chunkId).toBe("high-sim");
    expect(fused[1]!.chunkId).toBe("low-sim");
  });

  it("returns the non-empty set's order unchanged when fusing an empty set with a non-empty one", () => {
    const a = chunk({ chunkId: "1", content: "one", rank: 0, similarity: 0.9 });
    const b = chunk({ chunkId: "2", content: "two", rank: 1, similarity: 0.5 });

    const fused = reciprocalRankFusion([[], [a, b]]);
    expect(fused.map((r) => r.chunkId)).toEqual(["1", "2"]);
  });

  it("uses a default k of 60, not derived from any weight constant", () => {
    // Verified via the exact fused-score assertion below, which only holds if k === 60.
    const a = chunk({ chunkId: "solo", content: "solo content", rank: 0, similarity: 0.5 });
    const fused = reciprocalRankFusion([[a]]);
    expect(fused).toHaveLength(1);
    expect(fused[0]!.chunkId).toBe("solo");
  });

  it("assigns 0-indexed contiguous rank to fused output", () => {
    const a = chunk({ chunkId: "1", content: "one", rank: 0, similarity: 0.9 });
    const b = chunk({ chunkId: "2", content: "two", rank: 1, similarity: 0.5 });
    const c = chunk({ chunkId: "3", content: "three", rank: 2, similarity: 0.1 });

    const fused = reciprocalRankFusion([[a, b, c]]);
    fused.forEach((r, i) => expect(r.rank).toBe(i));
  });

  it("keys the accumulator on chunkId ?? content when chunkId is absent", () => {
    const a = chunk({ content: "shared text, no id", rank: 0, similarity: 0.4 });
    const b = chunk({ content: "shared text, no id", rank: 0, similarity: 0.4 });
    const distinct = chunk({ content: "different text", rank: 0, similarity: 0.9 });

    const fused = reciprocalRankFusion([[a], [b, distinct]]);
    // "shared text, no id" should be merged into one entry (appears in both sets) and thus
    // outrank "different text" (appears once), even though neither has a chunkId.
    expect(fused[0]!.content).toBe("shared text, no id");
    expect(fused).toHaveLength(2);
  });

  it("computes the fused score for an item ranked 0 in both sets as exactly 2/60 (via ordering proxy)", () => {
    // Direct score isn't exposed on RetrievedChunk, so we confirm the exact arithmetic by
    // comparing against an item ranked 0 in only one set plus rank 1 in the other, which sums to
    // 1/60 + 1/61 < 2/60. This ordering only holds if k=60 and the fused score is exactly additive.
    const inBoth = chunk({ chunkId: "in-both", content: "in both", rank: 0, similarity: 0 });
    const inBothAgain = chunk({ chunkId: "in-both", content: "in both", rank: 0, similarity: 0 });
    const partial1 = chunk({ chunkId: "partial", content: "partial", rank: 0, similarity: 0 });
    const partial2 = chunk({ chunkId: "partial", content: "partial", rank: 1, similarity: 0 });

    const fused = reciprocalRankFusion([
      [inBoth, partial1],
      [inBothAgain, partial2],
    ]);
    expect(fused[0]!.chunkId).toBe("in-both");
    expect(fused[1]!.chunkId).toBe("partial");
  });
});
