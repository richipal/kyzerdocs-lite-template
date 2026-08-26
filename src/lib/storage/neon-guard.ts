/**
 * Fail-closed Neon-host guard for `scripts/db-migrate.mts` (D3-06, KDL-DB-005).
 *
 * Deviation from 03-03-PLAN.md's original task text, approved by the developer mid-execution:
 * `db-migrate.mts` must refuse to run unless the resolved `DATABASE_URL` host is recognizably a
 * Neon host. This project's own `.env.local` already carries `KYZERDOCS_DATABASE_URL` pointing at
 * `aws-1-us-east-1.pooler.supabase.com` — the live production database of the sibling KyzerDocs
 * product, holding real customer data. It sits in the same file the developer is about to add
 * `DATABASE_URL` to, and the two names differ only by a prefix. Without this guard, one crossed
 * value means `db:migrate` runs `CREATE TABLE`/migrations against production.
 *
 * D3-06 rejects Supabase for exactly this reason; this turns that written decision into an
 * enforced one — but deliberately as an ALLOWLIST of Neon's own hostname pattern, not a blocklist
 * of Supabase specifically. A blocklist only catches the case someone already thought of; the
 * next mis-pasted provider (a different Postgres host entirely) would sail through unnoticed.
 * Failing closed catches every case that isn't affirmatively Neon.
 */

import { AppError } from "../errors.js";

/** Every Neon connection-string host observed in Neon's own docs and the Vercel Neon
 * integration ends in this suffix — both the direct (`ep-*.neon.tech`) and pooled
 * (`ep-*-pooler.<region>.aws.neon.tech`) forms. */
const NEON_HOST_SUFFIX = ".neon.tech";

/**
 * Throws `AppError("KDL-DB-005")` if `databaseUrl` does not parse as a URL, or parses but its
 * hostname does not end in `.neon.tech`. Never logs or includes the full connection string (which
 * carries credentials) — only the bare hostname, which is safe to print and name in an error.
 */
export function assertNeonHost(databaseUrl: string, varName: string): void {
  let hostname: string;
  try {
    hostname = new URL(databaseUrl).hostname;
  } catch (cause) {
    throw new AppError("KDL-DB-005", {
      cause,
      message: `${varName} is not a valid connection string URL — could not parse a host from it.`,
    });
  }

  if (!hostname.toLowerCase().endsWith(NEON_HOST_SUFFIX)) {
    throw new AppError("KDL-DB-005", {
      message:
        `Refusing to run — ${varName} host "${hostname}" is not a recognized Neon host ` +
        `(expected a hostname ending in "${NEON_HOST_SUFFIX}"). This guard exists to prevent a ` +
        `mis-pasted connection string reaching a different provider's database (D3-06). If this ` +
        `is genuinely a Neon database on a different domain, update NEON_HOST_SUFFIX in ` +
        `src/lib/storage/neon-guard.ts.`,
    });
  }
}
