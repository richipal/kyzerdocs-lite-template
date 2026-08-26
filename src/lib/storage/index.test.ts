import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `getStorageDriver()`'s mode switch (STOR-03, D3-16): `DATABASE_URL` presence is the ONLY thing
 * that decides which concrete `StorageDriver` the singleton getter constructs. `PRODUCT_CONFIG`
 * (`src/lib/config.ts`) snapshots `process.env` once at module-import time, so each case here
 * mutates `process.env.DATABASE_URL` and calls `vi.resetModules()` BEFORE importing — re-running
 * that snapshot fresh for each case, rather than relying on a stale cached config module.
 *
 * `DATABASE_PATH` is pointed at a throwaway temp directory for the local-mode cases (same
 * convention as `sqlite.test.ts`/`health/route.test.ts`) so this suite never opens or writes the
 * product's real default `./data/kyzerdocs.db` file.
 */
describe("storage/index — getStorageDriver mode switch", () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalDatabasePath = process.env.DATABASE_PATH;
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "kdl-storage-index-test-"));
    process.env.DATABASE_PATH = join(testDir, "test.db");
    vi.resetModules();
  });

  afterEach(() => {
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
    if (originalDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = originalDatabasePath;
    }
    rmSync(testDir, { recursive: true, force: true });
    vi.resetModules();
  });

  it("returns a SqliteStorageDriver when DATABASE_URL is unset", async () => {
    delete process.env.DATABASE_URL;
    const { getStorageDriver } = await import("./index.js");
    const { SqliteStorageDriver } = await import("./sqlite.js");

    const driver = getStorageDriver();
    expect(driver).toBeInstanceOf(SqliteStorageDriver);
  });

  it("returns the same singleton instance across repeated calls (local mode)", async () => {
    delete process.env.DATABASE_URL;
    const { getStorageDriver } = await import("./index.js");

    expect(getStorageDriver()).toBe(getStorageDriver());
  });

  it("returns a PgStorageDriver when DATABASE_URL is set — never opens a connection at import time", async () => {
    // A syntactically valid Neon-shaped connection string. No network call happens here —
    // getStorageDriver()/createPgClient() build the Drizzle handle lazily; the first real
    // connection attempt only happens on the first query, matching the "no eager connection at
    // import time" invariant this module's own doc comment states.
    process.env.DATABASE_URL = "postgresql://user:pass@ep-test-12345.us-east-1.aws.neon.tech/neondb";
    const { getStorageDriver } = await import("./index.js");
    const { PgStorageDriver } = await import("./postgres.js");

    const driver = getStorageDriver();
    expect(driver).toBeInstanceOf(PgStorageDriver);
  });
});
