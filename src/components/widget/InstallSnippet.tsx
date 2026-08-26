"use client";

/**
 * Widget screen's install snippet (UI-SPEC Surface 3): a `<pre><code>` block with the real
 * deployment host, the real `kbId`, and the currently SAVED position (never the unsaved draft —
 * the snippet describes what is actually live, not what the buyer is mid-editing).
 *
 * Before the first save, this renders the UI-SPEC's disabled-with-reason copy — never a plausible
 * placeholder id a buyer could paste and have silently fail against (S-5).
 *
 * Copy button (S-1/S-2/S-6): writes to the clipboard, swaps its rendered text to `Copied` within
 * 100ms, reverts after 2000ms. On a clipboard failure it falls back to selecting the block's text
 * and reports the true cause — never a silent no-op, never a generic "something went wrong".
 */

import { useEffect, useRef, useState } from "react";

const COPIED_LABEL_DURATION_MS = 2000;

interface InstallSnippetProps {
  kbId: string;
  deploymentHost: string;
  position: "bottom-right" | "bottom-left";
  hasBeenConfigured: boolean;
}

export default function InstallSnippet({ kbId, deploymentHost, position, hasBeenConfigured }: InstallSnippetProps) {
  const [copyLabel, setCopyLabel] = useState("Copy snippet");
  const revertTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const preRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    return () => {
      if (revertTimerRef.current) clearTimeout(revertTimerRef.current);
    };
  }, []);

  const snippet = `<script src="${deploymentHost}/widget.js" data-kb-id="${kbId}" data-position="${position}" async></script>`;

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopyLabel("Copied");
    } catch {
      const selection = window.getSelection?.();
      if (selection && preRef.current) {
        const range = document.createRange();
        range.selectNodeContents(preRef.current);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      setCopyLabel("Press Cmd/Ctrl+C to copy");
    } finally {
      if (revertTimerRef.current) clearTimeout(revertTimerRef.current);
      revertTimerRef.current = setTimeout(() => setCopyLabel("Copy snippet"), COPIED_LABEL_DURATION_MS);
    }
  }

  return (
    <section className="panel panel--rail widget-snippet-panel" data-testid="install-snippet">
      <div className="panel__header">
        <div className="panel__title">Install snippet</div>
        <button
          type="button"
          className="btn btn-secondary btn-small"
          onClick={() => void handleCopy()}
          disabled={!hasBeenConfigured}
          data-testid="copy-snippet-button"
        >
          {copyLabel}
        </button>
      </div>
      {hasBeenConfigured ? (
        <pre ref={preRef} className="widget-snippet-code" data-testid="snippet-code">
          <code>{snippet}</code>
        </pre>
      ) : (
        <p className="widget-snippet-unsaved" data-testid="snippet-unsaved">
          Save your settings to generate the install snippet.
        </p>
      )}
    </section>
  );
}
