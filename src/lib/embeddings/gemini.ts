/**
 * Batched `gemini-embedding-001` client at 768 dimensions, with normalization enforced at this
 * module's boundary rather than at every call site.
 *
 * `gemini-embedding-001` does NOT auto-normalize output at any dimensionality other than its
 * native 3072 (CLAUDE.md's Technology Stack section) — a 768-dim vector arrives non-unit. Every
 * vector this module returns has already been L2-normalized and asserted before the function
 * resolves, matching VAL-03's mandate at both ingest time and query time. Centralising it
 * here — rather than at every retrieval call site — means there is exactly one place a
 * normalization bug could live.
 *
 * `taskType` differs by role, and the asymmetry is not cosmetic — the API produces different
 * vectors for the two roles (`ai.google.dev/gemini-api/docs/embeddings`):
 *   - `embedDocuments` -> `RETRIEVAL_DOCUMENT`
 *   - `embedQuery`     -> `RETRIEVAL_QUERY`
 *
 * Free-tier rate limits are not statically published for this model — the official docs point at
 * the live AI Studio dashboard rather than a fixed table (RESEARCH.md's LOW-confidence flag). No
 * request-per-minute figure is hardcoded anywhere in this file; batch size, concurrency, and
 * retry backoff are all read from `PRODUCT_CONFIG`, so the first real run calibrates them
 * empirically rather than trusting a guessed constant.
 */

import { GoogleGenAI } from "@google/genai";
import { PRODUCT_CONFIG } from "../config.js";
import { assertNormalized, l2Normalize } from "../retrieval/normalize.js";
import { mapWithLimit } from "../util/semaphore.js";

const MODEL = "gemini-embedding-001";
const DIMENSIONS = 768;

type TaskType = "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY";

export interface EmbedOptions {
  /** D-16's negative control: returns raw (non-normalized) vectors instead of the usual
   * normalize-and-assert path. The caller is expected to apply `assertNormalized` itself and see
   * it fail — this flag never becomes a parallel "quietly correct" code path. */
  skipNormalization?: boolean;
}

/**
 * Mean raw L2 norm of the first document batch's vectors *before* normalization, measured once
 * per process and exposed for the report. This is the empirical evidence (VAL-03) that manual
 * normalization was actually necessary, not a precaution taken on faith.
 */
let firstBatchMeanRawNorm: number | null = null;

export function getFirstBatchMeanRawNorm(): number | null {
  return firstBatchMeanRawNorm;
}

/** Test-only reset so `getFirstBatchMeanRawNorm`'s "once per process" behavior is testable in
 * isolation across multiple `describe` blocks. Not used by any production code path. */
export function _resetFirstBatchMeanRawNormForTests(): void {
  firstBatchMeanRawNorm = null;
}

function getClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not set — required to call the Gemini embedding API");
  }
  return new GoogleGenAI({ apiKey });
}

function rawL2Norm(vector: readonly number[]): number {
  let sumSquares = 0;
  for (const v of vector) sumSquares += v * v;
  return Math.sqrt(sumSquares);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function statusOf(err: unknown): number | undefined {
  const status = (err as { status?: unknown } | undefined)?.status;
  return typeof status === "number" ? status : undefined;
}

function isRetryableStatus(status: number | undefined): boolean {
  return status === 429 || (status !== undefined && status >= 500);
}

/**
 * Calls `embedContent` for one request-sized batch of texts, retrying a 429 or 5xx with bounded
 * exponential backoff. Throws once retries are exhausted, with the HTTP status in the message. A
 * non-retryable error (any other status, or no status at all) throws immediately on first
 * failure.
 */
async function embedContentWithRetry(
  ai: GoogleGenAI,
  contents: string[],
  taskType: TaskType,
): Promise<Array<number[] | undefined>> {
  const maxAttempts = PRODUCT_CONFIG.embedding.maxRetries;
  let attempt = 0;

  for (;;) {
    try {
      const response = await ai.models.embedContent({
        model: MODEL,
        contents,
        config: { outputDimensionality: DIMENSIONS, taskType },
      });
      return (response.embeddings ?? []).map((e) => e.values);
    } catch (err) {
      attempt++;
      const status = statusOf(err);
      const retryable = isRetryableStatus(status);
      if (!retryable || attempt >= maxAttempts) {
        const statusPart = status !== undefined ? ` (HTTP ${status})` : "";
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Gemini embedding call failed after ${attempt} attempt(s)${statusPart}: ${message}`,
        );
      }
      const backoffMs = PRODUCT_CONFIG.embedding.baseRetryDelayMs * 2 ** (attempt - 1);
      await sleep(backoffMs);
    }
  }
}

/**
 * Splits `texts` into request-sized batches (`EVAL_CONFIG.embedding.batchSize`), routes the
 * batches through `mapWithLimit` (`EVAL_CONFIG.maxConcurrentCalls` / `interCallDelayMs`),
 * reassembles results in input order, and applies normalize-and-assert to every vector before
 * returning.
 */
async function embedTexts(
  texts: string[],
  taskType: TaskType,
  opts: EmbedOptions | undefined,
  recordRawNorm: boolean,
): Promise<Float32Array[]> {
  if (texts.length === 0) return [];

  const ai = getClient();
  const batchSize = PRODUCT_CONFIG.embedding.batchSize;

  const batches: string[][] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    batches.push(texts.slice(i, i + batchSize));
  }

  const batchResults = await mapWithLimit(
    batches,
    PRODUCT_CONFIG.embedding.maxConcurrentCalls,
    PRODUCT_CONFIG.embedding.interCallDelayMs,
    (batch) => embedContentWithRetry(ai, batch, taskType),
  );

  const out: Array<Float32Array | undefined> = new Array(texts.length);
  let rawNormSum = 0;
  let rawNormCount = 0;
  let globalIndex = 0;

  for (let b = 0; b < batches.length; b++) {
    const result = batchResults[b]!;
    if (result !== null && typeof result === "object" && "error" in result) {
      throw new Error(`Embedding batch ${b} failed: ${(result as { error: string }).error}`);
    }
    const values = result as Array<number[] | undefined>;
    const batchTexts = batches[b]!;

    for (let i = 0; i < batchTexts.length; i++) {
      const idx = globalIndex + i;
      const raw = values[i];
      if (!raw || !Array.isArray(raw)) {
        throw new Error(`Gemini embedding response is missing values for index ${idx}`);
      }
      if (raw.length !== DIMENSIONS) {
        throw new Error(
          `Embedding at index ${idx} has ${raw.length} dimensions, expected ${DIMENSIONS}`,
        );
      }

      if (recordRawNorm) {
        rawNormSum += rawL2Norm(raw);
        rawNormCount++;
      }

      const asFloat32 = Float32Array.from(raw);
      const normalized = l2Normalize(asFloat32, { skip: opts?.skipNormalization });
      if (!opts?.skipNormalization) {
        assertNormalized(normalized);
      }
      out[idx] = normalized;
    }

    globalIndex += batchTexts.length;
  }

  if (recordRawNorm && rawNormCount > 0 && firstBatchMeanRawNorm === null) {
    firstBatchMeanRawNorm = rawNormSum / rawNormCount;
  }

  return out as Float32Array[];
}

/**
 * Embeds a batch of document chunk texts with `taskType: "RETRIEVAL_DOCUMENT"`. Larger-than-one-
 * request inputs are split, requested with bounded concurrency, and reassembled in input order.
 */
export async function embedDocuments(
  texts: string[],
  opts?: EmbedOptions,
): Promise<Float32Array[]> {
  return embedTexts(texts, "RETRIEVAL_DOCUMENT", opts, firstBatchMeanRawNorm === null);
}

/** Embeds a single query with `taskType: "RETRIEVAL_QUERY"` — a different vector space than
 * `embedDocuments`'s `RETRIEVAL_DOCUMENT` role for the same text. */
export async function embedQuery(text: string, opts?: EmbedOptions): Promise<Float32Array> {
  const [vector] = await embedTexts([text], "RETRIEVAL_QUERY", opts, false);
  return vector!;
}
