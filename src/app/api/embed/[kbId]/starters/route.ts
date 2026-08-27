/**
 * GET /api/embed/{kbId}/starters — WIDG's public twin of `/api/chat/starters` (CHAT-06), guarded
 * by the same three-step sequence as `/api/embed/{kbId}/chat` (kbId -> origin allowlist -> rate
 * limit — see that route's header comment for the full rationale). This route must NEVER call the
 * admin session guard `src/lib/auth/session.js` exports for every protected route — if that guard
 * call ever appears here, that is itself the defect.
 *
 * The generation-keyed cache, `FALLBACK_QUESTIONS`, and the empty-corpus short-circuit (returning
 * `{ questions: [] }` with no model call) all carry over from the admin route unchanged
 * (03-PATTERNS.md) — the widget's own zero-document copy is a client-side rendering decision
 * (`StarterQuestions.tsx`'s `variant="widget"` branch), not a change to this route's response
 * shape. The cache key stays per-KB (`starters:{kbId}`), so one buyer's starters never appear in
 * another's widget, and is intentionally the SAME key the admin route already writes to — both
 * surfaces read the same underlying corpus-derived questions for a given KB.
 */

import { generateObject } from "ai";
import { z } from "zod";
import type { AttemptResult } from "../../../../../lib/auth/rate-limit.js";
import { judgeModel } from "../../../../../lib/chat/model.js";
import { AppError } from "../../../../../lib/errors.js";
import { getRateLimiter } from "../../../../../lib/rate-limit/index.js";
import { getStorageDriver } from "../../../../../lib/storage/index.js";
import { DEFAULT_KB_ID } from "../../../../../lib/types.js";
import { getWidgetConfig } from "../../../../../lib/widget/config.js";
import { isOriginAllowed } from "../../../../../lib/widget/origin.js";

const STARTERS_KEY_PREFIX = "starters:";
const TARGET_STARTER_COUNT = 4;

const startersSchema = z.object({
  questions: z.array(z.string().min(1)).min(3).max(5),
});

interface CachedStarters {
  generation: number;
  questions: string[];
}

/** Generic, corpus-agnostic fallback used only if the judge call itself fails. */
const FALLBACK_QUESTIONS = [
  "What topics do these documents cover?",
  "What are the key policies described here?",
  "Is there anything I should know before I get started?",
];

function buildStarterPrompt(filenames: readonly string[]): string {
  const list = filenames.map((f) => `- ${f}`).join("\n");
  return `A user is about to ask questions about the following uploaded documents:

${list}

Suggest ${TARGET_STARTER_COUNT} short, specific example questions a user could ask about this
document set. Base them on what these filenames suggest the documents actually contain. Each
question should be a single natural sentence a non-technical person would type, under 15 words,
with no numbering or preamble.`;
}

/** First hop of `x-forwarded-for` when present, otherwise a constant key — mirrors
 * src/app/api/auth/login/route.ts's `clientKey`. */
function clientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return "unknown";
}

export async function GET(
  req: Request,
  context: { params: Promise<{ kbId: string }> },
): Promise<Response> {
  const { kbId } = await context.params;

  // Guard 1: kbId must name a real knowledge base BEFORE any driver call takes it as a parameter.
  if (kbId !== DEFAULT_KB_ID) {
    return Response.json(new AppError("KDL-WIDG-003").toJSON(), { status: 404 });
  }

  // Guard 2: origin allowlist — convenience filter only (D3-12), never the real control.
  //
  // An ABSENT Origin header is same-origin, and must be allowed. This endpoint's only browser
  // caller is the embed page fetching its own starters from inside the iframe, and browsers omit
  // Origin on same-origin GETs — they send it on same-origin POSTs, which is why the chat route
  // worked while this one 403'd and the widget opened with no suggested questions (03-UAT F14).
  //
  // Rejecting the empty string here also meant `isOriginAllowed("")` was doing the deciding, and
  // it correctly refuses an unparseable origin — the guard was working exactly as written against
  // a request it was never meant to judge. What reaches this line with no Origin is either this
  // page's own fetch or a non-browser client, and the latter is what guard 3's rate limit is for:
  // D3-12 is explicit that the allowlist is a convenience filter and the limiter is the backstop.
  const config = await getWidgetConfig(kbId);
  const origin = req.headers.get("origin");
  if (origin !== null && !isOriginAllowed(origin, config.allowedDomains)) {
    return Response.json(new AppError("KDL-WIDG-001").toJSON(), { status: 403 });
  }

  // Guard 3: rate limit — the real backstop (D3-15/16). A thrown KDL-WIDG-005 is a 503 and never
  // falls through to serving the request.
  let attempt: AttemptResult;
  try {
    attempt = await getRateLimiter().consume(`${clientIp(req)}:${kbId}`);
  } catch (err) {
    if (err instanceof AppError) return Response.json(err.toJSON(), { status: 503 });
    const generic = new AppError("KDL-CHAT-003", {
      message: err instanceof Error ? err.message : "An unexpected error occurred.",
    });
    return Response.json(generic.toJSON(), { status: 500 });
  }
  if (!attempt.allowed) {
    return Response.json(new AppError("KDL-WIDG-002").toJSON(), {
      status: 429,
      headers: { "Retry-After": String(attempt.retryAfterSeconds) },
    });
  }

  const driver = getStorageDriver();
  const documents = await driver.listDocuments(kbId);
  const ready = documents.filter((d) => d.status === "ready" && d.supersededBy === null);

  if (ready.length === 0) {
    return Response.json({ questions: [] });
  }

  const generation = await driver.getGeneration(kbId);
  const cacheKey = `${STARTERS_KEY_PREFIX}${kbId}`;
  const cachedRaw = await driver.getSetting(cacheKey);

  if (cachedRaw) {
    try {
      const cached = JSON.parse(cachedRaw) as CachedStarters;
      if (
        cached.generation === generation &&
        Array.isArray(cached.questions) &&
        cached.questions.length > 0
      ) {
        return Response.json({ questions: cached.questions });
      }
    } catch {
      // A corrupt cache row must never break this endpoint — fall through and regenerate.
    }
  }

  let questions: string[];
  try {
    const result = await generateObject({
      model: judgeModel(),
      schema: startersSchema,
      prompt: buildStarterPrompt(ready.map((d) => d.filename)),
    });
    const parsed = startersSchema.safeParse(result.object);
    questions = parsed.success ? parsed.data.questions : FALLBACK_QUESTIONS;
  } catch {
    questions = FALLBACK_QUESTIONS;
  }

  await driver.setSetting(
    cacheKey,
    JSON.stringify({ generation, questions } satisfies CachedStarters),
    generation,
  );

  return Response.json({ questions });
}
