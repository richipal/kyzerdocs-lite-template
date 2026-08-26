/**
 * The hybrid read path (RET-01/02/03/04/05): embed query -> cosine + FTS -> RRF(60) -> MMR ->
 * final K, with every citation field carried through untouched. This is the composition layer —
 * `cosine.ts`, `rrf.ts`, `vector-index.ts` and `mmr.ts` do the actual work; this module owns only
 * call order, hydration of ids into full chunk rows, and metadata pass-through.
 *
 * Structural analog: `evals/src/ladder/lite-pipeline.ts`'s `liteRetrieve` — this reproduces its
 * fusion order (cosine top-k + FTS top-k -> RRF k=60) but adds the cached `vector-index.ts`
 * lifecycle in place of a per-call rebuild, and adds the RET-04 MMR diversity pass after fusion.
 *
 * D2-03/RESEARCH.md: this file adds no extra relevance-scoring model stage after fusion. D2-03
 * measured that kind of stage as net-negative on the Phase 1 corpus, and it is out of scope in
 * REQUIREMENTS.md — do not add one here.
 *
 * D2-02/VAL-03: `embedQuery` already normalizes and asserts at its own boundary, but this module
 * asserts the returned query vector a second time before it is used for cosine search — the
 * negative-control test proves this call site's own guard is live, not just relying on
 * `embedQuery`'s internal one.
 */

import { PRODUCT_CONFIG } from "../config.js";
import type { EmbedOptions } from "../embeddings/gemini.js";
import { embedQuery } from "../embeddings/gemini.js";
import { getStorageDriver } from "../storage/index.js";
import type { Chunk } from "../storage/types.js";
import { dot, topK } from "./cosine.js";
import { selectDiverse } from "./mmr.js";
import { assertNormalized } from "./normalize.js";
import { reciprocalRankFusion } from "./rrf.js";
import { getVectorIndex } from "./vector-index.js";

/** One retrieved chunk with every citation-relevant field intact. Plan 02-07 builds citations
 * exclusively from these fields, never from model output — they must survive RRF and MMR
 * untouched (ARCHITECTURE.md Pattern 5). */
export interface RetrievedChunkWithMeta {
  chunkId: string;
  documentId: string;
  filename: string;
  pageNumber: number | null;
  sectionTitle: string | null;
  charStart: number;
  charEnd: number;
  content: string;
  /** Raw cosine similarity to the query, computed for every survivor of RRF fusion+truncation —
   * including chunks that entered only via the FTS arm and were never in the cosine top-N
   * window — so this field is always a real measurement, never a silent 0/undefined stand-in. */
  similarity: number;
  /** The fused RRF rank (0-indexed), preserved from fusion — not re-numbered by MMR's selection
   * order. */
  rank: number;
}

export interface RetrieveOptions {
  vectorTopN?: number;
  ftsTopN?: number;
  fusedTopK?: number;
  mmrLambda?: number;
  finalK?: number;
  /** D2-02/VAL-03 negative control ONLY — threaded to `embedQuery`'s own `skipNormalization`
   * flag so the query vector arrives non-normalized on purpose, proving this module's own
   * `assertNormalized` call (not just `embedQuery`'s internal one) is live in the product path.
   * Must never be set `true` outside a test. */
  skipQueryNormalization?: boolean;
}

interface FusionCandidate {
  content: string;
  rank: number;
  similarity?: number;
  chunkId: string;
  documentId: string;
  filename: string;
  pageNumber: number | null;
  sectionTitle: string | null;
  charStart: number;
  charEnd: number;
}

function toFusionCandidate(
  chunk: Chunk,
  filename: string,
  rank: number,
  similarity: number | undefined,
): FusionCandidate {
  return {
    content: chunk.content,
    rank,
    similarity,
    chunkId: chunk.id,
    documentId: chunk.documentId,
    filename,
    pageNumber: chunk.pageNumber,
    sectionTitle: chunk.sectionTitle,
    charStart: chunk.charStart,
    charEnd: chunk.charEnd,
  };
}

/**
 * Runs the full hybrid read path for `query` against `kbId`: embed -> cosine top-N + FTS top-N ->
 * RRF(60) -> truncate -> recompute real cosine similarity for every survivor -> MMR diversify ->
 * final K, with citation metadata intact throughout.
 */
export async function retrieve(
  kbId: string,
  query: string,
  opts?: RetrieveOptions,
): Promise<RetrievedChunkWithMeta[]> {
  const cfg = PRODUCT_CONFIG.retrieval;
  const vectorTopN = opts?.vectorTopN ?? cfg.vectorTopN;
  const ftsTopN = opts?.ftsTopN ?? cfg.ftsTopN;
  const fusedTopK = opts?.fusedTopK ?? cfg.fusedTopK;
  const mmrLambda = opts?.mmrLambda ?? cfg.mmrLambda;
  const finalK = opts?.finalK ?? cfg.finalK;

  const driver = getStorageDriver();

  const embedOpts: EmbedOptions | undefined = opts?.skipQueryNormalization
    ? { skipNormalization: true }
    : undefined;
  const queryVector = await embedQuery(query, embedOpts);
  // D2-02/VAL-03: the product-path guard, independent of embedQuery's own internal assertion.
  assertNormalized(queryVector);

  const index = await getVectorIndex(kbId);
  const vectorHits = topK(queryVector, index.flatCorpus, index.dim, vectorTopN);
  const ftsHits = await driver.searchKeyword(kbId, query, ftsTopN);

  const wantedIds = new Set<string>();
  for (const hit of vectorHits) wantedIds.add(index.chunkIds[hit.index]!);
  for (const hit of ftsHits) wantedIds.add(hit.id);

  const chunks = await driver.getChunksByIds(Array.from(wantedIds));
  const chunkById = new Map(chunks.map((c) => [c.id, c]));

  const documents = await driver.listDocuments(kbId);
  const filenameByDocId = new Map(documents.map((d) => [d.id, d.filename]));

  const vectorResults: FusionCandidate[] = [];
  for (const hit of vectorHits) {
    const chunkId = index.chunkIds[hit.index]!;
    const chunk = chunkById.get(chunkId);
    if (!chunk) continue; // hydration miss (e.g. deleted between index build and read) — skip
    vectorResults.push(
      toFusionCandidate(chunk, filenameByDocId.get(chunk.documentId) ?? "", hit.rank, hit.score),
    );
  }

  const ftsResults: FusionCandidate[] = [];
  for (const hit of ftsHits) {
    const chunk = chunkById.get(hit.id);
    if (!chunk) continue;
    ftsResults.push(
      toFusionCandidate(chunk, filenameByDocId.get(chunk.documentId) ?? "", hit.rank, undefined),
    );
  }

  const fused = reciprocalRankFusion([vectorResults, ftsResults], cfg.rrfK) as FusionCandidate[];
  const truncated = fused.slice(0, fusedTopK);

  // Every fusion survivor gets a real, freshly computed cosine similarity — including chunks
  // that only entered via the FTS arm and never had one. A silent 0/undefined here would starve
  // MMR's relevance term and citations of a genuine measurement (Rule 2: this guard is required
  // for correctness, not an enhancement).
  const positionByChunkId = new Map(index.chunkIds.map((id, i) => [id, i]));
  const mmrCandidates = truncated.map((candidate) => {
    const position = positionByChunkId.get(candidate.chunkId);
    const vector =
      position === undefined
        ? new Float32Array(index.dim)
        : index.flatCorpus.slice(position * index.dim, (position + 1) * index.dim);
    const score =
      position === undefined ? (candidate.similarity ?? 0) : dot(queryVector, vector, index.dim, 0, 0);
    return { ...candidate, vector, score };
  });

  const selected = selectDiverse(mmrCandidates, queryVector, { lambda: mmrLambda, k: finalK });

  return selected.map(({ vector: _vector, score, ...rest }) => ({
    ...rest,
    similarity: score,
  }));
}
