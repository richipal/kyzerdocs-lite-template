/**
 * One behavioral suite, run against BOTH `FileStorage` implementations (STOR-06, plan 03-10),
 * mirroring `driver-conformance.test.ts`'s (03-05) shape: the local arm always runs (a fresh temp
 * directory per suite run); the Blob arm runs against the real, already-provisioned PRIVATE
 * Vercel Blob store when `BLOB_READ_WRITE_TOKEN` is available (`readCloudTestEnv` — never
 * mutates `process.env`, see `test-cloud-env.ts`'s header for why that matters), and reports an
 * explicit skip (not a failure) otherwise — this worktree has no `.env.local`, so the Blob arm is
 * expected to skip here; the orchestrator verifies it live after merge.
 *
 * Every case asserts the CONTRACT both implementations must share: byte-exact round trips, a
 * server-generated key that never leaks the buyer's filename (T-03-10-02), identical
 * `contentHash` computation (the actual ING-06-across-a-mode-switch protection), and idempotent
 * delete.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import type { FileStorage } from "./file-storage.js";
import { readCloudTestEnv } from "./test-cloud-env.js";

const localUploadDir = mkdtempSync(join(tmpdir(), "kdl-file-storage-test-"));
process.env.UPLOAD_DIR = localUploadDir;

const { LocalFileStorage } = await import("./files.js");
const { createBlobFileStorage } = await import("./blob.js");

afterAll(() => {
  delete process.env.UPLOAD_DIR;
  rmSync(localUploadDir, { recursive: true, force: true });
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Arm {
  name: string;
  storage: FileStorage;
}

const blobToken = readCloudTestEnv("BLOB_READ_WRITE_TOKEN");

const arms: Arm[] = [{ name: "local", storage: LocalFileStorage }];
if (blobToken) {
  arms.push({ name: "blob", storage: createBlobFileStorage(blobToken) });
} else {
  console.log("  SKIP  file-storage.test.ts blob arm — BLOB_READ_WRITE_TOKEN not found (process.env or .env.local)");
}

describe.each(arms)("FileStorage conformance ($name)", ({ storage }) => {
  it("store/read round-trips bytes exactly", async () => {
    const original = new TextEncoder().encode("round trip content, exact bytes");
    const { storagePath } = await storage.store(original, { filename: "doc.txt", byteSize: original.byteLength });

    const readBack = await storage.read(storagePath);
    expect(Buffer.from(readBack).equals(Buffer.from(original))).toBe(true);

    // The type matters as much as the contents, and this assertion exists because the contents
    // check above CANNOT catch what actually broke. `Buffer` extends `Uint8Array`, so a `Buffer`
    // return passes every byte comparison here — `Buffer.from()` on both sides normalises the very
    // difference under test — while `unpdf`/pdf.js rejects it with "Please provide binary data as
    // `Uint8Array`, rather than `Buffer`." That shipped: every PDF upload failed on a deployment
    // as "may be unreadable or corrupt" while local ingestion stayed green, because local mode
    // parses straight from the request and never reads back through this interface (03-UAT F6).
    expect(readBack).toBeInstanceOf(Uint8Array);
    expect(Buffer.isBuffer(readBack)).toBe(false);

    await storage.delete(storagePath);
  });

  it("storagePath contains no part of the supplied filename other than its extension", async () => {
    const bytes = new TextEncoder().encode("payload");
    const { storagePath } = await storage.store(bytes, {
      filename: "my confidential report.pdf",
      byteSize: bytes.byteLength,
    });

    expect(storagePath.toLowerCase()).not.toContain("confidential");
    expect(storagePath.toLowerCase()).not.toContain("report");
    expect(storagePath.endsWith(".pdf")).toBe(true);

    await storage.delete(storagePath);
  });

  it("path-traversal filename '../../evil.pdf' yields a storagePath containing neither '..' nor 'evil'", async () => {
    const bytes = new TextEncoder().encode("payload");
    const { storagePath } = await storage.store(bytes, { filename: "../../evil.pdf", byteSize: bytes.byteLength });

    expect(storagePath).not.toContain("..");
    expect(storagePath.toLowerCase()).not.toContain("evil");
    expect(storagePath.endsWith(".pdf")).toBe(true);

    await storage.delete(storagePath);
  });

  it("the generated key's basename (sans extension) is a UUID", async () => {
    const bytes = new TextEncoder().encode("payload");
    const { storagePath } = await storage.store(bytes, { filename: "anything.txt", byteSize: bytes.byteLength });

    const basename = storagePath.slice(storagePath.lastIndexOf("/") + 1);
    const withoutExt = basename.replace(/\.txt$/i, "");
    expect(withoutExt).toMatch(UUID_RE);

    await storage.delete(storagePath);
  });

  it("deleting twice does not throw", async () => {
    const bytes = new TextEncoder().encode("to be deleted twice");
    const { storagePath } = await storage.store(bytes, { filename: "gone.txt", byteSize: bytes.byteLength });

    await expect(storage.delete(storagePath)).resolves.toBeUndefined();
    await expect(storage.delete(storagePath)).resolves.toBeUndefined();
  });
});

describe("FileStorage conformance — contentHash agreement across implementations", () => {
  it.runIf(blobToken !== undefined)(
    "identical bytes produce identical contentHash in both LocalFileStorage and BlobFileStorage",
    async () => {
      const bytes = new TextEncoder().encode("the exact same bytes, hashed by both implementations");
      const meta = { filename: "shared.txt", byteSize: bytes.byteLength };

      const localResult = await LocalFileStorage.store(bytes, meta);
      const blobStorage = createBlobFileStorage(blobToken);
      const blobResult = await blobStorage.store(bytes, meta);

      // The actual ING-06-across-a-mode-switch assertion: both implementations compute SHA-256
      // over the same bytes the same way, so a re-upload after a mode switch is still detected.
      expect(localResult.contentHash).toBe(blobResult.contentHash);
      expect(localResult.contentHash).toMatch(/^[0-9a-f]{64}$/);

      await LocalFileStorage.delete(localResult.storagePath);
      await blobStorage.delete(blobResult.storagePath);
    },
  );

  it.skipIf(blobToken !== undefined)(
    "SKIPPED — BLOB_READ_WRITE_TOKEN not found (process.env or .env.local); Blob-arm contentHash agreement not exercised here",
    () => {
      expect(true).toBe(true);
    },
  );
});

describe("BlobFileStorage — no token configured", () => {
  it("store throws AppError KDL-BLOB-001 when no token is available", async () => {
    // Only meaningful when PRODUCT_CONFIG.storage.blobToken is ALSO absent for this process —
    // true by construction in this worktree (no .env.local) and in any CI run that doesn't
    // explicitly export BLOB_READ_WRITE_TOKEN into process.env before this module first loads.
    if (process.env.BLOB_READ_WRITE_TOKEN) {
      console.log("  SKIP  no-token case — BLOB_READ_WRITE_TOKEN is present in this process's env");
      return;
    }

    const noTokenStorage = createBlobFileStorage(undefined);
    const bytes = new TextEncoder().encode("payload");

    await expect(
      noTokenStorage.store(bytes, { filename: "x.txt", byteSize: bytes.byteLength }),
    ).rejects.toBeInstanceOf(AppError);
    await expect(
      noTokenStorage.store(bytes, { filename: "x.txt", byteSize: bytes.byteLength }),
    ).rejects.toMatchObject({ code: "KDL-BLOB-001" });
  });
});
