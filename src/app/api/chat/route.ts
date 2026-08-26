/**
 * POST /api/chat — CHAT-01/02/04/05 streaming answer endpoint. `requireAdmin(req)` is the first
 * statement (ADMIN-02, T-02-07-04): a direct `curl` with no session cookie is rejected here
 * regardless of what `src/proxy.ts`'s page-navigation redirect does. Private tier has no public
 * chat surface — that's Phase 3's widget, with its own origin allowlist and rate limit.
 *
 * Call order: `condenseQuery` (CHAT-05, resolves a follow-up against prior turns before retrieval
 * ever runs) -> `retrieve` (the hybrid read path) -> `checkGroundedness` (CHAT-04's real
 * mechanism, D2-06/07/08). If the gate refuses, this returns a plain JSON refusal — no stream, no
 * second model call for a "sorry" message. Only once the gate passes does this build the
 * marker-numbered context, attach `sources[]`, and stream: every `data-citation` part is written
 * BEFORE the model stream is merged in, so the client has the citation list before the first token
 * and never has to parse one out of generated text (CHAT-02).
 */

import { createUIMessageStream, createUIMessageStreamResponse, streamText, toUIMessageStream } from "ai";
import { z } from "zod";
import { requireAdmin, unauthorizedResponse } from "../../../lib/auth/session.js";
import { buildAnswerSystemPrompt } from "../../../lib/chat/system-prompt.js";
import { buildContextBlock, buildSources } from "../../../lib/chat/citations.js";
import { condenseQuery, type ChatTurn } from "../../../lib/chat/condense.js";
import { checkGroundedness } from "../../../lib/chat/groundedness.js";
import { chatModel } from "../../../lib/chat/model.js";
import { AppError } from "../../../lib/errors.js";
import { retrieve } from "../../../lib/retrieval/search.js";
import { getStorageDriver } from "../../../lib/storage/index.js";
import { DEFAULT_KB_ID } from "../../../lib/types.js";

const requestSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().min(1),
      }),
    )
    .min(1),
  kbId: z.string().min(1).optional(),
});

/** Maps an `AppError`'s code family to the HTTP status this route reports it under — the same
 * pattern `/api/ingest`'s route already establishes. Every response body is `AppError.toJSON()`
 * only (SUPP-01), never a stack trace or a raw provider error. */
function statusForCode(code: string): number {
  if (code === "KDL-AUTH-003") return 401;
  if (code === "KDL-CHAT-001" || code === "KDL-CHAT-002") return 200;
  // A malformed body is a client error, not a server fault. Reporting it as 500 also misleads
  // anything watching error rates into thinking the service is failing.
  if (code === "KDL-CHAT-004") return 400;
  return 500;
}

function errorResponse(err: unknown): Response {
  if (err instanceof AppError) {
    return Response.json(err.toJSON(), { status: statusForCode(err.code) });
  }
  // KDL-CHAT-003: "the chat model could not be reached" is this route's generic, coded 500
  // fallback for anything unclassified (network failure reaching whichever provider is active,
  // an SDK-internal error, etc.) — never a raw stack trace or provider error body.
  const generic = new AppError("KDL-CHAT-003", {
    message: err instanceof Error ? err.message : "An unexpected error occurred.",
  });
  return Response.json(generic.toJSON(), { status: 500 });
}

export async function POST(req: Request): Promise<Response> {
  try {
    await requireAdmin(req);
  } catch (err) {
    if (err instanceof AppError) return unauthorizedResponse(err);
    throw err;
  }

  try {
    const body = await req.json();
    const parsed = requestSchema.safeParse(body);
    if (!parsed.success) {
      // KDL-CHAT-004, not -003: the model was never contacted. Reporting a reachability failure
      // here sends the buyer to check an API key and network that are both fine.
      throw new AppError("KDL-CHAT-004");
    }
    const { messages, kbId: bodyKbId } = parsed.data;
    const kbId = bodyKbId ?? DEFAULT_KB_ID;

    const driver = getStorageDriver();
    const documents = await driver.listDocuments(kbId);
    const hasReadyDocument = documents.some((d) => d.status === "ready" && d.supersededBy === null);
    if (!hasReadyDocument) {
      const empty = new AppError("KDL-CHAT-001");
      return Response.json(empty.toJSON(), { status: 200 });
    }

    const lastMessage = messages[messages.length - 1]!;
    const history: ChatTurn[] = messages.slice(0, -1);
    const question = lastMessage.content;

    const condensed = await condenseQuery(history, question);
    const chunks = await retrieve(kbId, condensed);
    const verdict = await checkGroundedness(condensed, chunks);

    // Degrade-and-continue (RESEARCH.md's sibling-repo shape, applied to D2-08's logging
    // requirement): a failure logging prefilterTopScore must never turn a legitimate answer into
    // a 500.
    try {
      console.log(
        `[chat] prefilterTopScore=${verdict.prefilterTopScore.toFixed(4)} judged=${verdict.judged} grounded=${verdict.grounded}`,
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
