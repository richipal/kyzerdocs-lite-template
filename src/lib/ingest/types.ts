/**
 * Shapes shared by the ingest write-path: `validate.ts` (ING-01), `parse.ts` (ING-04/ING-07), and
 * `locate.ts` (ING-07). Kept in their own module so `validate.ts` and `parse.ts` do not import
 * from each other.
 */

/** One page's `[charStart, charEnd)` range into a PDF's concatenated extracted text. Produced by
 * `parse.ts` while concatenating `unpdf`'s per-page string array — this is the entire mechanism
 * by which a chunk's character offset (from the promoted, unmodified `chunk.ts`) resolves back to
 * a page number after chunking (`locate.ts#pageForRange`). */
export interface PageSpan {
  pageNumber: number;
  charStart: number;
  charEnd: number;
}

/** The result of `parseDocument()`. `pages`/`pageCount` are populated for PDF only — DOCX/TXT/MD
 * have no native page concept, so those formats carry an empty array and `null` rather than a
 * fabricated single "page". */
export interface ParsedDocument {
  text: string;
  pages: PageSpan[];
  pageCount: number | null;
  format: "pdf" | "docx" | "txt" | "md";
}

/** Metadata `validate.ts` and `parse.ts` both need about an uploaded file. `mimeType` is
 * browser-supplied and untrusted — see `validate.ts`'s header comment on the trust boundary. */
export interface FileMeta {
  filename: string;
  mimeType?: string;
  byteSize: number;
}
