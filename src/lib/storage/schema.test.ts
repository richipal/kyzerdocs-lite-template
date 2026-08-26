import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import { openDatabase } from "./pragmas.js";
import { applySchema } from "./schema.sql.js";

describe("storage/pragmas + schema", () => {
  let dir: string;
  let db: DatabaseSync;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kdl-schema-test-"));
    db = openDatabase(join(dir, "test.db"));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("opens with WAL journal mode and a 5000ms busy_timeout", () => {
    const journalMode = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    const busyTimeout = db.prepare("PRAGMA busy_timeout").get() as { timeout: number };

    expect(journalMode.journal_mode).toBe("wal");
    expect(busyTimeout.timeout).toBe(5000);
  });

  it("applies the schema idempotently — running it twice leaves the same table count", () => {
    applySchema(db);
    const tableCountAfterFirst = (
      db.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table'").get() as {
        c: number;
      }
    ).c;

    expect(() => applySchema(db)).not.toThrow();

    const tableCountAfterSecond = (
      db.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table'").get() as {
        c: number;
      }
    ).c;

    expect(tableCountAfterSecond).toBe(tableCountAfterFirst);
  });

  it("scopes documents, chunks, and ingest_jobs by knowledge_base_id", () => {
    applySchema(db);
    const tables = ["documents", "chunks", "ingest_jobs"];
    for (const table of tables) {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      expect(columns.some((c) => c.name === "knowledge_base_id")).toBe(true);
    }
  });

  it("cascades: deleting a documents row removes its chunks rows (foreign_keys ON)", () => {
    applySchema(db);
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO documents (id, knowledge_base_id, filename, mime_type, byte_size, content_hash, status, created_at, updated_at) VALUES (?, 'default', 'a.txt', 'text/plain', 10, 'hash', 'ready', ?, ?)",
    ).run("doc-1", now, now);
    const embedding = Buffer.alloc(3072);
    db.prepare(
      "INSERT INTO chunks (id, knowledge_base_id, document_id, chunk_index, content, char_start, char_end, embedding) VALUES (?, 'default', 'doc-1', 0, 'hello', 0, 5, ?)",
    ).run("chunk-1", embedding);

    db.prepare("DELETE FROM documents WHERE id = ?").run("doc-1");

    const remaining = db.prepare("SELECT COUNT(*) AS c FROM chunks WHERE document_id = ?").get(
      "doc-1",
    ) as { c: number };
    expect(remaining.c).toBe(0);
  });

  it("throws AppError KDL-DB-001 when the target path is not writable", () => {
    const readonlyDir = mkdtempSync(join(tmpdir(), "kdl-readonly-"));
    chmodSync(readonlyDir, 0o555);

    try {
      expect(() => openDatabase(join(readonlyDir, "nested", "test.db"))).toThrow(AppError);
      try {
        openDatabase(join(readonlyDir, "nested", "test.db"));
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).code).toBe("KDL-DB-001");
      }
    } finally {
      chmodSync(readonlyDir, 0o755);
      rmSync(readonlyDir, { recursive: true, force: true });
    }
  });
});
