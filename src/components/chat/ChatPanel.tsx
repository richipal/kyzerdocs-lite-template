"use client";

/**
 * Screen 2's core: CHAT-01 (progressive streaming) + CHAT-05 (follow-up history) via `useChat`
 * (@ai-sdk/react) pointed at POST /api/chat. History is session-scoped and lives only in this
 * component's React state — no browser-side persisted storage, no persistence table (CHATD-01 is
 * v2 scope, T-02-09-03 accepts this deliberately).
 *
 * The server (plan 02-07) returns three distinct response shapes, all HTTP 200 except the auth
 * gate: a streamed UI-message response for a grounded answer, or a single non-streamed JSON body
 * for KDL-CHAT-001 (empty corpus) / KDL-CHAT-002 (refusal). `useChat`'s `DefaultChatTransport`
 * always parses `response.body` as an SSE UI-message-chunk stream (see
 * node_modules/ai/src/ui/default-chat-transport.ts), so the two non-streamed 200 bodies are
 * bridged here — via a custom `fetch` — into the identical stream shape the server already uses
 * for a grounded answer: one short assistant text part plus a `data-refusal`/`data-empty-corpus`
 * part carrying the original `{code, message, action}` untouched. Every field MessageList renders
 * for these two cases is read straight off that AppError JSON; nothing here invents copy. A 401 is
 * left to throw (`HttpChatTransport`'s own `!response.ok` path) — `onError` below inspects the
 * thrown message for `KDL-AUTH-003` and sends the user to `/login`.
 *
 * Plan 03-08 (WIDG-01/02/03/05/06) reuses this component, unmodified in composition, for the
 * public embed page: `apiPath` + `variant` together parameterise the transport's `api` value and
 * the starters fetch (see the `ChatPanel` prop docs below for exactly how) so the SAME component
 * points at `/api/embed/{kbId}/chat` instead of `/api/chat`, and `variant` also sets a root class
 * name (`chat-shell--widget`) so widget-specific CSS can target the subtree — see `globals.css`'s
 * widget section. `prepareSendMessagesRequest`'s content-less-message filter below is
 * byte-identical to Phase 2: it is the fix for Phase 2 defect 9 (every second question failing),
 * and removing or reimplementing it reintroduces that failure on the widget's new route.
 *
 * Two further additions exist ONLY for S-1/S-6 (UI-STANDARDS, binding on this phase) and are
 * documented as deviations in 03-08-SUMMARY.md, since the plan's own text scoped this component's
 * diff to "api value plumbing plus two props": (1) the submit button always renders an SVG icon
 * (arrow, swapped for a spinner while busy) instead of bare text, because S-1 requires a test-
 * assertable rendered icon change, not just a `disabled` attribute; (2) `variant === "widget"`
 * selects distinct, true copy for a rate-limited (429) vs. a generic network/malformed failure,
 * because S-6 requires those two to read as different, true messages — a single hardcoded string
 * cannot satisfy that for both audiences at once.
 */

import { DefaultChatTransport, createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { useChat } from "@ai-sdk/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { MessageList } from "./MessageList.js";
import { StarterQuestions } from "./StarterQuestions.js";

interface ChatErrorBody {
  code: string;
  message: string;
  action: string;
}

function isChatErrorBody(value: unknown): value is ChatErrorBody {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).code === "string" &&
    typeof (value as Record<string, unknown>).message === "string" &&
    typeof (value as Record<string, unknown>).action === "string"
  );
}

/** Wraps a non-streamed 200 JSON body (KDL-CHAT-001/002) in the same UI-message-stream shape the
 * server produces for a grounded answer, so it flows through useChat's normal message model. */
function buildSyntheticResponse(body: ChatErrorBody): Response {
  const partType = body.code === "KDL-CHAT-001" ? "data-empty-corpus" : "data-refusal";
  const stream = createUIMessageStream({
    execute: ({ writer }) => {
      writer.write({ type: partType, data: body });
      writer.write({ type: "text-start", id: "1" });
      writer.write({ type: "text-delta", id: "1", delta: body.message });
      writer.write({ type: "text-end", id: "1" });
    },
  });
  return createUIMessageStreamResponse({ stream });
}

async function chatFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, init);
  const contentType = response.headers.get("content-type") ?? "";
  if (response.ok && contentType.includes("application/json")) {
    const body: unknown = await response.clone().json();
    if (isChatErrorBody(body)) {
      return buildSyntheticResponse(body);
    }
  }
  return response;
}

function isTextPart(part: { type: string }): part is { type: "text"; text: string } {
  return part.type === "text";
}

export function ChatPanel({
  apiPath = "/api/chat",
  variant = "admin",
}: {
  /** The starters-fetch base, always — `${apiPath}/starters` (admin: `/api/chat/starters`;
   * widget: `/api/embed/{kbId}/starters`, per the Public route contract). For admin, `apiPath`
   * ("/api/chat") is ALSO the exact chat transport target, since the admin chat route has no
   * further path segment. For widget, `apiPath` ("/api/embed/{kbId}") is a BASE — the real chat
   * route is a sibling of starters under it (`/api/embed/{kbId}/chat`), not the value itself — so
   * `variant` (below) selects whether `/chat` is appended before it becomes the transport target.
   * This is a structural difference in the two route families' own shapes (widget: chat/starters
   * are siblings under a kbId base; admin: starters is nested one segment under chat itself), not
   * a convenience — a single `${apiPath}/starters` formula happens to also be correct for the
   * chat target only in the admin case. */
  apiPath?: string;
  /** Sets a root class name (`chat-shell--widget`) AND selects the `/chat` suffix rule above —
   * see this file's header comment for why both are driven by the same value. */
  variant?: "admin" | "widget";
} = {}) {
  const chatEndpoint = variant === "widget" ? `${apiPath}/chat` : apiPath;
  const [input, setInput] = useState("");
  // Real count, read from the same GET /api/documents every other screen already calls — the
  // design template's "Answers are drawn only from your {N} documents" subtitle, wired to actual
  // data rather than left as a placeholder count.
  const [docCount, setDocCount] = useState<number | null>(null);

  useEffect(() => {
    // The widget's own branded header (EmbedChat.tsx) replaces this one entirely — CSS hides
    // `.chat-shell__header` under `.chat-shell--widget` (globals.css), so `docCount` is never
    // rendered there. Skip the fetch rather than sending a stranger's browser an unauthenticated
    // request to an admin-gated route (`/api/documents`) for a value nothing will display.
    if (variant === "widget") return;
    let cancelled = false;
    fetch("/api/documents", { method: "GET" })
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { documents: unknown[] } | null) => {
        if (!cancelled && body) setDocCount(body.documents.length);
      })
      .catch(() => {
        // Header subtitle count is a nice-to-have readout; a failed fetch just leaves it blank.
      });
    return () => {
      cancelled = true;
    };
  }, [variant]);

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: chatEndpoint,
        fetch: chatFetch,
        // Bridges useChat's UIMessage[] (parts-based) shape to the server's { role, content }[]
        // contract (plan 02-07's requestSchema) — this is also what carries full history forward
        // on every follow-up request (CHAT-05).
        prepareSendMessagesRequest: ({ api, messages, body, headers, credentials }) => ({
          api,
          headers,
          credentials,
          body: {
            ...body,
            /*
              Drop content-less messages before serializing history.

              The chat route writes every `data-citation` part and THEN merges the model stream, and
              that merge starts a fresh message — so each answer leaves behind an assistant message
              carrying only citations and no text. Serialized, its `content` is "", which the route's
              `requestSchema` rejects (`z.string().min(1)`). The whole body then failed validation,
              so the SECOND question of any session died with KDL-CHAT-003 — surfaced to the user as
              "Something went wrong reaching the chat model", though the model was never reached.

              Dropping them loses nothing: citations are retrieval metadata, not dialogue, and the
              model already received the source excerpts as context on the turn that produced them.
            */
            messages: messages
              .map((m) => ({
                role: m.role === "user" ? ("user" as const) : ("assistant" as const),
                content: m.parts.filter(isTextPart).map((p) => p.text).join(""),
              }))
              .filter((m) => m.content.trim().length > 0),
          },
        }),
      }),
    [chatEndpoint],
  );

  // Widget-only (S-6): a 429 and a generic network/malformed failure must read as different, true
  // messages. `err.message` carries the raw response body text on any non-ok response (same
  // mechanism the KDL-AUTH-003 check below already relies on), so the widget's registered WIDG-002
  // code is distinguishable without a new endpoint or transport change.
  const [structuredError, setStructuredError] = useState<ChatErrorBody | null>(null);

  const { messages, sendMessage, setMessages, status, error } = useChat({
    transport,
    onError: (err) => {
      setStructuredError(null);
      try {
        const parsed: unknown = JSON.parse(err.message);
        if (isChatErrorBody(parsed)) {
          if (parsed.code === "KDL-AUTH-003") {
            window.location.href = "/login";
            return;
          }
          setStructuredError(parsed);
        }
      } catch {
        // Not a structured AppError body — fall through to the generic error state below.
      }
    },
  });

  function submit(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    void sendMessage({ text: trimmed });
    setInput("");
  }

  const isBusy = status === "streaming" || status === "submitted";
  /*
    True from the moment a question is sent until the first assistant token actually arrives.
    `isBusy` alone stays true for the whole stream, which would leave the indicator sitting under a
    visibly-streaming answer.
  */
  /*
    Clicking a suggestion bubble part-way up the transcript would otherwise leave the buyer staring
    at the answer they just finished reading while the new one renders below the fold — the same
    class of "nothing happened" the citation panel had.
  */
  const bottomRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    // jsdom does not implement scrollIntoView, and a missing scroll must never take the panel
    // down with it — this is presentation, not behaviour.
    bottomRef.current?.scrollIntoView?.({ behavior: "smooth", block: "end" });
  }, [messages.length, status]);

  const lastMessage = messages[messages.length - 1];
  const awaitingAnswer =
    isBusy &&
    (!lastMessage ||
      lastMessage.role === "user" ||
      !lastMessage.parts.some((p) => p.type === "text" && p.text.length > 0));

  return (
    <div className={variant === "widget" ? "chat-shell chat-shell--widget" : "chat-shell"}>
      <header className="chat-shell__header">
        <div>
          <div className="chat-shell__title">Ask the knowledge base</div>
          <div className="chat-shell__subtitle">
            Answers are drawn only from your {docCount ?? "—"} document{docCount === 1 ? "" : "s"}.
          </div>
        </div>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => {
            setMessages([]);
            setInput("");
          }}
          disabled={messages.length === 0}
        >
          New thread
        </button>
      </header>

      <div className="chat-shell__body">
        {messages.length === 0 ? (
          <StarterQuestions onSelect={submit} variant={variant} startersPath={`${apiPath}/starters`} />
        ) : (
          <>
            <MessageList messages={messages} onAsk={submit} />
            {/*
              This product has a genuinely long pre-token gap that most chat UIs do not: a click
              triggers retrieval, then the CHAT-04 groundedness judge (a full model call), and only
              then does generation begin streaming. Disabling the composer at the bottom is not
              feedback a buyer notices when they just clicked a suggestion bubble further up, so the
              wait is shown where they are looking.
            */}
            {awaitingAnswer ? (
              <div className="thinking" role="status" aria-live="polite">
                <span className="thinking__dots" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </span>
                <span className="thinking__label">Searching your documents…</span>
              </div>
            ) : null}
            <div ref={bottomRef} />
            {/*
              No generic starters here. CHAT-06's cached set is corpus-wide and identical on every
              turn; the model's own follow-ups (rendered per-message by MessageList) are grounded in
              the excerpts that produced *this* answer, so they are strictly more useful. Showing
              both gave the buyer two competing suggestion lists, the weaker one last.
            */}
          </>
        )}

        {error ? (
          <p role="status" className="chat-error">
            {variant === "widget"
              ? structuredError?.code === "KDL-WIDG-002"
                ? "This chat is getting a lot of questions right now. Please try again in a minute."
                : "Something went wrong sending your message. Please try again."
              : "Something went wrong reaching the chat model. Please try again."}
          </p>
        ) : null}
      </div>

      <div className="chat-shell__composer-area">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit(input);
          }}
          className="chat-composer"
        >
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask about your documents"
            aria-label="Ask a question"
            disabled={isBusy}
            className="chat-composer__input"
          />
          {/*
            S-1 (UI-STANDARDS, binding): "shows a loading state" isn't enough — the acceptance
            criterion is a rendered icon that changes, not merely a `disabled` attribute. The
            visible "Ask" text stays (so this button's accessible name is unchanged from Phase 2),
            but a data-icon-bearing SVG swaps from an arrow to a spinner the instant `isBusy` flips.
          */}
          <button type="submit" disabled={isBusy || input.trim().length === 0} className="chat-composer__submit">
            {isBusy ? (
              <svg
                aria-hidden="true"
                data-icon="spinner"
                className="btn-icon btn-icon--spin"
                viewBox="0 0 24 24"
                width="14"
                height="14"
              >
                <circle
                  cx="12"
                  cy="12"
                  r="9"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeDasharray="42 14"
                />
              </svg>
            ) : (
              <svg
                aria-hidden="true"
                data-icon="arrow"
                className="btn-icon"
                viewBox="0 0 24 24"
                width="14"
                height="14"
              >
                <path
                  d="M4 12h15M13 6l6 6-6 6"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            )}
            <span>Ask</span>
          </button>
        </form>
        <p className="chat-shell__hint">
          If the documents do not answer a question, the assistant says so instead of guessing.
        </p>
      </div>
    </div>
  );
}
