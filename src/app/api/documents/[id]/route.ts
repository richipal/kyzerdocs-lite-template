/**
 * DELETE /api/documents/[id] — ING-05. `deleteDocument` cascades chunks and `chunks_fts` rows and
 * bumps the RET-02 generation counter (storage driver, plan 02-02); this route additionally
 * removes the uploaded file from disk so a delete cleans up both the database and the filesystem.
 * Deleting an unknown id is a 404, not a 204 — a buyer's client should be able to tell "already
 * gone" apart from "gone now".
 */

import { requireAdmin, unauthorizedResponse } from "../../../../lib/auth/session.js";
import { AppError } from "../../../../lib/errors.js";
import { getFileStorage, getStorageDriver } from "../../../../lib/storage/index.js";

export async function DELETE(
  req: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    await requireAdmin(req);
  } catch (err) {
    if (err instanceof AppError) return unauthorizedResponse(err);
    throw err;
  }

  const { id } = await context.params;
  const driver = getStorageDriver();
  const document = await driver.getDocument(id);
  if (!document) {
    const error = new AppError("KDL-INGEST-001", { message: `No document found for id ${id}` });
    return Response.json(error.toJSON(), { status: 404 });
  }

  // Stored bytes first, database row second — deliberately.
  //
  // This route used to call `deleteUpload` directly, the LOCAL filesystem implementation, bypassing
  // the `FileStorage` seam entirely. In cloud mode `storagePath` is a Blob key, so that call tried
  // to resolve it inside the local upload directory on a read-only filesystem and threw — AFTER
  // `deleteDocument` had already run. The buyer saw a failure, the row was gone on refresh, and the
  // blob was never deleted, accumulating on their bill forever (03-UAT F7).
  //
  // The ordering matters beyond the seam fix. `delete` is idempotent in both implementations, so
  // removing bytes first and failing leaves the row intact and the operation safely retryable. The
  // reverse — row first — turns any storage failure into an orphaned object nothing references and
  // nobody can find.
  try {
    if (document.storagePath) {
      await getFileStorage().delete(document.storagePath);
    }
  } catch (err) {
    const error =
      err instanceof AppError
        ? err
        : new AppError("KDL-INGEST-001", { message: "The document's stored file could not be removed." });
    return Response.json(error.toJSON(), { status: 500 });
  }

  await driver.deleteDocument(id);

  return new Response(null, { status: 204 });
}
