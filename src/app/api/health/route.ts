/**
 * GET /api/health — DELIV-03 status surface (D2-14: lives inside the document screen, not a
 * third page). Reports four checks: database, GEMINI_API_KEY presence, embedding model liveness,
 * and chat provider key presence.
 *
 * T-02-08-01: this route is deliberately reachable WITHOUT a session, but only in redacted form.
 * A buyer whose `ADMIN_PASSWORD` is misconfigured cannot log in, and a health page they cannot
 * reach is useless exactly when they need it most — so unauthenticated callers get booleans and
 * KDL codes only, never env values, file paths, provider error text, or document names.
 * `requireAdmin` succeeding adds per-check `message`/`action`, the database path, corpus counts,
 * and the most recent failed document's filename/code.
 *
 * T-02-08-03: the embedding liveness probe is cached in memory for 60 seconds so repeatedly
 * polling this screen cannot amplify into repeated provider calls.
 *
 * `indexRebuild` (plan 03-07, D3-18, UI-STANDARDS.md S-5): the last REAL cold vector-index
 * rebuild duration observed by `getVectorIndex()` in THIS process, never a copy of
 * `03-COLDSTART.md`'s benchmark numbers. Omitted entirely (not `null`, not `0`) until this
 * process has actually rebuilt the index at least once — `HealthPanel.tsx` renders no row at all
 * for the absent case. T-03-07-04 (accepted, not mitigated): visible to BOTH authenticated and
 * unauthenticated callers, unlike the other checks' detail fields — a rebuild duration alone
 * reveals corpus scale only to the order of magnitude, the same class of information the
 * always-visible `ok`/`code` booleans on every other check already carry.
 *
 * `blob` (plan 03-10, STOR-06, UI-SPEC Surface 4): a REAL reachability check against the Blob
 * store (`list({ limit: 1 })`) — not a token-presence check, so a revoked or wrong token reports
 * unhealthy rather than healthy. Present ONLY in cloud mode — omitted entirely in local mode,
 * where Blob storage is not part of the deployment and reporting on it would be meaningless noise
 * (same "omit, never a placeholder" discipline `indexRebuild` follows). The response never
 * includes the token or the store's URL — `buildCheckBody` only ever emits the static
 * `message`/`action` copy from `ERROR_CODES`, never a raw provider error or config value.
 *
 * Every check fails soft: one failing probe reports its own failure and the others still run and
 * return normally. A 500 from this route would defeat its entire purpose.
 */

import { list } from "@vercel/blob";
import { resolveChatProvider } from "../../../lib/chat/model.js";
import { PRODUCT_CONFIG } from "../../../lib/config.js";
import { resolveBlobAuth } from "../../../lib/storage/blob-auth.js";
import { embedQuery } from "../../../lib/embeddings/gemini.js";
import { ERROR_CODES, type ErrorCode } from "../../../lib/errors.js";
import { requireAdmin } from "../../../lib/auth/session.js";
import { getLastRebuildDurationMs } from "../../../lib/retrieval/vector-index.js";
import { getDriverLabel, getStorageDriver } from "../../../lib/storage/index.js";
import { DEFAULT_KB_ID } from "../../../lib/types.js";

const EMBEDDING_CACHE_TTL_MS = 60_000;
const EMBEDDING_PROBE_TEXT = "kyzerdocs-lite health check";

interface CheckResult {
  ok: boolean;
  code?: ErrorCode;
}

interface DatabaseCheckResult extends CheckResult {
  counts?: { total: number; ready: number; failed: number };
}

/** Module-scoped so it survives across requests within the same server process — this is exactly
 * what makes the caching test's "one embedQuery call across five requests" claim possible. */
let embeddingCache: { result: CheckResult; expiresAt: number } | null = null;

function isPresent(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function statusOf(err: unknown): number | undefined {
  const status = (err as { status?: unknown } | undefined)?.status;
  return typeof status === "number" ? status : undefined;
}

async function checkDatabase(): Promise<DatabaseCheckResult> {
  try {
    const driver = getStorageDriver();
    const counts = await driver.countDocuments(DEFAULT_KB_ID);
    return { ok: true, counts };
  } catch {
    return { ok: false, code: "KDL-DB-001" };
  }
}

function checkApiKeyPresence(): CheckResult {
  if (!isPresent(process.env.GEMINI_API_KEY)) {
    return { ok: false, code: "KDL-CFG-001" };
  }
  return { ok: true };
}

/**
 * Live `embedQuery` liveness probe, cached for `EMBEDDING_CACHE_TTL_MS`. Skipped entirely (no
 * network call, no cache write) when `GEMINI_API_KEY` is already known absent — that is the same
 * root cause the `apiKey` check already reports, not a fresh embedding-specific failure. A 401/403
 * from the provider is reclassified as `KDL-CFG-003` (key present but rejected) rather than the
 * generic `KDL-EMBED-002` (unreachable), matching the registry's actual semantics.
 */
async function checkEmbedding(apiKeyPresent: boolean): Promise<CheckResult> {
  if (!apiKeyPresent) {
    return { ok: false, code: "KDL-CFG-001" };
  }

  const now = Date.now();
  if (embeddingCache && embeddingCache.expiresAt > now) {
    return embeddingCache.result;
  }

  let result: CheckResult;
  try {
    await embedQuery(EMBEDDING_PROBE_TEXT);
    result = { ok: true };
  } catch (err) {
    const status = statusOf(err);
    result =
      status === 401 || status === 403
        ? { ok: false, code: "KDL-CFG-003" }
        : { ok: false, code: "KDL-EMBED-002" };
  }

  embeddingCache = { result, expiresAt: now + EMBEDDING_CACHE_TTL_MS };
  return result;
}

/** Presence-only (D2-09c/D2-09d, T-02-07-07): never makes a live call to whichever provider is
 * active, and never reveals which optional key a buyer has never heard of unless they are
 * authenticated. */
function checkChatProvider(): CheckResult {
  const provider = resolveChatProvider();
  if (provider === "google") {
    return isPresent(process.env.GEMINI_API_KEY) ? { ok: true } : { ok: false, code: "KDL-CFG-001" };
  }
  // resolveChatProvider() only returns "openrouter" when OPENROUTER_API_KEY is present and
  // non-blank, so this branch is only ever reached with a key already known to be present.
  return { ok: true };
}

/**
 * Real reachability probe against the Blob store — `list({ limit: 1 })`, never a token-presence
 * check. Only called at all in cloud mode (see `GET` below). No token configured is reported as
 * `KDL-BLOB-001` (the deployment is incomplete, not merely "unreachable right now") without ever
 * attempting a call; any thrown error from `list()` itself (revoked token, deleted store, network
 * failure) is `KDL-BLOB-004`. Never caches — unlike `checkEmbedding`, a revoked token should be
 * visible on the very next poll, not for up to 60 seconds.
 */
async function checkBlob(): Promise<CheckResult> {
  const auth = resolveBlobAuth();
  if (!auth) {
    return { ok: false, code: "KDL-BLOB-001" };
  }
  try {
    await list({ ...auth, limit: 1 });
    return { ok: true };
  } catch {
    return { ok: false, code: "KDL-BLOB-004" };
  }
}

async function getLastFailedDocument(): Promise<{ filename: string; errorCode: string | null } | null> {
  try {
    const driver = getStorageDriver();
    const all = await driver.listDocuments(DEFAULT_KB_ID);
    const failed = all
      .filter((d) => d.status === "failed")
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const mostRecent = failed[0];
    return mostRecent ? { filename: mostRecent.filename, errorCode: mostRecent.errorCode } : null;
  } catch {
    return null;
  }
}

/** Shapes one check's response body. Unauthenticated callers get `{ ok, code? }` only — no
 * `message`/`action` text, which is detail reserved for an authenticated caller (T-02-08-01). */
function buildCheckBody(result: CheckResult, authenticated: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = { ok: result.ok };
  if (result.code) {
    body.code = result.code;
    if (authenticated) {
      const entry = ERROR_CODES[result.code];
      body.message = entry.message;
      body.action = entry.action;
    }
  }
  return body;
}

export async function GET(req: Request): Promise<Response> {
  let authenticated = false;
  try {
    await requireAdmin(req);
    authenticated = true;
  } catch {
    authenticated = false;
  }

  const apiKeyPresent = isPresent(process.env.GEMINI_API_KEY);

  const [databaseResult, embeddingResult] = await Promise.all([
    checkDatabase(),
    checkEmbedding(apiKeyPresent),
  ]);
  const apiKeyResult = checkApiKeyPresence();
  const chatProviderResult = checkChatProvider();

  const body: Record<string, unknown> = {
    database: buildCheckBody(databaseResult, authenticated),
    apiKey: buildCheckBody(apiKeyResult, authenticated),
    embedding: buildCheckBody(embeddingResult, authenticated),
    chatProvider: buildCheckBody(chatProviderResult, authenticated),
  };

  // Fail-soft, matching this route's own convention (module header): a bad read of the
  // module-level duration must never turn this route into a 500. Omitted entirely (not `null`,
  // not `0`) until a real rebuild has happened in this process (S-5).
  try {
    const rebuildMs = getLastRebuildDurationMs();
    if (rebuildMs !== null) {
      body.indexRebuild = { ms: Math.round(rebuildMs) };
    }
  } catch {
    // Absent field on failure — same as "no rebuild observed yet," never a placeholder.
  }

  // Cloud-mode only (UI-SPEC Surface 4) — omitted entirely in local mode, where Blob storage is
  // not part of the deployment. `checkBlob` itself never throws (fails soft internally), but this
  // is wrapped anyway to match the route's own "a bad probe must never turn this into a 500"
  // convention rather than relying on the probe's own discipline alone.
  if (PRODUCT_CONFIG.cloudMode) {
    try {
      const blobResult = await checkBlob();
      body.blob = buildCheckBody(blobResult, authenticated);
    } catch {
      // Omitted on an unexpected failure — same as "no probe result," never a placeholder.
    }
  }

  if (authenticated) {
    (body.database as Record<string, unknown>).path = PRODUCT_CONFIG.paths.databasePath;
    (body.chatProvider as Record<string, unknown>).provider = resolveChatProvider();
    body.corpus = databaseResult.counts ?? { total: 0, ready: 0, failed: 0 };
    body.lastFailedDocument = await getLastFailedDocument();
    // UI-SPEC Surface 4 (plan 03-09): AppShell's sidebar meta line reads this to render
    // `{driver label} · cloud` in cloud mode — a real, config-derived label, never a hardcoded
    // "Postgres" string in the component itself.
    body.driver = { cloudMode: PRODUCT_CONFIG.cloudMode, label: getDriverLabel() };
  }

  return Response.json(body, { status: 200 });
}
