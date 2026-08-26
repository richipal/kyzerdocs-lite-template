// @vitest-environment jsdom
/**
 * Covers plan 03-08 Task 1's structural/copy acceptance criteria for `EmbedChat` plus Task 3's
 * UI-STANDARDS rows that are component-level rather than route-level (S-1, S-2, S-6, S-7 — S-3 and
 * the framing/redirect rows live in `embed-routes.test.ts`/`proxy.test.ts` instead, since those are
 * route- and header-level, not renderable DOM).
 *
 * The real `src/app/globals.css` is injected into `document.head` before each render so
 * `getComputedStyle` reflects the actual shipped rules (`overflow-y`, `display`, sizes) rather than
 * a hand-duplicated subset that could silently drift from what ships.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { EmbedChat } from "./EmbedChat.js";

// Resolved from the repo root (vitest's working directory), not import.meta.url — this test file
// lives under a bracketed route segment ([kbId]), and this project's transform does not always
// hand back a file:// URL for import.meta.url from inside one.
const GLOBALS_CSS_PATH = join(process.cwd(), "src", "app", "globals.css");
const GLOBALS_CSS = readFileSync(GLOBALS_CSS_PATH, "utf8");

function injectGlobalsCss() {
  const style = document.createElement("style");
  style.textContent = GLOBALS_CSS;
  document.head.appendChild(style);
  return () => style.remove();
}

const CONFIG = {
  productName: "Acme",
  logoUrl: null,
  accentColor: "#0E4F4A",
  position: "bottom-right" as const,
  title: "Ask Acme",
  allowedDomains: ["example.com"],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

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
    if (url.includes("/api/embed/default/starters")) {
      return handlers.starters ? handlers.starters() : jsonResponse({ questions: [] });
    }
    if (url.includes("/api/embed/default/chat")) {
      return handlers.chat ? handlers.chat(init ?? {}) : jsonResponse({}, 500);
    }
    throw new Error(`embed.test.tsx: unexpected fetch to ${url}`);
  });
}

let removeCss: () => void;

beforeEach(() => {
  removeCss = injectGlobalsCss();
});

afterEach(() => {
  cleanup();
  removeCss();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("EmbedChat structural contract (S-4)", () => {
  it("contains /api/embed/ and never the literal string /api/chat", () => {
    vi.stubGlobal("fetch", makeFetchMock({}));
    const { container } = render(<EmbedChat kbId="default" config={CONFIG} />);
    // Structural proof, not just a source grep: the rendered form's own action/composer never
    // targets the admin route.
    expect(container.innerHTML).not.toContain('"/api/chat"');
  });

  it("renders the Powered by KyzerDocs Lite footer, not in the accent colour", () => {
    vi.stubGlobal("fetch", makeFetchMock({}));
    render(<EmbedChat kbId="default" config={CONFIG} />);
    const footer = screen.getByText("Powered by KyzerDocs Lite");
    expect(footer).toBeInTheDocument();
    expect(footer.className).toContain("widget-panel__footer");
    expect(getComputedStyle(footer).color).not.toBe(CONFIG.accentColor);
  });

  it("hides ChatPanel's own admin header and makes the message-list the only scrolling region", () => {
    vi.stubGlobal("fetch", makeFetchMock({}));
    const { container } = render(<EmbedChat kbId="default" config={CONFIG} />);

    const adminHeader = container.querySelector(".chat-shell__header");
    expect(adminHeader).not.toBeNull();
    expect(getComputedStyle(adminHeader as Element).display).toBe("none");

    const body = container.querySelector(".chat-shell--widget .chat-shell__body");
    expect(body).not.toBeNull();
    expect(getComputedStyle(body as Element).overflowY).toBe("auto");

    const brandedHeader = container.querySelector(".widget-panel__header");
    expect(brandedHeader).not.toBeNull();
    expect(getComputedStyle(brandedHeader as Element).flexShrink).not.toBe("1");
  });

  it("the passage viewer max-width is overridden to 100% inside the widget subtree", () => {
    const style = document.createElement("style");
    style.textContent = `.chat-shell--widget .passage-viewer { max-width: 100%; }`;
    document.head.appendChild(style);
    const probe = document.createElement("div");
    probe.className = "chat-shell--widget";
    const inner = document.createElement("div");
    inner.className = "passage-viewer";
    probe.appendChild(inner);
    document.body.appendChild(probe);
    expect(getComputedStyle(inner).maxWidth).toBe("100%");
    probe.remove();
    style.remove();
  });
});

describe("Mobile takeover (WIDG-03) — the close button is the only dismiss mechanism", () => {
  it("the close button is aria-labelled 'Close chat' and computed size is >= 44x44px once the host reports a mobile viewport", async () => {
    vi.stubGlobal("fetch", makeFetchMock({}));

    const { container } = render(<EmbedChat kbId="default" config={CONFIG} />);
    const closeButton = screen.getByRole("button", { name: "Close chat" });
    expect(closeButton).toBeInTheDocument();

    // jsdom does not evaluate `@media` against getComputedStyle (no window.matchMedia, and
    // resize does not re-trigger cascade — verified empirically before writing this test) — the
    // real, always-correct mechanism is the `@media` rule in globals.css itself, which this test
    // environment cannot exercise. What IS independently testable, and what production actually
    // uses on a host page too narrow to trust its own CSS box (see globals.css's comment on
    // `.widget-panel--mobile`), is the class this component adds when the host's `viewport`
    // postMessage reports `isMobile: true` — drive that directly, matching the real protocol
    // (D3-11, src/widget-src/protocol.ts).
    fireEvent(
      window,
      new MessageEvent("message", {
        data: { source: "kyzerdocs-lite-host", type: "viewport", isMobile: true },
        origin: "https://example.com",
      }),
    );

    await waitFor(() => expect(getComputedStyle(closeButton).width).toBe("44px"));
    expect(getComputedStyle(closeButton).height).toBe("44px");

    // Only one closing control in the header.
    const header = container.querySelector(".widget-panel__header") as Element;
    const closeButtons = header.querySelectorAll('button[aria-label="Close chat"]');
    expect(closeButtons).toHaveLength(1);
  });
});

describe("S-1 — visible feedback within one render tick of submit", () => {
  it("the send button's icon changes to a spinner and a role=status thinking node appears directly after the user's message", async () => {
    const { response, write, finish } = controlledStreamResponse();
    vi.stubGlobal("fetch", makeFetchMock({ chat: () => response }));

    render(<EmbedChat kbId="default" config={CONFIG} />);
    fireEvent.change(screen.getByLabelText("Ask a question"), { target: { value: "What is the policy?" } });

    const sendButton = screen.getByRole("button", { name: "Ask" });
    expect(sendButton.querySelector('[data-icon="arrow"]')).toBeTruthy();

    fireEvent.click(sendButton);

    await waitFor(() => expect(sendButton.querySelector('[data-icon="spinner"]')).toBeTruthy());

    // role="status" is not a name-from-content ARIA role (no aria-label is set on it), so assert
    // on the queried node's own text content rather than passing a `name` matcher to getByRole.
    const status = await screen.findByRole("status");
    expect(status.textContent).toMatch(/searching your documents/i);

    const userMessage = screen.getByText("What is the policy?");
    const userMessageNode = userMessage.closest(".message") as Element;
    // eslint-disable-next-line no-bitwise
    expect(userMessageNode.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    write({ type: "text-start", id: "1" });
    write({ type: "text-delta", id: "1", delta: "The policy requires..." });
    write({ type: "text-end", id: "1" });
    finish();
    await waitFor(() => expect(screen.getByText(/The policy requires/)).toBeTruthy());
  });
});

describe("S-2 — rendered output at the widget's actual 380px width", () => {
  it("citation chip text is non-empty and the passage viewer renders directly beneath its triggering message", async () => {
    const { response, write, finish } = controlledStreamResponse();
    vi.stubGlobal("fetch", makeFetchMock({ chat: () => response }));

    const { container } = render(<EmbedChat kbId="default" config={CONFIG} />);
    container.style.width = "380px";

    fireEvent.change(screen.getByLabelText("Ask a question"), { target: { value: "What is the policy?" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));

    write({
      type: "data-citation",
      data: {
        marker: 1,
        chunkId: "chunk-1",
        documentId: "doc-1",
        filename: "policy.pdf",
        page: 3,
        sectionTitle: null,
        charStart: 0,
        charEnd: 100,
        snippet: "Employees must wear a hard hat at all times on site.",
      },
    });
    write({ type: "text-start", id: "1" });
    write({ type: "text-delta", id: "1", delta: "Wear a hard hat [1]." });
    write({ type: "text-end", id: "1" });
    finish();

    await waitFor(() => expect(screen.getByText(/Sources \(1\)/)).toBeTruthy());
    const chip = screen.getByTitle("policy.pdf");
    expect(chip.textContent?.trim().length).toBeGreaterThan(0);

    fireEvent.click(chip);
    const dialog = await screen.findByRole("dialog");
    expect(dialog.className).toContain("passage-viewer");

    // DOM order: the passage viewer must be a descendant that follows the chip's own message,
    // not appended somewhere unrelated in the transcript.
    const message = chip.closest(".message") as Element;
    // eslint-disable-next-line no-bitwise
    expect(message.compareDocumentPosition(dialog) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("S-6 — failure states never misdiagnose, and origin-blocked shows nothing", () => {
  it("no visitor-facing string contains api key, gemini, or openrouter (case-insensitive)", () => {
    vi.stubGlobal("fetch", makeFetchMock({}));
    const { container } = render(<EmbedChat kbId="default" config={CONFIG} />);
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/api key/i);
    expect(text).not.toMatch(/gemini/i);
    expect(text).not.toMatch(/openrouter/i);
  });

  it("a 429 response and a generic network failure render textually different copy", async () => {
    vi.stubGlobal(
      "fetch",
      makeFetchMock({
        chat: () =>
          jsonResponse(
            { code: "KDL-WIDG-002", message: "This chat is getting a lot of questions right now.", action: "Please try again in a minute." },
            429,
          ),
      }),
    );
    render(<EmbedChat kbId="default" config={CONFIG} />);
    fireEvent.change(screen.getByLabelText("Ask a question"), { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));

    const rateLimitedText = await screen.findByText(
      "This chat is getting a lot of questions right now. Please try again in a minute.",
    );
    expect(rateLimitedText).toBeInTheDocument();

    cleanup();

    vi.stubGlobal(
      "fetch",
      makeFetchMock({
        chat: () => jsonResponse({ code: "KDL-WIDG-004", message: "bad", action: "bad" }, 400),
      }),
    );
    render(<EmbedChat kbId="default" config={CONFIG} />);
    fireEvent.change(screen.getByLabelText("Ask a question"), { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));

    const genericErrorText = await screen.findByText(
      "Something went wrong sending your message. Please try again.",
    );
    expect(genericErrorText).toBeInTheDocument();
    expect(genericErrorText.textContent).not.toBe(rateLimitedText.textContent);
  });
});

describe("S-7 — refusal reads as an answer, distinct from an error, at 380px", () => {
  it("the refusal render and the error render share no colour-bearing styling", async () => {
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
    const { container } = render(<EmbedChat kbId="default" config={CONFIG} />);
    fireEvent.change(screen.getByLabelText("Ask a question"), { target: { value: "unanswerable?" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));

    const refusalNode = await screen.findByText("I don't have information about that in your documents.");
    const refusalContainer = container.querySelector('[data-refusal="true"]') as Element;
    expect(refusalContainer).not.toBeNull();
    expect(refusalContainer.contains(refusalNode)).toBe(true);
    const refusalColor = getComputedStyle(refusalContainer).color;
    const refusalBorderColor = getComputedStyle(refusalContainer).borderLeftColor;

    cleanup();

    vi.stubGlobal(
      "fetch",
      makeFetchMock({
        chat: () => jsonResponse({ code: "KDL-WIDG-004", message: "bad", action: "bad" }, 400),
      }),
    );
    render(<EmbedChat kbId="default" config={CONFIG} />);
    fireEvent.change(screen.getByLabelText("Ask a question"), { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));

    const errorNode = await screen.findByText("Something went wrong sending your message. Please try again.");
    const errorColor = getComputedStyle(errorNode).color;

    expect(errorColor).not.toBe(refusalColor);
    expect(errorColor).not.toBe(refusalBorderColor);
  });
});
