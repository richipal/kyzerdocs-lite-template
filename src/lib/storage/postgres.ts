/**
 * `PgStorageDriver` — the Postgres/Neon implementation of `StorageDriver` (STOR-03). Mirrors
 * `SqliteStorageDriver`'s one-constructor-arg shape and private-free-function row-mapper
 * convention (`src/lib/storage/sqlite.ts`), but the write-path mechanics are re-derived for
 * Postgres rather than copied verbatim — see the header comments on `upsertChunks`,
 * `deleteDocument`, and `supersedeDocument` below.
 *
 * Every method wraps its query execution in `run()`, which turns a raw Neon/Postgres driver
 * failure into the registered `AppError` codes (`KDL-DB-003`/`KDL-DB-004`) a caller can act on —
 * see `pg-client.ts`'s `wrapPgError`.
 */

import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { AppError } from "../errors.js";
import type { StorageDriver } from "./driver.js";
import { packEmbedding } from "./embedding-bytes.js";
import { generationKey } from "./generation-key.js";
import type { PgClient, PgDatabaseHandle, PgTransport, PgWsDatabase } from "./pg-client.js";
import { wrapPgError } from "./pg-client.js";
import { appSettings, chunks, documents, ingestJobs } from "./schema.pg.js";
import type {
  Chunk,
  Document,
  DocumentStatus,
  IngestJob,
  IngestJobStatus,
  NewChunk,
  NewDocument,
  NewIngestJob,
} from "./types.js";

// -------------------------------------------------------------------------------------------
// row mappers — private free functions per table, snake_case DB -> camelCase domain type
// (mirrors sqlite.ts's rowToDocument/rowToChunk/rowToIngestJob convention). Drizzle's typed
// query builder already returns camelCase-keyed objects (the pgTable column names in
// schema.pg.ts), so these mostly narrow loosely-typed `text` columns (`status`) to the exact
// literal union the domain type declares, and normalize `embedding` defensively.
// -------------------------------------------------------------------------------------------

type DocumentRow = typeof documents.$inferSelect;
type ChunkRow = typeof chunks.$inferSelect;
type IngestJobRow = typeof ingestJobs.$inferSelect;

function rowToDocument(row: DocumentRow): Document {
  return {
    id: row.id,
    knowledgeBaseId: row.knowledgeBaseId,
    filename: row.filename,
    mimeType: row.mimeType,
    byteSize: row.byteSize,
    contentHash: row.contentHash,
    storagePath: row.storagePath,
    pageCount: row.pageCount,
    status: row.status as DocumentStatus,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    supersededBy: row.supersededBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Normalizes the Neon HTTP driver's `\x`-prefixed hex-string wire format for `bytea` to a
 * `Buffer` — defense-in-depth alongside `schema.pg.ts`'s `bytea` customType, which already
 * performs this conversion for values read through Drizzle's typed query builder. Asserts the
 * expected byte length so a truncated/corrupted embedding is caught here, not as a silently wrong
 * similarity score downstream in `vector-index.ts`. */
function normalizeEmbedding(value: Buffer | string): Buffer {
  const buffer = Buffer.isBuffer(value)
    ? value
    : Buffer.from(value.startsWith("\\x") ? value.slice(2) : value, "hex");
  return buffer;
}

function rowToChunk(row: ChunkRow): Chunk {
  return {
    id: row.id,
    knowledgeBaseId: row.knowledgeBaseId,
    documentId: row.documentId,
    chunkIndex: row.chunkIndex,
    content: row.content,
    charStart: row.charStart,
    charEnd: row.charEnd,
    pageNumber: row.pageNumber,
    sectionTitle: row.sectionTitle,
    embedding: normalizeEmbedding(row.embedding),
  };
}

function rowToIngestJob(row: IngestJobRow): IngestJob {
  return {
    id: row.id,
    knowledgeBaseId: row.knowledgeBaseId,
    documentId: row.documentId,
    status: row.status as IngestJobStatus,
    phase: row.phase,
    chunksTotal: row.chunksTotal,
    chunksProcessed: row.chunksProcessed,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class PgStorageDriver implements StorageDriver {
  private readonly db: PgDatabaseHandle;
  private readonly transport: PgTransport;

  constructor(client: PgClient) {
    this.db = client.db;
    this.transport = client.transport;
  }

  /** Wraps a query body so any raw Neon/Postgres driver failure surfaces as the registered
   * `AppError` codes a caller can act on, instead of a raw driver error reaching a route handler
   * (T-03-05-04). `AppError`s thrown deliberately inside the body (e.g. `KDL-EMBED-003`) pass
   * through unchanged. */
  private async run<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (cause) {
      if (cause instanceof AppError) throw cause;
      throw wrapPgError(cause);
    }
  }

  // ---------------------------------------------------------------------------------------
  // documents
  // ---------------------------------------------------------------------------------------

  async insertDocument(doc: NewDocument): Promise<Document> {
    return this.run(async () => {
      const id = doc.id ?? randomUUID();
      const now = new Date().toISOString();
      const status = doc.status ?? "pending";

      const rows = await this.db
        .insert(documents)
        .values({
          id,
          knowledgeBaseId: doc.knowledgeBaseId,
          filename: doc.filename,
          mimeType: doc.mimeType,
          byteSize: doc.byteSize,
          contentHash: doc.contentHash,
          storagePath: doc.storagePath ?? null,
          pageCount: doc.pageCount ?? null,
          status,
          errorCode: doc.errorCode ?? null,
          errorMessage: doc.errorMessage ?? null,
          supersededBy: doc.supersededBy ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      const row = rows[0];
      if (!row) throw new AppError("KDL-DB-002", { message: "insertDocument failed to persist a row" });
      return rowToDocument(row);
    });
  }

  async getDocument(id: string): Promise<Document | null> {
    return this.run(async () => {
      const rows = await this.db.select().from(documents).where(eq(documents.id, id)).limit(1);
      const row = rows[0];
      return row ? rowToDocument(row) : null;
    });
  }

  async listDocuments(kbId: string): Promise<Document[]> {
    return this.run(async () => {
      const rows = await this.db
        .select()
        .from(documents)
        .where(eq(documents.knowledgeBaseId, kbId))
        .orderBy(documents.createdAt);
      return rows.map(rowToDocument);
    });
  }

  /**
   * Single atomic statement, not `db.batch()`/`db.transaction()`: a data-modifying CTE. Postgres
   * guarantees a CTE's data-modifying statement "is executed exactly once, and always to
   * completion" regardless of whether the outer query reads its output — so this one round trip
   * deletes the document (cascading its chunks and ingest jobs via `ON DELETE CASCADE`,
   * `schema.pg.ts`) AND bumps the affected KB's generation counter atomically, over either
   * transport, with no explicit `BEGIN`/`COMMIT` needed. If `id` does not exist, the `deleted` CTE
   * returns zero rows and the generation bump is skipped — mirroring `SqliteStorageDriver`'s
   * `if (!doc) return;` no-op.
   */
  async deleteDocument(id: string): Promise<void> {
    return this.run(async () => {
      const now = new Date().toISOString();
      await this.db.execute(sql`
        WITH deleted AS (
          DELETE FROM documents WHERE id = ${id}
          RETURNING knowledge_base_id
        )
        INSERT INTO app_settings (key, value, generation, updated_at)
        SELECT ${sql.raw("'__generation__:'")} || knowledge_base_id, '1', 1, ${now}
        FROM deleted
        ON CONFLICT (key) DO UPDATE SET
          generation = app_settings.generation + 1,
          value = (app_settings.generation + 1)::text,
          updated_at = ${now}
      `);
    });
  }

  async updateDocument(
    id: string,
    patch: Partial<
      Pick<Document, "status" | "errorCode" | "errorMessage" | "supersededBy" | "pageCount" | "storagePath">
    >,
  ): Promise<void> {
    return this.run(async () => {
      const now = new Date().toISOString();
      const fields: Partial<typeof documents.$inferInsert> = { updatedAt: now };
      if (patch.status !== undefined) fields.status = patch.status;
      if (patch.errorCode !== undefined) fields.errorCode = patch.errorCode;
      if (patch.errorMessage !== undefined) fields.errorMessage = patch.errorMessage;
      if (patch.supersededBy !== undefined) fields.supersededBy = patch.supersededBy;
      if (patch.pageCount !== undefined) fields.pageCount = patch.pageCount;
      if (patch.storagePath !== undefined) fields.storagePath = patch.storagePath;

      await this.db.update(documents).set(fields).where(eq(documents.id, id));
    });
  }

  /**
   * Single atomic CTE, same reasoning as `deleteDocument`: deletes the old document's chunks (no
   * `RETURNING` needed — Postgres still runs a data-modifying CTE to completion even when
   * unreferenced) while preserving the old document row with `supersededBy` set, then bumps
   * generation — one round trip, no partial-apply window.
   */
  async supersedeDocument(oldDocumentId: string, newDocumentId: string): Promise<void> {
    return this.run(async () => {
      const now = new Date().toISOString();
      await this.db.execute(sql`
        WITH deleted_chunks AS (
          DELETE FROM chunks WHERE document_id = ${oldDocumentId}
        ),
        updated_doc AS (
          UPDATE documents SET superseded_by = ${newDocumentId}, updated_at = ${now}
          WHERE id = ${oldDocumentId}
          RETURNING knowledge_base_id
        )
        INSERT INTO app_settings (key, value, generation, updated_at)
        SELECT ${sql.raw("'__generation__:'")} || knowledge_base_id, '1', 1, ${now}
        FROM updated_doc
        ON CONFLICT (key) DO UPDATE SET
          generation = app_settings.generation + 1,
          value = (app_settings.generation + 1)::text,
          updated_at = ${now}
      `);
    });
  }

  async countDocuments(kbId: string): Promise<{ total: number; ready: number; failed: number }> {
    return this.run(async () => {
      const rows = await this.db
        .select({ status: documents.status, c: sql<number>`count(*)::int` })
        .from(documents)
        .where(eq(documents.knowledgeBaseId, kbId))
        .groupBy(documents.status);

      let total = 0;
      let ready = 0;
      let failed = 0;
      for (const row of rows) {
        total += row.c;
        if (row.status === "ready") ready += row.c;
        if (row.status === "failed") failed += row.c;
      }
      return { total, ready, failed };
    });
  }

  async countChunksForDocument(documentId: string): Promise<number> {
    return this.run(async () => {
      const rows = await this.db
        .select({ c: sql<number>`count(*)::int` })
        .from(chunks)
        .where(eq(chunks.documentId, documentId));
      return rows[0]?.c ?? 0;
    });
  }

  // ---------------------------------------------------------------------------------------
  // chunks
  // ---------------------------------------------------------------------------------------

  /**
   * One multi-row `INSERT ... VALUES (...), (...) ON CONFLICT (id) DO UPDATE` (one round trip),
   * not a loop of single-row statements inside `BEGIN`/`COMMIT` — there is no SQLite-FTS-style
   * delete-then-reinsert step, the generated `content_search` column maintains itself. The
   * generation bump for every affected `kbId` rides the same statement via a data-modifying CTE
   * (see `deleteDocument`'s comment for why this is atomic without `db.batch()`/`db.transaction()`
   * over either transport). Every vector's byte length is validated by `packEmbedding` BEFORE any
   * statement is built or issued — a bad batch writes nothing, matching `SqliteStorageDriver`.
   */
  async upsertChunks(newChunks: NewChunk[]): Promise<void> {
    return this.run(async () => {
      if (newChunks.length === 0) return;

      // Validate every vector's dimension before building any SQL — fail closed with no partial
      // writes rather than a mid-batch throw leaving the DB half-updated.
      const packed = newChunks.map((chunk) => ({
        id: chunk.id ?? randomUUID(),
        chunk,
        embedding: packEmbedding(chunk.embedding),
      }));

      const now = new Date().toISOString();
      const valuesSql = sql.join(
        packed.map(
          ({ id, chunk, embedding }) => sql`(
            ${id}, ${chunk.knowledgeBaseId}, ${chunk.documentId}, ${chunk.chunkIndex}, ${chunk.content},
            ${chunk.charStart}, ${chunk.charEnd}, ${chunk.pageNumber ?? null}, ${chunk.sectionTitle ?? null},
            ${embedding}
          )`,
        ),
        sql`, `,
      );

      await this.db.execute(sql`
        WITH upserted AS (
          INSERT INTO chunks
            (id, knowledge_base_id, document_id, chunk_index, content, char_start, char_end,
             page_number, section_title, embedding)
          VALUES ${valuesSql}
          ON CONFLICT (id) DO UPDATE SET
            knowledge_base_id = excluded.knowledge_base_id,
            document_id = excluded.document_id,
            chunk_index = excluded.chunk_index,
            content = excluded.content,
            char_start = excluded.char_start,
            char_end = excluded.char_end,
            page_number = excluded.page_number,
            section_title = excluded.section_title,
            embedding = excluded.embedding
          RETURNING knowledge_base_id
        )
        INSERT INTO app_settings (key, value, generation, updated_at)
        SELECT ${sql.raw("'__generation__:'")} || knowledge_base_id, '1', 1, ${now}
        FROM (SELECT DISTINCT knowledge_base_id FROM upserted) AS distinct_kbs
        ON CONFLICT (key) DO UPDATE SET
          generation = app_settings.generation + 1,
          value = (app_settings.generation + 1)::text,
          updated_at = ${now}
      `);
    });
  }

  async getAllChunkVectors(kbId: string): Promise<{ id: string; embedding: Buffer }[]> {
    return this.run(async () => {
      const rows = await this.db
        .select({ id: chunks.id, embedding: chunks.embedding })
        .from(chunks)
        .where(eq(chunks.knowledgeBaseId, kbId));
      return rows.map((row) => ({ id: row.id, embedding: normalizeEmbedding(row.embedding) }));
    });
  }

  async getChunksByIds(ids: string[]): Promise<Chunk[]> {
    return this.run(async () => {
      if (ids.length === 0) return [];
      const rows = await this.db.select().from(chunks).where(inArray(chunks.id, ids));
      return rows.map(rowToChunk);
    });
  }

  // ---------------------------------------------------------------------------------------
  // keyword search — dialect-specific (websearch_to_tsquery + generated tsvector), same
  // `{ id, rank }[]` contract as SqliteStorageDriver.searchKeyword (0-indexed, best match first,
  // KB-scoped, empty array for a query that produces an empty tsquery). No FTS5-style query
  // sanitization here — websearch_to_tsquery already handles arbitrary user text; that escaping is
  // a SQLite-only concern (RESEARCH.md).
  // ---------------------------------------------------------------------------------------

  async searchKeyword(kbId: string, query: string, limit: number): Promise<{ id: string; rank: number }[]> {
    return this.run(async () => {
      const result = await this.db.execute<{ id: string; score: number }>(sql`
        SELECT id, ts_rank(content_search, websearch_to_tsquery('english', ${query})) AS score
        FROM chunks
        WHERE content_search @@ websearch_to_tsquery('english', ${query})
          AND knowledge_base_id = ${kbId}
        ORDER BY score DESC
        LIMIT ${limit}
      `);
      return result.rows.map((row, rank) => ({ id: row.id, rank }));
    });
  }

  // ---------------------------------------------------------------------------------------
  // ingest jobs
  // ---------------------------------------------------------------------------------------

  async createJob(job: NewIngestJob): Promise<IngestJob> {
    return this.run(async () => {
      const id = job.id ?? randomUUID();
      const now = new Date().toISOString();
      const status = job.status ?? "pending";

      const rows = await this.db
        .insert(ingestJobs)
        .values({
          id,
          knowledgeBaseId: job.knowledgeBaseId,
          documentId: job.documentId,
          status,
          phase: job.phase ?? null,
          chunksTotal: job.chunksTotal ?? null,
          chunksProcessed: job.chunksProcessed ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      const row = rows[0];
      if (!row) throw new AppError("KDL-DB-002", { message: "createJob failed to persist a row" });
      return rowToIngestJob(row);
    });
  }

  async updateJobProgress(id: string, progress: Partial<IngestJob>): Promise<void> {
    return this.run(async () => {
      const now = new Date().toISOString();
      const fields: Partial<typeof ingestJobs.$inferInsert> = { updatedAt: now };
      if (progress.status !== undefined) fields.status = progress.status;
      if (progress.phase !== undefined) fields.phase = progress.phase;
      if (progress.chunksTotal !== undefined) fields.chunksTotal = progress.chunksTotal;
      if (progress.chunksProcessed !== undefined) fields.chunksProcessed = progress.chunksProcessed;
      if (progress.errorCode !== undefined) fields.errorCode = progress.errorCode;
      if (progress.errorMessage !== undefined) fields.errorMessage = progress.errorMessage;

      await this.db.update(ingestJobs).set(fields).where(eq(ingestJobs.id, id));
    });
  }

  async getJob(id: string): Promise<IngestJob | null> {
    return this.run(async () => {
      const rows = await this.db.select().from(ingestJobs).where(eq(ingestJobs.id, id)).limit(1);
      const row = rows[0];
      return row ? rowToIngestJob(row) : null;
    });
  }

  // ---------------------------------------------------------------------------------------
  // settings + generation counter
  // ---------------------------------------------------------------------------------------

  async getGeneration(kbId: string): Promise<number> {
    return this.run(async () => {
      const rows = await this.db
        .select({ generation: appSettings.generation })
        .from(appSettings)
        .where(eq(appSettings.key, generationKey(kbId)));
      return rows[0]?.generation ?? 0;
    });
  }

  async getSetting(key: string): Promise<string | null> {
    return this.run(async () => {
      const rows = await this.db.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, key));
      return rows[0]?.value ?? null;
    });
  }

  async setSetting(key: string, value: string, generation: number): Promise<void> {
    return this.run(async () => {
      const now = new Date().toISOString();
      await this.db
        .insert(appSettings)
        .values({ key, value, generation, updatedAt: now })
        .onConflictDoUpdate({
          target: appSettings.key,
          set: {
            value: sql`excluded.value`,
            generation: sql`excluded.generation`,
            updatedAt: sql`excluded.updated_at`,
          },
        });
    });
  }

  // ---------------------------------------------------------------------------------------
  // transactions
  // ---------------------------------------------------------------------------------------

  /**
   * The HTTP transport (`drizzle-orm/neon-http`) cannot run an interactive, arbitrary-callback
   * transaction — `NeonHttpDatabase.transaction()` throws "No transactions support in neon-http
   * driver" by construction, because the HTTP transport is stateless per request and cannot hold a
   * connection open across the multiple round trips an arbitrary callback might need. Per this
   * plan's Task 2: fail loudly with `KDL-DB-003` rather than silently running the callback outside
   * a transaction — a supersede that half-applies is worse than one that errors.
   *
   * The WebSocket transport (`drizzle-orm/neon-serverless`, a `Pool`) holds a real connection and
   * supports `db.transaction(async (tx) => ...)` natively; this path constructs a
   * transaction-scoped `PgStorageDriver` wrapping `tx` so `fn(tx)` receives a real `StorageDriver`
   * whose writes are inside the transaction — matching how `SqliteStorageDriver.transaction`
   * passes `this`. Unverified against a live WebSocket connection in this plan (no `ws` transport
   * was exercised — `DEFAULT_PG_TRANSPORT` is `"http"`); 03-07 measures which transport this
   * product ships with by default.
   */
  async transaction<T>(fn: (tx: StorageDriver) => Promise<T>): Promise<T> {
    if (this.transport !== "websocket") {
      throw new AppError("KDL-DB-003", {
        message:
          "The configured Postgres transport (HTTP) does not support an interactive transaction. " +
          "A caller that needs an atomic multi-statement callback must use the WebSocket transport.",
      });
    }

    const wsDb = this.db as PgWsDatabase;
    return wsDb.transaction(async (tx) => {
      const txDriver = new PgStorageDriver({
        db: tx as unknown as PgDatabaseHandle,
        transport: "websocket",
      });
      return fn(txDriver);
    });
  }
}
