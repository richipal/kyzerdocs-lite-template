#!/usr/bin/env node
/**
 * WIDG-01 — bundles the embeddable widget loader into `public/widget.js`.
 *
 * This runs as the `prebuild` npm script (package.json), not inside `next build` itself, because
 * `public/widget.js` is a build artifact Next.js does not produce on its own, and `output:
 * "standalone"` (next.config.ts) does not copy `public/` — `scripts/build-package.mjs` already
 * compensates for that at packaging time, but only if the file exists *before* that copy step
 * runs. A deployment shipping a stale or missing `public/widget.js` is a silent WIDG-01 failure
 * with no other symptom: the app boots fine, admin UI works fine, and the one thing a buyer
 * pastes into their own site simply doesn't load or serves last week's code.
 *
 * `esbuild` is a devDependency only (see package.json) — it never reaches the buyer's runtime.
 * `scripts/build-package.mjs` builds its shipped dependency allowlist from `dependencies`, so
 * esbuild's native binaries have no path into the packaged tarball.
 */

import { build } from "esbuild";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const ENTRY_POINT = join(REPO_ROOT, "src", "widget-src", "kyzer-lite-widget.ts");
const OUTFILE = join(REPO_ROOT, "public", "widget.js");

const BANNER = `/**
 * KyzerDocs Lite embeddable widget
 *
 * Install snippet:
 *   <script src="{deployment-host}/widget.js" data-kb-id="{kbId}" data-position="{position}" async></script>
 */`;

async function buildWidget() {
  const publicDir = dirname(OUTFILE);
  if (!existsSync(publicDir)) {
    mkdirSync(publicDir, { recursive: true });
  }

  await build({
    entryPoints: [ENTRY_POINT],
    bundle: true,
    minify: true,
    format: "iife",
    globalName: "KyzerDocsLiteWidget",
    target: ["es2020"],
    platform: "browser",
    sourcemap: false,
    outfile: OUTFILE,
    banner: { js: BANNER },
    define: { "process.env.NODE_ENV": '"production"' },
  });

  if (!existsSync(OUTFILE)) {
    throw new Error(`Expected ${OUTFILE} to exist after build, but it does not.`);
  }
  const { size } = statSync(OUTFILE);
  if (size === 0) {
    throw new Error(`${OUTFILE} was created but is empty.`);
  }
  console.log(`[build-widget] ${OUTFILE} (${size} bytes)`);
}

buildWidget().catch((err) => {
  console.error(`[build-widget] FAILED: ${err.message}`);
  process.exit(1);
});
