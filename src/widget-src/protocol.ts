/**
 * The typed, origin-checked postMessage contract shared by the widget loader
 * (`kyzer-lite-widget.ts`, this plan) and the embed page (plan 03-08's
 * `src/app/embed/[kbId]/page.tsx`).
 *
 * This module is dependency-free and DOM-free on purpose: it is bundled into the widget's
 * browser IIFE (via esbuild, plan 03-04 Task 2) AND imported by the embed page's server-rendered
 * React tree, so it must not assume either environment. Both sides MUST verify `event.origin`
 * against the widget's own origin before acting on a message, and MUST ignore any message whose
 * `source` field does not match the expected constant — the type guards below encode exactly
 * that check, so neither side has to re-derive it.
 */

/** Messages carrying this `source` originate from inside the widget iframe. */
export const WIDGET_MESSAGE_SOURCE = "kyzerdocs-lite-widget";

/** Messages carrying this `source` originate from the host page's loader script. */
export const HOST_MESSAGE_SOURCE = "kyzerdocs-lite-host";

/** The widget's own visual configuration, reported once the embed page has resolved it. */
export interface WidgetReadyConfig {
  accentColor: string;
  position: "bottom-right" | "bottom-left";
  title: string;
}

/** Plan 03-09's admin Widget-config screen preview (`WidgetPreview.tsx`): the buyer's unsaved
 * edits, pushed into the real `/embed/{kbId}?preview=1` iframe so "the preview reflects unsaved
 * edits" (a must_have truth of that plan) is a real behaviour, not just a claim. Deliberately a
 * SEPARATE message type from `WidgetReadyConfig` above (not a superset) — the widget bundle's own
 * host->iframe direction never needed this before Phase 3's admin preview existed, and keeping it
 * distinct means a stray message from an actual host page can never accidentally restyle a real,
 * live widget instance (the admin-only field `productName`/`logoUrl` has no other host-side use). */
export interface WidgetPreviewConfig {
  productName: string;
  logoUrl: string | null;
  accentColor: string;
  position: "bottom-right" | "bottom-left";
  title: string;
}

/** iframe -> host. */
export type WidgetToHostMessage =
  | { source: typeof WIDGET_MESSAGE_SOURCE; type: "ready"; config: WidgetReadyConfig }
  | { source: typeof WIDGET_MESSAGE_SOURCE; type: "close" };

/** host -> iframe. */
export type HostToWidgetMessage =
  | { source: typeof HOST_MESSAGE_SOURCE; type: "open" }
  | { source: typeof HOST_MESSAGE_SOURCE; type: "viewport"; isMobile: boolean }
  | { source: typeof HOST_MESSAGE_SOURCE; type: "preview-config"; config: WidgetPreviewConfig };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Narrows an arbitrary `MessageEvent.data` payload to a `WidgetToHostMessage`. Checks both the
 * `source` constant AND the message shape — a message with the right source but a malformed
 * `config` (or an unrecognized `type`) is rejected, not passed through.
 */
export function isWidgetMessage(data: unknown): data is WidgetToHostMessage {
  if (!isRecord(data) || data.source !== WIDGET_MESSAGE_SOURCE) return false;
  if (data.type === "close") return true;
  if (data.type === "ready") {
    const config = data.config;
    return (
      isRecord(config) &&
      typeof config.accentColor === "string" &&
      (config.position === "bottom-right" || config.position === "bottom-left") &&
      typeof config.title === "string"
    );
  }
  return false;
}

/**
 * Narrows an arbitrary `MessageEvent.data` payload to a `HostToWidgetMessage`. Mirrors
 * `isWidgetMessage`'s shape-and-source check for the opposite direction.
 */
export function isHostMessage(data: unknown): data is HostToWidgetMessage {
  if (!isRecord(data) || data.source !== HOST_MESSAGE_SOURCE) return false;
  if (data.type === "open") return true;
  if (data.type === "viewport") return typeof data.isMobile === "boolean";
  if (data.type === "preview-config") {
    const config = data.config;
    return (
      isRecord(config) &&
      typeof config.productName === "string" &&
      (config.logoUrl === null || typeof config.logoUrl === "string") &&
      typeof config.accentColor === "string" &&
      (config.position === "bottom-right" || config.position === "bottom-left") &&
      typeof config.title === "string"
    );
  }
  return false;
}
