/**
 * Covers plan 03-08 Task 2/3's acceptance criteria for `/api/embed/{kbId}/chat` and
 * `/api/embed/{kbId}/starters`: the three-guard order (kbId -> origin -> rate limit), each guard's
 * exact status/code, and — the test the phase is judged by (S-3, UI-STANDARDS) — a real two-request
 * multi-turn conversation against the ACTUAL public route, never `/api/chat`. This file targets
 * `/api/embed/*` exclusively; a green test against `/api/chat` satisfies nothing here (that route
 * is admin-gated and the widget cannot call it — D3-13).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RetrievedChunkWithMeta } from "../../../lib/retrieval/search.js";
import type { WidgetConfig } from "../../../lib/widget/config.js";

const testDir = mkdtempSync(join(tmpdir(), "kdl-embed-route-test-"));
process.env.DATABASE_PATH = join(testDir, "test.db");
process.env.UPLOAD_DIR = join(testDir, "uploads");
process.env.ADMIN_PASSWORD = "embed-route-test-admin-password";
process.env.GEMINI_API_KEY = "test-gemini-key";

const {
  streamTextMock,
  generateObjectMock,
  condenseQueryMock,
  retrieveMock,
  checkGroundednessMock,
  chatModelMock,
  judgeModelMock,
  getWidgetConfigMock,
  rateLimiterConsumeMock,
  fakeDriverState,
  fakeDriver,
} = vi.hoisted(() => {
  const fakeDriverState = {
    generation: 1,
    documents: [
      { id: "doc-1", filename: "policy.pdf", status: "ready", supersededBy: null },
    ] as Array<{ id: string; filename: string; status: string; supersededBy: string | null }>,
    settings: new Map<string, string>(),
  };
  return {
    streamTextMock: vi.fn(),
    generateObjectMock: vi.fn(),
    condenseQueryMock: vi.fn(async (_history: unknown, question: string) => question),
    retrieveMock: vi.fn(),
    checkGroundednessMock: vi.fn(),
    chatModelMock: vi.fn(() => ({ modelId: "fake-chat-model" })),
    judgeModelMock: vi.fn(() => ({ modelId: "fake-judge-model" })),
    getWidgetConfigMock: vi.fn(),
    rateLimiterConsumeMock: vi.fn(),
    fakeDriverState,
    fakeDriver: {
      listDocuments: vi.fn(async () => fakeDriverState.documents),
      getGeneration: vi.fn(async () => fakeDriverState.generation),
      getSetting: vi.fn(async (key: string) => fakeDriverState.settings.get(key) ?? null),
      setSetting: vi.fn(async (key: string, value: string) => {
        fakeDriverState.settings.set(key, value);
      }),
    },
  };
});

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    streamText: (...args: unknown[]) => streamTextMock(...args),
    generateObject: (...args: unknown[]) => generateObjectMock(...args),
  };
});

vi.mock("../../../lib/chat/condense.js", () => ({
  condenseQuery: (...args: [unknown, string]) => condenseQueryMock(...args),
}));

vi.mock("../../../lib/retrieval/search.js", () => ({
  retrieve: (...args: unknown[]) => retrieveMock(...args),
}));

vi.mock("../../../lib/chat/groundedness.js", () => ({
  checkGroundedness: (...args: unknown[]) => checkGroundednessMock(...args),
}));

vi.mock("../../../lib/chat/model.js", () => ({
  chatModel: () => chatModelMock(),
  judgeModel: () => judgeModelMock(),
}));

vi.mock("../../../lib/widget/config.js", () => ({
  getWidgetConfig: (...args: [string]) => getWidgetConfigMock(...args),
}));

vi.mock("../../../lib/rate-limit/index.js", () => ({
  getRateLimiter: () => ({ consume: (...args: [string]) => rateLimiterConsumeMock(...args) }),
}));

vi.mock("../../../lib/storage/index.js", () => ({
  getStorageDriver: () => fakeDriver,
}));

const { POST: chatPOST } = await import("./[kbId]/chat/route.js");
const { GET: startersGET } = await import("./[kbId]/starters/route.js");
const { AppError } = await import("../../../lib/errors.js");

afterAll(() => {
  delete process.env.DATABASE_PATH;
  delete process.env.UPLOAD_DIR;
  delete process.env.ADMIN_PASSWORD;
  delete process.env.GEMINI_API_KEY;
  rmSync(testDir, { recursive: true, force: true });
});

const ALLOWED_CONFIG: WidgetConfig = {
  productName: "Acme",
  logoUrl: null,
  accentColor: "#0E4F4A",
  position: "bottom-right",
  title: "Ask Acme",
  allowedDomains: ["example.com"],
};

beforeEach(() => {
  streamTextMock.mockReset();
  generateObjectMock.mockReset();
  condenseQueryMock.mockClear();
  retrieveMock.mockReset();
  checkGroundednessMock.mockReset();
  chatModelMock.mockClear();
  judgeModelMock.mockClear();
  getWidgetConfigMock.mockReset();
  getWidgetConfigMock.mockResolvedValue(ALLOWED_CONFIG);
  rateLimiterConsumeMock.mockReset();
  rateLimiterConsumeMock.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
  fakeDriver.listDocuments.mockClear();
  fakeDriver.getGeneration.mockClear();
  fakeDriver.getSetting.mockClear();
  fakeDriver.setSetting.mockClear();
  fakeDriverState.generation = 1;
  fakeDriverState.documents = [{ id: "doc-1", filename: "policy.pdf", status: "ready", supersededBy: null }];
  fakeDriverState.settings.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function chatContext(kbId = "default") {
  return { params: Promise.resolve({ kbId }) };
}

function chatRequest(
  body: unknown,
  { origin = "https://example.com", kbId = "default" }: { origin?: string; kbId?: string } = {},
): Request {
  return new Request(`http://localhost/api/embed/${kbId}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify(body),
  });
}

function startersRequest({
  origin = "https://example.com",
  kbId = "default",
}: { origin?: string; kbId?: string } = {}): Request {
  return new Request(`http://localhost/api/embed/${kbId}/starters`, { headers: { origin } });
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

function fakeTextStream(text: string) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue({ type: "text-start", id: "1" });
      controller.enqueue({ type: "text-delta", id: "1", text });
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

describe("POST /api/embed/{kbId}/chat — guard order and each guard's own behavior", () => {
  it("a bad kbId AND a bad origin returns KDL-WIDG-003 — proving kbId is checked first", async () => {
    const res = await chatPOST(
      chatRequest({ messages: [{ role: "user", content: "hi" }] }, { origin: "https://evil.com", kbId: "not-real" }),
      chatContext("not-real"),
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("KDL-WIDG-003");
    // If origin were checked first (or at all, for a bad kbId), getWidgetConfig would have run.
    expect(getWidgetConfigMock).not.toHaveBeenCalled();
  });

  it("rejects a non-allowlisted origin with 403 KDL-WIDG-001 and never calls the chat model", async () => {
    const res = await chatPOST(
      chatRequest({ messages: [{ role: "user", content: "hi" }] }, { origin: "https://evil.com" }),
      chatContext(),
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("KDL-WIDG-001");
    expect(chatModelMock).not.toHaveBeenCalled();
    expect(streamTextMock).not.toHaveBeenCalled();
    expect(condenseQueryMock).not.toHaveBeenCalled();
  });

  it("returns 429 with Retry-After and KDL-WIDG-002 when the rate limiter denies", async () => {
    rateLimiterConsumeMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 42 });
    const res = await chatPOST(chatRequest({ messages: [{ role: "user", content: "hi" }] }), chatContext());
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("42");
    const body = await res.json();
    expect(body.code).toBe("KDL-WIDG-002");
  });

  it("returns 503, never 200, when the limiter throws KDL-WIDG-005", async () => {
    rateLimiterConsumeMock.mockRejectedValue(new AppError("KDL-WIDG-005"));
    const res = await chatPOST(chatRequest({ messages: [{ role: "user", content: "hi" }] }), chatContext());
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe("KDL-WIDG-005");
  });

  it("returns 400 KDL-WIDG-004 for a malformed body, never a reachability code", async () => {
    const res = await chatPOST(chatRequest({ nonsense: true }), chatContext());
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("KDL-WIDG-004");
  });

  it("a grounded request streams, with data-citation parts preceding any text-delta", async () => {
    const chunks = [makeChunk({ chunkId: "chunk-a", documentId: "doc-a" })];
    retrieveMock.mockResolvedValue(chunks);
    checkGroundednessMock.mockResolvedValue({
      grounded: true,
      rationale: "Contains the fact.",
      prefilterTopScore: 0.85,
      judged: true,
    });
    streamTextMock.mockReturnValue({ stream: fakeTextStream("The answer is [1].") });

    const res = await chatPOST(
      chatRequest({ messages: [{ role: "user", content: "what does the policy say?" }] }),
      chatContext(),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    const text = await res.text();
    const dataCitationIndex = text.indexOf('"type":"data-citation"');
    const textDeltaIndex = text.indexOf('"type":"text-delta"');
    expect(dataCitationIndex).toBeGreaterThanOrEqual(0);
    expect(textDeltaIndex).toBeGreaterThan(dataCitationIndex);
  });

  it("an ungrounded request returns HTTP 200 with code KDL-CHAT-002", async () => {
    retrieveMock.mockResolvedValue([makeChunk()]);
    checkGroundednessMock.mockResolvedValue({
      grounded: false,
      rationale: "Not found in the corpus.",
      prefilterTopScore: 0.4,
      judged: true,
    });

    const res = await chatPOST(
      chatRequest({ messages: [{ role: "user", content: "unanswerable question?" }] }),
      chatContext(),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.code).toBe("KDL-CHAT-002");
    expect(body.sources).toEqual([]);
    expect(streamTextMock).not.toHaveBeenCalled();
  });
});

describe("S-3 (UI-STANDARDS): multi-turn conversation against the REAL public route", () => {
  it("a follow-up question carrying real prior turns gets a correct grounded answer on the second request", async () => {
    const chunks = [makeChunk({ chunkId: "chunk-a", documentId: "doc-a" })];
    retrieveMock.mockResolvedValue(chunks);
    checkGroundednessMock.mockResolvedValue({
      grounded: true,
      rationale: "Contains the fact.",
      prefilterTopScore: 0.9,
      judged: true,
    });

    // --- First request: a fresh question, no history yet. ---
    streamTextMock.mockReturnValue({ stream: fakeTextStream("First answer [1].") });
    const firstRes = await chatPOST(
      chatRequest({ messages: [{ role: "user", content: "What is the ladder policy?" }] }),
      chatContext(),
    );
    expect(firstRes.status).toBe(200);
    expect(firstRes.headers.get("content-type")).toMatch(/text\/event-stream/);
    expect(await firstRes.text()).toContain("First answer");

    // --- Second request: the SECOND question of the session, carrying the real prior turn. This
    // is the exact shape of Phase 2 defect 9 — a passing unit test against transport mapping, but
    // a real second request against the real route failing in production. ---
    streamTextMock.mockReturnValue({ stream: fakeTextStream("Second answer, with history [1].") });
    const secondRes = await chatPOST(
      chatRequest({
        messages: [
          { role: "user", content: "What is the ladder policy?" },
          { role: "assistant", content: "First answer [1]." },
          { role: "user", content: "Can you say more about that?" },
        ],
      }),
      chatContext(),
    );

    expect(secondRes.status).toBe(200);
    expect(secondRes.headers.get("content-type")).toMatch(/text\/event-stream/);
    const secondText = await secondRes.text();
    expect(secondText).toContain("Second answer, with history");
    const dataCitationIndex = secondText.indexOf('"type":"data-citation"');
    const textDeltaIndex = secondText.indexOf('"type":"text-delta"');
    expect(dataCitationIndex).toBeGreaterThanOrEqual(0);
    expect(textDeltaIndex).toBeGreaterThan(dataCitationIndex);

    // Proves the second request genuinely carried the prior turn through to condenseQuery (CHAT-05
    // applied to the widget's own route) — not just that a second call happened to also succeed.
    expect(condenseQueryMock).toHaveBeenCalledTimes(2);
    const secondCallHistory = condenseQueryMock.mock.calls[1]![0] as Array<{
      role: string;
      content: string;
    }>;
    expect(secondCallHistory).toEqual([
      { role: "user", content: "What is the ladder policy?" },
      { role: "assistant", content: "First answer [1]." },
    ]);
  });
});

describe("GET /api/embed/{kbId}/starters — same three guards, then the reused cache/fallback logic", () => {
  it("a bad kbId returns KDL-WIDG-003 before any origin check", async () => {
    const res = await startersGET(startersRequest({ origin: "https://evil.com", kbId: "not-real" }), chatContext("not-real"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("KDL-WIDG-003");
    expect(getWidgetConfigMock).not.toHaveBeenCalled();
  });

  it("rejects a non-allowlisted origin with 403 KDL-WIDG-001", async () => {
    const res = await startersGET(startersRequest({ origin: "https://evil.com" }), chatContext());
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("KDL-WIDG-001");
    expect(fakeDriver.listDocuments).not.toHaveBeenCalled();
  });

  it("returns 429 with Retry-After when the rate limiter denies", async () => {
    rateLimiterConsumeMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 7 });
    const res = await startersGET(startersRequest(), chatContext());
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("7");
  });

  it("returns an empty array with no model call when the corpus has no ready documents", async () => {
    fakeDriverState.documents = [];
    const res = await startersGET(startersRequest(), chatContext());
    const body = await res.json();
    expect(body.questions).toEqual([]);
    expect(generateObjectMock).not.toHaveBeenCalled();
  });

  it("caches by generation — one judge call per corpus change, not per request", async () => {
    generateObjectMock.mockResolvedValue({
      object: { questions: ["Q1?", "Q2?", "Q3?", "Q4?"] },
    });

    await startersGET(startersRequest(), chatContext());
    expect(generateObjectMock).toHaveBeenCalledTimes(1);

    await startersGET(startersRequest(), chatContext());
    expect(generateObjectMock).toHaveBeenCalledTimes(1); // cache hit

    fakeDriverState.generation = 2;
    await startersGET(startersRequest(), chatContext());
    expect(generateObjectMock).toHaveBeenCalledTimes(2); // cache miss after generation bump
  });
});
