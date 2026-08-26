import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Phase 3 (STOR-03/STOR-06, plan 03-01): DATABASE_URL presence is the ONLY switch between local
// and cloud mode, and importing this module must never throw — even on a completely unconfigured
// machine, and even when a buyer leaves a blank-but-present cloud env line (D2-09d's
// blankAsUndefined convention). Each test dynamically imports config.ts after setting env vars,
// since the module parses process.env once at import time.

const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const ORIGINAL_BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN;

afterEach(() => {
  if (ORIGINAL_DATABASE_URL === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
  if (ORIGINAL_BLOB_TOKEN === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
  else process.env.BLOB_READ_WRITE_TOKEN = ORIGINAL_BLOB_TOKEN;
});

describe("PRODUCT_CONFIG cloud-mode derivation", () => {
  beforeEach(() => {
    delete process.env.DATABASE_URL;
    delete process.env.BLOB_READ_WRITE_TOKEN;
    vi.resetModules();
  });

  it("does not throw and yields cloudMode === false when both cloud vars are blank strings", async () => {
    process.env.DATABASE_URL = "";
    process.env.BLOB_READ_WRITE_TOKEN = "";

    const { PRODUCT_CONFIG } = await import("./config.js");

    expect(PRODUCT_CONFIG.cloudMode).toBe(false);
    expect(PRODUCT_CONFIG.storage.blobToken).toBeUndefined();
  });

  it("does not throw and yields cloudMode === false when both cloud vars are entirely absent", async () => {
    const { PRODUCT_CONFIG } = await import("./config.js");

    expect(PRODUCT_CONFIG.cloudMode).toBe(false);
    expect(PRODUCT_CONFIG.storage.blobToken).toBeUndefined();
  });

  it("yields cloudMode === true when DATABASE_URL is a non-blank value", async () => {
    process.env.DATABASE_URL = "postgres://example.invalid/db";
    process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_test_token";

    const { PRODUCT_CONFIG } = await import("./config.js");

    expect(PRODUCT_CONFIG.cloudMode).toBe(true);
    expect(PRODUCT_CONFIG.storage.blobToken).toBe("vercel_blob_rw_test_token");
  });
});
