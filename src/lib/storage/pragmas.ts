/**
 * `openDatabase()` — the single place a `node:sqlite` connection is opened. WAL mode and
 * `busy_timeout` are not defaults under `node:sqlite`'s `DatabaseSync` (`busy_timeout` defaults to
 * 0 — PITFALLS.md Pitfall 4 / 02-RESEARCH.md Pitfall 4) and there is currently no constructor
 * option for them, so they must be set explicitly, on every open, every time.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { AppError } from "../errors.js";

/** Opens (creating if absent) a SQLite database file at `path`, applying WAL mode, a 5s
 * busy_timeout, and foreign key enforcement. Creates the parent directory if it doesn't exist.
 * Any failure to create the directory or open the connection is wrapped in `AppError`
 * `KDL-DB-001` — callers never see a raw sqlite/fs error. */
export function openDatabase(path: string): DatabaseSync {
  try {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
  } catch (cause) {
    throw new AppError("KDL-DB-001", { cause });
  }

  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path);
  } catch (cause) {
    throw new AppError("KDL-DB-001", { cause });
  }

  try {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA foreign_keys = ON");
  } catch (cause) {
    throw new AppError("KDL-DB-001", { cause });
  }

  return db;
}
