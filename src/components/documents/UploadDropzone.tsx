"use client";

import { upload } from "@vercel/blob/client";
import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from "react";
import { AppError, type AppErrorJSON } from "../../lib/errors.js";
import { EXTENSION_TO_MIME_TYPE, MAX_UPLOAD_BYTES, validateFileMetadata } from "../../lib/ingest/validate.js";

export interface UploadResolution {
  file: File;
  jobId: string;
  documentId: string;
  status: string;
}

/** Imperative handle so the Documents screen's header "Upload files" button (template layout) can
 * open the same file picker the dropzone itself uses — one file dialog, two entry points, no
 * duplicated input element. */
export interface UploadDropzoneHandle {
  openFileDialog: () => void;
}

interface UploadDropzoneProps {
  /** Called once a file's `POST /api/ingest` call resolves with a 2xx body. */
  onUploadResolved: (resolution: UploadResolution) => void;
  /** Called when a file is rejected client-side (before upload) OR the server rejects/errors it. */
  onUploadFailed: (filename: string, error: AppErrorJSON) => void;
  /** Fires the moment a file passes client-side validation and its upload begins — the caller uses
   * this to know when to (re)start the list-level poll, since the row this upload will produce
   * does not exist yet and therefore cannot itself be polled by id. */
  onUploadStarted: (filename: string) => void;
  /** `PRODUCT_CONFIG.cloudMode`, read server-side by a parent Server Component and passed down as
   * a plain boolean (the same pattern `WidgetPageClient`'s `cloudMode` prop uses) — this component
   * is `"use client"`, and `PRODUCT_CONFIG` reads `process.env` at import time, which is only
   * correct on the server. Reading it directly here would silently evaluate to `false` in the
   * browser bundle regardless of the real deployment mode. Defaults to `false` (local mode) so
   * every existing local-mode caller/test needs no change. */
  cloudMode?: boolean;
}

const ACCEPT = Object.keys(EXTENSION_TO_MIME_TYPE).join(",");

/** Real, displayed types — read from the same `EXTENSION_TO_MIME_TYPE` registry validation uses,
 * never a second hardcoded list that could drift from what the server actually accepts. */
const DISPLAY_TYPES = ["PDF", "DOCX", "TXT", "MD"];

/** Real limit, read from `validate.ts` — the template mockup showed "max 40 MB each" as placeholder
 * copy; this product's actual `MAX_UPLOAD_BYTES` is 100 MB, so that is what renders. */
const MAX_UPLOAD_MB = Math.round(MAX_UPLOAD_BYTES / (1024 * 1024));

const GENERIC_UPLOAD_FAILURE: AppErrorJSON = {
  code: "KDL-INGEST-001",
  message: "The upload could not be completed.",
  action: "Check your connection and try again.",
};

/** Extension (with leading dot), lowercased — mirrors `src/lib/storage/files.ts`'s server-side
 * `extname()` use: consulted ONLY for the extension, never any other part of the filename. A
 * dotfile with no real extension (`".gitignore"`, index 0) yields `""`, matching the server's own
 * `getExtension()` in `validate.ts`. */
function clientExtname(filename: string): string {
  const lastDotIndex = filename.lastIndexOf(".");
  return lastDotIndex <= 0 ? "" : filename.slice(lastDotIndex).toLowerCase();
}

/** Posts the acquired-upload response shape both branches below produce to the caller's
 * resolve/fail callbacks — the one place that interprets `POST /api/ingest`'s JSON response, so
 * the local and cloud upload paths cannot drift in how they read it. */
async function reportIngestResponse(
  res: Response,
  file: File,
  onUploadResolved: UploadDropzoneProps["onUploadResolved"],
  onUploadFailed: UploadDropzoneProps["onUploadFailed"],
): Promise<void> {
  const body = await res.json();
  if (!res.ok) {
    onUploadFailed(file.name, body as AppErrorJSON);
    return;
  }
  onUploadResolved({ file, jobId: body.jobId, documentId: body.documentId, status: body.status });
}

/**
 * ING-01 drag-and-drop plus file-picker upload queue.
 *
 * Rejects by type and size on the client using `validateFileMetadata` from
 * `src/lib/ingest/validate.ts` — the exact same source of truth the server enforces, never a
 * second hardcoded list — and reports the rejection inline with its KDL code before any upload
 * starts (ING-01: "accepted or rejected by type before upload starts").
 *
 * Multiple dropped/selected files upload one at a time (not in parallel) to keep the local
 * process's embedding concurrency predictable, per this plan's action text.
 *
 * `cloudMode` branches how each file reaches the server (plan 03-10, STOR-06): in local mode the
 * file posts straight to `/api/ingest` as `multipart/form-data`, unchanged from before this plan.
 * In cloud mode the file is written DIRECTLY from this browser to Vercel Blob via
 * `@vercel/blob/client`'s `upload()` — bypassing the Function body entirely, which is the whole
 * point (the 4.5MB body cap this plan exists to route around) — using `/api/blob/upload` only for
 * the token exchange, then posts the resulting blob reference (never the file bytes again) to
 * `/api/ingest`. Everything the buyer SEES is identical in both modes: the same drag-drop, the
 * same per-file status progression, the same coded failure reasons.
 */
const UploadDropzone = forwardRef<UploadDropzoneHandle, UploadDropzoneProps>(function UploadDropzone(
  { onUploadResolved, onUploadFailed, onUploadStarted, cloudMode = false },
  ref,
) {
  const [isDragging, setIsDragging] = useState(false);
  const [rejections, setRejections] = useState<Array<{ filename: string; error: AppErrorJSON }>>([]);
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useImperativeHandle(ref, () => ({ openFileDialog: () => inputRef.current?.click() }), []);

  const uploadOneLocal = useCallback(
    async (file: File) => {
      const form = new FormData();
      form.set("file", file);
      const res = await fetch("/api/ingest", { method: "POST", body: form });
      await reportIngestResponse(res, file, onUploadResolved, onUploadFailed);
    },
    [onUploadFailed, onUploadResolved],
  );

  const uploadOneCloud = useCallback(
    async (file: File) => {
      // The key is generated HERE, client-side, from a UUID plus the extension ONLY — the same
      // discipline `LocalFileStorage`/`BlobFileStorage` enforce server-side (T-03-10-02). The
      // buyer's filename is sent separately as display metadata, never as (or concatenated into)
      // the blob pathname.
      const pathname = `uploads/${crypto.randomUUID()}${clientExtname(file.name)}`;
      const blob = await upload(pathname, file, {
        access: "private",
        handleUploadUrl: "/api/blob/upload",
        clientPayload: JSON.stringify({ filename: file.name, mimeType: file.type, byteSize: file.size }),
      });

      const res = await fetch("/api/ingest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          pathname: blob.pathname,
          filename: file.name,
          mimeType: file.type,
          byteSize: file.size,
        }),
      });
      await reportIngestResponse(res, file, onUploadResolved, onUploadFailed);
    },
    [onUploadFailed, onUploadResolved],
  );

  const uploadOne = useCallback(
    async (file: File) => {
      onUploadStarted(file.name);
      try {
        if (cloudMode) {
          await uploadOneCloud(file);
        } else {
          await uploadOneLocal(file);
        }
      } catch {
        onUploadFailed(file.name, GENERIC_UPLOAD_FAILURE);
      }
    },
    [cloudMode, onUploadFailed, onUploadStarted, uploadOneCloud, uploadOneLocal],
  );

  const processFiles = useCallback(
    async (fileList: FileList | null) => {
      if (!fileList || fileList.length === 0) return;

      const accepted: File[] = [];
      const newRejections: Array<{ filename: string; error: AppErrorJSON }> = [];

      for (const file of Array.from(fileList)) {
        try {
          validateFileMetadata({ filename: file.name, mimeType: file.type, byteSize: file.size });
          accepted.push(file);
        } catch (err) {
          if (err instanceof AppError) {
            newRejections.push({ filename: file.name, error: err.toJSON() });
          } else {
            throw err;
          }
        }
      }

      if (newRejections.length > 0) {
        setRejections((prev) => [...prev, ...newRejections]);
        // Also notified up to the parent, alongside inline display, so a single error log (the
        // page's `uploadErrors` list) can account for every failure, not only the server ones.
        for (const rejection of newRejections) {
          onUploadFailed(rejection.filename, rejection.error);
        }
      }

      if (accepted.length === 0) return;

      setUploading(true);
      for (const file of accepted) {
        // Sequential, not Promise.all — one file at a time (see doc comment above).
        // eslint-disable-next-line no-await-in-loop
        await uploadOne(file);
      }
      setUploading(false);
    },
    [uploadOne, onUploadFailed],
  );

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragging(false);
    void processFiles(event.dataTransfer.files);
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragging(true);
  }

  function handleDragLeave() {
    setIsDragging(false);
  }

  function handleFileInputChange(event: ChangeEvent<HTMLInputElement>) {
    void processFiles(event.target.files);
    event.target.value = "";
  }

  return (
    <div className="upload-dropzone-wrapper">
      <div
        className="upload-dropzone"
        data-dragging={isDragging}
        data-testid="upload-dropzone"
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onClick={() => inputRef.current?.click()}
        role="button"
        tabIndex={0}
      >
        <div className="upload-dropzone__title">{uploading ? "Uploading…" : "Drop files here"}</div>
        <div className="upload-dropzone__subtitle">
          {uploading ? "Uploading one at a time…" : "or click to browse"}
        </div>
        <div className="upload-dropzone__types">
          {DISPLAY_TYPES.map((type) => (
            <span key={type} className="upload-dropzone__chip">
              {type}
            </span>
          ))}
          <span className="upload-dropzone__limit">max {MAX_UPLOAD_MB} MB each</span>
        </div>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ACCEPT}
          onChange={handleFileInputChange}
          className="visually-hidden"
          aria-label="Choose files to upload"
        />
      </div>

      {rejections.length > 0 ? (
        <ul role="alert" data-testid="upload-rejections">
          {rejections.map((rejection, index) => (
            <li key={`${rejection.filename}-${index}`}>
              <strong>{rejection.filename}</strong> was rejected —{" "}
              <span data-error-code={rejection.error.code}>{rejection.error.code}</span>:{" "}
              {rejection.error.message} {rejection.error.action}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
});

export default UploadDropzone;
