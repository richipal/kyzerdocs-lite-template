/**
 * The single source of truth for the Widget screen's logo upload constraints (ADMIN-04, plan
 * 03-09). `BrandingSection.tsx` reads this same registry for BOTH client-side validation and the
 * rendered constraint-chip row — mirroring `src/lib/ingest/validate.ts`'s `EXTENSION_TO_MIME_TYPE`
 * pattern (see `UploadDropzone.tsx`'s own header comment) so the displayed types can never drift
 * from what is actually accepted.
 *
 * Logo storage decision (Claude's Discretion, recorded in 03-09-SUMMARY.md): the logo is read
 * client-side and stored as a data URL inside the `WidgetConfig` blob — it never touches file
 * storage. That keeps branding working identically in SQLite and Postgres, and before plan 03-10's
 * blob seam exists.
 */

export interface LogoTypeConstraint {
  label: string;
  mime: string;
}

/** Real, displayed types — PNG/SVG/JPG per the UI-SPEC's Surface 2 structural contract. */
export const ACCEPTED_LOGO_TYPES: LogoTypeConstraint[] = [
  { label: "PNG", mime: "image/png" },
  { label: "SVG", mime: "image/svg+xml" },
  { label: "JPG", mime: "image/jpeg" },
];

/** 512KB, per the UI-SPEC's Surface 2 structural contract ("≤512KB"). */
export const MAX_LOGO_BYTES = 512 * 1024;

export function isAcceptedLogoMimeType(mime: string): boolean {
  return ACCEPTED_LOGO_TYPES.some((t) => t.mime === mime);
}

export interface LogoValidationResult {
  ok: boolean;
  reason?: string;
}

/** Validates a browser `File`'s type and size against the registry above. Returns a stated reason
 * on rejection — S-5/S-6: a rejected upload must say exactly why, never silently drop it. */
export function validateLogoFile(file: { type: string; size: number }): LogoValidationResult {
  if (!isAcceptedLogoMimeType(file.type)) {
    const types = ACCEPTED_LOGO_TYPES.map((t) => t.label).join(", ");
    return { ok: false, reason: `That file type isn't supported. Upload a ${types} file.` };
  }
  if (file.size > MAX_LOGO_BYTES) {
    const maxKb = Math.round(MAX_LOGO_BYTES / 1024);
    return { ok: false, reason: `That file is too large. Upload an image ${maxKb}KB or smaller.` };
  }
  return { ok: true };
}
