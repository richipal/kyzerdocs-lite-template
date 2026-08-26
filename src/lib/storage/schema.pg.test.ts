import { neon } from "@neondatabase/serverless";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/neon-http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertNeonHost } from "./neon-guard.js";
import { readCloudTestEnv } from "./test-cloud-env.js";

/**
 * Structural conformance test for `schema.pg.ts` against a REAL Neon database. Skips cleanly (not
 * fails) when `DATABASE_URL` is absent, so `npm test` stays green on a local-only machine that has
 * never provisioned cloud mode (STOR-03's whole premise: local mode never needs Postgres at all).
 *
 * This suite deliberately does not run migrations itself — it assumes `npm run db:migrate` has
 * already been applied against `DATABASE_URL` (matching how a real deploy works: migrate, then
 * boot). Run `npm run db:migrate` first if this suite reports missing tables.
 *
 * Reads the credential via `readCloudTestEnv()` rather than `process.env.DATABASE_URL` directly
 * (plan 03-05, Task 2 deviation) — that function never mutates `process.env`, so this suite's
 * live-mode opt-in cannot leak into any other test file sharing a reused vitest worker thread.
 */
const databaseUrl = readCloudTestEnv("DATABASE_URL");

describe.skipIf(!databaseUrl)("schema.pg.ts — structural conformance against a live Neon database", () => {
  // `db` is created inside `beforeAll`, not at describe-body scope: vitest still executes a
  // `describe.skipIf(...)` body synchronously during test collection even when the suite ends up
  // skipped, so calling `neon(databaseUrl)` eagerly here would throw ("no connection string
  // provided") the instant `DATABASE_URL` is absent — exactly the case this file must not fail
  // on. Creating the client/db lazily, inside a hook vitest actually skips, is what makes the
  // skip clean.
  let db: ReturnType<typeof drizzle>;

  // Re-uses the same fail-closed guard `scripts/db-migrate.mts` uses (D3-06) — a stray
  // DATABASE_URL pointed at a non-Neon host must not silently run structural assertions against
  // it, since this suite performs a real INSERT as its last assertion.
  beforeAll(() => {
    assertNeonHost(databaseUrl as string, "DATABASE_URL");
    const client = neon(databaseUrl as string);
    db = drizzle(client);
  });

  const insertedChunkIds: string[] = [];

  afterAll(async () => {
    for (const id of insertedChunkIds) {
      await db.execute(sql`DELETE FROM chunks WHERE id = ${id}`);
    }
  });

  it("has every table from schema.sql.ts's interfaces block", async () => {
    const result = await db.execute<{ table_name: string }>(sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
    `);
    const tableNames = new Set(result.rows.map((row) => row.table_name));

    for (const expected of ["knowledge_bases", "documents", "chunks", "ingest_jobs", "app_settings", "rate_limits"]) {
      expect(tableNames.has(expected), `expected table "${expected}" to exist`).toBe(true);
    }

    // The one deliberate SQLite-only construct — must NOT have a Postgres mirror (D3-09).
    expect(tableNames.has("chunks_fts")).toBe(false);
  });

  it("stores chunks.embedding as bytea, never text/json (STOR-04)", async () => {
    const result = await db.execute<{ data_type: string }>(sql`
      SELECT data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'chunks' AND column_name = 'embedding'
    `);
    expect(result.rows[0]?.data_type).toBe("bytea");
  });

  it("has a GIN index on chunks.content_search", async () => {
    const result = await db.execute<{ indexdef: string }>(sql`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'chunks' AND indexname = 'idx_chunks_search'
    `);
    expect(result.rows.length).toBe(1);
    expect(result.rows[0]?.indexdef.toLowerCase()).toContain("using gin");
    expect(result.rows[0]?.indexdef.toLowerCase()).toContain("content_search");
  });

  it("populates content_search from content with no application code (generated column)", async () => {
    const kb = await db.execute<{ id: string }>(sql`SELECT id FROM knowledge_bases LIMIT 1`);
    const knowledgeBaseId = kb.rows[0]?.id;
    expect(knowledgeBaseId, "expected at least one seeded knowledge_bases row (DEFAULT_KB_ID)").toBeTruthy();

    const doc = await db.execute<{ id: string }>(sql`
      INSERT INTO documents (id, knowledge_base_id, filename, mime_type, byte_size, content_hash, status, created_at, updated_at)
      VALUES (
        ${"schema-pg-test-doc"}, ${knowledgeBaseId}, ${"test.txt"}, ${"text/plain"}, ${9},
        ${"schema-pg-test-hash"}, ${"ready"}, ${new Date().toISOString()}, ${new Date().toISOString()}
      )
      ON CONFLICT (id) DO UPDATE SET updated_at = EXCLUDED.updated_at
      RETURNING id
    `);
    const documentId = doc.rows[0]?.id;
    expect(documentId).toBeTruthy();

    const chunkId = "schema-pg-test-chunk";
    insertedChunkIds.push(chunkId);
    const packedEmbedding = Buffer.from(new Float32Array(768).fill(0.01).buffer);

    await db.execute(sql`
      INSERT INTO chunks (id, knowledge_base_id, document_id, chunk_index, content, char_start, char_end, embedding)
      VALUES (
        ${chunkId}, ${knowledgeBaseId}, ${documentId}, ${0},
        ${"The quick brown fox jumps over the lazy dog."}, ${0}, ${45}, ${packedEmbedding}
      )
      ON CONFLICT (id) DO UPDATE SET content = EXCLUDED.content
    `);

    const matched = await db.execute<{ id: string }>(sql`
      SELECT id FROM chunks
      WHERE id = ${chunkId} AND content_search @@ websearch_to_tsquery('english', ${"quick fox"})
    `);
    expect(matched.rows.length, "generated tsvector column should have populated itself").toBe(1);
    expect(matched.rows[0]?.id).toBe(chunkId);
  });
});
