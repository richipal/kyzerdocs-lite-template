/**
 * Applies the D3-13 grep gate to the artifact that actually ships (`public/widget.js`), not to
 * the loader's source — proving a bundler transform (minification, inlining, dead-code paths)
 * can never quietly reintroduce a credential-shaped string into the built bundle even if the
 * source stays clean.
 *
 * Default `node` environment (vitest.config.ts) — this test reads a file from disk and does no
 * DOM work, so no `@vitest-environment jsdom` docblock is needed.
 *
 * Requires `public/widget.js` to already exist: run `npm run build:widget` first (the plan's own
 * verify step does this: `npm run build:widget && npm run typecheck && npm test -- src/widget-src`).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const BUNDLE_PATH = join(process.cwd(), "public", "widget.js");
const bundleExists = existsSync(BUNDLE_PATH);

describe("widget bundle (public/widget.js) — D3-13 credential grep gate", () => {
  if (!bundleExists) {
    it("public/widget.js exists", () => {
      throw new Error(
        `public/widget.js is missing at ${BUNDLE_PATH} — run "npm run build:widget" before this suite.`,
      );
    });
    return;
  }

  const bundle = readFileSync(BUNDLE_PATH, "utf8");
  const lowerBundle = bundle.toLowerCase();

  const forbiddenSubstrings = ["admin_password", "gemini_api_key", "openrouter", "process.env"];

  it.each(forbiddenSubstrings)("never contains the case-insensitive substring %s", (needle) => {
    expect(lowerBundle).not.toContain(needle);
  });

  it("contains the exact iframe sandbox value", () => {
    expect(bundle).toContain("allow-scripts allow-same-origin allow-forms");
  });

  it("contains the max z-index value", () => {
    expect(bundle).toContain("2147483647");
  });
});
