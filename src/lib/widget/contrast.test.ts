import { describe, expect, it } from "vitest";
import { contrastRatioAgainstWhite } from "./contrast.js";

describe("contrastRatioAgainstWhite (WCAG relative luminance, S-5: real computation, no lookup)", () => {
  it("pure black against white is 21:1", () => {
    expect(contrastRatioAgainstWhite("#000000")).toBeCloseTo(21, 1);
  });

  it("pure white against white is 1:1", () => {
    expect(contrastRatioAgainstWhite("#FFFFFF")).toBeCloseTo(1, 2);
  });

  it("the shipped default accent (#0E4F4A) is above 4.5:1 against white", () => {
    expect(contrastRatioAgainstWhite("#0E4F4A")).toBeGreaterThan(4.5);
  });

  it("a pale, low-contrast colour falls below 4.5:1", () => {
    expect(contrastRatioAgainstWhite("#F5F0C0")).toBeLessThan(4.5);
  });

  it("accepts a hex value with no leading #", () => {
    expect(contrastRatioAgainstWhite("000000")).toBeCloseTo(21, 1);
  });

  it("throws on a malformed hex value", () => {
    expect(() => contrastRatioAgainstWhite("not-a-colour")).toThrow();
  });
});
