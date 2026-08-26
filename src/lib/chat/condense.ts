/**
 * CHAT-05's retrieval-layer requirement: a follow-up question that refers to the previous turn
 * ("what about that one?") must be resolved into a standalone question BEFORE it reaches
 * `retrieve()` — passing the raw pronoun-bearing text straight to `embedQuery` retrieves nothing
 * useful no matter how good the index is, since the embedding has no way to recover what "that
 * one" refers to.
 */

import { generateText } from "ai";
import { judgeModel } from "./model.js";

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

/** How many prior turns of history are handed to the rewrite call — enough to resolve most
 * pronoun/ellipsis references without an unbounded prompt. */
const MAX_HISTORY_TURNS = 6;

function buildCondensePrompt(history: readonly ChatTurn[], question: string): string {
  const recent = history.slice(-MAX_HISTORY_TURNS);
  const transcript = recent.map((turn) => `${turn.role}: ${turn.content}`).join("\n");

  return `Given this conversation history:

${transcript}

Rewrite the user's follow-up question below into a standalone question that makes sense without
the history — resolve any pronoun ("it", "that", "those") or ellipsis ("the second one") against
the specific entity or topic it refers to in the history above. If the follow-up question is
already standalone, return it unchanged. Respond with ONLY the rewritten question, no preamble.

Follow-up question: ${question}`;
}

/**
 * With empty history, returns `question` unchanged and makes no model call — most turns in a
 * conversation are the first turn, and this keeps that path free. With non-empty history, makes
 * one `judgeModel()` call rewriting the follow-up into a standalone question using the last few
 * turns. On any failure (network, provider, empty response) falls back to the original question
 * rather than throwing — a degraded (non-condensed) retrieval is a better outcome than a hard
 * failure of the whole chat turn.
 */
export async function condenseQuery(history: readonly ChatTurn[], question: string): Promise<string> {
  if (history.length === 0) {
    return question;
  }

  try {
    const result = await generateText({
      model: judgeModel(),
      prompt: buildCondensePrompt(history, question),
    });
    const condensed = result.text.trim();
    return condensed.length > 0 ? condensed : question;
  } catch {
    return question;
  }
}
