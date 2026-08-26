/**
 * Hand-written SQLite schema — drizzle-kit cannot target `node:sqlite` (open issue
 * drizzle-team/drizzle-orm#5471), so the schema is plain `CREATE TABLE IF NOT EXISTS` SQL applied
 * with `db.exec()` at boot. This is also the friendlier buyer UX: no migration command to run.
 *
 * Every table below (`documents`, `chunks`, `ingest_jobs`) carries `knowledge_base_id` from this
 * first migration (STOR-05) even though v1 UI only ever uses `DEFAULT_KB_ID`. `chunks.embedding`
 * is `BLOB NOT NULL` — never TEXT, never JSON (STOR-04, ARCHITECTURE.md Anti-Pattern 4).
 */

import type { DatabaseSync } from "node:sqlite";
import { AppError } from "../errors.js";
import { DEFAULT_KB_ID } from "../types.js";

export const SCHEMA_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS knowledge_bases (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    knowledge_base_id TEXT NOT NULL REFERENCES knowledge_bases(id),
    filename TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    byte_size INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    storage_path TEXT,
    page_count INTEGER,
    status TEXT NOT NULL DEFAULT 'pending',
    error_code TEXT,
    error_message TEXT,
    superseded_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS idx_documents_kb_status
    ON documents (knowledge_base_id, status)`,

  `CREATE TABLE IF NOT EXISTS chunks (
    id TEXT PRIMARY KEY,
    knowledge_base_id TEXT NOT NULL REFERENCES knowledge_bases(id),
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL,
    content TEXT NOT NULL,
    char_start INTEGER NOT NULL,
    char_end INTEGER NOT NULL,
    page_number INTEGER,
    section_title TEXT,
    embedding BLOB NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS idx_chunks_kb
    ON chunks (knowledge_base_id)`,

  `CREATE INDEX IF NOT EXISTS idx_chunks_document
    ON chunks (document_id)`,

  `CREATE TABLE IF NOT EXISTS ingest_jobs (
    id TEXT PRIMARY KEY,
    knowledge_base_id TEXT NOT NULL REFERENCES knowledge_bases(id),
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending',
    phase TEXT,
    chunks_total INTEGER,
    chunks_processed INTEGER,
    error_code TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS idx_ingest_jobs_document
    ON ingest_jobs (document_id)`,

  // key/value settings — CHAT-06's starter-question cache and the RET-02 generation counter
  // (reserved keys, see storage/sqlite.ts's generationKey()) share this one table.
  `CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    generation INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  )`,

  // Persistent FTS5 keyword index. A standalone (non-external-content) table — chunk_id and
  // knowledge_base_id are stored as UNINDEXED columns so a chunk's FTS row can be looked up and
  // deleted directly by id, and results scoped by KB, without relying on `content_rowid`/rowid
  // aliasing against `chunks`' TEXT primary key (STOR-05 cross-KB isolation).
  `CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
    content,
    chunk_id UNINDEXED,
    knowledge_base_id UNINDEXED
  )`,
];

/** Applies `SCHEMA_STATEMENTS` and seeds the `DEFAULT_KB_ID` row if absent. Idempotent — running
 * this twice against the same connection is a no-op the second time. Wraps any failure in
 * `AppError` `KDL-DB-002`. */
export function applySchema(db: DatabaseSync): void {
  try {
    for (const statement of SCHEMA_STATEMENTS) {
      db.exec(statement);
    }

    const existing = db
      .prepare("SELECT id FROM knowledge_bases WHERE id = ?")
      .get(DEFAULT_KB_ID) as { id: string } | undefined;

    if (!existing) {
      db.prepare("INSERT INTO knowledge_bases (id, name, created_at) VALUES (?, ?, ?)").run(
        DEFAULT_KB_ID,
        "Default",
        new Date().toISOString(),
      );
    }
  } catch (cause) {
    if (cause instanceof AppError) throw cause;
    throw new AppError("KDL-DB-002", { cause });
  }
}
