import { describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import { assertNeonHost } from "./neon-guard.js";

// All connection strings below are synthetic — no real credential, host, or project id appears
// anywhere in this file (D3-06 threat model, T-03-03-01).

describe("assertNeonHost", () => {
  it("accepts a Neon pooled-connection-style host", () => {
    expect(() =>
      assertNeonHost(
        "postgresql://synthetic_user:synthetic_pw@ep-cool-morning-12345-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require",
        "DATABASE_URL",
      ),
    ).not.toThrow();
  });

  it("accepts a Neon direct-connection-style host", () => {
    expect(() =>
      assertNeonHost(
        "postgresql://synthetic_user:synthetic_pw@ep-cool-morning-12345.us-east-2.aws.neon.tech/neondb?sslmode=require",
        "DATABASE_URL",
      ),
    ).not.toThrow();
  });

  it("rejects a Supabase-style host — the exact mis-paste this guard exists to prevent (D3-06)", () => {
    expect(() =>
      assertNeonHost(
        "postgresql://synthetic_user.synthetic_project:synthetic_pw@aws-1-us-east-1.pooler.supabase.com:6543/postgres",
        "DATABASE_URL",
      ),
    ).toThrow(AppError);

    try {
      assertNeonHost(
        "postgresql://synthetic_user.synthetic_project:synthetic_pw@aws-1-us-east-1.pooler.supabase.com:6543/postgres",
        "DATABASE_URL",
      );
      expect.fail("expected assertNeonHost to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      const appError = error as AppError;
      expect(appError.code).toBe("KDL-DB-005");
      // The error must name the offending host and the variable name, so the fix is obvious.
      expect(appError.message).toContain("aws-1-us-east-1.pooler.supabase.com");
      expect(appError.message).toContain("DATABASE_URL");
    }
  });

  it("rejects an unrelated/arbitrary host — fail-closed, not a Supabase-specific blocklist", () => {
    expect(() => assertNeonHost("postgresql://u:p@some-other-provider.example.com:5432/db", "DATABASE_URL")).toThrow(
      AppError,
    );
    expect(() => assertNeonHost("postgresql://u:p@localhost:5432/db", "DATABASE_URL")).toThrow(AppError);
  });

  it("rejects a value that is not a parseable URL at all", () => {
    expect(() => assertNeonHost("not-a-url", "DATABASE_URL")).toThrow(AppError);
  });

  it("reports the caller-supplied variable name in the error, not a hardcoded one", () => {
    try {
      assertNeonHost("postgresql://u:p@aws-1-us-east-1.pooler.supabase.com:6543/postgres", "KYZERDOCS_DATABASE_URL");
      expect.fail("expected assertNeonHost to throw");
    } catch (error) {
      expect((error as AppError).message).toContain("KYZERDOCS_DATABASE_URL");
    }
  });
});
