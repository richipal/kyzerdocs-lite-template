/**
 * The single place that decides how this deployment authenticates to Vercel Blob.
 *
 * Two credential forms are valid and Vercel picks the first by default:
 *
 *   1. **OIDC** — a connected Blob store injects `VERCEL_OIDC_TOKEN` and `BLOB_STORE_ID` at
 *      runtime. `@vercel/blob`'s own types state `token` is "Ignored when Vercel OIDC token is
 *      available and either process.env.BLOB_STORE_ID or options.storeId is set." Nothing needs to
 *      be passed; the SDK resolves it.
 *   2. **A long-lived read-write token** — `BLOB_READ_WRITE_TOKEN`, used outside Vercel, in tests,
 *      and to mint client upload tokens.
 *
 * This exists because the check was duplicated across four modules and each one tested only for
 * the read-write token — a precondition stricter than the SDK's own. On a default Vercel Blob
 * connection that produced two distinct failures: `KDL-BLOB-001` on upload and in `/api/health`
 * ("File storage is not configured" on a deployment where it was), and — worse because it was
 * silent — `vector-snapshot.ts` no-opping every read and write, leaving DELIV-06's cold-start
 * mitigation permanently inert with no error anywhere. Found on a real deploy (03-UAT F2/F3);
 * nothing in a dev environment sets `BLOB_STORE_ID`, so no local test could reach it.
 *
 * Keep every blob call site going through this function. A fifth duplicated check is how the same
 * defect comes back.
 */

import { PRODUCT_CONFIG } from "../config.js";

/** Auth to spread into an `@vercel/blob` call, or `null` when this deployment has no Blob
 * credentials at all. `{}` is a valid, configured result — it means "the SDK resolves OIDC itself",
 * and must not be confused with `null`. */
export function resolveBlobAuth(tokenOverride?: string): { token?: string } | null {
  const token = tokenOverride ?? PRODUCT_CONFIG.storage.blobToken;
  if (token) return { token };
  if (PRODUCT_CONFIG.storage.blobStoreId) return {};
  return null;
}

/** True when this deployment can talk to Blob storage by either credential form. */
export function isBlobConfigured(): boolean {
  return resolveBlobAuth() !== null;
}

/**
 * Whether this deployment can mint CLIENT upload tokens — the browser-direct upload path that
 * exists to bypass Vercel's 4.5MB Function body cap.
 *
 * This is deliberately stricter than `isBlobConfigured()`, and the difference is not cosmetic.
 * OIDC authenticates the SERVER to Blob, so `put`/`get`/`list`/`del` all work with it. Minting a
 * token a BROWSER will present requires the long-lived read-write token — Vercel's own docs list
 * `BLOB_READ_WRITE_TOKEN` as being for "code running outside Vercel or to generate client tokens
 * for browser uploads", and `handleUpload()` fails with "No read-write token found" without it.
 *
 * A default one-click Blob connection provisions OIDC only. That deployment passes every
 * server-side blob check and still cannot accept a single upload — which is exactly what reached a
 * real buyer-shaped test (03-UAT F4): `/api/health` reported blob ok while every upload failed.
 */
export function canMintClientUploadTokens(): boolean {
  return Boolean(PRODUCT_CONFIG.storage.blobToken);
}
