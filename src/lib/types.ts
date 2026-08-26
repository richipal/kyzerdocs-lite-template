/**
 * Shared product-side primitives. Storage-shaped and parse-shaped types belong to plans 02-02
 * and 02-03, not here — this file holds only what the promoted retrieval modules (plan 02-01
 * Task 2) and future consumers share.
 */

/**
 * One chunk returned by a retrieval strategy for a given query. Promoted verbatim from the eval
 * harness's own types module (D2-15) — the promoted `src/lib/retrieval/rrf.ts` imports this type.
 */
export interface RetrievedChunk {
  content: string;
  rank: number;
  similarity?: number;
  chunkId?: string;
  documentId?: string;
  filename?: string;
}

/** String alias for a knowledge-base id. Used everywhere until Phase 5 exposes multi-KB. */
export type KnowledgeBaseId = string;

/** Fixed single-KB id, used everywhere until Phase 5 exposes multi-KB (STOR-05 already scopes
 * the schema for KB so no data migration is needed later). */
export const DEFAULT_KB_ID: KnowledgeBaseId = "default";
