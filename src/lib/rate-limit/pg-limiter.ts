/**
 * WIDG-06 (D3-15/D3-16) — a Postgres-backed rate limiter whose state lives in the `rate_limits`
 * table (`schema.pg.ts`), not in process memory. Reproduces `src/lib/auth/rate-limit.ts`'s exact
 * semantics (continuous fractional refill, the same `AttemptResult` shape) against a different
 * store — deliberately NOT a `Map`, deliberately NOT reusing the in-memory module (D3-15: a
 * limiter that silently enforces nothing in production is worse than none, because it looks like
 * protection).
 *
 * No injected clock here (unlike the in-memory limiter's `now` parameter) — `now()` runs
 * server-side in Postgres, which is the point: the clock authority moves from the JS process to
 * the database, so a fresh serverless invocation reads the SAME elapsed time the previous
 * invocation would have, instead of restarting from zero.
 *
 * Key composition is the CALLER's job (this module only consumes whatever string it's given), but
 * the required shape is `${ip}:${kbId}` — IP alone is wrong, because it would let one visitor's
 * traffic against one buyer's widget throttle their traffic against a completely different
 * buyer's widget.
 *
 * Concurrency (T-03-06-04): the advisory lock plus the upsert are combined into ONE statement via
 * a CTE — a single round trip, atomic over EITHER Neon transport (HTTP or WebSocket), mirroring
 * `postgres.ts`'s own `deleteDocument`/`supersedeDocument` "data-modifying CTE" pattern rather
 * than a SELECT-then-UPDATE (which would race under concurrent requests for the same key and
 * silently under-count). `pg_advisory_xact_lock` serializes only requests sharing the exact same
 * key; unrelated keys never block each other. Cited against neon.com/guides/rate-limiting
 * (03-RESEARCH.md Pattern 3), and proven concurrent-safe by `pg-limiter.test.ts`'s
 * `Promise.all`-driven burst test, not a sequential loop — a sequential loop cannot exercise the
 * race this lock exists to close.
 */

import { sql } from "drizzle-orm";
import type { AttemptResult } from "../auth/rate-limit.js";
import { AppError } from "../errors.js";
import { createPgClient, wrapPgError } from "../storage/pg-client.js";
import type { PgClient } from "../storage/pg-client.js";

export interface RateLimitPolicy {
  /** Maximum tokens a bucket can hold. */
  capacity: number;
  /** Milliseconds for a fully-drained bucket to refill to capacity, under continuous
   * (fractional) refill — matches the in-memory limiter's own refill model. */
  refillWindowMs: number;
}

/**
 * The public-widget policy (WIDG-06), defined here rather than reusing the login policy
 * (`src/lib/auth/rate-limit.ts`'s capacity 5 / 15 minutes): a website visitor asking a normal
 * series of follow-up questions is a different judgement from five login attempts in fifteen
 * minutes. Capacity 10 with a full refill over 5 minutes is a starting point chosen to let a
 * genuine visitor ask a normal series of follow-up questions while capping an automated caller —
 * cheap to change because it is a parameter here, not a constant baked into the SQL. Exported so
 * route call sites (plan 03-08) name it rather than passing magic numbers.
 */
export const PUBLIC_WIDGET_RATE_LIMIT_POLICY: RateLimitPolicy = {
  capacity: 10,
  refillWindowMs: 5 * 60 * 1000,
};

let client: PgClient | null = null;

/** Lazily opens (and caches) the Neon connection this limiter reads/writes through — same
 * lazy-singleton shape as `src/lib/storage/index.ts`'s `getStorageDriver()`, deliberately a
 * SEPARATE client instance rather than sharing `StorageDriver`'s, since `StorageDriver` exposes
 * no raw-SQL escape hatch and this limiter's atomic upsert needs one. Reset to `null` only when
 * the MODULE ITSELF is thrown away (a fresh `vi.resetModules()` re-import in tests, or a
 * genuinely fresh serverless invocation in production) — never on a timer, never explicitly. */
function getClient(): PgClient {
  if (!client) {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      // Defensive, mirrors storage/index.ts's own defensive branch — the seam in
      // src/lib/rate-limit/index.ts only calls this module when PRODUCT_CONFIG.cloudMode is
      // true, which is itself derived from DATABASE_URL presence, so this should be unreachable
      // in practice. Never construct a Postgres client with an empty string.
      throw new AppError("KDL-DB-003", {
        message: "DATABASE_URL is unexpectedly absent for the Postgres rate limiter.",
      });
    }
    client = createPgClient(databaseUrl);
  }
  return client;
}

interface ConsumeRow extends Record<string, unknown> {
  tokens: number;
  allowed: boolean;
}

/** Consumes one token from `key`'s bucket, backed by the `rate_limits` table. Same
 * `AttemptResult` shape `src/lib/auth/rate-limit.ts`'s `consumeAttempt` returns, so route call
 * sites are identical in both modes — the only difference is this one is `async` (a real DB round
 * trip) where the in-memory one is sync.
 *
 * Fails CLOSED (T-03-06-05): any failure reaching this function's own storage call — an
 * unreachable database, a missing `rate_limits` relation, a transport that rejects the query —
 * propagates as a thrown error (wrapped via `wrapPgError` into a registered `KDL-DB-*` code when
 * it isn't already an `AppError`) rather than being swallowed into a fabricated `{ allowed: true
 * }`. The caller (`src/lib/rate-limit/index.ts`) is what turns this into `KDL-WIDG-005` and
 * refuses the request — this function itself simply never manufactures a false "allowed". */
export async function consumeAttemptPg(
  key: string,
  policy: RateLimitPolicy = PUBLIC_WIDGET_RATE_LIMIT_POLICY,
): Promise<AttemptResult> {
  const { db } = getClient();
  const refillRatePerSecond = policy.capacity / (policy.refillWindowMs / 1000);

  let row: ConsumeRow;
  try {
    const result = await db.execute<ConsumeRow>(sql`
      WITH lock_acquired AS (
        SELECT pg_advisory_xact_lock(hashtext(${key}))
      )
      INSERT INTO rate_limits (key, tokens, last_refill)
      SELECT ${key}, ${policy.capacity} - 1, now()
      FROM lock_acquired
      ON CONFLICT (key) DO UPDATE SET
        tokens = LEAST(${policy.capacity}, rate_limits.tokens +
          EXTRACT(EPOCH FROM (now() - rate_limits.last_refill)) * ${refillRatePerSecond}) - 1,
        last_refill = now()
      RETURNING tokens, (tokens >= 0) AS allowed
    `);
    const first = result.rows[0];
    if (!first) {
      throw new Error("rate_limits upsert returned no row");
    }
    row = first;
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw wrapPgError(err);
  }

  if (row.allowed) {
    return { allowed: true, retryAfterSeconds: 0 };
  }

  // `row.tokens` is the post-decrement balance, which is negative here (allowed === false).
  // Mirrors the in-memory limiter's formula exactly: tokensNeeded = 1 - tokensBeforeDecrement,
  // and tokensBeforeDecrement = row.tokens + 1, so tokensNeeded = -row.tokens.
  const tokensNeeded = -Number(row.tokens);
  const secondsNeeded = tokensNeeded / refillRatePerSecond;
  return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(secondsNeeded)) };
}
