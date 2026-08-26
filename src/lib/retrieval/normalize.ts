/**
 * L2 normalization for embedding vectors, plus the D-15 assertion that enforces it.
 *
 * `gemini-embedding-001` at 768 dimensions does NOT auto-normalize — this must be done manually
 * at both ingest and query time, or cosine similarity degrades silently (no error thrown) across
 * the whole retrieval path. `assertNormalized` is what turns that silent failure mode into a loud
 * one.
 *
 * Source: ai.google.dev/gemini-api/docs/embeddings normalization formula, ported from the
 * documented Python example (`embedding_values_np / np.linalg.norm(embedding_values_np)`).
 */

/**
 * Returns `vector` L2-normalized (`v / ||v||_2`) so its norm is within ~1e-6 of 1.0.
 *
 * `opts.skip` is D-16's negative control: the same call site, with one flag flipped, returns the
 * input values unchanged instead of normalizing. This exists so the negative-control run is
 * provably the same code path as the real one — do not implement a separate unnormalized code
 * path anywhere else in the harness.
 */
export function l2Normalize(vector: Float32Array, opts?: { skip?: boolean }): Float32Array {
  if (opts?.skip) {
    return new Float32Array(vector);
  }

  let sumSquares = 0;
  for (let i = 0; i < vector.length; i++) sumSquares += vector[i]! * vector[i]!;
  const norm = Math.sqrt(sumSquares);
  if (norm === 0) throw new Error("Cannot normalize a zero vector");

  const out = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i++) out[i] = vector[i]! / norm;
  return out;
}

/**
 * D-15: throws when `vector`'s L2 norm deviates from 1.0 by more than `tolerance`. Every
 * stored/query vector in the harness must pass this before it is used for similarity — a
 * normalization bug should surface here, not as "brute-force cosine doesn't work" downstream.
 */
export function assertNormalized(vector: Float32Array, tolerance = 1e-3): void {
  let sumSquares = 0;
  for (let i = 0; i < vector.length; i++) sumSquares += vector[i]! * vector[i]!;
  const norm = Math.sqrt(sumSquares);
  if (Math.abs(norm - 1.0) > tolerance) {
    throw new Error(`L2 norm assertion failed: expected ~1.0, got ${norm}`);
  }
}
