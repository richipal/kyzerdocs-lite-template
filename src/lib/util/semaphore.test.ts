import { describe, expect, it } from "vitest";
import { createSemaphore, mapWithLimit } from "./semaphore.js";

describe("createSemaphore", () => {
  it("never allows more than `limit` concurrent holders", async () => {
    const semaphore = createSemaphore(2);
    let active = 0;
    let maxActive = 0;

    async function task(): Promise<void> {
      const release = await semaphore.acquire();
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      release();
    }

    await Promise.all([task(), task(), task(), task(), task()]);
    expect(maxActive).toBeLessThanOrEqual(2);
  });
});

describe("mapWithLimit", () => {
  it("never has more than `limit` tasks in flight, proven by a counter", async () => {
    let active = 0;
    let maxActive = 0;

    await mapWithLimit([1, 2, 3, 4, 5, 6], 2, 0, async (item) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return item * 2;
    });

    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it("preserves input order in its output regardless of completion order", async () => {
    // Items with a *smaller* value resolve *later*, deliberately inverting completion order.
    const items = [5, 1, 4, 2, 3];
    const results = await mapWithLimit(items, 3, 0, async (item) => {
      await new Promise((resolve) => setTimeout(resolve, item * 5));
      return item;
    });
    expect(results).toEqual([5, 1, 4, 2, 3]);
  });

  it("captures a rejected task as a settled error entry instead of propagating", async () => {
    const results = await mapWithLimit([1, 2, 3], 2, 0, async (item) => {
      if (item === 2) throw new Error("boom");
      return item;
    });
    expect(results[0]).toBe(1);
    expect(results[1]).toEqual({ error: "boom" });
    expect(results[2]).toBe(3);
  });

  it("one failure does not abort the rest of the batch", async () => {
    const results = await mapWithLimit([1, 2, 3, 4], 1, 0, async (item) => {
      if (item === 1) throw new Error("first item fails");
      return item;
    });
    expect(results).toHaveLength(4);
    expect(results[1]).toBe(2);
    expect(results[2]).toBe(3);
    expect(results[3]).toBe(4);
  });

  it("applies the configured inter-call delay between task starts", async () => {
    const start = Date.now();
    await mapWithLimit([1, 2], 1, 20, async (item) => item);
    const elapsed = Date.now() - start;
    // Two sequential slots (limit=1) each wait 20ms before invoking fn => at least ~40ms total.
    expect(elapsed).toBeGreaterThanOrEqual(35);
  });

  it("returns an empty array for an empty input without calling fn", async () => {
    let calls = 0;
    const results = await mapWithLimit([], 3, 0, async () => {
      calls++;
      return 1;
    });
    expect(results).toEqual([]);
    expect(calls).toBe(0);
  });
});
