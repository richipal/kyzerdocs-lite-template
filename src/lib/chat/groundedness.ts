/**
 * CHAT-04's real mechanism (D2-06/D2-07/D2-08). Phase 1 measured `overlap_fraction: 0.6152`
 * between in-scope and out-of-scope similarity distributions (01-13-VERDICT.md) — a threshold
 * alone cannot separate answerable from unanswerable questions, so this module replaces the
 * threshold with a pre-hoc LLM judgement over the retrieved excerpts themselves.
 *
 * Run BEFORE generation, not after: judging whether the retrieved chunks *could* answer the
 * question is cheaper than generating a full answer and then discarding it, and the client never
 * sees a partial answer that gets retracted.
 *
 * The similarity threshold (`PRODUCT_CONFIG.retrieval.prefilterMinScore`) survives only as a
 * cheap pre-filter (D2-08) — when nothing retrieved is remotely close, skip the judge call
 * entirely and refuse without paying for it. It is NEVER the refusal decision on its own; when the
 * pre-filter passes, the judge call is the only thing that can produce `grounded: true`.
 */

import { generateObject } from "ai";
import { z } from "zod";
import { PRODUCT_CONFIG } from "../config.js";
import type { RetrievedChunkWithMeta } from "../retrieval/search.js";
import { judgeModel } from "./model.js";

export interface GroundednessVerdict {
  grounded: boolean;
  rationale: string;
  /** The highest cosine similarity among the retrieved chunks, or 0 when nothing was retrieved.
   * Logged alongside the verdict (D2-08) so a later tuning pass has real data, not anecdote. */
  prefilterTopScore: number;
  /** Whether the judge model was actually called this invocation — `false` for both the
   * empty-chunks and below-prefilter short-circuits. */
  judged: boolean;
}

const JUDGE_SCHEMA = z.object({
  grounded: z.boolean(),
  rationale: z.string(),
});

/**
 * The judge prompt gives concrete criteria rather than a vague "is this grounded?" — Phase 1's own
 * discordant-case review found "retrieved something topical but irrelevant" as a real failure
 * shape a vague prompt would miss. The excerpts must contain the SPECIFIC FACT, NUMBER, or NAME
 * the question asks for; being about the SAME TOPIC as the question is explicitly NOT sufficient —
 * a chunk that is merely topical, without the exact detail asked for, must be judged ungrounded.
 */
function buildJudgePrompt(query: string, chunks: readonly RetrievedChunkWithMeta[]): string {
  const excerpts = chunks
    .map((chunk, i) => `[${i + 1}] ${chunk.content}`)
    .join("\n\n");

  return `You are judging whether a set of retrieved document excerpts can answer a user's question.

QUESTION:
${query}

RETRIEVED EXCERPTS:
${excerpts}

CRITERIA:
- Answer "grounded: true" ONLY if the excerpts contain the specific fact, number, name, or policy detail the question actually asks for.
- Being about the same topic as the question is NOT sufficient. A merely topical excerpt that does not contain the specific detail asked for must be judged "grounded: false".
- Do not use any knowledge beyond what is written in the excerpts above.

Respond with a boolean "grounded" verdict and a one-sentence "rationale" explaining your judgement.`;
}

function prefilterTopScore(chunks: readonly RetrievedChunkWithMeta[]): number {
  if (chunks.length === 0) return 0;
  return Math.max(...chunks.map((c) => c.similarity));
}

/**
 * Judges whether `chunks` (already retrieved for `query`) can answer the question, pre-hoc —
 * before any generation. Short-circuits (no judge call, `judged: false`) on an empty chunk array
 * or when the pre-filter's top score is below `prefilterMinScore` — the cheap D2-08 skip. Once the
 * pre-filter passes, exactly one structured judge call decides the verdict; a malformed or
 * unparseable response fails closed to `grounded: false` rather than defaulting true or throwing.
 */
export async function checkGroundedness(
  query: string,
  chunks: RetrievedChunkWithMeta[],
): Promise<GroundednessVerdict> {
  const topScore = prefilterTopScore(chunks);

  if (chunks.length === 0) {
    return {
      grounded: false,
      rationale: "No document excerpts were retrieved for this question.",
      prefilterTopScore: topScore,
      judged: false,
    };
  }

  // D2-08 cheap pre-filter: skip the judge call when nothing retrieved is remotely close.
  // score >= 0.6 (PRODUCT_CONFIG.retrieval.prefilterMinScore) is required to even reach the judge.
  if (topScore < PRODUCT_CONFIG.retrieval.prefilterMinScore) {
    return {
      grounded: false,
      rationale: `The best retrieved match (similarity ${topScore.toFixed(4)}) is below the pre-filter threshold — not close enough to warrant a judge call.`,
      prefilterTopScore: topScore,
      judged: false,
    };
  }

  try {
    const result = await generateObject({
      model: judgeModel(),
      schema: JUDGE_SCHEMA,
      prompt: buildJudgePrompt(query, chunks),
    });

    const parsed = JUDGE_SCHEMA.safeParse(result.object);
    if (!parsed.success) {
      return {
        grounded: false,
        rationale: "The groundedness judgement could not be parsed — failing closed to refused.",
        prefilterTopScore: topScore,
        judged: true,
      };
    }

    return {
      grounded: parsed.data.grounded,
      rationale: parsed.data.rationale,
      prefilterTopScore: topScore,
      judged: true,
    };
  } catch {
    // Any thrown error (network failure, provider error, or the SDK's own response-validation
    // failure for a malformed JSON body) fails closed — never defaults to grounded: true.
    return {
      grounded: false,
      rationale: "The groundedness judgement could not be parsed — failing closed to refused.",
      prefilterTopScore: topScore,
      judged: true,
    };
  }
}
