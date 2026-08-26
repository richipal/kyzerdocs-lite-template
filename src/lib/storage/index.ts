/**
 * The only module the rest of the app imports from `src/lib/storage/` (STOR-01). Everything else
 * types against `StorageDriver` (`./driver.js`); this file is where the one `node:sqlite`
 * connection (local mode) or Neon connection (cloud mode) actually gets opened and wired into a
 * concrete driver.
 *
 * `PRODUCT_CONFIG.cloudMode` — derived from `DATABASE_URL` presence alone (`src/lib/config.ts`,
 * D3-16) — is the ONLY switch read here. Plans 03-06 (rate limiter) and 03-10 (file storage)
 * deliberately reuse this exact same shape (a `PRODUCT_CONFIG.cloudMode` branch in a lazy
 * singleton getter) rather than inventing a second local/cloud convention.
 */

import { PRODUCT_CONFIG } from "../config.js";
import { AppError } from "../errors.js";
import { BlobFileStorage } from "./blob.js";
import type { StorageDriver } from "./driver.js";
import type { FileStorage } from "./file-storage.js";
import { LocalFileStorage } from "./files.js";
import { createPgClient } from "./pg-client.js";
import { openDatabase } from "./pragmas.js";
import { PgStorageDriver } from "./postgres.js";
import { applySchema } from "./schema.sql.js";
import { SqliteStorageDriver } from "./sqlite.js";

let driver: StorageDriver | null = null;
let fileStorage: FileStorage | null = null;

/** Returns the process-wide `StorageDriver` singleton, opening the connection on first call —
 * lazily, never at import time, so a route that never touches storage never opens a database.
 * Safe to call repeatedly — subsequent calls return the same instance.
 *
 * Cloud mode (`DATABASE_URL` present) constructs a `PgStorageDriver` over Neon and does NOT call
 * `applySchema` — that is SQLite-only DDL. A cloud deploy applies its schema via
 * `npm run db:migrate` before the app ever boots; if a query here fails because a table is
 * missing, `PgStorageDriver`'s own error wrapping surfaces `KDL-DB-004` (run the migration)
 * rather than a raw Postgres error. Local mode is unchanged: open the SQLite file, apply the
 * hand-written schema, wire it into `SqliteStorageDriver`. */
export function getStorageDriver(): StorageDriver {
  if (!driver) {
    if (PRODUCT_CONFIG.cloudMode) {
      const databaseUrl = process.env.DATABASE_URL;
      if (!databaseUrl) {
        // Defensive — PRODUCT_CONFIG.cloudMode is derived from this same env var, so this branch
        // should be unreachable, but never construct a Postgres client with an empty string.
        throw new AppError("KDL-DB-003", { message: "DATABASE_URL is unexpectedly absent in cloud mode." });
      }
      const client = createPgClient(databaseUrl);
      driver = new PgStorageDriver(client);
    } else {
      const db = openDatabase(PRODUCT_CONFIG.paths.databasePath);
      applySchema(db);
      driver = new SqliteStorageDriver(db);
    }
  }
  return driver;
}

/** Returns the process-wide `FileStorage` singleton (STOR-06, plan 03-10) — the third use of the
 * exact same shape as `getStorageDriver` above (storage driver, rate limiter, now file storage):
 * a lazy singleton, branched on the SAME `PRODUCT_CONFIG.cloudMode` switch. Local mode returns
 * `LocalFileStorage` (`./files.ts`, the filesystem path already sold as the Private tier). Cloud
 * mode returns `BlobFileStorage` (`./blob.ts`, over the buyer's private Vercel Blob store). */
export function getFileStorage(): FileStorage {
  if (!fileStorage) {
    fileStorage = PRODUCT_CONFIG.cloudMode ? BlobFileStorage : LocalFileStorage;
  }
  return fileStorage;
}

/** UI-SPEC Surface 4: the sidebar's cloud-mode meta line reads `{driver label} · cloud` and must
 * never hardcode "Postgres" in the component (S-5 — a fabricated-looking label if a future dialect
 * is added). Phase 3 supports exactly one Postgres provider in cloud mode — Neon, enforced fail-
 * closed by `neon-guard.ts`'s `assertNeonHost` at migration time — so "Postgres (Neon)" is a real,
 * true label whenever `cloudMode` is on, not a guess. Local mode is unchanged: `SQLite`. */
export function getDriverLabel(): string {
  return PRODUCT_CONFIG.cloudMode ? "Postgres (Neon)" : "SQLite";
}

export type { StorageDriver } from "./driver.js";
export type { FileStorage } from "./file-storage.js";
export type {
  Chunk,
  Document,
  DocumentStatus,
  IngestJob,
  IngestJobStatus,
  NewChunk,
  NewDocument,
  NewIngestJob,
} from "./types.js";
