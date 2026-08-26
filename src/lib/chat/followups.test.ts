import { describe, expect, it } from "vitest";
import { splitFollowups, FOLLOWUP_MARKER } from "./followups.js";

describe("splitFollowups", () => {
  it("returns the whole text as the answer when no marker is present", () => {
    const { answer, followups } = splitFollowups("Just an answer with no follow-ups.");
    expect(answer).toBe("Just an answer with no follow-ups.");
    expect(followups).toEqual([]);
  });

  it("splits the answer from the questions and strips the marker", () => {
    const text = `The policy covers X [1].\n\n${FOLLOWUP_MARKER}\nWho approves it?\nWhen was it updated?`;
    const { answer, followups } = splitFollowups(text);
    expect(answer).toBe("The policy covers X [1].");
    expect(answer).not.toContain(FOLLOWUP_MARKER);
    expect(followups).toEqual(["Who approves it?", "When was it updated?"]);
  });

  it("tolerates the model numbering or bulleting the questions anyway", () => {
    const text = `Answer.\n${FOLLOWUP_MARKER}\n1. First?\n2) Second?\n- Third?\n* **Fourth?**`;
    expect(splitFollowups(text).followups).toEqual(["First?", "Second?", "Third?", "Fourth?"]);
  });

  it("drops blank lines and absurdly long lines", () => {
    const text = `Answer.\n${FOLLOWUP_MARKER}\n\nShort?\n${"x".repeat(250)}\n`;
    expect(splitFollowups(text).followups).toEqual(["Short?"]);
  });

  it("handles a stream that was cut off right after the marker", () => {
    const { answer, followups } = splitFollowups(`Partial answer.\n${FOLLOWUP_MARKER}`);
    expect(answer).toBe("Partial answer.");
    expect(followups).toEqual([]);
  });
});
