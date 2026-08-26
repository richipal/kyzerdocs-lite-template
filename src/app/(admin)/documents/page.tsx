import { PRODUCT_CONFIG } from "../../../lib/config.js";
import DocumentsPageClient from "./DocumentsPageClient.js";

/**
 * GET /documents — Screen 1 of the two-screen UI (D2-13). Server component: its only job is to
 * read `PRODUCT_CONFIG.cloudMode` on the server (D3-16) and hand it down as a plain boolean —
 * mirroring `src/app/(admin)/widget/page.tsx`'s `WidgetPageClient` split (plan 03-09) — because
 * `PRODUCT_CONFIG` carries secrets that must never reach a client bundle, and `UploadDropzone`
 * needs a REAL cloud-mode signal to decide whether to upload via `@vercel/blob/client` (STOR-06,
 * plan 03-10) rather than one that always evaluates `false` in the browser.
 */
export default function DocumentsPage() {
  return <DocumentsPageClient cloudMode={PRODUCT_CONFIG.cloudMode} />;
}
