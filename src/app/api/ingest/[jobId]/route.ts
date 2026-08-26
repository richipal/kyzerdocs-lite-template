/**
 * GET /api/ingest/[jobId] — ING-03/ING-09's only progress mechanism: no SSE, no websocket
 * (ARCHITECTURE.md Pattern 2 point 3 — one client-side polling code path works unchanged for both
 * the local in-process pipeline and a future cloud/queue-backed one). `action` is derived from
 * the KDL registry rather than stored on the row — the schema has no `action` column, and
 * `errors.ts`'s `ERROR_CODES` is already the single source of truth for that string.
 */

import { requireAdmin, unauthorizedResponse } from "../../../../lib/auth/session.js";
import { AppError, ERROR_CODES, type ErrorCode } from "../../../../lib/errors.js";
import { getStorageDriver } from "../../../../lib/storage/index.js";

export async function GET(
  req: Request,
  context: { params: Promise<{ jobId: string }> },
): Promise<Response> {
  try {
    await requireAdmin(req);
  } catch (err) {
    if (err instanceof AppError) return unauthorizedResponse(err);
    throw err;
  }

  const { jobId } = await context.params;
  const driver = getStorageDriver();
  const job = await driver.getJob(jobId);
  if (!job) {
    const error = new AppError("KDL-INGEST-001", { message: `No ingest job found for id ${jobId}` });
    return Response.json(error.toJSON(), { status: 404 });
  }

  const action = job.errorCode ? ERROR_CODES[job.errorCode as ErrorCode].action : null;

  return Response.json({
    status: job.status,
    phase: job.phase,
    chunksTotal: job.chunksTotal,
    chunksProcessed: job.chunksProcessed,
    errorCode: job.errorCode,
    errorMessage: job.errorMessage,
    action,
    updatedAt: job.updatedAt,
  });
}
