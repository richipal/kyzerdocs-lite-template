/**
 * FileStorage — the second storage seam this phase adds (STOR-06, plan 03-10), mirroring
 * `StorageDriver`'s own shape (`./driver.ts`): a small, doc-commented interface with one
 * implementation per mode, selected by the SAME `PRODUCT_CONFIG.cloudMode` branch
 * `getStorageDriver()` already uses (`./index.ts`'s `getFileStorage` — the third use of this
 * exact convention, after the storage driver and the rate limiter).
 *
 * Exactly the three operations `src/lib/storage/files.ts` already exposes as free functions
 * (`storeUpload`/`readUpload`/`deleteUpload`, now also exported as `LocalFileStorage`) — this
 * interface formalizes their contract so a second implementation (`BlobFileStorage`, `./blob.ts`)
 * can slot in behind it without either implementation drifting from the other's security
 * properties:
 *
 *   - `store`'s returned `storagePath` is ALWAYS server-generated — `randomUUID()` plus the
 *     file's extension only. The buyer-supplied filename is display metadata and is NEVER a path
 *     or key component, in either implementation (T-03-10-02). Blob keys are not filesystem
 *     paths, but the principle and the reason are the same.
 *   - `contentHash` is the SHA-256 hex digest of the exact bytes stored, computed identically in
 *     both implementations — this is ING-06's re-upload detection key, and a document
 *     re-uploaded after a mode switch (local <-> cloud) must still be detected as a duplicate.
 *   - `delete` is idempotent in both implementations — deleting an already-absent object is not
 *     an error, matching `deleteDocument`'s own "delete cascades, missing is fine" semantics.
 */

import type { FileMeta } from "../ingest/types.js";

export interface FileStorage {
  /** Writes `bytes` under a server-generated key and returns that key (`storagePath`) plus a
   * SHA-256 `contentHash` of the exact bytes written. `meta.filename` is consulted ONLY for its
   * extension — never used as (or concatenated into) the key itself. */
  store(bytes: Uint8Array, meta: FileMeta): Promise<{ storagePath: string; contentHash: string }>;

  /** Reads back a previously stored object's bytes in full, as a plain `Uint8Array` — the same
   * type `store()` accepts, so a round trip through this interface is type-symmetric.
   *
   * NOT `Buffer`, deliberately. `Buffer` extends `Uint8Array`, so it satisfies every structural
   * check and every byte comparison — and `unpdf`/pdf.js rejects it outright with "Please provide
   * binary data as `Uint8Array`, rather than `Buffer`." Local mode never hit this because
   * `/api/ingest` parses the bytes straight from the request and never reads them back; only cloud
   * mode round-trips through storage, so a `Buffer` here broke every PDF upload on a deployment
   * while local ingestion stayed green (03-UAT F6). */
  read(storagePath: string): Promise<Uint8Array>;

  /** Deletes a previously stored object. Idempotent — deleting an already-absent object never
   * throws. */
  delete(storagePath: string): Promise<void>;
}
