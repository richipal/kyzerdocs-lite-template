import { z } from "zod";

/**
 * Product-side runtime config — the `PRODUCT_CONFIG` replacement for the eval harness's
 * `EVAL_CONFIG` (D2-15). Every knob the promoted `src/lib/{ingest,embeddings,retrieval}` modules
 * read at runtime lives here.
 *
 * Importing this module must never throw, even on a completely unconfigured machine — every
 * secret is optional at the schema level (mirrors the eval harness's own env contract). Callers
 * decide when a missing key is fatal (e.g. the first embedding call, not module load).
 */

/**
 * Blank-as-absent (plan 02-07, D2-09d): a buyer who copies `.env.example` and leaves an optional
 * line present but empty (e.g. an env var set to `""` or whitespace-only) must land on the
 * default path, not crash the whole app at import time. Without this preprocessing step,
 * `z.string().min(1).optional()` rejects an empty string as an invalid *present* value rather than
 * treating it as absent — `envSchema.parse` would throw on module load for exactly the blank-line
 * case D2-09d exists to make silent.
 */
const blankAsUndefined = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().min(1).optional(),
);

// Note: the optional OpenRouter chat-provider key is deliberately NOT part of this schema.
// `src/lib/chat/model.ts` is the one file in the product that reads it — directly off
// `process.env`, at call time rather than at this module's import time — so a buyer who has never
// heard of it never encounters it anywhere else, including here (D2-09c/D2-09d, plan 02-07).
const envSchema = z.object({
  GEMINI_API_KEY: blankAsUndefined,
  ADMIN_PASSWORD: blankAsUndefined,
  CHAT_MODEL: blankAsUndefined,
  JUDGE_MODEL: blankAsUndefined,
  DATABASE_PATH: blankAsUndefined,
  UPLOAD_DIR: blankAsUndefined,
  // Phase 3 (STOR-03/STOR-06, D3-16): DATABASE_URL presence is the ONLY switch between local
  // (SQLite + local filesystem) and cloud (Postgres + Vercel Blob) mode. A buyer who copies
  // .env.example and leaves this blank must land on the local path, never crash at import — same
  // blankAsUndefined preprocessing as every other optional var, per D2-09d's convention.
  DATABASE_URL: blankAsUndefined,
  BLOB_READ_WRITE_TOKEN: blankAsUndefined,
});

/** Parses `process.env` against the schema above. Never throws — every field is optional (and
 * blank strings are normalized to absent above), so an arbitrary environment (including a
 * completely empty one, or one with blank-but-present optional lines) always parses
 * successfully. */
const env = envSchema.parse(process.env);

/** Deep-freezes an object graph so nested config fields cannot be mutated at runtime — ported
 * from the eval harness's own helper of the same shape and intent. */
function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Object.getOwnPropertyNames(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

export const PRODUCT_CONFIG = deepFreeze({
  /**
   * gemini-embedding-001 batching/retry knobs, read by the promoted `src/lib/embeddings/gemini.ts`.
   * `outputDimensionality: 768` matches KyzerDocs' existing schema (CLAUDE.md's Technology Stack
   * section) so lifted retrieval logic ports without a schema change.
   */
  embedding: {
    model: "gemini-embedding-001",
    outputDimensionality: 768,
    batchSize: 100,
    maxRetries: 5,
    baseRetryDelayMs: 500,
    maxConcurrentCalls: 3,
    interCallDelayMs: 1000,
  },
  /**
   * D2-05: a conventional starting point, NOT tuned — Phase 1 never varied targetChars/
   * overlapChars. Tuning this is legitimate work for a later plan; `npm run eval` is the
   * instrument for measuring the effect of any change here.
   */
  chunking: {
    targetChars: 1200,
    overlapChars: 150,
  },
  /**
   * D2-03: brute-force cosine + FTS keyword -> RRF at k=60, no reranker, no ANN index.
   * `prefilterMinScore` is Phase 1's measured in-scope p05 (0.6713) rounded down, well below the
   * out-of-scope p95 (0.762) — per D2-06/D2-08 this is a cheap pre-filter only (skip the
   * groundedness model call when nothing is remotely close) and must NEVER be the refusal
   * decision. Phase 1 measured `overlap_fraction: 0.6152` between in-scope and out-of-scope score
   * distributions, which is exactly why a threshold alone cannot be the gate — see D2-06/D2-07's
   * LLM groundedness check.
   */
  retrieval: {
    rrfK: 60,
    vectorTopN: 30,
    ftsTopN: 30,
    fusedTopK: 15,
    mmrLambda: 0.6,
    finalK: 6,
  /**
   * D2-08 cheap pre-filter — the ONLY job of this number is to skip a wasted judge call when
   * retrieval returned nothing usable at all. It is deliberately set far below anything a real
   * query produces, because it must never be the refusal decision (that is the judge's job, and
   * Phase 1 proved a threshold cannot do it: `overlap_fraction: 0.6152`).
   *
   * WAS 0.6, derived from Phase 1's in-scope p05 (0.6713) rounded down. That was wrong twice over:
   *
   *   1. p05 means 5% of legitimate in-scope questions already score BELOW it — the filter was
   *      built to reject a known tail of real queries.
   *   2. More fundamentally, absolute cosine values do not transfer between corpora. Phase 1
   *      measured 16 documents / 74 chunks (in-scope min 0.6330, out-of-scope min 0.6730). A buyer
   *      with 1 document / 2 chunks produces a different score range entirely. A real
   *      "summarize the policy" query on such a corpus measured 0.5973 — below every one of the 58
   *      questions Phase 1 ever scored — and was refused without the judge being consulted.
   *
   * Broad, whole-document queries ("summarize this policy") are structurally lower-scoring than the
   * specific factual lookups the golden dataset is built from, because no single chunk strongly
   * matches a summarisation request. Those are exactly the questions a small-business buyer asks.
   *
   * 0.25 is a floor for "retrieval returned essentially noise", not a relevance judgement.
   */
  prefilterMinScore: 0.25,
  },
  /**
   * D2-09c/D2-09d (plan 02-07): the product ships working on GEMINI_API_KEY alone.
   * `src/lib/chat/model.ts` is the ONLY file that reads the optional OpenRouter chat-provider key
   * and picks a branch; this config supplies both providers' model ids and decides nothing. The
   * two id namespaces differ — OpenRouter slugs are vendor-prefixed (`google/gemini-flash-latest`),
   * the direct `@ai-sdk/google` provider's are not (`gemini-flash-latest`) — so `CHAT_MODEL`/
   * `JUDGE_MODEL` overrides apply to whichever provider ends up active; a buyer who sets one is
   * expected to supply an id in the format their active provider expects.
   */
  chat: {
    google: {
      model: env.CHAT_MODEL ?? "gemini-flash-latest",
      judgeModel: env.JUDGE_MODEL ?? env.CHAT_MODEL ?? "gemini-flash-latest",
    },
    openrouter: {
      model: env.CHAT_MODEL ?? "google/gemini-flash-latest",
      judgeModel: env.JUDGE_MODEL ?? env.CHAT_MODEL ?? "google/gemini-flash-latest",
    },
  },
  paths: {
    databasePath: env.DATABASE_PATH ?? "./data/kyzerdocs.db",
    uploadDir: env.UPLOAD_DIR ?? "./data/uploads",
  },
  /**
   * Phase 3 (STOR-03/STOR-06, RESEARCH Pattern 1, D3-16): `cloudMode` is derived from
   * `DATABASE_URL` presence alone — no `MODE`/`NODE_ENV`/build-target alternative. This is the
   * single switch `storage/index.ts`'s driver-selection seam (and every other cloud-vs-local
   * branch in this phase, e.g. the rate limiter) reads.
   */
  cloudMode: env.DATABASE_URL !== undefined,
  /** `blobToken` — read here by `src/lib/storage/vector-snapshot.ts` (plan 03-07, D3-18's
   * measured mitigation) and, later, plan 03-10's file-storage driver. Stays undefined in local
   * mode, where it is never read. */
  storage: {
    blobToken: env.BLOB_READ_WRITE_TOKEN,
  },
});

export type ProductConfig = typeof PRODUCT_CONFIG;
