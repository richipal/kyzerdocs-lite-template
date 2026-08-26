import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_KB_ID } from "../types.js";
import { openDatabase } from "./pragmas.js";
import { applySchema } from "./schema.sql.js";
import { SqliteStorageDriver } from "./sqlite.js";
import type { NewChunk, NewDocument } from "./types.js";

const DIM = 768;
const OTHER_KB_ID = "kb-2";

function vector(): Float32Array {
  return new Float32Array(DIM);
}

function baseDocument(kbId: string, overrides: Partial<NewDocument> = {}): NewDocument {
  return {
    knowledgeBaseId: kbId,
    filename: "doc.txt",
    mimeType: "text/plain",
    byteSize: 100,
    contentHash: "hash",
    ...overrides,
  };
}

function baseChunk(kbId: string, documentId: string, overrides: Partial<NewChunk> = {}): NewChunk {
  return {
    knowledgeBaseId: kbId,
    documentId,
    chunkIndex: 0,
    content: "content",
    charStart: 0,
    charEnd: 10,
    embedding: vector(),
    ...overrides,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("storage/sqlite — searchKeyword + ingest jobs", () => {
  let dir: string;
  let db: DatabaseSync;
  let driver: SqliteStorageDriver;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kdl-sqlite-search-test-"));
    db = openDatabase(join(dir, "test.db"));
    applySchema(db);
    db.prepare("INSERT INTO knowledge_bases (id, name, created_at) VALUES (?, ?, ?)").run(
      OTHER_KB_ID,
      "Other",
      new Date().toISOString(),
    );
    driver = new SqliteStorageDriver(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("scopes results to the queried knowledge base — a shared term never leaks across KBs", async () => {
    const docA = await driver.insertDocument(baseDocument(DEFAULT_KB_ID));
    const docB = await driver.insertDocument(baseDocument(OTHER_KB_ID));

    await driver.upsertChunks([
      baseChunk(DEFAULT_KB_ID, docA.id, {
        id: "a-1",
        content: "the forklift safety procedure requires a spotter",
      }),
    ]);
    await driver.upsertChunks([
      baseChunk(OTHER_KB_ID, docB.id, {
        id: "b-1",
        content: "the forklift maintenance schedule is quarterly",
      }),
    ]);

    const resultsA = await driver.searchKeyword(DEFAULT_KB_ID, "forklift", 10);
    const resultsB = await driver.searchKeyword(OTHER_KB_ID, "forklift", 10);

    expect(resultsA.map((r) => r.id)).toEqual(["a-1"]);
    expect(resultsB.map((r) => r.id)).toEqual(["b-1"]);
  });

  it("handles an injection-shaped query without throwing, matching only sanitized tokens", async () => {
    const doc = await driver.insertDocument(baseDocument(DEFAULT_KB_ID));
    await driver.upsertChunks([
      baseChunk(DEFAULT_KB_ID, doc.id, { id: "ppe-1", content: "PPE is required on site" }),
    ]);

    await expect(
      driver.searchKeyword(DEFAULT_KB_ID, 'ppe" OR 1=1 NEAR* ^:', 10),
    ).resolves.not.toThrow();

    const results = await driver.searchKeyword(DEFAULT_KB_ID, 'ppe" OR 1=1 NEAR* ^:', 10);
    expect(results.map((r) => r.id)).toEqual(["ppe-1"]);
  });

  it("ranks a chunk mentioning the term 3x above one mentioning it once, ranks 0-indexed contiguous", async () => {
    const doc = await driver.insertDocument(baseDocument(DEFAULT_KB_ID));
    await driver.upsertChunks([
      baseChunk(DEFAULT_KB_ID, doc.id, {
        id: "weak",
        chunkIndex: 0,
        content: "safety is important on every site",
      }),
      baseChunk(DEFAULT_KB_ID, doc.id, {
        id: "strong",
        chunkIndex: 1,
        content: "safety safety safety procedures govern every safety inspection",
      }),
    ]);

    const results = await driver.searchKeyword(DEFAULT_KB_ID, "safety", 10);

    expect(results[0]!.id).toBe("strong");
    expect(results.map((r) => r.rank)).toEqual(results.map((_, i) => i));
  });

  it("returns an empty array for a query matching nothing, without throwing", async () => {
    const doc = await driver.insertDocument(baseDocument(DEFAULT_KB_ID));
    await driver.upsertChunks([baseChunk(DEFAULT_KB_ID, doc.id, { id: "c-1" })]);

    const results = await driver.searchKeyword(DEFAULT_KB_ID, "nonexistentxyz", 10);
    expect(results).toEqual([]);
  });

  it("createJob -> updateJobProgress x3 -> getJob reflects monotonic progress and live updatedAt", async () => {
    const doc = await driver.insertDocument(baseDocument(DEFAULT_KB_ID));
    const job = await driver.createJob({
      knowledgeBaseId: DEFAULT_KB_ID,
      documentId: doc.id,
      status: "embedding",
      chunksTotal: 30,
      chunksProcessed: 0,
    });

    const updatedAts: string[] = [];
    for (const processed of [10, 20, 30]) {
      await sleep(2);
      await driver.updateJobProgress(job.id, { chunksProcessed: processed });
      const current = await driver.getJob(job.id);
      updatedAts.push(current!.updatedAt);
    }

    const final = await driver.getJob(job.id);
    expect(final!.chunksProcessed).toBe(30);
    expect(new Set(updatedAts).size).toBe(3);
  });
});
