/**
 * RET-04 maximal marginal relevance (MMR) diversity pass.
 *
 * No analog anywhere in this codebase — 02-PATTERNS.md is explicit that the eval harness never
 * needed this: "recall@k doesn't penalize duplicate near-hits the way a context window does."
 * Built from `.planning/research/ARCHITECTURE.md` Pattern 4, point 3:
 *
 *   MMR = argmax [ lambda * sim(doc, query) - (1 - lambda) * max sim(doc, selected) ]
 *
 * `lambda` and `k` (this module's `opts.lambda`/`opts.k`, sourced by callers from
 * `PRODUCT_CONFIG.retrieval.mmrLambda`/`finalK`) are unmeasured defaults carried from
 * ARCHITECTURE.md's "lambda ~= 0.5-0.7" recommendation. RESEARCH.md's Open Question 3 flags both
 * the lambda value and the top-K sizing as unmeasured — plan 02-10 tunes them against the eval
 * harness's golden dataset. This module never hardcodes either value; callers must read them
 * from config.
 *
 * Vectors are L2-normalized everywhere in this system (D2-02), so similarity between two vectors
 * is a plain dot product — this reuses the promoted `dot` from `cosine.ts` rather than
 * re-deriving a second cosine implementation. No square-root call of any kind appears in this
 * file, on purpose.
 *
 * `sim(doc, query)` is read directly from each candidate's `score` field (the cosine similarity
 * already computed by the earlier retrieval stages and carried through fusion) rather than
 * recomputed against `queryVector` — `queryVector` is only used here for its `.length` (the
 * vector dimensionality), keeping this pass a pure function of the candidates already produced.
 */

import { dot } from "./cosine.js";

export function selectDiverse<T extends { vector: Float32Array; score: number }>(
  candidates: T[],
  queryVector: Float32Array,
  opts: { lambda: number; k: number },
): T[] {
  const { lambda, k } = opts;
  const dim = queryVector.length;

  const remaining = candidates.slice();
  const selected: T[] = [];

  while (remaining.length > 0 && selected.length < k) {
    let bestIndex = 0;
    let bestTerm = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i]!;

      // max sim(doc, selected): 0 when nothing has been selected yet (no diversity penalty on
      // the first pick), otherwise the maximum similarity to any already-selected candidate.
      let maxSimToSelected = selected.length === 0 ? 0 : -Infinity;
      for (const s of selected) {
        const sim = dot(candidate.vector, s.vector, dim, 0, 0);
        if (sim > maxSimToSelected) maxSimToSelected = sim;
      }

      const term = lambda * candidate.score - (1 - lambda) * maxSimToSelected;

      // Deterministic tie-break: prefer higher relevance score. This is what guarantees the
      // very first pick is always the highest-relevance candidate even at lambda = 0, where the
      // diversity term is 0 for every candidate (empty selected set) and the relevance term is
      // also multiplied by 0 — every candidate ties at term = 0 and the tie-break decides.
      if (term > bestTerm || (term === bestTerm && candidate.score > remaining[bestIndex]!.score)) {
        bestTerm = term;
        bestIndex = i;
      }
    }

    selected.push(remaining[bestIndex]!);
    remaining.splice(bestIndex, 1);
  }

  return selected;
}
