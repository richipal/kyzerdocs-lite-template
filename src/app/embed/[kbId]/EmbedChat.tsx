"use client";

/**
 * The widget's iframe panel: a 52px branded header (logo/monogram + title + close button), the
 * reused `ChatPanel` in `variant="widget"` (message list + composer are its own — see
 * ChatPanel.tsx), and the `Powered by KyzerDocs Lite` footer line (UI-SPEC Copywriting Contract,
 * developer-confirmed 2026-08-21). No second message-rendering tree — UI-SPEC's Surface 1
 * structural contract makes reusing `ChatPanel`/`MessageList`/`CitationChips`/`PassageViewer`
 * binding, precisely because a parallel implementation is how the citation-dedup, empty-bubble and
 * duplicate-chip defect classes reappear somewhere no Phase 2 test looks.
 *
 * Implements the iframe half of the postMessage contract (`src/widget-src/protocol.ts`, plan
 * 03-04): posts `ready` (with the visual config the host's launcher bubble needs) on mount and
 * `close` when the header X is clicked, both targeted at the host page's own origin — derived from
 * `document.referrer`, never a hardcoded host. Falls back to `"*"` only when no referrer is
 * available (e.g. a host sending `Referrer-Policy: no-referrer`): every field in
 * `WidgetReadyConfig` (accentColor/position/title) is the buyer's own public branding, already
 * rendered visibly in this very panel, so broadcasting it costs nothing a page inspecting this
 * iframe could not already read directly — no credential, session or config secret is ever posted
 * (D3-13). Listens for `open`/`viewport`/`preview-config`, rejecting anything that fails
 * `isHostMessage`'s shape check or (when a real host origin was resolved) arrives from an
 * unexpected origin.
 *
 * `preview-config` (plan 03-09, Rule 2 addition beyond that plan's own file list): the admin
 * Widget-config screen's `WidgetPreview.tsx` loads this SAME route at `?preview=1` and pushes the
 * buyer's unsaved form edits into it via this message, so the preview reflects an edit before any
 * save — a must_have truth of that plan, not just its own claim to test against. `previewOverride`
 * is layered on TOP of the server-resolved `config` prop (never replaces it structurally) — until a
 * `preview-config` message arrives, this page renders exactly what a real, live embed renders.
 */

import { useEffect, useRef, useState } from "react";
import { ChatPanel } from "../../../components/chat/ChatPanel.js";
import { WidgetBrandProvider } from "../../../components/chat/widget-brand-context.js";
import type { WidgetConfig } from "../../../lib/widget/config.js";
import {
  WIDGET_MESSAGE_SOURCE,
  isHostMessage,
  type WidgetPreviewConfig,
  type WidgetReadyConfig,
} from "../../../widget-src/protocol.js";

export function EmbedChat({ kbId, config }: { kbId: string; config: WidgetConfig }) {
  const [isMobile, setIsMobile] = useState(false);
  const [previewOverride, setPreviewOverride] = useState<WidgetPreviewConfig | null>(null);
  const hostOriginRef = useRef<string | null>(null);

  useEffect(() => {
    let resolvedOrigin: string | null = null;
    try {
      if (document.referrer) resolvedOrigin = new URL(document.referrer).origin;
    } catch {
      resolvedOrigin = null;
    }
    hostOriginRef.current = resolvedOrigin;

    const readyConfig: WidgetReadyConfig = {
      accentColor: config.accentColor,
      position: config.position,
      title: config.title,
    };
    window.parent.postMessage(
      { source: WIDGET_MESSAGE_SOURCE, type: "ready", config: readyConfig },
      resolvedOrigin ?? "*",
    );

    function onMessage(event: MessageEvent) {
      if (hostOriginRef.current && event.origin !== hostOriginRef.current) return;
      if (!isHostMessage(event.data)) return;
      if (event.data.type === "viewport") setIsMobile(event.data.isMobile);
      if (event.data.type === "preview-config") setPreviewOverride(event.data.config);
      // "open" carries no state this page needs to react to — the host's own iframe
      // visibility is what actually shows/hides the panel on the host page.
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [config.accentColor, config.position, config.title]);

  function close() {
    window.parent.postMessage(
      { source: WIDGET_MESSAGE_SOURCE, type: "close" },
      hostOriginRef.current ?? "*",
    );
  }

  const productName = previewOverride?.productName ?? config.productName;
  const logoUrl = previewOverride ? previewOverride.logoUrl : config.logoUrl;
  const accentColor = previewOverride?.accentColor ?? config.accentColor;
  const title = previewOverride?.title ?? config.title;

  return (
    <WidgetBrandProvider brandName={productName}>
      <div className={isMobile ? "widget-panel widget-panel--mobile" : "widget-panel"}>
        <header className="widget-panel__header" style={{ background: accentColor }}>
          <div className="widget-panel__brand">
            {logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- the buyer's own uploaded
              // logo, not an optimizable local asset; next/image requires a configured remote
              // pattern this single-KB embed page has no reason to maintain.
              <img src={logoUrl} alt="" className="widget-panel__logo" />
            ) : (
              <span className="widget-panel__monogram" aria-hidden="true">
                {productName.charAt(0).toUpperCase()}
              </span>
            )}
            <span className="widget-panel__title">{title}</span>
          </div>
          <button type="button" className="widget-panel__close" aria-label="Close chat" onClick={close}>
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
              <path
                d="M6 6l12 12M18 6L6 18"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </header>

        <ChatPanel variant="widget" apiPath={`/api/embed/${kbId}`} />

        <div className="widget-panel__footer">Powered by KyzerDocs Lite</div>
      </div>
    </WidgetBrandProvider>
  );
}
