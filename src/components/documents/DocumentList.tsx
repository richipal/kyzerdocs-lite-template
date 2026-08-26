"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import DocumentRow, { type DocumentEntry } from "./DocumentRow.js";

interface JobPollResult {
  status: DocumentEntry["status"];
  phase: string | null;
  chunksTotal: number | null;
  chunksProcessed: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  action: string | null;
  updatedAt: string;
}

interface DocumentListProps {
  documents: DocumentEntry[];
  onDocumentUpdate: (id: string, patch: Partial<DocumentEntry>) => void;
  onDelete: (id: string, filename: string) => void;
  deletingId: string | null;
  pollIntervalMs?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 1500;

function isTerminal(status: DocumentEntry["status"]): boolean {
  return status === "ready" || status === "failed";
}

function isNonTerminal(status: DocumentEntry["status"]): boolean {
  return !isTerminal(status);
}

/**
 * Renders every document row, split into the design template's two sections — "Ingesting" (jobs
 * still in `pending`/`parsing`/`embedding`) above "Indexed" (terminal `ready`/`failed` rows,
 * filterable by name) — and drives ING-03's live per-job polling: while any document carries a
 * `jobId` (known once its `POST /api/ingest` call has resolved — see `page.tsx`) and is not yet
 * terminal, this polls `GET /api/ingest/[jobId]` (the only progress channel, ARCHITECTURE.md
 * Pattern 2) on a single shared interval and reports each update up to the parent's canonical
 * document state, which flows back down as new `document.status`/`chunkCount`/`chunksTotal` props.
 *
 * T-02-08-04: the interval is cleared entirely — both from inside the tick once nothing is left to
 * poll, and via the effect's own cleanup once the dependency roster goes idle — the moment every
 * tracked job reaches `ready` or `failed`. This must never leave a timer running on an idle screen.
 */
export default function DocumentList({
  documents,
  onDocumentUpdate,
  onDelete,
  deletingId,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
}: DocumentListProps) {
  const documentsRef = useRef(documents);
  documentsRef.current = documents;
  const [filterText, setFilterText] = useState("");

  // Roster of "documents worth polling" as a plain string so the effect only restarts the
  // interval when the *set* of active jobs actually changes (a new upload resolves, or one
  // reaches a terminal state) — not on every unrelated parent re-render.
  const activeRoster = documents
    .filter((d) => d.jobId && !isTerminal(d.status))
    .map((d) => `${d.id}:${d.jobId}`)
    .join(",");

  useEffect(() => {
    if (activeRoster === "") return;

    const interval = setInterval(() => {
      const active = documentsRef.current.filter((d) => d.jobId && !isTerminal(d.status));
      if (active.length === 0) {
        clearInterval(interval);
        return;
      }

      void Promise.all(
        active.map(async (doc) => {
          try {
            const res = await fetch(`/api/ingest/${doc.jobId}`, { method: "GET" });
            if (!res.ok) return;
            const job = (await res.json()) as JobPollResult;
            onDocumentUpdate(doc.id, {
              status: job.status,
              chunkCount: job.chunksProcessed ?? doc.chunkCount,
              chunksTotal: job.chunksTotal,
              errorCode: job.errorCode,
              errorMessage: job.errorMessage,
              action: job.action,
            });
          } catch {
            // A transient network error on one poll tick is not fatal — the next tick retries.
          }
        }),
      );
    }, pollIntervalMs);

    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally keyed on the roster
    // string above, not on `documents`/`onDocumentUpdate` identity (see comment above).
  }, [activeRoster, pollIntervalMs]);

  const activeDocuments = useMemo(() => documents.filter((d) => isNonTerminal(d.status)), [documents]);
  const terminalDocuments = useMemo(() => documents.filter((d) => isTerminal(d.status)), [documents]);
  const visibleTerminalDocuments = useMemo(() => {
    const needle = filterText.trim().toLowerCase();
    if (!needle) return terminalDocuments;
    return terminalDocuments.filter((d) => d.filename.toLowerCase().includes(needle));
  }, [terminalDocuments, filterText]);

  if (documents.length === 0) {
    return <p className="empty-note">No documents yet — drag one in above.</p>;
  }

  return (
    <>
      {activeDocuments.length > 0 ? (
        <section className="panel">
          <div className="panel__header">
            <div className="panel__title">Ingesting</div>
            <div className="panel__meta">in-process · 1 worker</div>
          </div>
          <ul data-testid="ingest-queue" className="ingest-queue">
            {activeDocuments.map((doc) => (
              <DocumentRow key={doc.id} document={doc} onDelete={onDelete} deleting={deletingId === doc.id} />
            ))}
          </ul>
        </section>
      ) : null}

      <section className="panel">
        <div className="panel__header">
          <div className="panel__title">Indexed</div>
          <input
            type="text"
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            placeholder="Filter by name"
            aria-label="Filter documents by name"
            className="filter-input"
          />
        </div>
        {terminalDocuments.length > 0 ? (
          <div className="indexed-table__header" aria-hidden="true">
            <span>Name</span>
            <span className="ta-right">Chunks</span>
            <span>Updated</span>
            <span />
          </div>
        ) : null}
        {visibleTerminalDocuments.length === 0 ? (
          <p className="empty-note">
            {terminalDocuments.length === 0 ? "Nothing indexed yet." : "No documents match your filter."}
          </p>
        ) : (
          <ul data-testid="document-list" className="indexed-table">
            {visibleTerminalDocuments.map((doc) => (
              <DocumentRow key={doc.id} document={doc} onDelete={onDelete} deleting={deletingId === doc.id} />
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

export type { DocumentEntry } from "./DocumentRow.js";
