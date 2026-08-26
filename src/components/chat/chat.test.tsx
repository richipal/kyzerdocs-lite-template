// @vitest-environment jsdom
/**
 * Covers plan 02-09's Task 1 (streaming panel + follow-up history) and Task 2 (citation chips,
 * passage viewer, starter questions) acceptance criteria in one file, per the plan's file list.
 *
 * `ChatPanel`'s custom `fetch` bridges the server's two non-streamed 200 JSON responses
 * (KDL-CHAT-001/002) into the same UI-message-stream shape a grounded answer uses (see
 * ChatPanel.tsx's own header comment) — tests below exercise that bridge with real `Response`
 * objects rather than mocking `useChat` itself, so the actual wiring is what's under test.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import type { UIMessage } from "ai";
import { ChatPanel } from "./ChatPanel.js";
import { MessageList } from "./MessageList.js";
import { CitationChips, type Source } from "./CitationChips.js";

// ---------------------------------------------------------------------------------------------
// GET /api/chat/starters — hoisted mocks so they're available inside vi.mock factories
// regardless of this file's static-import order (Vitest's own documented pattern for mixing
// static component imports with mocked server-module dependencies in a single test file).
// ---------------------------------------------------------------------------------------------

const { generateObjectMock, fakeDriverState, fakeDriver } = vi.hoisted(() => {
  const generateObjectMock = vi.fn();
  const fakeDriverState = {
    generation: 1,
    documents: [{ id: "doc-1", filename: "policy.pdf", status: "ready", supersededBy: null }] as Array<{
      id: string;
      filename: string;
      status: string;
      supersededBy: string | null;
    }>,
    settings: new Map<string, string>(),
  };
  const fakeDriver = {
    listDocuments: vi.fn(async () => fakeDriverState.documents),
    getGeneration: vi.fn(async () => fakeDriverState.generation),
    getSetting: vi.fn(async (key: string) => fakeDriverState.settings.get(key) ?? null),
    setSetting: vi.fn(async (key: string, value: string) => {
      fakeDriverState.settings.set(key, value);
    }),
  };
  return { generateObjectMock, fakeDriverState, fakeDriver };
});

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, generateObject: (...args: unknown[]) => generateObjectMock(...args) };
});

vi.mock("../../lib/storage/index.js", () => ({
  getStorageDriver: () => fakeDriver,
}));

process.env.GEMINI_API_KEY = "test-gemini-key";
process.env.ADMIN_PASSWORD = "chat-test-admin-password";

const { GET: startersGET } = await import("../../app/api/chat/starters/route.js");
const { createSession } = await import("../../lib/auth/session.js");

async function authenticatedStartersRequest(): Promise<Request> {
  const carrier = new Response();
  await createSession(carrier);
  const cookie = carrier.headers.get("set-cookie")!.split(";")[0]!;
  return new Request("http://localhost/api/chat/starters", { headers: { cookie } });
}

// ---------------------------------------------------------------------------------------------
// Shared test helpers for the ChatPanel/MessageList/CitationChips suites
// ---------------------------------------------------------------------------------------------

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A real UI-message-stream Response whose chunks are pushed on demand from the test — proves
 * ChatPanel renders progressively as chunks arrive, not only once the stream closes. */
function controlledStreamResponse() {
  let write: (chunk: Record<string, unknown>) => void = () => {};
  let finish: () => void = () => {};
  const donePromise = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const stream = createUIMessageStream({
    execute: ({ writer }) => {
      write = (chunk) => writer.write(chunk as Parameters<typeof writer.write>[0]);
      return donePromise;
    },
  });
  const response = createUIMessageStreamResponse({ stream });
  return { response, write, finish };
}

function makeFetchMock(handlers: {
  chat?: (init: RequestInit) => Response | Promise<Response>;
  starters?: () => Response | Promise<Response>;
}) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    if (url.includes("/api/chat/starters")) {
      return handlers.starters ? handlers.starters() : jsonResponse({ questions: [] });
    }
    if (url.includes("/api/chat")) {
      return handlers.chat ? handlers.chat(init ?? {}) : jsonResponse({}, 500);
    }
    throw new Error(`chat.test.tsx: unexpected fetch to ${url}`);
  });
}

function makeSource(overrides: Partial<Source> = {}): Source {
  return {
    marker: overrides.marker ?? 1,
    chunkId: overrides.chunkId ?? "chunk-1",
    documentId: overrides.documentId ?? "doc-1",
    filename: overrides.filename ?? "policy.pdf",
    page: overrides.page ?? 4,
    sectionTitle: overrides.sectionTitle ?? null,
    charStart: overrides.charStart ?? 0,
    charEnd: overrides.charEnd ?? 200,
    snippet: overrides.snippet ?? "Employees must wear a hard hat at all times on site.",
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------------
// Task 1: streaming, non-streamed responses, follow-up history
// ---------------------------------------------------------------------------------------------

describe("ChatPanel streaming (CHAT-01)", () => {
  it("renders the answer progressively — text visibly grows across at least three chunks, not buffered to completion", async () => {
    const { response, write, finish } = controlledStreamResponse();
    vi.stubGlobal("fetch", makeFetchMock({ chat: () => response }));

    render(<ChatPanel />);
    fireEvent.change(screen.getByLabelText("Ask a question"), {
      target: { value: "What is the ladder policy?" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));

    write({ type: "text-start", id: "1" });
    write({ type: "text-delta", id: "1", delta: "Employees" });
    await waitFor(() => expect(document.body.textContent ?? "").toContain("Employees"));
    const lengthAfterFirst = (document.body.textContent ?? "").length;

    write({ type: "text-delta", id: "1", delta: " must wear" });
    await waitFor(() =>
      expect((document.body.textContent ?? "").length).toBeGreaterThan(lengthAfterFirst),
    );
    const lengthAfterSecond = (document.body.textContent ?? "").length;

    write({ type: "text-delta", id: "1", delta: " a hard hat." });
    await waitFor(() =>
      expect((document.body.textContent ?? "").length).toBeGreaterThan(lengthAfterSecond),
    );

    write({ type: "text-end", id: "1" });
    finish();

    await waitFor(() =>
      expect(document.body.textContent ?? "").toContain("Employees must wear a hard hat."),
    );
  });
});

describe("ChatPanel non-streamed responses (CHAT-04)", () => {
  it("renders a KDL-CHAT-002 refusal as an assistant answer, shows the code, and does not render an error/crash state", async () => {
    vi.stubGlobal(
      "fetch",
      makeFetchMock({
        chat: () =>
          jsonResponse({
            code: "KDL-CHAT-002",
            message: "I don't have information about that in your documents.",
            action: "Rephrase the question, or upload a document that covers this topic.",
          }),
      }),
    );

    render(<ChatPanel />);
    fireEvent.change(screen.getByLabelText("Ask a question"), {
      target: { value: "What is the vehicle policy?" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));

    await waitFor(() =>
      expect(screen.getByText("I don't have information about that in your documents.")).toBeTruthy(),
    );
    expect(screen.getByText("KDL-CHAT-002")).toBeTruthy();
    expect(screen.queryByText(/something went wrong/i)).toBeNull();
  });

  it("renders a KDL-CHAT-001 empty-corpus response as a link to /documents", async () => {
    vi.stubGlobal(
      "fetch",
      makeFetchMock({
        chat: () =>
          jsonResponse({
            code: "KDL-CHAT-001",
            message: "No documents have been indexed yet.",
            action: "Upload at least one document before asking a question.",
          }),
      }),
    );

    render(<ChatPanel />);
    fireEvent.change(screen.getByLabelText("Ask a question"), { target: { value: "anything?" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));

    await waitFor(() => expect(screen.getByRole("link", { name: /upload a document/i })).toBeTruthy());
    expect(screen.getByRole("link", { name: /upload a document/i })).toHaveProperty(
      "href",
      "http://localhost:3000/documents",
    );
  });
});

describe("ChatPanel follow-up history (CHAT-05)", () => {
  it("carries every prior turn, in order, on the third request", async () => {
    const capturedBodies: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    vi.stubGlobal(
      "fetch",
      makeFetchMock({
        chat: (init) => {
          const body = JSON.parse(String(init.body)) as { messages: Array<{ role: string; content: string }> };
          capturedBodies.push(body);
          return jsonResponse({
            code: "KDL-CHAT-002",
            message: `refused turn ${capturedBodies.length}`,
            action: "Rephrase the question.",
          });
        },
      }),
    );

    render(<ChatPanel />);
    const input = screen.getByLabelText("Ask a question");
    const askButton = screen.getByRole("button", { name: "Ask" });

    fireEvent.change(input, { target: { value: "first question" } });
    fireEvent.click(askButton);
    await waitFor(() => expect(screen.getByText("refused turn 1")).toBeTruthy());

    fireEvent.change(input, { target: { value: "second question" } });
    fireEvent.click(askButton);
    await waitFor(() => expect(screen.getByText("refused turn 2")).toBeTruthy());

    fireEvent.change(input, { target: { value: "third question" } });
    fireEvent.click(askButton);
    await waitFor(() => expect(screen.getByText("refused turn 3")).toBeTruthy());

    expect(capturedBodies).toHaveLength(3);
    const thirdRequestMessages = capturedBodies[2]!.messages;
    expect(thirdRequestMessages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
    ]);
    expect(thirdRequestMessages.map((m) => m.content)).toEqual([
      "first question",
      "refused turn 1",
      "second question",
      "refused turn 2",
      "third question",
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// Task 2: citation chips, passage viewer, starter questions
// ---------------------------------------------------------------------------------------------

function assistantMessage(overrides: Partial<UIMessage> & { parts: UIMessage["parts"] }): UIMessage {
  return { id: overrides.id ?? "msg-1", role: "assistant", parts: overrides.parts };
}

describe("CitationChips (CHAT-02/03)", () => {
  it("keeps a chip for every marker, including several passages from the same document", () => {
    // Was: deduped by document, so these three became two chips and [3] had nothing to click.
    // With one uploaded file that is catastrophic — six retrieved chunks collapsed to a single chip
    // while the model wrote "[1] … [3] … [6]". The citation unit here is a chunk (a passage at a
    // location), not a file: two passages from the same policy are two pieces of evidence.
    const sources: Source[] = [
      makeSource({ marker: 1, chunkId: "c1", documentId: "doc-a", filename: "safety-manual.pdf", page: 3 }),
      makeSource({ marker: 2, chunkId: "c2", documentId: "doc-b", filename: "hr-policy.docx", page: 9 }),
      makeSource({ marker: 3, chunkId: "c3", documentId: "doc-a", filename: "safety-manual.pdf", page: 7 }),
    ];
    render(<CitationChips sources={sources} onSelect={() => {}} />);

    expect(screen.getByText("Sources (3)")).toBeTruthy();
    expect(screen.getByText(/\[1\] safety-manual\.pdf, p\. 3/)).toBeTruthy();
    expect(screen.getByText(/\[2\] hr-policy\.docx, p\. 9/)).toBeTruthy();
    expect(screen.getByText(/\[3\] safety-manual\.pdf, p\. 7/)).toBeTruthy();
  });

  it("collapses a genuine duplicate — the same marker arriving twice from vector and keyword arms", () => {
    const sources: Source[] = [
      makeSource({ marker: 1, chunkId: "c1", documentId: "doc-a", filename: "safety-manual.pdf", page: 3 }),
      makeSource({ marker: 1, chunkId: "c1", documentId: "doc-a", filename: "safety-manual.pdf", page: 3 }),
    ];
    render(<CitationChips sources={sources} onSelect={() => {}} />);
    expect(screen.getByText("Sources (1)")).toBeTruthy();
  });

  it("renders nothing for an empty sources list", () => {
    const { container } = render(<CitationChips sources={[]} onSelect={() => {}} />);
    expect(container.textContent).toBe("");
  });
});

describe("MessageList citation provenance (CHAT-02 anti-parsing)", () => {
  it("shows a chip only for markers the answer actually cites", () => {
    // Retrieval returns finalK chunks; the model cites only those supporting a claim. Chips for
    // uncited sources point at passages that back nothing in the answer, and inflate "Sources (N)".
    const messages: UIMessage[] = [
      assistantMessage({
        parts: [
          { type: "text", text: "Ladders must be inspected [1] and stored dry [3]." },
          { type: "data-citation", data: makeSource({ marker: 1, chunkId: "c1", filename: "a.pdf" }) },
          { type: "data-citation", data: makeSource({ marker: 2, chunkId: "c2", filename: "a.pdf" }) },
          { type: "data-citation", data: makeSource({ marker: 3, chunkId: "c3", filename: "a.pdf" }) },
        ],
      }),
    ];
    render(<MessageList messages={messages} />);
    // Server markers 1 and 3 are cited; 2 is not. The two survivors are renumbered [1] and [2] for
    // display, so the reader never sees a gap — but only two chips exist, not three.
    expect(screen.getByText("Sources (2)")).toBeTruthy();
    expect(screen.queryByText(/\[3\]/)).toBeNull();
  });

  it("renumbers citations 1..N per answer and rewrites the answer text to match", () => {
    // A model citing the 3rd and 5th retrieved chunks previously rendered [3] and [5] with no
    // [1], [2] or [4] anywhere — correct links, arbitrary-looking numbering.
    const messages: UIMessage[] = [
      assistantMessage({
        parts: [
          { type: "text", text: "Inspect first [3]. Store dry [5]." },
          { type: "data-citation", data: makeSource({ marker: 3, chunkId: "c3", filename: "a.pdf" }) },
          { type: "data-citation", data: makeSource({ marker: 5, chunkId: "c5", filename: "b.pdf" }) },
        ],
      }),
    ];
    const { container } = render(<MessageList messages={messages} />);
    expect(container.textContent).toContain("Inspect first [1].");
    expect(container.textContent).toContain("Store dry [2].");
    expect(container.textContent).not.toContain("[3]");
    expect(container.textContent).not.toContain("[5]");
  });

  it("falls back to showing every source when the answer cites no markers at all", () => {
    const messages: UIMessage[] = [
      assistantMessage({
        parts: [
          { type: "text", text: "A summary with no bracket markers." },
          { type: "data-citation", data: makeSource({ marker: 1, chunkId: "c1", filename: "a.pdf" }) },
        ],
      }),
    ];
    render(<MessageList messages={messages} />);
    expect(screen.getByText("Sources (1)")).toBeTruthy();
  });

  it("renders no chip and does not throw when text contains a bracket marker with no matching citation part", () => {
    const messages: UIMessage[] = [
      assistantMessage({ parts: [{ type: "text", text: "The maximum height is 6 feet [9]." }] }),
    ];
    expect(() => render(<MessageList messages={messages} />)).not.toThrow();
    expect(screen.queryByText(/Sources \(/)).toBeNull();
    expect(screen.getByText(/The maximum height is 6 feet \[9\]\./)).toBeTruthy();
  });
});

describe("PassageViewer (CHAT-03)", () => {
  it("clicking a citation chip shows the passage in place, without calling window.open", () => {
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    const source = makeSource({
      marker: 1,
      filename: "ladder-safety.pdf",
      page: 4,
      sectionTitle: "Section 3: Ladder Height Limits",
      snippet: "Ladders must not exceed 20 feet in extended height without additional bracing.",
    });
    const messages: UIMessage[] = [
      assistantMessage({
        parts: [
          { type: "text", text: "The maximum ladder height is 20 feet [1]." },
          { type: "data-citation", data: source } as UIMessage["parts"][number],
        ],
      }),
    ];

    render(<MessageList messages={messages} />);
    fireEvent.click(screen.getByTitle("ladder-safety.pdf"));

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText(source.snippet)).toBeTruthy();
    expect(screen.getByText(/Section 3: Ladder Height Limits/)).toBeTruthy();
    expect(screen.getByText(/characters 0–200/)).toBeTruthy();
    expect(openSpy).not.toHaveBeenCalled();
  });
});

describe("PassageViewer position (bug fix regression — panel appeared below the whole transcript)", () => {
  it("renders the passage viewer immediately beneath the message whose chip was clicked, not after the whole transcript", () => {
    const source = makeSource({ marker: 1, filename: "ladder-safety.pdf" });
    const messages: UIMessage[] = [
      assistantMessage({
        id: "msg-1",
        parts: [
          { type: "text", text: "First answer [1]." },
          { type: "data-citation", data: source } as UIMessage["parts"][number],
        ],
      }),
      assistantMessage({ id: "msg-2", parts: [{ type: "text", text: "Second answer, no citations." }] }),
    ];

    render(<MessageList messages={messages} />);
    fireEvent.click(screen.getByTitle("ladder-safety.pdf"));

    const dialog = screen.getByRole("dialog");
    const secondAnswer = screen.getByText("Second answer, no citations.");
    // The dialog must precede the second message in document order — i.e. it renders inline
    // under the first message (where the click happened), never appended after the transcript.
    // eslint-disable-next-line no-bitwise
    expect(dialog.compareDocumentPosition(secondAnswer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("switches the panel to a newly clicked chip, and closes it when the same chip is clicked again", () => {
    const sourceA = makeSource({
      marker: 1,
      chunkId: "chunk-a",
      documentId: "doc-a",
      filename: "a.pdf",
      snippet: "Snippet A content",
    });
    const sourceB = makeSource({
      marker: 2,
      chunkId: "chunk-b",
      documentId: "doc-b",
      filename: "b.pdf",
      snippet: "Snippet B content",
    });
    const messages: UIMessage[] = [
      assistantMessage({
        parts: [
          { type: "text", text: "Answer [1][2]." },
          { type: "data-citation", data: sourceA } as UIMessage["parts"][number],
          { type: "data-citation", data: sourceB } as UIMessage["parts"][number],
        ],
      }),
    ];

    render(<MessageList messages={messages} />);

    fireEvent.click(screen.getByTitle("a.pdf"));
    expect(screen.getByText("Snippet A content")).toBeTruthy();

    fireEvent.click(screen.getByTitle("b.pdf"));
    expect(screen.getByText("Snippet B content")).toBeTruthy();
    expect(screen.queryByText("Snippet A content")).toBeNull();

    fireEvent.click(screen.getByTitle("b.pdf"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("GET /api/chat/starters (CHAT-06)", () => {
  beforeEach(() => {
    generateObjectMock.mockReset();
    fakeDriver.listDocuments.mockClear();
    fakeDriver.getGeneration.mockClear();
    fakeDriver.getSetting.mockClear();
    fakeDriver.setSetting.mockClear();
    fakeDriverState.generation = 1;
    fakeDriverState.documents = [{ id: "doc-1", filename: "policy.pdf", status: "ready", supersededBy: null }];
    fakeDriverState.settings.clear();
  });

  it("calls the judge model exactly once across repeated requests at the same generation, and again after the generation bumps", async () => {
    generateObjectMock.mockResolvedValue({
      object: {
        questions: [
          "What is the vacation policy?",
          "How do I request time off?",
          "What is the dress code?",
          "Who do I contact for IT support?",
        ],
      },
    });

    const first = await startersGET(await authenticatedStartersRequest());
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { questions: string[] };
    expect(firstBody.questions).toHaveLength(4);
    expect(generateObjectMock).toHaveBeenCalledTimes(1);

    const second = await startersGET(await authenticatedStartersRequest());
    const secondBody = (await second.json()) as { questions: string[] };
    expect(secondBody.questions).toEqual(firstBody.questions);
    expect(generateObjectMock).toHaveBeenCalledTimes(1); // still one — cache hit

    fakeDriverState.generation = 2;
    await startersGET(await authenticatedStartersRequest());
    expect(generateObjectMock).toHaveBeenCalledTimes(2); // cache miss after generation bump
  });

  it("returns an empty array with no model call when the corpus has no ready documents", async () => {
    fakeDriverState.documents = [];

    const res = await startersGET(await authenticatedStartersRequest());
    const body = (await res.json()) as { questions: string[] };

    expect(body.questions).toEqual([]);
    expect(generateObjectMock).not.toHaveBeenCalled();
  });

  it("returns between 3 and 5 starter questions inclusive", async () => {
    generateObjectMock.mockResolvedValue({
      object: { questions: ["Q1?", "Q2?", "Q3?", "Q4?"] },
    });

    const res = await startersGET(await authenticatedStartersRequest());
    const body = (await res.json()) as { questions: string[] };

    expect(body.questions.length).toBeGreaterThanOrEqual(3);
    expect(body.questions.length).toBeLessThanOrEqual(5);
  });

  it("rejects an unauthenticated request", async () => {
    const res = await startersGET(new Request("http://localhost/api/chat/starters"));
    expect(res.status).toBe(401);
  });
});
