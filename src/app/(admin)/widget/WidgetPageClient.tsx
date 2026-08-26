"use client";

/**
 * The Widget screen's client-side form (Rule 2 addition, plan 03-09 — not in the plan's own file
 * list, but necessary to satisfy its own action text: page.tsx "establishes the shell and the data
 * flow, loading the config server-side and handing it to the client sections", which requires ONE
 * component owning the shared draft `WidgetConfig` state that Branding/WidgetSettings/
 * AllowedDomains all edit and that WidgetPreview/InstallSnippet both read).
 *
 * `hasBeenConfigured` (Claude's Discretion, recorded in 03-09-SUMMARY.md): Phase 3 has no persisted
 * "has this KB ever been saved" flag — `getWidgetConfig` returns `DEFAULT_WIDGET_CONFIG` for both
 * "never configured" and a hypothetical save that reproduced every default value. This component
 * treats "the server-loaded config differs from the shipped default" as the real, honest signal
 * (computed server-side in page.tsx) — never fabricated — and flips to `true` for the rest of the
 * session the moment a save actually succeeds.
 */

import { useState } from "react";
import type { AppErrorJSON } from "../../../lib/errors.js";
import type { WidgetConfig } from "../../../lib/widget/config.js";
import AllowedDomainsSection from "../../../components/widget/AllowedDomainsSection.js";
import BrandingSection from "../../../components/widget/BrandingSection.js";
import InstallSnippet from "../../../components/widget/InstallSnippet.js";
import WidgetPreview from "../../../components/widget/WidgetPreview.js";
import WidgetSettingsSection from "../../../components/widget/WidgetSettingsSection.js";

interface WidgetPageClientProps {
  kbId: string;
  initialConfig: WidgetConfig;
  initialHasBeenConfigured: boolean;
  deploymentHost: string;
  /** `PRODUCT_CONFIG.cloudMode`, read server-side in page.tsx and passed down as a plain boolean —
   * never imported directly here, since `PRODUCT_CONFIG` carries secrets (e.g. `storage.blobToken`)
   * that must never reach a client bundle. Drives the local-mode banner (UI-SPEC Surface 4). */
  cloudMode: boolean;
}

const GENERIC_SAVE_FAILURE: AppErrorJSON = {
  code: "KDL-WIDG-006",
  message: "The widget configuration could not be saved.",
  action: "Check your connection and try again.",
};

export default function WidgetPageClient({
  kbId,
  initialConfig,
  initialHasBeenConfigured,
  deploymentHost,
  cloudMode,
}: WidgetPageClientProps) {
  const [form, setForm] = useState<WidgetConfig>(initialConfig);
  const [hasBeenConfigured, setHasBeenConfigured] = useState(initialHasBeenConfigured);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<AppErrorJSON | null>(null);

  function patch(fields: Partial<WidgetConfig>) {
    setForm((prev) => ({ ...prev, ...fields }));
  }

  async function handleSave() {
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch("/api/widget/config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(form),
      });
      const body = (await res.json()) as WidgetConfig | AppErrorJSON;
      if (!res.ok) {
        setSaveError(body as AppErrorJSON);
        return;
      }
      setForm(body as WidgetConfig);
      setHasBeenConfigured(true);
    } catch {
      setSaveError(GENERIC_SAVE_FAILURE);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      {!cloudMode ? (
        <p className="widget-page__local-banner" role="status" data-testid="local-mode-banner">
          Publishing a widget requires deploying to a public URL. You can still test it here against localhost.
        </p>
      ) : null}

      <div className="widget-page__save-bar">
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void handleSave()}
          disabled={saving}
          data-testid="save-widget-settings"
        >
          {saving ? "Saving…" : "Save widget settings"}
        </button>
        {saveError ? (
          <p role="alert" className="widget-page__save-error" data-testid="save-error">
            <span data-error-code={saveError.code}>{saveError.code}</span>: {saveError.message} {saveError.action}
          </p>
        ) : null}
      </div>

      <div className="widget-page__body">
        <div className="widget-page__main">
          <BrandingSection
            productName={form.productName}
            logoUrl={form.logoUrl}
            accentColor={form.accentColor}
            onChange={patch}
          />
          <WidgetSettingsSection position={form.position} title={form.title} onChange={patch} />
          <AllowedDomainsSection domains={form.allowedDomains} onChange={(allowedDomains) => patch({ allowedDomains })} />
        </div>

        <div className="widget-page__rail">
          <WidgetPreview kbId={kbId} config={form} />
          <InstallSnippet
            kbId={kbId}
            deploymentHost={deploymentHost}
            position={form.position}
            hasBeenConfigured={hasBeenConfigured}
          />
        </div>
      </div>
    </>
  );
}
