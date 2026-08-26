import { describe, expect, it } from "vitest";
import { dot, topK } from "./cosine.js";

function naiveDot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!;
  return sum;
}

describe("dot", () => {
  it("equals the naive per-array dot product within 1e-5 for two full-length vectors", () => {
    const a = new Float32Array([1, 2, 3, 4]);
    const b = new Float32Array([5, 6, 7, 8]);
    expect(Math.abs(dot(a, b, 4, 0, 0) - naiveDot(a, b))).toBeLessThan(1e-5);
  });

  it("computes the correct slice dot product against offsets into a flat contiguous buffer", () => {
    const dim = 3;
    // Two vectors packed contiguously: [v0(3), v1(3)]
    const flat = new Float32Array([1, 0, 0, 0, 1, 0]);
    const query = new Float32Array([1, 1, 0]);
    expect(Math.abs(dot(query, flat, dim, 0, 0) - 1)).toBeLessThan(1e-5);
    expect(Math.abs(dot(query, flat, dim, 0, dim) - 1)).toBeLessThan(1e-5);
  });
});

describe("topK", () => {
  const dim = 2;
  // 5 vectors packed contiguously, chosen so dot-product-with-query ordering is unambiguous.
  const flatCorpus = new Float32Array([
    1, 0, // index 0
    0.9, 0.1, // index 1
    0.5, 0.5, // index 2
    0.1, 0.9, // index 3
    0, 1, // index 4
  ]);
  const query = new Float32Array([1, 0]);

  it("returns exactly k results in descending score order", () => {
    const results = topK(query, flatCorpus, dim, 3);
    expect(results).toHaveLength(3);
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1]!.score).toBeGreaterThanOrEqual(results[i]!.score);
    }
  });

  it("returns all results when the corpus has fewer vectors than k", () => {
    const results = topK(query, flatCorpus, dim, 10);
    expect(results).toHaveLength(5);
  });

  it("preserves 0-indexed rank matching its own output order", () => {
    const results = topK(query, flatCorpus, dim, 5);
    results.forEach((r, i) => expect(r.rank).toBe(i));
  });

  it("ranks index 0 (identical direction to query) first", () => {
    const results = topK(query, flatCorpus, dim, 1);
    expect(results[0]!.index).toBe(0);
  });
});
