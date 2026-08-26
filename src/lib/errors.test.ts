import { describe, expect, it } from "vitest";
import { AppError, ERROR_CODES, type ErrorCode } from "./errors.js";

// Phase 3 (plan 03-01): all ten new Phase 3 codes are registered before any call site exists.
const PHASE_3_CODES: ErrorCode[] = [
  "KDL-WIDG-001",
  "KDL-WIDG-002",
  "KDL-WIDG-003",
  "KDL-WIDG-004",
  "KDL-WIDG-005",
  "KDL-DB-003",
  "KDL-DB-004",
  "KDL-BLOB-001",
  "KDL-BLOB-002",
  "KDL-BLOB-003",
];

// UI-STANDARDS S-6: a widget error is read by a stranger on the buyer's website, not by the
// buyer — this subset must never leak credential/provider/config vocabulary. See UI-SPEC's
// Copywriting Contract traceability table, S-6 row.
const VISITOR_FACING_CODES: ErrorCode[] = ["KDL-WIDG-002", "KDL-WIDG-004", "KDL-WIDG-005"];
const FORBIDDEN_SUBSTRINGS = [
  "api key",
  "gemini",
  "openrouter",
  "database_url",
  "token",
  "password",
];

describe("Phase 3 error codes", () => {
  it("registers all ten codes with a non-empty message and action", () => {
    for (const code of PHASE_3_CODES) {
      const entry = ERROR_CODES[code];
      expect(entry, `${code} must be registered`).toBeDefined();
      expect(entry.message.length, `${code}.message must be non-empty`).toBeGreaterThan(0);
      expect(entry.action.length, `${code}.action must be non-empty`).toBeGreaterThan(0);
    }
  });

  it("keeps the visitor-facing subset free of credential/provider/config vocabulary", () => {
    for (const code of VISITOR_FACING_CODES) {
      const entry = ERROR_CODES[code];
      const haystack = `${entry.message} ${entry.action}`.toLowerCase();
      for (const forbidden of FORBIDDEN_SUBSTRINGS) {
        expect(
          haystack.includes(forbidden),
          `${code} must not mention "${forbidden}" — a site visitor, not the buyer, reads this copy: "${haystack}"`,
        ).toBe(false);
      }
    }
  });

  it("AppError.toJSON() remains exactly { code, message, action }", () => {
    const err = new AppError("KDL-WIDG-002");
    const json = err.toJSON();
    expect(Object.keys(json).sort()).toEqual(["action", "code", "message"]);
  });
});
