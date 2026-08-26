/**
 * The entire session model (ADMIN-01/02). `iron-session@8` wraps an httpOnly, `sameSite: "lax"`,
 * AES-256-GCM-encrypted cookie containing only `{ authenticated: true, issuedAt: number }` — no
 * username, no role, because there is no user table.
 *
 * `requireAdmin()` is the actual access-control gate. It must be called at the top of every
 * protected API route handler itself, not only relied on via `src/proxy.ts`'s page-level
 * redirect — a direct `curl` to an API route bypasses a proxy redirect entirely, but cannot
 * bypass a check performed inside the handler (T-02-04-03).
 */

import { createHash } from "node:crypto";
import { getIronSession, type IronSession, type SessionOptions } from "iron-session";
import { AppError } from "../errors.js";

export const COOKIE_NAME = "kdl_session";

/** Session validity — also drives the cookie's `max-age`. */
const TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

export interface SessionData {
  /** Present and `true` only once a login has succeeded; absent on an empty/unauthenticated
   * session. Never widen this shape — no username, no role (there is no user table). */
  authenticated?: true;
  issuedAt?: number;
}

/** A `Request` with no cookie header, used when creating or destroying a session where the
 * caller has nothing meaningful to read from the incoming request — only `iron-session`'s
 * `req`+`res` overload can write a `Set-Cookie` onto a Web `Response`, so this stands in for the
 * read side of that overload. */
function blankRequest(): Request {
  return new Request("http://localhost/");
}

/**
 * Derives the cookie-encryption password. `SESSION_SECRET` is an optional, documented override;
 * absent that, the password is deterministically derived from `ADMIN_PASSWORD` via SHA-256 so a
 * buyer never has to invent a second secret. Always hashed (never used raw) so a short
 * `SESSION_SECRET`/`ADMIN_PASSWORD` can never trip iron-session's 32-character minimum.
 */
function derivePassword(): string {
  const raw = process.env.SESSION_SECRET || process.env.ADMIN_PASSWORD || "";
  return createHash("sha256").update(raw).digest("hex");
}

/** Fresh `SessionOptions` computed from the current environment on every call — never cached at
 * module load, so a test (or a buyer who edits `.env.local` and restarts) always sees the
 * current `ADMIN_PASSWORD`/`SESSION_SECRET`/`NODE_ENV`. */
export function sessionOptions(): SessionOptions {
  return {
    cookieName: COOKIE_NAME,
    password: derivePassword(),
    ttl: TTL_SECONDS,
    cookieOptions: {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      // A hardcoded, unconditionally-secure cookie flag breaks login on every local
      // http://localhost install, which is the primary delivery mode (D2-11) — condition it on
      // the runtime environment instead.
      secure: process.env.NODE_ENV === "production",
    },
  };
}

/** Reads and decrypts the session from an incoming request. Never throws for an absent,
 * unparseable, tampered, or expired cookie — those all resolve to an empty session object
 * (`iron-session`'s own behavior), which `requireAdmin` below treats as unauthenticated. */
export async function getSession(req: Request): Promise<IronSession<SessionData>> {
  return getIronSession<SessionData>(req, new Response(), sessionOptions());
}

/** Creates a new authenticated session and appends its `Set-Cookie` header onto `res`. Stores
 * nothing beyond `{ authenticated: true, issuedAt }` — there is no user table to reference. */
export async function createSession(res: Response): Promise<void> {
  const session = await getIronSession<SessionData>(blankRequest(), res, sessionOptions());
  session.authenticated = true;
  session.issuedAt = Date.now();
  await session.save();
}

/** Clears the session cookie by appending an expired `Set-Cookie` header onto `res`. */
export async function destroySession(res: Response): Promise<void> {
  const session = await getIronSession<SessionData>(blankRequest(), res, sessionOptions());
  session.destroy();
}

/**
 * The route guard. Every protected API route handler calls this itself — `src/proxy.ts`'s
 * cookie-presence redirect is a page-navigation convenience only and must never be the sole
 * control (ADMIN-02).
 */
export async function requireAdmin(req: Request): Promise<void> {
  const session = await getSession(req);
  if (session.authenticated !== true) {
    throw new AppError("KDL-AUTH-003");
  }
}

/** Builds the standard 401 response body for an auth failure. Every route reports the same
 * `{ code, message, action }` shape (SUPP-01) — never a stack trace or the attempted credential. */
export function unauthorizedResponse(error: AppError): Response {
  return Response.json(error.toJSON(), { status: 401 });
}
