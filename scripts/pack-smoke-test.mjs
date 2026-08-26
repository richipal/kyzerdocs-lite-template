#!/usr/bin/env node
/**
 * Automated proof of the mechanics DELIV-01/DELIV-02/DELIV-07 depend on — everything that IS
 * machine-decidable. "No compiler on a musl machine" and "setup doesn't feel like it wants a
 * second account" are not; those are the human clean-machine checkpoint (plan 02-11 Task 3).
 *
 * Builds a fresh tarball, installs it into a throwaway global prefix (never touching the real
 * npm global state), then runs the installed binary against real temp directories and real
 * localhost ports to prove:
 *   - persistence follows `process.cwd()`, not the npx cache (RESEARCH.md Pitfall 2)
 *   - a rejected key aborts before the server ever binds a port
 *   - first-run writes exactly `GEMINI_API_KEY` + `ADMIN_PASSWORD` to a 0600 `.env.local`
 *   - the word "OpenRouter" never appears anywhere in first-run output or the written file
 *     (D2-09d) — with `OPENROUTER_API_KEY` stripped from every child's environment throughout
 *   - a Node version below the `engines` floor is rejected with a plain-English message
 *
 * `KDL_TEST_STUB_VALIDATION` and `KDL_TEST_NODE_VERSION_OVERRIDE` are test-only seams read by
 * `bin/cli.js` — see that file's comments. Neither is reachable from any buyer-facing code path.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPackage } from "./build-package.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const CLI_SOURCE_PATH = join(REPO_ROOT, "bin", "cli.js");

const PORT_A = 45471;
const PORT_B = 45472;
const PORT_INVALID = 45473;

let failures = 0;
const cleanupPaths = [];

function check(condition, message) {
  if (condition) {
    console.log(`  PASS: ${message}`);
  } else {
    console.error(`  FAIL: ${message}`);
    failures++;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tmpDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanupPaths.push(dir);
  return dir;
}

/** Base env for every CLI invocation in this test: real process.env plus overrides, with
 * `OPENROUTER_API_KEY` always stripped — the absent-optional-key gate must hold for every run,
 * not just the one nominally testing it. */
function testEnv(overrides) {
  const env = { ...process.env, ...overrides };
  delete env.OPENROUTER_API_KEY;
  return env;
}

function spawnCli(binPath, { cwd, env, stdinLines }) {
  const child = spawn(binPath, [], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => {
    stdout += d.toString();
  });
  child.stderr.on("data", (d) => {
    stderr += d.toString();
  });
  for (const line of stdinLines ?? []) {
    child.stdin.write(`${line}\n`);
  }
  const exited = new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });
  return { child, exited, output: () => ({ stdout, stderr }) };
}

async function waitForHealth(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${port}/api/health`, {
        signal: AbortSignal.timeout(1500),
      });
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await sleep(300);
  }
  return false;
}

async function isPortOpen(port) {
  try {
    await fetch(`http://localhost:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  console.log("== Static grep gates on bin/cli.js ==");
  const cliSource = readFileSync(CLI_SOURCE_PATH, "utf8");
  check(!/openrouter/i.test(cliSource), "bin/cli.js never mentions OpenRouter, in code or comments");
  check(cliSource.includes("process.cwd()"), "bin/cli.js resolves the data dir from process.cwd()");
  check(!cliSource.includes("_npx"), "bin/cli.js does not reference npx's per-invocation cache path");
  check(
    !/require\(['"]open['"]\)|from ["']open["']/.test(cliSource),
    "bin/cli.js has no browser-opening dependency",
  );

  console.log("\n== Building a fresh tarball ==");
  const tarballPath = await buildPackage();
  check(existsSync(tarballPath), "tarball was produced");

  console.log("\n== Installing into a throwaway global prefix ==");
  const installPrefix = tmpDir("kdl-install-");
  const installResult = spawnSync(
    "npm",
    ["install", "-g", "--prefix", installPrefix, tarballPath],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  check(installResult.status === 0, "npm install -g of the tarball exits 0");
  if (installResult.status !== 0) {
    console.error(installResult.stdout?.toString());
    console.error(installResult.stderr?.toString());
  }
  const binPath = join(installPrefix, "bin", "kyzerdocs-lite");
  check(existsSync(binPath), "installed binary exists at <prefix>/bin/kyzerdocs-lite");
  if (!existsSync(binPath)) {
    console.error("Cannot continue without the installed binary.");
    process.exit(1);
  }

  console.log(`\n== Two-directory persistence test + first-run + silence gate (port ${PORT_A}) ==`);
  const dirA = tmpDir("kdl-a-");
  const runA = spawnCli(binPath, {
    cwd: dirA,
    env: testEnv({ PORT: String(PORT_A), KDL_TEST_STUB_VALIDATION: "valid" }),
    stdinLines: ["test-gemini-key-aaa", "test-admin-password-aaa"],
  });
  const upA = await waitForHealth(PORT_A);
  check(upA, `server A becomes reachable on port ${PORT_A}`);
  runA.child.kill("SIGTERM");
  const exitA = await runA.exited;
  const outA = runA.output();

  // A process deliberately terminated by SIGTERM is conventionally reported by the OS/shell as
  // 128+15=143 (or, if Node never installed a handler at all, as code=null/signal='SIGTERM') —
  // neither indicates a crash. cli.js propagates whatever exit status the forked standalone
  // server reports (RESEARCH.md's worked pattern), and Next's own server does exactly this
  // signal-aware 143 on shutdown. The real "absent-optional-key gate" claim is that the run
  // reached a healthy, serving state and only stopped because *we* asked it to — not a specific
  // shell exit code artifact of how it was asked.
  check(
    exitA.code === 0 || exitA.code === 143 || (exitA.code === null && exitA.signal === "SIGTERM"),
    `CLI A terminates cleanly after SIGTERM, not a crash (absent-optional-key gate; got code=${exitA.code} signal=${exitA.signal})`,
  );
  check(
    !/openrouter/i.test(outA.stdout + outA.stderr),
    "run A's captured stdout+stderr contains no case-insensitive 'openrouter' (D2-09d)",
  );

  const envPathA = join(dirA, ".env.local");
  check(existsSync(envPathA), ".env.local was written in buyer cwd A");
  const envContentsA = existsSync(envPathA) ? readFileSync(envPathA, "utf8") : "";
  check(envContentsA.includes("GEMINI_API_KEY=test-gemini-key-aaa"), ".env.local A contains GEMINI_API_KEY");
  check(
    envContentsA.includes("ADMIN_PASSWORD=test-admin-password-aaa"),
    ".env.local A contains ADMIN_PASSWORD",
  );
  check(!/openrouter/i.test(envContentsA), ".env.local A contains no OPENROUTER substring, commented or otherwise");
  if (existsSync(envPathA)) {
    const mode = statSync(envPathA).mode & 0o777;
    check(mode === 0o600, `.env.local A has mode 0600 (got 0${mode.toString(8)})`);
  }

  const dbPathA = join(dirA, "data", "kyzerdocs.db");
  check(existsSync(dbPathA), "data/kyzerdocs.db exists in dir A");

  console.log(`\n== Second directory, independent knowledge base (port ${PORT_B}) ==`);
  const dirB = tmpDir("kdl-b-");
  const runB = spawnCli(binPath, {
    cwd: dirB,
    env: testEnv({ PORT: String(PORT_B), KDL_TEST_STUB_VALIDATION: "valid" }),
    stdinLines: ["test-gemini-key-bbb", "test-admin-password-bbb"],
  });
  const upB = await waitForHealth(PORT_B);
  check(upB, `server B becomes reachable on port ${PORT_B}`);
  runB.child.kill("SIGTERM");
  await runB.exited;

  const dbPathB = join(dirB, "data", "kyzerdocs.db");
  check(existsSync(dbPathB), "data/kyzerdocs.db exists in dir B");

  if (existsSync(dbPathA) && existsSync(dbPathB)) {
    const inoA = statSync(dbPathA).ino;
    const inoB = statSync(dbPathB).ino;
    check(
      dbPathA !== dbPathB && inoA !== inoB,
      "dir A and dir B produced independent database files (different path and inode)",
    );
  }

  console.log(`\n== Invalid-key abort test (port ${PORT_INVALID}) ==`);
  const dirInvalid = tmpDir("kdl-invalid-");
  const runInvalid = spawnCli(binPath, {
    cwd: dirInvalid,
    env: testEnv({ PORT: String(PORT_INVALID), KDL_TEST_STUB_VALIDATION: "invalid" }),
    stdinLines: ["test-invalid-key", "test-admin-password"],
  });
  const exitInvalid = await runInvalid.exited;
  const outInvalid = runInvalid.output();
  check(exitInvalid.code !== 0 && exitInvalid.code !== null, `invalid-key run exits non-zero (got ${exitInvalid.code})`);
  check(
    /KDL-CFG-003/.test(outInvalid.stdout + outInvalid.stderr),
    "invalid-key run prints KDL-CFG-003",
  );
  const invalidPortOpen = await isPortOpen(PORT_INVALID);
  check(!invalidPortOpen, "no server is listening on the invalid-key run's port");

  console.log("\n== Node-version floor test ==");
  const dirFloor = tmpDir("kdl-floor-");
  const runFloor = spawnCli(binPath, {
    cwd: dirFloor,
    env: testEnv({ KDL_TEST_NODE_VERSION_OVERRIDE: "18.0.0" }),
    stdinLines: [],
  });
  const exitFloor = await runFloor.exited;
  const outFloor = runFloor.output();
  check(exitFloor.code !== 0 && exitFloor.code !== null, `Node-floor test exits non-zero (got ${exitFloor.code})`);
  check(/22\.5/.test(outFloor.stdout + outFloor.stderr), "Node-floor test prints the version requirement (22.5)");

  console.log("\n== Cleanup ==");
  for (const dir of cleanupPaths) {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  for (const dir of cleanupPaths) {
    rmSync(dir, { recursive: true, force: true });
  }
  process.exit(1);
});
