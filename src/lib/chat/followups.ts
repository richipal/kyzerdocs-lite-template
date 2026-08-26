/**
 * Splits an assistant answer into prose and follow-up questions.
 *
 * The model is instructed (see `buildFollowupInstructions`) to end its answer with a
 * `###FOLLOWUPS###` marker line followed by one question per line. Those questions are genuinely
 * useful — they are grounded in the retrieved excerpts, so they are far more specific than the
 * corpus-wide starter set — but as prose inside the answer bubble they cannot be clicked.
 *
 * Extraction happens on the client rather than in the route because the answer streams token by
 * token: the marker only arrives near the end, and buffering the whole response server-side to
 * strip it would defeat CHAT-01's streaming.
 *
 * Everything before the marker is the answer. If the marker never appears — an older model turn, a
 * refusal, or a truncated stream — the whole text is the answer and there are no follow-ups.
 */
export const FOLLOWUP_MARKER = "###FOLLOWUPS###";

export interface SplitAnswer {
  answer: string;
  followups: string[];
}

export function splitFollowups(text: string): SplitAnswer {
  const at = text.indexOf(FOLLOWUP_MARKER);
  if (at === -1) return { answer: text, followups: [] };

  const answer = text.slice(0, at).trimEnd();
  const followups = text
    .slice(at + FOLLOWUP_MARKER.length)
    .split("\n")
    .map((line) =>
      line
        // tolerate the model numbering or bulleting anyway
        .replace(/^\s*(?:\d+[.)]|[-*•])\s*/, "")
        .replace(/\*\*/g, "")
        .trim(),
    )
    .filter((line) => line.length > 0 && line.length <= 200);

  return { answer, followups };
}
