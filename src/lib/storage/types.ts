/**
 * Row shapes for the storage driver (STOR-01/02/04/05). Every table — and therefore every type
 * below — carries a `knowledgeBaseId` from this first migration, even though the v1 UI only ever
 * uses `DEFAULT_KB_ID` (src/lib/types.ts). Cheap now, an expensive data migration later (STOR-05).
 */

export type DocumentStatus = "pending" | "parsing" | "embedding" | "ready" | "failed";

export interface Document {
  id: string;
  knowledgeBaseId: string;
  filename: string;
  mimeType: string;
  byteSize: number;
  contentHash: string;
  storagePath: string | null;
  pageCount: number | null;
  status: DocumentStatus;
  errorCode: string | null;
  errorMessage: string | null;
  supersededBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NewDocument {
  id?: string;
  knowledgeBaseId: string;
  filename: string;
  mimeType: string;
  byteSize: number;
  contentHash: string;
  storagePath?: string | null;
  pageCount?: number | null;
  status?: DocumentStatus;
  errorCode?: string | null;
  errorMessage?: string | null;
  supersededBy?: string | null;
}

export interface Chunk {
  id: string;
  knowledgeBaseId: string;
  documentId: string;
  chunkIndex: number;
  content: string;
  charStart: number;
  charEnd: number;
  pageNumber: number | null;
  sectionTitle: string | null;
  /** Packed 768-dim Float32Array, never JSON (STOR-04, ARCHITECTURE.md Anti-Pattern 4). */
  embedding: Buffer;
}

export interface NewChunk {
  id?: string;
  knowledgeBaseId: string;
  documentId: string;
  chunkIndex: number;
  content: string;
  charStart: number;
  charEnd: number;
  pageNumber?: number | null;
  sectionTitle?: string | null;
  /** Caller supplies the raw vector; the driver packs it to BLOB and validates its dimension. */
  embedding: Float32Array;
}

export type IngestJobStatus = "pending" | "parsing" | "embedding" | "ready" | "failed";

export interface IngestJob {
  id: string;
  knowledgeBaseId: string;
  documentId: string;
  status: IngestJobStatus;
  phase: string | null;
  chunksTotal: number | null;
  chunksProcessed: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NewIngestJob {
  id?: string;
  knowledgeBaseId: string;
  documentId: string;
  status?: IngestJobStatus;
  phase?: string | null;
  chunksTotal?: number | null;
  chunksProcessed?: number | null;
}
