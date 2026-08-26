/**
 * DELETE /api/documents/[id] — ING-05. `deleteDocument` cascades chunks and `chunks_fts` rows and
 * bumps the RET-02 generation counter (storage driver, plan 02-02); this route additionally
 * removes the uploaded file from disk so a delete cleans up both the database and the filesystem.
 * Deleting an unknown id is a 404, not a 204 — a buyer's client should be able to tell "already
 * gone" apart from "gone now".
 */

import { requireAdmin, unauthorizedResponse } from "../../../../lib/auth/session.js";
import { AppError } from "../../../../lib/errors.js";
import { deleteUpload } from "../../../../lib/storage/files.js";
import { getStorageDriver } from "../../../../lib/storage/index.js";

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

  await driver.deleteDocument(id);
  if (document.storagePath) {
    await deleteUpload(document.storagePath);
  }

  return new Response(null, { status: 204 });
}
