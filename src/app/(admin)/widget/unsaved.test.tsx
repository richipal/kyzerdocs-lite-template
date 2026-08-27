// @vitest-environment jsdom
/**
 * The Widget screen must say when what you are looking at is not yet saved.
 *
 * Nothing on this screen reaches the server until Save. Adding an allowed domain appends a visible
 * row to the list, which reads as done — and navigating away discarded it with no warning. That
 * happened during UAT: a domain was added, the allowlist stayed empty, and the widget correctly
 * refused every origin for a reason the screen had given no hint about (03-UAT F11).
 *
 * Both assertions matter. A dirty form must announce itself, and a clean one must NOT — an
 * always-visible "unsaved" note would be noise that teaches the buyer to ignore it.
 */

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import WidgetPageClient from "./WidgetPageClient.js";

const config = {
  productName: "KyzerDocs",
  logoUrl: null,
  accentColor: "#0E4F4A",
  position: "bottom-right" as const,
  title: "Ask KyzerDocs",
  allowedDomains: [] as string[],
};

function renderPage() {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(config))));
  return render(
    <WidgetPageClient
      kbId="default"
      initialConfig={config}
      initialHasBeenConfigured={false}
      deploymentHost="example.vercel.app"
      cloudMode
    />,
  );
}

// This project's vitest config does not set `globals: true`, so testing-library's automatic
// afterEach cleanup is never registered — without this, the first render's DOM persists into the
// next test and every query finds two of everything.
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("unsaved-changes indication", () => {
  it("is silent on a pristine form, and Save is disabled", () => {
    renderPage();
    expect(screen.queryByTestId("unsaved-changes")).toBeNull();
    expect(screen.getByTestId("save-widget-settings")).toBeDisabled();
  });

  it("announces unsaved changes once a domain is added, and enables Save", () => {
    renderPage();
    // Scoped to the Allowed domains panel — the placeholder "example.com" appears more than once
    // on this screen, so an unscoped query is ambiguous and would break on unrelated edits.
    const panel = screen.getByTestId("allowed-domains-section");
    const input = within(panel).getByPlaceholderText("example.com");
    fireEvent.change(input, { target: { value: "myshop.com" } });
    fireEvent.click(within(panel).getByRole("button", { name: /add/i }));

    expect(screen.getByTestId("unsaved-changes")).toBeInTheDocument();
    expect(screen.getByTestId("save-widget-settings")).toBeEnabled();
  });
});
