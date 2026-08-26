/**
 * StorageDriver — the only persistence contract the rest of the app knows (STOR-01). Nothing
 * outside `src/lib/storage/` may import `node:sqlite` (or, in Phase 3, a Postgres client) — every
 * consumer types against this interface, exported from `src/lib/storage/index.ts`.
 *
 * `transaction` is declared `async` even though the SQLite implementation is internally
 * synchronous — ARCHITECTURE.md is explicit that callers must never be able to assume sync
 * semantics, because the Phase 3 Postgres driver cannot provide them.
 */

import type { Chunk, Document, IngestJob, NewChunk, NewDocument, NewIngestJob } from "./types.js";

export interface StorageDriver {
  // documents
  insertDocument(doc: NewDocument): Promise<Document>;
  getDocument(id: string): Promise<Document | null>;
  listDocuments(kbId: string): Promise<Document[]>;
  deleteDocument(id: string): Promise<void>; // cascades chunks + FTS rows

  // documents (status/error transitions during ingestion — ING-02/03/08, added by plan 02-05
  // since the pipeline cannot report parsing/embedding/ready/failed without it)
  updateDocument(
    id: string,
    patch: Partial<
      Pick<Document, "status" | "errorCode" | "errorMessage" | "supersededBy" | "pageCount" | "storagePath">
    >,
  ): Promise<void>;

  // ING-06: re-upload supersedes, never duplicates. Atomically deletes the old document's chunks
  // (and their chunks_fts rows) while preserving the old document row — with `supersededBy` set —
  // for history/audit. Added by plan 02-05: `deleteDocument` deletes the whole row, which would
  // lose the pointer this requirement needs.
  supersedeDocument(oldDocumentId: string, newDocumentId: string): Promise<void>;

  // chunks (write path — called from the ingest pipeline)
  upsertChunks(chunks: NewChunk[]): Promise<void>; // one call per document, transactional

  // chunks (read path)
  getAllChunkVectors(kbId: string): Promise<{ id: string; embedding: Buffer }[]>;
  getChunksByIds(ids: string[]): Promise<Chunk[]>;

  // hybrid keyword search — dialect-specific under the hood
  searchKeyword(kbId: string, query: string, limit: number): Promise<{ id: string; rank: number }[]>;

  // ingestion job tracking
  createJob(job: NewIngestJob): Promise<IngestJob>;
  updateJobProgress(id: string, progress: Partial<IngestJob>): Promise<void>;
  getJob(id: string): Promise<IngestJob | null>;

  transaction<T>(fn: (tx: StorageDriver) => Promise<T>): Promise<T>;

  // RET-02 index invalidation: a monotonic counter bumped by upsertChunks/deleteDocument only.
  getGeneration(kbId: string): Promise<number>;

  // CHAT-06 starter-question cache (and any other small key/value setting).
  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string, generation: number): Promise<void>;

  // DELIV-03 health/status surface.
  countDocuments(kbId: string): Promise<{ total: number; ready: number; failed: number }>;

  // Documents-list surface (02-08 UI, 02-05's GET /api/documents route): how many chunks
  // currently exist for a document. Read from the chunks table directly rather than a job row's
  // `chunksTotal` (which reflects one specific run) — an ING-06 supersede can drop this to 0
  // without changing the document's own status. Added by plan 02-05.
  countChunksForDocument(documentId: string): Promise<number>;
}
