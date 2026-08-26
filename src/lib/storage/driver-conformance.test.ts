/**
 * One behavioral suite, run against BOTH `StorageDriver` implementations (STOR-03, D3-09's
 * conformance-proof plan). The SQLite arm always runs (a fresh in-memory database per test). The
 * Postgres arm runs against the real Neon database when `DATABASE_URL` is available
 * (`readCloudTestEnv` — never mutates `process.env`, see `test-cloud-env.ts`), and reports an
 * explicit skip message (not a failure) otherwise, so this suite stays meaningful on a
 * local-only machine.
 *
 * Every case asserts the CONTRACT (ordering, cascading, byte-exactness, KB scoping) rather than a
 * dialect-specific implementation detail. `searchKeyword` cases never assert on a score value —
 * SQLite's `bm25()` (ascending) and Postgres's `ts_rank` (descending) are on different scales by
 * design (RESEARCH.md Pitfall 3, orchestrator notes); only correct best-first ordering and
 * contiguous 0-indexed ranks are shared contract.
 *
 * `transaction()` is the one place the two dialects cannot share an assertion: SQLite's
 * synchronous implementation supports a real rollback; Postgres's HTTP transport cannot run an
 * interactive transaction at all and fails closed with `KDL-DB-003` by design (`postgres.ts`),
 * while the default WebSocket transport (D3-18, plan 03-07 — see `pg-client.ts`) DOES support a
 * real rollback, like SQLite. All three are registered via `extra`, inside the SAME describe
 * block as the shared suite (guaranteeing they run after the arm's own setup hook), asserting
 * their own dialect/transport-correct behavior rather than a shared one.
 */

import { randomUUID } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_KB_ID } from "../types.js";
import type { StorageDriver } from "./driver.js";
import { createPgClient } from "./pg-client.js";
import { openDatabase } from "./pragmas.js";
import { PgStorageDriver } from "./postgres.js";
import { applySchema } from "./schema.sql.js";
import { SqliteStorageDriver } from "./sqlite.js";
import { readCloudTestEnv } from "./test-cloud-env.js";
import type { NewChunk, NewDocument } from "./types.js";

const DIM = 768;

function makeVector(fill: (i: number) => number): Float32Array {
  const v = new Float32Array(DIM);
  for (let i = 0; i < DIM; i++) v[i] = fill(i);
  return v;
}

function baseDocument(kbId: string, overrides: Partial<NewDocument> = {}): NewDocument {
  return {
    knowledgeBaseId: kbId,
    filename: "doc.txt",
    mimeType: "text/plain",
    byteSize: 100,
    contentHash: `hash-${randomUUID()}`,
    ...overrides,
  };
}

function baseChunk(kbId: string, documentId: string, overrides: Partial<NewChunk> = {}): NewChunk {
  return {
    knowledgeBaseId: kbId,
    documentId,
    chunkIndex: 0,
    content: "hello world",
    charStart: 0,
    charEnd: 11,
    embedding: makeVector((i) => i / DIM),
    ...overrides,
  };
}

interface Arm {
  driver: StorageDriver;
  kbId: string;
  otherKbId: string;
}

interface ArmHooks {
  beforeEach?: () => void | Promise<void>;
  beforeAll?: () => void | Promise<void>;
  afterAll?: () => void | Promise<void>;
}

/**
 * Registers the full shared behavioral suite, plus any dialect-specific `extra` tests, all inside
 * ONE `describe` block — so `hooks.beforeAll`/`hooks.beforeEach` are guaranteed to have run by
 * the time ANY test in this block (shared or `extra`) reads `getArm()`. `available` is a plain
 * boolean known at collection time, never computed by calling `getArm()` itself (whose backing
 * value may not be assigned yet at collection time — vitest evaluates a `describe.skipIf(...)`
 * body synchronously during collection, before any hook has run; `schema.pg.test.ts` already hit
 * this exact defect once this phase).
 */
function registerConformanceTests(
  name: string,
  available: boolean,
  getArm: () => Arm,
  hooks: ArmHooks = {},
  extra?: (getArm: () => Arm) => void,
): void {
  describe.skipIf(!available)(`shared conformance suite (${name})`, () => {
    if (hooks.beforeAll) beforeAll(hooks.beforeAll);
    if (hooks.afterAll) afterAll(hooks.afterAll);
    if (hooks.beforeEach) beforeEach(hooks.beforeEach);

    it("document insert/get/list/update round-trip with every nullable field exercised", async () => {
      const arm = getArm();
      const doc = await arm.driver.insertDocument(
        baseDocument(arm.kbId, {
          storagePath: "uploads/a.txt",
          pageCount: 3,
          status: "parsing",
          errorCode: null,
          errorMessage: null,
          supersededBy: null,
        }),
      );
      expect(doc.knowledgeBaseId).toBe(arm.kbId);
      expect(doc.storagePath).toBe("uploads/a.txt");
      expect(doc.pageCount).toBe(3);
      expect(doc.status).toBe("parsing");

      const fetched = await arm.driver.getDocument(doc.id);
      expect(fetched).toEqual(doc);

      const listed = await arm.driver.listDocuments(arm.kbId);
      expect(listed.some((d) => d.id === doc.id)).toBe(true);

      await arm.driver.updateDocument(doc.id, {
        status: "failed",
        errorCode: "KDL-PARSE-003",
        errorMessage: "could not read file",
        supersededBy: null,
        pageCount: null,
        storagePath: null,
      });
      const updated = await arm.driver.getDocument(doc.id);
      expect(updated?.status).toBe("failed");
      expect(updated?.errorCode).toBe("KDL-PARSE-003");
      expect(updated?.errorMessage).toBe("could not read file");
      expect(updated?.pageCount).toBeNull();
      expect(updated?.storagePath).toBeNull();

      await arm.driver.deleteDocument(doc.id);
    });

    it("deleteDocument removes the document and cascades its chunks", async () => {
      const arm = getArm();
      const doc = await arm.driver.insertDocument(baseDocument(arm.kbId));
      await arm.driver.upsertChunks([
        baseChunk(arm.kbId, doc.id, { id: `c1-${randomUUID()}` }),
        baseChunk(arm.kbId, doc.id, { id: `c2-${randomUUID()}`, chunkIndex: 1 }),
      ]);
      expect(await arm.driver.countChunksForDocument(doc.id)).toBe(2);

      await arm.driver.deleteDocument(doc.id);

      expect(await arm.driver.getDocument(doc.id)).toBeNull();
      expect(await arm.driver.countChunksForDocument(doc.id)).toBe(0);
    });

    it("supersedeDocument keeps the old document row, sets supersededBy, and removes its chunks", async () => {
      const arm = getArm();
      const oldDoc = await arm.driver.insertDocument(baseDocument(arm.kbId));
      const newDoc = await arm.driver.insertDocument(baseDocument(arm.kbId));
      const chunkId = `sc-${randomUUID()}`;
      await arm.driver.upsertChunks([baseChunk(arm.kbId, oldDoc.id, { id: chunkId })]);

      await arm.driver.supersedeDocument(oldDoc.id, newDoc.id);

      const oldAfter = await arm.driver.getDocument(oldDoc.id);
      expect(oldAfter).not.toBeNull();
      expect(oldAfter?.supersededBy).toBe(newDoc.id);
      expect(await arm.driver.countChunksForDocument(oldDoc.id)).toBe(0);
      expect(await arm.driver.getChunksByIds([chunkId])).toEqual([]);

      await arm.driver.deleteDocument(oldDoc.id);
      await arm.driver.deleteDocument(newDoc.id);
    });

    it("upsertChunks is idempotent — same id twice yields one row with the second content", async () => {
      const arm = getArm();
      const doc = await arm.driver.insertDocument(baseDocument(arm.kbId));
      const id = `idem-${randomUUID()}`;
      await arm.driver.upsertChunks([baseChunk(arm.kbId, doc.id, { id, content: "first version" })]);
      await arm.driver.upsertChunks([baseChunk(arm.kbId, doc.id, { id, content: "second version" })]);

      expect(await arm.driver.countChunksForDocument(doc.id)).toBe(1);
      const [chunk] = await arm.driver.getChunksByIds([id]);
      expect(chunk?.content).toBe("second version");

      await arm.driver.deleteDocument(doc.id);
    });

    it("round-trips a packed 768-float vector exactly, byteLength 3072", async () => {
      const arm = getArm();
      const doc = await arm.driver.insertDocument(baseDocument(arm.kbId));
      const vector = makeVector((i) => Math.sin(i) * 0.5 + i * 1e-4);
      const id = `vec-${randomUUID()}`;
      await arm.driver.upsertChunks([baseChunk(arm.kbId, doc.id, { id, embedding: vector })]);

      const vectors = await arm.driver.getAllChunkVectors(arm.kbId);
      const found = vectors.find((v) => v.id === id);
      expect(found).toBeDefined();
      expect(found!.embedding.byteLength).toBe(3072);

      const roundTripped = new Float32Array(found!.embedding.buffer, found!.embedding.byteOffset, DIM);
      for (let i = 0; i < DIM; i++) {
        expect(roundTripped[i]).toBe(vector[i]);
      }

      await arm.driver.deleteDocument(doc.id);
    });

    it("generation counter is monotonic — bumps on upsertChunks and deleteDocument, nothing else", async () => {
      const arm = getArm();
      const genBefore = await arm.driver.getGeneration(arm.kbId);
      const doc = await arm.driver.insertDocument(baseDocument(arm.kbId));
      const id = `gen-${randomUUID()}`;
      await arm.driver.upsertChunks([baseChunk(arm.kbId, doc.id, { id })]);
      const genAfterUpsert = await arm.driver.getGeneration(arm.kbId);
      expect(genAfterUpsert).toBeGreaterThan(genBefore);

      for (let i = 0; i < 5; i++) {
        await arm.driver.listDocuments(arm.kbId);
        await arm.driver.getDocument(doc.id);
      }
      expect(await arm.driver.getGeneration(arm.kbId)).toBe(genAfterUpsert);

      await arm.driver.deleteDocument(doc.id);
      const genAfterDelete = await arm.driver.getGeneration(arm.kbId);
      expect(genAfterDelete).toBeGreaterThan(genAfterUpsert);
    });

    it("getSetting/setSetting upsert — last write wins, absent key reads null", async () => {
      const arm = getArm();
      const key = `conformance-setting-${randomUUID()}`;
      expect(await arm.driver.getSetting(key)).toBeNull();

      await arm.driver.setSetting(key, "first", 1);
      expect(await arm.driver.getSetting(key)).toBe("first");

      await arm.driver.setSetting(key, "second", 2);
      expect(await arm.driver.getSetting(key)).toBe("second");
    });

    it("createJob -> updateJobProgress -> getJob reflects progress", async () => {
      const arm = getArm();
      const doc = await arm.driver.insertDocument(baseDocument(arm.kbId));
      const job = await arm.driver.createJob({
        knowledgeBaseId: arm.kbId,
        documentId: doc.id,
        status: "embedding",
        chunksTotal: 10,
        chunksProcessed: 0,
      });

      await arm.driver.updateJobProgress(job.id, { chunksProcessed: 5 });
      const midway = await arm.driver.getJob(job.id);
      expect(midway?.chunksProcessed).toBe(5);

      await arm.driver.updateJobProgress(job.id, { chunksProcessed: 10, status: "ready" });
      const done = await arm.driver.getJob(job.id);
      expect(done?.chunksProcessed).toBe(10);
      expect(done?.status).toBe("ready");

      await arm.driver.deleteDocument(doc.id);
    });

    it("countDocuments and countChunksForDocument report correctly", async () => {
      const arm = getArm();
      const before = await arm.driver.countDocuments(arm.kbId);

      const ready = await arm.driver.insertDocument(baseDocument(arm.kbId, { status: "ready" }));
      const failed = await arm.driver.insertDocument(baseDocument(arm.kbId, { status: "failed" }));
      await arm.driver.upsertChunks([
        baseChunk(arm.kbId, ready.id, { id: `cd1-${randomUUID()}` }),
        baseChunk(arm.kbId, ready.id, { id: `cd2-${randomUUID()}`, chunkIndex: 1 }),
      ]);

      const after = await arm.driver.countDocuments(arm.kbId);
      expect(after.total).toBe(before.total + 2);
      expect(after.ready).toBe(before.ready + 1);
      expect(after.failed).toBe(before.failed + 1);
      expect(await arm.driver.countChunksForDocument(ready.id)).toBe(2);
      expect(await arm.driver.countChunksForDocument(failed.id)).toBe(0);

      await arm.driver.deleteDocument(ready.id);
      await arm.driver.deleteDocument(failed.id);
    });

    it("scopes searchKeyword results to the queried knowledge base — a shared term never leaks across KBs", async () => {
      const arm = getArm();
      const docA = await arm.driver.insertDocument(baseDocument(arm.kbId));
      const docB = await arm.driver.insertDocument(baseDocument(arm.otherKbId));
      const idA = `scope-a-${randomUUID()}`;
      const idB = `scope-b-${randomUUID()}`;

      await arm.driver.upsertChunks([
        baseChunk(arm.kbId, docA.id, {
          id: idA,
          content: "the forklift safety procedure requires a spotter",
        }),
      ]);
      await arm.driver.upsertChunks([
        baseChunk(arm.otherKbId, docB.id, {
          id: idB,
          content: "the forklift maintenance schedule is quarterly",
        }),
      ]);

      const resultsA = await arm.driver.searchKeyword(arm.kbId, "forklift", 10);
      const resultsB = await arm.driver.searchKeyword(arm.otherKbId, "forklift", 10);

      expect(resultsA.map((r) => r.id)).toEqual([idA]);
      expect(resultsB.map((r) => r.id)).toEqual([idB]);

      await arm.driver.deleteDocument(docA.id);
      await arm.driver.deleteDocument(docB.id);
    });

    it("handles an injection-shaped query without throwing", async () => {
      const arm = getArm();
      const doc = await arm.driver.insertDocument(baseDocument(arm.kbId));
      const id = `ppe-${randomUUID()}`;
      await arm.driver.upsertChunks([
        baseChunk(arm.kbId, doc.id, { id, content: "PPE is required on site" }),
      ]);

      await expect(
        arm.driver.searchKeyword(arm.kbId, 'ppe" OR 1=1 NEAR* ^:', 10),
      ).resolves.not.toThrow();

      const results = await arm.driver.searchKeyword(arm.kbId, 'ppe" OR 1=1 NEAR* ^:', 10);
      expect(results.every((r) => typeof r.id === "string")).toBe(true);

      await arm.driver.deleteDocument(doc.id);
    });

    it("ranks best-first with contiguous 0-indexed ranks — never asserts on a score value", async () => {
      const arm = getArm();
      const doc = await arm.driver.insertDocument(baseDocument(arm.kbId));
      const weakId = `weak-${randomUUID()}`;
      const strongId = `strong-${randomUUID()}`;
      await arm.driver.upsertChunks([
        baseChunk(arm.kbId, doc.id, {
          id: weakId,
          chunkIndex: 0,
          content: "conformance is important on every site",
        }),
        baseChunk(arm.kbId, doc.id, {
          id: strongId,
          chunkIndex: 1,
          content: "conformance conformance conformance procedures govern every conformance inspection",
        }),
      ]);

      const results = await arm.driver.searchKeyword(arm.kbId, "conformance", 10);
      expect(results[0]?.id).toBe(strongId);
      expect(results.map((r) => r.rank)).toEqual(results.map((_, i) => i));

      await arm.driver.deleteDocument(doc.id);
    });

    it("returns an empty array for a term present in no chunk, without throwing", async () => {
      const arm = getArm();
      const doc = await arm.driver.insertDocument(baseDocument(arm.kbId));
      const id = `empty-${randomUUID()}`;
      await arm.driver.upsertChunks([baseChunk(arm.kbId, doc.id, { id })]);

      const results = await arm.driver.searchKeyword(arm.kbId, "nonexistentxyzconformance", 10);
      expect(results).toEqual([]);

      await arm.driver.deleteDocument(doc.id);
    });

    extra?.(getArm);
  });
}

// ---------------------------------------------------------------------------------------------
// SQLite arm — always runs, fresh in-memory database before every test in this describe block.
// ---------------------------------------------------------------------------------------------

let sqliteArm: Arm;

function makeSqliteArm(): Arm {
  const db = openDatabase(":memory:");
  applySchema(db);
  const otherKbId = "kb-2";
  db.prepare("INSERT INTO knowledge_bases (id, name, created_at) VALUES (?, ?, ?)").run(
    otherKbId,
    "Other",
    new Date().toISOString(),
  );
  return { driver: new SqliteStorageDriver(db), kbId: DEFAULT_KB_ID, otherKbId };
}

registerConformanceTests(
  "sqlite",
  true,
  () => sqliteArm,
  { beforeEach: () => { sqliteArm = makeSqliteArm(); } },
  (getArm) => {
    it("transaction() rolls back every write when the callback throws", async () => {
      const arm = getArm();
      await expect(
        arm.driver.transaction(async (tx) => {
          await tx.insertDocument(baseDocument(arm.kbId, { id: "will-roll-back" }));
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");

      expect(await arm.driver.getDocument("will-roll-back")).toBeNull();
    });
  },
);

// ---------------------------------------------------------------------------------------------
// Postgres arm — runs against the real Neon database when DATABASE_URL is available (read via
// readCloudTestEnv, which never mutates process.env — see that module's header for why this
// matters). Skips (not fails) otherwise, matching schema.pg.test.ts's convention.
// ---------------------------------------------------------------------------------------------

const databaseUrl = readCloudTestEnv("DATABASE_URL");

let pgArm: Arm;

registerConformanceTests(
  "postgres",
  !!databaseUrl,
  () => pgArm,
  {
    beforeAll: async () => {
      const client = createPgClient(databaseUrl as string);
      const kbId = `conformance-${randomUUID()}`;
      const otherKbId = `conformance-other-${randomUUID()}`;

      const sql = neon(databaseUrl as string);
      const now = new Date().toISOString();
      await sql`INSERT INTO knowledge_bases (id, name, created_at) VALUES (${kbId}, ${"Conformance"}, ${now})`;
      await sql`INSERT INTO knowledge_bases (id, name, created_at) VALUES (${otherKbId}, ${"Conformance Other"}, ${now})`;

      pgArm = { driver: new PgStorageDriver(client), kbId, otherKbId };
    },
    afterAll: async () => {
      const sql = neon(databaseUrl as string);
      // Cascades chunks/ingest_jobs via ON DELETE CASCADE.
      await sql`DELETE FROM documents WHERE knowledge_base_id IN (${pgArm.kbId}, ${pgArm.otherKbId})`;
      await sql`DELETE FROM app_settings WHERE key IN (${`__generation__:${pgArm.kbId}`}, ${`__generation__:${pgArm.otherKbId}`})`;
      // The getSetting/setSetting case above writes a randomly-keyed row with no corresponding
      // delete method on StorageDriver (by design — the interface is unchanged, see driver.ts's
      // header) — sweep it up here by the fixed prefix that test case always uses.
      await sql`DELETE FROM app_settings WHERE key LIKE 'conformance-setting-%'`;
      await sql`DELETE FROM knowledge_bases WHERE id IN (${pgArm.kbId}, ${pgArm.otherKbId})`;
    },
  },
  (getArm) => {
    // Plan 03-07 (D3-18) flipped DEFAULT_PG_TRANSPORT from "http" to "websocket" after measuring
    // HTTP fail outright (not just slowly) at the product's 20,000-chunk target scale — see
    // pg-client.ts's header and 03-COLDSTART.md. `getArm().driver` is built via
    // `createPgClient(databaseUrl)` with no explicit transport, so it now exercises the
    // WEBSOCKET path by default, not HTTP. Both assertions below are kept, each naming its
    // transport explicitly rather than "the default", so this suite stays correct the next time
    // the default changes.

    it("transaction() over an explicit HTTP transport fails closed with KDL-DB-003", async () => {
      const arm = getArm();
      const httpClient = createPgClient(databaseUrl as string, "http");
      const httpDriver = new PgStorageDriver(httpClient);

      await expect(
        httpDriver.transaction(async (tx) => {
          await tx.insertDocument(baseDocument(arm.kbId, { id: "should-not-run" }));
        }),
      ).rejects.toMatchObject({ code: "KDL-DB-003" });

      expect(await arm.driver.getDocument("should-not-run")).toBeNull();
    });

    it("transaction() over the default (WebSocket) transport rolls back every write when the callback throws", async () => {
      // First live verification of this code path (postgres.ts's own header, 03-05-SUMMARY.md:
      // "The WebSocket transport path is written but UNVERIFIED against a live connection")
      // now that plan 03-07 made it the shipped default.
      const arm = getArm();
      await expect(
        arm.driver.transaction(async (tx) => {
          await tx.insertDocument(baseDocument(arm.kbId, { id: "ws-will-roll-back" }));
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");

      expect(await arm.driver.getDocument("ws-will-roll-back")).toBeNull();
    });
  },
);
