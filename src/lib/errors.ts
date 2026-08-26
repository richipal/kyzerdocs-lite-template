/**
 * SUPP-01 greppable error-code registry. Every user-facing failure mode in the product carries a
 * `KDL-*` code so a buyer can paste it into a support request (or grep it themselves) instead of
 * a raw stack trace. See PITFALLS.md Pitfall 11.
 *
 * `AppError.toJSON()` is the only shape that ever reaches a client response body — it emits
 * `{ code, message, action }` and never a stack trace, a file path, or any env value (see this
 * plan's threat register, T-02-01-02).
 */

export const ERROR_CODES = {
  "KDL-CFG-001": {
    message: "GEMINI_API_KEY is not set.",
    action: "Add GEMINI_API_KEY to your .env.local — get one at https://aistudio.google.com/apikey.",
  },
  "KDL-CFG-002": {
    message: "ADMIN_PASSWORD is not set.",
    action: "Add ADMIN_PASSWORD to your .env.local — set it to any password you choose.",
  },
  "KDL-CFG-003": {
    message: "The configured API key was rejected by the provider.",
    action: "Check that GEMINI_API_KEY is correct and has not been revoked, then try again.",
  },
  "KDL-CFG-004": {
    // Plan 02-07 (D2-09c/D2-09d) redefines this code: it fires ONLY when the optional OpenRouter
    // chat key was present and the provider rejected it — never for the (normal, majority) case
    // of the key being absent, which is silent by design (see src/lib/chat/model.ts).
    message: "Your OpenRouter chat provider key was rejected.",
    action: "Check that your optional OpenRouter chat key is correct and has not been revoked, then try again.",
  },
  "KDL-DB-001": {
    message: "The database file could not be opened.",
    action: "Check that DATABASE_PATH points to a writable location and the disk has free space.",
  },
  "KDL-DB-002": {
    message: "A database schema migration failed.",
    action: "Check the server logs for the failing statement, then restart the app.",
  },
  "KDL-UPLOAD-001": {
    message: "This file type is not supported.",
    action: "Upload a PDF, DOCX, TXT, or MD file.",
  },
  "KDL-UPLOAD-002": {
    message: "This file is too large.",
    action: "Upload a smaller file, or split it into multiple documents.",
  },
  "KDL-UPLOAD-003": {
    message: "This file is empty.",
    action: "Upload a file that contains content.",
  },
  "KDL-PARSE-001": {
    message: "No text could be extracted — this looks like a scanned PDF with no text layer.",
    action: "Upload a text-based PDF, or run this file through OCR first.",
  },
  "KDL-PARSE-002": {
    message: "This PDF is password-protected.",
    action: "Remove the password protection and re-upload the file.",
  },
  "KDL-PARSE-003": {
    message: "This file could not be read — it may be unreadable or corrupt.",
    action: "Re-export or re-save the file, then try uploading it again.",
  },
  "KDL-PARSE-004": {
    message: "Text extraction from this DOCX file failed.",
    action: "Re-save the file from its original application and try again.",
  },
  "KDL-EMBED-001": {
    message: "The embedding API rate limit or quota was exhausted.",
    action: "Wait a few minutes and try again, or check your AI Studio quota.",
  },
  "KDL-EMBED-002": {
    message: "The embedding API could not be reached.",
    action: "Check your network connection and try again.",
  },
  "KDL-EMBED-003": {
    message: "An embedding failed its normalization check.",
    action: "This is an internal error — please retry; if it persists, report it with this code.",
  },
  "KDL-INGEST-001": {
    message: "Document ingestion failed.",
    action: "Check the document status for details, then retry the upload.",
  },
  "KDL-INGEST-002": {
    message: "Document ingestion was interrupted and can be resumed.",
    action: "Retry the upload — ingestion will continue from where it left off.",
  },
  "KDL-AUTH-001": {
    message: "Incorrect password.",
    action: "Check ADMIN_PASSWORD in your .env.local and try again.",
  },
  "KDL-AUTH-002": {
    message: "Too many login attempts.",
    action: "Wait a few minutes before trying again.",
  },
  "KDL-AUTH-003": {
    message: "You are not signed in.",
    action: "Sign in with the admin password to continue.",
  },
  "KDL-CHAT-001": {
    message: "No documents have been indexed yet.",
    action: "Upload at least one document before asking a question.",
  },
  "KDL-CHAT-002": {
    message: "The answer was refused because the retrieved passages do not answer the question.",
    action: "Rephrase the question, or upload a document that covers this topic.",
  },
  "KDL-CHAT-003": {
    message: "The chat model could not be reached.",
    action: "Check your network connection and API key, then try again.",
  },
  /*
    Split out of KDL-CHAT-003. That code was thrown both when the model was genuinely unreachable
    AND when the request body failed schema validation, but its copy only described the first —
    so a malformed request told the buyer to check their network and API key, sending them to
    diagnose a working model. Real occurrence: a serialization defect made every second question
    of a session fail this way, and the reported symptom was "cannot reach the chat model" for a
    request that never left the browser.
  */
  "KDL-CHAT-004": {
    message: "The chat request was malformed and the server rejected it.",
    action:
      "This is a bug in the app, not a problem with your key or connection. Reload the page and ask again — if it keeps happening, quote KDL-CHAT-004 in a support message.",
  },
  /*
    Phase 3 (WIDG-01/05, D3-12/D3-13). Buyer-facing, not visitor-facing: this fires when the
    admin's Widget screen or an init-time domain check rejects a host page whose origin is not on
    the KB's allowlist. Per UI-SPEC, the widget itself renders nothing and only console.errors for
    this case — this code/copy is surfaced to the buyer (e.g. in the admin UI or a support
    message), never injected into the visitor's page.
  */
  "KDL-WIDG-001": {
    message: "This website is not on the allowed-domains list for this knowledge base.",
    action: "Add this domain in the Widget screen's Allowed domains list, then reload the page.",
  },
  /*
    The one WIDG code a real site visitor can actually read (mid-conversation, after the widget
    has already rendered). Distinct from KDL-WIDG-001 (an init-time, buyer-only failure): this
    fires on every request once the per-IP/per-KB limiter (WIDG-06, the real backstop per D3-12)
    is tripped. Per S-6 this copy must contain no credential, provider, or configuration
    vocabulary — a stranger on the buyer's website reads this, not the buyer.
  */
  "KDL-WIDG-002": {
    message: "This chat is getting a lot of questions right now.",
    action: "Please try again in a minute.",
  },
  /*
    Distinct from KDL-WIDG-001 (origin rejected) and KDL-CHAT-001 (no documents indexed yet): this
    fires when the `kbId` path segment itself does not match any known knowledge base — e.g. a
    stale or mistyped install snippet. Buyer-facing (surfaces while the buyer is wiring up their
    own install snippet), not visitor-facing in the normal case.
  */
  "KDL-WIDG-003": {
    message: "No knowledge base matches this id.",
    action:
      "Check the data-kb-id value in your install snippet against the one shown on the Widget screen.",
  },
  /*
    The /api/embed/* twin of KDL-CHAT-004, and exists for the same S-6 reason: a request-schema
    validation failure must never be reported as a reachability/network failure, or a visitor (and
    the buyer debugging on their behalf) is sent to diagnose a connection that was never the
    problem. Real Phase 2 precedent: KDL-CHAT-003's original copy caused exactly this
    misdiagnosis for a serialization defect.
  */
  "KDL-WIDG-004": {
    message: "The widget request was malformed and the server rejected it.",
    action:
      "This is a bug in the app, not a problem with your site. Reload the page and ask again — if it keeps happening, quote KDL-WIDG-004 in a support message.",
  },
  /*
    Phase 3 (D3-15/D3-16): cloud mode requires the shared Postgres-backed rate limiter, because
    the in-memory token bucket (src/lib/auth/rate-limit.ts) resets on every fresh serverless
    invocation and enforces nothing there. If that shared store is ever unreachable, the public
    route fails CLOSED with this code rather than silently serving unlimited traffic — an
    unenforced limiter that looks like protection is worse than none. The client-visible copy is
    deliberately non-specific (no mention of Postgres/DATABASE_URL) because a site visitor is not
    the audience for the specific cause; that detail is logged server-side only.
  */
  "KDL-WIDG-005": {
    message: "This chat is not available right now.",
    action: "The site owner needs to finish configuring their deployment — quote KDL-WIDG-005 to them.",
  },
  /*
    Distinct from KDL-DB-001 (SQLite file could not be opened): this is the Postgres cloud-mode
    equivalent — the connection itself could not be established (bad/unreachable DATABASE_URL,
    Neon endpoint down, etc.), not a local file-permission problem.
  */
  "KDL-DB-003": {
    message: "The database could not be reached.",
    action: "Check that DATABASE_URL is correct and the database is running, then try again.",
  },
  /*
    Distinct from KDL-DB-002 (a migration that failed WHILE running, local SQLite): this fires
    when the Postgres schema was never migrated at all — e.g. a fresh cloud deploy where
    `npm run db:migrate` has not yet been run against DATABASE_URL. The failure mode (missing
    tables) and the fix (run the migration) are both different from KDL-DB-002's.
  */
  "KDL-DB-004": {
    message: "The database schema is missing or out of date.",
    action: "Run `npm run db:migrate` against your DATABASE_URL, then restart the app.",
  },
  /*
    New in plan 03-03 (developer-approved deviation from the plan's original task text — see
    03-03-SUMMARY.md). Fires when a resolved DATABASE_URL's host is not recognizably a Neon host.
    This project's own .env.local already carries KYZERDOCS_DATABASE_URL pointing at KyzerDocs'
    live production Supabase database — one crossed env-var name away from DATABASE_URL. Fails
    closed: allowlists Neon's own hostname pattern rather than blocklisting Supabase specifically,
    so the next unrelated provider is caught too (D3-06). Distinct from KDL-DB-003 (a Neon host
    that could not be reached) — this fires before any connection attempt, on the host string
    alone.
  */
  "KDL-DB-005": {
    message: "The configured database is not a recognized Neon host.",
    action: "Check DATABASE_URL — it must point at a Neon Postgres database (host ending in neon.tech), not any other provider.",
  },
  /*
    Phase 3 (STOR-06): parallels KDL-DB-003/004 for the Blob storage half of cloud mode. Fires
    when BLOB_READ_WRITE_TOKEN is absent/blank in cloud mode — distinct from KDL-BLOB-002 (a write
    that was attempted and failed) because here no attempt was made at all; the deployment itself
    is incomplete.
  */
  "KDL-BLOB-001": {
    message: "File storage is not configured for this deployment.",
    action: "Connect a Blob store to your Vercel project and redeploy. If one is already connected, open it, create a read-write token, add it to the project as BLOB_READ_WRITE_TOKEN, and redeploy.",
  },
  /*
    Fires when a `put()` call to Vercel Blob itself fails (token revoked, store deleted, transient
    provider error) during upload — distinct from KDL-BLOB-001 (never configured at all) and
    KDL-BLOB-003 (a write that succeeded but a later read of that same object fails).
  */
  "KDL-BLOB-002": {
    message: "The uploaded file could not be stored.",
    action: "Check that the Blob store still exists and its token has not been revoked, then re-upload.",
  },
  /*
    Fires when a previously-stored document's blob object cannot be read back (deleted out of
    band, corrupted, or the store itself is gone) — distinct from KDL-BLOB-002, which fires at
    write time, not read time.
  */
  "KDL-BLOB-003": {
    message: "The stored copy of this document could not be read.",
    action: "Re-upload the document — its stored copy is missing or unreadable.",
  },
  /*
    Plan 03-10 (STOR-06), `GET /api/health`'s `blob` probe. Fires when a real reachability check
    against the Blob store (`list({ limit: 1 })`, never a token-presence check alone) throws — a
    revoked token, a deleted store, or a network failure. Distinct from KDL-BLOB-001 (no token
    configured at all — checked first, before this probe ever runs) and KDL-BLOB-002/003 (a
    specific write/read of a specific object failed) — this is the health panel's general "is the
    store reachable right now" signal, parallel to KDL-DB-003's role for Postgres.
  */
  "KDL-BLOB-004": {
    message: "Blob storage could not be reached.",
    action: "Check that your Blob store still exists and BLOB_READ_WRITE_TOKEN is correct, then try again.",
  },
  /*
    Plan 03-09 (ADMIN-04/WIDG-04/WIDG-05). Fires on `PUT /api/widget/config` when the submitted
    body fails `widgetConfigSchema` (a field shape is wrong — bad hex colour, title over 40 chars,
    an unknown position value) OR when an `allowedDomains` entry fails `normalizeDomain` (a full
    URL instead of a bare host). Distinct from KDL-WIDG-004 (the /api/embed/* PUBLIC route's
    malformed-request code, visitor-facing): this is the ADMIN route's twin, buyer-facing only, and
    the whole request is rejected rather than silently dropping the one bad entry — a partially
    saved allowlist would be worse than an obvious rejection.
  */
  "KDL-WIDG-006": {
    message: "The widget configuration you submitted is invalid.",
    action: "Check each field — domain format, accent colour, title length — and try again.",
  },
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export interface AppErrorJSON {
  code: ErrorCode;
  message: string;
  action: string;
}

/**
 * The one error type user-facing code throws. `toJSON()` is deliberately narrow — it must never
 * be extended to include `stack`, a file path, or any env value (T-02-01-02).
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly action: string;
  override readonly cause?: unknown;

  constructor(code: ErrorCode, options?: { cause?: unknown; message?: string }) {
    const entry = ERROR_CODES[code];
    super(options?.message ?? entry.message);
    this.name = "AppError";
    this.code = code;
    this.action = entry.action;
    this.cause = options?.cause;
  }

  toJSON(): AppErrorJSON {
    return { code: this.code, message: this.message, action: this.action };
  }
}
