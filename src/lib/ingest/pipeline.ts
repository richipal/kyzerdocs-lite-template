/**
 * ING-02/03/04/05/06/08/09 write-path pipeline: parse -> chunk -> locate -> batched embed ->
 * transactional per-batch persist, driving the same `documents`/`ingest_jobs` rows the client
 * polls (ARCHITECTURE.md Pattern 2). `runIngestion` is awaited inside the request — there is no
 * queue, no fire-and-forget, and no "local mode is simpler" synchronous shortcut, because the job
 * row is what makes progress observable (ING-03) and failure resumable (ING-08) identically on a
 * long-lived local process and on a future serverless deployment.
 *
 * PITFALLS.md #5 (silent partial ingestion): every batch is embedded, persisted through
 * `upsertChunks` (already transactional per call), and progress-reported BEFORE moving to the
 * next batch — so a quota failure on batch N never loses batches 1..N-1's completed work, and the
 * document/job status can only ever settle at `ready` or `failed`, never stuck at `parsing`/
 * `embedding`.
 */

import type { ErrorCode } from "../errors.js";
import { AppError } from "../errors.js";
import { PRODUCT_CONFIG } from "../config.js";
import { embedDocuments } from "../embeddings/gemini.js";
import { getStorageDriver } from "../storage/index.js";
import type { StorageDriver } from "../storage/driver.js";
import type { NewChunk } from "../storage/types.js";
import { readUpload } from "../storage/files.js";
import { chunkText } from "./chunk.js";
import { pageForRange, sectionTitleForRange } from "./locate.js";
import { parseDocument } from "./parse.js";
import type { FileMeta } from "./types.js";

export interface RunIngestionInput {
  kbId: string;
  documentId: string;
  jobId: string;
  bytes: Uint8Array;
  meta: FileMeta;
}

export interface IngestionDeps {
  /** Defaults to the process-wide `getStorageDriver()` singleton; tests pass an isolated
   * in-memory/temp-file driver instead. */
  driver?: StorageDriver;
}

/**
 * Classifies a thrown error into a KDL code + message pair before it reaches the document/job
 * rows (T-02-05-05/PITFALLS.md #5). Parse failures already carry the right `KDL-PARSE-*` code
 * from plan 02-03's classifier and pass through unchanged; everything else is pattern-matched
 * against the specific error shapes `embedDocuments`/`assertNormalized`/`packEmbedding` are known
 * to throw (see `src/lib/embeddings/gemini.ts` and `src/lib/retrieval/normalize.ts`).
 */
function classifyIngestError(err: unknown): { code: ErrorCode; message: string } {
  if (err instanceof AppError) {
    return { code: err.code, message: err.message };
  }

  const message = err instanceof Error ? err.message : String(err);

  // normalize.ts#assertNormalized's exact thrown message.
  if (/L2 norm assertion failed/i.test(message)) {
    return { code: "KDL-EMBED-003", message };
  }
  // gemini.ts#embedContentWithRetry includes "(HTTP <status>)" once it has an HTTP status to
  // report — both 429 (quota) and 5xx exhaust the same retry/backoff loop and land here as the
  // same buyer-facing "rate limit or quota" story.
  if (/\(HTTP \d+\)/.test(message)) {
    return { code: "KDL-EMBED-001", message };
  }
  // gemini.ts's own wrapper message prefix, thrown with no HTTP status when the request never
  // got a response at all (DNS/connection failure) — the network-unreachable case.
  if (/gemini embedding call failed/i.test(message) || /gemini embedding response/i.test(message)) {
    return { code: "KDL-EMBED-002", message };
  }

  return { code: "KDL-INGEST-001", message };
}

/** Flattens an error and its `cause` chain into one loggable string. `AppError` carries the real
 * failure on `cause` (see `classifyPdfError`), so logging only the top-level message would record
 * the same buyer-facing sentence that is already stored — and none of the reason. */
function formatErrorChain(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  let depth = 0;
  while (current && depth < 5) {
    if (current instanceof Error) {
      parts.push(`${current.name}: ${current.message}`);
      if (depth === 0 && current.stack) parts.push(current.stack.split("\n").slice(1, 4).join(" | "));
      current = (current as { cause?: unknown }).cause;
    } else {
      parts.push(String(current));
      current = undefined;
    }
    depth += 1;
  }
  return parts.join("  <- caused by  ");
}

/** Deterministic chunk id from `(documentId, chunkIndex)` — required so a resumed run's
 * `upsertChunks` call (`ON CONFLICT(id) DO UPDATE`) overwrites the same rows rather than creating
 * duplicates (ING-08's "no duplication on resume" requirement). */
function chunkId(documentId: string, chunkIndex: number): string {
  return `${documentId}:${chunkIndex}`;
}

/**
 * Finds an existing, non-superseded document in `kbId` that matches the just-ingested document's
 * `contentHash` or `filename`, excluding the document itself. Returns `null` when there is no
 * match. Called only after the new document has reached `ready` (ING-06's ordering requirement:
 * a failed re-ingest must never touch the previous document's content).
 */
async function findSupersedeTarget(
  driver: StorageDriver,
  kbId: string,
  newDocumentId: string,
): Promise<string | null> {
  const newDoc = await driver.getDocument(newDocumentId);
  if (!newDoc) return null;

  const all = await driver.listDocuments(kbId);
  const match = all.find(
    (d) =>
      d.id !== newDocumentId &&
      d.supersededBy === null &&
      (d.contentHash === newDoc.contentHash || d.filename === newDoc.filename),
  );
  return match?.id ?? null;
}

/**
 * The shared core of `runIngestion`/`resumeIngestion`. `resumeFromChunkIndex` skips chunks
 * already persisted by a prior attempt (their embeddings and rows are already correct — re-
 * embedding them would waste quota) while still re-parsing/re-chunking from scratch, which is
 * cheap relative to embedding and guarantees deterministic chunk boundaries/ids.
 */
async function runPipeline(
  input: RunIngestionInput,
  driver: StorageDriver,
  resumeFromChunkIndex: number,
): Promise<void> {
  const { kbId, documentId, jobId, bytes, meta } = input;

  await driver.updateJobProgress(jobId, { status: "parsing", phase: "parsing" });
  await driver.updateDocument(documentId, { status: "parsing" });

  let chunksProcessed = resumeFromChunkIndex;

  try {
    const parsed = await parseDocument(bytes, meta);

    const rawChunks = chunkText(parsed.text, meta.filename, PRODUCT_CONFIG.chunking);
    const attached = rawChunks.map((c) => ({
      ...c,
      pageNumber: pageForRange(parsed.pages, c.charStart, c.charEnd),
      sectionTitle: sectionTitleForRange(parsed.text, c.charStart),
    }));
    const chunksTotal = attached.length;

    await driver.updateJobProgress(jobId, {
      status: "embedding",
      phase: "embedding",
      chunksTotal,
      chunksProcessed: resumeFromChunkIndex,
    });
    await driver.updateDocument(documentId, { status: "embedding" });

    const batchSize = PRODUCT_CONFIG.embedding.batchSize;

    for (let start = resumeFromChunkIndex; start < attached.length; start += batchSize) {
      const batch = attached.slice(start, start + batchSize);
      const texts = batch.map((c) => c.content);
      const vectors = await embedDocuments(texts);

      const newChunks: NewChunk[] = batch.map((c, i) => ({
        id: chunkId(documentId, c.chunkIndex),
        knowledgeBaseId: kbId,
        documentId,
        chunkIndex: c.chunkIndex,
        content: c.content,
        charStart: c.charStart,
        charEnd: c.charEnd,
        pageNumber: c.pageNumber,
        sectionTitle: c.sectionTitle,
        embedding: vectors[i]!,
      }));

      // Write-through per batch, not one write at the end (PITFALLS.md #5) — `upsertChunks` is
      // already transactional per call, so this batch's rows are durable before the next batch
      // is even requested.
      await driver.upsertChunks(newChunks);
      chunksProcessed = start + batch.length;
      await driver.updateJobProgress(jobId, { chunksProcessed });
    }

    // `chunksProcessed` is intentionally omitted here — the loop above already left it at
    // `chunksTotal` (every chunk was persisted before this line is reached), so re-writing the
    // same value would be a spurious duplicate in the ING-09 batch-progress signal.
    await driver.updateJobProgress(jobId, { status: "ready", phase: "ready" });
    await driver.updateDocument(documentId, { status: "ready", pageCount: parsed.pageCount });

    const supersedeTargetId = await findSupersedeTarget(driver, kbId, documentId);
    if (supersedeTargetId) {
      await driver.supersedeDocument(supersedeTargetId, documentId);
    }
  } catch (err) {
    const classified = classifyIngestError(err);
    // The buyer-facing `errorMessage` persisted below is deliberately free of technical detail
    // (S-6) and is rendered verbatim by `DocumentRow`. That leaves nobody able to diagnose a
    // failure after the fact: a valid PDF that fails only in the deployed runtime reads to the
    // buyer as "may be unreadable or corrupt", and the real reason — held on the AppError's
    // `cause` — was discarded at this line. Log the full chain server-side so it reaches the
    // platform's runtime logs while the buyer still gets plain language.
    // eslint-disable-next-line no-console -- deliberate: this is the only diagnostic trail a
    // deployed failure leaves, and support cannot ask a non-technical buyer to reproduce it.
    console.error(
      `[ingest] document=${documentId} job=${jobId} failed code=${classified.code}`,
      formatErrorChain(err),
    );
    // A failure must never leave status at `parsing`/`embedding` — it settles at `failed` with a
    // specific code, and `chunksProcessed` stays at the last successfully persisted batch (not 0,
    // not the total) so `resumeIngestion` knows exactly where to continue.
    await driver.updateJobProgress(jobId, {
      status: "failed",
      chunksProcessed,
      errorCode: classified.code,
      errorMessage: classified.message,
    });
    await driver.updateDocument(documentId, {
      status: "failed",
      errorCode: classified.code,
      errorMessage: classified.message,
    });
  }
}

/**
 * Runs a fresh ingestion end to end: parse -> chunk -> locate -> batched embed -> transactional
 * persist, driving `documentId`'s and `jobId`'s rows throughout. Resolves normally whether the
 * run reaches `ready` or a classified `failed` state — callers read the resulting row(s) rather
 * than relying on a thrown exception, so a route can return `{ jobId, documentId, status }`
 * without a 500 for an ordinary, correctly-recorded ingestion failure.
 */
export async function runIngestion(input: RunIngestionInput, deps: IngestionDeps = {}): Promise<void> {
  const driver = deps.driver ?? getStorageDriver();
  await runPipeline(input, driver, 0);
}

/**
 * Resumes a previously failed, retryable ingestion job from its last successfully persisted
 * batch (ING-08). Re-reads the stored upload bytes, re-parses and re-chunks (cheap relative to
 * embedding — the whole point of doing it again rather than caching intermediate state), and
 * skips every chunk index below the job's last recorded `chunksProcessed`.
 */
export async function resumeIngestion(jobId: string, deps: IngestionDeps = {}): Promise<void> {
  const driver = deps.driver ?? getStorageDriver();

  const job = await driver.getJob(jobId);
  if (!job) {
    throw new AppError("KDL-INGEST-001", { message: `No ingest job found for id ${jobId}` });
  }
  const document = await driver.getDocument(job.documentId);
  if (!document) {
    throw new AppError("KDL-INGEST-001", { message: `No document found for id ${job.documentId}` });
  }
  if (!document.storagePath) {
    throw new AppError("KDL-INGEST-001", {
      message: `Document ${document.id} has no stored upload to resume from`,
    });
  }

  const bytes = await readUpload(document.storagePath);
  const meta: FileMeta = {
    filename: document.filename,
    mimeType: document.mimeType,
    byteSize: document.byteSize,
  };

  await runPipeline(
    { kbId: job.knowledgeBaseId, documentId: job.documentId, jobId: job.id, bytes, meta },
    driver,
    job.chunksProcessed ?? 0,
  );
}
