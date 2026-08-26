import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { chunkText } from "./chunk.js";
import { pageForRange, sectionTitleForRange } from "./locate.js";
import { parseDocument } from "./parse.js";
import type { PageSpan } from "./types.js";

const CORPUS_DIR = "evals/corpus";

describe("pageForRange", () => {
  const pages: PageSpan[] = [
    { pageNumber: 1, charStart: 0, charEnd: 100 },
    { pageNumber: 2, charStart: 100, charEnd: 250 },
    { pageNumber: 3, charStart: 250, charEnd: 300 },
  ];

  it("returns the page containing charStart", () => {
    expect(pageForRange(pages, 0, 50)).toBe(1);
    expect(pageForRange(pages, 99, 150)).toBe(1);
    expect(pageForRange(pages, 100, 150)).toBe(2);
    expect(pageForRange(pages, 249, 260)).toBe(2);
    expect(pageForRange(pages, 250, 260)).toBe(3);
  });

  it("resolves a charStart exactly at the document's terminal offset to the last page", () => {
    expect(pageForRange(pages, 300, 300)).toBe(3);
  });

  it("returns null for an empty pages array rather than throwing", () => {
    expect(pageForRange([], 10, 20)).toBeNull();
  });

  it("returns null for a charStart outside every span", () => {
    expect(pageForRange(pages, 1000, 1010)).toBeNull();
  });
});

describe("pageForRange — integration with a real corpus PDF and the promoted chunker", () => {
  it("every chunk resolves to a page in [1, pageCount], non-decreasing across chunkIndex", async () => {
    const filename = "osha-tractor-hazards-agricultural-workers.pdf";
    const bytes = new Uint8Array(readFileSync(`${CORPUS_DIR}/${filename}`));
    const parsed = await parseDocument(bytes, { filename, byteSize: bytes.byteLength });
    const chunks = chunkText(parsed.text, filename);

    expect(chunks.length).toBeGreaterThan(0);

    let lastPage = 0;
    for (const chunk of chunks) {
      const page = pageForRange(parsed.pages, chunk.charStart, chunk.charEnd);
      expect(page).not.toBeNull();
      expect(page!).toBeGreaterThanOrEqual(1);
      expect(page!).toBeLessThanOrEqual(parsed.pageCount!);
      expect(page!).toBeGreaterThanOrEqual(lastPage);
      lastPage = page!;
    }
  });
});

describe("sectionTitleForRange", () => {
  it("returns null when no heading precedes the position", () => {
    const text = "Just a plain sentence with no heading anywhere above it at all.";
    expect(sectionTitleForRange(text, 10)).toBeNull();
  });

  it("finds a markdown heading directly above the position", () => {
    const text = "## Returns\n\nWe accept returns within 30 days of purchase.";
    const bodyStart = text.indexOf("We accept");
    expect(sectionTitleForRange(text, bodyStart)).toBe("Returns");
  });

  it("finds the nearest of two markdown headings, not the first", () => {
    const text = [
      "## Shipping",
      "",
      "Ships in 3-5 business days.",
      "",
      "## Returns",
      "",
      "We accept returns within 30 days of purchase.",
    ].join("\n");
    const bodyStart = text.indexOf("We accept");
    expect(sectionTitleForRange(text, bodyStart)).toBe("Returns");
  });

  it("resolves a chunk from the real service-warranty-faq.md corpus fixture to its heading", async () => {
    // service-warranty-faq.md has no literal "Returns" section — resolve against a heading that
    // actually exists in the corpus fixture instead of a synthetic one.
    const filename = "service-warranty-faq.md";
    const bytes = new Uint8Array(readFileSync(`${CORPUS_DIR}/${filename}`));
    const parsed = await parseDocument(bytes, { filename, byteSize: bytes.byteLength });
    const chunks = chunkText(parsed.text, filename, { targetChars: 220, overlapChars: 0 });

    const targetHeading = "What is covered under the planting warranty?";
    const bodyNeedle = "Trees and shrubs installed by BrightPath";
    const chunk = chunks.find((c) => c.content.includes(bodyNeedle));
    expect(chunk).toBeDefined();
    expect(sectionTitleForRange(parsed.text, chunk!.charStart)).toBe(targetHeading);
  });
});
