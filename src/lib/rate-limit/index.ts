/**
 * WIDG-06 selection seam (D3-15/D3-16) — the single call site every route in this phase uses:
 * `getRateLimiter().consume(key)`. Selects an implementation from `PRODUCT_CONFIG.cloudMode`, the
 * exact same `DATABASE_URL`-presence switch `src/lib/storage/index.ts`'s `getStorageDriver()`
 * uses — one convention, now two call sites (storage and this one; 03-10's file storage will be a
 * third), never three different ways of asking "are we in cloud mode."
 *
 * Deliberately TWO implementations behind ONE selection point, not one function with an internal
 * `if`:
 *   - Local mode wraps `src/lib/auth/rate-limit.ts`'s existing, UNTOUCHED, synchronous
 *     `consumeAttempt` in an async method (D3-16 — the login limiter keeps working exactly as it
 *     does today; this file adds nothing to its own behaviour).
 *   - Cloud mode delegates to `src/lib/rate-limit/pg-limiter.ts`'s `consumeAttemptPg`.
 * Keeping these as two distinct objects, rather than merging them, is what makes
 * `pg-limiter.test.ts`'s cold-invocation negative control meaningful (D3-15) — a merged
 * implementation would make it trivially easy for a future edit to accidentally route production
 * cloud traffic through the in-memory bucket again, which is exactly the failure mode this phase
 * exists to close.
 *
 * D3-15's failure rule, restated here because it's the one thing this file must never violate:
 * "a limiter that silently enforces nothing is worse than no limiter, because it looks like
 * protection." If the cloud-mode Postgres limiter throws for ANY reason — unreachable database,
 * missing `rate_limits` relation, a transport that rejects the query — `consume` does NOT fall
 * back to the in-memory limiter and does NOT return `{ allowed: true }`. It throws
 * `AppError("KDL-WIDG-005")`, and the caller (plan 03-08's routes) turns that into a refusal. The
 * specific underlying cause is `console.error`-logged server-side so the buyer's deployment logs
 * name it; the client-visible copy stays generic (`KDL-WIDG-005`'s registered message never
 * mentions Postgres or `DATABASE_URL` — a site visitor is not the audience for that detail).
 */

import { consumeAttempt } from "../auth/rate-limit.js";
import type { AttemptResult } from "../auth/rate-limit.js";
import { PRODUCT_CONFIG } from "../config.js";
import { AppError } from "../errors.js";
import { consumeAttemptPg, PUBLIC_WIDGET_RATE_LIMIT_POLICY } from "./pg-limiter.js";

export interface RateLimiter {
  consume(key: string): Promise<AttemptResult>;
}

/** Local mode (D3-16): wraps the existing, unmodified in-memory limiter. Nothing about this
 * object's behaviour is new — it exists only so local-mode callers get the same `async
 * consume(key)` shape cloud-mode callers get, letting every route call site look identical
 * regardless of mode. */
const localRateLimiter: RateLimiter = {
  async consume(key: string): Promise<AttemptResult> {
    return consumeAttempt(key);
  },
};

/** Cloud mode (D3-15): delegates to the Postgres-backed limiter. Any failure here is fail-CLOSED
 * — see this file's header comment. This implementation deliberately has no reference to
 * `consumeAttempt`/`../auth/rate-limit.js` anywhere in its body: that is the source assertion
 * `index.test.ts` checks, and it is what guarantees a cloud-mode failure can never silently
 * resolve through the in-memory bucket. */
const cloudRateLimiter: RateLimiter = {
  async consume(key: string): Promise<AttemptResult> {
    try {
      return await consumeAttemptPg(key, PUBLIC_WIDGET_RATE_LIMIT_POLICY);
    } catch (err) {
      console.error(
        "[rate-limit] Postgres rate limiter failed; refusing traffic rather than serving it unlimited (KDL-WIDG-005):",
        err,
      );
      throw new AppError("KDL-WIDG-005", { cause: err });
    }
  },
};

/** Returns the active `RateLimiter` for the current mode. No caching/singleton needed here — both
 * implementation objects above are stateless wrappers; the real state (the `Map` in local mode,
 * the Postgres connection in cloud mode) lives inside their own modules
 * (`src/lib/auth/rate-limit.js`, `src/lib/rate-limit/pg-limiter.js`). */
export function getRateLimiter(): RateLimiter {
  return PRODUCT_CONFIG.cloudMode ? cloudRateLimiter : localRateLimiter;
}
