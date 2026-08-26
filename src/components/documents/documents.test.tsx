// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import DocumentsPageClient from "../../app/(admin)/documents/DocumentsPageClient.js";
import DocumentList, { type DocumentEntry } from "./DocumentList.js";
import DocumentRow from "./DocumentRow.js";
import UploadDropzone from "./UploadDropzone.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("UploadDropzone — client-side type gating (ING-01)", () => {
  it("dropping a .pptx file renders a rejection containing KDL-UPLOAD-001 and issues no POST /api/ingest", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const onUploadResolved = vi.fn();
    const onUploadFailed = vi.fn();
    const onUploadStarted = vi.fn();

    render(
      <UploadDropzone
        onUploadResolved={onUploadResolved}
        onUploadFailed={onUploadFailed}
        onUploadStarted={onUploadStarted}
      />,
    );

    const input = screen.getByLabelText("Choose files to upload");
    const file = new File(["not really a pptx"], "slides.pptx", {
      type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    });

    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("KDL-UPLOAD-001");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(onUploadStarted).not.toHaveBeenCalled();
    expect(onUploadFailed).toHaveBeenCalledWith(
      "slides.pptx",
      expect.objectContaining({ code: "KDL-UPLOAD-001" }),
    );
  });
});

describe("DocumentRow — failure rendering (SUPP-01)", () => {
  it("renders errorCode, message, and action as visible text for a failed document", () => {
    const doc: DocumentEntry = {
      id: "doc-2",
      filename: "scanned.pdf",
      status: "failed",
      errorCode: "KDL-PARSE-001",
      pageCount: null,
      chunkCount: 0,
      createdAt: "",
      updatedAt: "",
    };

    render(
      <ul>
        <DocumentRow document={doc} onDelete={() => {}} deleting={false} />
      </ul>,
    );

    const reason = screen.getByTestId("failure-reason");
    expect(reason).toHaveTextContent("KDL-PARSE-001");
    expect(reason).toHaveTextContent("scanned PDF");
    expect(reason).toHaveTextContent("OCR");
  });
});

describe("DocumentList — per-job polling (ING-03/T-02-08-04)", () => {
  it("renders parsing -> embedding (chunk count advancing) -> ready in sequence and stops polling after ready", async () => {
    vi.useFakeTimers();
    try {
      const responses = [
        {
          status: "embedding",
          phase: "embedding",
          chunksTotal: 10,
          chunksProcessed: 3,
          errorCode: null,
          errorMessage: null,
          action: null,
          updatedAt: "",
        },
        {
          status: "embedding",
          phase: "embedding",
          chunksTotal: 10,
          chunksProcessed: 7,
          errorCode: null,
          errorMessage: null,
          action: null,
          updatedAt: "",
        },
        {
          status: "ready",
          phase: "ready",
          chunksTotal: 10,
          chunksProcessed: 10,
          errorCode: null,
          errorMessage: null,
          action: null,
          updatedAt: "",
        },
      ];
      let callIndex = 0;
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
        const body = responses[Math.min(callIndex, responses.length - 1)]!;
        callIndex++;
        return jsonResponse(body);
      });

      function Harness() {
        const [documents, setDocuments] = useState<DocumentEntry[]>([
          {
            id: "doc-1",
            filename: "safety.pdf",
            status: "parsing",
            errorCode: null,
            pageCount: null,
            chunkCount: 0,
            createdAt: "",
            updatedAt: "",
            jobId: "job-1",
          },
        ]);
        return (
          <DocumentList
            documents={documents}
            onDocumentUpdate={(id, patch) =>
              setDocuments((prev) => prev.map((d) => (d.id === id ? { ...d, ...patch } : d)))
            }
            onDelete={() => {}}
            deletingId={null}
          />
        );
      }

      render(<Harness />);
      expect(screen.getByTestId("status-chip")).toHaveTextContent("Parsing");

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1500);
      });
      expect(screen.getByTestId("status-chip")).toHaveTextContent("Embedding");
      expect(screen.getByTestId("document-row")).toHaveTextContent("3 chunks embedded of 10");

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1500);
      });
      expect(screen.getByTestId("document-row")).toHaveTextContent("7 chunks embedded of 10");

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1500);
      });
      expect(screen.getByTestId("status-chip")).toHaveTextContent("Ready");

      const callsAfterReady = fetchSpy.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6000);
      });
      expect(fetchSpy.mock.calls.length).toBe(callsAfterReady);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("DocumentsPage — delete flow (ING-05)", () => {
  it("delete issues DELETE /api/documents/<id> and removes the row on 204", async () => {
    vi.stubGlobal("confirm", vi.fn(() => true));

    const doc = {
      id: "doc-3",
      filename: "manual.pdf",
      status: "ready" as const,
      errorCode: null,
      pageCount: 5,
      chunkCount: 12,
      createdAt: "",
      updatedAt: "",
    };

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/documents") {
        return jsonResponse({ documents: [doc] });
      }
      if (url === "/api/health") {
        return jsonResponse({
          database: { ok: true },
          apiKey: { ok: true },
          embedding: { ok: true },
          chatProvider: { ok: true },
        });
      }
      if (url === `/api/documents/${doc.id}`) {
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected fetch in delete-flow test: ${url}`);
    });

    render(<DocumentsPageClient cloudMode={false} />);

    await screen.findByText("manual.pdf");

    const deleteButton = screen.getByRole("button", { name: /delete/i });
    await act(async () => {
      fireEvent.click(deleteButton);
    });

    await waitFor(() => {
      expect(screen.queryByText("manual.pdf")).not.toBeInTheDocument();
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(`/api/documents/${doc.id}`, { method: "DELETE" });
  });
});
