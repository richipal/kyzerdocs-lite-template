import { beforeEach, describe, expect, it, vi } from "vitest";

const generateTextMock = vi.fn();

vi.mock("ai", () => ({
  generateText: (...args: unknown[]) => generateTextMock(...args),
}));

vi.mock("./model.js", () => ({
  judgeModel: vi.fn(() => "stub-judge-model"),
}));

describe("condenseQuery", () => {
  beforeEach(() => {
    generateTextMock.mockReset();
  });

  it("empty history: returns the question unchanged and makes no model call", async () => {
    const { condenseQuery } = await import("./condense.js");
    const result = await condenseQuery([], "What is the warranty period?");

    expect(result).toBe("What is the warranty period?");
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it("resolves a pronoun-bearing follow-up against the prior turn's entity", async () => {
    generateTextMock.mockResolvedValue({
      text: "What is the maximum working height for the tripod orchard ladder?",
    });
    const { condenseQuery } = await import("./condense.js");

    const history = [
      { role: "user" as const, content: "Tell me about the tripod orchard ladder safety rules." },
      {
        role: "assistant" as const,
        content: "The tripod orchard ladder must be inspected before each use.",
      },
    ];
    const result = await condenseQuery(history, "what is the maximum working height for it?");

    expect(generateTextMock).toHaveBeenCalledTimes(1);
    expect(result).toContain("ladder");
  });

  it("falls back to the original question when the model call fails", async () => {
    generateTextMock.mockRejectedValue(new Error("network unreachable"));
    const { condenseQuery } = await import("./condense.js");

    const history = [{ role: "user" as const, content: "Tell me about ladders." }];
    const result = await condenseQuery(history, "what about the second one?");

    expect(result).toBe("what about the second one?");
  });

  it("falls back to the original question when the model returns an empty string", async () => {
    generateTextMock.mockResolvedValue({ text: "   " });
    const { condenseQuery } = await import("./condense.js");

    const history = [{ role: "user" as const, content: "Tell me about ladders." }];
    const result = await condenseQuery(history, "what about the second one?");

    expect(result).toBe("what about the second one?");
  });
});
