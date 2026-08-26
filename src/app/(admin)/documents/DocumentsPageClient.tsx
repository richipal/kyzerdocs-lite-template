"use client";

/**
 * The Documents screen's client-side state and interactions (Rule 2 addition, plan 03-10 — not in
 * the plan's own file list, but necessary to satisfy its own action text: `UploadDropzone` needs a
 * real `cloudMode` boolean to decide whether to call `@vercel/blob/client`'s `upload()`, and
 * `PRODUCT_CONFIG.cloudMode` can only be read correctly on the server — reading it directly inside
 * a `"use client"` module would silently evaluate to `false` in the browser bundle regardless of
 * the real deployment mode, since `PRODUCT_CONFIG` parses `process.env` at import time and
 * Next.js does not inline arbitrary server env vars into client bundles. `page.tsx` now owns that
 * one server-side read and hands it down as a plain boolean — the exact same split
 * `WidgetPageClient.tsx`'s `cloudMode` prop already established in plan 03-09.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { AppShell } from "../../../components/layout/AppShell.js";
import DocumentList, { type DocumentEntry } from "../../../components/documents/DocumentList.js";
import HealthPanel from "../../../components/documents/HealthPanel.js";
import UploadDropzone, {
  type UploadDropzoneHandle,
  type UploadResolution,
} from "../../../components/documents/UploadDropzone.js";
import type { AppErrorJSON } from "../../../lib/errors.js";

interface ApiDocument {
  id: string;
  filename: string;
  status: DocumentEntry["status"];
  errorCode: string | null;
  pageCount: number | null;
  chunkCount: number;
  createdAt: string;
  updatedAt: string;
}

interface DocumentsPageClientProps {
  /** `PRODUCT_CONFIG.cloudMode`, read server-side in `page.tsx` and passed down as a plain
   * boolean — never imported directly here, since `PRODUCT_CONFIG` carries secrets (e.g.
   * `storage.blobToken`) that must never reach a client bundle. Drives `UploadDropzone`'s
   * client-direct-vs-form-data branch (STOR-06). */
  cloudMode: boolean;
}

const LIST_POLL_INTERVAL_MS = 1500;

function isNonTerminal(status: DocumentEntry["status"]): boolean {
  return status === "pending" || status === "parsing" || status === "embedding";
}

/**
 * Screen 1 of the two-screen UI (D2-13): upload, live per-document status, failure reasons,
 * delete, and health — all on one page (D2-14).
 *
 * Two polling mechanisms cooperate here, and both are necessary given `POST /api/ingest` awaits
 * the entire pipeline in-request (02-05):
 *   1. This component's own list-level poll (`GET /api/documents`, below) — no job id required —
 *      is what actually makes a document's row APPEAR and its status/chunk-count visibly advance
 *      WHILE a real upload is still in flight, because the SQLite writes each pipeline stage makes
 *      commit durably as soon as they happen, and a concurrent GET on the same server process
 *      observes them even though the POST's own promise has not resolved yet.
 *   2. `DocumentList`'s per-job poll (`GET /api/ingest/[jobId]`) refines a row with exact
 *      `chunksTotal`/`chunksProcessed`/`errorMessage`/`action` once a job id is known (from this
 *      upload's own `POST /api/ingest` response) — the mechanism the plan's interfaces describe,
 *      and the one a future async/queued ingestion mode would rely on exclusively.
 */
export default function DocumentsPageClient({ cloudMode }: DocumentsPageClientProps) {
  const [documents, setDocuments] = useState<DocumentEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [uploadErrors, setUploadErrors] = useState<Array<{ filename: string; error: AppErrorJSON }>>([]);
  const [uploadingCount, setUploadingCount] = useState(0);
  const jobIdByDocumentId = useRef<Map<string, string>>(new Map());
  const dropzoneRef = useRef<UploadDropzoneHandle>(null);

  const fetchDocuments = useCallback(async () => {
    const res = await fetch("/api/documents", { method: "GET" });
    if (!res.ok) return;
    const body = (await res.json()) as { documents: ApiDocument[] };
    setDocuments((prev) => {
      const prevById = new Map(prev.map((d) => [d.id, d]));
      return body.documents.map((doc) => {
        const existing = prevById.get(doc.id);
        const jobId = jobIdByDocumentId.current.get(doc.id);
        return {
          ...doc,
          jobId,
          errorMessage: existing?.errorMessage,
          action: existing?.action,
          chunksTotal: existing?.chunksTotal,
        };
      });
    });
  }, []);

  useEffect(() => {
    void fetchDocuments().finally(() => setLoaded(true));
    // Runs once on mount only — the polls below take over from here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const shouldPollList = uploadingCount > 0 || documents.some((d) => isNonTerminal(d.status));

  useEffect(() => {
    if (!shouldPollList) return;
    const interval = setInterval(() => {
      void fetchDocuments();
    }, LIST_POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [shouldPollList, fetchDocuments]);

  const handleUploadStarted = useCallback(() => {
    setUploadingCount((count) => count + 1);
  }, []);

  const handleUploadResolved = useCallback(
    (resolution: UploadResolution) => {
      jobIdByDocumentId.current.set(resolution.documentId, resolution.jobId);
      setUploadingCount((count) => Math.max(0, count - 1));
      void fetchDocuments();
    },
    [fetchDocuments],
  );

  const handleUploadFailed = useCallback((filename: string, error: AppErrorJSON) => {
    setUploadingCount((count) => Math.max(0, count - 1));
    setUploadErrors((prev) => [...prev, { filename, error }]);
  }, []);

  const handleDocumentUpdate = useCallback((id: string, patch: Partial<DocumentEntry>) => {
    setDocuments((prev) => prev.map((doc) => (doc.id === id ? { ...doc, ...patch } : doc)));
  }, []);

  const handleDelete = useCallback(async (id: string, filename: string) => {
    const confirmed = window.confirm(`Delete "${filename}"? This cannot be undone.`);
    if (!confirmed) return;
    setDeletingId(id);
    try {
      const res = await fetch(`/api/documents/${id}`, { method: "DELETE" });
      if (res.status === 204) {
        setDocuments((prev) => prev.filter((doc) => doc.id !== id));
        jobIdByDocumentId.current.delete(id);
      }
    } finally {
      setDeletingId(null);
    }
  }, []);

  return (
    <AppShell active="documents">
      <div className="docs">
        <header className="docs__header">
          <div>
            <h1>Documents</h1>
            <p className="docs__subtitle">
              Everything here is parsed, chunked and embedded on this machine. Nothing leaves it except the text
              sent to the embedding API.
            </p>
          </div>
          <div className="docs__actions">
            <button
              type="button"
              className="btn btn-secondary"
              disabled
              title="No rebuild endpoint exists yet in this build — restart the server to rebuild the in-memory index."
            >
              Rebuild index
            </button>
            <button type="button" className="btn btn-primary" onClick={() => dropzoneRef.current?.openFileDialog()}>
              Upload files
            </button>
          </div>
        </header>

        <div className="docs__body">
          <div className="docs__main">
            <UploadDropzone
              ref={dropzoneRef}
              onUploadStarted={handleUploadStarted}
              onUploadResolved={handleUploadResolved}
              onUploadFailed={handleUploadFailed}
              cloudMode={cloudMode}
            />

            {uploadErrors.length > 0 ? (
              <ul role="alert" data-testid="upload-errors">
                {uploadErrors.map((entry, index) => (
                  <li key={`${entry.filename}-${index}`}>
                    <strong>{entry.filename}</strong>:{" "}
                    <span data-error-code={entry.error.code}>{entry.error.code}</span> — {entry.error.message}{" "}
                    {entry.error.action}
                  </li>
                ))}
              </ul>
            ) : null}

            {loaded ? (
              <DocumentList
                documents={documents}
                onDocumentUpdate={handleDocumentUpdate}
                onDelete={(id, filename) => void handleDelete(id, filename)}
                deletingId={deletingId}
              />
            ) : (
              <p>Loading…</p>
            )}
          </div>

          <div className="docs__rail">
            <section className="panel panel--rail">
              <div className="panel__title">Website source</div>
              <p className="panel__copy">Keep the knowledge base in step with your public site automatically.</p>
              <div className="upsell-note">
                Crawling and weekly resync are part of the <strong>Business</strong> package.
              </div>
            </section>

            <HealthPanel />

            <p className="docs__footnote">Scanned PDFs without a text layer are skipped. Re-upload them with OCR applied.</p>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
