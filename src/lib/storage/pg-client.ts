/**
 * Neon client factory for `PgStorageDriver` (STOR-03). Exposes both transports Neon's serverless
 * driver supports, behind one exported constant (D3-18):
 *
 *   - **HTTP** (`@neondatabase/serverless`'s `neon()` + `drizzle-orm/neon-http`) — stateless per
 *     request, no connection to keep warm, but hex-encodes `bytea` over the wire at roughly 2x
 *     cost (RESEARCH.md) and cannot run an interactive multi-round-trip transaction —
 *     `NeonHttpDatabase.transaction()` throws "No transactions support in neon-http driver" by
 *     design. **Measured (plan 03-07, `03-COLDSTART.md`) to FAIL OUTRIGHT, not just slowly, at
 *     the product's 20,000-chunk target scale**: Neon's HTTP data-API proxy enforces a hard
 *     server-side response-size cap independent of any client-side timeout or retry —
 *     `getAllChunkVectors(kbId)` on a 20k-chunk kb returned `HTTP 507 "response is too large (max
 *     is 67108864 bytes)"` on every one of 5 attempts. This is a structural ceiling, not a
 *     workload-tuning question — do not make this the default at this product's target scale.
 *   - **WebSocket** (`@neondatabase/serverless`'s `Pool` + `drizzle-orm/neon-serverless`) — **the
 *     default**, since it is the only transport that completes a full-corpus cold rebuild at all
 *     at target scale. Holds a real connection, so it also supports
 *     `db.transaction(async (tx) => ...)` for arbitrary interactive callbacks. Measured p50
 *     5459.58ms / p95 6478.52ms / max 6478.52ms for a genuinely cold `getVectorIndex()` rebuild at
 *     20,000 chunks (network+decode dominates: p95 6401.97ms vs a 76.55ms pack+assert loop) —
 *     this ALSO misses D3-18's pre-registered 3000ms p95 budget, which is why
 *     `src/lib/storage/vector-snapshot.ts` exists as a read-through cache on top of this
 *     transport, not a replacement for measuring it honestly. See `03-COLDSTART.md`'s "Measured
 *     result" and "Road taken" sections for the full numbers and the decision they produced.
 *
 * Every method on `PgStorageDriver` wraps its own query execution in `wrapPgError` (this file) —
 * connection/network failures become `AppError("KDL-DB-003")`, a missing-relation failure
 * (Postgres SQLSTATE `42P01`) becomes `AppError("KDL-DB-004")` naming the fix (run migrations).
 */

import { neon, Pool } from "@neondatabase/serverless";
import { drizzle as drizzleHttp, type NeonHttpDatabase } from "drizzle-orm/neon-http";
import { drizzle as drizzleWs, type NeonDatabase } from "drizzle-orm/neon-serverless";
import { AppError } from "../errors.js";
import * as schema from "./schema.pg.js";

export type PgTransport = "http" | "websocket";

/** Flipped by plan 03-07 after measuring cold-start cost (D3-18) — see this file's header for
 * the measured numbers behind this choice. Do not hardcode "http"/"websocket" anywhere else —
 * read this constant. HTTP remains available (some callers, e.g. short-lived low-volume queries
 * outside the vector-index rebuild path, may still prefer it), but it is no longer the shipped
 * default because it cannot complete this product's own target-scale read at all. */
export const DEFAULT_PG_TRANSPORT: PgTransport = "websocket";

export type PgSchema = typeof schema;
export type PgHttpDatabase = NeonHttpDatabase<PgSchema>;
export type PgWsDatabase = NeonDatabase<PgSchema>;
export type PgDatabaseHandle = PgHttpDatabase | PgWsDatabase;

/** A Neon connection plus which transport built it — `PgStorageDriver` reads `.transport`
 * directly (an explicit tag, not structural introspection of the Drizzle instance) to decide
 * whether `transaction()` can attempt an interactive transaction or must fail loudly with
 * `KDL-DB-003`. */
export interface PgClient {
  db: PgDatabaseHandle;
  transport: PgTransport;
}

/** Opens a Neon connection over the requested transport (default `DEFAULT_PG_TRANSPORT`) and
 * wraps it with Drizzle, typed against `schema.pg.ts`. Never throws synchronously on a bad host —
 * both `neon()` and `Pool` build lazily; the first real failure surfaces the first time a query
 * runs, wrapped by `wrapPgError` inside `PgStorageDriver`. */
export function createPgClient(
  databaseUrl: string,
  transport: PgTransport = DEFAULT_PG_TRANSPORT,
): PgClient {
  if (transport === "websocket") {
    const pool = new Pool({ connectionString: databaseUrl });
    return { db: drizzleWs(pool, { schema }), transport };
  }
  const sql = neon(databaseUrl);
  return { db: drizzleHttp(sql, { schema }), transport };
}

/** Postgres SQLSTATE for `undefined_table` — the code Neon/`pg` report when a query references a
 * relation that does not exist (a fresh cloud deploy where `npm run db:migrate` has not run yet). */
const UNDEFINED_TABLE_SQLSTATE = "42P01";

/** Reads a driver error's own `.code`, walking one level into `.cause` if absent. Verified live
 * against a real missing-relation failure (plan 03-05, Task 3): Drizzle's `db.execute()` does not
 * surface the raw Postgres/Neon error directly — it wraps it in its own `DrizzleQueryError`, whose
 * top-level `.code` is `undefined`; the real SQLSTATE (`"42P01"`) lives one level down at
 * `.cause.code`. Checking only the top-level `.code` (an earlier version of this function) silently
 * misclassified every missing-relation failure as `KDL-DB-003` instead of `KDL-DB-004`. */
function readDriverErrorCode(error: unknown): unknown {
  const direct = (error as { code?: unknown } | null | undefined)?.code;
  if (direct !== undefined) return direct;
  return (error as { cause?: { code?: unknown } } | null | undefined)?.cause?.code;
}

/** Wraps a raw Neon/Postgres driver error as the registered `AppError` code a caller (route
 * handler, health check) can act on, instead of leaking a raw driver error. Never passes the
 * original message through to `AppError`'s own `message` field — the registered copy for
 * `KDL-DB-003`/`KDL-DB-004` is the only thing a client ever sees; `cause` carries the original for
 * server-side logs. */
export function wrapPgError(cause: unknown): AppError {
  const code = readDriverErrorCode(cause);
  if (code === UNDEFINED_TABLE_SQLSTATE) {
    return new AppError("KDL-DB-004", { cause });
  }
  return new AppError("KDL-DB-003", { cause });
}
