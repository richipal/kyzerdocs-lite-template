/**
 * Covers `resolveBlobAuth` — the single decision point for how this deployment authenticates to
 * Vercel Blob — and the two consumers whose failure modes differ.
 *
 * Why this file exists: the token check was duplicated across four modules and each tested only for
 * `BLOB_READ_WRITE_TOKEN`, a precondition stricter than the SDK's own. Vercel connects a Blob store
 * with OIDC by default (`VERCEL_OIDC_TOKEN` + `BLOB_STORE_ID`), and `@vercel/blob` ignores `token`
 * entirely in that mode. On a real deployment that produced a loud failure (KDL-BLOB-001 on upload
 * and in /api/health) and a SILENT one: `vector-snapshot` no-opped every read and write, leaving
 * DELIV-06's cold-start mitigation inert with no error anywhere. The silent case is why
 * `isBlobConfigured()` is asserted separately — a regression there produces no symptom at all.
 *
 * `vi.doMock` on the config module keeps these hermetic: nothing writes to `process.env`, per
 * `test-cloud-env.ts`'s header.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

async function withConfig(storage: { blobToken?: string; blobStoreId?: string }) {
  vi.resetModules();
  vi.doMock("../config.js", () => ({
    PRODUCT_CONFIG: { storage: { uploadDir: "./data/uploads", ...storage } },
  }));
  return {
    auth: await import("./blob-auth.js"),
    blob: await import("./blob.js"),
  };
}

afterEach(() => {
  vi.doUnmock("../config.js");
  vi.resetModules();
});

describe("resolveBlobAuth", () => {
  it("returns null when neither credential form is present", async () => {
    const { auth } = await withConfig({});
    expect(auth.resolveBlobAuth()).toBeNull();
    expect(auth.isBlobConfigured()).toBe(false);
  });

  it("returns the read-write token when one is configured", async () => {
    const { auth } = await withConfig({ blobToken: "vercel_blob_rw_synthetic" });
    expect(auth.resolveBlobAuth()).toEqual({ token: "vercel_blob_rw_synthetic" });
    expect(auth.isBlobConfigured()).toBe(true);
  });

  it("returns EMPTY auth — not null — when only BLOB_STORE_ID is set (the OIDC path)", async () => {
    const { auth } = await withConfig({ blobStoreId: "store_synthetic_oidc" });
    // `{}` and `null` are the distinction the whole fix rests on: `{}` means "configured, the SDK
    // resolves OIDC itself", `null` means "no credentials at all". Collapsing them is the bug.
    expect(auth.resolveBlobAuth()).toEqual({});
    expect(auth.isBlobConfigured()).toBe(true);
  });

  it("prefers an explicit override over both", async () => {
    const { auth } = await withConfig({ blobToken: "from_config", blobStoreId: "store_x" });
    expect(auth.resolveBlobAuth("explicit_override")).toEqual({ token: "explicit_override" });
  });
});

describe("consumers of resolveBlobAuth", () => {
  const BYTES = new TextEncoder().encode("payload");
  const META = { filename: "x.txt", byteSize: BYTES.byteLength };

  it("upload throws KDL-BLOB-001 only when genuinely unconfigured", async () => {
    const { blob } = await withConfig({});
    await expect(blob.createBlobFileStorage().store(BYTES, META)).rejects.toMatchObject({
      code: "KDL-BLOB-001",
    });
  });

  it("upload does NOT throw KDL-BLOB-001 on the OIDC path", async () => {
    const { blob } = await withConfig({ blobStoreId: "store_synthetic_oidc" });
    // It still fails — there is no real OIDC token in a test process — but as a WRITE failure.
    // KDL-BLOB-001 here would mean a connected store is being refused before the SDK is consulted.
    await expect(blob.createBlobFileStorage().store(BYTES, META)).rejects.not.toMatchObject({
      code: "KDL-BLOB-001",
    });
  });

  it("the snapshot cache treats the OIDC path as configured, not as absent", async () => {
    // The silent regression: vector-snapshot returns early when unconfigured, by design. If OIDC
    // reads as unconfigured, every snapshot read and write no-ops and DELIV-06's mitigation is
    // permanently inert with NO error raised anywhere — nothing else in the suite would catch it.
    const { auth } = await withConfig({ blobStoreId: "store_synthetic_oidc" });
    expect(auth.resolveBlobAuth()).not.toBeNull();
  });
});
