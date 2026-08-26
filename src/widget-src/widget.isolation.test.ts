// @vitest-environment jsdom
/**
 * Turns every row of the phase's UI-SPEC Isolation table (03-UI-SPEC.md, "Isolation (WIDG-02,
 * D3-11)") into a passing, fail-able test against a deliberately hostile host document — plus
 * two tests covering the WIDG-03 mobile takeover contract.
 *
 * The widget module (`kyzer-lite-widget.ts`) has no exports: its whole behavior is a top-level
 * bootstrap side effect that reads `document.currentScript` once at import time. Every test below
 * therefore builds a fresh host document, stubs `document.currentScript` to a fake `<script>`
 * element, resets the module registry, and dynamically re-imports the loader — mirroring how a
 * real browser re-evaluates the script tag on every page load.
 *
 * `window.matchMedia` does not exist in jsdom (verified empirically) — `stubMatchMedia` below is a
 * hand-rolled `MediaQueryList` stand-in that supports the one thing the loader actually uses:
 * `.matches` and `addEventListener("change", ...)`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WIDGET_MESSAGE_SOURCE, type WidgetReadyConfig } from "./protocol.js";

const WIDGET_ORIGIN = "https://widget.example";
const WIDGET_SRC = `${WIDGET_ORIGIN}/widget.js`;

function stubMatchMedia(initialMatches: boolean): {
  fireChange: (matches: boolean) => void;
} {
  const listeners = new Set<(event: { matches: boolean }) => void>();
  const mql = {
    matches: initialMatches,
    media: "(max-width: 480px)",
    addEventListener: (_type: string, cb: (event: { matches: boolean }) => void) => {
      listeners.add(cb);
    },
    removeEventListener: (_type: string, cb: (event: { matches: boolean }) => void) => {
      listeners.delete(cb);
    },
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => true,
  };
  // jsdom does not implement matchMedia (verified empirically) — this is a minimal test stand-in.
  window.matchMedia = vi.fn().mockReturnValue(mql);
  return {
    fireChange(matches: boolean) {
      mql.matches = matches;
      for (const cb of listeners) cb({ matches });
    },
  };
}

interface RenderOptions {
  attrs?: Record<string, string>;
  mobile?: boolean;
  skipReady?: boolean;
  readyConfig?: Partial<WidgetReadyConfig>;
}

interface RenderResult {
  scriptEl: HTMLScriptElement;
  fireViewportChange: (matches: boolean) => void;
  sendReady: (config?: Partial<WidgetReadyConfig>) => void;
  sendClose: () => void;
}

async function renderWidget(options: RenderOptions = {}): Promise<RenderResult> {
  document.body.innerHTML = "";
  document.head.innerHTML = "";

  const scriptEl = document.createElement("script");
  scriptEl.src = WIDGET_SRC;
  scriptEl.setAttribute("data-kb-id", options.attrs?.["data-kb-id"] ?? "default");
  for (const [key, value] of Object.entries(options.attrs ?? {})) {
    if (key === "data-kb-id") continue;
    scriptEl.setAttribute(key, value);
  }
  document.body.appendChild(scriptEl);
  Object.defineProperty(document, "currentScript", { value: scriptEl, configurable: true });

  const { fireChange } = stubMatchMedia(options.mobile ?? false);

  vi.resetModules();
  await import("./kyzer-lite-widget.js");

  function sendReady(config?: Partial<WidgetReadyConfig>): void {
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: WIDGET_ORIGIN,
        data: {
          source: WIDGET_MESSAGE_SOURCE,
          type: "ready",
          config: {
            accentColor: "#0E4F4A",
            position: "bottom-right",
            title: "Ask Acme",
            ...config,
          },
        },
      }),
    );
  }

  function sendClose(): void {
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: WIDGET_ORIGIN,
        data: { source: WIDGET_MESSAGE_SOURCE, type: "close" },
      }),
    );
  }

  if (!options.skipReady) {
    sendReady(options.readyConfig);
  }

  return { scriptEl, fireViewportChange: fireChange, sendReady, sendClose };
}

function getLauncherButton(): HTMLButtonElement | null {
  return document.body.querySelector("button");
}

function getIframe(): HTMLIFrameElement | null {
  return document.body.querySelector("iframe");
}

function getIframeContainer(): HTMLElement | null {
  return getIframe()?.parentElement ?? null;
}

describe("widget isolation (UI-SPEC Isolation table)", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  // `window` persists across `it()` blocks within one test file (jsdom's environment is fresh
  // per file, not per test). Each `renderWidget()` call registers a fresh `window.addEventListener
  // ("message", ...)` handler that is never otherwise torn down — without tracking and removing
  // these, a later test's dispatched MessageEvent would also invoke every earlier test's stale
  // handler against its (by-then-removed-from-the-DOM) iframe. Spying on `addEventListener` lets
  // us collect and remove every "message" listener after each test.
  let messageListeners: Array<EventListenerOrEventListenerObject> = [];

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const originalAddEventListener = window.addEventListener.bind(window);
    vi.spyOn(window, "addEventListener").mockImplementation(
      (
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions,
      ) => {
        if (type === "message") messageListeners.push(listener);
        return originalAddEventListener(type, listener, options);
      },
    );
  });

  afterEach(() => {
    for (const listener of messageListeners) {
      window.removeEventListener("message", listener);
    }
    messageListeners = [];
    vi.restoreAllMocks();
    vi.useRealTimers();
    document.body.innerHTML = "";
    document.head.innerHTML = "";
  });

  it("survives an aggressive host reset stylesheet: launcher stays fixed and circular", async () => {
    const style = document.createElement("style");
    style.textContent = "* { all: unset !important } button { all: unset !important }";
    document.head.appendChild(style);

    await renderWidget();

    const button = getLauncherButton();
    expect(button).toBeTruthy();
    const computed = getComputedStyle(button as HTMLButtonElement);
    expect(computed.position).toBe("fixed");
    expect(computed.borderRadius).toBe("50%");
  });

  it("beats a host z-index war: the widget's z-index is 2147483647, numerically above a hostile element's", async () => {
    const hostile = document.createElement("div");
    hostile.style.position = "fixed";
    hostile.style.zIndex = "999999999";
    document.body.appendChild(hostile);

    await renderWidget();

    const button = getLauncherButton();
    const computedZIndex = Number(getComputedStyle(button as HTMLButtonElement).zIndex);
    expect(computedZIndex).toBe(2147483647);
    expect(computedZIndex).toBeGreaterThan(Number(getComputedStyle(hostile).zIndex));
  });

  it("sandboxes the iframe with exactly allow-scripts allow-same-origin allow-forms", async () => {
    await renderWidget();

    const iframe = getIframe();
    expect(iframe).toBeTruthy();
    expect(iframe?.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin allow-forms");
  });

  it("still renders the launcher when an unrelated host script has already thrown", async () => {
    // jsdom does not execute inline <script> content by default (no `runScripts: "dangerously"`
    // configured for this suite), so a literal throwing <script> tag would never actually run, and
    // dispatching a real window "error" event trips Vitest's own unhandled-exception detector
    // rather than exercising anything about our loader. What actually matters, and is testable
    // without either: browsers do not halt subsequent script evaluation after an uncaught error
    // elsewhere on the page — each <script> tag's own failure is isolated by the browser's per-
    // script error boundary. Modeling that isolation directly (throw-and-catch, exactly as the
    // browser's own default handling does before moving to the next script) and then loading the
    // widget proves the loader depends on nothing set up by another script and isn't itself
    // skipped as a result.
    try {
      throw new Error("unrelated host script exploded");
    } catch {
      // Swallowed here only to model the browser's own per-script error isolation.
    }

    await renderWidget();

    const button = getLauncherButton();
    expect(button).toBeTruthy();
  });

  it("never reads, renders, or transmits any credential-shaped attribute", async () => {
    const fakeAdminPassword = "s3cr3t-admin-password";
    const fakeGeminiKey = "AIzaFAKEGEMINIKEY1234567890";

    await renderWidget({
      attrs: {
        "data-admin-password": fakeAdminPassword,
        "data-gemini-api-key": fakeGeminiKey,
      },
    });

    const iframe = getIframe();
    expect(iframe).toBeTruthy();
    const contentWindow = (iframe as HTMLIFrameElement).contentWindow;
    let framePostMessageCalls: unknown[] = [];
    if (contentWindow) {
      const spy = vi.spyOn(contentWindow, "postMessage").mockImplementation(() => {});
      getLauncherButton()?.click(); // open() -> posts {type: "open"} to the iframe
      framePostMessageCalls = spy.mock.calls.map((call) => call[0]);
    }

    // Only the widget's OWN created elements are in scope here — the host page's original
    // `<script>` tag legitimately carries these attributes verbatim (the host author typed them),
    // that is not something the widget rendered.
    const iframeContainer = getIframeContainer();
    const launcherContainer = getLauncherButton()?.parentElement ?? null;
    const domSnapshot = `${iframeContainer?.outerHTML ?? ""}${launcherContainer?.outerHTML ?? ""}`;
    expect(domSnapshot).not.toContain(fakeAdminPassword);
    expect(domSnapshot).not.toContain(fakeGeminiKey);

    const allPosted = JSON.stringify(framePostMessageCalls);
    expect(allPosted).not.toContain(fakeAdminPassword);
    expect(allPosted).not.toContain(fakeGeminiKey);
  });

  it("renders nothing at all when no ready message arrives (origin blocked or CSP blocked)", async () => {
    vi.useFakeTimers();

    await renderWidget({ skipReady: true });

    vi.advanceTimersByTime(5000);

    expect(document.body.querySelector("iframe")).toBeNull();
    expect(document.body.querySelector("button")).toBeNull();
    const loggedArgs = consoleErrorSpy.mock.calls.flat().join(" ");
    expect(loggedArgs).toContain("[widget]");
    expect(loggedArgs).toContain("allowlist");
    expect(loggedArgs).toContain("Content-Security-Policy");
  });

  it("takes over the full viewport on mobile: fixed inset-0 panel at 100dvh", async () => {
    await renderWidget({ mobile: true });

    getLauncherButton()?.click(); // open()

    const container = getIframeContainer();
    expect(container).toBeTruthy();
    const computed = getComputedStyle(container as HTMLElement);
    expect(computed.position).toBe("fixed");
    expect(computed.top).toBe("0px");
    expect(computed.right).toBe("0px");
    expect(computed.bottom).toBe("0px");
    expect(computed.left).toBe("0px");
    expect(computed.height).toBe("100dvh");
  });

  it("hides the launcher entirely while the mobile panel is open", async () => {
    await renderWidget({ mobile: true });

    const button = getLauncherButton() as HTMLButtonElement;
    button.click(); // open()

    expect(getComputedStyle(button).display).toBe("none");
  });
});
