import { headers } from "next/headers.js";
import { AppShell } from "../../../components/layout/AppShell.js";
import { PRODUCT_CONFIG } from "../../../lib/config.js";
import { DEFAULT_KB_ID } from "../../../lib/types.js";
import { DEFAULT_WIDGET_CONFIG, getWidgetConfig } from "../../../lib/widget/config.js";
import WidgetPageClient from "./WidgetPageClient.js";

/**
 * GET /widget — ADMIN-04/WIDG-04/WIDG-05's admin Widget-config screen. Server component: loads the
 * KB's config server-side (`getWidgetConfig`, the same function `/embed/{kbId}` itself calls — no
 * duplicated config-reading logic) and the real deployment host from the incoming request's `Host`
 * header, then hands both to `WidgetPageClient`, which owns the interactive form state.
 *
 * Reuses the exact `.docs__header`/`1fr 340px` shell Documents/Chat already ship (Regime A of the
 * UI-SPEC Spacing Scale — S-4: the template's concrete shipped values win over a fresh scale).
 */
export default async function WidgetPage() {
  const kbId = DEFAULT_KB_ID;
  const config = await getWidgetConfig(kbId);

  // Claude's Discretion (see WidgetPageClient.tsx's header comment): the real, honest signal for
  // "has this KB ever been saved" — Phase 3 persists no dedicated flag, so a config that differs
  // from the shipped default means a real save has happened.
  const hasBeenConfigured = JSON.stringify(config) !== JSON.stringify(DEFAULT_WIDGET_CONFIG);

  const headersList = await headers();
  const host = headersList.get("host") ?? "localhost:3000";
  const protocol = host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https";
  const deploymentHost = `${protocol}://${host}`;

  return (
    <AppShell active="widget">
      <div className="widget-page">
        <header className="docs__header">
          <div>
            <h1>Widget</h1>
            <p className="docs__subtitle">
              Brand it, position it, choose who may embed it, and copy the install snippet for your site.
            </p>
          </div>
        </header>

        <WidgetPageClient
          kbId={kbId}
          initialConfig={config}
          initialHasBeenConfigured={hasBeenConfigured}
          deploymentHost={deploymentHost}
          cloudMode={PRODUCT_CONFIG.cloudMode}
        />
      </div>
    </AppShell>
  );
}
