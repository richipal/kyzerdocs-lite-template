/**
 * Brute-force cosine similarity search over a flat, contiguous `Float32Array` corpus.
 *
 * Vectors are stored L2-normalized (see normalize.ts), so similarity at query time is a plain
 * dot product with no runtime division. `flatCorpus` is one contiguous buffer of `n * dim`
 * values rather than an array of typed arrays — CPU cache locality is the reason the "no vector
 * index" bet is viable at ~20k chunks (see CLAUDE.md's Technology Stack section). No SIMD or
 * native-accelerated library is used: at this scale the win is immaterial next to the packaging
 * risk of a native/WASM dependency.
 */

/**
 * Dot product of two `dim`-length slices, `a` starting at `offsetA` and `b` starting at
 * `offsetB`, within their respective (possibly larger, flat) buffers.
 */
export function dot(
  a: Float32Array,
  b: Float32Array,
  dim: number,
  offsetA: number,
  offsetB: number,
): number {
  let sum = 0;
  for (let i = 0; i < dim; i++) {
    sum += a[offsetA + i]! * b[offsetB + i]!;
  }
  return sum;
}

/**
 * Brute-force top-k similarity search: scores `queryVector` (length `dim`) against every
 * `dim`-length slice of `flatCorpus` (length `n * dim`), returning the top `k` by descending
 * dot-product score. Returns all `n` results, 0-indexed rank matching output order, when the
 * corpus has fewer than `k` vectors.
 */
export function topK(
  queryVector: Float32Array,
  flatCorpus: Float32Array,
  dim: number,
  k: number,
): Array<{ index: number; score: number; rank: number }> {
  const n = Math.floor(flatCorpus.length / dim);
  const scored: Array<{ index: number; score: number }> = new Array(n);
  for (let i = 0; i < n; i++) {
    scored[i] = { index: i, score: dot(queryVector, flatCorpus, dim, 0, i * dim) };
  }

  scored.sort((x, y) => y.score - x.score);

  const limit = Math.min(k, n);
  const results: Array<{ index: number; score: number; rank: number }> = new Array(limit);
  for (let rank = 0; rank < limit; rank++) {
    const entry = scored[rank]!;
    results[rank] = { index: entry.index, score: entry.score, rank };
  }
  return results;
}
