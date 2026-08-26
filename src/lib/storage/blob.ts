/**
 * BlobFileStorage — the cloud-mode `FileStorage` implementation (STOR-06, plan 03-10), over the
 * buyer's Vercel Blob store. Mirrors `LocalFileStorage`'s (`./files.ts`) security properties
 * exactly: the storage key is `randomUUID()` plus the filename's extension ONLY — the buyer's
 * filename is display metadata and nothing else — and `contentHash` is the SHA-256 hex digest of
 * the same bytes, computed with the same call, so a document re-uploaded after a mode switch is
 * still detected as a re-upload (ING-06).
 *
 * The store is PRIVATE — verified live against the real, already-provisioned store
 * (`03-RESEARCH.md`'s "Live cloud verification" section): `access: "public"` THROWS against it.
 * Private is correct and is not "fixed" here: the objects behind this module are the buyer's own
 * manuals, policies and FAQs. `read()` therefore uses `get(pathname, { access: "private" })`,
 * which returns a STREAM (`{ stream, headers, blob }`), never a durable public URL — this module
 * is the only place that stream is consumed, and it is never handed to a browser or the widget.
 *
 * Error codes: `KDL-BLOB-001` — no `BLOB_READ_WRITE_TOKEN` configured (deployment incomplete).
 * `KDL-BLOB-002` — a write (`put()`) failed. `KDL-BLOB-003` — a read-back (`get()`) failed,
 * distinct from a write failure per the registry's own doc comment (`../errors.ts`). `delete` is
 * idempotent — deleting an already-absent object never throws, matching `LocalFileStorage`'s
 * semantics — so a `del()` failure (including "not found") is swallowed rather than re-thrown.
 *
 * `createBlobFileStorage(tokenOverride?)` — the exported `BlobFileStorage` singleton reads
 * `PRODUCT_CONFIG.storage.blobToken` (production behavior). `file-storage.test.ts`'s live
 * conformance arm passes a token read via `readCloudTestEnv("BLOB_READ_WRITE_TOKEN")` explicitly
 * instead, matching `driver-conformance.test.ts`'s pattern of constructing an instance directly
 * rather than mutating `process.env` — `test-cloud-env.ts`'s header explains why that mutation is
 * unsafe (worker-thread reuse can leak a live credential into an unrelated test file).
 */

import { createHash, randomUUID } from "node:crypto";
import { extname } from "node:path";
import { del, get, put } from "@vercel/blob";
import { PRODUCT_CONFIG } from "../config.js";
import { AppError } from "../errors.js";
import type { FileMeta } from "../ingest/types.js";
import type { FileStorage } from "./file-storage.js";

/** All objects this implementation writes live under this prefix, distinct from
 * `vector-snapshots/` (plan 03-07) — two independent object families in the same store. */
const UPLOAD_PREFIX = "uploads";

/** Builds a `FileStorage` over `@vercel/blob`. `tokenOverride` defaults to
 * `PRODUCT_CONFIG.storage.blobToken` (production) — pass it explicitly only for a live test arm
 * that must never write to `process.env` (see this file's header). */
export function createBlobFileStorage(tokenOverride?: string): FileStorage {
  function requireToken(): string {
    const token = tokenOverride ?? PRODUCT_CONFIG.storage.blobToken;
    if (!token) {
      throw new AppError("KDL-BLOB-001");
    }
    return token;
  }

  async function store(bytes: Uint8Array, meta: FileMeta): Promise<{ storagePath: string; contentHash: string }> {
    const token = requireToken();
    const ext = extname(meta.filename).toLowerCase();
    const pathname = `${UPLOAD_PREFIX}/${randomUUID()}${ext}`;
    const contentHash = createHash("sha256").update(bytes).digest("hex");

    try {
      await put(pathname, Buffer.from(bytes), {
        access: "private",
        token,
        addRandomSuffix: false,
        contentType: meta.mimeType || "application/octet-stream",
      });
    } catch (cause) {
      throw new AppError("KDL-BLOB-002", { cause });
    }

    return { storagePath: pathname, contentHash };
  }

  async function read(storagePath: string): Promise<Buffer> {
    const token = requireToken();
    try {
      const got = await get(storagePath, { access: "private", token });
      if (!got || !got.stream) {
        throw new Error(`no object found at pathname: ${storagePath}`);
      }
      const arrayBuffer = await new Response(got.stream).arrayBuffer();
      return Buffer.from(arrayBuffer);
    } catch (cause) {
      throw new AppError("KDL-BLOB-003", { cause });
    }
  }

  async function deleteObject(storagePath: string): Promise<void> {
    const token = requireToken();
    try {
      await del(storagePath, { token });
    } catch {
      // Idempotent — matches LocalFileStorage#delete's semantics: deleting an already-absent
      // object (or one that fails to delete for any other reason) is never an error here.
    }
  }

  return { store, read, delete: deleteObject };
}

export const BlobFileStorage: FileStorage = createBlobFileStorage();
