/** POST /api/auth/logout — clears the session cookie. Like every protected route, it calls the
 * session guard itself rather than relying on the proxy redirect (ADMIN-02): a direct call with
 * no cookie is rejected the same way an unauthenticated call to any other protected route is. */

import { AppError } from "../../../../lib/errors.js";
import { destroySession, requireAdmin, unauthorizedResponse } from "../../../../lib/auth/session.js";

export async function POST(req: Request): Promise<Response> {
  try {
    await requireAdmin(req);
  } catch (err) {
    if (err instanceof AppError) return unauthorizedResponse(err);
    throw err;
  }

  const response = new Response(null, { status: 204 });
  await destroySession(response);
  return response;
}
