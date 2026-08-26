#!/usr/bin/env node
/**
 * scripts/verify-deploy.mjs — a one-command health check for a LIVE deployment (local dev server
 * or a real cloud deployment), in `pack-smoke-test.mjs`'s style: one OK/FAIL/SKIP line per check,
 * non-zero exit if any check fails. This is the tool plan 03-12's fresh-account validation leans
 * on instead of clicking around by hand (DELIV-04's "verify everything automatable" half of the
 * plan; the developer still does the parts a script structurally cannot — see the summary this
 * script prints at the end).
 *
 * Usage:
 *   node scripts/verify-deploy.mjs <base-url> [allowed-origin]
 *
 * `<base-url>` is the only required argument — e.g. `http://localhost:3000` or
 * `https://your-project.vercel.app`. This script reads no environment variable and requires no
 * credential beyond that URL, so it can run against a fresh deployment before anyone has logged
 * in — it is safe to hand to anyone who only has the URL.
 *
 * `[allowed-origin]` is optional and only affects the rate-limit check — see that check's own
 * comment below for exactly why a credential-free run cannot reach the rate limiter on a freshly
 * deployed, not-yet-configured instance.
 *
 * What this script does NOT claim to verify — deliberately, so a green run is never mistaken for
 * DELIV-05 or WIDG-07 being satisfied: a real WordPress page, a real hosted site-builder page, and
 * a real mobile device. Those stay plan 03-12's human checkpoints.
 */

const DEFAULT_KB_ID = "default";
const SANDBOX_VALUE = "allow-scripts allow-same-origin allow-forms";
const Z_INDEX_CEILING = "2147483647";
const FOREIGN_ORIGIN = "https://kdl-verify-deploy-not-on-any-allowlist.example";
const RATE_LIMIT_MAX_ATTEMPTS = 15; // above the largest real bucket capacity (cloud: 10, local: 5)

let failures = 0;

function ok(message) {
  console.log(`  OK: ${message}`);
}

function fail(message) {
  console.error(`  FAIL: ${message}`);
  failures++;
}

function skip(message) {
  console.log(`  SKIP: ${message}`);
}

function check(condition, message) {
  if (condition) ok(message);
  else fail(message);
}

async function safeFetch(url, init) {
  try {
    const res = await fetch(url, init);
    return { res, error: null };
  } catch (error) {
    return { res: null, error };
  }
}

async function safeJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function checkHealth(baseUrl) {
  console.log("\n== GET /api/health ==");
  const { res, error } = await safeFetch(`${baseUrl}/api/health`);
  if (!res) {
    fail(`GET /api/health did not respond (${error?.message ?? "unknown error"})`);
    return;
  }
  const body = await safeJson(res);
  check(res.status === 200, `returns 200 (got ${res.status})`);
  check(body?.database?.ok === true, `database.ok is true (got ${JSON.stringify(body?.database)})`);
  if (body && Object.prototype.hasOwnProperty.call(body, "blob")) {
    check(body.blob?.ok === true, `blob.ok is true — cloud mode detected (got ${JSON.stringify(body.blob)})`);
  } else {
    skip("blob check — field absent (local mode, where Blob storage is not part of the deployment)");
  }
}

async function checkWidgetBundle(baseUrl) {
  console.log("\n== GET /widget.js ==");
  const { res, error } = await safeFetch(`${baseUrl}/widget.js`);
  if (!res) {
    fail(`GET /widget.js did not respond (${error?.message ?? "unknown error"})`);
    return;
  }
  const contentType = res.headers.get("content-type") ?? "";
  const body = await res.text();
  check(res.status === 200, `returns 200 (got ${res.status})`);
  check(/javascript/i.test(contentType), `content-type is JavaScript (got "${contentType}")`);
  check(body.includes(SANDBOX_VALUE), `served bundle contains the sandbox attribute string ("${SANDBOX_VALUE}")`);
  check(body.includes(Z_INDEX_CEILING), `served bundle contains the z-index ceiling (${Z_INDEX_CEILING})`);
}

async function checkEmbedFraming(baseUrl) {
  console.log(`\n== GET /embed/${DEFAULT_KB_ID} ==`);
  const { res, error } = await safeFetch(`${baseUrl}/embed/${DEFAULT_KB_ID}`);
  if (!res) {
    fail(`GET /embed/${DEFAULT_KB_ID} did not respond (${error?.message ?? "unknown error"})`);
    return;
  }
  const csp = res.headers.get("content-security-policy") ?? "";
  check(res.status === 200, `returns 200 (got ${res.status})`);
  check(csp.includes("frame-ancestors"), `Content-Security-Policy header contains frame-ancestors (got "${csp}")`);
}

async function postChat(baseUrl, origin) {
  return safeFetch(`${baseUrl}/api/embed/${DEFAULT_KB_ID}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ messages: [{ role: "user", content: "test question from verify-deploy" }] }),
  });
}

async function checkForeignOrigin(baseUrl) {
  console.log("\n== POST /api/embed/default/chat — a domain definitely not on the allowlist ==");
  const { res, error } = await postChat(baseUrl, FOREIGN_ORIGIN);
  if (!res) {
    fail(`POST /api/embed/${DEFAULT_KB_ID}/chat did not respond (${error?.message ?? "unknown error"})`);
    return false;
  }
  const body = await safeJson(res);
  check(res.status === 403, `returns 403 for a disallowed Origin (got ${res.status})`);
  check(body?.code === "KDL-WIDG-001", `body code is KDL-WIDG-001 (got ${body?.code ?? "none"})`);
  return res.status === 403 && body?.code === "KDL-WIDG-001";
}

/**
 * Rate-limit check (WIDG-06). Best-effort, not unconditional — and here is exactly why, verified
 * directly against `src/app/api/embed/[kbId]/chat/route.ts`: the three guards run in a fixed
 * order — kbId, THEN the origin allowlist, THEN the rate limiter. A request whose Origin is not on
 * the allowlist is rejected at the second guard on EVERY attempt and never reaches the third, no
 * matter how many times it is repeated. A brand-new deployment's allowlist starts empty (nothing
 * is allowed yet, by design — an empty allowlist rejects every origin), so a credential-free run
 * against a fresh deployment has no Origin value available that would ever reach the rate limiter.
 *
 * Pass an origin that the deployment's Widget screen has actually allowlisted as this script's
 * second argument to exercise this check for real; without one, it reports SKIP rather than a
 * false FAIL against a perfectly healthy, simply-not-yet-configured deployment. An allowlisted
 * origin is not a credential — it is a public domain name the buyer chose to expose on purpose.
 */
async function checkRateLimit(baseUrl, allowedOrigin) {
  console.log("\n== Rate limit — repeated requests past the free bucket ==");
  if (!allowedOrigin) {
    skip(
      "no allowed-origin argument given — the origin-allowlist guard runs before the rate limiter, " +
        "so a disallowed origin can never reach it (see this function's header comment). Add a " +
        "domain on the Widget screen, then re-run: node scripts/verify-deploy.mjs <base-url> <https://that-domain>",
    );
    return;
  }
  let last = null;
  let lastError = null;
  for (let attempt = 0; attempt < RATE_LIMIT_MAX_ATTEMPTS; attempt++) {
    const { res, error } = await postChat(baseUrl, allowedOrigin);
    if (!res) {
      lastError = error;
      break;
    }
    last = res;
    // Drain the body so the connection can be reused and this loop does not pile up open streams.
    await res.text().catch(() => undefined);
    if (res.status === 429) break;
  }
  if (!last) {
    fail(`rate-limit check did not respond (${lastError?.message ?? "unknown error"})`);
    return;
  }
  check(
    last.status === 429,
    `repeated requests eventually return 429 (got ${last.status} after up to ${RATE_LIMIT_MAX_ATTEMPTS} attempts)`,
  );
  if (last.status === 429) {
    check(last.headers.has("retry-after"), "429 response includes a Retry-After header");
  }
}

async function checkAdminSeparation(baseUrl) {
  console.log("\n== POST /api/chat (the admin route) — no session ==");
  // The plan text this script implements names a GET request to this route; the route only
  // exports POST (verified directly against src/app/api/chat/route.ts), so a GET here would
  // report Next.js's own generic method-not-allowed response rather than testing anything about
  // this app's own access control. POST with no session cookie is what actually exercises the
  // guard — requireAdmin() is that route's first statement, checked before it ever reads a body.
  const { res, error } = await safeFetch(`${baseUrl}/api/chat`, { method: "POST" });
  if (!res) {
    fail(`POST /api/chat did not respond (${error?.message ?? "unknown error"})`);
    return;
  }
  check(res.status === 401, `returns 401 with no session cookie (got ${res.status})`);
}

function printSummary() {
  console.log("\n== What this script does not check ==");
  console.log("  A human still has to verify, per plan 03-12:");
  console.log("    - the widget actually renders correctly on a real WordPress page");
  console.log("    - the widget actually renders correctly on a real hosted site-builder page");
  console.log("    - the widget actually works on a real phone");
  console.log("  A green run above is not DELIV-05 or WIDG-07 — those three remain human checkpoints.");
}

async function main() {
  const [rawBaseUrl, allowedOrigin] = process.argv.slice(2);
  if (!rawBaseUrl) {
    console.error("Usage: node scripts/verify-deploy.mjs <base-url> [allowed-origin]");
    process.exit(1);
  }
  const baseUrl = rawBaseUrl.replace(/\/+$/, "");

  console.log(`Verifying deployment at ${baseUrl}`);

  await checkHealth(baseUrl);
  await checkWidgetBundle(baseUrl);
  await checkEmbedFraming(baseUrl);
  await checkForeignOrigin(baseUrl);
  await checkRateLimit(baseUrl, allowedOrigin);
  await checkAdminSeparation(baseUrl);

  printSummary();

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
