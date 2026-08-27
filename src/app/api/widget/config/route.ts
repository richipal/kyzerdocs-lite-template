/**
 * GET/PUT /api/widget/config — ADMIN-04/WIDG-04/WIDG-05's admin-guarded read/write endpoint for
 * the single per-KB `WidgetConfig` blob (`src/lib/widget/config.ts`, plan 03-06). This is an admin
 * surface, not a public one — unlike `/api/embed/*`, `requireAdmin` opens both handlers, matching
 * every other protected route in this app (`/api/documents`, `/api/chat`). `npm run audit`'s check
 * (a) enforces this mechanically: this route is deliberately NOT on the allowlist.
 *
 * `PUT` validates the whole body against `widgetConfigSchema` (the same schema `setWidgetConfig`
 * itself enforces — never a second, divergent set of rules), then runs every `allowedDomains`
 * entry through `normalizeDomain` (`src/lib/widget/origin.ts`). T-03-09-02: a malformed domain
 * (e.g. a full URL) rejects the ENTIRE request with KDL-WIDG-006 rather than silently dropping just
 * that entry — a partially saved allowlist is a worse failure mode than an obvious rejection, since
 * the buyer would not notice one domain quietly missing.
 *
 * Phase 3 is single-KB scope (STOR-05 carried forward, mirrors plan 03-08's embed routes): there is
 * exactly one knowledge base (`DEFAULT_KB_ID`), so this route reads/writes it directly rather than
 * taking a `kbId` from the request.
 */

import { requireAdmin, unauthorizedResponse } from "../../../../lib/auth/session.js";
import { AppError } from "../../../../lib/errors.js";
import { DEFAULT_KB_ID } from "../../../../lib/types.js";
import { getWidgetConfig, setWidgetConfig, widgetConfigSchema } from "../../../../lib/widget/config.js";
import { normalizeDomain } from "../../../../lib/widget/origin.js";

/** Maps a caught `AppError`'s code to the HTTP status this route reports it under — the admin
 * config route's own twin of `/api/chat`'s and `/api/embed/*`'s `statusForCode`. Every response
 * body is `AppError.toJSON()` only (SUPP-01), never a stack trace or a raw validation error. */
function statusForCode(code: string): number {
  if (code === "KDL-AUTH-003") return 401;
  if (code === "KDL-WIDG-006") return 400;
  return 500;
}

function errorResponse(err: unknown): Response {
  if (err instanceof AppError) {
    return Response.json(err.toJSON(), { status: statusForCode(err.code) });
  }
  const generic = new AppError("KDL-WIDG-006", {
    message: err instanceof Error ? err.message : "An unexpected error occurred.",
  });
  return Response.json(generic.toJSON(), { status: 500 });
}

export async function GET(req: Request): Promise<Response> {
  try {
    await requireAdmin(req);
  } catch (err) {
    if (err instanceof AppError) return unauthorizedResponse(err);
    throw err;
  }

  const config = await getWidgetConfig(DEFAULT_KB_ID);
  return Response.json(config);
}

export async function PUT(req: Request): Promise<Response> {
  try {
    await requireAdmin(req);
  } catch (err) {
    if (err instanceof AppError) return unauthorizedResponse(err);
    throw err;
  }

  try {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      body = undefined;
    }

    const parsed = widgetConfigSchema.safeParse(body);
    if (!parsed.success) {
      throw new AppError("KDL-WIDG-006");
    }

    // Every allowedDomains entry must normalize to a bare host — the whole request is rejected on
    // the first failure rather than silently dropping the bad entry (T-03-09-02).
    const normalizedDomains: string[] = [];
    for (const rawDomain of parsed.data.allowedDomains) {
      const normalized = normalizeDomain(rawDomain);
      if (normalized === null) {
        throw new AppError("KDL-WIDG-006", {
          message: `"${rawDomain}" is not a valid domain. Enter a domain, like example.com — not a full URL.`,
        });
      }
      // Dedupe AFTER normalising, not before. Two different inputs collapse to one host —
      // `kyzer.ai` and `www.kyzer.ai` both normalise to `kyzer.ai` — so a pre-normalisation
      // uniqueness check sees two distinct strings and stores the same host twice. The client
      // deduped and this route did not, so an API caller (or a client bug) could persist
      // duplicates that then render as repeated rows (03-UAT F12).
      if (!normalizedDomains.includes(normalized)) {
        normalizedDomains.push(normalized);
      }
    }

    const validated = { ...parsed.data, allowedDomains: normalizedDomains };
    await setWidgetConfig(DEFAULT_KB_ID, validated);
    return Response.json(validated);
  } catch (err) {
    return errorResponse(err);
  }
}
