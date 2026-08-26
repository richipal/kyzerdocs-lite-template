import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSession,
  destroySession,
  getSession,
  requireAdmin,
  sessionOptions,
} from "./session.js";

const COOKIE_NAME = "kdl_session";

function extractCookieValue(res: Response, name: string): string {
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("expected a set-cookie header, got none");
  const pair = setCookie.split(";")[0]!;
  const eqIndex = pair.indexOf("=");
  const cookieName = pair.slice(0, eqIndex);
  const value = pair.slice(eqIndex + 1);
  if (cookieName !== name) throw new Error(`unexpected cookie name: ${cookieName}`);
  return value;
}

function requestWithCookie(value: string): Request {
  return new Request("http://localhost/api/documents", {
    headers: { cookie: `${COOKIE_NAME}=${value}` },
  });
}

/** Flips one character deep inside the decrypted seal payload, then re-encodes it so the
 * resulting Cookie header value is still well-formed — this corrupts the HMAC/ciphertext, not
 * the cookie's URI-encoding. */
function tamperCookieValue(value: string): string {
  const decoded = decodeURIComponent(value);
  const midpoint = Math.floor(decoded.length / 2);
  const original = decoded[midpoint]!;
  const replacement = original === "A" ? "B" : "A";
  const tamperedDecoded = decoded.slice(0, midpoint) + replacement + decoded.slice(midpoint + 1);
  return encodeURIComponent(tamperedDecoded);
}

describe("session", () => {
  beforeEach(() => {
    process.env.ADMIN_PASSWORD = "test-admin-password-for-session-tests";
    delete process.env.SESSION_SECRET;
  });

  it("requireAdmin throws KDL-AUTH-003 when no cookie is present", async () => {
    const req = new Request("http://localhost/api/documents");
    await expect(requireAdmin(req)).rejects.toMatchObject({ code: "KDL-AUTH-003" });
  });

  it("requireAdmin throws KDL-AUTH-003 for an unparseable cookie value", async () => {
    const req = requestWithCookie("not-a-valid-iron-session-seal");
    await expect(requireAdmin(req)).rejects.toMatchObject({ code: "KDL-AUTH-003" });
  });

  it("requireAdmin resolves for a freshly created, valid session cookie", async () => {
    const res = new Response();
    await createSession(res);
    const cookieValue = extractCookieValue(res, COOKIE_NAME);

    await expect(requireAdmin(requestWithCookie(cookieValue))).resolves.toBeUndefined();
  });

  it("requireAdmin throws KDL-AUTH-003 for a bit-flipped (tampered) cookie", async () => {
    const res = new Response();
    await createSession(res);
    const cookieValue = extractCookieValue(res, COOKIE_NAME);
    const tampered = tamperCookieValue(cookieValue);

    await expect(requireAdmin(requestWithCookie(tampered))).rejects.toMatchObject({
      code: "KDL-AUTH-003",
    });
  });

  it("the decrypted session payload has exactly the keys authenticated and issuedAt", async () => {
    const res = new Response();
    await createSession(res);
    const cookieValue = extractCookieValue(res, COOKIE_NAME);

    const session = await getSession(requestWithCookie(cookieValue));
    expect(Object.keys(session).sort()).toEqual(["authenticated", "issuedAt"]);
    expect(session.authenticated).toBe(true);
    expect(typeof session.issuedAt).toBe("number");
  });

  it("destroySession clears the cookie so a subsequent requireAdmin call rejects", async () => {
    const createRes = new Response();
    await createSession(createRes);
    const cookieValue = extractCookieValue(createRes, COOKIE_NAME);
    await expect(requireAdmin(requestWithCookie(cookieValue))).resolves.toBeUndefined();

    const destroyRes = new Response();
    await destroySession(destroyRes);
    const cleared = extractCookieValue(destroyRes, COOKIE_NAME);
    // A destroyed cookie is set to an empty value with maxAge 0 — requireAdmin must reject it.
    await expect(requireAdmin(requestWithCookie(cleared))).rejects.toMatchObject({
      code: "KDL-AUTH-003",
    });
  });

  it("sessionOptions conditions the secure flag on NODE_ENV rather than hardcoding it", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(sessionOptions().cookieOptions?.secure).toBe(false);
    vi.stubEnv("NODE_ENV", "production");
    expect(sessionOptions().cookieOptions?.secure).toBe(true);
    vi.unstubAllEnvs();
  });

  it("derives the session password from ADMIN_PASSWORD when SESSION_SECRET is unset", () => {
    // Must not throw iron-session's "password must be >= 32 chars" error for a short admin password.
    process.env.ADMIN_PASSWORD = "short";
    expect(() => sessionOptions()).not.toThrow();
    expect((sessionOptions().password as string).length).toBeGreaterThanOrEqual(32);
  });
});
