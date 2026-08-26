import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_KB_ID } from "../types.js";
import { openDatabase } from "../storage/pragmas.js";
import { applySchema } from "../storage/schema.sql.js";
import { SqliteStorageDriver } from "../storage/sqlite.js";

// The pipeline must never hit the real Gemini API in a unit test (no network, no quota). Mocked
// before `./pipeline.js` is imported so its own static `embedDocuments` import binds to the mock.
const embedDocumentsMock = vi.fn(async (texts: string[]) =>
  texts.map(() => {
    const v = new Float32Array(768);
    v[0] = 1; // already-unit-norm vector — no normalization surprises in this suite
    return v;
  }),
);
vi.mock("../embeddings/gemini.js", () => ({
  embedDocuments: (texts: string[]) => embedDocumentsMock(texts),
}));

const { runIngestion } = await import("./pipeline.js");

const CORPUS_PDF = join(process.cwd(), "evals/corpus/osha-aed-cardiac-arrest-workplace.pdf");

// `readFileSync` returns a Node `Buffer`, whose `.slice()` returns a *view* onto Node's pooled
// ArrayBuffer rather than a copy — `unpdf`'s worker-transfer `bytes.slice()` call (parse.ts) then
// structured-clone-transfers the wrong window of bytes. Wrapping in `new Uint8Array(...)` forces
// a fresh, exactly-sized ArrayBuffer, matching parse.test.ts's own corpus-loading convention.
function readCorpusPdf(): Uint8Array {
  return new Uint8Array(readFileSync(CORPUS_PDF));
}

describe("ingest/pipeline — runIngestion happy path", () => {
  let dir: string;
  let db: DatabaseSync;
  let driver: SqliteStorageDriver;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kdl-pipeline-test-"));
    db = openDatabase(join(dir, "test.db"));
    applySchema(db);
    driver = new SqliteStorageDriver(db);
    embedDocumentsMock.mockClear();
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("takes a real corpus PDF from pending to ready with page metadata on every chunk", async () => {
    const bytes = readCorpusPdf();
    const document = await driver.insertDocument({
      knowledgeBaseId: DEFAULT_KB_ID,
      filename: "osha-aed-cardiac-arrest-workplace.pdf",
      mimeType: "application/pdf",
      byteSize: bytes.byteLength,
      contentHash: "test-hash-1",
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
    expect(finalDoc?.status).toBe("ready");
    expect(finalDoc?.pageCount).toBeGreaterThan(0);

    const finalJob = await driver.getJob(job.id);
    expect(finalJob?.status).toBe("ready");
    expect(finalJob?.chunksProcessed).toBe(finalJob?.chunksTotal);
    expect(finalJob?.chunksTotal).toBeGreaterThan(0);

    const nullPageRow = db
      .prepare("SELECT COUNT(*) AS c FROM chunks WHERE page_number IS NULL AND document_id = ?")
      .get(document.id) as { c: number };
    expect(nullPageRow.c).toBe(0);

    const totalRow = db.prepare("SELECT COUNT(*) AS c FROM chunks WHERE document_id = ?").get(document.id) as {
      c: number;
    };
    expect(totalRow.c).toBeGreaterThan(0);
    expect(totalRow.c).toBe(finalJob?.chunksTotal);
  });

  it("calls embedDocuments (not embedQuery) — ingest uses RETRIEVAL_DOCUMENT, never RETRIEVAL_QUERY", async () => {
    const bytes = readCorpusPdf();
    const document = await driver.insertDocument({
      knowledgeBaseId: DEFAULT_KB_ID,
      filename: "osha-aed-cardiac-arrest-workplace.pdf",
      mimeType: "application/pdf",
      byteSize: bytes.byteLength,
      contentHash: "test-hash-2",
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

    expect(embedDocumentsMock).toHaveBeenCalled();
  });

  it("reports progress at least 10 times with strictly increasing chunksProcessed for a large synthetic document", async () => {
    // ~1100 paragraph-separated blocks of ~1200 chars each -> ~1100 chunks -> >=10 batches at the
    // configured batchSize of 100.
    const paragraph = "Sentence about safety procedures and equipment use. ".repeat(24); // ~1300 chars
    const text = Array.from({ length: 1100 }, (_, i) => `Paragraph ${i}. ${paragraph}`).join("\n\n");
    const bytes = Buffer.from(text, "utf-8");

    const document = await driver.insertDocument({
      knowledgeBaseId: DEFAULT_KB_ID,
      filename: "big-doc.txt",
      mimeType: "text/plain",
      byteSize: bytes.byteLength,
      contentHash: "test-hash-3",
    });
    const job = await driver.createJob({ knowledgeBaseId: DEFAULT_KB_ID, documentId: document.id });

    const progressCalls: number[] = [];
    const updateJobProgressSpy = vi.spyOn(driver, "updateJobProgress");
    updateJobProgressSpy.mockImplementation(async (id, progress) => {
      if (typeof progress.chunksProcessed === "number") progressCalls.push(progress.chunksProcessed);
      return SqliteStorageDriver.prototype.updateJobProgress.call(driver, id, progress);
    });

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

    updateJobProgressSpy.mockRestore();

    expect(progressCalls.length).toBeGreaterThanOrEqual(10);
    for (let i = 1; i < progressCalls.length; i++) {
      expect(progressCalls[i]!).toBeGreaterThan(progressCalls[i - 1]!);
    }

    const finalDoc = await driver.getDocument(document.id);
    expect(finalDoc?.status).toBe("ready");
  });
});
