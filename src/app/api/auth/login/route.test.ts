import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST } from "./route.js";

const ADMIN_PASSWORD = "correct-horse-battery-staple";

function loginRequest(password: unknown, ip: string): Request {
  return new Request("http://localhost/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify({ password }),
  });
}

describe("POST /api/auth/login", () => {
  const originalAdminPassword = process.env.ADMIN_PASSWORD;

  beforeEach(() => {
    process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;
  });

  afterEach(() => {
    if (originalAdminPassword === undefined) delete process.env.ADMIN_PASSWORD;
    else process.env.ADMIN_PASSWORD = originalAdminPassword;
  });

  it("returns 200 and a Set-Cookie with HttpOnly and SameSite=Lax for the correct password", async () => {
    const res = await POST(loginRequest(ADMIN_PASSWORD, "203.0.113.10"));
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toBeTruthy();
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
  });

  it("returns 401 KDL-AUTH-001 for the wrong password", async () => {
    const res = await POST(loginRequest("wrong-password", "203.0.113.11"));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("KDL-AUTH-001");
  });

  it("rate-limits after five wrong attempts: five 401s then a 429 with Retry-After and KDL-AUTH-002", async () => {
    const ip = "203.0.113.12";
    for (let i = 0; i < 5; i++) {
      const res = await POST(loginRequest("wrong-password", ip));
      expect(res.status).toBe(401);
    }
    const sixth = await POST(loginRequest("wrong-password", ip));
    expect(sixth.status).toBe(429);
    const body = await sixth.json();
    expect(body.code).toBe("KDL-AUTH-002");
    expect(sixth.headers.get("Retry-After")).toBeTruthy();
  });

  it("returns 500 KDL-CFG-002 and never sets a cookie when ADMIN_PASSWORD is unset", async () => {
    delete process.env.ADMIN_PASSWORD;
    const res = await POST(loginRequest("anything", "203.0.113.13"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("KDL-CFG-002");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("never leaks the attempted password in the failure response body", async () => {
    const res = await POST(loginRequest("super-secret-guess", "203.0.113.14"));
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain("super-secret-guess");
  });
});
