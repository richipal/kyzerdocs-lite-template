import { describe, expect, it } from "vitest";
import { consumeAttempt, getBucketCount, resetAttempts } from "./rate-limit.js";

describe("consumeAttempt", () => {
  it("allows attempts 1 through 5 and refuses attempt 6 with retryAfterSeconds > 0", () => {
    const now = 1_000_000;
    const key = `login-allow-${now}`;
    for (let i = 0; i < 5; i++) {
      expect(consumeAttempt(key, now).allowed).toBe(true);
    }
    const sixth = consumeAttempt(key, now);
    expect(sixth.allowed).toBe(false);
    expect(sixth.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("refills a token after the 15-minute window elapses, using an injected clock", () => {
    const start = 2_000_000;
    const key = `login-refill-${start}`;
    for (let i = 0; i < 5; i++) {
      consumeAttempt(key, start);
    }
    expect(consumeAttempt(key, start).allowed).toBe(false);

    const fifteenMinutesMs = 15 * 60 * 1000;
    const later = start + fifteenMinutesMs;
    expect(consumeAttempt(key, later).allowed).toBe(true);
  });

  it("gives two distinct keys independent buckets", () => {
    const now = 3_000_000;
    const keyA = `login-a-${now}`;
    const keyB = `login-b-${now}`;
    for (let i = 0; i < 5; i++) {
      expect(consumeAttempt(keyA, now).allowed).toBe(true);
    }
    // keyA is now exhausted; keyB must still have its own full bucket.
    expect(consumeAttempt(keyA, now).allowed).toBe(false);
    expect(consumeAttempt(keyB, now).allowed).toBe(true);
  });

  it("evicts entries idle for more than one hour, bounding map growth", () => {
    const base = 4_000_000;
    consumeAttempt(`evict-1-${base}`, base);
    consumeAttempt(`evict-2-${base}`, base);
    consumeAttempt(`evict-3-${base}`, base);

    const twoHoursLater = base + 2 * 60 * 60 * 1000;
    consumeAttempt(`evict-4-${base}`, twoHoursLater);

    expect(getBucketCount()).toBe(1);
  });

  it("resets a key's bucket on successful login, restoring full capacity", () => {
    const now = 5_000_000;
    const key = `login-reset-${now}`;
    for (let i = 0; i < 5; i++) {
      consumeAttempt(key, now);
    }
    expect(consumeAttempt(key, now).allowed).toBe(false);

    resetAttempts(key);
    expect(consumeAttempt(key, now).allowed).toBe(true);
  });
});
