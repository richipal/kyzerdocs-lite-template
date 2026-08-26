import { describe, expect, it } from "vitest";
import { isOriginAllowed, normalizeDomain } from "./origin.js";

describe("normalizeDomain", () => {
  it("returns a bare lowercase host unchanged", () => {
    expect(normalizeDomain("example.com")).toBe("example.com");
    expect(normalizeDomain("EXAMPLE.COM")).toBe("example.com");
  });

  it("strips a leading scheme", () => {
    expect(normalizeDomain("https://example.com")).toBe("example.com");
    expect(normalizeDomain("http://example.com")).toBe("example.com");
  });

  it("strips a leading www.", () => {
    expect(normalizeDomain("www.example.com")).toBe("example.com");
  });

  it("strips a trailing dot", () => {
    expect(normalizeDomain("example.com.")).toBe("example.com");
  });

  it("strips a trailing slash", () => {
    expect(normalizeDomain("example.com/")).toBe("example.com");
  });

  it("drops a bare query string with no path", () => {
    expect(normalizeDomain("example.com?ref=1")).toBe("example.com");
  });

  it("rejects a full URL with a path rather than parsing it", () => {
    expect(normalizeDomain("https://example.com/path?q=1")).toBeNull();
  });

  it("rejects input containing a space", () => {
    expect(normalizeDomain("example .com")).toBeNull();
    expect(normalizeDomain("example.com foo")).toBeNull();
  });

  it("rejects input with a port", () => {
    expect(normalizeDomain("example.com:8080")).toBeNull();
  });

  it("rejects an empty string", () => {
    expect(normalizeDomain("")).toBeNull();
    expect(normalizeDomain("   ")).toBeNull();
  });
});

describe("isOriginAllowed", () => {
  it("matches a bare host exactly", () => {
    expect(isOriginAllowed("https://example.com", ["example.com"])).toBe(true);
  });

  it("matches www.-prefixed origins against a bare allowed host", () => {
    expect(isOriginAllowed("https://www.example.com", ["example.com"])).toBe(true);
  });

  it("rejects a lookalike prefix domain", () => {
    expect(isOriginAllowed("https://evil-example.com", ["example.com"])).toBe(false);
  });

  it("rejects a lookalike suffix domain", () => {
    expect(isOriginAllowed("https://example.com.attacker.net", ["example.com"])).toBe(false);
  });

  it("allows nothing when the allowlist is empty", () => {
    expect(isOriginAllowed("https://example.com", [])).toBe(false);
  });

  it("rejects an unparsable origin", () => {
    expect(isOriginAllowed("not-a-url", ["example.com"])).toBe(false);
  });

  it("never uses substring or endsWith-style matching", () => {
    // "notexample.com" ends with "example.com" as a substring but is a different host entirely.
    expect(isOriginAllowed("https://notexample.com", ["example.com"])).toBe(false);
  });
});
