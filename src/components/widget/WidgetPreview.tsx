"use client";

/**
 * Widget screen's rail — primary visual anchor (UI-SPEC Surface 2): a real `<iframe>` pointed at
 * the actual `/embed/{kbId}?preview=1` route, never a static image or a hand-built mockup (S-5).
 * What the buyer sees here is the exact code path plan 03-08 shipped for real visitors.
 *
 * Unsaved form edits are pushed into the live iframe via a debounced, origin-checked `postMessage`
 * using the shared widget protocol (`src/widget-src/protocol.ts`'s `preview-config` message, a
 * Rule 2 addition documented in 03-09-SUMMARY.md) — `targetOrigin` is always this app's own origin,
 * never `"*"` (T-03-09-04).
 */

import { useEffect, useRef, useState } from "react";
import type { WidgetConfig } from "../../lib/widget/config.js";
import { HOST_MESSAGE_SOURCE, isWidgetMessage } from "../../widget-src/protocol.js";

const DEBOUNCE_MS = 200;
const LOAD_TIMEOUT_MS = 5000;

interface WidgetPreviewProps {
  kbId: string;
  config: Pick<WidgetConfig, "productName" | "logoUrl" | "accentColor" | "position" | "title">;
}

export default function WidgetPreview({ kbId, config }: WidgetPreviewProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [frameStatus, setFrameStatus] = useState<"loading" | "loaded" | "error">("loading");

  // The iframe's own `ready` message (plan 03-08) is the real signal it loaded and rendered —
  // more meaningful than the DOM `onLoad` event, which fires even for a same-origin error page.
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.source !== iframeRef.current?.contentWindow) return;
      if (isWidgetMessage(event.data) && event.data.type === "ready") {
        setFrameStatus("loaded");
      }
    }
    window.addEventListener("message", onMessage);
    const timeout = setTimeout(() => {
      setFrameStatus((current) => (current === "loading" ? "error" : current));
    }, LOAD_TIMEOUT_MS);
    return () => {
      window.removeEventListener("message", onMessage);
      clearTimeout(timeout);
    };
  }, []);

  // Debounced push of every unsaved edit into the live iframe — never on the initial mount alone,
  // so a keystroke updates the preview without a save and without a reload.
  useEffect(() => {
    const timer = setTimeout(() => {
      const contentWindow = iframeRef.current?.contentWindow;
      if (!contentWindow) return;
      contentWindow.postMessage(
        {
          source: HOST_MESSAGE_SOURCE,
          type: "preview-config",
          config: {
            productName: config.productName,
            logoUrl: config.logoUrl,
            accentColor: config.accentColor,
            position: config.position,
            title: config.title,
          },
        },
        window.location.origin,
      );
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [config.productName, config.logoUrl, config.accentColor, config.position, config.title]);

  return (
    <section className="panel panel--rail widget-preview-panel" data-testid="widget-preview">
      <div className="panel__header">
        <div className="panel__title">Live preview</div>
      </div>
      <div className="widget-preview-frame-wrap">
        <iframe
          ref={iframeRef}
          src={`/embed/${kbId}?preview=1`}
          title="Widget preview"
          className="widget-preview-frame"
          data-testid="widget-preview-frame"
        />
        {frameStatus === "error" ? (
          <p role="alert" className="widget-preview-frame__error">
            Preview couldn&apos;t load. Refresh this page, or check that the knowledge base is configured.
          </p>
        ) : null}
      </div>
    </section>
  );
}
