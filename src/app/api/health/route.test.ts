import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Same convention as ingest/route.test.ts: PRODUCT_CONFIG reads DATABASE_PATH/UPLOAD_DIR from
// process.env exactly once and freezes, so both must be set before any dynamic import evaluates
// that module graph.
const testDir = mkdtempSync(join(tmpdir(), "kdl-health-route-test-"));
process.env.DATABASE_PATH = join(testDir, "test.db");
process.env.UPLOAD_DIR = join(testDir, "uploads");
process.env.ADMIN_PASSWORD = "health-route-test-admin-password";

afterAll(() => {
  delete process.env.DATABASE_PATH;
  delete process.env.UPLOAD_DIR;
  delete process.env.ADMIN_PASSWORD;
  rmSync(testDir, { recursive: true, force: true });
});

/** Builds the `Cookie` header value a real login would produce. Each test re-imports the route
 * module fresh (see `loadRoute` below), so `createSession` must also be re-imported from the same
 * fresh module graph rather than hoisted once at file scope. */
async function authCookieHeader(createSession: (res: Response) => Promise<void>): Promise<string> {
  const carrier = new Response();
  await createSession(carrier);
  const setCookie = carrier.headers.get("set-cookie")!;
  return setCookie.split(";")[0]!;
}

/** Every test gets its own fresh module graph — the health route's embedding-check cache is
 * module-scoped by design (T-02-08-03), so tests that need to observe a *fresh* cache (the missing-
 * key test, the fail-soft test) must not see a previous test's cached result. Only the caching
 * test itself relies on the cache persisting *within* one graph, across repeated calls. */
async function loadRoute() {
  vi.resetModules();
  const routeModule = await import("./route.js");
  const sessionModule = await import("../../../lib/auth/session.js");
  return { GET: routeModule.GET, createSession: sessionModule.createSession };
}

describe("GET /api/health", () => {
  beforeEach(() => {
    delete process.env.GEMINI_API_KEY;
  });

  afterEach(() => {
    delete process.env.GEMINI_API_KEY;
    vi.doUnmock("../../../lib/embeddings/gemini.js");
    vi.restoreAllMocks();
  });

  it("unauthenticated GET returns 200 and never leaks DATABASE_PATH, a path-shaped key, or the configured API key value", async () => {
    process.env.GEMINI_API_KEY = "fake-recognisable-test-key-zzz999";
    const { GET } = await loadRoute();

    const req = new Request("http://localhost/api/health", { method: "GET" });
    const res = await GET(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    const raw = JSON.stringify(body);

    expect(raw).not.toContain(process.env.DATABASE_PATH!);
    expect(raw).not.toContain("fake-recognisable-test-key-zzz999");
    for (const key of Object.keys(body)) {
      expect(key.toLowerCase()).not.toContain("path");
      const inner = body[key];
      if (inner && typeof inner === "object") {
        for (const innerKey of Object.keys(inner)) {
          expect(innerKey.toLowerCase()).not.toContain("path");
        }
      }
    }

    // Unauthenticated shape: booleans and codes only, no message/action detail, no corpus, no
    // lastFailedDocument.
    expect(typeof body.database.ok).toBe("boolean");
    expect(body.database.message).toBeUndefined();
    expect(body.database.action).toBeUndefined();
    expect(body.corpus).toBeUndefined();
    expect(body.lastFailedDocument).toBeUndefined();
  });

  it("authenticated GET returns the same check keys plus detail fields (path, message, action, corpus)", async () => {
    process.env.GEMINI_API_KEY = "fake-recognisable-test-key-zzz999";
    const { GET, createSession } = await loadRoute();

    const cookie = await authCookieHeader(createSession);
    const req = new Request("http://localhost/api/health", { method: "GET", headers: { cookie } });
    const res = await GET(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.database.path).toBe(process.env.DATABASE_PATH);
    expect(body.corpus).toEqual({ total: 0, ready: 0, failed: 0 });
    expect(body.lastFailedDocument).toBeNull();
    expect(body.chatProvider.provider).toBe("google");
  });

  it("fail-soft: with the embedding client stubbed to throw, the response is still 200, embedding.ok is false with KDL-EMBED-002, and database.ok remains true", async () => {
    process.env.GEMINI_API_KEY = "fake-recognisable-test-key-zzz999";
    vi.resetModules();
    vi.doMock("../../../lib/embeddings/gemini.js", () => ({
      embedQuery: async () => {
        throw new Error("simulated embedding provider failure");
      },
    }));

    const routeModule = await import("./route.js");
    const sessionModule = await import("../../../lib/auth/session.js");
    const cookie = await authCookieHeader(sessionModule.createSession);

    const req = new Request("http://localhost/api/health", { method: "GET", headers: { cookie } });
    const res = await routeModule.GET(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.embedding.ok).toBe(false);
    expect(body.embedding.code).toBe("KDL-EMBED-002");
    expect(body.database.ok).toBe(true);
  });

  it("missing-key: with GEMINI_API_KEY unset, apiKey.ok is false with code KDL-CFG-001 and an action string", async () => {
    const { GET, createSession } = await loadRoute();
    const cookie = await authCookieHeader(createSession);

    const req = new Request("http://localhost/api/health", { method: "GET", headers: { cookie } });
    const res = await GET(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.apiKey.ok).toBe(false);
    expect(body.apiKey.code).toBe("KDL-CFG-001");
    expect(typeof body.apiKey.action).toBe("string");
    expect(body.apiKey.action.length).toBeGreaterThan(0);

    // The embedding probe can't run at all without a key — same root cause, no wasted call.
    expect(body.embedding.ok).toBe(false);
    expect(body.embedding.code).toBe("KDL-CFG-001");
  });

  it("indexRebuild is omitted entirely when no rebuild has been observed in this process (S-5)", async () => {
    process.env.GEMINI_API_KEY = "fake-recognisable-test-key-zzz999";
    const { GET } = await loadRoute();

    const req = new Request("http://localhost/api/health", { method: "GET" });
    const res = await GET(req);
    const body = await res.json();

    expect("indexRebuild" in body).toBe(false);
  });

  it("indexRebuild carries a real millisecond value once getVectorIndex has rebuilt in this process", async () => {
    process.env.GEMINI_API_KEY = "fake-recognisable-test-key-zzz999";
    vi.resetModules();

    const routeModule = await import("./route.js");
    const vectorIndexModule = await import("../../../lib/retrieval/vector-index.js");

    // Drive a real rebuild against this process's own (empty, local-mode) storage driver — the
    // same module getVectorIndex() itself uses, no mocking of the rebuild path.
    await vectorIndexModule.getVectorIndex("indexrebuild-health-test-kb");

    const req = new Request("http://localhost/api/health", { method: "GET" });
    const res = await routeModule.GET(req);
    const body = await res.json();

    expect(body.indexRebuild).toBeDefined();
    expect(typeof body.indexRebuild.ms).toBe("number");
    expect(body.indexRebuild.ms).toBeGreaterThanOrEqual(0);
  });

  it("caching: five consecutive requests within the cache window make exactly one embedQuery call", async () => {
    process.env.GEMINI_API_KEY = "fake-recognisable-test-key-zzz999";
    vi.resetModules();
    const embedQueryMock = vi.fn(async () => new Float32Array(768));
    vi.doMock("../../../lib/embeddings/gemini.js", () => ({
      embedQuery: embedQueryMock,
    }));

    const routeModule = await import("./route.js");
    const sessionModule = await import("../../../lib/auth/session.js");
    const cookie = await authCookieHeader(sessionModule.createSession);

    for (let i = 0; i < 5; i++) {
      const req = new Request("http://localhost/api/health", { method: "GET", headers: { cookie } });
      const res = await routeModule.GET(req);
      expect(res.status).toBe(200);
    }

    expect(embedQueryMock).toHaveBeenCalledTimes(1);
  });
});

// Plan 03-10 (STOR-06, UI-SPEC Surface 4) — the `blob` probe. `@vercel/blob`'s `list()` is
// mocked throughout (same style as `embedQuery` above) so this suite never contacts a real store.
// `DATABASE_URL` is set/restored per test (a synthetic, non-resolving Neon-style host, matching
// `vector-snapshot.test.ts`'s own convention) to flip `PRODUCT_CONFIG.cloudMode` — never left set
// outside a single test's own try/finally, so no other test in this file inherits it.
describe("GET /api/health — blob probe (plan 03-10)", () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalBlobToken = process.env.BLOB_READ_WRITE_TOKEN;

  afterEach(() => {
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    if (originalBlobToken === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
    else process.env.BLOB_READ_WRITE_TOKEN = originalBlobToken;
    vi.doUnmock("@vercel/blob");
    vi.resetModules();
  });

  it("the health response omits `blob` entirely in local mode", async () => {
    delete process.env.DATABASE_URL;
    const { GET } = await loadRoute();

    const req = new Request("http://localhost/api/health", { method: "GET" });
    const res = await GET(req);
    const body = await res.json();

    expect("blob" in body).toBe(false);
  });

  it("a forced list() throw does not change the route's status code — still 200, blob.ok is false with KDL-BLOB-004", async () => {
    process.env.DATABASE_URL = "postgresql://user:pass@ep-test-99999.us-east-1.aws.neon.tech/neondb";
    process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_test_synthetic_token_1234567890";
    vi.resetModules();
    vi.doMock("@vercel/blob", () => ({
      list: async () => {
        throw new Error("simulated blob store failure");
      },
    }));

    const routeModule = await import("./route.js");
    const req = new Request("http://localhost/api/health", { method: "GET" });
    const res = await routeModule.GET(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.blob.ok).toBe(false);
    expect(body.blob.code).toBe("KDL-BLOB-004");
  });

  it("blob.ok is true and no token or store URL ever appears in the response when list() succeeds", async () => {
    process.env.DATABASE_URL = "postgresql://user:pass@ep-test-99999.us-east-1.aws.neon.tech/neondb";
    process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_test_recognisable_token_zzz999";
    vi.resetModules();
    const listMock = vi.fn(async () => ({ blobs: [], cursor: undefined, hasMore: false }));
    vi.doMock("@vercel/blob", () => ({ list: listMock }));

    const routeModule = await import("./route.js");
    const req = new Request("http://localhost/api/health", { method: "GET" });
    const res = await routeModule.GET(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.blob.ok).toBe(true);

    const raw = JSON.stringify(body);
    expect(raw).not.toContain("vercel_blob_rw_test_recognisable_token_zzz999");
    expect(raw).not.toContain(".blob.vercel-storage.com");
    expect(listMock).toHaveBeenCalledWith(expect.objectContaining({ limit: 1 }));
  });

  it("no BLOB_READ_WRITE_TOKEN configured in cloud mode reports blob.ok false with KDL-BLOB-001, without calling list()", async () => {
    process.env.DATABASE_URL = "postgresql://user:pass@ep-test-99999.us-east-1.aws.neon.tech/neondb";
    delete process.env.BLOB_READ_WRITE_TOKEN;
    vi.resetModules();
    const listMock = vi.fn(async () => ({ blobs: [], cursor: undefined, hasMore: false }));
    vi.doMock("@vercel/blob", () => ({ list: listMock }));

    const routeModule = await import("./route.js");
    const req = new Request("http://localhost/api/health", { method: "GET" });
    const res = await routeModule.GET(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.blob.ok).toBe(false);
    expect(body.blob.code).toBe("KDL-BLOB-001");
    expect(listMock).not.toHaveBeenCalled();
  });
});

describe("database.path is local-mode only (S-5)", () => {
  it("omits the SQLite path in cloud mode rather than reporting a file that does not exist", async () => {
    // `paths.databasePath` is the SQLite file location. On a Postgres deployment it is meaningless,
    // and reporting it made one response contradict itself: "path": "./data/kyzerdocs.db" alongside
    // "label": "Postgres (Neon)". Never rendered to the buyer, but this endpoint exists to be
    // believed during support, and a diagnostic asserting a false location sends whoever reads it
    // looking for the wrong database (03-UAT F9).
    process.env.GEMINI_API_KEY = "fake-recognisable-test-key-zzz999";
    process.env.DATABASE_URL = "postgresql://u:p@ep-fake-test.us-east-2.aws.neon.tech/neondb";
    try {
      const { GET, createSession } = await loadRoute();
      const cookie = await authCookieHeader(createSession);
      const req = new Request("http://localhost/api/health", { method: "GET", headers: { cookie } });
      const body = await (await GET(req)).json();

      expect(body.driver?.cloudMode).toBe(true);
      expect(body.database.path).toBeUndefined();
    } finally {
      delete process.env.DATABASE_URL;
    }
  });
});
