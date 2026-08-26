/**
 * ING-04/ING-07 write-path parser: dispatches by format (unpdf for PDF, mammoth for DOCX, plain
 * UTF-8 decode for TXT/MD) and hands back extracted text plus — for PDF only — a page-boundary
 * map. The promoted chunker (`chunk.ts`) emits character offsets and nothing else; this module is
 * what makes a chunk's offset resolvable back to a page number after chunking (`locate.ts`), and
 * it is new, not promoted — see 02-RESEARCH.md's Structure Rationale.
 *
 * Every PDF failure mode this module can detect maps to a specific KDL code rather than a generic
 * "failed to parse" (ING-04, SUPP-01): no text layer (scanned PDF, `KDL-PARSE-001`),
 * password-protected (`KDL-PARSE-002`), unreadable/corrupt (`KDL-PARSE-003`), and DOCX extraction
 * failure (`KDL-PARSE-004`).
 */

import { extractRawText } from "mammoth";
import { extractText, getDocumentProxy } from "unpdf";
import { AppError } from "../errors.js";
import type { FileMeta, PageSpan, ParsedDocument } from "./types.js";

/** Fixed joiner between consecutive PDF pages in the concatenated text. Included inside the
 * *preceding* page's span (see `parsePdf` below) so `pages[i].charEnd === pages[i + 1].charStart`
 * always holds — the page-span contiguity invariant `parse.test.ts` asserts. */
const PAGE_JOINER = "\n\n";

/** Below this average non-whitespace-characters-per-page, a PDF is classified as having no text
 * layer (KDL-PARSE-001) rather than treated as a thin-but-real document. Calibrated against the
 * Phase 1 corpus's own `evals/reports/parse-audit.json` (RESEARCH.md Assumption A4): the corpus's
 * scanned fixture (`osha-tractor-hazards-agricultural-workers-scanned.pdf`) yields 0 chars across
 * 3 pages by construction (verified image-only, no `/Font`), and the least-dense *text-bearing*
 * real page average among the corpus's nine OSHA PDFs is 1263 chars/page
 * (`osha-aed-cardiac-arrest-workplace.pdf`, 4 pages, 5052 non-whitespace chars per
 * `evals/reports/parse-audit.json`). 100 chars/page sits nowhere near either measured boundary. */
const MIN_CHARS_PER_PAGE = 100;

function nonWhitespaceLength(text: string): number {
  return text.replace(/\s+/g, "").length;
}

/**
 * Classifies an error thrown while opening/extracting a PDF into a specific KDL code. Exported so
 * the classifier can be unit-tested by injecting synthetic errors (RESEARCH.md Assumption A2:
 * unpdf/pdf.js's exact error strings/classes are not part of unpdf's stable public API — verified
 * against the installed version this session rather than assumed) without depending on a real
 * encrypted-PDF fixture, which this corpus does not have.
 *
 * Verified directly against the installed `unpdf`/pdf.js this session: a garbage or truncated
 * buffer throws `InvalidPDFException` with message `"Invalid PDF structure."`; pdf.js's password
 * path throws `PasswordException` with messages `"No password given"` / `"Incorrect Password"`.
 */
export function classifyPdfError(err: unknown): AppError {
  const message = err instanceof Error ? err.message : String(err);
  if (/password/i.test(message)) {
    return new AppError("KDL-PARSE-002", { cause: err });
  }
  return new AppError("KDL-PARSE-003", { cause: err });
}

function formatFromFilename(filename: string): ParsedDocument["format"] {
  const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  switch (ext) {
    case ".pdf":
      return "pdf";
    case ".docx":
      return "docx";
    case ".txt":
      return "txt";
    case ".md":
    case ".markdown":
      return "md";
    default:
      // validate.ts is the gate that should have already rejected this filename — reaching here
      // means a caller skipped validation, so fail closed with the same code validation would
      // have used rather than a generic error.
      throw new AppError("KDL-UPLOAD-001");
  }
}

async function parsePdf(bytes: Uint8Array): Promise<ParsedDocument> {
  let pageTexts: string[];
  let totalPages: number;
  try {
    // unpdf/pdf.js transfers (detaches) the underlying ArrayBuffer when handing it to its worker
    // via postMessage — passing `bytes` directly would silently neuter the caller's buffer after
    // the first call, breaking `parseDocument`'s documented purity (same input bytes -> same
    // output, repeatable). Copy defensively so the caller's original buffer is never touched.
    const pdf = await getDocumentProxy(bytes.slice());
    const result = await extractText(pdf, { mergePages: false });
    pageTexts = result.text;
    totalPages = result.totalPages;
  } catch (err) {
    throw classifyPdfError(err);
  }

  let text = "";
  const pages: PageSpan[] = [];
  for (let i = 0; i < pageTexts.length; i++) {
    const charStart = text.length;
    text += pageTexts[i]!;
    if (i < pageTexts.length - 1) {
      text += PAGE_JOINER;
    }
    pages.push({ pageNumber: i + 1, charStart, charEnd: text.length });
  }

  const charsPerPage = nonWhitespaceLength(text) / Math.max(totalPages, 1);
  if (charsPerPage < MIN_CHARS_PER_PAGE) {
    throw new AppError("KDL-PARSE-001");
  }

  return { text, pages, pageCount: totalPages, format: "pdf" };
}

async function parseDocx(bytes: Uint8Array): Promise<ParsedDocument> {
  let value: string;
  try {
    const result = await extractRawText({ buffer: Buffer.from(bytes) });
    value = result.value;
  } catch (err) {
    throw new AppError("KDL-PARSE-004", { cause: err });
  }
  return { text: value, pages: [], pageCount: null, format: "docx" };
}

function parsePlainText(bytes: Uint8Array, format: "txt" | "md"): ParsedDocument {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  return { text, pages: [], pageCount: null, format };
}

/**
 * Extracts text (and, for PDF, a verified page-boundary map) from an uploaded file's raw bytes.
 * Pure with respect to its input bytes: the same bytes always produce the same `text`/`pages`.
 * Hands the extracted text back exactly as extracted — no normalization, no whitespace collapsing
 * — because the chunker's offsets and the eval harness's span-based recall both assume the text
 * they measure is the text that was chunked.
 */
export async function parseDocument(bytes: Uint8Array, meta: FileMeta): Promise<ParsedDocument> {
  const format = formatFromFilename(meta.filename);
  switch (format) {
    case "pdf":
      return parsePdf(bytes);
    case "docx":
      return parseDocx(bytes);
    case "txt":
    case "md":
      return parsePlainText(bytes, format);
  }
}
