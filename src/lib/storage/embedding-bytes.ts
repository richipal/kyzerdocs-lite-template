/**
 * `packEmbedding` / `EXPECTED_EMBEDDING_BYTES` — moved here from `src/lib/storage/sqlite.ts`
 * verbatim (plan 03-05, STOR-03). Both `SqliteStorageDriver` and `PgStorageDriver` call this same
 * function to pack a `Float32Array` into a `Buffer` before it ever reaches a `BLOB`/`bytea` column
 * — two packing implementations is exactly the dialect-drift failure D3-09 names.
 */

import { PRODUCT_CONFIG } from "../config.js";
import { AppError } from "../errors.js";

export const EXPECTED_EMBEDDING_BYTES = PRODUCT_CONFIG.embedding.outputDimensionality * 4;

/** Packs a `Float32Array` into a `Buffer` for the `embedding BLOB`/`bytea` column — never JSON
 * (STOR-04). Asserts the vector is exactly the configured output dimensionality; a wrong-width
 * vector reaching the corpus is exactly the silent corruption normalization exists to prevent. */
export function packEmbedding(vector: Float32Array): Buffer {
  if (vector.byteLength !== EXPECTED_EMBEDDING_BYTES) {
    throw new AppError("KDL-EMBED-003", {
      message: `Embedding has ${vector.byteLength} bytes, expected ${EXPECTED_EMBEDDING_BYTES} (${PRODUCT_CONFIG.embedding.outputDimensionality} dims x 4 bytes).`,
    });
  }
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}
