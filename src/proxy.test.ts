/**
 * Covers plan 03-08 Task 3's proxy.ts acceptance criteria: the matcher includes `/embed/:path*`,
 * `frame-ancestors` names the configured domains (or `'none'` for an empty allowlist), and — the
 * assertion most likely to be forgotten, and the one whose absence breaks every widget on every
 * site (RESEARCH.md Pitfall 5) — a request to `/embed/{kbId}` with no session cookie is NOT
 * redirected to `/login`.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server.js";
import type { WidgetConfig } from "./lib/widget/config.js";

const getWidgetConfigMock = vi.fn<(kbId: string) => Promise<WidgetConfig>>();

vi.mock("./lib/widget/config.js", () => ({
  getWidgetConfig: (...args: [string]) => getWidgetConfigMock(...args),
}));

const { proxy, config } = await import("./proxy.js");

function makeConfig(overrides: Partial<WidgetConfig> = {}): WidgetConfig {
  return {
    productName: "KyzerDocs",
    logoUrl: null,
    accentColor: "#0E4F4A",
    position: "bottom-right",
    title: "Ask KyzerDocs",
    allowedDomains: [],
    ...overrides,
  };
}

beforeEach(() => {
  getWidgetConfigMock.mockReset();
});

describe("proxy matcher", () => {
  it("includes /embed/:path*", () => {
    expect(config.matcher).toContain("/embed/:path*");
  });
});

describe("proxy /embed/* framing (WIDG-05, D3-12)", () => {
  it("sets frame-ancestors naming the configured domains", async () => {
    getWidgetConfigMock.mockResolvedValue(
      makeConfig({ allowedDomains: ["example.com", "shop.example.com"] }),
    );

    const req = new NextRequest(new URL("http://localhost/embed/default"));
    const res = await proxy(req);

    expect(getWidgetConfigMock).toHaveBeenCalledWith("default");
    // BOTH forms per stored domain. The allowlist stores the bare host (normalizeDomain strips
    // `www.`) and `isOriginAllowed` strips `www.` from the incoming Origin, so the API accepts
    // www requests. CSP frame-ancestors does no normalisation, so emitting only the bare form made
    // the browser refuse to frame the widget on any www site while the API said the origin was
    // fine — a contradiction the buyer could not act on (03-UAT F13).
    expect(res.headers.get("content-security-policy")).toBe(
      "frame-ancestors https://example.com https://www.example.com " +
        "https://shop.example.com https://www.shop.example.com",
    );
  });

  it("frames a www. host from a bare stored domain — the case that blocked a real site", async () => {
    getWidgetConfigMock.mockResolvedValue(makeConfig({ allowedDomains: ["kyzer.ai"] }));
    const res = await proxy(new NextRequest(new URL("http://localhost/embed/default")));
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("https://kyzer.ai");
    expect(csp).toContain("https://www.kyzer.ai");
  });

  it("still refuses everything on an empty allowlist", async () => {
    getWidgetConfigMock.mockResolvedValue(makeConfig({ allowedDomains: [] }));
    const res = await proxy(new NextRequest(new URL("http://localhost/embed/default")));
    expect(res.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
  });

  it("yields frame-ancestors 'none' for an empty allowlist", async () => {
    getWidgetConfigMock.mockResolvedValue(makeConfig({ allowedDomains: [] }));

    const req = new NextRequest(new URL("http://localhost/embed/default"));
    const res = await proxy(req);

    expect(res.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
  });

  it("does NOT redirect /embed/default to /login even with no session cookie", async () => {
    getWidgetConfigMock.mockResolvedValue(makeConfig({ allowedDomains: ["example.com"] }));

    const req = new NextRequest(new URL("http://localhost/embed/default"));
    const res = await proxy(req);

    expect(res.headers.get("location")).toBeNull();
  });
});

describe("proxy admin page redirect (unchanged, Phase 2)", () => {
  it("redirects /ask with no session cookie to /login", async () => {
    const req = new NextRequest(new URL("http://localhost/ask"));
    const res = await proxy(req);

    expect(res.headers.get("location")).toContain("/login");
    expect(getWidgetConfigMock).not.toHaveBeenCalled();
  });

  it("does not set frame-ancestors on an admin page", async () => {
    const req = new NextRequest(new URL("http://localhost/ask"), {
      headers: { cookie: "kdl_session=whatever" },
    });
    const res = await proxy(req);

    expect(res.headers.get("content-security-policy")).toBeNull();
  });
});
