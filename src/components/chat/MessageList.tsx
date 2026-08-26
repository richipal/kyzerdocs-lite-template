"use client";

/**
 * Renders the message transcript. Assistant messages surface exactly what the server (or
 * ChatPanel's non-streamed-response bridge, see ChatPanel.tsx) attached: `data-citation` parts
 * become `CitationChips` (CHAT-02/03), a `data-refusal` part renders CHAT-04's refusal as a calm,
 * deliberate answer rather than an error/crash state, and a `data-empty-corpus` part renders the
 * upload prompt with a link to `/documents`. Nothing here parses citation markers, "Sources:"
 * text, or URLs out of message text.
 */

import { useState } from "react";
import Markdown from "react-markdown";
import { splitFollowups } from "../../lib/chat/followups.js";
import type { UIMessage } from "ai";
import { CitationChips, type Source } from "./CitationChips.js";
import { PassageViewer } from "./PassageViewer.js";

interface ChatErrorBody {
  code: string;
  message: string;
  action: string;
}

function isTextPart(part: UIMessage["parts"][number]): part is { type: "text"; text: string } {
  return part.type === "text";
}

function textOf(message: UIMessage): string {
  return message.parts.filter(isTextPart).map((p) => p.text).join("");
}

function citationsOf(message: UIMessage): Source[] {
  return message.parts
    .filter((p): p is { type: "data-citation"; id?: string; data: Source } => p.type === "data-citation")
    .map((p) => p.data);
}

function dataPartOf(message: UIMessage, type: "data-refusal" | "data-empty-corpus"): ChatErrorBody | null {
  const part = message.parts.find((p) => p.type === type) as
    | { type: string; data: ChatErrorBody }
    | undefined;
  return part ? part.data : null;
}

/** Template's small mono "who" label above every bubble ("You" / "Assistant"). */
function whoLabel(message: UIMessage): string {
  return message.role === "user" ? "You" : "Assistant";
}

/** The passage viewer is keyed to *both* the message it was opened from and the chunk it shows —
 * so it renders inline directly beneath that message's citation chips (never appended after the
 * whole transcript, which is what made the original click look inert), switches when a different
 * chip is clicked, and closes when the same chip is clicked again. */
interface ActivePassage {
  messageId: string;
  source: Source;
}

export function MessageList({ messages, onAsk }: { messages: UIMessage[]; onAsk?: (q: string) => void }) {
  const [activePassage, setActivePassage] = useState<ActivePassage | null>(null);

  function toggleSource(messageId: string, source: Source) {
    setActivePassage((prev) =>
      prev && prev.messageId === messageId && prev.source.chunkId === source.chunkId
        ? null
        : { messageId, source },
    );
  }

  return (
    <div className="message-list">
      {messages.map((message, index) => {
        const emptyCorpus = message.role === "assistant" ? dataPartOf(message, "data-empty-corpus") : null;
        const refusal = message.role === "assistant" ? dataPartOf(message, "data-refusal") : null;

        if (emptyCorpus) {
          return (
            <div key={message.id} className="message message--notice" data-empty-corpus="true">
              <div className="message__who">{whoLabel(message)}</div>
              <p className="message__text">{emptyCorpus.message}</p>
              <a href="/documents" className="message__link">
                Upload a document
              </a>
            </div>
          );
        }

        if (refusal) {
          return (
            <div key={message.id} className="message message--refusal" data-refusal="true">
              <div className="message__who">{whoLabel(message)}</div>
              <p className="message__text">{refusal.message}</p>
              <p className="message__code">
                <span data-error-code={refusal.code}>{refusal.code}</span>
              </p>
            </div>
          );
        }

        const rawText = textOf(message);
        const { answer: text, followups } =
          message.role === "assistant" ? splitFollowups(rawText) : { answer: rawText, followups: [] };
        /*
          The chat route writes every `data-citation` part and THEN merges the model stream
          (route.ts) — the merge starts a fresh message, so citations land on one assistant message
          and the answer text on the next. Rendering each message independently showed the source
          chips both above and below the answer.

          Fold any orphaned citations from immediately-preceding text-less assistant messages into
          the message that actually carries the answer, so the chips render once, beneath it.
        */
        const ownSources = citationsOf(message);
        const inheritedSources =
          message.role === "assistant" && text
            ? (() => {
                const out: Source[] = [];
                for (let i = index - 1; i >= 0; i--) {
                  const prev = messages[i]!;
                  if (prev.role !== "assistant" || textOf(prev)) break;
                  out.unshift(...citationsOf(prev));
                }
                return out;
              })()
            : [];
        const seen = new Set<string>();
        const allSources = [...inheritedSources, ...ownSources].filter((s) =>
          seen.has(s.chunkId) ? false : (seen.add(s.chunkId), true),
        );

        /*
          Show a chip only for markers the answer actually cites.

          Retrieval returns finalK chunks (6 by default) but the model cites only those that support
          a claim. Rendering all six put chips for [4] and [5] under an answer that never referenced
          them: clicking one showed a passage backing nothing, and "Sources (6)" implied six
          passages supported the answer when four did.

          This does NOT violate CHAT-02. That rule forbids CONSTRUCTING a citation from model text —
          the danger being an invented filename, page or URL. This only FILTERS sources the server
          already built from retrieval metadata, so it can show fewer real sources and can never
          introduce a fabricated one. `CitationChips` itself still never inspects text.

          A marker the model invents (`[9]` with no matching part) still renders nothing, because the
          filter can only ever select from server-provided sources.
        */
        const citedMarkers = new Set(
          [...text.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])),
        );
        const citedSources = citedMarkers.size > 0
          ? allSources.filter((s) => citedMarkers.has(s.marker))
          : allSources;

        /*
          Renumber what the reader sees so each answer's citations run 1..N.

          The server numbers all finalK retrieved chunks by rank, so an answer citing the 3rd, 5th
          and 6th produced chips labelled [3] [5] [6] with no [1], [2] or [4] anywhere — correct
          links, but the numbering reads as arbitrary or as though citations are missing.

          The remap must apply to the answer TEXT and the CHIPS together or they stop matching, so
          both are derived from one mapping. Ordered by the server's original marker, which is
          retrieval rank, so [1] remains the best-matching passage.

          Display-layer only: `chunkId`, `filename` and `page` are untouched, so the passage viewer
          still opens the same chunk. A marker the model invented is absent from the map and is left
          exactly as written — it has no source and renders no chip, unchanged from before.
        */
        const displayMarker = new Map<number, number>();
        [...citedSources]
          .sort((a, b) => a.marker - b.marker)
          .forEach((s, i) => displayMarker.set(s.marker, i + 1));

        const sources = citedSources.map((s) => ({
          ...s,
          marker: displayMarker.get(s.marker) ?? s.marker,
        }));

        const displayText = text.replace(/\[(\d+)\]/g, (whole, n) => {
          const mapped = displayMarker.get(Number(n));
          return mapped === undefined ? whole : `[${mapped}]`;
        });

        // A text-less assistant message exists only to carry citations that the message above now
        // renders — drop it rather than emitting a stray source row.
        if (message.role === "assistant" && !text && ownSources.length > 0) return null;

        return (
          <div
            key={message.id}
            className={`message ${message.role === "user" ? "message--user" : "message--assistant"}`}
          >
            {text ? <div className="message__who">{whoLabel(message)}</div> : null}
            {/*
              Only render a bubble when there is text. The chat route writes every `data-citation`
              part BEFORE the first token (so citations are attached programmatically, never
              model-authored — CHAT-02), which produces an assistant message carrying sources and no
              text. Rendering unconditionally showed an empty bubble with a duplicate ASSISTANT
              label above the real answer.
            */}
            {text ? (
              <div className="message__bubble">
                {message.role === "user" ? (
                  <p className="message__text">{text}</p>
                ) : (
                  <Markdown>{displayText}</Markdown>
                )}
              </div>
            ) : null}
            {sources.length > 0 ? (
              <CitationChips sources={sources} onSelect={(source) => toggleSource(message.id, source)} />
            ) : null}
            {/*
              Passage viewer sits directly under the citation chips, BEFORE the follow-up
              bubbles. It was rendering after them, so clicking a citation opened the passage
              below the "Ask next" row — far from the chip that was clicked, which reads as the
              panel opening somewhere unrelated. CHAT-03 wants the source next to its citation.
            */}
            {activePassage && activePassage.messageId === message.id ? (
              <PassageViewer source={activePassage.source} onClose={() => setActivePassage(null)} />
            ) : null}
            {followups.length > 0 && onAsk ? (
              <div className="followups" data-followups="true">
                <div className="followups__label">Ask next</div>
                <div className="followups__list">
                  {followups.map((q) => (
                    <button key={q} type="button" className="followup" onClick={() => onAsk(q)}>
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
