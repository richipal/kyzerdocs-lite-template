/**
 * ING-01 upload gate: file type and size allowlist, trimmed from KyzerDocs'
 * `apps/web/lib/file-validation-constants.ts` + `file-validation.ts` to the four types this
 * product supports (PDF/DOCX/TXT/MD — no images, video, audio, or PPTX; PPTX is v2 per
 * REQUIREMENTS.md).
 *
 * SECURITY BOUNDARY NOTE (T-02-03-01): this module is a UX filter, not the trust boundary. A file
 * that passes here can still be a renamed binary with a spoofed MIME type — `parse.ts` is what
 * fails closed when content does not actually parse as the claimed type. The pipeline never uses
 * the buyer-supplied filename as a filesystem path (T-02-03-04, handled in plan 02-05's storage
 * layer via a server-generated UUID).
 */

import { AppError } from "../errors.js";
import type { FileMeta } from "./types.js";

/** Trimmed to one category — Lite has no images/video/audio tier, so the sibling repo's
 * per-category loop collapses to a direct membership check (see `isSupportedMime`). */
export const SUPPORTED_FILE_TYPES = {
  documents: {
    "application/pdf": [".pdf"],
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"],
    "text/plain": [".txt"],
    "text/markdown": [".md", ".markdown"],
  },
} as const;

/** Reverse mapping: file extension -> MIME type. Used as a fallback when the browser-supplied
 * MIME type is missing or generic (`application/octet-stream`) — Windows browsers frequently omit
 * MIME entirely — and as the source of truth an explicit MIME type is checked against. */
export const EXTENSION_TO_MIME_TYPE: Record<string, string> = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
};

export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024; // 100 MB

function isSupportedMime(mime: string): boolean {
  return mime in SUPPORTED_FILE_TYPES.documents;
}

function getExtension(filename: string): string | null {
  const lastDotIndex = filename.lastIndexOf(".");
  if (lastDotIndex <= 0) return null; // no dot, or a dotfile with no extension (".gitignore")
  return filename.slice(lastDotIndex).toLowerCase();
}

/**
 * Throws a coded `AppError` on rejection, returns void on acceptance.
 *
 * Type/size are checked in that order: an unsupported type is rejected before size is even
 * considered, so a buyer sees "wrong file type" rather than "too large" for e.g. an oversized
 * `.png`.
 */
export function validateFileMetadata(meta: FileMeta): void {
  const { filename, mimeType, byteSize } = meta;

  const ext = getExtension(filename);
  const extMime = ext ? EXTENSION_TO_MIME_TYPE[ext] : undefined;

  const isGenericMime = !mimeType || mimeType === "application/octet-stream";
  const resolvedMime = isGenericMime ? extMime : mimeType;

  // The extension itself must be one of the four supported types, and (when the browser supplied
  // a specific, non-generic MIME type) it must agree with what the extension implies — a mismatch
  // is treated as a rejection rather than silently trusting one side or the other (T-02-03-01).
  if (!extMime || !resolvedMime || !isSupportedMime(resolvedMime)) {
    throw new AppError("KDL-UPLOAD-001");
  }
  if (!isGenericMime && mimeType !== extMime) {
    throw new AppError("KDL-UPLOAD-001");
  }

  if (byteSize === 0) {
    throw new AppError("KDL-UPLOAD-003");
  }
  if (byteSize > MAX_UPLOAD_BYTES) {
    throw new AppError("KDL-UPLOAD-002");
  }
}
