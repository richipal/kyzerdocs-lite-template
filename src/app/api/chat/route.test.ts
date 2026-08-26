import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RetrievedChunkWithMeta } from "../../../lib/retrieval/search.js";

// PRODUCT_CONFIG reads DATABASE_PATH/UPLOAD_DIR from process.env exactly once and freezes — both
// must be set before any dynamic import evaluates that module graph (matches
// src/app/api/ingest/route.test.ts's own setup).
const testDir = mkdtempSync(join(tmpdir(), "kdl-chat-route-test-"));
process.env.DATABASE_PATH = join(testDir, "test.db");
process.env.UPLOAD_DIR = join(testDir, "uploads");
process.env.ADMIN_PASSWORD = "route-test-admin-password";
process.env.GEMINI_API_KEY = "test-gemini-key";

const streamTextMock = vi.fn();

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    streamText: (...args: unknown[]) => streamTextMock(...args),
  };
});

const condenseQueryMock = vi.fn(async (_history: unknown, question: string) => question);
vi.mock("../../../lib/chat/condense.js", () => ({
  condenseQuery: (...args: [unknown, string]) => condenseQueryMock(...args),
}));

const retrieveMock = vi.fn();
vi.mock("../../../lib/retrieval/search.js", () => ({
  retrieve: (...args: unknown[]) => retrieveMock(...args),
}));

const checkGroundednessMock = vi.fn();
vi.mock("../../../lib/chat/groundedness.js", () => ({
  checkGroundedness: (...args: unknown[]) => checkGroundednessMock(...args),
}));

const listDocumentsMock = vi.fn(async () => [
  {
    id: "doc-1",
    status: "ready",
    supersededBy: null,
  },
]);
vi.mock("../../../lib/storage/index.js", () => ({
  getStorageDriver: () => ({ listDocuments: listDocumentsMock }),
}));

const { POST } = await import("./route.js");
const { createSession } = await import("../../../lib/auth/session.js");

afterAll(() => {
  delete process.env.DATABASE_PATH;
  delete process.env.UPLOAD_DIR;
  delete process.env.ADMIN_PASSWORD;
  delete process.env.GEMINI_API_KEY;
  rmSync(testDir, { recursive: true, force: true });
});

beforeEach(() => {
  streamTextMock.mockReset();
  condenseQueryMock.mockClear();
  retrieveMock.mockReset();
  checkGroundednessMock.mockReset();
  listDocumentsMock.mockClear();
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

function makeChunk(overrides: Partial<RetrievedChunkWithMeta> = {}): RetrievedChunkWithMeta {
  return {
    chunkId: overrides.chunkId ?? "chunk-1",
    documentId: overrides.documentId ?? "doc-1",
    filename: overrides.filename ?? "policy.pdf",
    pageNumber: overrides.pageNumber ?? 2,
    sectionTitle: overrides.sectionTitle ?? null,
    charStart: overrides.charStart ?? 0,
    charEnd: overrides.charEnd ?? 100,
    content: overrides.content ?? "Retrieved content.",
    similarity: overrides.similarity ?? 0.85,
    rank: overrides.rank ?? 0,
  };
}

function chatRequest(body: unknown, cookie?: string): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
  return new Request("http://localhost/api/chat", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function fakeTextStream() {
  return new ReadableStream({
    start(controller) {
      controller.enqueue({ type: "text-start", id: "1" });
      controller.enqueue({ type: "text-delta", id: "1", text: "The answer is [1]." });
      controller.enqueue({ type: "text-end", id: "1" });
      controller.enqueue({
        type: "finish",
        finishReason: "stop",
        rawFinishReason: undefined,
        totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      });
      controller.close();
    },
  });
}

describe("POST /api/chat", () => {
  it("returns 401 KDL-AUTH-003 when unauthenticated", async () => {
    const res = await POST(chatRequest({ messages: [{ role: "user", content: "hello" }] }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("KDL-AUTH-003");
  });

  it("refusal path: checkGroundedness false returns non-streamed KDL-CHAT-002 and never calls streamText", async () => {
    const cookie = await authCookieHeader();
    retrieveMock.mockResolvedValue([makeChunk()]);
    checkGroundednessMock.mockResolvedValue({
      grounded: false,
      rationale: "Not found in the corpus.",
      prefilterTopScore: 0.5,
      judged: true,
    });

    const res = await POST(
      chatRequest({ messages: [{ role: "user", content: "unanswerable question?" }] }, cookie),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.code).toBe("KDL-CHAT-002");
    expect(body.sources).toEqual([]);
    expect(streamTextMock).not.toHaveBeenCalled();
  });

  it("streaming path: content type is a stream, and data-citation parts precede any text-delta", async () => {
    const cookie = await authCookieHeader();
    const chunks = [
      makeChunk({ chunkId: "chunk-a", documentId: "doc-a" }),
      makeChunk({ chunkId: "chunk-b", documentId: "doc-b" }),
    ];
    retrieveMock.mockResolvedValue(chunks);
    checkGroundednessMock.mockResolvedValue({
      grounded: true,
      rationale: "Contains the fact.",
      prefilterTopScore: 0.85,
      judged: true,
    });
    streamTextMock.mockReturnValue({ stream: fakeTextStream() });

    const res = await POST(
      chatRequest({ messages: [{ role: "user", content: "what does the policy say?" }] }, cookie),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);

    const text = await res.text();
    const dataCitationIndex = text.indexOf('"type":"data-citation"');
    const textDeltaIndex = text.indexOf('"type":"text-delta"');

    expect(dataCitationIndex).toBeGreaterThanOrEqual(0);
    expect(textDeltaIndex).toBeGreaterThan(dataCitationIndex);

    // Citation provenance: every emitted data-citation payload's chunkId is a member of the id
    // set returned by the stubbed retrieve() for this request.
    const retrievedIds = new Set(chunks.map((c) => c.chunkId));
    const citationMatches = [...text.matchAll(/"type":"data-citation","data":(\{[^}]*\})/g)];
    expect(citationMatches.length).toBeGreaterThan(0);
    for (const match of citationMatches) {
      const data = JSON.parse(match[1]!) as { chunkId: string };
      expect(retrievedIds.has(data.chunkId)).toBe(true);
    }
  });

  it("empty corpus returns KDL-CHAT-001 without calling retrieve/groundedness", async () => {
    const cookie = await authCookieHeader();
    listDocumentsMock.mockResolvedValue([]);

    const res = await POST(chatRequest({ messages: [{ role: "user", content: "anything?" }] }, cookie));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.code).toBe("KDL-CHAT-001");
    expect(retrieveMock).not.toHaveBeenCalled();
    expect(checkGroundednessMock).not.toHaveBeenCalled();
  });
});
