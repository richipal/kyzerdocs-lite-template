// @vitest-environment jsdom
/**
 * Covers plan 03-09 Task 2's acceptance criteria: Branding (contrast warning, logo constraints),
 * Widget settings (title counter), and Allowed domains (validation, undo, empty state). Task 3
 * extends this same file (WidgetPreview, InstallSnippet, AppShell branding/cloud meta) per the
 * plan's own file list, which names this ONE test file across both tasks.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import AllowedDomainsSection from "./AllowedDomainsSection.js";
import BrandingSection from "./BrandingSection.js";
import InstallSnippet from "./InstallSnippet.js";
import WidgetPreview from "./WidgetPreview.js";
import WidgetSettingsSection from "./WidgetSettingsSection.js";
import { ACCEPTED_LOGO_TYPES } from "../../lib/widget/logo-constraints.js";
import { AppShell } from "../layout/AppShell.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("BrandingSection — accent colour contrast (S-5, ADMIN-04)", () => {
  it("renders no warning for the shipped default accent (#0E4F4A)", () => {
    render(<BrandingSection productName="Acme" logoUrl={null} accentColor="#0E4F4A" onChange={vi.fn()} />);
    expect(screen.queryByTestId("contrast-warning")).not.toBeInTheDocument();
  });

  it("entering a pale accent renders the warning containing the real computed ratio", () => {
    const onChange = vi.fn();
    render(<BrandingSection productName="Acme" logoUrl={null} accentColor="#0E4F4A" onChange={onChange} />);
    const hexInput = screen.getByLabelText("Accent colour hex value");
    fireEvent.change(hexInput, { target: { value: "#F5F0C0" } });

    const warning = screen.getByTestId("contrast-warning");
    expect(warning).toHaveTextContent(/contrast ratio of \d+(\.\d+)?:1 against white text/);
    expect(warning).toHaveTextContent("You can still save it.");
    // The colour still saves — no silent substitution (UI-SPEC: "the app never swaps in a safer colour").
    expect(onChange).toHaveBeenCalledWith({ accentColor: "#F5F0C0" });
  });
});

describe("BrandingSection — logo upload constraints (ADMIN-04)", () => {
  it("rejects a file over 512KB with a stated reason and never calls onChange", async () => {
    const onChange = vi.fn();
    render(<BrandingSection productName="Acme" logoUrl={null} accentColor="#0E4F4A" onChange={onChange} />);
    const input = screen.getByLabelText("Choose a logo file");
    const oversized = new File([new Uint8Array(600 * 1024)], "logo.png", { type: "image/png" });

    await act(async () => {
      fireEvent.change(input, { target: { files: [oversized] } });
    });

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/too large/i);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("rejects an unsupported file type with a stated reason and never calls onChange", async () => {
    const onChange = vi.fn();
    render(<BrandingSection productName="Acme" logoUrl={null} accentColor="#0E4F4A" onChange={onChange} />);
    const input = screen.getByLabelText("Choose a logo file");
    const wrongType = new File(["x"], "logo.gif", { type: "image/gif" });

    await act(async () => {
      fireEvent.change(input, { target: { files: [wrongType] } });
    });

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/isn't supported/i);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("accepts a valid PNG and calls onChange with a data URL", async () => {
    const onChange = vi.fn();
    render(<BrandingSection productName="Acme" logoUrl={null} accentColor="#0E4F4A" onChange={onChange} />);
    const input = screen.getByLabelText("Choose a logo file");
    const valid = new File([new Uint8Array(10)], "logo.png", { type: "image/png" });

    fireEvent.change(input, { target: { files: [valid] } });

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith({ logoUrl: expect.stringMatching(/^data:image\/png/) });
    });
  });

  it("renders the constraint-chip row from ACCEPTED_LOGO_TYPES verbatim", () => {
    render(<BrandingSection productName="Acme" logoUrl={null} accentColor="#0E4F4A" onChange={vi.fn()} />);
    const chips = screen.getByTestId("logo-constraint-chips");
    for (const type of ACCEPTED_LOGO_TYPES) {
      expect(chips).toHaveTextContent(type.label);
    }
  });

  it("the constraint-chip row's accepted types come from the same constant validation uses — changing the constant changes the rendered chips", async () => {
    vi.resetModules();
    vi.doMock("../../lib/widget/logo-constraints.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../../lib/widget/logo-constraints.js")>();
      return {
        ...actual,
        ACCEPTED_LOGO_TYPES: [{ label: "WEBP", mime: "image/webp" }],
      };
    });
    const { default: MockedBrandingSection } = await import("./BrandingSection.js");

    render(<MockedBrandingSection productName="Acme" logoUrl={null} accentColor="#0E4F4A" onChange={vi.fn()} />);
    const chips = screen.getByTestId("logo-constraint-chips");
    expect(chips).toHaveTextContent("WEBP");
    expect(chips).not.toHaveTextContent("PNG");

    vi.doUnmock("../../lib/widget/logo-constraints.js");
    vi.resetModules();
  });

  it("removing the logo reverts to a monogram fallback with no confirmation", () => {
    const onChange = vi.fn();
    render(<BrandingSection productName="Acme" logoUrl="data:image/png;base64,abc" accentColor="#0E4F4A" onChange={onChange} />);
    fireEvent.click(screen.getByText("Remove logo"));
    expect(onChange).toHaveBeenCalledWith({ logoUrl: null });
  });
});

describe("WidgetSettingsSection — title counter and position toggle (WIDG-04)", () => {
  it("enforces a 40-character limit and renders a live counter", () => {
    const onChange = vi.fn();
    render(<WidgetSettingsSection position="bottom-right" title="Ask Acme" onChange={onChange} />);
    expect(screen.getByTestId("title-counter")).toHaveTextContent("8/40");

    const input = screen.getByLabelText("Widget panel title") as HTMLInputElement;
    expect(input.maxLength).toBe(40);
  });

  it("selecting bottom-left calls onChange with the new position", () => {
    const onChange = vi.fn();
    render(<WidgetSettingsSection position="bottom-right" title="Ask Acme" onChange={onChange} />);
    fireEvent.click(screen.getByText("Bottom left"));
    expect(onChange).toHaveBeenCalledWith({ position: "bottom-left" });
  });
});

describe("AllowedDomainsSection — validation, undo, empty state (WIDG-05, D3-12)", () => {
  it("renders the D3-12 convenience-filter explainer verbatim", () => {
    render(<AllowedDomainsSection domains={[]} onChange={vi.fn()} />);
    expect(screen.getByText(/convenience filter, not a security boundary/)).toBeInTheDocument();
  });

  it("adding a full URL renders the UI-SPEC validation error and does not call onChange", () => {
    const onChange = vi.fn();
    render(<AllowedDomainsSection domains={[]} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Add an allowed domain"), {
      target: { value: "https://example.com/path" },
    });
    fireEvent.click(screen.getByText("Add"));

    expect(screen.getByTestId("domain-validation-error")).toHaveTextContent(
      "Enter a domain, like example.com — not a full URL.",
    );
    expect(onChange).not.toHaveBeenCalled();
  });

  it("adding Example.COM stores example.com", () => {
    const onChange = vi.fn();
    render(<AllowedDomainsSection domains={[]} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Add an allowed domain"), { target: { value: "Example.COM" } });
    fireEvent.click(screen.getByText("Add"));

    expect(onChange).toHaveBeenCalledWith(["example.com"]);
  });

  it("an empty allowed-domains list renders the UI-SPEC empty-state copy", () => {
    render(<AllowedDomainsSection domains={[]} onChange={vi.fn()} />);
    expect(screen.getByTestId("allowed-domains-empty")).toHaveTextContent(
      "No domains added yet. Add your website's domain before you publish the install snippet, or the widget won't respond anywhere.",
    );
  });

  it("removing a domain renders an Undo affordance, and activating it restores the row", () => {
    function Wrapper() {
      const [domains, setDomains] = useState(["example.com", "shop.example.com"]);
      return <AllowedDomainsSection domains={domains} onChange={setDomains} />;
    }
    render(<Wrapper />);

    expect(screen.getAllByTestId("allowed-domain-row")).toHaveLength(2);
    fireEvent.click(screen.getByTitle("Remove example.com"));

    expect(screen.getAllByTestId("allowed-domain-row")).toHaveLength(1);
    expect(screen.getByTestId("domain-removed-undo")).toHaveTextContent("example.com");

    fireEvent.click(screen.getByText("Undo"));
    expect(screen.getAllByTestId("allowed-domain-row")).toHaveLength(2);
    expect(screen.queryByTestId("domain-removed-undo")).not.toBeInTheDocument();
  });
});

const PREVIEW_CONFIG = {
  productName: "Acme",
  logoUrl: null,
  accentColor: "#0E4F4A",
  position: "bottom-right" as const,
  title: "Ask Acme",
};

describe("WidgetPreview — a real iframe onto the real embed route (S-5)", () => {
  it("renders an iframe whose src contains /embed/ and no img/static asset", () => {
    render(<WidgetPreview kbId="default" config={PREVIEW_CONFIG} />);
    const iframe = screen.getByTestId("widget-preview-frame") as HTMLIFrameElement;
    expect(iframe.tagName).toBe("IFRAME");
    expect(iframe.src).toContain("/embed/default");
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("posts a preview-config message to the iframe on an accent-colour change, with a non-wildcard targetOrigin", async () => {
    vi.useFakeTimers();
    const { rerender } = render(<WidgetPreview kbId="default" config={PREVIEW_CONFIG} />);
    const iframe = screen.getByTestId("widget-preview-frame") as HTMLIFrameElement;
    const postMessageSpy = vi.spyOn(iframe.contentWindow!, "postMessage");

    rerender(<WidgetPreview kbId="default" config={{ ...PREVIEW_CONFIG, accentColor: "#F5F0C0" }} />);

    await act(async () => {
      vi.advanceTimersByTime(250);
    });

    expect(postMessageSpy).toHaveBeenCalled();
    const lastCall = postMessageSpy.mock.calls[postMessageSpy.mock.calls.length - 1]!;
    expect(lastCall[0]).toMatchObject({
      type: "preview-config",
      config: expect.objectContaining({ accentColor: "#F5F0C0" }),
    });
    expect(lastCall[1]).not.toBe("*");
    vi.useRealTimers();
  });
});

describe("InstallSnippet — real values or honestly disabled (S-5, S-1, S-2, S-6)", () => {
  it("before the first save, renders the unsaved copy and a disabled copy button", () => {
    render(<InstallSnippet kbId="default" deploymentHost="https://acme.example.com" position="bottom-right" hasBeenConfigured={false} />);
    expect(screen.getByTestId("snippet-unsaved")).toHaveTextContent(
      "Save your settings to generate the install snippet.",
    );
    expect(screen.getByTestId("copy-snippet-button")).toBeDisabled();
    expect(screen.queryByTestId("snippet-code")).not.toBeInTheDocument();
  });

  it("after a save, renders the real kbId/position with no placeholder token", () => {
    render(<InstallSnippet kbId="default" deploymentHost="https://acme.example.com" position="bottom-left" hasBeenConfigured={true} />);
    const code = screen.getByTestId("snippet-code");
    expect(code).toHaveTextContent('data-kb-id="default"');
    expect(code).toHaveTextContent('data-position="bottom-left"');
    expect(code).toHaveTextContent("https://acme.example.com/widget.js");
    expect(code.textContent).not.toContain("{kbId}");
    expect(code.textContent).not.toContain("YOUR_ID");
    expect(screen.getByTestId("copy-snippet-button")).not.toBeDisabled();
  });

  it("clicking copy changes the button's rendered text to Copied", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });

    render(<InstallSnippet kbId="default" deploymentHost="https://acme.example.com" position="bottom-right" hasBeenConfigured={true} />);
    fireEvent.click(screen.getByTestId("copy-snippet-button"));

    await waitFor(() => {
      expect(screen.getByTestId("copy-snippet-button")).toHaveTextContent("Copied");
    });
  });

  it("on a clipboard failure, renders the Cmd/Ctrl+C fallback instead of a silent no-op", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });

    render(<InstallSnippet kbId="default" deploymentHost="https://acme.example.com" position="bottom-right" hasBeenConfigured={true} />);
    fireEvent.click(screen.getByTestId("copy-snippet-button"));

    await waitFor(() => {
      expect(screen.getByTestId("copy-snippet-button")).toHaveTextContent("Press Cmd/Ctrl+C to copy");
    });
  });
});

describe("AppShell — branding reaches the admin shell (ADMIN-04)", () => {
  function stubFetch(opts: { brand?: Record<string, unknown>; driver?: Record<string, unknown> } = {}) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/api/documents")) return jsonResponse({ documents: [] });
        if (url.includes("/api/widget/config")) {
          return opts.brand
            ? jsonResponse(opts.brand)
            : jsonResponse({ code: "KDL-AUTH-003", message: "x", action: "y" }, 401);
        }
        if (url.includes("/api/health")) {
          return jsonResponse({
            database: { ok: true },
            apiKey: { ok: true },
            embedding: { ok: true },
            chatProvider: { ok: true },
            lastFailedDocument: null,
            ...(opts.driver ? { driver: opts.driver } : {}),
          });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
  }

  it("renders the configured productName and logo when logoUrl is set", async () => {
    stubFetch({ brand: { productName: "Acme Co", logoUrl: "data:image/png;base64,abc", accentColor: "#0E4F4A" } });
    render(<AppShell active="widget"><div /></AppShell>);

    await waitFor(() => {
      expect(screen.getByTestId("sidebar-brand-name")).toHaveTextContent("Acme Co");
    });
    const logoImg = document.querySelector(".sidebar__logo--image") as HTMLImageElement | null;
    expect(logoImg?.src).toContain("data:image/png");
  });

  it("renders the existing monogram fallback when logoUrl is null", async () => {
    stubFetch({ brand: { productName: "Acme Co", logoUrl: null, accentColor: "#0E4F4A" } });
    render(<AppShell active="widget"><div /></AppShell>);

    await waitFor(() => {
      expect(screen.getByTestId("sidebar-brand-name")).toHaveTextContent("Acme Co");
    });
    expect(document.querySelector(".sidebar__logo--image")).not.toBeInTheDocument();
    expect(document.querySelector(".sidebar__logo")).toHaveTextContent("A");
  });

  it("in cloud mode, the sidebar meta line contains the driver label and '· cloud'", async () => {
    stubFetch({
      brand: { productName: "Acme Co", logoUrl: null, accentColor: "#0E4F4A" },
      driver: { cloudMode: true, label: "Postgres (Neon)" },
    });
    render(<AppShell active="widget"><div /></AppShell>);

    await waitFor(() => {
      expect(screen.getByTestId("sidebar-meta")).toHaveTextContent("Postgres (Neon) · cloud");
    });
  });

  it("in local mode, the sidebar meta line is unchanged", async () => {
    stubFetch({ brand: { productName: "Acme Co", logoUrl: null, accentColor: "#0E4F4A" } });
    render(<AppShell active="widget"><div /></AppShell>);

    await waitFor(() => {
      expect(screen.getByTestId("sidebar-meta")).toHaveTextContent("SQLite · local folder");
    });
  });
});
