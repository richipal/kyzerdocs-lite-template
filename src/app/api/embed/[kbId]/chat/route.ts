/**
 * POST /api/embed/{kbId}/chat — WIDG-01/02/03/05/06's genuinely public chat endpoint. This is the
 * highest-risk route in the phase: it is unauthenticated by design (D3-13 — the widget structurally
 * cannot carry an admin session, a password, or any API key), so it MUST NEVER call the admin
 * session guard `src/lib/auth/session.js` exports for every protected route. If that guard call
 * ever appears here, that is itself the defect (03-PATTERNS.md's negative template) —
 * `scripts/audit-surface.mjs` check (e) enforces this permanently.
 *
 * Three guards run, in this exact order, BEFORE any driver call takes an untrusted value and
 * BEFORE any model is contacted:
 *   1. `kbId` validated against a real knowledge base — KDL-WIDG-003, 404. Phase 3 is single-KB
 *      scope (STOR-05 carried forward): `DEFAULT_KB_ID` is the only knowledge base that can exist
 *      yet, so equality against it IS the validation. This runs first so an attacker cannot probe
 *      arbitrary strings through `searchKeyword`/`getAllChunkVectors` (T-03-08-02) — and so a
 *      request with both a bad kbId AND a bad origin proves kbId is checked first (a bad-origin
 *      403 would leak that a KB with that origin's allowlist exists at all).
 *   2. Origin checked against the KB's allowlist — KDL-WIDG-001, 403. D3-12: the `Origin` header
 *      is spoofable by any non-browser client, so this is a convenience filter, not the real
 *      control — never rely on it alone.
 *   3. Rate limit consumed, keyed `${clientIp}:${kbId}`, never IP alone — KDL-WIDG-002, 429 with
 *      `Retry-After`. This is the real backstop (WIDG-06, D3-15/16). If the limiter itself throws
 *      (KDL-WIDG-005 — the shared store is unreachable in cloud mode), that is a 503 and NEVER
 *      falls through to serving the request: an unenforced limiter that looks like protection is
 *      worse than none (D3-15).
 *
 * Only once all three pass does control reach Phase 2's unchanged chat call order — condenseQuery
 * -> retrieve -> checkGroundedness -> stream, with every `data-citation` part written BEFORE the
 * model stream is merged in (CHAT-02) — reused verbatim from src/app/api/chat/route.ts:96-140.
 *
 * Deliberately NOT reused: the admin route's earlier `hasReadyDocument`/KDL-CHAT-001 early return
 * (route.ts:85-91, before the verbatim block this file copies). An empty corpus here flows
 * straight into `checkGroundedness`, which naturally refuses with KDL-CHAT-002 — the same calm,
 * no-red refusal styling every other refusal gets. The admin route's KDL-CHAT-001 response renders
 * an "Upload a document" link (`MessageList.tsx`) that assumes admin access a public visitor does
 * not have; reproducing that response here would be exactly the S-6 misdiagnosis defect this plan
 * exists to prevent.
 */

import { createUIMessageStream, createUIMessageStreamResponse, streamText, toUIMessageStream } from "ai";
import { z } from "zod";
import { buildAnswerSystemPrompt } from "../../../../../lib/chat/system-prompt.js";
import { buildContextBlock, buildSources } from "../../../../../lib/chat/citations.js";
import { condenseQuery, type ChatTurn } from "../../../../../lib/chat/condense.js";
import { checkGroundedness } from "../../../../../lib/chat/groundedness.js";
import { chatModel } from "../../../../../lib/chat/model.js";
import type { AttemptResult } from "../../../../../lib/auth/rate-limit.js";
import { AppError } from "../../../../../lib/errors.js";
import { getRateLimiter } from "../../../../../lib/rate-limit/index.js";
import { retrieve } from "../../../../../lib/retrieval/search.js";
import { DEFAULT_KB_ID } from "../../../../../lib/types.js";
import { getWidgetConfig } from "../../../../../lib/widget/config.js";
import { isOriginAllowed } from "../../../../../lib/widget/origin.js";

const requestSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().min(1),
      }),
    )
    .min(1),
});

/** Maps a caught `AppError`'s code to the HTTP status this route reports it under — the WIDG
 * family's twin of the admin route's `statusForCode`. Every response body is `AppError.toJSON()`
 * only (SUPP-01), never a stack trace or a raw provider error. */
function statusForCode(code: string): number {
  if (code === "KDL-WIDG-004") return 400;
  if (code === "KDL-WIDG-005") return 503;
  return 500;
}

function errorResponse(err: unknown): Response {
  if (err instanceof AppError) {
    return Response.json(err.toJSON(), { status: statusForCode(err.code) });
  }
  const generic = new AppError("KDL-CHAT-003", {
    message: err instanceof Error ? err.message : "An unexpected error occurred.",
  });
  return Response.json(generic.toJSON(), { status: 500 });
}

/** First hop of `x-forwarded-for` when present, otherwise a constant key — mirrors
 * src/app/api/auth/login/route.ts's `clientKey`. */
function clientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return "unknown";
}

export async function POST(
  req: Request,
  context: { params: Promise<{ kbId: string }> },
): Promise<Response> {
  const { kbId } = await context.params;

  // Guard 1: kbId must name a real knowledge base BEFORE any driver call takes it as a parameter.
  if (kbId !== DEFAULT_KB_ID) {
    return Response.json(new AppError("KDL-WIDG-003").toJSON(), { status: 404 });
  }

  // Guard 2: origin allowlist — convenience filter only (D3-12), never the real control.
  const config = await getWidgetConfig(kbId);
  const origin = req.headers.get("origin") ?? "";
  if (!isOriginAllowed(origin, config.allowedDomains)) {
    return Response.json(new AppError("KDL-WIDG-001").toJSON(), { status: 403 });
  }

  // Guard 3: rate limit — the real backstop (D3-15/16). A thrown KDL-WIDG-005 is a 503 and never
  // falls through to serving the request.
  let attempt: AttemptResult;
  try {
    attempt = await getRateLimiter().consume(`${clientIp(req)}:${kbId}`);
  } catch (err) {
    return errorResponse(err);
  }
  if (!attempt.allowed) {
    return Response.json(new AppError("KDL-WIDG-002").toJSON(), {
      status: 429,
      headers: { "Retry-After": String(attempt.retryAfterSeconds) },
    });
  }

  try {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      body = undefined;
    }
    const parsed = requestSchema.safeParse(body);
    if (!parsed.success) {
      // KDL-WIDG-004, not a reachability code — the request never left the browser (S-6).
      throw new AppError("KDL-WIDG-004");
    }
    const { messages } = parsed.data;

    const lastMessage = messages[messages.length - 1]!;
    const history: ChatTurn[] = messages.slice(0, -1);
    const question = lastMessage.content;

    const condensed = await condenseQuery(history, question);
    const chunks = await retrieve(kbId, condensed);
    const verdict = await checkGroundedness(condensed, chunks);

    // Degrade-and-continue, same as the admin route: a logging failure must never turn a
    // legitimate answer into a 500.
    try {
      console.log(
        `[embed-chat] kbId=${kbId} prefilterTopScore=${verdict.prefilterTopScore.toFixed(4)} judged=${verdict.judged} grounded=${verdict.grounded}`,
      );
    } catch {
      // logging is never allowed to affect the response
    }

    if (!verdict.grounded) {
      const refused = new AppError("KDL-CHAT-002", { message: verdict.rationale });
      return Response.json(
        { ...refused.toJSON(), rationale: verdict.rationale, sources: [] },
        { status: 200 },
      );
    }

    const contextBlock = buildContextBlock(chunks);
    const sources = buildSources(chunks);
    const systemPrompt = buildAnswerSystemPrompt(contextBlock);

    const stream = createUIMessageStream({
      execute: ({ writer }) => {
        // Every citation is written before the model stream is merged in — the client has the
        // full source list before the first token (CHAT-02).
        for (const source of sources) {
          writer.write({ type: "data-citation", data: source });
        }
        const result = streamText({
          model: chatModel(),
          system: systemPrompt,
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
        });
        writer.merge(toUIMessageStream({ stream: result.stream }));
      },
    });

    return createUIMessageStreamResponse({ stream });
  } catch (err) {
    return errorResponse(err);
  }
}
