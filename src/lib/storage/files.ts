/**
 * Upload persistence (ING-02/06, T-02-05-01). Bytes are written under
 * `PRODUCT_CONFIG.paths.uploadDir` at a path built from `crypto.randomUUID()` plus the file's
 * extension — the buyer-supplied filename is NEVER used as a path component, only as display
 * metadata stored in the `documents` row (see `validate.ts`'s trust-boundary note: a filename is
 * attacker-controlled input, and `"../../evil.pdf"` must never escape the upload directory).
 *
 * `readUpload`/`deleteUpload` re-assert the resolved path stays inside `uploadDir` before
 * touching the filesystem — defense in depth even though `storeUpload`'s own UUID-based path
 * construction cannot itself be tricked into traversal (the filename is never concatenated into
 * the path, only its extension, and `path.extname` is traversal-safe by construction).
 *
 * Plan 03-10 (STOR-06): the three functions below are also exposed as `LocalFileStorage`, the
 * local-mode implementation of `./file-storage.ts`'s `FileStorage` interface — the free functions
 * stay exported unchanged so nothing that imports them today breaks (this file is the Private
 * tier's upload path, already sold, and must not regress).
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { PRODUCT_CONFIG } from "../config.js";
import { AppError } from "../errors.js";
import type { FileMeta } from "../ingest/types.js";
import type { FileStorage } from "./file-storage.js";

function resolveUploadDir(): string {
  return resolve(PRODUCT_CONFIG.paths.uploadDir);
}

/** Resolves `path` and asserts the result stays inside the upload directory. Throws
 * `KDL-UPLOAD-001` rather than silently truncating or reading/writing outside `uploadDir`
 * (T-02-05-01) — a path that resolves outside is treated the same as an unsupported upload. */
function assertInsideUploadDir(path: string): string {
  const uploadDir = resolveUploadDir();
  const resolved = resolve(path);
  if (resolved !== uploadDir && !resolved.startsWith(uploadDir + sep)) {
    throw new AppError("KDL-UPLOAD-001", {
      message: "Resolved upload path escapes the configured upload directory.",
    });
  }
  return resolved;
}

/**
 * Writes `bytes` to a server-generated path under `uploadDir` and returns that path plus a
 * SHA-256 `contentHash` of the bytes (ING-06's re-upload detection key). The buyer's filename is
 * only consulted for its extension — `extname()` operates on the final path segment, so it is
 * traversal-safe even for a filename like `"../../evil.pdf"` (the UUID basename is what actually
 * lands on disk, never the buyer's string).
 */
export async function storeUpload(
  bytes: Uint8Array,
  meta: FileMeta,
): Promise<{ storagePath: string; contentHash: string }> {
  const uploadDir = resolveUploadDir();
  await mkdir(uploadDir, { recursive: true });

  const ext = extname(meta.filename).toLowerCase();
  const basename = `${randomUUID()}${ext}`;
  const storagePath = assertInsideUploadDir(resolve(uploadDir, basename));

  const contentHash = createHash("sha256").update(bytes).digest("hex");
  await writeFile(storagePath, bytes);

  return { storagePath, contentHash };
}

/** Reads a previously stored upload's bytes. Throws (never reads) if `storagePath` resolves
 * outside `uploadDir` — this is the read-side half of T-02-05-01's mitigation. */
export async function readUpload(storagePath: string): Promise<Uint8Array> {
  const resolved = assertInsideUploadDir(storagePath);
  // `readFile` resolves a `Buffer`; the copy into a plain `Uint8Array` is what the interface
  // promises and what pdf.js requires — see `file-storage.ts`'s note on `read()`.
  return new Uint8Array(await readFile(resolved));
}

/** Deletes a previously stored upload. Idempotent — deleting an already-absent file is not an
 * error, matching `deleteDocument`'s own "delete cascades, missing is fine" semantics. Throws
 * (never deletes) if `storagePath` resolves outside `uploadDir`. */
export async function deleteUpload(storagePath: string): Promise<void> {
  const resolved = assertInsideUploadDir(storagePath);
  await rm(resolved, { force: true });
}

/** Local-mode `FileStorage` — the three functions above, exposed under the shared interface so
 * `./index.ts#getFileStorage()` can select between this and `./blob.ts#BlobFileStorage` behind
 * one seam. Identical behavior to calling the free functions directly. */
export const LocalFileStorage: FileStorage = {
  store: storeUpload,
  read: readUpload,
  delete: deleteUpload,
};
