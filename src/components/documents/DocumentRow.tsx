"use client";

import { ERROR_CODES, type ErrorCode } from "../../lib/errors.js";
import type { DocumentStatus } from "../../lib/storage/types.js";
import { formatRelativeTime } from "../../lib/ui/relative-time.js";

export interface DocumentEntry {
  id: string;
  filename: string;
  status: DocumentStatus;
  errorCode: string | null;
  /** Populated once a per-job poll (`GET /api/ingest/[jobId]`) has run for this row. Absent for a
   * row discovered via the plain document list (e.g. after a page reload) — the row still shows a
   * correct, if slightly less detailed, failure reason via the `ERROR_CODES` fallback below. */
  errorMessage?: string | null;
  action?: string | null;
  pageCount: number | null;
  chunkCount: number;
  chunksTotal?: number | null;
  createdAt: string;
  updatedAt: string;
  /** Known only for a document uploaded this session (from `POST /api/ingest`'s response) — used
   * to drive the per-job poll in `DocumentList`. */
  jobId?: string;
}

interface DocumentRowProps {
  document: DocumentEntry;
  onDelete: (id: string, filename: string) => void;
  deleting: boolean;
}

const STATUS_LABEL: Record<DocumentStatus, string> = {
  pending: "Pending",
  parsing: "Parsing",
  embedding: "Embedding",
  ready: "Ready",
  failed: "Failed",
};

/** The design template's per-job row shows a 4-segment "parse · chunk · embed · ready" bar. This
 * product's pipeline only ever surfaces `pending | parsing | embedding | ready | failed` — there is
 * no separate "chunking" status — so segments are derived honestly from that: parsing lights only
 * "parse"; embedding (which already implies parsing and chunking finished) lights the first three;
 * only a genuinely `ready` row (which has left this section entirely) would light all four. */
const STAGE_LABELS = ["parse", "chunk", "embed", "ready"] as const;

function activeStageCount(status: DocumentStatus): number {
  if (status === "parsing") return 1;
  if (status === "embedding") return 3;
  return 0; // pending — nothing finished yet; failed/ready never render through this path
}

/** `errorCode` is the only field guaranteed present for a failure regardless of how the row was
 * discovered (fresh upload vs. reload). `errors.ts`'s `ERROR_CODES` registry is plain, client-safe
 * data (no server-only dependency) — this is the same "derive action from the registry at the
 * boundary, never store it on the row" pattern the API routes themselves use. */
function resolveFailureText(doc: DocumentEntry): { message: string; action: string } {
  if (doc.errorMessage && doc.action) {
    return { message: doc.errorMessage, action: doc.action };
  }
  const code = doc.errorCode as ErrorCode | null;
  if (code && code in ERROR_CODES) {
    const entry = ERROR_CODES[code];
    return { message: entry.message, action: entry.action };
  }
  return { message: "Ingestion failed.", action: "Retry the upload." };
}

/** Leads with the capitalized `STATUS_LABEL` word (so this single element can also serve as the
 * row's accessible status-chip) followed by the same real-progress detail the original row text
 * used — no separate hidden duplicate needed. */
function IngestDetail({ document }: { document: DocumentEntry }) {
  if (document.status === "pending") {
    return <span>{STATUS_LABEL.pending}</span>;
  }
  if (document.status === "parsing") {
    return (
      <span>
        {STATUS_LABEL.parsing}
        {document.pageCount !== null ? ` · ${document.pageCount} pages` : ""}
      </span>
    );
  }
  // embedding (the only other non-terminal state that reaches this component)
  return (
    <span>
      {STATUS_LABEL.embedding} · {document.chunkCount} chunk{document.chunkCount === 1 ? "" : "s"} embedded
      {typeof document.chunksTotal === "number" && document.chunksTotal > 0 ? ` of ${document.chunksTotal}` : ""}
    </span>
  );
}

/** One row of the document list, rendered as one of two layouts depending on where it sits in the
 * pipeline (`DocumentList` groups by status before mapping): an in-flight row shows the template's
 * "Ingesting" job layout (name/detail + 4-segment progress bar); a terminal row shows the "Indexed"
 * table layout (status dot, chunk count, relative update time, delete). A `failed` row always
 * renders its error message, action, and the KDL code as visible text (SUPP-01: a screenshot must
 * be diagnosable — the code must be on screen, not only in a tooltip or the console). */
export default function DocumentRow({ document, onDelete, deleting }: DocumentRowProps) {
  const isNonTerminal = document.status === "pending" || document.status === "parsing" || document.status === "embedding";

  if (isNonTerminal) {
    const activeStages = activeStageCount(document.status);
    return (
      <li className="ingest-row" data-testid="document-row" data-document-id={document.id} data-status={document.status}>
        <div className="ingest-row__info">
          <div className="ingest-row__name">{document.filename}</div>
          <div className="ingest-row__detail" data-testid="status-chip">
            <IngestDetail document={document} />
          </div>
        </div>
        <div className="ingest-row__progress">
          <div className="ingest-row__bars" aria-hidden="true">
            {STAGE_LABELS.map((label, i) => (
              <span key={label} className={`ingest-row__bar${i < activeStages ? " is-active" : ""}`} />
            ))}
          </div>
          <div className="ingest-row__stage-labels">
            {STAGE_LABELS.map((label) => (
              <span key={label}>{label}</span>
            ))}
          </div>
        </div>
      </li>
    );
  }

  return (
    <li className="indexed-row" data-testid="document-row" data-document-id={document.id} data-status={document.status}>
      <div className="indexed-row__name">
        <span className="status-dot" data-status={document.status} aria-hidden="true" />
        <span className="indexed-row__filename" title={document.pageCount !== null ? `${document.pageCount} pages` : undefined}>
          {document.filename}
        </span>
        <span className="sr-only" data-testid="status-chip">
          {STATUS_LABEL[document.status]}
        </span>
      </div>
      <span className="indexed-row__chunks">{document.status === "ready" ? document.chunkCount : "—"}</span>
      <span className="indexed-row__updated">{formatRelativeTime(document.updatedAt)}</span>
      <button
        type="button"
        className="indexed-row__delete"
        onClick={() => onDelete(document.id, document.filename)}
        disabled={deleting}
        title={`Delete ${document.filename}`}
      >
        {deleting ? "Deleting…" : "Delete"}
      </button>

      {document.status === "failed"
        ? (() => {
            const { message, action } = resolveFailureText(document);
            return (
              <p role="alert" data-testid="failure-reason" className="indexed-row__failure">
                <span data-error-code={document.errorCode ?? undefined}>{document.errorCode}</span>: {message}{" "}
                {action}
              </p>
            );
          })()
        : null}
    </li>
  );
}
