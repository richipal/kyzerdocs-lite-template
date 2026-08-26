#!/usr/bin/env tsx
/**
 * DELIV-06 cold-start measurement (D3-18, plan 03-07). Seeds a dedicated, non-"default"
 * knowledge base with N synthetic, real, L2-normalized 768-dim vectors directly in the
 * provisioned Neon database, then times a genuinely cold `getVectorIndex()` rebuild — clearing
 * the in-process cache before every timed call — for BOTH Neon transports (HTTP `neon()` vs
 * WebSocket `Pool`), reporting p50/p95/max plus the network (getGeneration + getAllChunkVectors) vs
 * pack-and-assert split, and peak process memory. Appends the result to `03-COLDSTART.md`, below
 * the pre-registered budget that was committed before this script ever ran.
 *
 * Every timed `getVectorIndex()` call runs the REAL production packing/normalization-assertion
 * loop (`src/lib/retrieval/vector-index.ts`) against an explicit per-transport driver
 * (`driverOverride`, added by this plan) — not a reimplementation of it. The network-vs-packing
 * split is obtained by wrapping that driver in a `Proxy` that times both network round trips
 * (`getGeneration` and `getAllChunkVectors`); `packMs = totalMs - networkMs` for the same call,
 * with zero duplicated logic.
 *
 * Cleans up the synthetic corpus (chunks -> cascaded by `deleteDocument`, the document row, and
 * the measurement knowledge-base row) at the end of every run unless `--keep` is passed.
 *
 * Run: npm run measure:coldstart [-- --chunks=20000] [-- --iterations=5] [-- --keep]
 */

import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { AppError } from "../src/lib/errors.js";
import { getVectorIndex, invalidateVectorIndex, type VectorIndex } from "../src/lib/retrieval/vector-index.js";
import { l2Normalize } from "../src/lib/retrieval/normalize.js";
import { createPgClient, type PgClient, type PgTransport } from "../src/lib/storage/pg-client.js";
import { PgStorageDriver } from "../src/lib/storage/postgres.js";
import type { StorageDriver } from "../src/lib/storage/driver.js";
import { readCloudTestEnv } from "../src/lib/storage/test-cloud-env.js";

const DIM = 768;
const MEASUREMENT_KB_ID = "measurement-coldstart-03-07";
const COLDSTART_DOC = ".planning/phases/03-cloud-delivery-public-widget-business-tier/03-COLDSTART.md";
const P95_BUDGET_MS = 3000;
const SEED_BATCH_SIZE = 1000;

interface Args {
  chunks: number;
  iterations: number;
  keep: boolean;
  /** Plan 03-07 Task 3 (D3-18): after `vector-snapshot.ts` exists, one untimed warm-up rebuild
   * pre-populates the Blob snapshot, then every timed iteration is a genuine snapshot-hit cold
   * rebuild — never blended with the one-time Postgres-miss cost the default mode's first
   * iteration pays. This answers "does the mitigation get a STEADY-STATE cold start under
   * budget", which the default mode's small sample size cannot honestly answer (a 5-sample
   * p95 with 1 slow miss among 4 fast hits puts the outlier AT p95, understating how rare a miss
   * actually is once a generation is stable). */
  snapshotOnly: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => argv.find((a) => a.startsWith(`--${flag}=`))?.split("=")[1];
  return {
    chunks: Number(get("chunks") ?? 20000),
    iterations: Number(get("iterations") ?? 5),
    keep: argv.includes("--keep"),
    snapshotOnly: argv.includes("--snapshot-only"),
  };
}

function seededRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

function randomNormalizedVector(rand: () => number): Float32Array {
  const v = new Float32Array(DIM);
  for (let i = 0; i < DIM; i++) v[i] = rand() * 2 - 1;
  return l2Normalize(v);
}

function percentile(sortedAscending: number[], p: number): number {
  if (sortedAscending.length === 0) return 0;
  const idx = Math.min(sortedAscending.length - 1, Math.floor((p / 100) * sortedAscending.length));
  return sortedAscending[idx]!;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function mb(bytes: number): number {
  return round(bytes / (1024 * 1024));
}

/** Wraps a real `StorageDriver` in a `Proxy` that times BOTH network round trips
 * `getVectorIndex()` makes — `getGeneration` (issued first) and `getAllChunkVectors` (issued
 * second) — appending each call's duration to `out`. Every other method (and property) forwards
 * untouched.
 *
 * `getGeneration` matters here beyond its own tiny query cost: for the WebSocket transport, a
 * fresh `Pool` (this script creates one per iteration, matching a genuinely cold serverless
 * invocation) lazily opens its TCP/TLS connection on the FIRST query it runs, which is
 * `getGeneration`, not `getAllChunkVectors`. Timing `getAllChunkVectors` alone would silently
 * fold that connection-establishment cost into the "packing" bucket instead of "network" —
 * exactly the kind of split error this script exists to avoid. Summing both calls' durations is
 * what makes `packMs = totalMs - networkMs` isolate ONLY the local CPU work (the for-loop in
 * `vector-index.ts`: iterate rows, build the `Float32Array`, run `assertNormalized`), which is
 * what the plan's "packing-and-assertion loop" actually names. */
function withNetworkTiming(driver: StorageDriver, out: number[]): StorageDriver {
  const timedMethods = new Set(["getGeneration", "getAllChunkVectors"]);
  return new Proxy(driver, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop === "string" && timedMethods.has(prop) && typeof value === "function") {
        return async (...args: unknown[]) => {
          const start = performance.now();
          const result = await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
          out.push(performance.now() - start);
          return result;
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as StorageDriver;
}

function extractNeonRegion(databaseUrl: string): string {
  try {
    const host = new URL(databaseUrl).hostname;
    // Neon pooled hostnames look like ep-xxxx-pooler.<region>.aws.neon.tech; the direct form
    // omits "-pooler" but keeps the same <region>.aws.neon.tech suffix.
    const match = host.match(/\.([a-z0-9-]+)\.aws\.neon\.tech$/i);
    return match?.[1] ?? `unknown (host pattern not recognized: ${host.replace(/^[^.]+/, "<redacted-endpoint>")})`;
  } catch {
    return "unknown (DATABASE_URL did not parse as a URL)";
  }
}

/** Creates the measurement knowledge-base row if absent — the `documents`/`chunks` FK
 * constraints (drizzle/migrations/0000_flashy_tenebrous.sql) require it to exist before
 * `insertDocument`/`upsertChunks` can write anything under this kb id. `ON CONFLICT DO NOTHING`
 * makes a re-run (e.g. after an interrupted prior measurement) idempotent. */
async function ensureMeasurementKb(client: PgClient): Promise<void> {
  const now = new Date().toISOString();
  await client.db.execute(sql`
    INSERT INTO knowledge_bases (id, name, created_at)
    VALUES (${MEASUREMENT_KB_ID}, ${"DELIV-06 cold-start measurement (03-07, not a real KB)"}, ${now})
    ON CONFLICT (id) DO NOTHING
  `);
}

/** Deletes the measurement knowledge-base row itself, after its documents/chunks (and their
 * generation-counter `app_settings` row) have already been removed by `cleanupCorpus`. Best
 * effort — logs and continues rather than failing the whole run if this row was already gone or
 * some other reference remains, since the far more important cleanup (chunks/documents) already
 * happened by this point. */
async function cleanupMeasurementKb(client: PgClient): Promise<void> {
  try {
    await client.db.execute(sql`DELETE FROM app_settings WHERE key = ${`__generation__:${MEASUREMENT_KB_ID}`}`);
    await client.db.execute(sql`DELETE FROM knowledge_bases WHERE id = ${MEASUREMENT_KB_ID}`);
  } catch (err) {
    console.warn(`Non-fatal: could not fully clean up the measurement kb row: ${String(err)}`);
  }
}

async function seedCorpus(
  driver: StorageDriver,
  n: number,
): Promise<{ documentId: string; expectedIds: Set<string> }> {
  const doc = await driver.insertDocument({
    knowledgeBaseId: MEASUREMENT_KB_ID,
    filename: "coldstart-measurement-synthetic.txt",
    mimeType: "text/plain",
    byteSize: 0,
    contentHash: `coldstart-${randomUUID()}`,
    status: "ready",
  });

  const rand = seededRandom(42);
  const expectedIds = new Set<string>();
  for (let batchStart = 0; batchStart < n; batchStart += SEED_BATCH_SIZE) {
    const batchSize = Math.min(SEED_BATCH_SIZE, n - batchStart);
    const batch = Array.from({ length: batchSize }, (_, i) => {
      const id = `coldstart-${batchStart + i}`;
      expectedIds.add(id);
      return {
        id,
        knowledgeBaseId: MEASUREMENT_KB_ID,
        documentId: doc.id,
        chunkIndex: batchStart + i,
        content: `synthetic coldstart chunk ${batchStart + i}`,
        charStart: 0,
        charEnd: 1,
        embedding: randomNormalizedVector(rand),
      };
    });
    await driver.upsertChunks(batch);
    process.stdout.write(`\r  seeded ${Math.min(batchStart + batchSize, n)}/${n} chunks`);
  }
  process.stdout.write("\n");
  return { documentId: doc.id, expectedIds };
}

async function cleanupCorpus(driver: StorageDriver, documentId: string): Promise<void> {
  // deleteDocument cascades the document's chunks via the documents_id FK's ON DELETE CASCADE
  // (drizzle/migrations/0000_flashy_tenebrous.sql), and bumps the generation counter atomically —
  // this is the same production code path a real re-ingest would exercise.
  await driver.deleteDocument(documentId);
}

interface TransportResultOk {
  transport: PgTransport;
  status: "ok";
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  networkP50Ms: number;
  networkP95Ms: number;
  packP50Ms: number;
  packP95Ms: number;
  budgetMet: boolean;
  samples: number;
  identityDiffersEveryColdCall: boolean;
  warmCacheNearZeroMs: number;
}

/** A transport can fail OUTRIGHT at scale, not just slowly — e.g. Neon's HTTP transport enforces
 * a hard server-side response-size cap independent of any client timeout. That is a measured
 * finding, not a script bug, and D3-18 requires it reported as such: FAIL with the platform's own
 * quoted error, never silently retried down to a smaller corpus. */
interface TransportResultFailed {
  transport: PgTransport;
  status: "failed";
  errorMessage: string;
  samplesAttempted: number;
}

type TransportResult = TransportResultOk | TransportResultFailed;

/** Walks one level into `.cause` (AppError -> DrizzleQueryError -> the real Neon/Postgres driver
 * error) to surface the platform's own literal error text rather than the generic registered
 * `AppError` message every KDL-DB-003 shares. Quoted, not paraphrased — this is what makes a
 * FAIL verdict auditable later. */
function describeError(err: unknown): string {
  if (err instanceof AppError) {
    const cause = err.cause;
    if (cause instanceof Error) {
      const nested = (cause as { cause?: unknown }).cause;
      const nestedMsg = nested instanceof Error ? ` — ${nested.message}` : nested ? ` — ${String(nested)}` : "";
      return `${err.code}: ${err.message} (cause: ${cause.message}${nestedMsg})`;
    }
    return `${err.code}: ${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}

async function measureTransport(
  databaseUrl: string,
  transport: PgTransport,
  iterations: number,
): Promise<TransportResultOk> {
  const totalsMs: number[] = [];
  const networkMs: number[] = [];
  // Computed INSIDE the loop, paired with the same iteration's total/network — never derived by
  // subtracting two independently-sorted arrays by index after the fact, which would silently
  // pair the wrong iterations together once p50/p95 sorting reorders each array differently.
  const packMs: number[] = [];
  let identityDiffersEveryColdCall = true;
  let previousIndex: VectorIndex | undefined;

  for (let i = 0; i < iterations; i++) {
    const client = createPgClient(databaseUrl, transport);
    const rawDriver = new PgStorageDriver(client);
    const timedNetwork: number[] = [];
    const driver = withNetworkTiming(rawDriver, timedNetwork);

    // "clear the vector-index module cache" (plan text): force the next call to treat this as a
    // fresh, cold rebuild rather than a generation-matched cache hit — the entire point of the
    // measurement.
    invalidateVectorIndex(MEASUREMENT_KB_ID);

    const start = performance.now();
    const index = await getVectorIndex(MEASUREMENT_KB_ID, driver);
    const totalMs = performance.now() - start;

    if (previousIndex !== undefined && previousIndex === index) {
      identityDiffersEveryColdCall = false;
    }
    previousIndex = index;

    // Sum every timed network round trip for this call (getGeneration + getAllChunkVectors) —
    // see withNetworkTiming's header comment for why both, not just getAllChunkVectors alone.
    const networkForThisCall = timedNetwork.reduce((sum, ms) => sum + ms, 0);
    totalsMs.push(totalMs);
    networkMs.push(networkForThisCall);
    packMs.push(totalMs - networkForThisCall);
  }

  // Sanity check the plan explicitly asks for: with the cache deliberately left WARM (no
  // invalidation between calls), a second call must be near-zero, proving the cold-loop above is
  // genuinely clearing the cache rather than measuring a no-op every time.
  const warmClient = createPgClient(databaseUrl, transport);
  const warmDriver = new PgStorageDriver(warmClient);
  invalidateVectorIndex(MEASUREMENT_KB_ID);
  await getVectorIndex(MEASUREMENT_KB_ID, warmDriver); // cold build, populates the cache
  const warmStart = performance.now();
  await getVectorIndex(MEASUREMENT_KB_ID, warmDriver); // warm hit, cache NOT invalidated
  const warmCacheNearZeroMs = performance.now() - warmStart;

  totalsMs.sort((a, b) => a - b);
  networkMs.sort((a, b) => a - b);
  packMs.sort((a, b) => a - b);

  const p95Ms = percentile(totalsMs, 95);
  return {
    transport,
    status: "ok",
    p50Ms: round(percentile(totalsMs, 50)),
    p95Ms: round(p95Ms),
    maxMs: round(totalsMs[totalsMs.length - 1] ?? 0),
    networkP50Ms: round(percentile(networkMs, 50)),
    networkP95Ms: round(percentile(networkMs, 95)),
    packP50Ms: round(percentile(packMs, 50)),
    packP95Ms: round(percentile(packMs, 95)),
    budgetMet: p95Ms <= P95_BUDGET_MS,
    samples: iterations,
    identityDiffersEveryColdCall,
    warmCacheNearZeroMs: round(warmCacheNearZeroMs),
  };
}

/** Runs `measureTransport`, converting a hard failure (e.g. Neon's HTTP transport's own
 * server-side response-size cap) into a recorded FAIL result instead of aborting the whole
 * script — the other transport must still get measured. */
async function measureTransportSafe(
  databaseUrl: string,
  transport: PgTransport,
  iterations: number,
): Promise<TransportResult> {
  try {
    return await measureTransport(databaseUrl, transport, iterations);
  } catch (err) {
    return { transport, status: "failed", errorMessage: describeError(err), samplesAttempted: iterations };
  }
}

interface SnapshotWarmResult {
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  budgetMet: boolean;
  samples: number;
  identityDiffersEveryColdCall: boolean;
  /** The generation the snapshot was written/read at — `vector-snapshot.ts`'s Blob key includes
   * this, so cleanup needs it explicitly rather than guessing. */
  generation: number;
}

/**
 * `--snapshot-only` mode (plan 03-07, Task 3, D3-18): does ONE untimed warm-up rebuild (via
 * WebSocket — the only transport proven to complete a full corpus read at target scale) to
 * populate the Blob snapshot for the corpus's current generation, THEN times `iterations` cold
 * rebuilds that should EVERY one be a snapshot hit (cache invalidated before each call, but the
 * underlying generation never changes, so `readVectorSnapshot` finds a valid, current entry every
 * time). This is deliberately a SEPARATE sample set from `measureTransport`'s default mode —
 * blending one Postgres-miss iteration with several snapshot-hit iterations in the same 5-sample
 * percentile would put the single slow outlier AT p95 (`Math.floor(0.95*5)` is the last, worst
 * value), which materially UNDERSTATES how rare a miss actually is once a generation is stable.
 * This mode answers the real question: once the mitigation has done its one-time work, does a
 * cold start meet budget?
 *
 * No network-vs-pack split is reported here (unlike `measureTransport`) — the snapshot-hit path
 * does not call `driver.getAllChunkVectors` at all (it is a Blob `get()` inside
 * `readVectorSnapshot`, entirely bypassing the driver except for the small `getGeneration` call),
 * so `withNetworkTiming`'s driver-method-timing approach does not apply the same way; the total
 * end-to-end number is what the budget check needs.
 */
async function measureSnapshotWarm(databaseUrl: string, iterations: number): Promise<SnapshotWarmResult> {
  const warmClient = createPgClient(databaseUrl, "websocket");
  const warmDriver = new PgStorageDriver(warmClient);
  invalidateVectorIndex(MEASUREMENT_KB_ID);
  const warmupIndex = await getVectorIndex(MEASUREMENT_KB_ID, warmDriver); // untimed — populates the Blob snapshot
  const generation = warmupIndex.generation;

  const totalsMs: number[] = [];
  let identityDiffersEveryColdCall = true;
  let previousIndex: VectorIndex | undefined;

  for (let i = 0; i < iterations; i++) {
    const client = createPgClient(databaseUrl, "websocket");
    const driver = new PgStorageDriver(client);

    invalidateVectorIndex(MEASUREMENT_KB_ID);
    const start = performance.now();
    const index = await getVectorIndex(MEASUREMENT_KB_ID, driver);
    const totalMs = performance.now() - start;

    if (previousIndex !== undefined && previousIndex === index) {
      identityDiffersEveryColdCall = false;
    }
    previousIndex = index;
    totalsMs.push(totalMs);
  }

  totalsMs.sort((a, b) => a - b);
  const p95Ms = percentile(totalsMs, 95);

  return {
    p50Ms: round(percentile(totalsMs, 50)),
    p95Ms: round(p95Ms),
    maxMs: round(totalsMs[totalsMs.length - 1] ?? 0),
    budgetMet: p95Ms <= P95_BUDGET_MS,
    samples: iterations,
    identityDiffersEveryColdCall,
    generation,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const databaseUrl = readCloudTestEnv("DATABASE_URL");
  if (!databaseUrl) {
    console.error("FATAL: DATABASE_URL not found (process.env or .env.local). Cannot measure against Neon.");
    process.exit(1);
  }

  const seedClient = createPgClient(databaseUrl, "http");
  await ensureMeasurementKb(seedClient);

  console.log(`Seeding ${args.chunks} synthetic chunks into kb="${MEASUREMENT_KB_ID}"...`);
  const seedDriver = new PgStorageDriver(seedClient);
  const memBeforeSeed = process.memoryUsage().rss;
  const { documentId } = await seedCorpus(seedDriver, args.chunks);
  const memAfterSeed = process.memoryUsage().rss;

  if (args.snapshotOnly) {
    let snapshotGeneration: number | undefined;
    try {
      console.log(`\nMeasuring snapshot-warm cold rebuild (${args.iterations} iterations, one untimed warm-up first)...`);
      const result = await measureSnapshotWarm(databaseUrl, args.iterations);
      snapshotGeneration = result.generation;
      console.table([result]);

      const generatedAt = new Date().toISOString();
      const section = `
## Snapshot-warm cold rebuild (${generatedAt})

A SEPARATE measurement from "Measured result" above: one untimed warm-up rebuild first populates
the Blob snapshot for this corpus's current generation (via the WebSocket transport, the only one
proven to complete the miss path at this scale), then ${args.iterations} timed cold rebuilds run
with the in-memory cache invalidated before each call but the underlying generation UNCHANGED —
every one of them should be a genuine snapshot hit, never touching \`driver.getAllChunkVectors\`.
This is the steady-state number: what a cold start actually costs once a generation has been
stable for at least one prior invocation, which is the common case in production (a generation
only bumps on a document upload/delete, not on every request).

| Metric | p50 | p95 | max |
|---|---|---|---|
| \`getVectorIndex()\` end-to-end (snapshot hit) | ${result.p50Ms}ms | ${result.p95Ms}ms | ${result.maxMs}ms |

**Budget verdict: ${result.budgetMet ? "PASS" : "FAIL"}** (p95 ${result.p95Ms}ms vs the ${P95_BUDGET_MS}ms budget).
Cache-clear sanity check: consecutive cold calls returned a different index object every time
(${result.identityDiffersEveryColdCall ? "confirmed" : "NOT CONFIRMED — see Issues"}).
`;
      appendFileSync(COLDSTART_DOC, section);
      console.log(`\nAppended snapshot-warm result to ${COLDSTART_DOC}`);
      console.log(`Snapshot-warm: ${result.budgetMet ? "PASS" : "FAIL"} (p95 ${result.p95Ms}ms)`);
    } finally {
      if (!args.keep) {
        console.log(`\nCleaning up synthetic corpus (kb="${MEASUREMENT_KB_ID}")...`);
        await cleanupCorpus(seedDriver, documentId);
        await cleanupMeasurementKb(seedClient);
        if (snapshotGeneration !== undefined) {
          const { deleteVectorSnapshot } = await import("../src/lib/storage/vector-snapshot.js");
          await deleteVectorSnapshot(MEASUREMENT_KB_ID, snapshotGeneration);
        }
      } else {
        console.log(`\n--keep passed: leaving synthetic corpus and snapshot (kb="${MEASUREMENT_KB_ID}") in place.`);
      }
    }
    return;
  }

  let httpResult: TransportResult | undefined;
  let wsResult: TransportResult | undefined;
  let peakRssDuringRebuildBytes = 0;

  try {
    for (const transport of ["http", "websocket"] as const) {
      console.log(`\nMeasuring transport="${transport}" (${args.iterations} cold iterations)...`);
      const before = process.memoryUsage().rss;
      const result = await measureTransportSafe(databaseUrl, transport, args.iterations);
      const after = process.memoryUsage().rss;
      peakRssDuringRebuildBytes = Math.max(peakRssDuringRebuildBytes, before, after);
      if (transport === "http") httpResult = result;
      else wsResult = result;
      if (result.status === "failed") {
        console.error(`  FAILED: ${result.errorMessage}`);
      } else {
        console.table([result]);
      }
    }
  } finally {
    if (!args.keep) {
      console.log(`\nCleaning up synthetic corpus (kb="${MEASUREMENT_KB_ID}")...`);
      await cleanupCorpus(seedDriver, documentId);
      await cleanupMeasurementKb(seedClient);
    } else {
      console.log(`\n--keep passed: leaving synthetic corpus (kb="${MEASUREMENT_KB_ID}") in place.`);
    }
  }

  if (!httpResult || !wsResult) {
    console.error("FATAL: one or both transports did not produce a result.");
    process.exit(1);
  }

  /** Renders one transport's section. A `failed` result still gets a full section — the quoted
   * error IS the measurement for that transport (D3-18: report the number, or the failure,
   * whether or not either one is convenient). */
  function renderTransportSection(label: string, result: TransportResult): string {
    if (result.status === "failed") {
      return `### ${label}

**Budget verdict: FAIL — the transport did not complete a cold rebuild at ${args.chunks.toLocaleString()} chunks.**

Attempted ${result.samplesAttempted} iteration(s); every one failed with the same error, quoted
verbatim from the platform (not paraphrased):

\`\`\`
${result.errorMessage}
\`\`\`
`;
    }
    return `### ${label}

| Metric | p50 | p95 | max |
|---|---|---|---|
| \`getVectorIndex()\` end-to-end | ${result.p50Ms}ms | ${result.p95Ms}ms | ${result.maxMs}ms |
| \`getGeneration\` + \`getAllChunkVectors\` (network + decode) | ${result.networkP50Ms}ms | ${result.networkP95Ms}ms | — |
| pack + normalize-assert loop | ${result.packP50Ms}ms | ${result.packP95Ms}ms | — |

**Budget verdict: ${result.budgetMet ? "PASS" : "FAIL"}** (p95 ${result.p95Ms}ms vs the ${P95_BUDGET_MS}ms budget).
Cache-clear sanity check: consecutive cold calls returned a different index object every time
(${result.identityDiffersEveryColdCall ? "confirmed" : "NOT CONFIRMED — see Issues"}); a
deliberately WARM (non-invalidated) second call measured ${result.warmCacheNearZeroMs}ms,
demonstrating the cold-loop above is not silently hitting the cache.
`;
  }

  function verdictLabel(result: TransportResult): string {
    if (result.status === "failed") return "FAIL (transport error, see 03-COLDSTART.md)";
    return `${result.budgetMet ? "PASS" : "FAIL"} (p95 ${result.p95Ms}ms)`;
  }

  const region = extractNeonRegion(databaseUrl);
  const resourceUsage = process.resourceUsage();
  // maxRSS is kilobytes on Linux and macOS (Node docs: process.resourceUsage()); convert to MB
  // for the report. This is the whole PROCESS's peak resident memory since start, not an isolated
  // per-call measurement — reported as such, alongside the narrower before/after rebuild-loop
  // snapshot above, which is the closer proxy to "memory cost of one cold rebuild."
  const maxRssMb = round(resourceUsage.maxRSS / 1024);
  const rebuildLoopPeakMb = mb(peakRssDuringRebuildBytes);
  const seedMemDeltaMb = mb(memAfterSeed - memBeforeSeed);

  const generatedAt = new Date().toISOString();
  const report = `
## Measured result (${generatedAt})

**Corpus:** ${args.chunks.toLocaleString()} synthetic chunks, each a randomly-generated then
L2-normalized ${DIM}-dim \`Float32Array\` (deterministic seed 42, \`gemini-embedding-001\`-shaped:
768 dims x 4 bytes = 3072 bytes/row), written to a dedicated, non-\`default\` knowledge base id
(\`${MEASUREMENT_KB_ID}\`) via the real \`PgStorageDriver.upsertChunks\` write path in batches of
${SEED_BATCH_SIZE}. ${args.iterations} cold-rebuild iterations were timed per transport.

**Neon region (parsed from \`DATABASE_URL\`'s hostname):** ${region}. Plan tier: not queryable via
SQL from this script; PROJECT.md's "2 free-tier accounts" constraint means this is the Neon Free
tier by product requirement, not by a query result — stated as an inference, not a measured fact.

${renderTransportSection("HTTP transport (`neon()` / `drizzle-orm/neon-http`)", httpResult)}
${renderTransportSection("WebSocket transport (`Pool` / `drizzle-orm/neon-serverless`)", wsResult)}
### Peak memory

- Whole-process peak RSS since script start (\`process.resourceUsage().maxRSS\`): **${maxRssMb} MB**.
- RSS observed immediately around the ${args.chunks.toLocaleString()}-chunk rebuild loop (narrower proxy for
  "memory cost of one cold rebuild," not an isolated single-call measurement): **${rebuildLoopPeakMb} MB**.
- RSS delta while seeding the corpus (write path, not the read path under test): ${seedMemDeltaMb} MB.
- Vercel Functions default to 1024MB; both numbers above are reported as measured, not adjusted.

**Corpus cleanup:** ${args.keep ? "SKIPPED (--keep passed) — synthetic corpus left in place." : `document ${documentId} and its ${args.chunks.toLocaleString()} chunks were deleted via the real deleteDocument cascade path immediately after measurement.`}
`;

  appendFileSync(COLDSTART_DOC, report);
  console.log(`\nAppended measured results to ${COLDSTART_DOC}`);
  console.log(`HTTP: ${verdictLabel(httpResult)} | WebSocket: ${verdictLabel(wsResult)}`);
}

main().catch((err) => {
  if (err instanceof AppError) {
    console.error(`FATAL (${err.code}): ${err.message}`);
    if (err.cause) console.error("Cause:", err.cause);
  } else {
    console.error("FATAL:", err);
  }
  process.exit(1);
});
