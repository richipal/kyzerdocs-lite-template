import { randomUUID } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/neon-http";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { assertNeonHost } from "../storage/neon-guard.js";
import { readCloudTestEnv } from "../storage/test-cloud-env.js";
import type { RateLimitPolicy } from "./pg-limiter.js";

/**
 * Live-database suite for `consumeAttemptPg` (WIDG-06, D3-15). Skips cleanly (not fails) when
 * `DATABASE_URL` is absent — same `describe.skipIf` convention as `schema.pg.test.ts` — so
 * `npm test` stays green on a machine that has never provisioned cloud mode.
 *
 * Credential handling follows `test-cloud-env.ts`'s established rule: `readCloudTestEnv()` reads
 * the value without ever mutating `process.env`. This suite DOES scope-mutate
 * `process.env.DATABASE_URL` inside `beforeAll`/`afterAll` — but only with the value
 * `readCloudTestEnv()` already read, only for the lifetime of THIS describe block, and always
 * restored to its prior value afterward. This is the same locally-scoped save/restore pattern
 * `src/lib/storage/index.test.ts` already uses (there with a synthetic value; here with the real
 * one) — it exists because `consumeAttemptPg`'s own production code intentionally reads
 * `process.env.DATABASE_URL` directly (mirroring `storage/index.ts`'s own convention), so a live
 * call against it needs that variable actually set for the duration of the call, without ever
 * leaking a mutation into a sibling test file sharing the same worker.
 *
 * "Gate a suite on a credential, then verify it actually executed" — this suite's very first test
 * name says whether the DATABASE_URL branch ran at all; grep this file's own `describe.skipIf`
 * condition and cross-check against a `npm test` run's reported test count if in doubt.
 */
const databaseUrl = readCloudTestEnv("DATABASE_URL");

describe.skipIf(!databaseUrl)("rate-limit/pg-limiter — consumeAttemptPg against a live Neon database", () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const insertedKeys: string[] = [];
  let cleanupDb: ReturnType<typeof drizzle>;

  beforeAll(() => {
    assertNeonHost(databaseUrl as string, "DATABASE_URL");
    process.env.DATABASE_URL = databaseUrl;
    const rawClient = neon(databaseUrl as string);
    cleanupDb = drizzle(rawClient);
  });

  afterAll(async () => {
    for (const key of insertedKeys) {
      await cleanupDb.execute(sql`DELETE FROM rate_limits WHERE key = ${key}`);
    }
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
  });

  function freshKey(label: string): string {
    const key = `pg-limiter-test-${label}-${randomUUID()}`;
    insertedKeys.push(key);
    return key;
  }

  it("allows consumption below capacity", async () => {
    const { consumeAttemptPg, PUBLIC_WIDGET_RATE_LIMIT_POLICY } = await import("./pg-limiter.js");
    const key = freshKey("below-capacity");
    const attempt = await consumeAttemptPg(key, PUBLIC_WIDGET_RATE_LIMIT_POLICY);
    expect(attempt.allowed).toBe(true);
  });

  it("denies consumption past capacity, with retryAfterSeconds > 0", async () => {
    const { consumeAttemptPg, PUBLIC_WIDGET_RATE_LIMIT_POLICY } = await import("./pg-limiter.js");
    const key = freshKey("exhaust");
    for (let i = 0; i < PUBLIC_WIDGET_RATE_LIMIT_POLICY.capacity; i++) {
      const attempt = await consumeAttemptPg(key, PUBLIC_WIDGET_RATE_LIMIT_POLICY);
      expect(attempt.allowed).toBe(true);
    }
    const denied = await consumeAttemptPg(key, PUBLIC_WIDGET_RATE_LIMIT_POLICY);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("refills tokens over elapsed time", async () => {
    const { consumeAttemptPg, PUBLIC_WIDGET_RATE_LIMIT_POLICY } = await import("./pg-limiter.js");
    const key = freshKey("refill");

    for (let i = 0; i < PUBLIC_WIDGET_RATE_LIMIT_POLICY.capacity; i++) {
      await consumeAttemptPg(key, PUBLIC_WIDGET_RATE_LIMIT_POLICY);
    }
    const exhausted = await consumeAttemptPg(key, PUBLIC_WIDGET_RATE_LIMIT_POLICY);
    expect(exhausted.allowed).toBe(false);

    // Rewind last_refill far enough into the past to guarantee a full refill, rather than
    // sleeping in a test — the "inject the clock" spirit of the in-memory limiter's own tests,
    // applied here to the row Postgres computes `now() - last_refill` against.
    await cleanupDb.execute(
      sql`UPDATE rate_limits SET last_refill = now() - interval '10 minutes' WHERE key = ${key}`,
    );

    const refilled = await consumeAttemptPg(key, PUBLIC_WIDGET_RATE_LIMIT_POLICY);
    expect(refilled.allowed).toBe(true);
  });

  it("gives two distinct keys independent buckets", async () => {
    const { consumeAttemptPg, PUBLIC_WIDGET_RATE_LIMIT_POLICY } = await import("./pg-limiter.js");
    const keyA = freshKey("independent-a");
    const keyB = freshKey("independent-b");

    for (let i = 0; i < PUBLIC_WIDGET_RATE_LIMIT_POLICY.capacity; i++) {
      await consumeAttemptPg(keyA, PUBLIC_WIDGET_RATE_LIMIT_POLICY);
    }
    const deniedA = await consumeAttemptPg(keyA, PUBLIC_WIDGET_RATE_LIMIT_POLICY);
    expect(deniedA.allowed).toBe(false);

    const allowedB = await consumeAttemptPg(keyB, PUBLIC_WIDGET_RATE_LIMIT_POLICY);
    expect(allowedB.allowed).toBe(true);
  });

  it(
    "enforces the limit under CONCURRENT requests, not just sequential ones — proves the " +
      "advisory-lock CTE prevents a SELECT-then-UPDATE double-spend race (T-03-06-04)",
    async () => {
      const { consumeAttemptPg } = await import("./pg-limiter.js");
      const key = freshKey("concurrent-burst");
      const policy: RateLimitPolicy = { capacity: 5, refillWindowMs: 5 * 60 * 1000 };
      const BURST_SIZE = 15;

      // All fired at once — genuinely overlapping in-flight requests, not a sequential loop. A
      // racy SELECT-then-UPDATE implementation would allow more than `capacity` through here,
      // because multiple requests would read the same starting token count before any of them
      // writes back. This is exactly the property a sequential loop cannot exercise.
      const results = await Promise.all(
        Array.from({ length: BURST_SIZE }, () => consumeAttemptPg(key, policy)),
      );

      const allowedCount = results.filter((r) => r.allowed).length;
      expect(allowedCount).toBe(policy.capacity);
    },
  );

  it("the counter survives a fresh module instance (cold-invocation persistence, D3-15)", async () => {
    const { consumeAttemptPg: firstImport, PUBLIC_WIDGET_RATE_LIMIT_POLICY: policy } =
      await import("./pg-limiter.js");
    const key = freshKey("cold-invocation");

    for (let i = 0; i < policy.capacity; i++) {
      const attempt = await firstImport(key, policy);
      expect(attempt.allowed).toBe(true);
    }
    const exhausted = await firstImport(key, policy);
    expect(exhausted.allowed).toBe(false);

    // Simulate a fresh serverless invocation: throw away the module's scope (its cached
    // Postgres client singleton included) and re-import from nothing.
    vi.resetModules();
    const { consumeAttemptPg: secondImport } = await import("./pg-limiter.js");
    const stillDenied = await secondImport(key, policy);
    expect(stillDenied.allowed).toBe(false);
  });

  it(
    "negative control: the in-memory limiter WRONGLY allows again after vi.resetModules() — " +
      "this is the executable statement of why pg-limiter.ts exists (D3-15)",
    async () => {
      const { consumeAttempt: firstImport } = await import("../auth/rate-limit.js");
      const key = `negative-control-${randomUUID()}`;
      const now = Date.now();

      for (let i = 0; i < 5; i++) {
        expect(firstImport(key, now).allowed).toBe(true);
      }
      expect(firstImport(key, now).allowed).toBe(false);

      vi.resetModules();
      const { consumeAttempt: secondImport } = await import("../auth/rate-limit.js");
      // A fresh module scope means a fresh, empty Map — the bucket just exhausted is gone, and
      // this call is wrongly allowed. If a future change "simplifies" the two rate limiters back
      // into one, this assertion is what starts failing loudly.
      expect(secondImport(key, now).allowed).toBe(true);
    },
  );
});

/**
 * Fail-closed behavior (T-03-06-05) does not require a real database — an unreachable one
 * demonstrates the property just as well, and this describe block is intentionally NOT gated on
 * `DATABASE_URL`'s presence, so it always runs.
 */
describe("rate-limit/pg-limiter — fails closed on a storage failure", () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;

  afterEach(() => {
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
    vi.resetModules();
  });

  it("propagates an error instead of resolving allowed:true when the database is unreachable", async () => {
    vi.resetModules();
    // A syntactically valid Neon-shaped connection string pointing at a host that cannot exist —
    // the query fails with a real connection/DNS error, never a stale cached response.
    process.env.DATABASE_URL =
      "postgresql://user:pass@ep-nonexistent-00000000.us-east-1.aws.neon.tech/neondb";
    const { consumeAttemptPg } = await import("./pg-limiter.js");

    await expect(consumeAttemptPg("fail-closed-test-key")).rejects.toThrow();
  });
});
