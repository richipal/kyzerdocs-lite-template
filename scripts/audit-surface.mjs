#!/usr/bin/env node
/**
 * SUPP-01 / ADMIN-02 / STOR-01 mechanical audit, run via `npm run audit`.
 *
 * Four checks, each exiting the process non-zero on a real violation:
 *
 * (a) Auth coverage — every `src/app/api/**\/route.ts` either calls `requireAdmin` itself or
 *     appears on an explicit, commented allowlist. `src/proxy.ts` redirects page navigation only
 *     (see its own header comment) and is bypassed entirely by a direct API call, so this check
 *     greps the ROUTE FILE ITSELF, never the proxy matcher. The allowlist is code, not convention:
 *     a new unguarded route fails the audit instead of shipping unnoticed.
 *
 * (b) Error-code registration — every `new AppError("KDL-...")` call site in `src/` uses a code
 *     that is a real key of `ERROR_CODES`. The reverse direction (a registered code with no call
 *     site) is reported as a warning only — some codes exist for the CLI (`bin/cli.js`, outside
 *     `src/`) or are reachable only through the health route's redacted/authenticated split.
 *
 * (c) Uncoded user-facing failures — no route handler returns a `Response`/`Response.json` with a
 *     4xx/5xx status whose body lacks a `code` field. Every failure a buyer can hit must carry a
 *     KDL code so a support conversation starts from a known state (PITFALLS.md #11).
 *
 * (d) STOR-01 seam — no `.ts`/`.tsx` file outside `src/lib/storage/` imports `node:sqlite`. This is
 *     the permanent gate against the D3-08 leak (`src/lib/retrieval/fts.ts` used to be the one
 *     exception; it is deleted as of plan 03-02). The allowlist here is a documented *pattern*, not
 *     a path list like check (a): a `*.test.ts` file may import `node:sqlite` type-only
 *     (`import type { DatabaseSync } from "node:sqlite"`) to construct a driver for its own test
 *     fixtures — it never uses `node:sqlite` at runtime. Any non-type-only import, anywhere outside
 *     `src/lib/storage/`, fails the audit. A new entry widening this pattern means the seam was
 *     reopened deliberately — document why right here.
 *
 * (e) Widget credential boundary (D3-13) — no SOURCE file under `src/app/api/embed/` or
 *     `src/app/embed/` contains `requireAdmin`, `ADMIN_PASSWORD`, `GEMINI_API_KEY` or
 *     `OPENROUTER`. This is the D3-13 grep gate applied to the public route tree itself, not just
 *     the widget bundle (plan 03-04 already grep-gates the built `public/widget.js`): the widget
 *     structurally cannot carry an admin session or any provisioning credential, and this check is
 *     what stops a future edit from quietly making that surface carry one. `*.test.ts`/`*.test.tsx`
 *     files are excluded (mirrors check (d)'s test-file allowlist) — a test's own
 *     `process.env.ADMIN_PASSWORD` setup (every `route.test.ts` in this repo needs it, since
 *     `PRODUCT_CONFIG` requires `GEMINI_API_KEY` at module-eval time regardless of which route is
 *     under test) never ships to the widget bundle or reaches a real request.
 *
 * Also generates `docs/ERROR-CODES.md` directly from `ERROR_CODES` — one row per registered code,
 * so the reference can never drift from the registry it documents.
 */

import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const API_ROOT = join(ROOT, "src", "app", "api");
const SRC_ROOT = join(ROOT, "src");
const EVALS_ROOT = join(ROOT, "evals");
const STORAGE_DIR_PREFIX = `src${sep}lib${sep}storage${sep}`;

/**
 * Explicit allowlist of routes that must NOT call `requireAdmin` — every entry is documented with
 * why. This list is the audit's only escape hatch; anything not on it and not calling
 * `requireAdmin` is a failing route.
 */
const AUTH_ALLOWLIST = new Map([
  ["src/app/api/auth/login/route.ts", "the login endpoint itself — nothing to authenticate yet"],
  [
    "src/app/api/health/route.ts",
    "T-02-08-01: deliberately reachable unauthenticated, in redacted form only — a buyer with a misconfigured ADMIN_PASSWORD cannot log in to diagnose it",
  ],
  [
    "src/app/api/embed/[kbId]/chat/route.ts",
    "WIDG-01/05/06, D3-13: the widget's public chat call — genuinely public by design, guarded by kbId validation + origin allowlist + a Postgres/in-memory rate limit instead of an admin session, which the widget structurally cannot carry",
  ],
  [
    "src/app/api/embed/[kbId]/starters/route.ts",
    "WIDG-01/05/06, D3-13: the widget's public starter-questions call — same guard sequence and rationale as the chat route above",
  ],
]);
// Note: /api/auth/logout is NOT on this allowlist — it calls requireAdmin itself (verified below)
// exactly like every other protected route, so an unauthenticated DELETE/POST to it is rejected.

let failures = 0;
const warnings = [];

function walkRouteFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...walkRouteFiles(full));
    } else if (entry === "route.ts") {
      out.push(full);
    }
  }
  return out;
}

/**
 * Strips `/* ... *\/` block comments and `// ...` line comments before any check runs. Without
 * this, a JSDoc line like "`requireAdmin(req)` is the first statement" satisfies the auth-coverage
 * regex even after the real call is deleted — a comment referencing the guard is not the guard.
 * Deliberately crude (no string-literal awareness), which is safe here: this project's route
 * files never construct the literal text `requireAdmin(` or `new AppError(` inside a string.
 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

function walkTsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...walkTsFiles(full));
    } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// (a) Auth coverage
// ---------------------------------------------------------------------------

console.log("(a) Auth coverage");
const routeFiles = walkRouteFiles(API_ROOT);
for (const file of routeFiles) {
  const relPath = relative(ROOT, file);
  const contents = stripComments(readFileSync(file, "utf8"));
  const callsRequireAdmin = /requireAdmin\s*\(/.test(contents);
  const allowlisted = AUTH_ALLOWLIST.has(relPath);

  if (callsRequireAdmin) {
    console.log(`  OK    ${relPath} — calls requireAdmin`);
  } else if (allowlisted) {
    console.log(`  OK    ${relPath} — allowlisted (${AUTH_ALLOWLIST.get(relPath)})`);
  } else {
    console.error(`  FAIL  ${relPath} — no requireAdmin call and not on the allowlist`);
    failures++;
  }
}

// ---------------------------------------------------------------------------
// (b) Error-code registration
// ---------------------------------------------------------------------------

console.log("\n(b) Error-code registration");
const errorsPath = join(SRC_ROOT, "lib", "errors.ts");
const errorsSource = readFileSync(errorsPath, "utf8");
const registryMatch = errorsSource.match(/export const ERROR_CODES = \{([\s\S]*?)\n\} as const;/);
if (!registryMatch) {
  console.error("  FAIL  could not locate ERROR_CODES registry in src/lib/errors.ts");
  process.exit(1);
}
const registeredCodes = new Set(
  [...registryMatch[1].matchAll(/"(KDL-[A-Z0-9-]+)":\s*\{/g)].map((m) => m[1]),
);
console.log(`  Registry has ${registeredCodes.size} codes.`);

const srcFiles = walkTsFiles(SRC_ROOT);
const usedCodes = new Set();
for (const file of srcFiles) {
  if (file === errorsPath) continue; // the registry file itself only defines codes, never throws
  const contents = stripComments(readFileSync(file, "utf8"));
  for (const m of contents.matchAll(/new AppError\(\s*"(KDL-[A-Z0-9-]+)"/g)) {
    const code = m[1];
    usedCodes.add(code);
    if (!registeredCodes.has(code)) {
      console.error(`  FAIL  ${relative(ROOT, file)} throws unregistered code ${code}`);
      failures++;
    }
  }
}
if (failures === 0) {
  console.log("  OK    every new AppError(...) call site uses a registered code");
}

for (const code of registeredCodes) {
  if (!usedCodes.has(code)) {
    warnings.push(`registered code ${code} has no new AppError(...) call site under src/ (may be CLI- or health-route-only)`);
  }
}

// ---------------------------------------------------------------------------
// (c) Uncoded user-facing failures
// ---------------------------------------------------------------------------

console.log("\n(c) Uncoded user-facing failures");
let checkedResponses = 0;
for (const file of routeFiles) {
  const relPath = relative(ROOT, file);
  const contents = stripComments(readFileSync(file, "utf8"));
  // Find every `{ status: <4xx/5xx> }` option object passed to Response.json/new Response and
  // check whether the corresponding body expression is `.toJSON()` (always carries `code`) or an
  // object literal that itself contains a `code` field. This is intentionally a structural check
  // against this route surface's two response shapes (AppError.toJSON() and a small number of
  // literal bodies), not a full JS parser.
  const statusMatches = [...contents.matchAll(/status:\s*(\d{3})/g)];
  for (const m of statusMatches) {
    const status = Number(m[1]);
    if (status < 400) continue;
    checkedResponses++;
    // Look at a window of source around the match for either `.toJSON()` (AppError bodies always
    // carry code/message/action) or a literal `code` key in the same response expression.
    const windowStart = Math.max(0, m.index - 400);
    const window = contents.slice(windowStart, m.index + 20);
    const hasCoded = /\.toJSON\(\)/.test(window) || /\bcode\s*:/.test(window);
    if (!hasCoded) {
      console.error(`  FAIL  ${relPath} — a ${status} response near offset ${m.index} has no visible code field`);
      failures++;
    }
  }
}
console.log(`  Checked ${checkedResponses} 4xx/5xx response site(s) across ${routeFiles.length} route files.`);
if (failures === 0) {
  console.log("  OK    every 4xx/5xx route response carries a code");
}

// ---------------------------------------------------------------------------
// (d) STOR-01 seam — node:sqlite imports outside the storage driver boundary
// ---------------------------------------------------------------------------

console.log("\n(d) node:sqlite import boundary (STOR-01)");

/**
 * Pattern allowlist (not a path allowlist, unlike check (a)): a `*.test.ts` file may import
 * `node:sqlite` ONLY as a type (`import type { ... } from "node:sqlite"`) to construct a
 * `DatabaseSync` for its own test fixtures — it never uses `node:sqlite` at runtime. Any
 * non-type-only import of `node:sqlite`, in any file outside `src/lib/storage/`, is a real
 * STOR-01 violation. Widening this pattern (or adding a path-based entry) means the seam was
 * reopened deliberately — document why here, not just at the call site.
 */
function isAllowlistedSqliteImportLine(relPath, line) {
  return relPath.endsWith(".test.ts") && /^\s*import\s+type\s.*from\s+["']node:sqlite["']/.test(line);
}

const sqliteScanFiles = [...walkTsFiles(SRC_ROOT), ...walkTsFiles(EVALS_ROOT)];
const failuresBeforeD = failures;
let sqliteFilesChecked = 0;
for (const file of sqliteScanFiles) {
  const relPath = relative(ROOT, file);
  if (relPath.startsWith(STORAGE_DIR_PREFIX)) continue; // the one directory allowed to import it

  const rawContents = readFileSync(file, "utf8");
  if (!/node:sqlite/.test(rawContents)) continue; // cheap pre-filter before the comment-stripping pass

  const contents = stripComments(rawContents);
  const importLines = contents.split("\n").filter((line) => /from\s+["']node:sqlite["']/.test(line));
  if (importLines.length === 0) continue; // only a comment mentioned "node:sqlite" — not a real import

  sqliteFilesChecked++;
  for (const line of importLines) {
    if (isAllowlistedSqliteImportLine(relPath, line)) {
      console.log(`  OK    ${relPath} — allowlisted type-only node:sqlite import for test driver construction`);
    } else {
      console.error(`  FAIL  ${relPath} — imports node:sqlite outside src/lib/storage/`);
      failures++;
    }
  }
}
console.log(`  Checked ${sqliteFilesChecked} file(s) referencing node:sqlite outside src/lib/storage/.`);
if (failures === failuresBeforeD) {
  console.log("  OK    no node:sqlite import outside src/lib/storage/ (or the test-driver allowlist)");
}

// ---------------------------------------------------------------------------
// (e) Widget credential boundary (D3-13) — src/app/api/embed/ and src/app/embed/ carry no
//     requireAdmin call, no ADMIN_PASSWORD/GEMINI_API_KEY/OPENROUTER reference
// ---------------------------------------------------------------------------

console.log("\n(e) Widget credential boundary (D3-13)");

const FORBIDDEN_WIDGET_PATTERNS = ["requireAdmin", "ADMIN_PASSWORD", "GEMINI_API_KEY", "OPENROUTER"];
const WIDGET_ROUTE_DIRS = [join(SRC_ROOT, "app", "api", "embed"), join(SRC_ROOT, "app", "embed")];

let widgetFilesChecked = 0;
const failuresBeforeE = failures;
for (const dir of WIDGET_ROUTE_DIRS) {
  let files;
  try {
    files = walkTsFiles(dir);
  } catch (err) {
    if (err && err.code === "ENOENT") continue; // directory doesn't exist yet — nothing to check
    throw err;
  }
  for (const file of files) {
    const relPath = relative(ROOT, file);
    // Mirrors check (d)'s established test-file allowlist pattern: a *.test.ts/*.test.tsx file
    // under this tree legitimately sets process.env.ADMIN_PASSWORD/GEMINI_API_KEY in its own
    // setup (matching every other route.test.ts in this repo — PRODUCT_CONFIG requires
    // GEMINI_API_KEY at module-eval time regardless of which route is under test), but this is
    // Node test-process setup, never shipped to the widget bundle or the browser. The concern
    // this check exists for (D3-13) is production route/component SOURCE carrying a credential
    // path a real request could reach — a test file's own env-var setup is not that.
    if (relPath.endsWith(".test.ts") || relPath.endsWith(".test.tsx")) continue;
    widgetFilesChecked++;
    const contents = stripComments(readFileSync(file, "utf8"));
    for (const pattern of FORBIDDEN_WIDGET_PATTERNS) {
      if (contents.includes(pattern)) {
        console.error(`  FAIL  ${relPath} — contains forbidden reference "${pattern}" (D3-13)`);
        failures++;
      }
    }
  }
}
console.log(`  Checked ${widgetFilesChecked} file(s) under src/app/api/embed/ and src/app/embed/.`);
if (failures === failuresBeforeE) {
  console.log("  OK    no widget-surface file contains requireAdmin/ADMIN_PASSWORD/GEMINI_API_KEY/OPENROUTER");
}

// ---------------------------------------------------------------------------
// Generate docs/ERROR-CODES.md from the registry
// ---------------------------------------------------------------------------

// Between the opening `{` and `message:` a code's entry may carry `//` comment lines (e.g.
// KDL-CFG-004's redefinition note) — skip any number of them, not just whitespace.
const registryEntries = [...registryMatch[1].matchAll(
  /"(KDL-[A-Z0-9-]+)":\s*\{(?:\s*(?:\/\/[^\n]*)?\n)*\s*message:\s*"((?:[^"\\]|\\.)*)",\s*action:\s*"((?:[^"\\]|\\.)*)",?\s*\}/g,
)].map((m) => ({ code: m[1], message: m[2].replace(/\\"/g, '"'), action: m[3].replace(/\\"/g, '"') }));

if (registryEntries.length !== registeredCodes.size) {
  console.error(
    `  FAIL  parsed ${registryEntries.length} full entries but found ${registeredCodes.size} code keys — ` +
      "the doc-generation regex likely doesn't match every entry shape in errors.ts. Fix the generator, not the check.",
  );
  failures++;
} else {
  const rows = registryEntries
    .map((e) => `| ${e.code} | ${e.message} | ${e.action} |`)
    .join("\n");
  const doc = `# Error Code Reference

Every failure kyzerdocs-lite can show you carries one of the codes below. If something goes
wrong, look up the code here first — it tells you what actually happened and what to do next. If
you need to contact support, include the code; it is the fastest way to start from a known state.

This file is generated directly from the app's error registry (\`src/lib/errors.ts\`) and cannot
drift from what the app actually does — do not hand-edit it.

| Code | What it means | What to do |
|---|---|---|
${rows}
`;
  const outPath = join(ROOT, "docs", "ERROR-CODES.md");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, doc);
  console.log(`\nWrote docs/ERROR-CODES.md with ${registryEntries.length} codes.`);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

if (warnings.length > 0) {
  console.log("\nWarnings:");
  for (const w of warnings) console.log(`  - ${w}`);
}

if (failures > 0) {
  console.error(`\naudit-surface: ${failures} failure(s).`);
  process.exit(1);
} else {
  console.log("\naudit-surface: all checks passed.");
  process.exit(0);
}
