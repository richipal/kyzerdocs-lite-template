/**
 * `SqliteStorageDriver` — the `node:sqlite` implementation of `StorageDriver` (STOR-01/02/04/05).
 * This is the one file in the product allowed to import `node:sqlite` outside `index.ts`'s
 * singleton wiring; everything else types against `./driver.js`.
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { AppError } from "../errors.js";
import { packEmbedding } from "./embedding-bytes.js";
import { sanitizeFtsQuery } from "./fts-query.js";
import { generationKey } from "./generation-key.js";
import type { StorageDriver } from "./driver.js";
import type {
  Chunk,
  Document,
  IngestJob,
  NewChunk,
  NewDocument,
  NewIngestJob,
} from "./types.js";

interface DocumentRow {
  id: string;
  knowledge_base_id: string;
  filename: string;
  mime_type: string;
  byte_size: number;
  content_hash: string;
  storage_path: string | null;
  page_count: number | null;
  status: Document["status"];
  error_code: string | null;
  error_message: string | null;
  superseded_by: string | null;
  created_at: string;
  updated_at: string;
}

function rowToDocument(row: DocumentRow): Document {
  return {
    id: row.id,
    knowledgeBaseId: row.knowledge_base_id,
    filename: row.filename,
    mimeType: row.mime_type,
    byteSize: row.byte_size,
    contentHash: row.content_hash,
    storagePath: row.storage_path,
    pageCount: row.page_count,
    status: row.status,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    supersededBy: row.superseded_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface ChunkRow {
  id: string;
  knowledge_base_id: string;
  document_id: string;
  chunk_index: number;
  content: string;
  char_start: number;
  char_end: number;
  page_number: number | null;
  section_title: string | null;
  embedding: Uint8Array;
}

function rowToChunk(row: ChunkRow): Chunk {
  return {
    id: row.id,
    knowledgeBaseId: row.knowledge_base_id,
    documentId: row.document_id,
    chunkIndex: row.chunk_index,
    content: row.content,
    charStart: row.char_start,
    charEnd: row.char_end,
    pageNumber: row.page_number,
    sectionTitle: row.section_title,
    embedding: Buffer.from(row.embedding),
  };
}

interface IngestJobRow {
  id: string;
  knowledge_base_id: string;
  document_id: string;
  status: IngestJob["status"];
  phase: string | null;
  chunks_total: number | null;
  chunks_processed: number | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

function rowToIngestJob(row: IngestJobRow): IngestJob {
  return {
    id: row.id,
    knowledgeBaseId: row.knowledge_base_id,
    documentId: row.document_id,
    status: row.status,
    phase: row.phase,
    chunksTotal: row.chunks_total,
    chunksProcessed: row.chunks_processed,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SqliteStorageDriver implements StorageDriver {
  constructor(private readonly db: DatabaseSync) {}

  // ---------------------------------------------------------------------------------------
  // documents
  // ---------------------------------------------------------------------------------------

  async insertDocument(doc: NewDocument): Promise<Document> {
    const id = doc.id ?? randomUUID();
    const now = new Date().toISOString();
    const status = doc.status ?? "pending";

    this.db
      .prepare(
        `INSERT INTO documents
          (id, knowledge_base_id, filename, mime_type, byte_size, content_hash, storage_path,
           page_count, status, error_code, error_message, superseded_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        doc.knowledgeBaseId,
        doc.filename,
        doc.mimeType,
        doc.byteSize,
        doc.contentHash,
        doc.storagePath ?? null,
        doc.pageCount ?? null,
        status,
        doc.errorCode ?? null,
        doc.errorMessage ?? null,
        doc.supersededBy ?? null,
        now,
        now,
      );

    const inserted = await this.getDocument(id);
    if (!inserted) throw new AppError("KDL-DB-002", { message: "insertDocument failed to persist a row" });
    return inserted;
  }

  async getDocument(id: string): Promise<Document | null> {
    const row = this.db.prepare("SELECT * FROM documents WHERE id = ?").get(id) as
      | DocumentRow
      | undefined;
    return row ? rowToDocument(row) : null;
  }

  async listDocuments(kbId: string): Promise<Document[]> {
    const rows = this.db
      .prepare("SELECT * FROM documents WHERE knowledge_base_id = ? ORDER BY created_at ASC")
      .all(kbId) as unknown as DocumentRow[];
    return rows.map(rowToDocument);
  }

  async deleteDocument(id: string): Promise<void> {
    const doc = this.db.prepare("SELECT knowledge_base_id FROM documents WHERE id = ?").get(
      id,
    ) as { knowledge_base_id: string } | undefined;
    if (!doc) return;

    this.db.exec("BEGIN");
    try {
      const chunkIds = this.db
        .prepare("SELECT id FROM chunks WHERE document_id = ?")
        .all(id) as Array<{ id: string }>;
      const deleteFts = this.db.prepare("DELETE FROM chunks_fts WHERE chunk_id = ?");
      for (const { id: chunkId } of chunkIds) {
        deleteFts.run(chunkId);
      }

      // Deleting the document cascades its chunks via `ON DELETE CASCADE` (foreign_keys = ON).
      this.db.prepare("DELETE FROM documents WHERE id = ?").run(id);

      this.bumpGeneration(doc.knowledge_base_id);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  async updateDocument(
    id: string,
    patch: Partial<
      Pick<Document, "status" | "errorCode" | "errorMessage" | "supersededBy" | "pageCount" | "storagePath">
    >,
  ): Promise<void> {
    const now = new Date().toISOString();
    const fields: Record<string, string | number | null> = { updated_at: now };
    if (patch.status !== undefined) fields.status = patch.status;
    if (patch.errorCode !== undefined) fields.error_code = patch.errorCode;
    if (patch.errorMessage !== undefined) fields.error_message = patch.errorMessage;
    if (patch.supersededBy !== undefined) fields.superseded_by = patch.supersededBy;
    if (patch.pageCount !== undefined) fields.page_count = patch.pageCount;
    if (patch.storagePath !== undefined) fields.storage_path = patch.storagePath;

    const columns = Object.keys(fields);
    const setClause = columns.map((col) => `${col} = ?`).join(", ");
    const values = Object.values(fields);

    this.db.prepare(`UPDATE documents SET ${setClause} WHERE id = ?`).run(...values, id);
  }

  async supersedeDocument(oldDocumentId: string, newDocumentId: string): Promise<void> {
    const doc = this.db.prepare("SELECT knowledge_base_id FROM documents WHERE id = ?").get(
      oldDocumentId,
    ) as { knowledge_base_id: string } | undefined;
    if (!doc) return;

    this.db.exec("BEGIN");
    try {
      const chunkIds = this.db
        .prepare("SELECT id FROM chunks WHERE document_id = ?")
        .all(oldDocumentId) as Array<{ id: string }>;
      const deleteFts = this.db.prepare("DELETE FROM chunks_fts WHERE chunk_id = ?");
      for (const { id: chunkId } of chunkIds) {
        deleteFts.run(chunkId);
      }
      this.db.prepare("DELETE FROM chunks WHERE document_id = ?").run(oldDocumentId);

      const now = new Date().toISOString();
      this.db
        .prepare("UPDATE documents SET superseded_by = ?, updated_at = ? WHERE id = ?")
        .run(newDocumentId, now, oldDocumentId);

      this.bumpGeneration(doc.knowledge_base_id);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  async countDocuments(kbId: string): Promise<{ total: number; ready: number; failed: number }> {
    const rows = this.db
      .prepare("SELECT status, COUNT(*) AS c FROM documents WHERE knowledge_base_id = ? GROUP BY status")
      .all(kbId) as Array<{ status: Document["status"]; c: number }>;

    let total = 0;
    let ready = 0;
    let failed = 0;
    for (const row of rows) {
      total += row.c;
      if (row.status === "ready") ready += row.c;
      if (row.status === "failed") failed += row.c;
    }
    return { total, ready, failed };
  }

  async countChunksForDocument(documentId: string): Promise<number> {
    const row = this.db
      .prepare("SELECT COUNT(*) AS c FROM chunks WHERE document_id = ?")
      .get(documentId) as { c: number };
    return row.c;
  }

  // ---------------------------------------------------------------------------------------
  // chunks
  // ---------------------------------------------------------------------------------------

  async upsertChunks(chunks: NewChunk[]): Promise<void> {
    if (chunks.length === 0) return;

    // Validate every vector's dimension BEFORE opening the transaction — fail closed with no
    // partial writes rather than a mid-batch throw leaving the DB half-updated.
    const packed = chunks.map((chunk) => ({ chunk, embedding: packEmbedding(chunk.embedding) }));

    const upsertChunk = this.db.prepare(
      `INSERT INTO chunks
        (id, knowledge_base_id, document_id, chunk_index, content, char_start, char_end,
         page_number, section_title, embedding)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         knowledge_base_id = excluded.knowledge_base_id,
         document_id = excluded.document_id,
         chunk_index = excluded.chunk_index,
         content = excluded.content,
         char_start = excluded.char_start,
         char_end = excluded.char_end,
         page_number = excluded.page_number,
         section_title = excluded.section_title,
         embedding = excluded.embedding`,
    );
    const deleteFts = this.db.prepare("DELETE FROM chunks_fts WHERE chunk_id = ?");
    const insertFts = this.db.prepare(
      "INSERT INTO chunks_fts (chunk_id, knowledge_base_id, content) VALUES (?, ?, ?)",
    );

    const kbIds = new Set<string>();

    this.db.exec("BEGIN");
    try {
      for (const { chunk, embedding } of packed) {
        const id = chunk.id ?? randomUUID();
        upsertChunk.run(
          id,
          chunk.knowledgeBaseId,
          chunk.documentId,
          chunk.chunkIndex,
          chunk.content,
          chunk.charStart,
          chunk.charEnd,
          chunk.pageNumber ?? null,
          chunk.sectionTitle ?? null,
          embedding,
        );
        deleteFts.run(id);
        insertFts.run(id, chunk.knowledgeBaseId, chunk.content);
        kbIds.add(chunk.knowledgeBaseId);
      }

      for (const kbId of kbIds) {
        this.bumpGeneration(kbId);
      }

      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  async getAllChunkVectors(kbId: string): Promise<{ id: string; embedding: Buffer }[]> {
    const rows = this.db
      .prepare("SELECT id, embedding FROM chunks WHERE knowledge_base_id = ?")
      .all(kbId) as Array<{ id: string; embedding: Uint8Array }>;
    return rows.map((row) => ({ id: row.id, embedding: Buffer.from(row.embedding) }));
  }

  async getChunksByIds(ids: string[]): Promise<Chunk[]> {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(", ");
    const rows = this.db
      .prepare(`SELECT * FROM chunks WHERE id IN (${placeholders})`)
      .all(...ids) as unknown as ChunkRow[];
    return rows.map(rowToChunk);
  }

  // ---------------------------------------------------------------------------------------
  // keyword search (Task 3)
  // ---------------------------------------------------------------------------------------

  async searchKeyword(
    kbId: string,
    query: string,
    limit: number,
  ): Promise<{ id: string; rank: number }[]> {
    const sanitized = sanitizeFtsQuery(query);
    if (sanitized.length === 0) return [];

    const rows = this.db
      .prepare(
        `SELECT chunk_id, bm25(chunks_fts) AS score
         FROM chunks_fts
         WHERE chunks_fts MATCH ? AND knowledge_base_id = ?
         ORDER BY score
         LIMIT ?`,
      )
      .all(sanitized, kbId, limit) as Array<{ chunk_id: string; score: number }>;

    return rows.map((row, rank) => ({ id: row.chunk_id, rank }));
  }

  // ---------------------------------------------------------------------------------------
  // ingest jobs (Task 3)
  // ---------------------------------------------------------------------------------------

  async createJob(job: NewIngestJob): Promise<IngestJob> {
    const id = job.id ?? randomUUID();
    const now = new Date().toISOString();
    const status = job.status ?? "pending";

    this.db
      .prepare(
        `INSERT INTO ingest_jobs
          (id, knowledge_base_id, document_id, status, phase, chunks_total, chunks_processed,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        job.knowledgeBaseId,
        job.documentId,
        status,
        job.phase ?? null,
        job.chunksTotal ?? null,
        job.chunksProcessed ?? null,
        now,
        now,
      );

    const inserted = await this.getJob(id);
    if (!inserted) throw new AppError("KDL-DB-002", { message: "createJob failed to persist a row" });
    return inserted;
  }

  async updateJobProgress(id: string, progress: Partial<IngestJob>): Promise<void> {
    const now = new Date().toISOString();
    const fields: Record<string, string | number | null> = { updated_at: now };
    if (progress.status !== undefined) fields.status = progress.status;
    if (progress.phase !== undefined) fields.phase = progress.phase;
    if (progress.chunksTotal !== undefined) fields.chunks_total = progress.chunksTotal;
    if (progress.chunksProcessed !== undefined) fields.chunks_processed = progress.chunksProcessed;
    if (progress.errorCode !== undefined) fields.error_code = progress.errorCode;
    if (progress.errorMessage !== undefined) fields.error_message = progress.errorMessage;

    const columns = Object.keys(fields);
    const setClause = columns.map((col) => `${col} = ?`).join(", ");
    const values = Object.values(fields);

    this.db.prepare(`UPDATE ingest_jobs SET ${setClause} WHERE id = ?`).run(...values, id);
  }

  async getJob(id: string): Promise<IngestJob | null> {
    const row = this.db.prepare("SELECT * FROM ingest_jobs WHERE id = ?").get(id) as
      | IngestJobRow
      | undefined;
    return row ? rowToIngestJob(row) : null;
  }

  // ---------------------------------------------------------------------------------------
  // settings + generation counter
  // ---------------------------------------------------------------------------------------

  async getGeneration(kbId: string): Promise<number> {
    const row = this.db.prepare("SELECT value FROM app_settings WHERE key = ?").get(
      generationKey(kbId),
    ) as { value: string } | undefined;
    return row ? Number.parseInt(row.value, 10) : 0;
  }

  private bumpGeneration(kbId: string): void {
    const key = generationKey(kbId);
    const row = this.db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    const next = (row ? Number.parseInt(row.value, 10) : 0) + 1;
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO app_settings (key, value, generation, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, generation = excluded.generation, updated_at = excluded.updated_at`,
      )
      .run(key, String(next), next, now);
  }

  async getSetting(key: string): Promise<string | null> {
    const row = this.db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key) as
      | { value: string | null }
      | undefined;
    return row ? row.value : null;
  }

  async setSetting(key: string, value: string, generation: number): Promise<void> {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO app_settings (key, value, generation, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, generation = excluded.generation, updated_at = excluded.updated_at`,
      )
      .run(key, value, generation, now);
  }

  // ---------------------------------------------------------------------------------------
  // transactions
  // ---------------------------------------------------------------------------------------

  async transaction<T>(fn: (tx: StorageDriver) => Promise<T>): Promise<T> {
    this.db.exec("BEGIN");
    try {
      const result = await fn(this);
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
}
