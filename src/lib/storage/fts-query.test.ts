import { describe, expect, it } from "vitest";
import { sanitizeFtsQuery } from "./fts-query.js";

describe("sanitizeFtsQuery", () => {
  it("wraps each remaining token in double quotes and joins with OR", () => {
    expect(sanitizeFtsQuery("warranty coverage")).toBe('"warranty" OR "coverage"');
  });

  it("strips FTS5 operator/punctuation characters before tokenizing", () => {
    expect(sanitizeFtsQuery('What is the "fox" doing? *near* the dog')).toBe(
      '"What" OR "is" OR "the" OR "fox" OR "doing" OR "the" OR "dog"',
    );
  });

  it("strips the NEAR operator (case-insensitive) as a whole word", () => {
    expect(sanitizeFtsQuery("fox NEAR dog")).toBe('"fox" OR "dog"');
  });

  it("neutralizes an injection-shaped query into plain OR'd literal tokens", () => {
    expect(sanitizeFtsQuery('ppe" OR 1=1 NEAR* ^:')).toBe('"ppe" OR "OR" OR "1=1"');
  });

  it("returns an empty string when the query sanitizes to nothing (only punctuation)", () => {
    expect(sanitizeFtsQuery("???...")).toBe("");
  });

  it("collapses repeated whitespace produced by stripped characters", () => {
    expect(sanitizeFtsQuery("a   -   b")).toBe('"a" OR "b"');
  });
});
