/**
 * KyzerDocs Lite embeddable widget loader.
 *
 * Ships to a stranger's website as a single, minified IIFE (see scripts/build-widget.mjs). This
 * module's whole body runs inside a host document whose CSS, JavaScript, CSP and z-index stack
 * are entirely outside our control (see the phase threat model, T-03-04-03/T-03-04-05) — every
 * layout-critical style is therefore set as an inline `style` property with `!important`, never a
 * class or a stylesheet rule, and the whole bootstrap is wrapped in one top-level try/catch so a
 * failure here can never surface as an unhandled error on the host page.
 *
 * Install snippet (the only public API — no other attribute, no credential of any kind):
 *   <script src="{deployment-host}/widget.js" data-kb-id="{kbId}" data-position="{position}" async></script>
 */

import { HOST_MESSAGE_SOURCE, isWidgetMessage, type WidgetReadyConfig } from "./protocol.js";

type Position = "bottom-right" | "bottom-left";

const DEFAULT_ACCENT = "#0E4F4A";
const READY_TIMEOUT_MS = 5000;
const MOBILE_QUERY = "(max-width: 480px)";
// Exactly this string, no allow-top-navigation / allow-popups / allow-modals (T-03-04-01).
const SANDBOX_VALUE = "allow-scripts allow-same-origin allow-forms";
// Max 32-bit signed int — the ceiling every major embeddable-widget SDK converges on.
const MAX_Z_INDEX = "2147483647";

const LAUNCHER_SIZE = 56;
const LAUNCHER_OFFSET = 20;
const PANEL_GAP = 16;
const PANEL_WIDTH = 380;
const PANEL_HEIGHT = 600;
const PANEL_BOTTOM_DESKTOP = LAUNCHER_OFFSET + LAUNCHER_SIZE + PANEL_GAP;

// Stroke-based, viewBox 0 0 24 24, stroke-width 2, currentColor — lifted verbatim from the
// sibling widget's ICONS map. No xmlns attribute: an inline <svg> parsed as part of an HTML
// document is namespaced automatically, so no attribute value needs to carry the SVG spec URI.
const ICON_MESSAGE =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>';
const ICON_CLOSE =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';

function log(message: string, ...rest: unknown[]): void {
  console.error(`[widget] ${message}`, ...rest);
}

/** Sets a CSS property inline with `!important` — the only thing that can out-specificity a host
 * reset stylesheet like `* { all: unset !important }` (see the phase's Isolation table). */
function setImportant(el: HTMLElement, property: string, value: string): void {
  el.style.setProperty(property, value, "important");
}

class WidgetInstance {
  private readonly baseUrl: string;
  private readonly embedUrl: string;
  private readonly sideProperty: "left" | "right";

  private readonly launcherContainer: HTMLDivElement;
  private readonly launcherButton: HTMLButtonElement;
  private readonly iframeContainer: HTMLDivElement;
  private readonly iframe: HTMLIFrameElement;

  private isOpen = false;
  private isMobile: boolean;
  private launcherAppended = false;
  private timedOut = false;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(baseUrl: string, kbId: string, position: Position) {
    this.baseUrl = baseUrl;
    this.embedUrl = `${baseUrl}/embed/${kbId}`;
    this.sideProperty = position === "bottom-left" ? "left" : "right";
    this.isMobile = this.readMobileMatch();

    this.iframe = this.buildIframe();
    this.iframeContainer = this.buildIframeContainer();
    this.iframeContainer.appendChild(this.iframe);
    document.body.appendChild(this.iframeContainer);

    this.launcherButton = this.buildLauncherButton();
    this.launcherContainer = this.buildLauncherContainer();
    this.launcherContainer.appendChild(this.launcherButton);
    // Deliberately not appended to document.body yet — the launcher only appears once a valid
    // `ready` message arrives from the iframe (see handleReady()).

    window.addEventListener("message", (event) => this.handleMessage(event));
    this.registerViewportListener();

    this.readyTimer = setTimeout(() => this.handleReadyTimeout(), READY_TIMEOUT_MS);
  }

  // --- construction helpers ---------------------------------------------------------------

  private readMobileMatch(): boolean {
    return window.matchMedia(MOBILE_QUERY).matches;
  }

  private buildIframe(): HTMLIFrameElement {
    const iframe = document.createElement("iframe");
    iframe.src = this.embedUrl;
    iframe.setAttribute("sandbox", SANDBOX_VALUE);
    iframe.setAttribute("title", "Chat");
    setImportant(iframe, "width", "100%");
    setImportant(iframe, "height", "100%");
    setImportant(iframe, "border", "none");
    setImportant(iframe, "display", "block");
    return iframe;
  }

  private buildIframeContainer(): HTMLDivElement {
    const container = document.createElement("div");
    setImportant(container, "position", "fixed");
    setImportant(container, "z-index", MAX_Z_INDEX);
    setImportant(container, "overflow", "hidden");
    setImportant(container, "background", "#FBFAF7");
    setImportant(container, "box-shadow", "0 8px 32px rgba(0, 0, 0, 0.2)");
    setImportant(container, "display", "none");
    this.applyPanelGeometry(container);
    return container;
  }

  private buildLauncherContainer(): HTMLDivElement {
    const container = document.createElement("div");
    setImportant(container, "position", "fixed");
    setImportant(container, "z-index", MAX_Z_INDEX);
    setImportant(container, "width", `${LAUNCHER_SIZE}px`);
    setImportant(container, "height", `${LAUNCHER_SIZE}px`);
    setImportant(container, "display", "flex");
    this.applyLauncherOffset(container);
    return container;
  }

  private buildLauncherButton(): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("aria-label", "Open chat");
    button.innerHTML = ICON_MESSAGE;
    setImportant(button, "position", "fixed");
    setImportant(button, "z-index", MAX_Z_INDEX);
    setImportant(button, "width", `${LAUNCHER_SIZE}px`);
    setImportant(button, "height", `${LAUNCHER_SIZE}px`);
    setImportant(button, "border-radius", "50%");
    setImportant(button, "background", DEFAULT_ACCENT);
    setImportant(button, "color", "#FFFFFF");
    setImportant(button, "border", "none");
    setImportant(button, "cursor", "pointer");
    setImportant(button, "display", "flex");
    setImportant(button, "align-items", "center");
    setImportant(button, "justify-content", "center");
    setImportant(button, "box-shadow", "0 4px 12px rgba(0, 0, 0, 0.2)");
    setImportant(button, "transition", "transform 0.2s, box-shadow 0.2s");
    this.applyLauncherOffset(button);
    button.addEventListener("mouseenter", () => {
      setImportant(button, "transform", "scale(1.04)");
      setImportant(button, "box-shadow", "0 6px 16px rgba(0, 0, 0, 0.28)");
    });
    button.addEventListener("mouseleave", () => {
      setImportant(button, "transform", "scale(1)");
      setImportant(button, "box-shadow", "0 4px 12px rgba(0, 0, 0, 0.2)");
    });
    button.addEventListener("click", () => this.toggle());
    return button;
  }

  // --- geometry ------------------------------------------------------------------------------

  /** Desktop: 380x600 anchored 16px above the launcher, same side as configured. Mobile
   * (<=480px viewport): full-viewport takeover, no border-radius — WIDG-03. */
  private applyPanelGeometry(container: HTMLDivElement): void {
    container.style.removeProperty("inset");
    container.style.removeProperty("top");
    container.style.removeProperty("left");
    container.style.removeProperty("right");
    container.style.removeProperty("bottom");
    if (this.isMobile) {
      setImportant(container, "inset", "0");
      setImportant(container, "top", "0");
      setImportant(container, "right", "0");
      setImportant(container, "bottom", "0");
      setImportant(container, "left", "0");
      setImportant(container, "width", "100%");
      // dvh, not vh — tracks the visual viewport as mobile chrome/keyboard resize it.
      setImportant(container, "height", "100dvh");
      setImportant(container, "border-radius", "0");
    } else {
      setImportant(container, "bottom", `${PANEL_BOTTOM_DESKTOP}px`);
      setImportant(container, this.sideProperty, `${LAUNCHER_OFFSET}px`);
      setImportant(container, "width", `${PANEL_WIDTH}px`);
      setImportant(container, "height", `${PANEL_HEIGHT}px`);
      setImportant(container, "border-radius", "16px");
    }
  }

  /** Closed-state launcher offset: flat 20px on desktop, safe-area-aware on mobile so it never
   * sits under a notch/home-indicator. */
  private applyLauncherOffset(el: HTMLElement): void {
    const bottom = this.isMobile
      ? `calc(${LAUNCHER_OFFSET}px + env(safe-area-inset-bottom))`
      : `${LAUNCHER_OFFSET}px`;
    setImportant(el, "bottom", bottom);
    setImportant(el, this.sideProperty, `${LAUNCHER_OFFSET}px`);
  }

  /** The launcher hides entirely while the panel is open on mobile (nothing to tap through to —
   * the panel is full-viewport, there is no "outside"). */
  private updateLauncherVisibility(): void {
    const hidden = this.isMobile && this.isOpen;
    setImportant(this.launcherContainer, "display", hidden ? "none" : "flex");
    setImportant(this.launcherButton, "display", hidden ? "none" : "flex");
  }

  private registerViewportListener(): void {
    const mql = window.matchMedia(MOBILE_QUERY);
    mql.addEventListener("change", (event) => {
      this.isMobile = event.matches;
      this.applyPanelGeometry(this.iframeContainer);
      this.applyLauncherOffset(this.launcherContainer);
      this.applyLauncherOffset(this.launcherButton);
      this.updateLauncherVisibility();
      this.postViewport();
    });
  }

  private postViewport(): void {
    this.iframe.contentWindow?.postMessage(
      { source: HOST_MESSAGE_SOURCE, type: "viewport", isMobile: this.isMobile },
      this.baseUrl,
    );
  }

  // --- postMessage handshake -----------------------------------------------------------------

  private handleMessage(event: MessageEvent): void {
    if (this.timedOut) return;
    // Verify origin against the widget's own origin before acting on anything (T-03-04-02).
    if (event.origin !== this.baseUrl) return;
    if (!isWidgetMessage(event.data)) return;
    if (event.data.type === "ready") {
      this.handleReady(event.data.config);
    } else if (event.data.type === "close") {
      this.close();
    }
  }

  private handleReady(config: WidgetReadyConfig): void {
    if (this.readyTimer !== null) {
      clearTimeout(this.readyTimer);
      this.readyTimer = null;
    }
    setImportant(this.launcherButton, "background", config.accentColor || DEFAULT_ACCENT);
    if (config.title) {
      this.iframe.title = config.title;
    }
    if (!this.launcherAppended) {
      document.body.appendChild(this.launcherContainer);
      this.launcherAppended = true;
    }
    this.postViewport();
  }

  private handleReadyTimeout(): void {
    this.readyTimer = null;
    this.timedOut = true;
    // Naming both possible causes is deliberate: attributing a CSP block to the allowlist (or
    // vice versa) would misdiagnose it (S-6).
    log(
      "this domain is not on the allowlist for this knowledge base, or this page's Content-Security-Policy blocked the widget frame",
    );
    this.iframeContainer.remove();
  }

  // --- open/close state machine ---------------------------------------------------------------

  public open(): void {
    if (this.isOpen) return;
    this.isOpen = true;
    this.launcherButton.setAttribute("aria-label", "Close chat");
    this.launcherButton.innerHTML = ICON_CLOSE;
    setImportant(this.iframeContainer, "display", "flex");
    this.updateLauncherVisibility();
    this.iframe.contentWindow?.postMessage(
      { source: HOST_MESSAGE_SOURCE, type: "open" },
      this.baseUrl,
    );
  }

  public close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.launcherButton.setAttribute("aria-label", "Open chat");
    this.launcherButton.innerHTML = ICON_MESSAGE;
    setImportant(this.iframeContainer, "display", "none");
    this.updateLauncherVisibility();
  }

  public toggle(): void {
    if (this.isOpen) {
      this.close();
    } else {
      this.open();
    }
  }
}

// --- bootstrap ---------------------------------------------------------------------------------

(function bootstrap(): void {
  try {
    // Captured synchronously here, before any async work — document.currentScript is null once
    // execution yields past this point.
    const scriptEl = document.currentScript as HTMLScriptElement | null;
    if (!scriptEl?.src) {
      log("could not determine its own origin — the script tag must have a src");
      return;
    }
    const scriptUrl = new URL(scriptEl.src);
    const baseUrl = `${scriptUrl.protocol}//${scriptUrl.host}`;

    const kbId = scriptEl.getAttribute("data-kb-id");
    if (!kbId) {
      log("missing required data-kb-id attribute");
      return;
    }

    let position: Position = "bottom-right";
    const rawPosition = scriptEl.getAttribute("data-position");
    if (rawPosition !== null) {
      if (rawPosition === "bottom-right" || rawPosition === "bottom-left") {
        position = rawPosition;
      } else {
        log(`invalid data-position "${rawPosition}" -- falling back to "bottom-right"`);
      }
    }

    new WidgetInstance(baseUrl, kbId, position);
  } catch (err) {
    log("initialization failed", err);
  }
})();
