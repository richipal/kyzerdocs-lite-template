"use client";

/**
 * Widget screen "Allowed domains" panel (WIDG-05, D3-12). Copy is verbatim from the UI-SPEC's
 * Copywriting Contract — D3-12 requires the buyer be told plainly that the `Origin` header is
 * spoofable and this list is a convenience filter, not a security boundary.
 *
 * Add-field input runs through the same `normalizeDomain` the admin route validates with at save
 * time (never a second, divergent parser). Removal is a soft-delete with a 5-second inline "Undo"
 * (destructive-lite per the UI-SPEC — no blocking modal, but some safety net since a removal can
 * silently break a live customer-facing widget with no other visible signal).
 */

import { useEffect, useRef, useState } from "react";
import { normalizeDomain } from "../../lib/widget/origin.js";

const UNDO_WINDOW_MS = 5000;

interface AllowedDomainsSectionProps {
  domains: string[];
  onChange: (domains: string[]) => void;
}

interface PendingRemoval {
  domain: string;
  index: number;
}

export default function AllowedDomainsSection({ domains, onChange }: AllowedDomainsSectionProps) {
  const [draft, setDraft] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<PendingRemoval | null>(null);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    };
  }, []);

  function handleAdd() {
    const normalized = normalizeDomain(draft);
    if (normalized === null) {
      setValidationError("Enter a domain, like example.com — not a full URL.");
      return;
    }
    setValidationError(null);
    setDraft("");
    if (!domains.includes(normalized)) {
      onChange([...domains, normalized]);
    }
  }

  function handleRemove(domain: string, index: number) {
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    onChange(domains.filter((d) => d !== domain));
    setPendingRemoval({ domain, index });
    undoTimerRef.current = setTimeout(() => {
      setPendingRemoval(null);
    }, UNDO_WINDOW_MS);
  }

  function handleUndo() {
    if (!pendingRemoval) return;
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    const restored = [...domains];
    restored.splice(Math.min(pendingRemoval.index, restored.length), 0, pendingRemoval.domain);
    onChange(restored);
    setPendingRemoval(null);
  }

  return (
    <section className="panel widget-form-panel" data-testid="allowed-domains-section">
      <div className="panel__header">
        <div className="panel__title">Allowed domains</div>
      </div>
      <div className="panel__body widget-form-panel__body">
        <p className="panel__copy">
          Requests from other domains are rejected. Origin headers can be spoofable, so this list is a convenience
          filter, not a security boundary — rate limiting is what actually protects your usage costs.
        </p>

        <div className="widget-domain-add">
          <input
            type="text"
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              if (validationError) setValidationError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                handleAdd();
              }
            }}
            placeholder="example.com"
            aria-label="Add an allowed domain"
          />
          <button type="button" className="btn btn-secondary btn-small" onClick={handleAdd}>
            Add
          </button>
        </div>
        {validationError ? (
          <p role="alert" className="widget-form-field__error" data-testid="domain-validation-error">
            {validationError}
          </p>
        ) : null}

        {domains.length === 0 && !pendingRemoval ? (
          <p className="widget-domain-empty" data-testid="allowed-domains-empty">
            No domains added yet. Add your website&apos;s domain before you publish the install snippet, or the
            widget won&apos;t respond anywhere.
          </p>
        ) : (
          <ul className="widget-domain-list" data-testid="allowed-domains-list">
            {domains.map((domain, index) => (
              <li key={domain} className="widget-domain-row" data-testid="allowed-domain-row">
                <span className="widget-domain-row__name">{domain}</span>
                <button
                  type="button"
                  className="widget-domain-row__remove"
                  onClick={() => handleRemove(domain, index)}
                  title={`Remove ${domain}`}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}

        {pendingRemoval ? (
          <p className="widget-domain-undo" role="status" data-testid="domain-removed-undo">
            Removed &ldquo;{pendingRemoval.domain}&rdquo; —{" "}
            <button type="button" className="widget-domain-undo__button" onClick={handleUndo}>
              Undo
            </button>
          </p>
        ) : null}
      </div>
    </section>
  );
}
