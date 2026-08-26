#!/usr/bin/env node
/**
 * DELIV-01/DELIV-02 entry point — the one command a buyer runs.
 *
 * Sequence: check the Node floor, resolve a data directory rooted at the buyer's own working
 * directory (never this package's install location, and never npx's per-invocation cache —
 * RESEARCH.md Pitfall 2), run first-run setup if no `.env.local` exists yet, validate
 * `GEMINI_API_KEY` with one live call before anything else can happen, then fork the prebuilt
 * standalone server.
 *
 * D2-09c/D2-09d: this file must never prompt for, mention, hint at, or write a placeholder for
 * the optional secondary chat-provider key. The product is fully functional on `GEMINI_API_KEY`
 * alone; a buyer who wants the override adds the line to `.env.local` themselves, without this
 * CLI ever having raised the concept. `scripts/pack-smoke-test.mjs` greps this file to enforce it.
 */

import { fork } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const GEMINI_KEY_SIGNUP_URL = "https://aistudio.google.com/apikey";
const VALIDATION_MODEL = "gemini-embedding-001";
const VALIDATION_DIMENSIONS = 768;

function checkNodeVersion() {
  // Test-only override: process.versions.node cannot be spoofed from outside the process, so
  // scripts/pack-smoke-test.mjs sets this env var to exercise the below-floor path deterministically.
  const nodeVersion = process.env.KDL_TEST_NODE_VERSION_OVERRIDE ?? process.versions.node;
  const [majorStr, minorStr] = nodeVersion.split(".");
  const major = Number(majorStr);
  const minor = Number(minorStr);
  const meetsFloor = major > 22 || (major === 22 && minor >= 5);
  if (!meetsFloor) {
    console.error(
      `kyzerdocs-lite requires Node.js >=22.5 (you have ${nodeVersion}). ` +
        "Install a newer Node.js version from https://nodejs.org and try again.",
    );
    process.exit(1);
  }
}

function parseEnvFile(contents) {
  const values = {};
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    if (key) values[key] = value;
  }
  return values;
}

/** Loads `.env.local` from the buyer's cwd into `process.env`, without ever overwriting a value
 * already present in the real environment (matches the project's existing `--env-file-if-exists`
 * convention: real env wins over the file). */
function loadEnvLocal(envPath) {
  if (!existsSync(envPath)) return;
  const parsed = parseEnvFile(readFileSync(envPath, "utf8"));
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

/**
 * First run: prompts for exactly two values (GEMINI_API_KEY, ADMIN_PASSWORD) and writes them to
 * `.env.local` in the buyer's cwd with mode 0600. Never asks about, mentions, or writes anything
 * related to the optional secondary chat-provider key — the product's default path never
 * encounters that concept.
 *
 * Deliberately nested callbacks, not two separately-`await`ed `question()` calls (whether via
 * `node:readline/promises` or a hand-rolled promise wrapper around the classic API). Against a
 * piped, non-TTY stdin — exactly how `scripts/pack-smoke-test.mjs` drives this file — inserting an
 * `await`'s microtask tick between the two prompts let the input stream's `close` event (which
 * fires once the pipe's writer finishes, immediately after both lines are buffered) win the race
 * against the second `question()` call attaching its listener: the second prompt printed, but its
 * already-buffered answer was silently dropped and the process exited 0 with no error. Chaining
 * the second `question()` synchronously inside the first's callback — as this function does —
 * consumes the already-buffered second line in the same synchronous turn the first answer arrives
 * in, before `close` gets a chance to fire. Confirmed by direct comparison against both async
 * variants before this file was written this way; do not "simplify" this back to `await`. */
function runFirstRunSetup(envPath) {
  return new Promise((resolve, reject) => {
    if (existsSync(envPath)) {
      resolve();
      return;
    }

    console.log("Welcome to kyzerdocs-lite. Let's get you set up — this only happens once.\n");
    console.log(`Get a free Gemini API key at ${GEMINI_KEY_SIGNUP_URL}\n`);

    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    rl.question("Paste your Gemini API key: ", (rawGeminiKey) => {
      rl.question("Choose an admin password: ", (rawAdminPassword) => {
        rl.close();
        try {
          const geminiKey = rawGeminiKey.trim();
          const adminPassword = rawAdminPassword.trim();
          const contents = `GEMINI_API_KEY=${geminiKey}\nADMIN_PASSWORD=${adminPassword}\n`;
          writeFileSync(envPath, contents, { mode: 0o600 });
          chmodSync(envPath, 0o600);
          process.env.GEMINI_API_KEY = geminiKey;
          process.env.ADMIN_PASSWORD = adminPassword;
          resolve();
        } catch (err) {
          reject(err);
        }
      });
    });
  });
}

/**
 * One cheap embedding call proves the key works before the buyer can waste time on a failing
 * upload (DELIV-02, PITFALLS.md #15). `KDL_TEST_STUB_VALIDATION` lets
 * `scripts/pack-smoke-test.mjs` exercise both the accept and reject paths deterministically,
 * without a live network call or a real key.
 */
async function validateGeminiKey(apiKey) {
  const stub = process.env.KDL_TEST_STUB_VALIDATION;
  if (stub === "valid") return true;
  if (stub === "invalid") return false;

  const { GoogleGenAI } = await import("@google/genai");
  const client = new GoogleGenAI({ apiKey });
  try {
    await client.models.embedContent({
      model: VALIDATION_MODEL,
      contents: "kyzerdocs-lite setup validation",
      config: { outputDimensionality: VALIDATION_DIMENSIONS },
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Finds a port that is actually free, starting from `start`.
 *
 * The CLI previously took `PORT ?? 3000`, forked the server, and immediately printed
 * "kyzerdocs-lite is running at http://localhost:3000" — before anything had bound. If the port was
 * occupied (a buyer running any other dev server, which is common on 3000) the child died on
 * EADDRINUSE while the buyer had already been told it was running, and was left staring at either a
 * dead URL or somebody else's app.
 *
 * A non-technical buyer should not have to know what a port is, so rather than failing we move to
 * the next free one and say which. An explicit PORT is respected: if the buyer asked for a specific
 * port and it is taken, that is a real error and we say so rather than silently using a different
 * one.
 */
async function findFreePort(start, { explicit }) {
  const net = await import("node:net");
  const tryPort = (port) =>
    new Promise((resolve) => {
      const server = net.createServer();
      server.once("error", () => resolve(false));
      server.once("listening", () => server.close(() => resolve(true)));
      server.listen(port, "0.0.0.0");
    });

  if (await tryPort(start)) return start;

  if (explicit) {
    console.error(
      `\nPort ${start} is already in use, and you asked for it specifically via PORT.\n` +
        `Free that port, or run again without PORT set and one will be chosen for you.`,
    );
    process.exit(1);
  }

  for (let port = start + 1; port <= start + 40; port++) {
    if (await tryPort(port)) {
      console.log(`Port ${start} was busy — using ${port} instead.`);
      return port;
    }
  }
  console.error(`\nCould not find a free port between ${start} and ${start + 40}.`);
  process.exit(1);
}

async function main() {
  checkNodeVersion();

  const pkgRoot = dirname(fileURLToPath(import.meta.url));
  const serverPath = join(pkgRoot, ".next", "standalone", "server.js");

  // The buyer's own working directory — the folder they typed `kyzerdocs-lite` from — never this
  // package's install location. Persistence must follow process.cwd(), not wherever npm/npx
  // happened to install this package, or a buyer's knowledge base could silently live inside a
  // throwaway cache directory that npm housekeeping is free to clear.
  const buyerCwd = process.cwd();
  const dataDir = join(buyerCwd, "data");
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

  const envPath = join(buyerCwd, ".env.local");
  await runFirstRunSetup(envPath);
  loadEnvLocal(envPath);

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error(
      "KDL-CFG-001: GEMINI_API_KEY is not set. Add it to .env.local — get one at " +
        `${GEMINI_KEY_SIGNUP_URL} — then try again.`,
    );
    process.exit(1);
  }

  console.log("Validating your Gemini API key...");
  const isValid = await validateGeminiKey(apiKey);
  if (!isValid) {
    console.error(
      "KDL-CFG-003: The configured API key was rejected by the provider. " +
        "Check that GEMINI_API_KEY is correct and has not been revoked, then try again.",
    );
    process.exit(1);
  }
  console.log("Key validated.\n");

  const requestedPort = Number(process.env.PORT ?? "3000");
  const port = String(await findFreePort(requestedPort, { explicit: process.env.PORT != null }));
  const child = fork(serverPath, [], {
    cwd: pkgRoot, // server.js resolves its own static/public relative to its own location
    env: {
      ...process.env,
      PORT: port,
      DATABASE_PATH: join(dataDir, "kyzerdocs.db"),
      UPLOAD_DIR: join(dataDir, "uploads"),
    },
  });

  let announced = false;
  child.on("exit", (code) => {
    if (!announced) {
      // Died before we ever claimed success — say that plainly instead of leaving the buyer with a
      // URL that was never going to work.
      console.error(`\nThe server stopped before it finished starting (exit code ${code ?? 0}).`);
    }
    process.exit(code ?? 0);
  });
  process.on("SIGINT", () => child.kill("SIGINT"));
  process.on("SIGTERM", () => child.kill("SIGTERM"));

  // Give the child a moment to fail fast (bad build, unwritable data dir) before telling the buyer
  // it is up. The port itself is already known-free from findFreePort above.
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      announced = true;
      console.log(`\nkyzerdocs-lite is running at http://localhost:${port}`);
      console.log(`If you are running this inside a container, browse to the port you mapped it to.`);
    }
  }, 400);
}

main().catch((err) => {
  console.error(`kyzerdocs-lite failed to start: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
