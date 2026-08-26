import { describe, expect, it } from "vitest";
import { selectDiverse } from "./mmr.js";

interface Candidate {
  id: string;
  vector: Float32Array;
  score: number;
}

/** Builds a 15-dim one-hot-ish vector: `1.0` at `dim`, with optional small perturbation values
 * spread across dims 1-4 (used only by the cluster vectors below) so cluster members are
 * near-identical but not byte-identical. */
function vec(primaryDim: number, perturb: number[] = []): Float32Array {
  const v = new Float32Array(15);
  v[primaryDim] = 1;
  for (let i = 0; i < perturb.length; i++) v[1 + i] = perturb[i]!;
  // Re-normalize so every vector is unit-length, matching the product's always-normalized
  // invariant (D2-02) — MMR assumes this and never re-derives a normalization step itself.
  let sumSquares = 0;
  for (let i = 0; i < v.length; i++) sumSquares += v[i]! * v[i]!;
  const norm = Math.sqrt(sumSquares);
  for (let i = 0; i < v.length; i++) v[i] = v[i]! / norm;
  return v;
}

/** 15 candidates: indices 0-4 are near-identical perturbations of one vector (dim 0), scored
 * highest; indices 5-14 are mutually near-orthogonal one-hot vectors in dims 5-14, scored lower
 * but still descending. Pure relevance-only selection of 6 would include 5 of the 0-4 cluster;
 * MMR must not. */
function buildNearDuplicateCandidates(): Candidate[] {
  const cluster: Candidate[] = [
    { id: "c0", vector: vec(0, []), score: 0.99 },
    { id: "c1", vector: vec(0, [0.001]), score: 0.98 },
    { id: "c2", vector: vec(0, [0, 0.001]), score: 0.97 },
    { id: "c3", vector: vec(0, [0, 0, 0.001]), score: 0.96 },
    { id: "c4", vector: vec(0, [0, 0, 0, 0.001]), score: 0.95 },
  ];
  const distinct: Candidate[] = [];
  for (let i = 0; i < 10; i++) {
    distinct.push({ id: `d${i}`, vector: vec(5 + i), score: 0.94 - i * 0.01 });
  }
  return [...cluster, ...distinct];
}

/** Query vector is unused for similarity math (relevance comes from the precomputed `score`
 * field carried through from cosine/RRF fusion) — only its `.length` supplies `dim`. */
const QUERY_VECTOR = new Float32Array(15);

describe("selectDiverse (MMR)", () => {
  it("caps near-duplicate crowding: at most 2 of a 5-member near-identical cluster survive into a diverse top-6, and the top-scoring candidate is included", () => {
    const candidates = buildNearDuplicateCandidates();
    const selected = selectDiverse(candidates, QUERY_VECTOR, { lambda: 0.6, k: 6 });

    expect(selected).toHaveLength(6);
    const clusterCount = selected.filter((c) => c.id.startsWith("c")).length;
    expect(clusterCount).toBeLessThanOrEqual(2);
    expect(selected.some((c) => c.id === "c0")).toBe(true);
  });

  it("lambda = 1.0 returns exactly the relevance-sorted top-K (pure relevance, no diversity term)", () => {
    const candidates = buildNearDuplicateCandidates();
    const selected = selectDiverse(candidates, QUERY_VECTOR, { lambda: 1.0, k: 6 });

    const expectedOrder = candidates
      .slice()
      .sort((a, b) => b.score - a.score)
      .slice(0, 6)
      .map((c) => c.id);
    expect(selected.map((c) => c.id)).toEqual(expectedOrder);
  });

  it("lambda = 0.0 maximizes dissimilarity and does not simply return the relevance order", () => {
    const candidates = buildNearDuplicateCandidates();
    const selected = selectDiverse(candidates, QUERY_VECTOR, { lambda: 0.0, k: 6 });

    const relevanceOrder = candidates
      .slice()
      .sort((a, b) => b.score - a.score)
      .slice(0, 6)
      .map((c) => c.id);
    expect(selected.map((c) => c.id)).not.toEqual(relevanceOrder);
  });

  it("the first selected item is always the highest-relevance candidate, regardless of lambda", () => {
    const candidates = buildNearDuplicateCandidates();
    for (const lambda of [0.0, 0.3, 0.6, 1.0]) {
      const selected = selectDiverse(candidates, QUERY_VECTOR, { lambda, k: 6 });
      expect(selected[0]!.id).toBe("c0");
    }
  });

  it("is deterministic: identical input produces identical output across runs", () => {
    const candidates = buildNearDuplicateCandidates();
    const first = selectDiverse(candidates, QUERY_VECTOR, { lambda: 0.6, k: 6 }).map((c) => c.id);
    const second = selectDiverse(candidates, QUERY_VECTOR, { lambda: 0.6, k: 6 }).map((c) => c.id);
    expect(second).toEqual(first);
  });

  it("requesting more items than there are candidates returns all candidates exactly once, without error", () => {
    const candidates = buildNearDuplicateCandidates();
    const selected = selectDiverse(candidates, QUERY_VECTOR, { lambda: 0.6, k: 100 });

    expect(selected).toHaveLength(candidates.length);
    const ids = selected.map((c) => c.id).sort();
    const expectedIds = candidates.map((c) => c.id).sort();
    expect(ids).toEqual(expectedIds);
  });
});
