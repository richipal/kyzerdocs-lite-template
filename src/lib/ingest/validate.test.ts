import { describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import { MAX_UPLOAD_BYTES, validateFileMetadata } from "./validate.js";

describe("validateFileMetadata", () => {
  describe("accepted types", () => {
    const accepted: Array<{ filename: string; mimeType: string }> = [
      { filename: "manual.pdf", mimeType: "application/pdf" },
      {
        filename: "policy.docx",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      },
      { filename: "notes.txt", mimeType: "text/plain" },
      { filename: "readme.md", mimeType: "text/markdown" },
      { filename: "readme.markdown", mimeType: "text/markdown" },
    ];

    it.each(accepted)("accepts $filename", ({ filename, mimeType }) => {
      expect(() => validateFileMetadata({ filename, mimeType, byteSize: 1024 })).not.toThrow();
    });
  });

  describe("rejected types", () => {
    const rejected: Array<{ filename: string; mimeType: string }> = [
      { filename: "deck.pptx", mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation" },
      { filename: "photo.png", mimeType: "image/png" },
      { filename: "clip.mp4", mimeType: "video/mp4" },
      { filename: "data.csv", mimeType: "text/csv" },
      { filename: "noextension", mimeType: "" },
    ];

    it.each(rejected)("rejects $filename with KDL-UPLOAD-001", ({ filename, mimeType }) => {
      try {
        validateFileMetadata({ filename, mimeType, byteSize: 1024 });
        expect.fail(`expected ${filename} to be rejected`);
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).code).toBe("KDL-UPLOAD-001");
      }
    });
  });

  it("accepts a .docx file whose browser-supplied MIME type is empty, resolving by extension", () => {
    expect(() =>
      validateFileMetadata({ filename: "policy.docx", mimeType: "", byteSize: 1024 }),
    ).not.toThrow();
  });

  it("accepts a .docx file whose browser-supplied MIME type is the generic octet-stream fallback", () => {
    expect(() =>
      validateFileMetadata({
        filename: "policy.docx",
        mimeType: "application/octet-stream",
        byteSize: 1024,
      }),
    ).not.toThrow();
  });

  it("rejects a file whose MIME type claims application/pdf but whose extension is .exe", () => {
    try {
      validateFileMetadata({ filename: "totally-safe.exe", mimeType: "application/pdf", byteSize: 1024 });
      expect.fail("expected .exe with spoofed application/pdf MIME to be rejected");
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe("KDL-UPLOAD-001");
    }
  });

  it("rejects a mismatched, non-generic MIME/extension pair even when both are individually supported types", () => {
    try {
      validateFileMetadata({ filename: "notes.txt", mimeType: "application/pdf", byteSize: 1024 });
      expect.fail("expected mismatched MIME/extension to be rejected");
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe("KDL-UPLOAD-001");
    }
  });

  it("rejects a zero-byte file with KDL-UPLOAD-003", () => {
    try {
      validateFileMetadata({ filename: "empty.pdf", mimeType: "application/pdf", byteSize: 0 });
      expect.fail("expected empty file to be rejected");
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe("KDL-UPLOAD-003");
    }
  });

  it("rejects a file above the size cap with KDL-UPLOAD-002", () => {
    try {
      validateFileMetadata({
        filename: "huge.pdf",
        mimeType: "application/pdf",
        byteSize: MAX_UPLOAD_BYTES + 1,
      });
      expect.fail("expected oversize file to be rejected");
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe("KDL-UPLOAD-002");
    }
  });

  it("accepts a file exactly at the size cap", () => {
    expect(() =>
      validateFileMetadata({ filename: "big.pdf", mimeType: "application/pdf", byteSize: MAX_UPLOAD_BYTES }),
    ).not.toThrow();
  });
});
