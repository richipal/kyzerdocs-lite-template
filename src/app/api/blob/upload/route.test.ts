/**
 * `/api/blob/upload` — the client-direct upload token-exchange route (STOR-06, plan 03-10).
 *
 * `generateClientTokenFromReadWriteToken` (`@vercel/blob/client`, verified in
 * `node_modules/@vercel/blob/dist/client.js`) signs the returned client token purely LOCALLY —
 * it never makes a network call — so this suite exercises the real route (real `handleUpload`,
 * real `validateFileMetadata`) against a SYNTHETIC, non-secret `BLOB_READ_WRITE_TOKEN`
 * (`vercel_blob_rw_test_synthetic...`, matching `vector-snapshot.test.ts`'s own convention for
 * exercising `@vercel/blob` code paths without a live credential) rather than requiring
 * `readCloudTestEnv`. No real Blob store is ever contacted by this suite.
 */

import { afterAll, describe, expect, it } from "vitest";

process.env.ADMIN_PASSWORD = "blob-route-test-admin-password";
process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_test_synthetic_token_1234567890";

const { POST } = await import("./route.js");
const { createSession } = await import("../../../../lib/auth/session.js");

afterAll(() => {
  delete process.env.ADMIN_PASSWORD;
  delete process.env.BLOB_READ_WRITE_TOKEN;
});

async function authCookieHeader(): Promise<string> {
  const carrier = new Response();
  await createSession(carrier);
  const setCookie = carrier.headers.get("set-cookie")!;
  return setCookie.split(";")[0]!;
}

function tokenRequestBody(filename: string, mimeType: string, byteSize: number) {
  return {
    type: "blob.generate-client-token",
    payload: {
      pathname: `uploads/${crypto.randomUUID()}.bin`,
      callbackUrl: "http://localhost/api/blob/upload",
      clientPayload: JSON.stringify({ filename, mimeType, byteSize }),
      multipart: false,
    },
  };
}

async function postTokenRequest(cookie: string | null, body: unknown): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
  const req = new Request("http://localhost/api/blob/upload", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return POST(req);
}

describe("POST /api/blob/upload — auth coverage", () => {
  it("without a session returns 401 KDL-AUTH-003 and never calls handleUpload", async () => {
    const res = await postTokenRequest(null, tokenRequestBody("doc.pdf", "application/pdf", 1024));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("KDL-AUTH-003");
  });
});

describe("POST /api/blob/upload — token issuance gate (T-03-10-03)", () => {
  it("rejects a disallowed content type BEFORE issuing a token", async () => {
    const cookie = await authCookieHeader();
    const res = await postTokenRequest(
      cookie,
      tokenRequestBody("slides.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation", 1024),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("KDL-UPLOAD-001");
    expect(body.clientToken).toBeUndefined();
  });

  it("rejects an oversized declared byteSize BEFORE issuing a token", async () => {
    const cookie = await authCookieHeader();
    const res = await postTokenRequest(cookie, tokenRequestBody("huge.pdf", "application/pdf", 200 * 1024 * 1024));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("KDL-UPLOAD-002");
  });

  it("rejects malformed/missing clientPayload metadata", async () => {
    const cookie = await authCookieHeader();
    const res = await postTokenRequest(cookie, {
      type: "blob.generate-client-token",
      payload: { pathname: "uploads/x.pdf", clientPayload: null, multipart: false },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("KDL-UPLOAD-001");
  });

  it("issues a client token for a supported, correctly-sized file", async () => {
    const cookie = await authCookieHeader();
    const res = await postTokenRequest(cookie, tokenRequestBody("manual.pdf", "application/pdf", 1024));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.clientToken).toBe("string");
    expect(body.clientToken.length).toBeGreaterThan(0);
  });
});
