/**
 * Postgres mirror of `schema.sql.ts` — Drizzle `pgTable` definitions for cloud mode (STOR-03).
 * Column-for-column translation of the hand-written SQLite DDL; do not let this drift from
 * `schema.sql.ts` (D3-09 / T-03-03-03 — plan 03-05's dual-dialect conformance suite is the
 * running proof). Managed by drizzle-kit (`npm run db:generate` / `npm run db:migrate`) — unlike
 * `schema.sql.ts`, which stays hand-written because drizzle-kit cannot target `node:sqlite`
 * (drizzle-team/drizzle-orm#5471).
 *
 * Two deliberate departures from a literal 1:1 mirror, both intentional and documented in the
 * plan/context:
 *
 *   1. `chunks.contentSearch` — a generated `tsvector` column + GIN index replaces SQLite's
 *      separate FTS5 virtual table (`schema.sql.ts`'s `chunks` + `_fts` suffix table, D3-09,
 *      RESEARCH.md Pattern 2). There is NO mirror of that SQLite-only virtual table here —
 *      intentionally. The generated column stays in sync on every write with no
 *      delete-then-reinsert dance, which is exactly the duplicated-implementation risk D3-09
 *      exists to avoid.
 *   2. `rate_limits` — a new, Postgres-only table (WIDG-06, D3-16, RESEARCH.md Pattern 3). Local
 *      mode keeps its existing in-memory limiter (`src/lib/auth/rate-limit.ts`) unchanged — an
 *      in-memory counter enforces nothing on Vercel's per-invocation process lifetime (D3-15), so
 *      cloud mode needs a shared backing store, and Postgres (already provisioned) is the
 *      cheapest option that adds no third account.
 *
 * There is deliberately NO `widget_config` table (an earlier draft of 03-PATTERNS.md named one —
 * corrected in place). Widget branding/settings are a JSON blob in `app_settings` under the
 * reserved key `widget:{kbId}`, the same shape the starters cache already uses.
 *
 * `chunks.embedding` is a `bytea` customType — never `text`/`json` (STOR-04, ARCHITECTURE.md
 * Anti-Pattern 4, carried forward from Phase 2). Timestamps that mirror SQLite stay `text(...)`
 * (ISO-8601 strings), not `timestamp(...)`, so the storage driver's row mappers (plan 03-05)
 * return the same JS type from both dialects. `rate_limits.lastRefill` is the one exception —
 * it's a Postgres-only table with no SQLite counterpart to stay type-compatible with, so it uses
 * a real `timestamptz` per RESEARCH.md Pattern 3.
 */

import { sql, type SQL } from "drizzle-orm";
import { customType, index, integer, pgTable, real, text, timestamp } from "drizzle-orm/pg-core";

/**
 * `chunks.embedding` — packed Float32Array bytes, round-tripped as a Node `Buffer`. Never
 * `text`/`json` (STOR-04).
 *
 * Corrected against a live Neon connection (plan 03-05) — the doc comment this replaced assumed
 * `@neondatabase/serverless`'s HTTP transport always returns `bytea` as a `\x`-prefixed hex
 * string. Measured behavior is different: `neon()`'s tagged-template driver already deserializes
 * `bytea` into a real Node `Buffer` before Drizzle's row mapper ever sees it — `fromDriver` was
 * calling `.startsWith()` on a `Buffer`, which does not have that method, and threw on every read
 * (`TypeError: value.startsWith is not a function`). `fromDriver` now accepts either shape
 * defensively (`Buffer` pass-through for the confirmed-live HTTP-transport case; a hex-string
 * fallback in case a different transport/driver version ever returns text), and `toDriver` passes
 * a `Buffer` straight through rather than pre-encoding it to hex text, since the driver already
 * serializes a `Buffer` parameter correctly (verified by `postgres.ts`'s raw-SQL chunk writes).
 */
const bytea = customType<{ data: Buffer; driverData: Buffer | string }>({
  dataType() {
    return "bytea";
  },
  toDriver(value: Buffer): Buffer {
    return value;
  },
  fromDriver(value: Buffer | string): Buffer {
    if (Buffer.isBuffer(value)) return value;
    return Buffer.from(value.startsWith("\\x") ? value.slice(2) : value, "hex");
  },
});

/** Postgres replacement for SQLite's FTS5 virtual table — see this file's header. Pattern
 * confirmed against Drizzle's own docs
 * (orm.drizzle.team/docs/guides/full-text-search-with-generated-columns). */
const tsVector = customType<{ data: string }>({ dataType: () => "tsvector" });

export const knowledgeBases = pgTable("knowledge_bases", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: text("created_at").notNull(),
});

export const documents = pgTable(
  "documents",
  {
    id: text("id").primaryKey(),
    knowledgeBaseId: text("knowledge_base_id")
      .notNull()
      .references(() => knowledgeBases.id),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    contentHash: text("content_hash").notNull(),
    storagePath: text("storage_path"),
    pageCount: integer("page_count"),
    status: text("status").notNull().default("pending"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    supersededBy: text("superseded_by"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("idx_documents_kb_status").on(t.knowledgeBaseId, t.status)],
);

export const chunks = pgTable(
  "chunks",
  {
    id: text("id").primaryKey(),
    knowledgeBaseId: text("knowledge_base_id")
      .notNull()
      .references(() => knowledgeBases.id),
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    chunkIndex: integer("chunk_index").notNull(),
    content: text("content").notNull(),
    charStart: integer("char_start").notNull(),
    charEnd: integer("char_end").notNull(),
    pageNumber: integer("page_number"),
    sectionTitle: text("section_title"),
    embedding: bytea("embedding").notNull(),
    // Postgres-only keyword-search column — replaces SQLite's separate FTS5 virtual table
    // (D3-09). See this file's header for why there is no mirror table.
    contentSearch: tsVector("content_search").generatedAlwaysAs(
      (): SQL => sql`to_tsvector('english', ${chunks.content})`,
    ),
  },
  (t) => [
    index("idx_chunks_kb").on(t.knowledgeBaseId),
    index("idx_chunks_document").on(t.documentId),
    index("idx_chunks_search").using("gin", t.contentSearch),
  ],
);

export const ingestJobs = pgTable(
  "ingest_jobs",
  {
    id: text("id").primaryKey(),
    knowledgeBaseId: text("knowledge_base_id")
      .notNull()
      .references(() => knowledgeBases.id),
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("pending"),
    phase: text("phase"),
    chunksTotal: integer("chunks_total"),
    chunksProcessed: integer("chunks_processed"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("idx_ingest_jobs_document").on(t.documentId)],
);

// key/value settings — CHAT-06's starter-question cache, the RET-02 generation counter, and (new
// in this phase) widget branding/settings under the reserved key `widget:{kbId}` all share this
// one table. There is deliberately NO separate `widget_config` table — see this file's header.
export const appSettings = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value"),
  generation: integer("generation").notNull().default(0),
  updatedAt: text("updated_at").notNull(),
});

/**
 * Postgres-only, no SQLite counterpart (RESEARCH.md Pattern 3, D3-16). Backs WIDG-06's rate
 * limiter in cloud mode; local mode keeps `src/lib/auth/rate-limit.ts`'s in-memory token bucket
 * unchanged. One row per (ip, kbId) composite key — bounded by distinct visitor IPs at this
 * product's scale (T-03-03-04, accepted risk).
 */
export const rateLimits = pgTable("rate_limits", {
  key: text("key").primaryKey(),
  tokens: real("tokens").notNull(),
  lastRefill: timestamp("last_refill", { withTimezone: true }).notNull(),
});
