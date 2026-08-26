/**
 * GET /api/documents — lists documents in the default knowledge base for the document screen
 * (02-08), excluding superseded rows (ING-06): a superseded document's chunks are already gone
 * from the corpus, so listing it would be confusing to a buyer deciding what to re-upload/delete.
 */

import { requireAdmin, unauthorizedResponse } from "../../../lib/auth/session.js";
import { AppError } from "../../../lib/errors.js";
import { getStorageDriver } from "../../../lib/storage/index.js";
import { DEFAULT_KB_ID } from "../../../lib/types.js";

export async function GET(req: Request): Promise<Response> {
  try {
    await requireAdmin(req);
  } catch (err) {
    if (err instanceof AppError) return unauthorizedResponse(err);
    throw err;
  }

  const driver = getStorageDriver();
  const all = await driver.listDocuments(DEFAULT_KB_ID);
  const visible = all.filter((d) => d.supersededBy === null);

  const documents = await Promise.all(
    visible.map(async (d) => ({
      id: d.id,
      filename: d.filename,
      status: d.status,
      errorCode: d.errorCode,
      pageCount: d.pageCount,
      chunkCount: await driver.countChunksForDocument(d.id),
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
    })),
  );

  return Response.json({ documents });
}
