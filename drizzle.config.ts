/**
 * drizzle-kit config — Postgres dialect ONLY.
 *
 * drizzle-kit cannot target `node:sqlite` (open issue drizzle-team/drizzle-orm#5471), which is
 * why `src/lib/storage/schema.sql.ts` stays hand-written `CREATE TABLE IF NOT EXISTS` SQL applied
 * with `db.exec()` at boot, and is not managed by this config or by drizzle-kit at all. This file
 * exists solely to generate and apply migrations for `src/lib/storage/schema.pg.ts`, the cloud-mode
 * (Business tier) Postgres schema.
 *
 * `npm run db:generate` (drizzle-kit generate) diffs `schema.pg.ts` against the migration history
 * already present in `drizzle/migrations/` and emits SQL — this works fully offline, with no
 * database connection required. `dbCredentials.url` below is only consulted by commands that
 * actually connect (e.g. `drizzle-kit push`, which this project does NOT use — migrations are
 * applied by `scripts/db-migrate.mts` instead, so the generated SQL can be reviewed before it
 * ever touches a real database).
 */

import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/lib/storage/schema.pg.ts",
  out: "./drizzle/migrations",
  dbCredentials: {
    // Deliberately allowed to be an empty string at config-load time: `db:generate` never
    // connects, so an absent DATABASE_URL (e.g. this dev machine, pre-Task-1-checkpoint) must not
    // crash the generate command. Any command that DOES connect (not used in this project) would
    // fail loudly on an empty string, which is the correct behavior for those commands.
    url: process.env.DATABASE_URL ?? "",
  },
});
