/**
 * Covers plan 03-09 Task 1's acceptance criteria for `GET/PUT /api/widget/config`: both handlers
 * require an admin session (T-03-09-01), a malformed `allowedDomains` entry rejects the whole
 * request and persists nothing (T-03-09-02), and a valid `PUT` round-trips through a subsequent
 * `GET`.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WidgetConfig } from "../../../../lib/widget/config.js";

const testDir = mkdtempSync(join(tmpdir(), "kdl-widget-config-route-test-"));
process.env.DATABASE_PATH = join(testDir, "test.db");
process.env.UPLOAD_DIR = join(testDir, "uploads");
process.env.ADMIN_PASSWORD = "widget-config-route-test-admin-password";
process.env.GEMINI_API_KEY = "test-gemini-key";

const { fakeDriverState, fakeDriver } = vi.hoisted(() => {
  const fakeDriverState = {
    generation: 1,
    settings: new Map<string, string>(),
  };
  return {
    fakeDriverState,
    fakeDriver: {
      getGeneration: vi.fn(async () => fakeDriverState.generation),
      getSetting: vi.fn(async (key: string) => fakeDriverState.settings.get(key) ?? null),
      setSetting: vi.fn(async (key: string, value: string) => {
        fakeDriverState.settings.set(key, value);
        fakeDriverState.generation += 1;
      }),
    },
  };
});

vi.mock("../../../../lib/storage/index.js", () => ({
  getStorageDriver: () => fakeDriver,
}));

const { GET, PUT } = await import("./route.js");
const { createSession } = await import("../../../../lib/auth/session.js");

afterAll(() => {
  delete process.env.DATABASE_PATH;
  delete process.env.UPLOAD_DIR;
  delete process.env.ADMIN_PASSWORD;
  delete process.env.GEMINI_API_KEY;
  rmSync(testDir, { recursive: true, force: true });
});

beforeEach(() => {
  fakeDriverState.generation = 1;
  fakeDriverState.settings.clear();
  fakeDriver.getGeneration.mockClear();
  fakeDriver.getSetting.mockClear();
  fakeDriver.setSetting.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function authCookieHeader(): Promise<string> {
  const carrier = new Response();
  await createSession(carrier);
  const setCookie = carrier.headers.get("set-cookie")!;
  return setCookie.split(";")[0]!;
}

const VALID_CONFIG: WidgetConfig = {
  productName: "Acme Co",
  logoUrl: null,
  accentColor: "#0E4F4A",
  position: "bottom-right",
  title: "Ask Acme Co",
  allowedDomains: ["example.com"],
};

function getRequest(cookie?: string): Request {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  return new Request("http://localhost/api/widget/config", { method: "GET", headers });
}

function putRequest(body: unknown, cookie?: string): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
  return new Request("http://localhost/api/widget/config", {
    method: "PUT",
    headers,
    body: JSON.stringify(body),
  });
}

describe("GET /api/widget/config", () => {
  it("returns 401 KDL-AUTH-003 when unauthenticated", async () => {
    const res = await GET(getRequest());
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("KDL-AUTH-003");
  });

  it("returns the default config when nothing has been saved yet", async () => {
    const cookie = await authCookieHeader();
    const res = await GET(getRequest(cookie));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.productName).toBe("KyzerDocs");
    expect(body.allowedDomains).toEqual([]);
  });
});

describe("PUT /api/widget/config", () => {
  it("returns 401 KDL-AUTH-003 when unauthenticated and persists nothing", async () => {
    const res = await PUT(putRequest(VALID_CONFIG));
    expect(res.status).toBe(401);
    expect(fakeDriver.setSetting).not.toHaveBeenCalled();
  });

  it("rejects a full URL in allowedDomains with 400 KDL-WIDG-006 and persists nothing", async () => {
    const cookie = await authCookieHeader();
    const res = await PUT(
      putRequest({ ...VALID_CONFIG, allowedDomains: ["https://example.com/path"] }, cookie),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("KDL-WIDG-006");
    expect(fakeDriver.setSetting).not.toHaveBeenCalled();
  });

  it("rejects a schema-invalid body (bad hex colour) with 400 KDL-WIDG-006", async () => {
    const cookie = await authCookieHeader();
    const res = await PUT(putRequest({ ...VALID_CONFIG, accentColor: "teal" }, cookie));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("KDL-WIDG-006");
    expect(fakeDriver.setSetting).not.toHaveBeenCalled();
  });

  it("persists a valid body, normalizing domains, and a subsequent GET returns the saved values", async () => {
    const cookie = await authCookieHeader();
    const putRes = await PUT(
      putRequest({ ...VALID_CONFIG, allowedDomains: ["Example.COM", "www.foo.com"] }, cookie),
    );
    expect(putRes.status).toBe(200);
    const putBody = await putRes.json();
    expect(putBody.allowedDomains).toEqual(["example.com", "foo.com"]);

    const getRes = await GET(getRequest(cookie));
    const getBody = await getRes.json();
    expect(getBody.productName).toBe("Acme Co");
    expect(getBody.allowedDomains).toEqual(["example.com", "foo.com"]);
  });
});
