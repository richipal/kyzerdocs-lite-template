/**
 * Structure-aware text chunker for rung (c)'s self-chunked corpus.
 *
 * This exists so rung (c) can chunk the extracted corpus itself instead of depending on
 * KyzerDocs' exported chunk texts (01-08's fixture) — see this run's RUN-LOG.md "Run 2" entry
 * for why. It is deliberately not throwaway: this is the de-facto prototype Phase 2's real
 * ingestion pipeline will inherit, so it earns real tests and a real design, not a blind
 * character-window splitter.
 *
 * Splits hierarchically, escalating to a cheaper/blinder tier only when a candidate span still
 * exceeds `targetChars`:
 *
 *   1. Blank-line paragraph boundaries — works well for the corpus's authored DOCX/TXT/MD
 *      documents, which have real blank lines between paragraphs.
 *   2. Heading-like line boundaries (a short, isolated line with no trailing sentence
 *      punctuation, both neighbors non-blank) — this is the boundary that actually carries
 *      structure for the corpus's nine OSHA PDFs, whose `unpdf`-extracted text has ZERO blank
 *      lines (verified empirically against every PDF in the eval corpus's extracted-text set) but does
 *      carry section headings as isolated short lines between body text.
 *   3. Sentence boundaries (`.`/`!`/`?` followed by whitespace or end of span) — the fallback
 *      that guarantees every document gets *some* structure-aware split regardless of whether
 *      tiers 1 or 2 found anything. Over-splitting here (e.g. on "U.S.") is harmless: the
 *      packing step below re-merges small atoms up toward `targetChars` anyway.
 *   4. A hard character window, breaking at the nearest preceding whitespace within a small
 *      lookback — the only truly "blind" tier, reached only when a single sentence-level atom
 *      alone still exceeds `targetChars` (i.e., text with no sentence punctuation at all).
 *
 * Deterministic: a pure function of (text, filename, config) — no randomness, no wall-clock or
 * `Date` dependence, no reliance on object/Map iteration order beyond what the language
 * guarantees. The same input always produces byte-identical chunks, which is what makes a
 * measurement run reproducible from the config snapshot alone.
 */

export interface ChunkConfig {
  /** Soft target chunk size in characters. Every chunk's *core* (pre-overlap) span is packed up
   * toward this size without exceeding it; a chunk's final content can exceed it by up to
   * `overlapChars` once the leading-overlap prefix from the previous chunk is added. */
  targetChars: number;
  /** Characters of trailing context carried forward from the previous chunk into the start of
   * each subsequent chunk (except the first), so a fact split across a chunk boundary still
   * appears whole in at least one chunk. */
  overlapChars: number;
}

/**
 * ~1200 chars / ~150 chars overlap. At roughly 4 characters per token this targets ~300 tokens
 * per chunk with a ~12.5% overlap — a conventional RAG starting point, not a value tuned against
 * this run's results (this file is written and the corpus is chunked with this config before any
 * recall number exists in this run).
 */
export const DEFAULT_CHUNK_CONFIG: ChunkConfig = {
  targetChars: 1200,
  overlapChars: 150,
};

export interface Chunk {
  content: string;
  /** The source document's filename, matching `MANIFEST.json`/the golden dataset's
   * `source_document_filename` convention (extension included, e.g. `"service-warranty-faq.md"`). */
  filename: string;
  /** Equal to `filename` today (the corpus has one chunked unit per document) — kept as a
   * separate field so downstream code (FtsChunk/RetrievedChunk) never has to know that. */
  documentId: string;
  /** 0-indexed position of this chunk within its document, in chunking order. */
  chunkIndex: number;
  /** Character offset into the *original extracted text* where this chunk's content starts
   * (inclusive) — after any leading-overlap prefix has been applied, so `text.slice(charStart,
   * charEnd) === content` always holds. */
  charStart: number;
  /** Character offset into the original extracted text where this chunk's content ends
   * (exclusive). */
  charEnd: number;
}

interface Span {
  start: number;
  end: number;
}

function trimSpan(text: string, span: Span): Span {
  let s = span.start;
  let e = span.end;
  while (s < e && /\s/.test(text[s]!)) s++;
  while (e > s && /\s/.test(text[e - 1]!)) e--;
  return { start: s, end: e };
}

function nonEmpty(span: Span): boolean {
  return span.end > span.start;
}

/** Tier 1: split on one or more blank lines. Returns `[span]` unchanged (a length-1 array, the
 * "found nothing" signal `splitRecursive` checks for) when no blank line exists in the span. */
function splitOnBlankLines(span: Span, text: string): Span[] {
  const segment = text.slice(span.start, span.end);
  const re = /\n[ \t]*\n[ \t\n]*/g;
  const spans: Span[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(segment))) {
    if (m.index > last) {
      spans.push(trimSpan(text, { start: span.start + last, end: span.start + m.index }));
    }
    last = re.lastIndex;
  }
  if (last < segment.length) {
    spans.push(trimSpan(text, { start: span.start + last, end: span.end }));
  }
  return spans.filter(nonEmpty);
}

/** Tier 2: split immediately before a "heading-like" line — short, no trailing sentence
 * punctuation, with non-blank lines on both sides (so it reads as a label for what follows, not
 * a body sentence that happens to be alone). This is what recovers section structure from the
 * corpus's PDF-extracted text, which has no blank lines at all. */
function splitOnHeadingLines(span: Span, text: string): Span[] {
  const segment = text.slice(span.start, span.end);
  const lines = segment.split("\n");
  const breakOffsets: number[] = [];
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    const isHeadingLike =
      i > 0 &&
      i < lines.length - 1 &&
      trimmed.length > 0 &&
      trimmed.length <= 80 &&
      !/[.!?:;,]$/.test(trimmed) &&
      (lines[i - 1] ?? "").trim().length > 0 &&
      (lines[i + 1] ?? "").trim().length > 0;
    if (isHeadingLike) breakOffsets.push(offset);
    offset += line.length + 1;
  }
  if (breakOffsets.length === 0) return [span];

  const spans: Span[] = [];
  let prev = 0;
  for (const b of breakOffsets) {
    if (b > prev) spans.push(trimSpan(text, { start: span.start + prev, end: span.start + b }));
    prev = b;
  }
  spans.push(trimSpan(text, { start: span.start + prev, end: span.end }));
  return spans.filter(nonEmpty);
}

/** Tier 3: split after `.`/`!`/`?` (plus optional closing quote/paren) followed by whitespace or
 * end of span. Deliberately not abbreviation-aware (e.g. "U.S." splits) — over-splitting here is
 * harmless because `packAtomsIntoChunks` re-merges small atoms back up toward `targetChars`. */
function splitOnSentences(span: Span, text: string): Span[] {
  const segment = text.slice(span.start, span.end);
  const re = /[^.!?\n]*[.!?]+["')\]]*(?=\s|$)/g;
  const spans: Span[] = [];
  let lastEnd = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(segment))) {
    const end = m.index + m[0].length;
    if (end <= lastEnd) {
      // A zero-length match (e.g. consecutive punctuation) — advance manually to avoid looping.
      re.lastIndex = lastEnd + 1;
      continue;
    }
    spans.push(trimSpan(text, { start: span.start + lastEnd, end: span.start + end }));
    lastEnd = end;
  }
  if (lastEnd < segment.length) {
    spans.push(trimSpan(text, { start: span.start + lastEnd, end: span.end }));
  }
  return spans.filter(nonEmpty);
}

/** Tier 4 (last resort): a hard character window, breaking at the nearest preceding whitespace
 * within a small lookback so a split does not land mid-word when avoidable. Always makes
 * progress (each emitted span is strictly shorter than the input) as long as `targetChars > 0`,
 * which `chunkText` validates — this is what guarantees `splitRecursive` terminates. */
function splitOnHardWindow(span: Span, text: string, targetChars: number): Span[] {
  const spans: Span[] = [];
  let start = span.start;
  const lookback = Math.min(40, targetChars - 1);

  while (span.end - start > targetChars) {
    const cut = start + targetChars;
    let bestCut = cut;
    for (let i = cut; i > cut - lookback && i > start; i--) {
      if (/\s/.test(text[i]!)) {
        bestCut = i;
        break;
      }
    }
    spans.push(trimSpan(text, { start, end: bestCut }));
    start = bestCut;
  }
  spans.push(trimSpan(text, { start, end: span.end }));
  return spans.filter(nonEmpty);
}

const STRUCTURE_TIERS: Array<(span: Span, text: string) => Span[]> = [
  splitOnBlankLines,
  splitOnHeadingLines,
  splitOnSentences,
];

function splitRecursive(span: Span, text: string, targetChars: number, tierIndex: number): Span[] {
  if (span.end - span.start <= targetChars) return [span];
  if (tierIndex >= STRUCTURE_TIERS.length) {
    return splitOnHardWindow(span, text, targetChars);
  }

  const parts = STRUCTURE_TIERS[tierIndex]!(span, text);
  if (parts.length <= 1) {
    return splitRecursive(span, text, targetChars, tierIndex + 1);
  }

  const out: Span[] = [];
  for (const part of parts) {
    out.push(...splitRecursive(part, text, targetChars, 0));
  }
  return out;
}

/** Greedily merges consecutive atoms (each already `<= targetChars`) into chunks, closing the
 * current chunk and starting a new one only when the next atom would push it over `targetChars`.
 * This is what turns tier-generated atom boundaries into final chunk boundaries, rather than
 * emitting one chunk per atom regardless of size. */
function packAtomsIntoChunks(atoms: Span[], targetChars: number): Span[] {
  if (atoms.length === 0) return [];

  const chunks: Span[] = [];
  let bufStart = atoms[0]!.start;
  let bufEnd = atoms[0]!.end;

  for (let i = 1; i < atoms.length; i++) {
    const atom = atoms[i]!;
    const candidateLen = atom.end - bufStart;
    if (candidateLen > targetChars) {
      chunks.push({ start: bufStart, end: bufEnd });
      bufStart = atom.start;
      bufEnd = atom.end;
    } else {
      bufEnd = atom.end;
    }
  }
  chunks.push({ start: bufStart, end: bufEnd });
  return chunks;
}

/** Extends each chunk's start backward into `overlapChars` of the previous chunk's own span
 * (clamped so it never reaches before the previous chunk's start), so consecutive chunks share a
 * trailing/leading overlap. The first chunk is never extended (nothing precedes it). */
function applyOverlap(chunks: Span[], overlapChars: number): Span[] {
  if (overlapChars <= 0 || chunks.length <= 1) return chunks;

  const out: Span[] = [chunks[0]!];
  for (let i = 1; i < chunks.length; i++) {
    const prev = chunks[i - 1]!;
    const cur = chunks[i]!;
    const newStart = Math.max(prev.start, cur.start - overlapChars);
    out.push({ start: newStart, end: cur.end });
  }
  return out;
}

/**
 * Chunks one document's already-extracted plain text, deterministically. Every chunk carries
 * `filename`/`documentId` and a `[charStart, charEnd)` span into `text` — the metadata
 * span-based recall@k scorer (the eval harness's own scoring module) needs to locate a chunk's
 * content back in the source document, and that `text.slice(charStart, charEnd) === content` invariant is
 * verified by this module's own test suite for every chunk this function can produce.
 *
 * Returns `[]` for a document whose extracted text is empty or whitespace-only (nothing to
 * chunk) — never throws on that input, since an already-excluded zero-text document (e.g. the
 * corpus's scanned PDF) legitimately has none.
 */
export function chunkText(
  text: string,
  filename: string,
  config: ChunkConfig = DEFAULT_CHUNK_CONFIG,
): Chunk[] {
  if (config.targetChars <= 0) {
    throw new Error(`chunkText: targetChars must be > 0, got ${config.targetChars}`);
  }
  if (config.overlapChars < 0) {
    throw new Error(`chunkText: overlapChars must be >= 0, got ${config.overlapChars}`);
  }
  if (config.overlapChars >= config.targetChars) {
    throw new Error(
      `chunkText: overlapChars (${config.overlapChars}) must be less than targetChars ` +
        `(${config.targetChars})`,
    );
  }

  if (text.trim().length === 0) return [];

  const fullSpan: Span = trimSpan(text, { start: 0, end: text.length });
  const atoms = splitRecursive(fullSpan, text, config.targetChars, 0);
  const packed = packAtomsIntoChunks(atoms, config.targetChars);
  const withOverlap = applyOverlap(packed, config.overlapChars);

  return withOverlap.map((span, i) => ({
    content: text.slice(span.start, span.end),
    filename,
    documentId: filename,
    chunkIndex: i,
    charStart: span.start,
    charEnd: span.end,
  }));
}
