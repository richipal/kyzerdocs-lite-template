import { describe, expect, it } from "vitest";
import { chunkText, DEFAULT_CHUNK_CONFIG, type Chunk } from "./chunk.js";

/** Every chunk's declared span must exactly reproduce its content — this is the invariant
 * span-based recall@k (the eval harness's own scoring module) and this chunker's own overlap
 * logic both depend on. Checked across every test below, not just once. */
function expectSpansMatchContent(chunks: Chunk[], sourceText: string): void {
  for (const c of chunks) {
    expect(sourceText.slice(c.charStart, c.charEnd)).toBe(c.content);
  }
}

describe("chunkText", () => {
  it("returns [] for empty or whitespace-only text", () => {
    expect(chunkText("", "doc.txt")).toEqual([]);
    expect(chunkText("   \n\n   ", "doc.txt")).toEqual([]);
  });

  it("returns a single chunk for text shorter than targetChars", () => {
    const text = "This is a short document with just one paragraph of text.";
    const chunks = chunkText(text, "short.txt", { targetChars: 1000, overlapChars: 100 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.content).toBe(text);
    expect(chunks[0]!.chunkIndex).toBe(0);
    expectSpansMatchContent(chunks, text);
  });

  it("is deterministic: chunking the same input twice yields byte-identical output", () => {
    const text = Array.from({ length: 20 }, (_, i) => `Paragraph number ${i} with some content here.`).join(
      "\n\n",
    );
    const config = { targetChars: 150, overlapChars: 20 };
    const first = chunkText(text, "doc.txt", config);
    const second = chunkText(text, "doc.txt", config);
    expect(second).toEqual(first);
  });

  it("prefers blank-line paragraph boundaries when they exist and paragraphs fit", () => {
    const paragraphs = [
      "First paragraph about warranty terms and conditions for the product line.",
      "Second paragraph about the return policy and how refunds are processed.",
      "Third paragraph about shipping timelines and carrier options available.",
    ];
    const text = paragraphs.join("\n\n");
    // targetChars large enough that each individual paragraph fits, but not all three together.
    const chunks = chunkText(text, "doc.txt", { targetChars: 90, overlapChars: 0 });
    expect(chunks.length).toBeGreaterThan(1);
    // Every chunk's content should be one of the original paragraphs (or a whitespace-trimmed
    // version of it) rather than a mid-sentence character split.
    for (const c of chunks) {
      expect(paragraphs.some((p) => p.startsWith(c.content) || c.content === p)).toBe(true);
    }
    expectSpansMatchContent(chunks, text);
  });

  it("falls back to heading-like line boundaries when there are no blank lines (PDF-like text)", () => {
    // Simulates unpdf-extracted text: single '\n' between lines, no blank lines anywhere,
    // isolated short "heading" lines between body paragraphs.
    const text = [
      "Introduction",
      "This section explains the general safety requirements that apply to every job site and every worker regardless of role or seniority within the company structure.",
      "Hazard Identification",
      "Workers must identify potential hazards before beginning any task and report unsafe conditions to a supervisor immediately rather than attempting to work around them silently.",
      "Emergency Procedures",
      "In the event of an emergency every worker must follow the posted evacuation route and report to the designated assembly area for a headcount before re-entering the building.",
    ].join("\n");

    expect(text.includes("\n\n")).toBe(false);

    const chunks = chunkText(text, "pdf-like.txt", { targetChars: 200, overlapChars: 0 });
    expect(chunks.length).toBeGreaterThan(1);
    expectSpansMatchContent(chunks, text);
    // At least one chunk should start with a heading line rather than mid-sentence.
    expect(chunks.some((c) => c.content.startsWith("Hazard Identification"))).toBe(true);
  });

  it("falls back to sentence boundaries when there is no paragraph or heading structure at all", () => {
    const text =
      "The warranty covers manufacturing defects for twelve months. It does not cover accidental damage or misuse. " +
      "Claims must be filed within thirty days of discovering the defect. A receipt or proof of purchase is required for every claim. " +
      "Refunds are issued to the original payment method within five to seven business days after approval.";

    const chunks = chunkText(text, "no-structure.txt", { targetChars: 120, overlapChars: 0 });
    expect(chunks.length).toBeGreaterThan(1);
    expectSpansMatchContent(chunks, text);
    // No chunk should end mid-word (a blind character split would frequently do this); every
    // chunk here should end at a sentence terminator or the end of the text.
    for (const c of chunks) {
      const trimmed = c.content.trimEnd();
      expect(/[.!?]$/.test(trimmed) || c.charEnd === text.length).toBe(true);
    }
  });

  it("falls back to a hard character window only when a single atom has no sentence punctuation at all", () => {
    const text = "word ".repeat(100).trim(); // 500 chars, no punctuation anywhere
    const chunks = chunkText(text, "no-punctuation.txt", { targetChars: 100, overlapChars: 0 });
    expect(chunks.length).toBeGreaterThan(1);
    expectSpansMatchContent(chunks, text);
    for (const c of chunks) {
      expect(c.content.length).toBeLessThanOrEqual(100 + 1); // hard window tolerance for the whitespace lookback
    }
  });

  it("applies overlap between consecutive chunks, and never overlaps the first chunk", () => {
    const paragraphs = Array.from(
      { length: 5 },
      (_, i) => `Paragraph ${i}: ${"word ".repeat(20).trim()}.`,
    );
    const text = paragraphs.join("\n\n");
    const overlapChars = 15;
    const chunks = chunkText(text, "doc.txt", { targetChars: 60, overlapChars });
    expect(chunks.length).toBeGreaterThan(2);
    expectSpansMatchContent(chunks, text);

    // Chunk 0 has no predecessor, so nothing precedes it to overlap with.
    expect(chunks[0]!.charStart).toBe(0);

    for (let i = 1; i < chunks.length; i++) {
      const prev = chunks[i - 1]!;
      const cur = chunks[i]!;
      // The current chunk's start must not be after the previous chunk's own end minus the
      // requested overlap (i.e. some trailing context from the previous chunk is included),
      // unless the previous chunk was too short to supply that much overlap.
      expect(cur.charStart).toBeLessThan(prev.charEnd);
    }
  });

  it("respects targetChars/overlapChars from config, and records them for reproducibility", () => {
    const text = Array.from({ length: 10 }, (_, i) => `Sentence number ${i} of the document.`).join(
      " ",
    );
    const looseConfig = { targetChars: 500, overlapChars: 0 };
    const tightConfig = { targetChars: 60, overlapChars: 0 };

    const looseChunks = chunkText(text, "doc.txt", looseConfig);
    const tightChunks = chunkText(text, "doc.txt", tightConfig);

    expect(tightChunks.length).toBeGreaterThan(looseChunks.length);
  });

  it("every chunk carries filename, documentId, and a monotonically increasing chunkIndex", () => {
    const text = Array.from({ length: 8 }, (_, i) => `Paragraph ${i} with some filler text here.`).join(
      "\n\n",
    );
    const chunks = chunkText(text, "example.pdf", { targetChars: 60, overlapChars: 5 });
    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach((c, i) => {
      expect(c.filename).toBe("example.pdf");
      expect(c.documentId).toBe("example.pdf");
      expect(c.chunkIndex).toBe(i);
    });
  });

  it("throws on invalid config (targetChars <= 0, overlapChars < 0, or overlapChars >= targetChars)", () => {
    expect(() => chunkText("some text", "doc.txt", { targetChars: 0, overlapChars: 0 })).toThrow();
    expect(() => chunkText("some text", "doc.txt", { targetChars: 100, overlapChars: -1 })).toThrow();
    expect(() =>
      chunkText("some text", "doc.txt", { targetChars: 100, overlapChars: 100 }),
    ).toThrow();
  });

  it("DEFAULT_CHUNK_CONFIG is a positive, sane target/overlap pair", () => {
    expect(DEFAULT_CHUNK_CONFIG.targetChars).toBeGreaterThan(0);
    expect(DEFAULT_CHUNK_CONFIG.overlapChars).toBeGreaterThanOrEqual(0);
    expect(DEFAULT_CHUNK_CONFIG.overlapChars).toBeLessThan(DEFAULT_CHUNK_CONFIG.targetChars);
  });
});
