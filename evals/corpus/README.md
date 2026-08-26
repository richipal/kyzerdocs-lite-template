# Corpus

This is the fixed, 16-document corpus the retrieval-validation-gate measurement (VAL-01) runs
against. It exists to answer one question honestly: does in-memory brute-force cosine retrieval
(Lite) match the KyzerDocs pgvector baseline, on documents that look like what the product will
actually ingest for its target market of trades, clinics, agencies, and local services.

## Composition rules

- Documents are sourced from two places only:
  1. **U.S. federal agency (OSHA) publications** — public domain under 17 U.S.C. 105 (works of
     the U.S. government are not subject to domestic copyright). Downloaded with `curl` directly
     from `osha.gov`. See `MANIFEST.json`'s `provenance` field for the exact source URL of each.
  2. **Documents authored specifically for this corpus** — fictional organizations (e.g.
     "Riverside Family Clinic," "Cascade HVAC Services," "Ironclad Electrical Contractors"),
     fictional policies, fictional dollar amounts, torque specs, and fee schedules. None of this
     content describes a real business, a real patient, or a real customer.
- No real buyer documents and no PII, ever — not even for internal testing. Exported chunk
  content from this corpus is later written to `evals/fixtures/` by later plans in this phase;
  keeping the corpus public-domain or synthetic-original is what keeps that low-risk.
- Every entry in `MANIFEST.json` carries a `provenance` (source URL or "authored for this
  corpus"), a `licence` (`us-government-public-domain` or `authored-original`), and a `sha256`
  that can be independently recomputed with `shasum -a 256` and must match.
- Format and layout coverage required by VAL-01: at least one multi-column PDF, one
  image-only/scanned PDF, and one DOCX. This corpus has 6 multi-column PDFs, 1 image-only PDF,
  and 3 DOCX documents, plus 3 single-column PDFs and 3 TXT/MD documents.
- Idiosyncratic content is preferred over generic domain prose — exact torque values, part
  numbers, named policy IDs, dollar amounts, and procedural step counts — because a question
  whose answer a language model already knows cannot discriminate between two retrieval
  pipelines. The authored documents in particular lean on this deliberately.

## The image-only PDF is an asserted expected result, not a bug

One document, `osha-tractor-hazards-agricultural-workers-scanned.pdf`, is a genuinely
image-only PDF with no text layer, synthesized by rasterizing every page of
`osha-tractor-hazards-agricultural-workers.pdf` and reassembling the page images into a new PDF
with no OCR and no embedded text. Extracting it with `unpdf` is expected and required to yield
zero (or near-zero) text.

This is correct behavior, not a harness failure. Per decision D-20, it is recorded in
`MANIFEST.json` as `expected_parse: "zero-text"` and `scoring_excluded: true`, and
`evals/scripts/parse-audit.ts` asserts this rather than merely reporting it. Do not add OCR,
Tesseract, or any image-to-text step anywhere in this harness to "fix" this document — doing so
would defeat the entire reason it is in the corpus, which is to prove the harness correctly
detects and excludes unparseable input instead of silently scoring it as a retrieval miss.

## Files

See `MANIFEST.json` for the authoritative per-document record: `filename`, `format`, `layout`,
`domain`, `provenance`, `licence`, `sha256`, `expected_parse`, and `scoring_excluded`.

Plain-text extractions for every parseable document live in `evals/corpus/extracted/`, written
by `evals/scripts/parse-audit.ts`. That extracted text is the authoring source for ground-truth
answer spans in plan 01-06 — copying quotes from it guarantees the span validator finds them
verbatim.
