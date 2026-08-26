/**
 * GET /api/chat/starters — CHAT-06's empty-state prompts (T-02-09-04/05). `requireAdmin()` first
 * (ADMIN-02), matching every other non-auth, non-health route. Reads the corpus generation
 * (RET-02's monotonic counter, `getGeneration`) and returns a cached `{generation, questions}`
 * blob from `app_settings` when the generation is unchanged — exactly one `judgeModel()` call per
 * corpus change, never one per page view (T-02-09-04's DoS mitigation). An empty corpus (no ready
 * documents) short-circuits to `{ questions: [] }` with no model call at all; the UI renders the
 * upload prompt instead.
 *
 * Section-title sampling scope note: the plan's action text describes generating starters "over
 * the indexed document filenames and a sample of section titles." The `StorageDriver` interface
 * (plan 02-02, already merged) exposes no method to sample arbitrary chunk/section-title rows —
 * only `getChunksByIds` (requires already-known ids) and `countChunksForDocument` (a count, not
 * content). Extending the driver interface for this would be a cross-cutting architectural change
 * outside this plan's `files_modified` scope, so this route generates starters from document
 * filenames alone. Documented as a deviation in the plan's SUMMARY.
 */

import { generateObject } from "ai";
import { z } from "zod";
import { requireAdmin, unauthorizedResponse } from "../../../../lib/auth/session.js";
import { judgeModel } from "../../../../lib/chat/model.js";
import { AppError } from "../../../../lib/errors.js";
import { getStorageDriver } from "../../../../lib/storage/index.js";
import { DEFAULT_KB_ID } from "../../../../lib/types.js";

const STARTERS_KEY_PREFIX = "starters:";
const TARGET_STARTER_COUNT = 4;

const startersSchema = z.object({
  questions: z.array(z.string().min(1)).min(3).max(5),
});

interface CachedStarters {
  generation: number;
  questions: string[];
}

/** Generic, corpus-agnostic fallback used only if the judge call itself fails — CHAT-06 is a UX
 * nicety, never a reason to 500 the empty state or leave it blank. */
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

export async function GET(req: Request): Promise<Response> {
  try {
    await requireAdmin(req);
  } catch (err) {
    if (err instanceof AppError) return unauthorizedResponse(err);
    throw err;
  }

  const driver = getStorageDriver();
  const kbId = DEFAULT_KB_ID;
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
