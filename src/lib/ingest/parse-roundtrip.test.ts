/**
 * Parses a PDF whose bytes came back OUT of `FileStorage`, rather than straight from a request.
 *
 * This is the path cloud mode takes and local mode does not: `/api/ingest` in local mode parses
 * `new Uint8Array(await file.arrayBuffer())` directly, so the stored bytes are never read back
 * before parsing. Cloud mode uploads to Blob first and then reads back — and when `read()` returned
 * a `Buffer`, pdf.js rejected it with "Please provide binary data as `Uint8Array`, rather than
 * `Buffer`". Every PDF upload failed on the deployment as "may be unreadable or corrupt" while the
 * whole suite stayed green (03-UAT F6).
 *
 * The storage conformance suite could not catch it: it compared contents with
 * `Buffer.from(a).equals(Buffer.from(b))`, which normalises both sides to `Buffer` and is blind to
 * the exact difference that mattered. Comparing bytes is not the same as exercising the path.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalFileStorage } from "../storage/files.js";
import { parseDocument } from "./parse.js";

const CORPUS_PDF = join(process.cwd(), "evals/corpus/osha-asbestos-flooring-maintenance.pdf");
const localUploadDir = join(process.cwd(), "data", "test-uploads-roundtrip");
let stored: string | undefined;

beforeAll(() => {
  process.env.UPLOAD_DIR = localUploadDir;
});
afterAll(async () => {
  if (stored) await LocalFileStorage.delete(stored);
  delete process.env.UPLOAD_DIR;
});

describe("parse a PDF read back out of FileStorage", () => {
  it("round-trips through storage and still parses", async () => {
    const original = new Uint8Array(await readFile(CORPUS_PDF));
    const { storagePath } = await LocalFileStorage.store(original, {
      filename: "roundtrip.pdf",
      byteSize: original.byteLength,
      mimeType: "application/pdf",
    });
    stored = storagePath;

    const readBack = await LocalFileStorage.read(storagePath);
    // The precondition pdf.js actually enforces. A `Buffer` here passes every byte assertion and
    // still fails to parse, which is why this is asserted before the parse rather than inferred
    // from it.
    expect(Buffer.isBuffer(readBack)).toBe(false);

    const parsed = await parseDocument(readBack, {
      filename: "roundtrip.pdf",
      mimeType: "application/pdf",
    } as never);

    expect((parsed as { text: string }).text.length).toBeGreaterThan(500);
  });
});
