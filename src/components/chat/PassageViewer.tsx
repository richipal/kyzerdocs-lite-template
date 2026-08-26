"use client";

/**
 * CHAT-03: clicking a citation chip opens this in-page panel showing the cited chunk's own
 * content, filename, page/section, and character range — same page, never a new tab. The sibling
 * repo's `SourceCitations.tsx` uses `window.open(document_url, "_blank")` because its documents
 * are hosted files; this product's citation unit is a retrieved chunk, not a file, so the click
 * target is the chunk's own `snippet` content rendered in place (02-PATTERNS.md).
 */

import type { Source } from "../../lib/chat/citations.js";

export function PassageViewer({ source, onClose }: { source: Source; onClose: () => void }) {
  const location = [source.page !== null ? `Page ${source.page}` : null, source.sectionTitle]
    .filter((part): part is string => Boolean(part))
    .join(" · ");

  return (
    <div role="dialog" aria-label={`Source passage from ${source.filename}`} className="passage-viewer">
      <div className="passage-viewer__eyebrow">Source {source.marker}</div>
      <div className="passage-viewer__header">
        <strong>{source.filename}</strong>
        <button type="button" onClick={onClose} aria-label="Close passage viewer" className="passage-viewer__close">
          Close
        </button>
      </div>
      <p className="passage-viewer__meta">
        {location}
        {location ? " " : ""}
        (characters {source.charStart}–{source.charEnd})
      </p>
      <p className="passage-viewer__body">{source.snippet}</p>
    </div>
  );
}
