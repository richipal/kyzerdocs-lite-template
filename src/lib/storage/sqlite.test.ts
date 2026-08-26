import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import { DEFAULT_KB_ID } from "../types.js";
import { openDatabase } from "./pragmas.js";
import { applySchema } from "./schema.sql.js";
import { SqliteStorageDriver } from "./sqlite.js";
import type { NewChunk, NewDocument } from "./types.js";

const DIM = 768;

function makeVector(fill: (i: number) => number): Float32Array {
  const v = new Float32Array(DIM);
  for (let i = 0; i < DIM; i++) v[i] = fill(i);
  return v;
}

function baseDocument(overrides: Partial<NewDocument> = {}): NewDocument {
  return {
    knowledgeBaseId: DEFAULT_KB_ID,
    filename: "doc.txt",
    mimeType: "text/plain",
    byteSize: 100,
    contentHash: "hash",
    ...overrides,
  };
}

function baseChunk(documentId: string, overrides: Partial<NewChunk> = {}): NewChunk {
  return {
    knowledgeBaseId: DEFAULT_KB_ID,
    documentId,
    chunkIndex: 0,
    content: "hello world",
    charStart: 0,
    charEnd: 11,
    embedding: makeVector((i) => i / DIM),
    ...overrides,
  };
}

describe("storage/sqlite — SqliteStorageDriver", () => {
  let dir: string;
  let db: DatabaseSync;
  let driver: SqliteStorageDriver;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kdl-sqlite-test-"));
    db = openDatabase(join(dir, "test.db"));
    applySchema(db);
    driver = new SqliteStorageDriver(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips a packed 768-float vector exactly, byteLength 3072", async () => {
    const doc = await driver.insertDocument(baseDocument());
    const vector = makeVector((i) => Math.sin(i) * 0.5 + i * 1e-4);
    await driver.upsertChunks([baseChunk(doc.id, { id: "chunk-1", embedding: vector })]);

    const vectors = await driver.getAllChunkVectors(DEFAULT_KB_ID);
    expect(vectors).toHaveLength(1);
    expect(vectors[0]!.embedding.byteLength).toBe(3072);

    const roundTripped = new Float32Array(
      vectors[0]!.embedding.buffer,
      vectors[0]!.embedding.byteOffset,
      DIM,
    );
    for (let i = 0; i < DIM; i++) {
      expect(roundTripped[i]).toBe(vector[i]);
    }
  });

  it("stores embedding with SQLite typeof 'blob'", async () => {
    const doc = await driver.insertDocument(baseDocument());
    await driver.upsertChunks([baseChunk(doc.id, { id: "chunk-1" })]);

    const row = db.prepare("SELECT typeof(embedding) AS t FROM chunks LIMIT 1").get() as {
      t: string;
    };
    expect(row.t).toBe("blob");
  });

  it("upsertChunks is idempotent — same ids twice leaves the same row counts", async () => {
    const doc = await driver.insertDocument(baseDocument());
    const chunks = Array.from({ length: 5 }, (_, i) =>
      baseChunk(doc.id, { id: `chunk-${i}`, chunkIndex: i, content: `chunk number ${i}` }),
    );

    await driver.upsertChunks(chunks);
    await driver.upsertChunks(chunks);

    const chunkCount = db.prepare("SELECT COUNT(*) AS c FROM chunks").get() as { c: number };
    const ftsCount = db.prepare("SELECT COUNT(*) AS c FROM chunks_fts").get() as { c: number };
    expect(chunkCount.c).toBe(5);
    expect(ftsCount.c).toBe(5);
  });

  it("deleteDocument removes the document, its chunks, and its chunks_fts rows", async () => {
    const doc = await driver.insertDocument(baseDocument());
    const chunks = Array.from({ length: 3 }, (_, i) =>
      baseChunk(doc.id, { id: `chunk-${i}`, chunkIndex: i }),
    );
    await driver.upsertChunks(chunks);

    const ftsBefore = db.prepare("SELECT COUNT(*) AS c FROM chunks_fts").get() as { c: number };

    await driver.deleteDocument(doc.id);

    const remainingChunks = db
      .prepare("SELECT COUNT(*) AS c FROM chunks WHERE document_id = ?")
      .get(doc.id) as { c: number };
    const ftsAfter = db.prepare("SELECT COUNT(*) AS c FROM chunks_fts").get() as { c: number };

    expect(remainingChunks.c).toBe(0);
    expect(ftsAfter.c).toBe(ftsBefore.c - 3);
    expect(await driver.getDocument(doc.id)).toBeNull();
  });

  it("transaction() rolls back every write when the callback throws", async () => {
    await expect(
      driver.transaction(async (tx) => {
        await tx.insertDocument(baseDocument({ id: "will-roll-back" }));
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const row = db.prepare("SELECT COUNT(*) AS c FROM documents").get() as { c: number };
    expect(row.c).toBe(0);
  });

  it("getGeneration strictly increases after writes and is unchanged by reads", async () => {
    const genBefore = await driver.getGeneration(DEFAULT_KB_ID);
    const doc = await driver.insertDocument(baseDocument());
    await driver.upsertChunks([baseChunk(doc.id, { id: "chunk-1" })]);
    const genAfterUpsert = await driver.getGeneration(DEFAULT_KB_ID);
    expect(genAfterUpsert).toBeGreaterThan(genBefore);

    for (let i = 0; i < 10; i++) {
      await driver.listDocuments(DEFAULT_KB_ID);
    }
    expect(await driver.getGeneration(DEFAULT_KB_ID)).toBe(genAfterUpsert);

    await driver.deleteDocument(doc.id);
    const genAfterDelete = await driver.getGeneration(DEFAULT_KB_ID);
    expect(genAfterDelete).toBeGreaterThan(genAfterUpsert);
  });

  it("rejects a wrong-dimension vector with AppError KDL-EMBED-003", async () => {
    const doc = await driver.insertDocument(baseDocument());
    const wrongDim = new Float32Array(512);

    await expect(
      driver.upsertChunks([baseChunk(doc.id, { id: "chunk-1", embedding: wrongDim })]),
    ).rejects.toMatchObject({ code: "KDL-EMBED-003" });

    try {
      await driver.upsertChunks([baseChunk(doc.id, { id: "chunk-1", embedding: wrongDim })]);
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
    }
  });
});
