import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_KB_ID } from "../types.js";
import { openDatabase } from "../storage/pragmas.js";
import { applySchema } from "../storage/schema.sql.js";
import { SqliteStorageDriver } from "../storage/sqlite.js";

// PRODUCT_CONFIG (transitively imported by storage/files.js, which resumeIngestion needs to
// re-read the stored upload) reads UPLOAD_DIR from process.env exactly once and freezes — the
// override must land before any dynamic import below evaluates that module graph.
const uploadDir = mkdtempSync(join(tmpdir(), "kdl-pipeline-resume-uploads-"));
process.env.UPLOAD_DIR = uploadDir;

/** Controls the mocked `embedDocuments`: `failOnCall === N` throws a 429-shaped error on the Nth
 * call (1-indexed) across the whole test, then behaves normally afterward. Reset in `beforeEach`. */
let embedCallCount = 0;
let failOnCall: number | null = null;

function unitVector(): Float32Array {
  const v = new Float32Array(768);
  v[0] = 1;
  return v;
}

const embedDocumentsMock = vi.fn(async (texts: string[]) => {
  embedCallCount++;
  if (failOnCall !== null && embedCallCount === failOnCall) {
    // Shaped like gemini.ts#embedContentWithRetry's own thrown message after retries exhaust —
    // pipeline.ts's classifier keys off the literal "(HTTP <status>)" substring.
    throw new Error("Gemini embedding call failed after 5 attempt(s) (HTTP 429): rate limit exceeded");
  }
  return texts.map(() => unitVector());
});

vi.mock("../embeddings/gemini.js", () => ({
  embedDocuments: (texts: string[]) => embedDocumentsMock(texts),
}));

const { runIngestion, resumeIngestion } = await import("./pipeline.js");
const { storeUpload } = await import("../storage/files.js");
const { ERROR_CODES } = await import("../errors.js");

const CORPUS_DIR = join(process.cwd(), "evals/corpus");

function readCorpusPdf(filename: string): Uint8Array {
  return new Uint8Array(readFileSync(join(CORPUS_DIR, filename)));
}

/** ~1100 paragraph-separated blocks of ~1300 chars -> ~1196 chunks -> 12 batches at the
 * configured batchSize of 100 (batch 2 covers chunk indices [100, 200)), enough headroom for a
 * "fails on batch 2, resumes to completion" scenario. `suffix` keeps two calls' byte content
 * (and therefore contentHash) distinct when a test needs two independent documents. */
function bigText(paragraphs = 1100, suffix = ""): string {
  const paragraph = "Sentence about safety procedures and equipment use. ".repeat(24);
  return Array.from({ length: paragraphs }, (_, i) => `Paragraph ${i}. ${paragraph}`).join("\n\n") + suffix;
}

describe("ingest/pipeline — failure classification, resumability, supersede (ING-06/ING-08)", () => {
  let dir: string;
  let db: DatabaseSync;
  let driver: SqliteStorageDriver;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kdl-pipeline-resume-db-"));
    db = openDatabase(join(dir, "test.db"));
    applySchema(db);
    driver = new SqliteStorageDriver(db);
    embedCallCount = 0;
    failOnCall = null;
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function ingest(filename: string, bytes: Buffer) {
    const upload = await storeUpload(bytes, { filename, byteSize: bytes.byteLength });
    const document = await driver.insertDocument({
      knowledgeBaseId: DEFAULT_KB_ID,
      filename,
      mimeType: "text/plain",
      byteSize: bytes.byteLength,
      contentHash: upload.contentHash,
      storagePath: upload.storagePath,
    });
    const job = await driver.createJob({ knowledgeBaseId: DEFAULT_KB_ID, documentId: document.id });
    await runIngestion(
      {
        kbId: DEFAULT_KB_ID,
        documentId: document.id,
        jobId: job.id,
        bytes,
        meta: { filename: document.filename, mimeType: document.mimeType, byteSize: document.byteSize },
      },
      { driver },
    );
    return { document, job };
  }

  function chunkCountFor(documentId: string): number {
    return (
      db.prepare("SELECT COUNT(*) AS c FROM chunks WHERE document_id = ?").get(documentId) as { c: number }
    ).c;
  }

  it("quota exhaustion on batch 2 leaves failed status, KDL-EMBED-001, and chunksProcessed at exactly one batch", async () => {
    failOnCall = 2;
    const bytes = Buffer.from(bigText(), "utf-8");
    const { document, job } = await ingest("quota-doc.txt", bytes);

    const finalDoc = await driver.getDocument(document.id);
    const finalJob = await driver.getJob(job.id);

    expect(finalDoc?.status).toBe("failed");
    expect(finalJob?.status).toBe("failed");
    expect(finalJob?.errorCode).toBe("KDL-EMBED-001");
    expect(finalDoc?.errorCode).toBe("KDL-EMBED-001");

    // Exactly one batch, not 0, not the total.
    expect(finalJob?.chunksProcessed).toBe(100);
    expect(finalJob?.chunksProcessed).not.toBe(0);
    expect(finalJob?.chunksProcessed).not.toBe(finalJob?.chunksTotal);

    // No stuck status: never left at "parsing"/"embedding".
    expect(["ready", "failed"]).toContain(finalDoc?.status);
    expect(["ready", "failed"]).toContain(finalJob?.status);
  });

  it("resumeIngestion continues from the last persisted batch, reaching ready with no duplicate chunks", async () => {
    failOnCall = 2;
    const bytes = Buffer.from(bigText(), "utf-8");
    const { document, job } = await ingest("resume-doc.txt", bytes);

    const failedJob = await driver.getJob(job.id);
    expect(failedJob?.status).toBe("failed");
    expect(failedJob?.chunksProcessed).toBe(100);

    // Healthy embedder from here on.
    failOnCall = null;
    await resumeIngestion(job.id, { driver });

    const resumedDoc = await driver.getDocument(document.id);
    const resumedJob = await driver.getJob(job.id);
    expect(resumedDoc?.status).toBe("ready");
    expect(resumedJob?.status).toBe("ready");
    expect(resumedJob?.chunksProcessed).toBe(resumedJob?.chunksTotal);

    const resumedChunkCount = chunkCountFor(document.id);

    // Distinct content (suffix) so this comparison document's contentHash never collides with the
    // resumed one above — an accidental ING-06 supersede match would confuse this comparison.
    const cleanBytes = Buffer.from(bigText(1100, " CLEAN-COPY"), "utf-8");
    const { document: cleanDocument } = await ingest("resume-doc-clean.txt", cleanBytes);
    const cleanChunkCount = chunkCountFor(cleanDocument.id);

    expect(resumedChunkCount).toBe(cleanChunkCount);
  });

  it("no stuck status after an injected mid-run failure: document.status settles at ready or failed, never embedding/parsing", async () => {
    failOnCall = 3;
    const bytes = Buffer.from(bigText(), "utf-8");
    const { document } = await ingest("stuck-status-doc.txt", bytes);

    const finalDoc = await driver.getDocument(document.id);
    expect(finalDoc?.status).not.toBe("parsing");
    expect(finalDoc?.status).not.toBe("embedding");
    expect(["ready", "failed"]).toContain(finalDoc?.status);
  });

  it("scanned PDF fails end to end with KDL-PARSE-001 and a non-empty action string", async () => {
    const bytes = readCorpusPdf("osha-tractor-hazards-agricultural-workers-scanned.pdf");
    const document = await driver.insertDocument({
      knowledgeBaseId: DEFAULT_KB_ID,
      filename: "scanned.pdf",
      mimeType: "application/pdf",
      byteSize: bytes.byteLength,
      contentHash: "scanned-hash",
    });
    const job = await driver.createJob({ knowledgeBaseId: DEFAULT_KB_ID, documentId: document.id });

    await runIngestion(
      {
        kbId: DEFAULT_KB_ID,
        documentId: document.id,
        jobId: job.id,
        bytes,
        meta: { filename: document.filename, mimeType: document.mimeType, byteSize: document.byteSize },
      },
      { driver },
    );

    const finalDoc = await driver.getDocument(document.id);
    expect(finalDoc?.status).toBe("failed");
    expect(finalDoc?.errorCode).toBe("KDL-PARSE-001");

    const action = ERROR_CODES[finalDoc!.errorCode as keyof typeof ERROR_CODES].action;
    expect(action.length).toBeGreaterThan(0);
  });

  it("supersede-on-reupload: ingesting the same file twice yields one non-superseded row and no orphaned rows", async () => {
    const bytes = Buffer.from(bigText(200), "utf-8");

    const { document: firstDoc } = await ingest("dup.txt", bytes);
    const firstChunkCount = chunkCountFor(firstDoc.id);
    expect(firstChunkCount).toBeGreaterThan(0);

    const { document: secondDoc } = await ingest("dup.txt", bytes);

    const firstAfter = await driver.getDocument(firstDoc.id);
    const secondAfter = await driver.getDocument(secondDoc.id);
    expect(firstAfter?.supersededBy).toBe(secondDoc.id);
    expect(secondAfter?.supersededBy).toBeNull();

    // Chunk count is unchanged by the supersede — the second ingest's own chunks equal the
    // first's, and the first's are gone.
    const totalChunkCount = (
      db.prepare("SELECT COUNT(*) AS c FROM chunks WHERE knowledge_base_id = ?").get(DEFAULT_KB_ID) as {
        c: number;
      }
    ).c;
    expect(totalChunkCount).toBe(firstChunkCount);

    const nonSupersededCount = (
      db
        .prepare(
          "SELECT COUNT(*) AS c FROM documents WHERE knowledge_base_id = ? AND filename = ? AND superseded_by IS NULL",
        )
        .get(DEFAULT_KB_ID, "dup.txt") as { c: number }
    ).c;
    expect(nonSupersededCount).toBe(1);

    const orphanedFtsCount = (
      db.prepare("SELECT COUNT(*) AS c FROM chunks_fts WHERE chunk_id NOT IN (SELECT id FROM chunks)").get() as {
        c: number;
      }
    ).c;
    expect(orphanedFtsCount).toBe(0);
  });

  it("ordering: if the second ingest fails, the first document is still non-superseded and its chunks still exist", async () => {
    const bytes = Buffer.from(bigText(), "utf-8");

    const { document: firstDocument } = await ingest("order.txt", bytes);
    const firstChunkCountBefore = chunkCountFor(firstDocument.id);
    expect(firstChunkCountBefore).toBeGreaterThan(0);

    // Second ingest of the same content, forced to fail on batch 2 — never reaches the supersede
    // step (which only runs after a document reaches `ready`). `failOnCall` counts embedDocuments
    // calls from here (reset), not across both ingests.
    embedCallCount = 0;
    failOnCall = 2;
    const { document: secondDocument } = await ingest("order.txt", bytes);

    const secondDoc = await driver.getDocument(secondDocument.id);
    expect(secondDoc?.status).toBe("failed");

    const firstDocAfter = await driver.getDocument(firstDocument.id);
    expect(firstDocAfter?.supersededBy).toBeNull();

    const firstChunkCountAfter = chunkCountFor(firstDocument.id);
    expect(firstChunkCountAfter).toBe(firstChunkCountBefore);
  });
});
