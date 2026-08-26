"use client";

/**
 * Renders exactly the `data-citation` parts the server attached to an assistant turn (CHAT-02 at
 * the UI layer, T-02-09-02 mitigation) — deduped by marker (so every marker the model
 * cites has a clickable chip), sorted by marker, behind a collapsible "Sources (N)" disclosure with a truncated
 * filename and a title tooltip (structure lifted from the sibling repo's `SourceCitations.tsx`,
 * see 02-PATTERNS.md). This component never scans message text for bracket markers, filenames, or
 * URLs to construct a citation: it only ever reads the `sources` prop, which the caller builds
 * exclusively from `data-citation` parts. If `[9]` appears in an answer's text with no matching
 * citation part, nothing here notices — there is no code path that inspects that text at all.
 */

import type { Source } from "../../lib/chat/citations.js";

export type { Source };

/**
 * Dedupe by MARKER, not by document.
 *
 * This previously kept one chip per document (earliest marker). With a single uploaded file that is
 * catastrophic: six retrieved chunks collapse to one chip while the model correctly writes "[1] …
 * [3] … [6]", so most markers in the prose have no chip to click and CHAT-03's "click a citation,
 * see the passage it came from" simply does not work. Reported from a real session: markers
 * [1] [3] [6] in the answer, one chip rendered.
 *
 * The citation unit in this product is a chunk — a specific passage at a specific location — not a
 * file. Two passages from the same policy are two different pieces of evidence and each needs to be
 * reachable. Deduping by marker only collapses genuine duplicates (the same chunk retrieved twice
 * by the vector and keyword arms before fusion).
 */
function dedupeByMarker(sources: readonly Source[]): Source[] {
  const byMarker = new Map<number, Source>();
  for (const source of sources) {
    if (!byMarker.has(source.marker)) byMarker.set(source.marker, source);
  }
  return [...byMarker.values()].sort((a, b) => a.marker - b.marker);
}

function locationLabel(source: Source): string {
  if (source.page !== null) return `p. ${source.page}`;
  if (source.sectionTitle) return source.sectionTitle;
  return "";
}

function truncateFilename(filename: string, max = 28): string {
  return filename.length > max ? `${filename.slice(0, max - 1)}…` : filename;
}

export function CitationChips({
  sources,
  onSelect,
}: {
  sources: readonly Source[];
  onSelect: (source: Source) => void;
}) {
  const unique = dedupeByMarker(sources);
  if (unique.length === 0) return null;

  return (
    // `open` so the sources row renders expanded by default, matching the design template's
    // always-visible "Sources" row under an answer — still a real <details>, so a user can
    // collapse it natively if they want to.
    <details className="citation-disclosure" open>
      <summary className="citation-summary">Sources ({unique.length})</summary>
      <ul className="citation-list">
        {unique.map((source) => {
          const location = locationLabel(source);
          return (
            <li key={source.chunkId}>
              <button
                type="button"
                title={source.filename}
                onClick={() => onSelect(source)}
                className="citation-chip"
                data-citation={source.marker}
              >
                [{source.marker}] {truncateFilename(source.filename)}
                {location ? `, ${location}` : ""}
              </button>
            </li>
          );
        })}
      </ul>
    </details>
  );
}
