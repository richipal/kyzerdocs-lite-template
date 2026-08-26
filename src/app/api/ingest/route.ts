/**
 * POST /api/ingest — ING-01/02/03 upload endpoint. `requireAdmin()` is the first statement
 * (ADMIN-02): a direct `curl` with no session cookie is rejected here regardless of what
 * `src/proxy.ts`'s page-navigation redirect does. Rejects an unsupported/oversized/empty file
 * (ING-01) BEFORE writing anything to the database, creates the `documents`/`ingest_jobs` rows,
 * and `await`s the full pipeline in-request (ARCHITECTURE.md Pattern 2 — no queue, no fire-and-
 * forget). Resolves and returns `{ jobId, documentId, status }` whether the pipeline reached
 * `ready` or a classified `failed` state — the client polls `GET /api/ingest/[jobId]` for detail,
 * so an ordinary ingestion failure is not a 500.
 *
 * BYTE ACQUISITION BRANCHES ON `cloudMode` (plan 03-10, STOR-06) AND NOTHING ELSE DOES. A Vercel
 * Function's request body is capped at 4.5MB [CONFIRMED: official Vercel docs,
 * `FUNCTION_PAYLOAD_TOO_LARGE`] — reading the whole upload out of `req.formData()` (the local-mode
 * path below) would return 413 for any document over ~4.5MB the moment this app deploys to
 * Vercel, with no code change needed to trigger it. Local mode is unaffected (no such platform
 * limit) and its `req.formData()` path is byte-for-byte unchanged from before this plan.
 *
 * In cloud mode the request body instead carries a BLOB REFERENCE — the pathname and declared
 * metadata `@vercel/blob/client`'s `upload()` returned to the browser after writing the bytes
 * DIRECTLY to Blob (never through this Function's body) — and this route reads them back through
 * `getFileStorage().read(...)`, which resolves against the server's OWN configured store using
 * its own token, never an arbitrary caller-supplied URL (T-03-10-06). From `validateFileMetadata`
 * onward the code is identical in both branches: same `insertDocument`, same `createJob`, same
 * awaited `runIngestion`, same response shape.
 *
 * Honest limit, recorded per this plan's own output spec: reading the bytes back into the
 * Function for parsing still means the file must fit in the Function's memory — a different, much
 * larger ceiling than the 4.5MB body cap, but a ceiling nonetheless. `validateFileMetadata`'s
 * `MAX_UPLOAD_BYTES` (100MB, `src/lib/ingest/validate.ts`) is what actually bounds this upload in
 * either mode; this restructure removes the 4.5MB body wall, not every size limit.
 */

import { AppError } from "../../../lib/errors.js";
import { requireAdmin, unauthorizedResponse } from "../../../lib/auth/session.js";
import { PRODUCT_CONFIG } from "../../../lib/config.js";
import { createHash } from "node:crypto";
import { runIngestion } from "../../../lib/ingest/pipeline.js";
import { validateFileMetadata } from "../../../lib/ingest/validate.js";
import { storeUpload } from "../../../lib/storage/files.js";
import { getFileStorage, getStorageDriver } from "../../../lib/storage/index.js";
import { DEFAULT_KB_ID } from "../../../lib/types.js";

/** Maps an `AppError`'s code family to the HTTP status this route reports it under. Every
 * response body is `AppError.toJSON()` only — code, message, action — never a stack trace or a
 * raw parser/provider error (T-02-05-06). */
function statusForCode(code: string): number {
  if (code === "KDL-AUTH-003") return 401;
  if (code.startsWith("KDL-UPLOAD-")) return 400;
  return 500;
}

function errorResponse(err: unknown): Response {
  if (err instanceof AppError) {
    return Response.json(err.toJSON(), { status: statusForCode(err.code) });
  }
  const generic = new AppError("KDL-INGEST-001", {
    message: err instanceof Error ? err.message : "An unexpected error occurred.",
  });
  return Response.json(generic.toJSON(), { status: 500 });
}

/** What both byte-acquisition branches produce — everything from `insertDocument` onward reads
 * only this shape, never the request itself, so that code path is identical regardless of mode. */
interface AcquiredUpload {
  filename: string;
  /** Raw, as declared by the caller — may be an empty string. Mirrors the pre-restructure
   * behavior of passing `file.type` straight through to `runIngestion`'s `meta` unmodified;
   * defaulting to `"application/octet-stream"` happens only at the `insertDocument` call below. */
  mimeType: string;
  byteSize: number;
  bytes: Uint8Array;
  storagePath: string;
  contentHash: string;
}

/** Local mode — unchanged from before this plan. Reads `multipart/form-data`, validates BEFORE
 * any bytes are read into memory or written to disk (ING-01), and stores through
 * `storeUpload` (the same function `LocalFileStorage.store` wraps, `src/lib/storage/files.ts`). */
async function acquireLocalUpload(req: Request): Promise<AcquiredUpload> {
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    throw new AppError("KDL-UPLOAD-001", { message: "No file field was present in the upload." });
  }

  const byteSize = file.size;
  validateFileMetadata({ filename: file.name, mimeType: file.type, byteSize });

  const bytes = new Uint8Array(await file.arrayBuffer());
  const { storagePath, contentHash } = await storeUpload(bytes, { filename: file.name, byteSize });

  return { filename: file.name, mimeType: file.type, byteSize, bytes, storagePath, contentHash };
}

/** Cloud mode's request body carries a blob reference — the pathname `@vercel/blob/client`'s
 * `upload()` returned to the browser after writing bytes DIRECTLY to Blob — never the file
 * itself, so `req.formData()`/`req.arrayBuffer()` are never called on this branch. */
interface BlobReferenceBody {
  pathname: string;
  filename: string;
  mimeType?: string;
  byteSize: number;
}

function parseBlobReferenceBody(value: unknown): BlobReferenceBody {
  const candidate = value as Partial<BlobReferenceBody> | null;
  if (
    !candidate ||
    typeof candidate.pathname !== "string" ||
    typeof candidate.filename !== "string" ||
    typeof candidate.byteSize !== "number"
  ) {
    throw new AppError("KDL-UPLOAD-001", { message: "The blob reference in the request body was malformed." });
  }
  return {
    pathname: candidate.pathname,
    filename: candidate.filename,
    mimeType: typeof candidate.mimeType === "string" ? candidate.mimeType : undefined,
    byteSize: candidate.byteSize,
  };
}

/** Cloud mode. Validates the SAME way local mode does (T-03-10-03's `/api/blob/upload` gate is
 * defense at token-issue time; this is the second, identical check before a documents row is
 * created), then reads the bytes back through `getFileStorage().read(...)` — resolved against the
 * server's OWN configured Blob store using its own token, never a caller-supplied URL
 * (T-03-10-06). `req.formData()` is never called on this branch — asserted by
 * `route.test.ts`'s spy. */
async function acquireCloudUpload(req: Request): Promise<AcquiredUpload> {
  const body = parseBlobReferenceBody(await req.json());
  const mimeType = body.mimeType ?? "";
  validateFileMetadata({ filename: body.filename, mimeType: body.mimeType, byteSize: body.byteSize });

  const bytes = await getFileStorage().read(body.pathname);
  const contentHash = createHash("sha256").update(bytes).digest("hex");

  return { filename: body.filename, mimeType, byteSize: body.byteSize, bytes, storagePath: body.pathname, contentHash };
}

export async function POST(req: Request): Promise<Response> {
  try {
    await requireAdmin(req);
  } catch (err) {
    if (err instanceof AppError) return unauthorizedResponse(err);
    throw err;
  }

  try {
    // The ONLY branch in this route (see header comment) — everything below reads only the
    // `AcquiredUpload` shape both arms produce, never the request itself again.
    const upload = PRODUCT_CONFIG.cloudMode ? await acquireCloudUpload(req) : await acquireLocalUpload(req);

    const driver = getStorageDriver();
    const document = await driver.insertDocument({
      knowledgeBaseId: DEFAULT_KB_ID,
      filename: upload.filename,
      mimeType: upload.mimeType || "application/octet-stream",
      byteSize: upload.byteSize,
      contentHash: upload.contentHash,
      storagePath: upload.storagePath,
    });
    const job = await driver.createJob({ knowledgeBaseId: DEFAULT_KB_ID, documentId: document.id });

    await runIngestion(
      {
        kbId: DEFAULT_KB_ID,
        documentId: document.id,
        jobId: job.id,
        bytes: upload.bytes,
        meta: { filename: upload.filename, mimeType: upload.mimeType, byteSize: upload.byteSize },
      },
      { driver },
    );

    const finalJob = await driver.getJob(job.id);
    return Response.json(
      { jobId: job.id, documentId: document.id, status: finalJob?.status ?? "failed" },
      { status: 200 },
    );
  } catch (err) {
    return errorResponse(err);
  }
}
