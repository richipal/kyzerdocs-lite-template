/**
 * Concurrency limiter with inter-call delay for rate-sensitive external calls.
 *
 * Built here (under plan 01-09) because this plan's Task 1 depends on it, and plan 01-08 — which
 * owns this file per the phase's plan set — has not yet been executed (no KyzerDocs/Postgres
 * credentials are configured; see 01-02-SUMMARY.md's BLOCKED verdict). This is a self-contained,
 * dependency-free, pure-logic utility with no production-database or KyzerDocs-API surface, so
 * building the small piece 01-09 needs here (Rule 3 — blocking dependency) does not touch any of
 * 01-08's actual scope (ingest, export, cleanup scripts against a live KyzerDocs instance). Plan
 * 01-08, when it runs, should find this file already satisfying its own Task 1 spec.
 *
 * This is the pattern used for every rate-sensitive external call in the harness: Gemini
 * embedding batches here (plan 01-09), `/api/eval/chat` calls (plan 01-10), and ingest uploads
 * (plan 01-08). Hand-rolled — no dependency added to a phase whose whole point is producing a
 * trustworthy number.
 *
 * Source: ported in spirit from KyzerDocs' `scripts/run_rag_eval.py`'s `run_api_calls`
 * (`asyncio.Semaphore` + inter-call delay), reimplemented in TypeScript.
 */

/** A simple counting semaphore: `acquire()` resolves once a slot is available and returns a
 * `release` function the caller must call exactly once when done with the slot. */
export function createSemaphore(limit: number): { acquire: () => Promise<() => void> } {
  if (limit < 1) throw new Error(`createSemaphore: limit must be >= 1, got ${limit}`);

  let active = 0;
  const queue: Array<() => void> = [];

  function release(): void {
    active--;
    const next = queue.shift();
    if (next) next();
  }

  async function acquire(): Promise<() => void> {
    if (active < limit) {
      active++;
      return release;
    }
    await new Promise<void>((resolve) => queue.push(resolve));
    active++;
    return release;
  }

  return { acquire };
}

/** One failed item's captured error, in place of a thrown exception. */
export interface MapWithLimitError {
  error: string;
}

/**
 * Runs `fn` over every item in `items`, never more than `limit` in flight at once, waiting
 * `delayMs` after acquiring a slot and before invoking `fn` (inter-call pacing for rate-sensitive
 * APIs). A rejected `fn` call is captured as `{ error }` rather than propagated — one failure
 * must not abort the batch. Output order always matches input order, regardless of completion
 * order.
 */
export async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  delayMs: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<Array<R | MapWithLimitError>> {
  const semaphore = createSemaphore(limit);
  const results: Array<R | MapWithLimitError> = new Array(items.length);

  await Promise.all(
    items.map(async (item, index) => {
      const release = await semaphore.acquire();
      try {
        if (delayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
        results[index] = await fn(item, index);
      } catch (err) {
        results[index] = { error: err instanceof Error ? err.message : String(err) };
      } finally {
        release();
      }
    }),
  );

  return results;
}
