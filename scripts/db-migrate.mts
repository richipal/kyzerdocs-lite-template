#!/usr/bin/env tsx
/**
 * Idempotent Postgres migration runner (STOR-03). Invoked by `npm run db:migrate` and by
 * cloud-mode boot in a later plan (03-11).
 *
 * Refuses to run unless `DATABASE_URL` is set AND its host is recognizably a Neon host — see
 * `src/lib/storage/neon-guard.ts` (D3-06, KDL-DB-005; developer-approved deviation from this
 * plan's original task text, recorded in `03-03-SUMMARY.md`). This project's own `.env.local`
 * already carries `KYZERDOCS_DATABASE_URL` pointing at KyzerDocs' live production Supabase
 * database — one crossed env-var name away from `DATABASE_URL`.
 *
 * Applies every migration in `drizzle/migrations/` (drizzle-kit's own monotonic
 * apply-if-newer-than-last logic makes a second run a no-op), then seeds the `knowledge_bases`
 * row for `DEFAULT_KB_ID` if it does not exist yet, mirroring `schema.sql.ts`'s `applySchema()`
 * seed step — using `ON CONFLICT (id) DO NOTHING` so a second run is a no-op there too.
 *
 * Exits non-zero on any failure, with a `KDL-DB-*` code in the message so the failure is
 * greppable (SUPP-01).
 */

import { neon } from "@neondatabase/serverless";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/neon-http";
import { migrate } from "drizzle-orm/neon-http/migrator";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AppError } from "../src/lib/errors.js";
import { assertNeonHost } from "../src/lib/storage/neon-guard.js";
import { DEFAULT_KB_ID } from "../src/lib/types.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = join(SCRIPT_DIR, "..", "drizzle", "migrations");

interface JournalEntry {
  tag: string;
  when: number;
}

function readJournal(): JournalEntry[] {
  const journalPath = join(MIGRATIONS_FOLDER, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: JournalEntry[] };
  return journal.entries;
}

/** Snapshots the drizzle-managed migrations table. Returns an empty list on the very first run,
 * before `migrate()` has created `drizzle.__drizzle_migrations` at all — that is not a failure. */
async function readAppliedMigrations(
  db: ReturnType<typeof drizzle>,
): Promise<{ hash: string; created_at: number }[]> {
  try {
    const result = await db.execute(
      sql`select hash, created_at from drizzle.__drizzle_migrations order by created_at asc`,
    );
    return result.rows as unknown as { hash: string; created_at: number }[];
  } catch {
    return [];
  }
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error(
      "KDL-DB-004: DATABASE_URL is not set. Provision a Neon Postgres database and set " +
        "DATABASE_URL in .env.local, then re-run `npm run db:migrate` — see .env.example.",
    );
    process.exit(1);
  }

  try {
    assertNeonHost(databaseUrl, "DATABASE_URL");
  } catch (error) {
    if (error instanceof AppError) {
      console.error(`${error.code}: ${error.message}`);
    } else {
      console.error(error);
    }
    process.exit(1);
  }

  const client = neon(databaseUrl);
  const db = drizzle(client);

  const before = await readAppliedMigrations(db);

  try {
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  } catch (cause) {
    console.error(`KDL-DB-004: migration failed — ${cause instanceof Error ? cause.message : String(cause)}`);
    process.exit(1);
  }

  const after = await readAppliedMigrations(db);
  const beforeHashes = new Set(before.map((row) => row.hash));
  const newlyApplied = after.filter((row) => !beforeHashes.has(row.hash));

  if (newlyApplied.length === 0) {
    console.log("No migrations were applied — schema already up to date.");
  } else {
    const journal = readJournal();
    for (const row of newlyApplied) {
      const entry = journal.find((j) => j.when === Number(row.created_at));
      console.log(`Applied migration: ${entry?.tag ?? row.hash.slice(0, 12)}`);
    }
  }

  let seedResult;
  try {
    seedResult = await db.execute(sql`
      INSERT INTO knowledge_bases (id, name, created_at)
      VALUES (${DEFAULT_KB_ID}, ${"Default"}, ${new Date().toISOString()})
      ON CONFLICT (id) DO NOTHING
      RETURNING id
    `);
  } catch (cause) {
    console.error(`KDL-DB-004: seed step failed — ${cause instanceof Error ? cause.message : String(cause)}`);
    process.exit(1);
  }

  if (seedResult.rows.length > 0) {
    console.log(`Seed row created: knowledge_bases.id = "${DEFAULT_KB_ID}"`);
  } else {
    console.log(`Seed row already present: knowledge_bases.id = "${DEFAULT_KB_ID}"`);
  }
}

main().catch((cause) => {
  if (cause instanceof AppError) {
    console.error(`${cause.code}: ${cause.message}`);
  } else {
    console.error(`KDL-DB-004: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  process.exit(1);
});
