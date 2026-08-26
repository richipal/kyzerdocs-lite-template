import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

// PRODUCT_CONFIG (transitively imported by every route below, via storage/index.js and
// storage/files.js) reads DATABASE_PATH/UPLOAD_DIR from process.env exactly once and freezes —
// both must be set before any dynamic import evaluates that module graph (same pattern as
// pipeline.resume.test.ts).
const testDir = mkdtempSync(join(tmpdir(), "kdl-ingest-route-test-"));
process.env.DATABASE_PATH = join(testDir, "test.db");
process.env.UPLOAD_DIR = join(testDir, "uploads");
process.env.ADMIN_PASSWORD = "route-test-admin-password";

// The routes must never hit the real Gemini API in a unit test.
vi.mock("../../../lib/embeddings/gemini.js", () => ({
  embedDocuments: async (texts: string[]) =>
    texts.map(() => {
      const v = new Float32Array(768);
      v[0] = 1;
      return v;
    }),
}));

const { POST: ingestPost } = await import("./route.js");
const { GET: jobGet } = await import("./[jobId]/route.js");
const { GET: documentsGet } = await import("../documents/route.js");
const { DELETE: documentDelete } = await import("../documents/[id]/route.js");
const { createSession } = await import("../../../lib/auth/session.js");
const { getStorageDriver } = await import("../../../lib/storage/index.js");
const { DEFAULT_KB_ID } = await import("../../../lib/types.js");

afterAll(() => {
  delete process.env.DATABASE_PATH;
  delete process.env.UPLOAD_DIR;
  delete process.env.ADMIN_PASSWORD;
  rmSync(testDir, { recursive: true, force: true });
});

/** Builds the `Cookie` header value a real login would produce, without going through the login
 * route/rate-limiter — this suite is testing ingest/document routes' own `requireAdmin()` gate,
 * not the login flow (already covered by `auth/login/route.test.ts`). */
async function authCookieHeader(): Promise<string> {
  const carrier = new Response();
  await createSession(carrier);
  const setCookie = carrier.headers.get("set-cookie")!;
  return setCookie.split(";")[0]!;
}

function textFileForm(filename: string, content: string, mimeType = "text/plain"): FormData {
  const form = new FormData();
  form.set("file", new File([content], filename, { type: mimeType }));
  return form;
}

async function uploadAuthed(filename: string, content: string, mimeType = "text/plain") {
  const cookie = await authCookieHeader();
  const req = new Request("http://localhost/api/ingest", {
    method: "POST",
    headers: { cookie },
    body: textFileForm(filename, content, mimeType),
  });
  return ingestPost(req);
}

describe("ingest/document API routes — auth, upload, poll, list, delete", () => {
  it("every route module imports and calls requireAdmin (grep-verified separately; this asserts the runtime behavior)", async () => {
    const req = new Request("http://localhost/api/ingest", { method: "POST", body: new FormData() });
    const res = await ingestPost(req);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("KDL-AUTH-003");
  });

  it("POST /api/ingest with a valid session and a supported file returns 200 and status ready", async () => {
    const res = await uploadAuthed("hello.txt", "Hello world, this is a small test document about safety.");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.jobId).toBeTruthy();
    expect(body.documentId).toBeTruthy();
    expect(body.status).toBe("ready");
  });

  it("unsupported file type (.pptx) returns 400 KDL-UPLOAD-001 and creates no documents row", async () => {
    const driver = getStorageDriver();
    const before = await driver.listDocuments(DEFAULT_KB_ID);

    const cookie = await authCookieHeader();
    const req = new Request("http://localhost/api/ingest", {
      method: "POST",
      headers: { cookie },
      body: textFileForm(
        "slides.pptx",
        "not really a pptx",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      ),
    });
    const res = await ingestPost(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("KDL-UPLOAD-001");

    const after = await driver.listDocuments(DEFAULT_KB_ID);
    expect(after.length).toBe(before.length);
  });

  it("GET /api/ingest/[jobId] for a completed job returns status ready with chunksProcessed === chunksTotal", async () => {
    const uploadRes = await uploadAuthed("poll-doc.txt", "Content for the polling test document.");
    const { jobId } = await uploadRes.json();

    const cookie = await authCookieHeader();
    const req = new Request(`http://localhost/api/ingest/${jobId}`, { method: "GET", headers: { cookie } });
    const res = await jobGet(req, { params: Promise.resolve({ jobId }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ready");
    expect(body.chunksProcessed).toBe(body.chunksTotal);
  });

  it("GET /api/ingest/[jobId] without a session returns 401", async () => {
    const req = new Request("http://localhost/api/ingest/does-not-matter", { method: "GET" });
    const res = await jobGet(req, { params: Promise.resolve({ jobId: "does-not-matter" }) });
    expect(res.status).toBe(401);
  });

  it("DELETE /api/documents/[id] removes the document, its chunks, and the uploaded file; GET /api/documents no longer lists it", async () => {
    const uploadRes = await uploadAuthed("delete-doc.txt", "This document will be deleted by the test.");
    const { documentId } = await uploadRes.json();

    const driver = getStorageDriver();
    const doc = await driver.getDocument(documentId);
    expect(doc?.storagePath).toBeTruthy();
    expect(existsSync(doc!.storagePath!)).toBe(true);

    const cookie = await authCookieHeader();
    const deleteReq = new Request(`http://localhost/api/documents/${documentId}`, {
      method: "DELETE",
      headers: { cookie },
    });
    const deleteRes = await documentDelete(deleteReq, { params: Promise.resolve({ id: documentId }) });
    expect(deleteRes.status).toBe(204);

    const listReq = new Request("http://localhost/api/documents", { method: "GET", headers: { cookie } });
    const listRes = await documentsGet(listReq);
    const listBody = await listRes.json();
    expect(listBody.documents.find((d: { id: string }) => d.id === documentId)).toBeUndefined();

    const chunkCount = await driver.countChunksForDocument(documentId);
    expect(chunkCount).toBe(0);

    expect(existsSync(doc!.storagePath!)).toBe(false);
  });

  it("DELETE /api/documents/[id] for an unknown id returns 404, not 204", async () => {
    const cookie = await authCookieHeader();
    const req = new Request("http://localhost/api/documents/does-not-exist", {
      method: "DELETE",
      headers: { cookie },
    });
    const res = await documentDelete(req, { params: Promise.resolve({ id: "does-not-exist" }) });
    expect(res.status).toBe(404);
  });

  it("GET /api/documents without a session returns 401", async () => {
    const req = new Request("http://localhost/api/documents", { method: "GET" });
    const res = await documentsGet(req);
    expect(res.status).toBe(401);
  });

  it("GET /api/documents lists status/errorCode/pageCount/chunkCount for a ready document", async () => {
    const uploadRes = await uploadAuthed("listed-doc.txt", "Content for the list-shape test document.");
    const { documentId } = await uploadRes.json();

    const cookie = await authCookieHeader();
    const req = new Request("http://localhost/api/documents", { method: "GET", headers: { cookie } });
    const res = await documentsGet(req);
    const body = await res.json();
    const entry = body.documents.find((d: { id: string }) => d.id === documentId);
    expect(entry).toBeDefined();
    expect(entry.status).toBe("ready");
    expect(entry.errorCode).toBeNull();
    expect(entry.chunkCount).toBeGreaterThan(0);
  });

  // Plan 03-10 (STOR-06) — the defect this plan exists to fix: a Vercel Function's request body
  // is capped at 4.5MB. This is the fixture RESEARCH.md's own "Warning signs" section names: any
  // manual test using only small fixtures would pass while the defect existed, undetected.
  it(
    "a fixture over 4.5MB ingests successfully in local mode (the local path is untouched by this plan)",
    async () => {
      // Realistic sentence-shaped content (whitespace + punctuation), not one unbroken character
      // run — `chunk.ts`'s structure-aware tiers are O(n) per document on real text; an unbroken
      // whitespace-free string defeats every structure tier and forces the O(chunk-count x
      // remaining-text-length) fallback path, which is pathological at this size and unrelated to
      // what this test actually needs to prove (a large file's byte-acquisition path, not chunker
      // performance on pathological input).
      const sentence = "This paragraph exists only to exceed the 4.5MB Vercel body cap in a realistic way. ";
      const overFourPointFiveMb = sentence.repeat(Math.ceil((5 * 1024 * 1024) / sentence.length));
      const res = await uploadAuthed("big-document.txt", overFourPointFiveMb);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("ready");
    },
    20_000, // ~4300 chunks through the real (mocked-embedding) pipeline legitimately takes >5s
  );
});

// Plan 03-10 (STOR-06) — the real regression guard: in cloud mode, `POST /api/ingest` must NEVER
// call `req.formData()`, even when the read ultimately fails (no real Blob store is provisioned
// in this suite). A test that only proves a SMALL cloud-mode upload succeeds would pass even if
// the route silently fell back to reading the request body — RESEARCH.md names this exact trap.
// Requires a fresh module graph (`vi.resetModules()`) so `PRODUCT_CONFIG.cloudMode` — frozen at
// first `config.js` import — reflects `DATABASE_URL` being present, mirroring
// `vector-snapshot.test.ts`'s established pattern for exercising the cloud branch without a live
// credential. Never assigns to `process.env` outside this one isolated, restored test.
describe("POST /api/ingest — cloud mode never reads req.formData() (Pitfall 2 regression guard)", () => {
  it("cloud-mode request never calls req.formData(), even though the read ultimately fails without a real Blob store", async () => {
    const originalDatabaseUrl = process.env.DATABASE_URL;
    const originalBlobToken = process.env.BLOB_READ_WRITE_TOKEN;
    process.env.DATABASE_URL = "postgresql://user:pass@ep-test-99999.us-east-1.aws.neon.tech/neondb";
    delete process.env.BLOB_READ_WRITE_TOKEN;
    vi.resetModules();

    try {
      const { POST: cloudIngestPost } = await import("./route.js");
      const { createSession: cloudCreateSession } = await import("../../../lib/auth/session.js");

      const carrier = new Response();
      await cloudCreateSession(carrier);
      const cookie = carrier.headers.get("set-cookie")!.split(";")[0]!;

      const req = new Request("http://localhost/api/ingest", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({
          pathname: "uploads/fake-object.txt",
          filename: "fake-object.txt",
          mimeType: "text/plain",
          byteSize: 10,
        }),
      });
      const formDataSpy = vi.spyOn(req, "formData");

      const res = await cloudIngestPost(req);

      // The actual regression assertion — independent of how the request ultimately resolves.
      expect(formDataSpy).not.toHaveBeenCalled();

      // Confirm the failure is the expected coded one (no real Blob token configured here), not a
      // silent success masking whether the cloud branch actually ran.
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.code).toBe("KDL-BLOB-001");
    } finally {
      if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = originalDatabaseUrl;
      if (originalBlobToken === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
      else process.env.BLOB_READ_WRITE_TOKEN = originalBlobToken;
      vi.resetModules();
    }
  });
});
