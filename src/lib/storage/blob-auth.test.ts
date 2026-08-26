/**
 * Covers the two credential forms `@vercel/blob` accepts, and the case where neither exists.
 *
 * Why this file exists: requiring `BLOB_READ_WRITE_TOKEN` was stricter than the SDK's own
 * requirement. Vercel connects a Blob store with OIDC auth by default — `VERCEL_OIDC_TOKEN` plus
 * `BLOB_STORE_ID` — and the SDK's types state `token` is "Ignored when Vercel OIDC token is
 * available and either process.env.BLOB_STORE_ID or options.storeId is set." A correctly connected
 * store therefore authenticated fine while this module refused to start, which reached a real
 * deployment as "File storage is not configured" on a deployment where it was (03-UAT finding F2).
 *
 * These assert the DECISION (which auth is chosen, or that it throws), not a live network call —
 * `resolveAuth` runs before any SDK call, so the decision is the whole behaviour under test.
 * `vi.doMock` on the config module keeps this hermetic: nothing writes to `process.env`, per
 * `test-cloud-env.ts`'s header.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const BYTES = new TextEncoder().encode("payload");
const META = { filename: "x.txt", byteSize: BYTES.byteLength };

async function loadWithConfig(storage: { blobToken?: string; blobStoreId?: string }) {
  vi.resetModules();
  vi.doMock("../config.js", () => ({
    PRODUCT_CONFIG: { storage: { uploadDir: "./data/uploads", ...storage } },
  }));
  return import("./blob.js");
}

afterEach(() => {
  vi.doUnmock("../config.js");
  vi.resetModules();
});

describe("Blob credential resolution", () => {
  it("throws KDL-BLOB-001 when neither a read-write token nor a store id is configured", async () => {
    const { createBlobFileStorage } = await loadWithConfig({});
    await expect(createBlobFileStorage().store(BYTES, META)).rejects.toMatchObject({
      code: "KDL-BLOB-001",
    });
  });

  it("does NOT throw KDL-BLOB-001 when only BLOB_STORE_ID is set — the OIDC path", async () => {
    const { createBlobFileStorage } = await loadWithConfig({ blobStoreId: "store_synthetic_oidc" });
    // The call still fails (no real network/OIDC token in a test process) — but it must fail as a
    // WRITE failure, never as "not configured". That distinction is the entire fix: KDL-BLOB-001
    // here would mean a correctly connected store is being refused before the SDK is consulted.
    await expect(createBlobFileStorage().store(BYTES, META)).rejects.not.toMatchObject({
      code: "KDL-BLOB-001",
    });
  });

  it("uses the read-write token when one is configured", async () => {
    const { createBlobFileStorage } = await loadWithConfig({ blobToken: "vercel_blob_rw_synthetic" });
    await expect(createBlobFileStorage().store(BYTES, META)).rejects.not.toMatchObject({
      code: "KDL-BLOB-001",
    });
  });
});
