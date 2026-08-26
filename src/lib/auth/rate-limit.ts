/**
 * In-memory login token bucket (ADMIN-03). A single, long-lived local Node process with a single
 * admin — no Redis, no external store, no generic rate-limiting framework. This is deliberately
 * ~20 lines of logic per RESEARCH.md's `## Don't Hand-Roll` sizing.
 *
 * Capacity 5, full refill over a 15-minute window, continuous (fractional) refill rather than a
 * hard window reset — a caller who waits 3 minutes gets 1 token back, not zero until minute 15.
 * Never sleeps or schedules a deferred timer callback: every caller (including tests) injects
 * `now` so time advances deterministically. Entries idle for more than an hour are evicted opportunistically on every
 * call so a sustained attack from many distinct keys cannot grow the map without bound — this is
 * the only memory-safety control here and Task 1's test exercises it directly.
 *
 * This limiter resets on process restart, which is an accepted limitation for a single-process
 * local app (see 02-04-SUMMARY.md) — there is no persistence requirement at this tier.
 */

const CAPACITY = 5;
const REFILL_WINDOW_MS = 15 * 60 * 1000; // full bucket refills over 15 minutes
const REFILL_RATE_PER_MS = CAPACITY / REFILL_WINDOW_MS;
const EVICT_IDLE_MS = 60 * 60 * 1000; // entries untouched for over an hour are dropped

interface Bucket {
  tokens: number;
  lastRefill: number;
}

const buckets = new Map<string, Bucket>();

/** Drops any bucket that has not been touched in over an hour. Called opportunistically on every
 * `consumeAttempt`, never on a timer. */
function evictStale(now: number): void {
  for (const [key, bucket] of buckets) {
    if (now - bucket.lastRefill > EVICT_IDLE_MS) {
      buckets.delete(key);
    }
  }
}

export interface AttemptResult {
  allowed: boolean;
  /** Seconds until at least one token will be available again. 0 when `allowed` is true. */
  retryAfterSeconds: number;
}

/** Consumes one token from `key`'s bucket if available. `now` defaults to `Date.now()` in
 * production and is injected explicitly by tests to advance time deterministically. */
export function consumeAttempt(key: string, now: number = Date.now()): AttemptResult {
  evictStale(now);

  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { tokens: CAPACITY, lastRefill: now };
    buckets.set(key, bucket);
  } else {
    const elapsedMs = Math.max(0, now - bucket.lastRefill);
    bucket.tokens = Math.min(CAPACITY, bucket.tokens + elapsedMs * REFILL_RATE_PER_MS);
    bucket.lastRefill = now;
  }

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return { allowed: true, retryAfterSeconds: 0 };
  }

  const tokensNeeded = 1 - bucket.tokens;
  const msNeeded = tokensNeeded / REFILL_RATE_PER_MS;
  return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(msNeeded / 1000)) };
}

/** Restores a key's bucket to full capacity. Called on successful login so a correct password
 * doesn't count against the attacker-facing window. */
export function resetAttempts(key: string): void {
  buckets.delete(key);
}

/** Number of currently tracked keys. Exists for the eviction test — not used by production
 * callers. */
export function getBucketCount(): number {
  return buckets.size;
}
