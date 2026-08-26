#!/usr/bin/env tsx
/**
 * DELIV-06 / RESEARCH.md Assumption A2 / Open Question 1 (plan 03-07, Task 2). Settles, by
 * running it, whether `@vercel/blob`'s `put()` can write a ~60MB buffer that was NEVER received
 * as an HTTP request body — the shape a future vector-index snapshot write would take.
 *
 * Generates a ~60MB `Buffer` in memory (never touching an HTTP request), tries `put()` plain
 * first, retries with `multipart: true` on failure, reads the object back via `get(pathname,
 * { access: "private" })` (the store is PRIVATE — verified live by the orchestrator; `get()`
 * returns `{ stream, headers, blob }`, not a public URL — RESEARCH.md's "Live cloud verification"
 * section, and a plain `fetch()` of a private object's URL would 403), hashes both ends
 * (SHA-256, not just byte length), and reports one of three verdicts appended to
 * `03-COLDSTART.md` under "Blob snapshot feasibility": `put() WORKS`, `put() WORKS ONLY WITH
 * multipart`, or `put() FAILS` (with the platform's own quoted error).
 *
 * Deletes the spike object afterward in every case (including a thrown assertion) and confirms
 * with `list()` that nothing was left behind — never writes cloud credentials into
 * `process.env` (`readCloudTestEnv()` only, per `test-cloud-env.ts`'s header).
 *
 * Run: npx tsx --env-file-if-exists=.env.local scripts/blob-put-spike.mts
 */

import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { del, get, list, put } from "@vercel/blob";
import { readCloudTestEnv } from "../src/lib/storage/test-cloud-env.js";

const SPIKE_SIZE_BYTES = 60 * 1024 * 1024; // ~60MB — matches the ~61.4MB 20k-chunk snapshot size.
const COLDSTART_DOC = ".planning/phases/03-cloud-delivery-public-widget-business-tier/03-COLDSTART.md";
const PATHNAME = `coldstart-blob-spike/${Date.now()}-${Math.random().toString(36).slice(2)}.bin`;

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

async function readStreamToBuffer(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

interface Verdict {
  outcome: "WORKS" | "WORKS_ONLY_WITH_MULTIPART" | "FAILS";
  writeMs?: number;
  readMs?: number;
  usedMultipart: boolean;
  hashMatch?: boolean;
  errorMessage?: string;
}

async function main(): Promise<void> {
  const token = readCloudTestEnv("BLOB_READ_WRITE_TOKEN");
  if (!token) {
    console.error("FATAL: BLOB_READ_WRITE_TOKEN not found (process.env or .env.local). Cannot spike against Blob.");
    process.exit(1);
  }

  console.log(`Generating a ${round(SPIKE_SIZE_BYTES / (1024 * 1024))}MB in-memory buffer (never an HTTP request body)...`);
  // crypto.getRandomValues has a per-call cap far below 60MB on some platforms; build the buffer
  // from repeated smaller random chunks instead of one giant randomBytes call.
  const CHUNK = 1024 * 1024;
  const parts: Buffer[] = [];
  let remaining = SPIKE_SIZE_BYTES;
  const { randomBytes } = await import("node:crypto");
  while (remaining > 0) {
    const size = Math.min(CHUNK, remaining);
    parts.push(randomBytes(size));
    remaining -= size;
  }
  const inputBuffer = Buffer.concat(parts);
  const inputHash = sha256(inputBuffer);
  console.log(`Buffer generated: ${inputBuffer.byteLength} bytes, sha256=${inputHash}`);

  let verdict: Verdict = { outcome: "FAILS", usedMultipart: false };
  let putUrl: string | undefined;

  try {
    // Try the plain call first.
    console.log("Attempting put() WITHOUT multipart...");
    let writeStart = performance.now();
    let usedMultipart = false;
    let putResult;
    try {
      putResult = await put(PATHNAME, inputBuffer, {
        access: "private",
        token,
        contentType: "application/octet-stream",
        addRandomSuffix: false,
      });
    } catch (plainErr) {
      console.log(`Plain put() failed (${String(plainErr)}); retrying WITH multipart: true...`);
      writeStart = performance.now();
      usedMultipart = true;
      putResult = await put(PATHNAME, inputBuffer, {
        access: "private",
        token,
        contentType: "application/octet-stream",
        addRandomSuffix: false,
        multipart: true,
      });
    }
    const writeMs = performance.now() - writeStart;
    putUrl = putResult.url;
    console.log(`put() succeeded (multipart=${usedMultipart}) in ${round(writeMs)}ms. url=${putResult.url}`);

    // Read it back — the store is PRIVATE (orchestrator's live verification), so this uses
    // get(pathname, { access: "private" }), which returns a stream, NOT a durable public URL. A
    // plain fetch() of putResult.url would 403 against a private store.
    console.log("Reading the object back via get({ access: 'private' })...");
    const readStart = performance.now();
    const got = await get(PATHNAME, { access: "private", token, useCache: false });
    if (!got || got.statusCode !== 200 || !got.stream) {
      throw new Error(`get() did not return a readable stream (statusCode=${got?.statusCode})`);
    }
    const outputBuffer = await readStreamToBuffer(got.stream);
    const readMs = performance.now() - readStart;
    const outputHash = sha256(outputBuffer);
    const hashMatch = outputHash === inputHash && outputBuffer.byteLength === inputBuffer.byteLength;
    console.log(
      `get() returned ${outputBuffer.byteLength} bytes in ${round(readMs)}ms, sha256=${outputHash}, match=${hashMatch}`,
    );

    verdict = {
      outcome: usedMultipart ? "WORKS_ONLY_WITH_MULTIPART" : "WORKS",
      writeMs: round(writeMs),
      readMs: round(readMs),
      usedMultipart,
      hashMatch,
    };
  } catch (err) {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.error(`put()/get() spike FAILED: ${message}`);
    verdict = { outcome: "FAILS", usedMultipart: false, errorMessage: message };
  } finally {
    // Delete the spike object in every case, including a thrown assertion above.
    try {
      await del(PATHNAME, { token });
      console.log(`Deleted spike object at pathname="${PATHNAME}".`);
    } catch (delErr) {
      console.warn(`Non-fatal: could not delete the spike object: ${String(delErr)}`);
    }
  }

  // Confirm nothing was left behind.
  const remaining_ = await list({ token, prefix: "coldstart-blob-spike/" });
  const leftBehind = remaining_.blobs.length;
  if (leftBehind > 0) {
    console.warn(`WARNING: ${leftBehind} coldstart-blob-spike/* object(s) still present after cleanup.`);
  } else {
    console.log("Confirmed via list(): no coldstart-blob-spike/* objects remain.");
  }

  const generatedAt = new Date().toISOString();
  let section: string;
  if (verdict.outcome === "FAILS") {
    section = `
## Blob snapshot feasibility (${generatedAt})

**Verdict: put() FAILS**

Attempted to write a ${round(SPIKE_SIZE_BYTES / (1024 * 1024))}MB in-memory buffer (never an HTTP
request body) to the provisioned, PRIVATE Vercel Blob store via \`put(pathname, buffer, { access:
"private" })\`, retrying with \`multipart: true\` on failure. Both attempts failed. The platform's
own error, quoted verbatim (not paraphrased):

\`\`\`
${verdict.errorMessage}
\`\`\`

Per RESEARCH.md's named fallback: no snapshot cache is built on this result. Task 3 keeps the
Postgres fetch as the only rebuild path and documents whichever transport's measured number
(Task 1) becomes the shipped mitigation.
`;
  } else {
    const label = verdict.outcome === "WORKS" ? "put() WORKS" : "put() WORKS ONLY WITH multipart";
    section = `
## Blob snapshot feasibility (${generatedAt})

**Verdict: ${label}**

Wrote a ${round(SPIKE_SIZE_BYTES / (1024 * 1024))}MB in-memory buffer (never an HTTP request body,
generated directly in this script) to the provisioned, PRIVATE Vercel Blob store via
\`put(pathname, buffer, { access: "private"${verdict.usedMultipart ? ", multipart: true" : ""} })\`.
Read it back via \`get(pathname, { access: "private" })\` (the store is PRIVATE — verified live by
the orchestrator; reading returns a stream, never a durable public URL a browser could be handed
directly).

| Metric | Value |
|---|---|
| Write time | ${verdict.writeMs}ms |
| Read time | ${verdict.readMs}ms |
| SHA-256 round-trip match | ${verdict.hashMatch ? "confirmed (input and output hashes are identical)" : "MISMATCH — see Issues"} |
| multipart required | ${verdict.usedMultipart ? "yes" : "no — the plain call succeeded"} |

RESEARCH assumption A2 / Open Question 1 is now closed empirically: an internally-generated buffer
this size CAN be written via \`put()\`${verdict.usedMultipart ? " (with multipart: true)" : " with no special option"} — the 4.5MB Vercel Functions body-size limit does not apply here, because this buffer never crossed an inbound HTTP request body.
`;
  }

  appendFileSync(COLDSTART_DOC, section);
  console.log(`\nAppended Blob snapshot feasibility verdict to ${COLDSTART_DOC}`);
  console.log(`Verdict: ${verdict.outcome}`);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
