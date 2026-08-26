#!/usr/bin/env node
/**
 * DELIV-01/DELIV-07 — produces the tarball a buyer's `npm install -g` / `npx` actually consumes.
 *
 * `next build` and everything else in this script runs in CI/on the developer's machine, never on
 * the buyer's. `output: 'standalone'` (next.config.ts) produces `.next/standalone/server.js` plus
 * a minimal traced `node_modules`, but it deliberately does NOT copy `public/` or `.next/static` —
 * skipping that copy step is the single most common way to ship a build that boots but renders
 * completely unstyled (RESEARCH.md "Pattern: npx packaging").
 *
 * The staged directory under `dist/package/` is what actually gets tarred. Its `package.json` is
 * generated fresh here — not a filtered copy of the repo root's — so there is no path by which
 * `devDependencies`, `evals/` scripts, or anything under `.planning/` can leak into a buyer's
 * install (D2-17: the buyer receives a product, not the development harness).
 */

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const DIST_DIR = join(REPO_ROOT, "dist");
const STAGE_DIR = join(DIST_DIR, "package");

/** Only what `bin/cli.js` itself imports at runtime — the standalone server carries its own
 * traced `node_modules` and never needs anything declared here. */
const RUNTIME_DEPENDENCY_NAMES = ["@google/genai"];

function readRootPackageJson() {
  return JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    stdio: "inherit",
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`Command failed (${result.status}): ${command} ${args.join(" ")}`);
  }
}

function assertExists(path, what) {
  if (!existsSync(path)) {
    throw new Error(`Expected ${what} at ${path} but it does not exist.`);
  }
}

export async function buildPackage() {
  console.log("[build-package] Running next build...");
  run("npm", ["run", "build"]);

  const standaloneDir = join(REPO_ROOT, ".next", "standalone");
  assertExists(join(standaloneDir, "server.js"), "the standalone server entry point");

  console.log("[build-package] Copying public/ and .next/static into the standalone tree...");
  mkdirSync(join(standaloneDir, ".next"), { recursive: true });
  const publicDir = join(REPO_ROOT, "public");
  // This project ships no public/ directory today (no static assets outside .next/static). If
  // one is ever added, standalone output still won't copy it — keep this step, don't remove it.
  if (existsSync(publicDir)) {
    cpSync(publicDir, join(standaloneDir, "public"), { recursive: true });
  } else {
    // npm pack drops empty directories from the tarball — write a placeholder so the standalone
    // tree's public/ directory still round-trips through packing, matching Next's own convention
    // that server.js expects public/ to exist alongside it.
    mkdirSync(join(standaloneDir, "public"), { recursive: true });
    writeFileSync(join(standaloneDir, "public", ".gitkeep"), "");
  }
  cpSync(join(REPO_ROOT, ".next", "static"), join(standaloneDir, ".next", "static"), {
    recursive: true,
  });

  console.log("[build-package] Staging publishable package...");
  rmSync(STAGE_DIR, { recursive: true, force: true });
  mkdirSync(STAGE_DIR, { recursive: true });

  cpSync(standaloneDir, join(STAGE_DIR, ".next", "standalone"), { recursive: true });
  cpSync(join(REPO_ROOT, "bin", "cli.js"), join(STAGE_DIR, "cli.js"));

  const rootPkg = readRootPackageJson();
  const dependencies = {};
  for (const name of RUNTIME_DEPENDENCY_NAMES) {
    const version = rootPkg.dependencies?.[name];
    if (!version) {
      throw new Error(`Runtime dependency ${name} is missing from the root package.json`);
    }
    dependencies[name] = version;
  }

  const stagedPkg = {
    name: rootPkg.name,
    version: rootPkg.version,
    type: "module",
    bin: { [rootPkg.name]: "./cli.js" },
    files: [".next/standalone", "cli.js"],
    engines: { node: ">=22.5" },
    dependencies,
  };
  writeFileSync(join(STAGE_DIR, "package.json"), `${JSON.stringify(stagedPkg, null, 2)}\n`);

  console.log("[build-package] Running npm pack...");
  const packResult = spawnSync(
    "npm",
    ["pack", "--json", "--pack-destination", DIST_DIR],
    { cwd: STAGE_DIR, stdio: ["ignore", "pipe", "inherit"] },
  );
  if (packResult.status !== 0) {
    throw new Error(`npm pack failed (${packResult.status})`);
  }
  const packInfo = JSON.parse(packResult.stdout.toString());
  const tarballName = packInfo[0]?.filename;
  if (!tarballName) {
    throw new Error("npm pack did not report a tarball filename");
  }
  const tarballPath = join(DIST_DIR, tarballName);
  assertExists(tarballPath, "the packed tarball");

  console.log(`[build-package] Tarball ready: ${tarballPath}`);
  return tarballPath;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  buildPackage()
    .then((tarballPath) => {
      console.log(tarballPath);
    })
    .catch((err) => {
      console.error(`[build-package] FAILED: ${err.message}`);
      process.exit(1);
    });
}
