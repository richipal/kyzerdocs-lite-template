/**
 * Reads a cloud-mode test credential (`DATABASE_URL`/`BLOB_READ_WRITE_TOKEN`) for opt-in live
 * test suites (`schema.pg.test.ts`, `driver-conformance.test.ts`, `postgres.test.ts`) WITHOUT ever
 * writing to `process.env`.
 *
 * Rule 1 fix (found during plan 03-05, Task 2): `vitest.setup.ts` used to lift these two keys out
 * of `.env.local` directly into `process.env`, globally, for the whole vitest run. That worked
 * for its one stated goal (making `schema.pg.test.ts`'s `describe.skipIf(!process.env.DATABASE_URL)`
 * gate actually execute instead of skip), but `process.env` is a real OS-level structure scoped to
 * the worker PROCESS, not to a test file or its module registry — `vi.resetModules()` resets
 * Vitest's synthetic module cache, not `process.env`. Once `getStorageDriver()` grew a real
 * `PRODUCT_CONFIG.cloudMode` branch (this plan, D3-16), every OTHER test file that happens to run
 * in the SAME reused worker thread as an opt-in live suite silently inherited a live
 * `DATABASE_URL` and got routed to the real Neon database instead of its own isolated local SQLite
 * fixture — `src/app/api/health/route.test.ts`'s "authenticated GET" test failed non-deterministically
 * (corpus counts of 7, then 10, tracking whatever real data happened to be in the live database at
 * that moment) purely as a side effect of worker reuse, with no code of its own at fault.
 *
 * The fix: opt-in live suites read the credential directly (from an already-set `process.env`
 * value, or from `.env.local` on disk) and use the returned string locally — e.g. passed straight
 * into `createPgClient(databaseUrl)` or `neon(databaseUrl)` — instead of ever assigning it back to
 * `process.env`. No test file outside this opt-in set is affected, because nothing is mutated
 * process-wide.
 */

import { existsSync, readFileSync } from "node:fs";

const CLOUD_TEST_KEYS = ["DATABASE_URL", "BLOB_READ_WRITE_TOKEN"] as const;
export type CloudTestKey = (typeof CLOUD_TEST_KEYS)[number];

/** Returns the credential's value if present in `process.env` already (e.g. injected by CI)
 * or in `.env.local` on disk, otherwise `undefined`. Never writes to `process.env`. */
export function readCloudTestEnv(key: CloudTestKey): string | undefined {
  const fromProcess = process.env[key];
  if (fromProcess) return fromProcess;

  if (!existsSync(".env.local")) return undefined;
  const file = readFileSync(".env.local", "utf8");
  const match = file.match(new RegExp(`^${key}=(.*)$`, "m"));
  const captured = match?.[1];
  if (captured === undefined) return undefined;
  return captured.trim().replace(/^["']|["']$/g, "");
}
