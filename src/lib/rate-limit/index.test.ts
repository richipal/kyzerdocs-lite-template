import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppError as AppErrorClass } from "../errors.js";

/**
 * `getRateLimiter()`'s mode switch (D3-15/D3-16): `PRODUCT_CONFIG.cloudMode` (itself derived from
 * `DATABASE_URL` presence, `src/lib/config.ts`) is the ONLY thing that decides which `RateLimiter`
 * the seam returns. Mirrors `src/lib/storage/index.test.ts`'s convention — mutate
 * `process.env.DATABASE_URL`, `vi.resetModules()`, THEN dynamically import — so every module this
 * test touches (`./index.js`, its transitive `../config.js`, and the mocked `./pg-limiter.js`)
 * comes from the SAME freshly-reset module registry. `../errors.js` is also re-imported
 * dynamically inside the throwing test, after the same reset, so the `AppError` class used for the
 * `instanceof` assertion is the identical class reference the freshly-imported `index.js` throws —
 * a stale statically-imported class from before `vi.resetModules()` would otherwise fail that
 * check for reasons that have nothing to do with this file's own correctness.
 */
describe("rate-limit/index — getRateLimiter selection seam", () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
    vi.doUnmock("./pg-limiter.js");
    vi.resetModules();
  });

  it("local mode (cloudMode false) never calls consumeAttemptPg", async () => {
    delete process.env.DATABASE_URL;
    const consumeAttemptPgSpy = vi.fn();
    vi.doMock("./pg-limiter.js", () => ({
      consumeAttemptPg: consumeAttemptPgSpy,
      PUBLIC_WIDGET_RATE_LIMIT_POLICY: { capacity: 10, refillWindowMs: 5 * 60 * 1000 },
    }));

    const { getRateLimiter } = await import("./index.js");
    const limiter = getRateLimiter();
    const result = await limiter.consume("local-test-key");

    expect(consumeAttemptPgSpy).not.toHaveBeenCalled();
    expect(result.allowed).toBe(true);
  });

  it("cloud mode (cloudMode true) calls consumeAttemptPg", async () => {
    process.env.DATABASE_URL = "postgresql://user:pass@ep-test-12345.us-east-1.aws.neon.tech/neondb";
    const consumeAttemptPgSpy = vi.fn().mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
    vi.doMock("./pg-limiter.js", () => ({
      consumeAttemptPg: consumeAttemptPgSpy,
      PUBLIC_WIDGET_RATE_LIMIT_POLICY: { capacity: 10, refillWindowMs: 5 * 60 * 1000 },
    }));

    const { getRateLimiter } = await import("./index.js");
    const limiter = getRateLimiter();
    const result = await limiter.consume("cloud-test-key");

    expect(consumeAttemptPgSpy).toHaveBeenCalledWith("cloud-test-key", expect.anything());
    expect(result).toEqual({ allowed: true, retryAfterSeconds: 0 });
  });

  it(
    "cloud mode with a rejecting Postgres limiter throws AppError(KDL-WIDG-005) and never " +
      "returns allowed:true",
    async () => {
      process.env.DATABASE_URL = "postgresql://user:pass@ep-test-12345.us-east-1.aws.neon.tech/neondb";
      vi.doMock("./pg-limiter.js", () => ({
        consumeAttemptPg: vi.fn().mockRejectedValue(new Error("connection refused")),
        PUBLIC_WIDGET_RATE_LIMIT_POLICY: { capacity: 10, refillWindowMs: 5 * 60 * 1000 },
      }));

      const { getRateLimiter } = await import("./index.js");
      const { AppError } = await import("../errors.js");
      const limiter = getRateLimiter();

      let caught: unknown;
      try {
        await limiter.consume("failing-test-key");
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(AppError);
      expect((caught as AppErrorClass).code).toBe("KDL-WIDG-005");
    },
  );
});

/**
 * Structural guard, not a runtime mock: the whole point of this file is that the cloud branch can
 * NEVER route through the in-memory limiter, under any circumstance — including a future edit
 * that introduces a fallback without anyone noticing it violates D3-15. Reading `index.ts`'s own
 * source and asserting the `cloudRateLimiter` object's body contains no call to the synchronous
 * `consumeAttempt` catches that class of regression even if a future test double happened to make
 * it behave correctly by accident.
 */
describe("rate-limit/index — source assertion: the cloud branch never falls back to the in-memory limiter", () => {
  it("cloudRateLimiter's implementation body never calls the synchronous consumeAttempt", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

    const cloudStart = source.indexOf("const cloudRateLimiter");
    expect(cloudStart).toBeGreaterThan(-1);
    const cloudEnd = source.indexOf("\n};", cloudStart);
    expect(cloudEnd).toBeGreaterThan(cloudStart);
    const cloudBody = source.slice(cloudStart, cloudEnd);

    // "consumeAttempt(" (not "consumeAttemptPg(") is the in-memory limiter's call signature —
    // this must never appear inside the cloud branch's body.
    expect(cloudBody).not.toMatch(/consumeAttempt\(/);
    expect(cloudBody).toMatch(/consumeAttemptPg\(/);
  });
});
