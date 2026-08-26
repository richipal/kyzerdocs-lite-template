/**
 * POST /api/blob/upload — token-exchange route for `@vercel/blob/client`'s `upload()` (STOR-06,
 * plan 03-10). This is the server half of the client-direct upload path that lets a buyer's
 * document bypass the Vercel Function's 4.5MB request body limit entirely: the browser uploads
 * straight to Blob, and this route is called only to issue a short-lived, scoped write token
 * (and, on completion, to receive a notification — unused here, since `/api/ingest` itself reads
 * the object back once the client tells it the upload finished).
 *
 * `requireAdmin` is the FIRST statement, before `handleUpload` ever runs (T-03-10-01): the token
 * this route issues grants write access to the buyer's own Blob store, so an unauthenticated
 * caller must never obtain one. This route is deliberately NOT on `audit-surface.mjs`'s
 * auth-coverage allowlist — the audit's check (a) enforces that.
 *
 * `onBeforeGenerateToken` re-runs `validateFileMetadata` against the filename/MIME/declared size
 * the client sends as its JSON `clientPayload` (T-03-10-03) — an unsupported or oversized file is
 * rejected BEFORE a token is issued, not after bytes are already sitting in the store.
 * `allowedContentTypes` is read from the SAME `SUPPORTED_FILE_TYPES` constant `validate.ts`'s own
 * check and the client-side dropzone display both use — never a second, driftable list.
 */

import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { requireAdmin, unauthorizedResponse } from "../../../../lib/auth/session.js";
import { AppError } from "../../../../lib/errors.js";
import { canMintClientUploadTokens } from "../../../../lib/storage/blob-auth.js";
import { SUPPORTED_FILE_TYPES, validateFileMetadata, MAX_UPLOAD_BYTES } from "../../../../lib/ingest/validate.js";

const ALLOWED_CONTENT_TYPES = Object.keys(SUPPORTED_FILE_TYPES.documents);

interface UploadClientPayload {
  filename: string;
  mimeType?: string;
  byteSize: number;
}

function parseClientPayload(clientPayload: string | null): UploadClientPayload {
  if (!clientPayload) {
    throw new AppError("KDL-UPLOAD-001", { message: "No upload metadata was provided." });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(clientPayload);
  } catch {
    throw new AppError("KDL-UPLOAD-001", { message: "Upload metadata was malformed." });
  }
  const candidate = parsed as Partial<UploadClientPayload>;
  if (typeof candidate.filename !== "string" || typeof candidate.byteSize !== "number") {
    throw new AppError("KDL-UPLOAD-001", { message: "Upload metadata was malformed." });
  }
  return {
    filename: candidate.filename,
    mimeType: typeof candidate.mimeType === "string" ? candidate.mimeType : undefined,
    byteSize: candidate.byteSize,
  };
}

export async function POST(req: Request): Promise<Response> {
  try {
    await requireAdmin(req);
  } catch (err) {
    if (err instanceof AppError) return unauthorizedResponse(err);
    throw err;
  }

  // Fail with the actionable code BEFORE handleUpload() surfaces its own generic
  // "No read-write token found" through KDL-INGEST-001, which tells a buyer to check the document
  // status for a problem that is really a missing deployment credential.
  if (!canMintClientUploadTokens()) {
    const err = new AppError("KDL-BLOB-005");
    return Response.json(err.toJSON(), { status: 503 });
  }

  const body = (await req.json()) as HandleUploadBody;

  try {
    const jsonResponse = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async (_pathname, clientPayload) => {
        const meta = parseClientPayload(clientPayload);
        // Same validator, same accepted-type/size source of truth the local-mode /api/ingest
        // path and the client-side dropzone display both use — an unsupported or oversized file
        // is rejected here before a token is ever issued.
        validateFileMetadata(meta);

        return {
          allowedContentTypes: ALLOWED_CONTENT_TYPES,
          maximumSizeInBytes: MAX_UPLOAD_BYTES,
          addRandomSuffix: false,
          allowOverwrite: false,
        };
      },
    });

    return Response.json(jsonResponse);
  } catch (err) {
    if (err instanceof AppError) {
      return Response.json(err.toJSON(), { status: 400 });
    }
    const generic = new AppError("KDL-INGEST-001", {
      message: err instanceof Error ? err.message : "The upload token request failed.",
    });
    return Response.json(generic.toJSON(), { status: 500 });
  }
}
