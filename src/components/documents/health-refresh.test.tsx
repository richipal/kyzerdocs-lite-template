// @vitest-environment jsdom
/**
 * `HealthPanel` re-reads when `refreshKey` changes.
 *
 * It used to fetch once on mount and then update only if the buyer noticed its Refresh button. Its
 * numbers describe the corpus — document count, chunk count, vectors in memory — so uploading or
 * deleting a document left it showing whatever was true when the page loaded, sitting directly
 * beside the row that had just finished ingesting (03-UAT F8). A stale number next to a fresh one
 * is worse than no number: it reads as the upload having failed to index.
 */

import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import HealthPanel from "./HealthPanel.js";

const health = { database: { ok: true }, apiKey: { ok: true }, embedding: { ok: true }, chatProvider: { ok: true } };
let documentsPayload = { documents: [{ id: "a", chunkCount: 3, status: "ready" }] };
let fetchCalls = 0;

beforeEach(() => {
  fetchCalls = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (String(url).includes("/api/health")) { fetchCalls += 1; return new Response(JSON.stringify(health)); }
    return new Response(JSON.stringify(documentsPayload));
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe("HealthPanel refreshKey", () => {
  it("re-reads when the key changes, and not when it does not", async () => {
    const { rerender } = render(<HealthPanel refreshKey={0} />);
    await waitFor(() => expect(screen.getByTestId("health-panel")).toBeInTheDocument());
    await waitFor(() => expect(fetchCalls).toBe(1));

    // Same key — a re-render alone must not refetch, or the panel would hammer /api/health on
    // every parent state change (the list polls every few seconds).
    rerender(<HealthPanel refreshKey={0} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchCalls).toBe(1);

    // Changed key — the corpus changed, so the numbers must be re-read.
    rerender(<HealthPanel refreshKey={1} />);
    await waitFor(() => expect(fetchCalls).toBe(2));
  });
});
