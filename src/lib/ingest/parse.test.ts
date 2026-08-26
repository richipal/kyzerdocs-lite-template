import { readFileSync } from "node:fs";
import { extractText, getDocumentProxy } from "unpdf";
import { describe, expect, it } from "vitest";
import { AppError, ERROR_CODES } from "../errors.js";
import { classifyPdfError, parseDocument } from "./parse.js";

const CORPUS_DIR = "evals/corpus";

/** Real corpus PDFs Phase 1 actually measured (per RESEARCH.md's directive: a synthetic one-page
 * PDF proves nothing about page-boundary arithmetic across multi-page, multi-column documents).
 * Subset used for the deeper per-test assertions below (slice-fidelity, purity). */
const REAL_PDFS = [
  "osha-emergency-preparedness-farmworkers.pdf",
  "osha-farm-vehicle-backover-prevention.pdf",
  "osha-tractor-hazards-agricultural-workers.pdf",
];

/** Every text-bearing PDF in the Phase 1 corpus (excludes the scanned fixture, which is asserted
 * separately below to *fail* extraction) — the plan's phase-level verification requires page-span
 * contiguity to hold across the whole corpus, not just a sample. */
const ALL_TEXT_PDFS = [
  ...REAL_PDFS,
  "osha-amputation-hazards-factsheet.pdf",
  "osha-aed-cardiac-arrest-workplace.pdf",
  "osha-tripod-orchard-ladder-safety.pdf",
  "osha-asbestos-flooring-maintenance.pdf",
  "osha-asbestos-factsheet.pdf",
  "osha-avian-flu-food-handlers.pdf",
];

function readBytes(filename: string): Uint8Array {
  return new Uint8Array(readFileSync(`${CORPUS_DIR}/${filename}`));
}

describe("parseDocument — PDF page-boundary tracking", () => {
  it.each(REAL_PDFS)("produces a contiguous, verified page-boundary map for %s", async (filename) => {
    const bytes = readBytes(filename);
    const parsed = await parseDocument(bytes, { filename, byteSize: bytes.byteLength });

    expect(parsed.format).toBe("pdf");
    expect(parsed.pageCount).not.toBeNull();
    expect(parsed.pages.length).toBe(parsed.pageCount);
    expect(parsed.pages[0]!.charStart).toBe(0);

    for (let i = 0; i < parsed.pages.length - 1; i++) {
      expect(parsed.pages[i]!.charEnd).toBe(parsed.pages[i + 1]!.charStart);
    }
    expect(parsed.pages.at(-1)!.charEnd).toBe(parsed.text.length);

    for (const [i, span] of parsed.pages.entries()) {
      expect(span.pageNumber).toBe(i + 1);
      expect(span.charEnd).toBeGreaterThanOrEqual(span.charStart);
    }
  });

  it("slice of a page's span matches that page's own extractText output (first 60 chars)", async () => {
    const filename = "osha-tractor-hazards-agricultural-workers.pdf";
    const bytes = readBytes(filename);
    const parsed = await parseDocument(bytes, { filename, byteSize: bytes.byteLength });

    // Independently re-extract per-page text the same way parse.ts does, to compare against.
    // getDocumentProxy transfers/detaches its input buffer, so re-read fresh bytes rather than
    // reusing `bytes` (already consumed by the parseDocument call above).
    const pdf = await getDocumentProxy(readBytes(filename));
    const { text: pageTexts } = await extractText(pdf, { mergePages: false });

    const pageIndex = Math.floor(pageTexts.length / 2); // a middle page, not just the first/last
    const span = parsed.pages[pageIndex]!;
    const sliced = parsed.text.slice(span.charStart, span.charEnd);
    expect(sliced.slice(0, 60)).toBe(pageTexts[pageIndex]!.slice(0, 60));
  });

  it("is pure: parsing the same bytes twice yields identical text and pages", async () => {
    const filename = "osha-farm-vehicle-backover-prevention.pdf";
    const bytes = readBytes(filename);
    const first = await parseDocument(bytes, { filename, byteSize: bytes.byteLength });
    const second = await parseDocument(bytes, { filename, byteSize: bytes.byteLength });
    expect(second.text).toBe(first.text);
    expect(second.pages).toEqual(first.pages);
  });

  it.each(ALL_TEXT_PDFS)("page-span contiguity holds for %s (whole-corpus verification requirement)", async (filename) => {
    const bytes = readBytes(filename);
    const parsed = await parseDocument(bytes, { filename, byteSize: bytes.byteLength });

    expect(parsed.pages.length).toBe(parsed.pageCount);
    expect(parsed.pages[0]!.charStart).toBe(0);
    for (let i = 0; i < parsed.pages.length - 1; i++) {
      expect(parsed.pages[i]!.charEnd).toBe(parsed.pages[i + 1]!.charStart);
    }
    expect(parsed.pages.at(-1)!.charEnd).toBe(parsed.text.length);
  });
});

describe("parseDocument — DOCX", () => {
  it("returns non-empty text with no page concept", async () => {
    const filename = "clinic-intake-policy.docx";
    const bytes = readBytes(filename);
    const parsed = await parseDocument(bytes, { filename, byteSize: bytes.byteLength });

    expect(parsed.format).toBe("docx");
    expect(parsed.text.length).toBeGreaterThan(0);
    expect(parsed.pages).toHaveLength(0);
    expect(parsed.pageCount).toBeNull();
  });
});

describe("parseDocument — scanned-PDF detection (ING-04)", () => {
  it("rejects the image-only scanned corpus PDF with KDL-PARSE-001, while its text-layer twin parses successfully", async () => {
    const scannedFilename = "osha-tractor-hazards-agricultural-workers-scanned.pdf";
    const scannedBytes = readBytes(scannedFilename);

    await expect(
      parseDocument(scannedBytes, { filename: scannedFilename, byteSize: scannedBytes.byteLength }),
    ).rejects.toMatchObject({ code: "KDL-PARSE-001" });

    // The pair, not the single fixture, is the assertion — this proves the detector separates a
    // genuinely image-only PDF from its dense text-layer twin rather than rejecting dense PDFs.
    const twinFilename = "osha-tractor-hazards-agricultural-workers.pdf";
    const twinBytes = readBytes(twinFilename);
    const twinParsed = await parseDocument(twinBytes, { filename: twinFilename, byteSize: twinBytes.byteLength });
    expect(twinParsed.text.length).toBeGreaterThan(2000);
  });
});

describe("classifyPdfError", () => {
  it("classifies a password-related error message as KDL-PARSE-002", () => {
    const err = classifyPdfError(new Error("No password given"));
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe("KDL-PARSE-002");
  });

  it("classifies an incorrect-password error message as KDL-PARSE-002", () => {
    const err = classifyPdfError(new Error("Incorrect Password"));
    expect(err.code).toBe("KDL-PARSE-002");
  });

  it("classifies a corrupt-structure error message as KDL-PARSE-003", () => {
    const err = classifyPdfError(new Error("Invalid PDF structure."));
    expect(err.code).toBe("KDL-PARSE-003");
  });

  it("classifies an unrecognized error as KDL-PARSE-003 rather than throwing or defaulting to a generic message", () => {
    const err = classifyPdfError(new Error("some unrelated pdf.js internal failure"));
    expect(err.code).toBe("KDL-PARSE-003");
  });
});

describe("parseDocument — every throw site uses a registered KDL code", () => {
  it("formatFromFilename rejects an unsupported extension with a registered code, not a generic error", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    await expect(parseDocument(bytes, { filename: "malware.exe", byteSize: 3 })).rejects.toMatchObject({
      code: "KDL-UPLOAD-001",
    });
  });

  it("a garbage buffer claiming to be a PDF raises KDL-PARSE-003", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    await expect(parseDocument(bytes, { filename: "corrupt.pdf", byteSize: bytes.byteLength })).rejects.toMatchObject(
      { code: "KDL-PARSE-003" },
    );
  });

  it("every code this module can throw is a registered ERROR_CODES key, exercised end to end", async () => {
    const observedCodes = new Set<string>();

    // KDL-UPLOAD-001 — unsupported extension reaching parseDocument directly.
    await parseDocument(new Uint8Array([1]), { filename: "malware.exe", byteSize: 1 }).catch((err: AppError) =>
      observedCodes.add(err.code),
    );
    // KDL-PARSE-003 — garbage bytes claiming to be a PDF.
    await parseDocument(new Uint8Array([1, 2, 3, 4, 5]), { filename: "corrupt.pdf", byteSize: 5 }).catch(
      (err: AppError) => observedCodes.add(err.code),
    );
    // KDL-PARSE-001 — the real scanned-PDF fixture.
    const scannedFilename = "osha-tractor-hazards-agricultural-workers-scanned.pdf";
    const scannedBytes = readBytes(scannedFilename);
    await parseDocument(scannedBytes, { filename: scannedFilename, byteSize: scannedBytes.byteLength }).catch(
      (err: AppError) => observedCodes.add(err.code),
    );
    // KDL-PARSE-002 — classifier, injected (no real password-protected fixture in the corpus).
    observedCodes.add(classifyPdfError(new Error("No password given")).code);
    // KDL-PARSE-004 — DOCX extraction failure, forced with bytes mammoth cannot read as a DOCX.
    await parseDocument(new Uint8Array([1, 2, 3, 4, 5]), { filename: "corrupt.docx", byteSize: 5 }).catch(
      (err: AppError) => observedCodes.add(err.code),
    );

    expect(observedCodes.size).toBeGreaterThan(0);
    for (const code of observedCodes) {
      expect(Object.keys(ERROR_CODES)).toContain(code);
    }
    expect(observedCodes).toEqual(
      new Set(["KDL-UPLOAD-001", "KDL-PARSE-003", "KDL-PARSE-001", "KDL-PARSE-002", "KDL-PARSE-004"]),
    );
  });
});

describe("parseDocument — Markdown", () => {
  it("preserves heading lines verbatim so the chunker's heading tier still fires", async () => {
    const filename = "service-warranty-faq.md";
    const bytes = readBytes(filename);
    const parsed = await parseDocument(bytes, { filename, byteSize: bytes.byteLength });

    expect(parsed.format).toBe("md");
    expect(parsed.pages).toHaveLength(0);
    expect(parsed.pageCount).toBeNull();

    const headingLines = parsed.text.split("\n").filter((line) => /^#{1,3} /.test(line));
    expect(headingLines.length).toBeGreaterThan(0);
    expect(parsed.text).toContain("## How is mowing and maintenance priced?");
  });
});
