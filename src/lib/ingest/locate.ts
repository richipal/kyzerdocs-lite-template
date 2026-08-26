/**
 * ING-07 citation-location mapping: turns a chunk's `[charStart, charEnd)` character offset (the
 * only thing the promoted, unmodified `chunk.ts` knows about) back into a page number and a
 * nearby section title, so a clicked citation can jump to the right passage (CHAT-03).
 *
 * `pipeline.ts` calls both functions after `chunkText()` to attach `pageNumber`/`sectionTitle` to
 * each chunk row — neither function touches `chunk.ts` itself.
 */

import type { PageSpan } from "./types.js";

/** Returns the page containing `charStart`, or `null` when `pages` is empty (DOCX/TXT/MD have no
 * page concept) — never throws on that input. */
export function pageForRange(pages: PageSpan[], charStart: number, _charEnd: number): number | null {
  if (pages.length === 0) return null;

  for (const span of pages) {
    if (charStart >= span.charStart && charStart < span.charEnd) {
      return span.pageNumber;
    }
  }

  // A chunk that starts exactly at the document's terminal offset (an empty trailing chunk, or a
  // charStart equal to the very last page's charEnd) still resolves to the last page rather than
  // falling through to null.
  const last = pages.at(-1)!;
  if (charStart === last.charEnd) return last.pageNumber;

  return null;
}

const MARKDOWN_HEADING_RE = /^#{1,6}\s+/;

/** Mirrors `chunk.ts#splitOnHeadingLines`'s `isHeadingLike` predicate verbatim (short, isolated
 * line with no trailing sentence punctuation, non-blank neighbors) — this is deliberate, not a
 * coincidence: it is what makes chunk.ts break a chunk boundary at this line, so a chunk boundary
 * and its detected section title must never disagree about what counts as a heading. This also
 * naturally covers ALL-CAPS section titles and numbered-section headings (e.g. "3.2 Safety
 * Procedures") the way chunk.ts's own tier 2 does for headerless PDF-extracted text — no separate
 * regex is needed for those, they already satisfy this same shape check. */
function isHeadingLike(line: string, prevLine: string | undefined, nextLine: string | undefined): boolean {
  const trimmed = line.trim();
  return (
    trimmed.length > 0 &&
    trimmed.length <= 80 &&
    !/[.!?:;,]$/.test(trimmed) &&
    (prevLine ?? "").trim().length > 0 &&
    (nextLine ?? "").trim().length > 0
  );
}

/** Returns the nearest heading line at or above `charStart`, or `null` when none exists. Markdown
 * `#` lines are recognized unconditionally (they commonly sit between blank lines, which would
 * otherwise fail the neighbor check below); everything else falls back to the same structural
 * heading heuristic `chunk.ts` uses for blank-line-free PDF text. */
export function sectionTitleForRange(text: string, charStart: number): string | null {
  const clamped = Math.max(0, Math.min(charStart, text.length));
  const lines = text.split("\n");

  // Locate the index of the line containing `clamped`.
  let offset = 0;
  let startLineIndex = lines.length - 1;
  for (let i = 0; i < lines.length; i++) {
    const lineLength = lines[i]!.length;
    if (clamped <= offset + lineLength) {
      startLineIndex = i;
      break;
    }
    offset += lineLength + 1; // +1 for the split-away '\n'
  }

  for (let i = startLineIndex; i >= 0; i--) {
    const line = lines[i]!;
    const trimmed = line.trim();

    const mdMatch = MARKDOWN_HEADING_RE.exec(trimmed);
    if (mdMatch) return trimmed.slice(mdMatch[0].length).trim();

    if (isHeadingLike(line, lines[i - 1], lines[i + 1])) {
      return trimmed;
    }
  }

  return null;
}
