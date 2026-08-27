/**
 * Next.js 16 proxy — thin, page-navigation-only routing decision (ADMIN-02's convenience half),
 * PLUS, new in Phase 3, the per-KB `frame-ancestors` CSP for the public `/embed/{kbId}` route
 * (WIDG-05, D3-12, RESEARCH.md Pattern 4). It still never decrypts the session cookie, never
 * reads the admin credential, and never performs the real access-control check for admin
 * pages/routes — that check lives in the route guard exported by `src/lib/auth/session.ts`,
 * called explicitly inside every protected API route handler. The matcher deliberately excludes
 * the API route tree (other than `/embed/*`'s own dedicated public route family, which never
 * calls `requireAdmin` and needs no proxy involvement at all — see
 * `src/app/api/embed/[kbId]/chat/route.ts`'s own header comment): a redirect here does nothing
 * for a direct `curl` to an ingestion or config endpoint, so leaving those paths out of the
 * matcher prevents anyone from mistaking this file for that control (T-02-04-03).
 *
 * The `/embed/` branch runs BEFORE the existing cookie-redirect logic and returns early — a
 * public route has no session cookie by design (D3-13), and letting the redirect run would bounce
 * every visitor to `/login` (RESEARCH.md Pitfall 5, the single most consequential line in this
 * file: its absence breaks every widget on every site).
 *
 * Runtime (RESEARCH.md Open Question 3, settled here): `proxy.ts` in Next.js 16 always runs on
 * the Node.js runtime — confirmed directly against this project's installed `next` package
 * (`node_modules/next/dist/build/analysis/get-page-static-info.js`: "Proxy always runs on
 * Node.js runtime"; a `runtime` export here is a build error in production, not merely
 * unsupported/ignored). There is therefore no Edge-runtime constraint on the `getWidgetConfig`
 * lookup below — `node:sqlite` (local mode) and either Neon transport (cloud mode) both work here
 * exactly as they do inside a route handler. The `frame-ancestors` computation stays in this file
 * rather than moving to the `/embed/{kbId}` route segment's own response.
 */

import { NextResponse } from "next/server.js";
import type { NextRequest } from "next/server.js";
import { getWidgetConfig } from "./lib/widget/config.js";

const SESSION_COOKIE_NAME = "kdl_session";

export async function proxy(request: NextRequest): Promise<NextResponse> {
  if (request.nextUrl.pathname.startsWith("/embed/")) {
    const kbId = request.nextUrl.pathname.split("/")[2] ?? "";
    const config = await getWidgetConfig(kbId);
    const response = NextResponse.next();
    // An empty allowlist yields `frame-ancestors 'none'` — the browser refuses to frame the page
    // at all, which is what makes UI-SPEC's "origin blocked: nothing renders" state real. D3-12:
    // this header is a real security boundary (unlike the Origin-header check in the API routes,
    // which is spoofable) — the browser enforces frame-ancestors itself.
    // BOTH the bare host and its `www.` form, for every stored domain.
    //
    // `normalizeDomain` strips a leading `www.`, so the allowlist stores `example.com` and
    // `isOriginAllowed` strips `www.` from the incoming Origin before comparing — meaning the API
    // accepts a request from `https://www.example.com`. CSP `frame-ancestors` performs no such
    // normalisation: the browser treats `https://example.com` and `https://www.example.com` as
    // different origins and refuses to frame anything not listed exactly.
    //
    // Emitting only the stored form made the two mechanisms disagree — the API said yes and the
    // browser said no — so the widget was blocked on every `www.` site with a console error the
    // buyer could do nothing about, while their allowlist looked correct. Most real sites serve on
    // `www.`, so this blocked the common case (03-UAT F13).
    const frameAncestors = config.allowedDomains.flatMap((domain) => [
      `https://${domain}`,
      `https://www.${domain}`,
    ]);
    const directive =
      frameAncestors.length === 0
        ? "frame-ancestors 'none'"
        : `frame-ancestors ${frameAncestors.join(" ")}`;
    response.headers.set("Content-Security-Policy", directive);
    return response;
  }

  const hasSessionCookie = request.cookies.has(SESSION_COOKIE_NAME);
  if (!hasSessionCookie) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", request.nextUrl.pathname);
    return NextResponse.redirect(loginUrl);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/", "/documents/:path*", "/ask/:path*", "/widget/:path*", "/embed/:path*"],
};
