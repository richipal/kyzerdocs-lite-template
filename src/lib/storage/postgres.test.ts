/**
 * Postgres-only behaviors `driver-conformance.test.ts`'s shared suite cannot express: the
 * generated `content_search` column populating itself with no application code, a missing-relation
 * failure surfacing as `KDL-DB-004`, and an unreachable host surfacing as `KDL-DB-003`. Skips
 * cleanly (not fails) when no live `DATABASE_URL` is available, matching
 * `schema.pg.test.ts`/`driver-conformance.test.ts`'s convention. Credential read via
 * `readCloudTestEnv` — never mutates `process.env` (see that module's header).
 */

import { randomUUID } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgClient } from "./pg-client.js";
import { wrapPgError } from "./pg-client.js";
import { PgStorageDriver } from "./postgres.js";
import { readCloudTestEnv } from "./test-cloud-env.js";

const databaseUrl = readCloudTestEnv("DATABASE_URL");

describe.skipIf(!databaseUrl)("postgres.ts — Postgres-only behaviors against a live Neon database", () => {
  let driver: PgStorageDriver;
  let kbId: string;
  const insertedDocumentIds: string[] = [];

  beforeAll(async () => {
    const client = createPgClient(databaseUrl as string);
    driver = new PgStorageDriver(client);
    kbId = `pgtest-${randomUUID()}`;

    const client2 = neon(databaseUrl as string);
    await client2`INSERT INTO knowledge_bases (id, name, created_at) VALUES (${kbId}, ${"pg.test.ts"}, ${new Date().toISOString()})`;
  });

  afterAll(async () => {
    const client = neon(databaseUrl as string);
    for (const id of insertedDocumentIds) {
      await client`DELETE FROM documents WHERE id = ${id}`;
    }
    await client`DELETE FROM app_settings WHERE key = ${`__generation__:${kbId}`}`;
    await client`DELETE FROM knowledge_bases WHERE id = ${kbId}`;
  });

  it("the generated content_search column populates itself with no application code", async () => {
    const doc = await driver.insertDocument({
      knowledgeBaseId: kbId,
      filename: "pg-only-test.txt",
      mimeType: "text/plain",
      byteSize: 42,
      contentHash: `hash-${randomUUID()}`,
    });
    insertedDocumentIds.push(doc.id);

    const vector = new Float32Array(768);
    const chunkId = randomUUID();
    await driver.upsertChunks([
      {
        id: chunkId,
        knowledgeBaseId: kbId,
        documentId: doc.id,
        chunkIndex: 0,
        content: "the quick brown fox jumps over the lazy dog",
        charStart: 0,
        charEnd: 44,
        embedding: vector,
      },
    ]);

    // No application code ever writes content_search — PgStorageDriver only ever writes to
    // `content` (see postgres.ts's upsertChunks). If this returns the row, the generated column
    // populated itself, unattended, from the write above.
    const results = await driver.searchKeyword(kbId, "quick fox", 10);
    expect(results.map((r) => r.id)).toContain(chunkId);
  });

  it("a missing-relation failure (SQLSTATE 42P01) surfaces as KDL-DB-004", async () => {
    const client = createPgClient(databaseUrl as string);
    try {
      await client.db.execute(sql`SELECT * FROM kdl_conformance_table_that_does_not_exist`);
      throw new Error("expected the query to reject with a missing-relation error");
    } catch (cause) {
      const appError = wrapPgError(cause);
      expect(appError.code).toBe("KDL-DB-004");
    }
  });

  it("an unreachable Neon host surfaces as KDL-DB-003", async () => {
    // Syntactically valid, Neon-shaped, genuinely unreachable — DNS/connection failure, not a
    // Postgres-level SQL error, exercising the OTHER branch of wrapPgError.
    const unreachableUrl =
      "postgresql://user:pass@ep-nonexistent-conformance-test-000000.us-east-1.aws.neon.tech/neondb";
    const client = createPgClient(unreachableUrl);
    const unreachableDriver = new PgStorageDriver(client);

    await expect(unreachableDriver.getDocument("anything")).rejects.toMatchObject({
      code: "KDL-DB-003",
    });
  }, 20000);
});
