/**
 * POST /api/auth/login — the only authentication endpoint in the product (ADMIN-01). Rate limit
 * is consulted before any password work so a flood never even reaches the hash (T-02-04-01), and
 * the comparison itself is constant-time (T-02-04-02) — never a plain `===` against
 * `ADMIN_PASSWORD` anywhere in this file.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { AppError } from "../../../../lib/errors.js";
import { consumeAttempt, resetAttempts } from "../../../../lib/auth/rate-limit.js";
import { createSession } from "../../../../lib/auth/session.js";

const loginBodySchema = z.object({
  password: z.string().min(1),
});

/** Rate-limit key: the first hop of `x-forwarded-for` when present (reverse proxy in front),
 * otherwise a constant key — this is a single-buyer local app, so "everyone shares one bucket
 * when there's no proxy" is still correct and still ADMIN-03-compliant. */
function clientKey(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    return forwarded.split(",")[0]!.trim();
  }
  return "local";
}

/** SHA-256 both sides to fixed 32-byte digests, then `timingSafeEqual` — sidesteps
 * `timingSafeEqual`'s throw-on-length-mismatch footgun and never leaks length/prefix via timing. */
function verifyPassword(submitted: string, expected: string): boolean {
  const a = createHash("sha256").update(submitted).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export async function POST(req: Request): Promise<Response> {
  const key = clientKey(req);

  // Rate limiter first — before any password work, so a flood cannot even reach the hash.
  const attempt = consumeAttempt(key);
  if (!attempt.allowed) {
    const error = new AppError("KDL-AUTH-002");
    return Response.json(error.toJSON(), {
      status: 429,
      headers: { "Retry-After": String(attempt.retryAfterSeconds) },
    });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = undefined;
  }

  const parsed = loginBodySchema.safeParse(body);
  if (!parsed.success) {
    const error = new AppError("KDL-AUTH-001");
    return Response.json(error.toJSON(), { status: 401 });
  }

  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) {
    const error = new AppError("KDL-CFG-002");
    return Response.json(error.toJSON(), { status: 500 });
  }

  // Never echo the attempted password back, in logs or in the response — an auth failure must
  // stay safe to paste into a SUPP-01 support message.
  if (!verifyPassword(parsed.data.password, adminPassword)) {
    const error = new AppError("KDL-AUTH-001");
    return Response.json(error.toJSON(), { status: 401 });
  }

  resetAttempts(key);

  const cookieCarrier = new Response();
  await createSession(cookieCarrier);

  const response = Response.json({ ok: true }, { status: 200 });
  const setCookie = cookieCarrier.headers.get("set-cookie");
  if (setCookie) {
    response.headers.set("set-cookie", setCookie);
  }
  return response;
}
