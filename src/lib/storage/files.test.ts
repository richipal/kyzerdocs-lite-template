import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// PRODUCT_CONFIG (imported transitively by files.ts) reads UPLOAD_DIR from process.env exactly
// once, at first module load, and is deep-frozen thereafter (config.ts) — so the env override
// must land before files.ts's module graph is first evaluated, and stays fixed for the rest of
// this file's run. Same top-level-await-after-env-set pattern as gemini.test.ts.
const uploadDir = mkdtempSync(join(tmpdir(), "kdl-uploads-test-"));
process.env.UPLOAD_DIR = uploadDir;

const { storeUpload, readUpload, deleteUpload } = await import("./files.js");

afterAll(() => {
  delete process.env.UPLOAD_DIR;
  rmSync(uploadDir, { recursive: true, force: true });
});

const UUID_BASENAME_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pdf$/i;

describe("storage/files — storeUpload/readUpload/deleteUpload", () => {
  it("storeUpload writes under uploadDir at a server-generated UUID path, never the buyer's filename", async () => {
    const bytes = new TextEncoder().encode("hello world");
    const { storagePath, contentHash } = await storeUpload(bytes, {
      filename: "my report.pdf",
      byteSize: bytes.byteLength,
    });

    expect(storagePath.startsWith(resolve(uploadDir))).toBe(true);
    expect(storagePath).not.toContain("my report");
    expect(contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("path-traversal filename: '../../evil.pdf' still lands inside uploadDir with a UUID basename", async () => {
    const bytes = new TextEncoder().encode("payload");
    const { storagePath } = await storeUpload(bytes, {
      filename: "../../evil.pdf",
      byteSize: bytes.byteLength,
    });

    expect(storagePath.startsWith(resolve(uploadDir) + "/")).toBe(true);
    const basename = storagePath.slice(storagePath.lastIndexOf("/") + 1);
    expect(basename).toMatch(UUID_BASENAME_RE);

    // No file was created outside uploadDir — walk up two levels and confirm no "evil.pdf" exists.
    const parentDir = resolve(uploadDir, "..", "..");
    const escaped = (() => {
      try {
        return readdirSync(parentDir).includes("evil.pdf");
      } catch {
        return false;
      }
    })();
    expect(escaped).toBe(false);
  });

  it("readUpload round-trips the exact bytes written by storeUpload", async () => {
    const original = new TextEncoder().encode("round trip content");
    const { storagePath } = await storeUpload(original, {
      filename: "doc.txt",
      byteSize: original.byteLength,
    });

    const readBack = await readUpload(storagePath);
    expect(Buffer.from(readBack).equals(Buffer.from(original))).toBe(true);
  });

  it("readUpload throws (never reads) for a crafted path escaping uploadDir via '../'", async () => {
    const crafted = resolve(uploadDir, "..", "..", "..", "etc", "passwd");
    await expect(readUpload(crafted)).rejects.toThrow();
  });

  it("deleteUpload removes the file; deleting an already-absent file does not throw", async () => {
    const bytes = new TextEncoder().encode("to be deleted");
    const { storagePath } = await storeUpload(bytes, {
      filename: "gone.txt",
      byteSize: bytes.byteLength,
    });

    await expect(readUpload(storagePath)).resolves.toBeDefined();
    await deleteUpload(storagePath);
    await expect(readUpload(storagePath)).rejects.toThrow();

    // Idempotent: deleting again does not throw.
    await expect(deleteUpload(storagePath)).resolves.toBeUndefined();
  });

  it("deleteUpload throws (never deletes) for a crafted path escaping uploadDir", async () => {
    const crafted = resolve(uploadDir, "..", "..", "escape.txt");
    await expect(deleteUpload(crafted)).rejects.toThrow();
  });
});
