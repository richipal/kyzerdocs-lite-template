/**
 * ADMIN-04 — one config blob per knowledge base, read identically by three consumers: the admin
 * Widget page (plan 03-09), the `/embed/{kbId}` page's SSR render, and the widget loader's own
 * config resolution. Storage is a single JSON blob under the reserved settings key
 * `widget:${kbId}`, read/written through `getStorageDriver()`'s `getSetting`/`setSetting` — never
 * a new table (see 03-PATTERNS.md's Correction block: an earlier draft named a `widget_config`
 * table, which is NOT built).
 *
 * Mirrors `src/app/api/chat/starters/route.ts`'s `CachedStarters` JSON-blob-under-one-key shape
 * and its `STARTERS_KEY_PREFIX` convention — same pattern, different reserved prefix
 * (`widget:` vs `starters:`), so the two can never collide with each other or with RET-02's
 * `__generation__:` prefix (`src/lib/storage/generation-key.ts`).
 *
 * `getWidgetConfig` never throws on a corrupt or unconfigured settings row: a KB that has never
 * been configured returns `DEFAULT_WIDGET_CONFIG` (a complete, schema-valid value, never nulls),
 * and a stored blob that fails `widgetConfigSchema` validation is logged and treated as absent —
 * a corrupt settings row must not take the whole widget offline.
 */

import { z } from "zod";
import { getStorageDriver } from "../storage/index.js";

const WIDGET_CONFIG_KEY_PREFIX = "widget:";

/** Accent colour validation matches UI-SPEC's Color section: a 6-digit hex with a leading `#`. */
const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

export const widgetConfigSchema = z.object({
  /** ADMIN-04. Rendered in the widget panel header (`Ask {productName}`) and the empty-state
   * copy ("Answers are drawn from {productName}'s documents."). */
  productName: z.string().min(1).max(60),
  /** ADMIN-04. `null` renders a monogram fallback — no logo has been uploaded (or none is set). */
  logoUrl: z.string().min(1).nullable(),
  /** ADMIN-04. Contrast against `#FFFFFF` is a save-time warning computed by the admin route
   * (plan 03-09), not enforced here — the buyer owns their brand colour (UI-SPEC: "no silent
   * substitution"). This schema only enforces the hex shape is well-formed. */
  accentColor: z.string().regex(HEX_COLOR_PATTERN),
  /** WIDG-04. */
  position: z.enum(["bottom-right", "bottom-left"]),
  /** WIDG-04. Default is `Ask ${productName}` at config-default time; once set, this schema does
   * not re-derive it from `productName` on every read — a buyer who typed a custom title keeps it
   * even if they later change `productName`. */
  title: z.string().min(1).max(40),
  /** WIDG-05. Bare hosts like `example.com` — never full URLs. Validated by `normalizeDomain`
   * (`./origin.js`) at write time (plan 03-09's admin route), not re-validated on every read here,
   * since a previously-valid stored value must not become unreadable if this schema tightens
   * later. */
  allowedDomains: z.array(z.string().min(1)),
});

export type WidgetConfig = z.infer<typeof widgetConfigSchema>;

/** ADMIN-04/WIDG-04 defaults, matching UI-SPEC's Color section (`#0E4F4A` accent) and Copywriting
 * Contract (`Ask {brandName}` title pattern) exactly — plans 03-08/03-09 read these values, so a
 * drift between this file and UI-SPEC would only surface on a real host page. */
export const DEFAULT_WIDGET_CONFIG: WidgetConfig = {
  productName: "KyzerDocs",
  logoUrl: null,
  accentColor: "#0E4F4A",
  position: "bottom-right",
  title: "Ask KyzerDocs",
  allowedDomains: [],
};

function widgetConfigKey(kbId: string): string {
  return `${WIDGET_CONFIG_KEY_PREFIX}${kbId}`;
}

/** Returns `kbId`'s widget config, merged over `DEFAULT_WIDGET_CONFIG` so an unconfigured KB
 * yields a complete, schema-valid value rather than nulls. A stored blob that fails validation
 * (corrupt JSON, or a shape `widgetConfigSchema` rejects) is logged server-side and treated as
 * absent — never thrown — because a corrupt settings row must not take the whole widget
 * offline. */
export async function getWidgetConfig(kbId: string): Promise<WidgetConfig> {
  const driver = getStorageDriver();
  const raw = await driver.getSetting(widgetConfigKey(kbId));
  if (!raw) {
    return DEFAULT_WIDGET_CONFIG;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (err) {
    console.error(`[widget/config] corrupt JSON for kbId=${kbId}, falling back to defaults:`, err);
    return DEFAULT_WIDGET_CONFIG;
  }

  const merged = { ...DEFAULT_WIDGET_CONFIG, ...(parsedJson as Partial<WidgetConfig>) };
  const result = widgetConfigSchema.safeParse(merged);
  if (!result.success) {
    console.error(
      `[widget/config] stored config for kbId=${kbId} failed schema validation, falling back to defaults:`,
      result.error,
    );
    return DEFAULT_WIDGET_CONFIG;
  }
  return result.data;
}

/** Validates and stores `config` for `kbId` as one JSON blob under the reserved `widget:${kbId}`
 * key. Throws (via `widgetConfigSchema.parse`) on an invalid config — plan 03-09's admin route is
 * the caller responsible for surfacing a validation error to the buyer before this is reached. */
export async function setWidgetConfig(kbId: string, config: WidgetConfig): Promise<void> {
  const validated = widgetConfigSchema.parse(config);
  const driver = getStorageDriver();
  const generation = await driver.getGeneration(kbId);
  await driver.setSetting(widgetConfigKey(kbId), JSON.stringify(validated), generation);
}
