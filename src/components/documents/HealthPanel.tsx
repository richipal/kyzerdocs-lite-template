"use client";

import { useCallback, useEffect, useState } from "react";

interface HealthCheck {
  ok: boolean;
  code?: string;
  message?: string;
  action?: string;
}

interface HealthResponse {
  database: HealthCheck & { path?: string };
  apiKey: HealthCheck;
  embedding: HealthCheck;
  chatProvider: HealthCheck & { provider?: string };
  corpus?: { total: number; ready: number; failed: number };
  lastFailedDocument?: { filename: string; errorCode: string | null } | null;
  /** D3-18, plan 03-07. Present ONLY once a real cold rebuild has happened in this deployment's
   * process — absent (not `null`, not `{ ms: 0 }`) otherwise. See this component's own render
   * logic below for why an absent field means an absent row, never a placeholder (S-5). */
  indexRebuild?: { ms: number };
  /** Plan 03-10 (STOR-06), UI-SPEC Surface 4. Present ONLY in cloud mode — absent entirely in
   * local mode, where Blob storage is not part of the deployment. A REAL reachability check
   * (`list({ limit: 1 })` server-side), never a static "OK". */
  blob?: HealthCheck;
}

interface ApiDocument {
  status: string;
  chunkCount: number;
}

const CHECKS: Array<{ key: keyof Pick<HealthResponse, "database" | "apiKey" | "embedding" | "chatProvider">; label: string }> = [
  { key: "database", label: "Database" },
  { key: "apiKey", label: "API key" },
  { key: "embedding", label: "Embedding model" },
  { key: "chatProvider", label: "Chat provider" },
];

/**
 * DELIV-03 status surface, styled as the design template's "Index health" panel (D2-14: lives
 * inside the document screen, not a third page). Fetches `GET /api/health` on mount and on demand
 * — never assumes the four checks always succeed (T-02-08-01's redaction happens server-side; this
 * component just renders whatever shape it receives, authenticated or not).
 *
 * The template's mockup also showed "Footprint" (memory size) and "Median search" (latency) rows —
 * neither is exposed by any endpoint this build has, and this component does not invent numbers to
 * fill them in, so those two rows are omitted entirely rather than hardcoded. "Vectors in memory"
 * is real: it's the sum of `chunkCount` across `ready` documents from the same `GET /api/documents`
 * the rest of the screen already calls (one embedding chunk == one vector, by construction of the
 * ingest pipeline). "Last failure" is the health route's own `lastFailedDocument`, not a placeholder.
 *
 * "Index rebuild (cold)" (D3-18, plan 03-07, UI-STANDARDS.md S-5) follows the exact same
 * no-invented-numbers rule as the two omitted rows above: it renders ONLY when
 * `health.indexRebuild` is present in the response (a real rebuild has happened in this
 * deployment's process since it started) — never a `—` placeholder, never a hardcoded `0ms` copied
 * from `03-COLDSTART.md`'s benchmark. Absence of a real measurement means absence of the row.
 *
 * "Blob storage" (plan 03-10, STOR-06, UI-SPEC Surface 4) follows the same `.health-row`/`data-ok`
 * pattern as the four `CHECKS` rows above it: renders ONLY when `health.blob` is present (cloud
 * mode) — local mode shows the original four rows unchanged, cloud mode shows five. The row's
 * `data-ok` reflects a REAL server-side reachability check, never a static "OK".
 */
export default function HealthPanel() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [vectorsInMemory, setVectorsInMemory] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchFailed, setFetchFailed] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setFetchFailed(false);
    try {
      const [healthRes, docsRes] = await Promise.all([
        fetch("/api/health", { method: "GET" }),
        fetch("/api/documents", { method: "GET" }),
      ]);
      const body = (await healthRes.json()) as HealthResponse;
      setHealth(body);
      if (docsRes.ok) {
        const docsBody = (await docsRes.json()) as { documents: ApiDocument[] };
        setVectorsInMemory(
          docsBody.documents.filter((d) => d.status === "ready").reduce((sum, d) => sum + (d.chunkCount || 0), 0),
        );
      }
    } catch {
      setFetchFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <section className="panel panel--rail" data-testid="health-panel">
      <div className="panel__header">
        <div className="panel__title">Index health</div>
        <button type="button" className="btn btn-secondary btn-small" onClick={() => void refresh()} disabled={loading}>
          {loading ? "Checking…" : "Refresh"}
        </button>
      </div>

      {fetchFailed ? (
        <p role="alert" className="health-panel__error">
          Could not reach the health check.
        </p>
      ) : null}

      {health ? (
        <ul className="health-checks">
          {CHECKS.map(({ key, label }) => {
            const check = health[key];
            return (
              <li key={key} data-testid={`health-check-${key}`} data-ok={check.ok} className="health-row">
                <span className="health-row__label">{label}</span>
                <span className="health-row__value">
                  {check.ok ? "OK" : "Not OK"}
                  {check.code ? <span data-error-code={check.code}> ({check.code})</span> : null}
                  {check.message ? <span className="health-row__detail"> — {check.message}</span> : null}
                  {check.action ? <span className="health-row__detail"> {check.action}</span> : null}
                </span>
              </li>
            );
          })}

          {health.blob ? (
            <li
              key="blob"
              data-testid="health-check-blob"
              data-ok={health.blob.ok}
              className="health-row"
            >
              <span className="health-row__label">Blob storage</span>
              <span className="health-row__value">
                {health.blob.ok ? "OK" : "Not OK"}
                {health.blob.code ? <span data-error-code={health.blob.code}> ({health.blob.code})</span> : null}
                {health.blob.message ? <span className="health-row__detail"> — {health.blob.message}</span> : null}
                {health.blob.action ? <span className="health-row__detail"> {health.blob.action}</span> : null}
              </span>
            </li>
          ) : null}

          {vectorsInMemory !== null ? (
            <li className="health-row">
              <span className="health-row__label">Vectors in memory</span>
              <span className="health-row__value health-row__value--mono">{vectorsInMemory}</span>
            </li>
          ) : null}

          {health.indexRebuild ? (
            <li className="health-row" data-testid="health-index-rebuild">
              <span className="health-row__label">Index rebuild (cold)</span>
              <span className="health-row__value health-row__value--mono">{health.indexRebuild.ms}ms</span>
            </li>
          ) : null}

          <li className="health-row">
            <span className="health-row__label">Last failure</span>
            <span className="health-row__value health-row__value--mono" data-testid="health-last-failed">
              {health.lastFailedDocument
                ? `${health.lastFailedDocument.filename}${
                    health.lastFailedDocument.errorCode ? ` (${health.lastFailedDocument.errorCode})` : ""
                  }`
                : "none"}
            </span>
          </li>
        </ul>
      ) : null}

      {health?.corpus ? (
        <p data-testid="health-corpus" className="health-panel__corpus">
          {health.corpus.total} document{health.corpus.total === 1 ? "" : "s"}, {health.corpus.ready} ready,{" "}
          {health.corpus.failed} failed.
        </p>
      ) : null}
    </section>
  );
}
