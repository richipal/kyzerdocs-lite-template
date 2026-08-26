import { DEFAULT_KB_ID } from "../../../lib/types.js";
import { getWidgetConfig } from "../../../lib/widget/config.js";
import { EmbedChat } from "./EmbedChat.js";

/**
 * GET /embed/{kbId} — WIDG-01/02/03's iframe document (D3-11). Server component: reads the kbId
 * path segment, resolves the KB's branding (ADMIN-04/WIDG-04) via `getWidgetConfig`, and renders
 * the whole panel client-side through `EmbedChat`. No admin shell component, no sidebar, no admin
 * nav — a visitor on a stranger's website has no admin access and nothing here should look like
 * it does. (This file deliberately never imports the admin layout component from
 * `src/components/layout/`.)
 *
 * Fonts: this page is still rendered under the app's single root layout (`src/app/layout.tsx`),
 * which already declares the self-hosted IBM Plex Sans/Mono `@font-face`s on `<html>` for every
 * route in this Next.js app — including this one. Next's App Router only allows the ROOT layout to
 * own `<html>`/`<body>`, so there is no nested layout here to "re-declare" fonts in; the UI-SPEC's
 * instruction to re-declare them applies structurally to a genuinely separate HTML document (which
 * this route is, once fetched into the widget's `<iframe src="/embed/{kbId}">` on a stranger's
 * site) — it is NOT separate from this Next.js app's own single document tree, so the fonts it
 * needs are already present with zero extra code. Framing (`frame-ancestors`) is computed
 * per-request in `src/proxy.ts`, not here — see that file's header comment.
 *
 * Phase 3 is single-KB scope (STOR-05 carried forward): `DEFAULT_KB_ID` is the only knowledge base
 * that can exist yet, so a mismatched `kbId` renders nothing (a stranger is the audience here, not
 * the buyer — an admin-shaped error page is the wrong thing to show them) and logs server-side only.
 */
export default async function EmbedPage({
  params,
}: {
  params: Promise<{ kbId: string }>;
}) {
  const { kbId } = await params;

  if (kbId !== DEFAULT_KB_ID) {
    console.error(`[embed] no knowledge base for kbId="${kbId}"`);
    return null;
  }

  const config = await getWidgetConfig(kbId);

  return <EmbedChat kbId={kbId} config={config} />;
}
