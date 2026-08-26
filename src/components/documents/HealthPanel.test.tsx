// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import HealthPanel from "./HealthPanel.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Stubs `fetch` to answer both calls `HealthPanel` makes on mount (`GET /api/health` and
 * `GET /api/documents`), routing by URL so each test only needs to specify the health body. */
function stubFetch(healthBody: Record<string, unknown>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/health")) return jsonResponse(healthBody);
      if (url.includes("/api/documents")) return jsonResponse({ documents: [] });
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
}

const BASE_HEALTH_BODY = {
  database: { ok: true },
  apiKey: { ok: true },
  embedding: { ok: true },
  chatProvider: { ok: true },
  lastFailedDocument: null,
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("HealthPanel — Index rebuild (cold) row (D3-18, plan 03-07, UI-STANDARDS.md S-5)", () => {
  it("renders NO element containing the text 'Index rebuild' when health.indexRebuild is absent", async () => {
    stubFetch({ ...BASE_HEALTH_BODY }); // no indexRebuild field at all

    render(<HealthPanel />);

    await waitFor(() => {
      expect(screen.getByTestId("health-panel")).toBeInTheDocument();
    });
    // Give the component's own state update a tick to settle before asserting an absence.
    await act(async () => {});

    expect(screen.queryByTestId("health-index-rebuild")).not.toBeInTheDocument();
    expect(screen.queryByText(/Index rebuild/i)).not.toBeInTheDocument();
  });

  it("renders the row with the real millisecond value when health.indexRebuild is present", async () => {
    stubFetch({ ...BASE_HEALTH_BODY, indexRebuild: { ms: 6478.52 } });

    render(<HealthPanel />);

    const row = await screen.findByTestId("health-index-rebuild");
    expect(row).toHaveTextContent("Index rebuild (cold)");
    expect(row).toHaveTextContent("6478.52ms");
  });

  it("never fabricates a 0ms or placeholder value — a zero-ms measurement still renders the exact number, never invented", async () => {
    // Distinguishes a REAL zero-duration measurement (a legitimate, if unlikely, value) from the
    // absent case above — the component must not treat 0 as "no data" and hide the row, nor must
    // it show a dash/placeholder for the absent case. Both are asserted, in the two tests either
    // side of this one.
    stubFetch({ ...BASE_HEALTH_BODY, indexRebuild: { ms: 0 } });

    render(<HealthPanel />);

    const row = await screen.findByTestId("health-index-rebuild");
    expect(row).toHaveTextContent("0ms");
  });
});

describe("HealthPanel — Blob storage row (plan 03-10, STOR-06, UI-SPEC Surface 4)", () => {
  it("renders NO element containing 'Blob storage' when health.blob is absent (local mode)", async () => {
    stubFetch({ ...BASE_HEALTH_BODY }); // no blob field at all — local mode's real response shape

    render(<HealthPanel />);

    await waitFor(() => {
      expect(screen.getByTestId("health-panel")).toBeInTheDocument();
    });
    await act(async () => {});

    expect(screen.queryByTestId("health-check-blob")).not.toBeInTheDocument();
    expect(screen.queryByText(/Blob storage/i)).not.toBeInTheDocument();
  });

  it("renders the row with data-ok=\"true\" when the probe succeeded (cloud mode)", async () => {
    stubFetch({ ...BASE_HEALTH_BODY, blob: { ok: true } });

    render(<HealthPanel />);

    const row = await screen.findByTestId("health-check-blob");
    expect(row).toHaveAttribute("data-ok", "true");
    expect(row).toHaveTextContent("Blob storage");
    expect(row).toHaveTextContent("OK");
  });

  it("renders the row with data-ok=\"false\" and the coded reason when the probe failed", async () => {
    stubFetch({
      ...BASE_HEALTH_BODY,
      blob: { ok: false, code: "KDL-BLOB-004", message: "Blob storage could not be reached." },
    });

    render(<HealthPanel />);

    const row = await screen.findByTestId("health-check-blob");
    expect(row).toHaveAttribute("data-ok", "false");
    expect(row).toHaveTextContent("KDL-BLOB-004");
    expect(row).toHaveTextContent("Blob storage could not be reached.");
  });
});
