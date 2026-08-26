import { cookies } from "next/headers.js";
import { redirect } from "next/navigation.js";
import type { ReactNode } from "react";
import { AppError } from "../../lib/errors.js";
import { COOKIE_NAME, requireAdmin } from "../../lib/auth/session.js";

/**
 * `(admin)` route-group layout — T-02-08-02's defence in depth. `src/proxy.ts` only redirects
 * page NAVIGATION and only checks cookie presence; it never decrypts the session and does nothing
 * for a request that somehow reaches the React tree without going through the proxy matcher. This
 * layout calls the real `requireAdmin()` gate itself so the server component tree refuses to
 * render at all without a valid session — matching the same guard every protected API route
 * already runs as its first statement.
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get(COOKIE_NAME);

  // requireAdmin() reads a `Request`'s Cookie header (it is shared code with the API routes,
  // which have a real Request to hand it) — a server component only has `cookies()`, so a minimal
  // Request carrying just that header is built here, the same shape iron-session itself expects.
  const req = new Request("http://localhost/", {
    headers: sessionCookie ? { cookie: `${COOKIE_NAME}=${sessionCookie.value}` } : {},
  });

  try {
    await requireAdmin(req);
  } catch (err) {
    if (err instanceof AppError) {
      redirect("/login");
    }
    throw err;
  }

  return <>{children}</>;
}
