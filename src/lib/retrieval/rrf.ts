/**
 * Reciprocal Rank Fusion (RRF) Combiner
 *
 * Ported verbatim (algorithm and `k = 60` default) from KyzerDocs'
 * `apps/web/lib/search/rrf-combiner.ts` — a production-tuned constant. Re-deriving it would
 * confound rung (b)/(c) comparisons with an implementation difference, since rung (a) uses the
 * original.
 *
 * Combines search results from multiple ranking systems using RRF. RRF is robust to different
 * score scales and emphasizes results that rank highly across multiple search strategies.
 *
 * Three changes from the KyzerDocs original:
 * 1. Keys the accumulator on `chunkId ?? content` rather than a required `chunk_id`, because rung
 *    (a) chunks may arrive without an id (`/api/eval/chat` omits `chunkId` today).
 * 2. Uses this project's own shared `RetrievedChunk` type instead of KyzerDocs'
 *    `SearchResult`.
 * 3. The KyzerDocs original's text/multimodal convenience wrapper (a two-argument helper that
 *    just called this function with a fixed pair of named inputs) is dropped entirely — it is
 *    specific to KyzerDocs' dual-embedding search; this harness fuses exactly two sets (vector,
 *    FTS) via a direct call to `reciprocalRankFusion([vectorResults, ftsResults])`.
 *
 * Do not introduce `vector_weight`/`text_weight` (0.7/0.3) anywhere in this file. Those are
 * inputs to KyzerDocs' Postgres combined-score RPC, a different fusion mechanism at a different
 * pipeline stage — conflating them with RRF's `k` would silently change the ranking.
 */

import type { RetrievedChunk } from "../types.js";

/**
 * Reciprocal Rank Fusion algorithm for combining multiple result sets.
 *
 * Formula: score(chunk) = sum over all result sets of: 1 / (rank + k)
 * where rank is 0-based position in that result set.
 *
 * @param resultSets - Array of retrieved-chunk arrays from different strategies
 * @param k - Constant to prevent division by zero and control fusion (default: 60, matching
 *   KyzerDocs' production constant)
 * @returns Combined and re-ranked results sorted by RRF score (descending), with 0-indexed
 *   contiguous `rank` reassigned on the fused output.
 */
export function reciprocalRankFusion(
  resultSets: RetrievedChunk[][],
  k: number = 60,
): RetrievedChunk[] {
  // Map of chunkId-or-content to accumulated RRF score and result.
  const scoreMap = new Map<string, { score: number; result: RetrievedChunk }>();

  for (const resultSet of resultSets) {
    for (let rank = 0; rank < resultSet.length; rank++) {
      const result = resultSet[rank]!;
      const key = result.chunkId ?? result.content;

      const rrfContribution = 1 / (rank + k);

      const existing = scoreMap.get(key);
      if (existing) {
        existing.score += rrfContribution;
      } else {
        scoreMap.set(key, { score: rrfContribution, result });
      }
    }
  }

  const rankedResults = Array.from(scoreMap.values()).sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    // Tiebreaker: prefer higher original similarity, matching KyzerDocs' production tiebreaker.
    return (b.result.similarity ?? 0) - (a.result.similarity ?? 0);
  });

  return rankedResults.map((entry, rank) => ({ ...entry.result, rank }));
}
