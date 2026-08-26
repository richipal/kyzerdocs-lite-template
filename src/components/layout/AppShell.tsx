"use client";

/**
 * Persistent product shell — the 232px dark sidebar + content grid from the developer's design
 * template ("KyzerDocs Lite" design canvas). Both screens (Documents, Chat) render inside this,
 * matching the template's `grid-template-columns: 232px 1fr` structure exactly.
 *
 * Presentation only: no routing/auth change. `Documents`/`Chat`/`Widget` are real links to screens
 * that exist; `Settings` renders disabled (not built — see PROJECT.md's tier table) rather than
 * linking anywhere, per the "never fake a surface that isn't real" rule.
 *
 * Sidebar stats (`Documents`, `Chunks indexed`) are read from the same `GET /api/documents` every
 * document screen already calls — no new endpoint, no fabricated numbers. The template's quota
 * progress bar assumed a per-tier document limit; this build has no quota/tier-limit concept, so
 * rather than invent a fraction to animate a bar with, the count renders as a plain number.
 *
 * ADMIN-04 branding (plan 03-09): the sidebar brand block reads the SAME `WidgetConfig` the widget
 * itself reads — `GET /api/widget/config`, the admin-guarded route that calls `getWidgetConfig`
 * directly (no second, divergent config-reading implementation; this component cannot call
 * `getWidgetConfig` itself, since it is a `node:sqlite`/Postgres-backed server-only function and
 * this is a client component — the HTTP round trip through the already-admin-gated route IS the one
 * config read, mirroring how this same component already fetches `/api/documents` for its stats
 * rather than calling the storage driver directly). `productName`/`logoUrl` fall back to this
 * shell's own shipped defaults ("KyzerDocs Lite"/monogram "K") while loading or on a failed fetch —
 * real defaults, not fabricated ones. The accent override is scoped to the sidebar's own logo badge
 * only (not the whole app), a deliberate, narrower choice than a global `--color-accent` override —
 * see 03-09-SUMMARY.md's Decisions Made for the reasoning.
 *
 * Surface 4 (cloud-mode sidebar meta): `GET /api/health`'s authenticated `driver` field carries a
 * real, config-derived label — never a hardcoded "Postgres" literal in this component.
 */

import { useEffect, useState } from "react";

interface ApiDocument {
  status: string;
  chunkCount: number;
}

interface BrandConfig {
  productName: string;
  logoUrl: string | null;
  accentColor: string;
}

interface DriverInfo {
  cloudMode: boolean;
  label: string;
}

export type ActiveScreen = "documents" | "chat" | "widget";

// Rendered below through the `item.href ? <a href={item.href}> : <button disabled>` branch — the
// Widget entry (plan 03-09) now resolves the same way Documents/Chat already do, producing a real
// anchor tag `<a href="/widget">` once mapped, no longer the disabled-button branch.
const NAV_ITEMS: Array<{ key: ActiveScreen | "settings"; label: string; href?: string; title?: string }> = [
  { key: "documents", label: "Documents", href: "/documents" },
  { key: "chat", label: "Chat", href: "/ask" },
  { key: "widget", label: "Widget", href: "/widget" },
  { key: "settings", label: "Settings", title: "Settings are not available in this build yet." },
];

export function AppShell({ active, children }: { active: ActiveScreen; children: React.ReactNode }) {
  const [docCount, setDocCount] = useState<number | null>(null);
  const [chunkCount, setChunkCount] = useState<number | null>(null);
  const [brand, setBrand] = useState<BrandConfig | null>(null);
  const [driver, setDriver] = useState<DriverInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/documents", { method: "GET" })
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { documents: ApiDocument[] } | null) => {
        if (cancelled || !body) return;
        setDocCount(body.documents.length);
        setChunkCount(body.documents.reduce((sum, d) => sum + (d.chunkCount || 0), 0));
      })
      .catch(() => {
        // Sidebar stats are a nice-to-have readout, not load-bearing — a failed fetch just leaves
        // the counts blank rather than surfacing an error state in the nav.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/widget/config", { method: "GET" })
      .then((res) => (res.ok ? res.json() : null))
      .then((body: BrandConfig | null) => {
        if (cancelled || !body) return;
        setBrand(body);
      })
      .catch(() => {
        // Branding is a readout of the buyer's own settings — a failed fetch leaves the shell on
        // its shipped defaults (below) rather than surfacing an error in the nav chrome.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/health", { method: "GET" })
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { driver?: DriverInfo } | null) => {
        if (cancelled || !body?.driver) return;
        setDriver(body.driver);
      })
      .catch(() => {
        // Local mode's meta line needs no fetched data at all; a failed fetch here just means the
        // cloud-mode line never appears, which matches "unchanged" local-mode behaviour.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const productName = brand?.productName ?? "KyzerDocs Lite";
  const logoInitial = (brand?.productName ?? "KyzerDocs Lite").charAt(0).toUpperCase() || "K";

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar__brand">
          {brand?.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- the buyer's own uploaded logo
            // (a data URL), not an optimizable local asset.
            <img src={brand.logoUrl} alt="" className="sidebar__logo sidebar__logo--image" />
          ) : (
            <div
              className="sidebar__logo"
              aria-hidden="true"
              style={brand?.accentColor ? { background: brand.accentColor } : undefined}
            >
              {logoInitial}
            </div>
          )}
          <div>
            <div className="sidebar__brand-name" data-testid="sidebar-brand-name">
              {productName}
            </div>
            <div className="sidebar__tier">Private package</div>
          </div>
        </div>

        <nav className="sidebar__nav" aria-label="Main">
          {NAV_ITEMS.map((item) =>
            item.href ? (
              <a
                key={item.key}
                href={item.href}
                className={`sidebar__nav-item${active === item.key ? " is-active" : ""}`}
              >
                {item.label}
              </a>
            ) : (
              <button
                key={item.key}
                type="button"
                className="sidebar__nav-item is-disabled"
                disabled
                title={item.title}
              >
                {item.label}
              </button>
            ),
          )}
        </nav>

        <div className="sidebar__footer">
          <div className="sidebar__stats">
            <div className="sidebar__stat-row">
              <span>Documents</span>
              <span className="sidebar__stat-value">{docCount ?? "—"}</span>
            </div>
            <div className="sidebar__stat-row">
              <span>Chunks indexed</span>
              <span className="sidebar__stat-value">{chunkCount ?? "—"}</span>
            </div>
          </div>
          <div className="sidebar__meta" data-testid="sidebar-meta">
            {driver?.cloudMode ? `${driver.label} · cloud` : "SQLite · local folder"}
            <br />
            gemini-embedding-001 · 768d
          </div>
        </div>
      </aside>

      <main className="app-main">{children}</main>
    </div>
  );
}

export default AppShell;
