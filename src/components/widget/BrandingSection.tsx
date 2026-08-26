"use client";

/**
 * Widget screen Branding panel (ADMIN-04): Product name, Logo, Accent colour. Part of
 * `WidgetPageClient`'s single form — every change here flows up via `onChange` into the parent's
 * draft `WidgetConfig`, which `WidgetPreview` also reads for its live, unsaved-edit preview.
 *
 * Logo storage decision (Claude's Discretion — see 03-09-SUMMARY.md): read client-side, validated
 * against `src/lib/widget/logo-constraints.ts` (the SAME registry the rendered constraint-chip row
 * reads — never a second hardcoded list), and stored as a data URL. No file-storage dependency.
 *
 * Accent colour contrast (UI-SPEC Color section): recomputed on every keystroke via
 * `contrastRatioAgainstWhite`, real arithmetic (S-5). Below 4.5:1 the warning renders with the real
 * number — non-blocking, never a silent substitution; the buyer owns their brand colour.
 */

import { useRef, useState } from "react";
import { contrastRatioAgainstWhite, MIN_ACCESSIBLE_CONTRAST_RATIO } from "../../lib/widget/contrast.js";
import { ACCEPTED_LOGO_TYPES, MAX_LOGO_BYTES, validateLogoFile } from "../../lib/widget/logo-constraints.js";

const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
const MAX_LOGO_KB = Math.round(MAX_LOGO_BYTES / 1024);

interface BrandingSectionProps {
  productName: string;
  logoUrl: string | null;
  accentColor: string;
  onChange: (patch: Partial<{ productName: string; logoUrl: string | null; accentColor: string }>) => void;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the file."));
    reader.readAsDataURL(file);
  });
}

export default function BrandingSection({ productName, logoUrl, accentColor, onChange }: BrandingSectionProps) {
  const [logoError, setLogoError] = useState<string | null>(null);
  const [accentInput, setAccentInput] = useState(accentColor);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  async function handleLogoChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    const result = validateLogoFile(file);
    if (!result.ok) {
      setLogoError(result.reason ?? "That file could not be used.");
      return;
    }
    setLogoError(null);
    try {
      const dataUrl = await readFileAsDataUrl(file);
      onChange({ logoUrl: dataUrl });
    } catch {
      setLogoError("That file could not be read. Try again.");
    }
  }

  function handleAccentChange(value: string) {
    setAccentInput(value);
    if (HEX_COLOR_PATTERN.test(value)) {
      onChange({ accentColor: value });
    }
  }

  const contrastRatio = HEX_COLOR_PATTERN.test(accentInput) ? contrastRatioAgainstWhite(accentInput) : null;
  const showContrastWarning = contrastRatio !== null && contrastRatio < MIN_ACCESSIBLE_CONTRAST_RATIO;

  return (
    <section className="panel widget-form-panel" data-testid="branding-section">
      <div className="panel__header">
        <div className="panel__title">Branding</div>
      </div>
      <div className="panel__body widget-form-panel__body">
        <label className="widget-form-field">
          <span className="widget-form-field__label">Product name</span>
          <input
            type="text"
            value={productName}
            maxLength={60}
            onChange={(e) => onChange({ productName: e.target.value })}
            aria-label="Product name"
          />
        </label>

        <div className="widget-form-field">
          <span className="widget-form-field__label">Logo</span>
          <div className="widget-logo-row">
            <div className="widget-logo-preview" aria-hidden="true">
              {logoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- buyer-supplied data URL, not an optimizable local asset.
                <img src={logoUrl} alt="" />
              ) : (
                <span className="widget-logo-preview__monogram">{productName.charAt(0).toUpperCase() || "K"}</span>
              )}
            </div>
            <div className="widget-logo-actions">
              <button
                type="button"
                className="btn btn-secondary btn-small"
                onClick={() => fileInputRef.current?.click()}
              >
                {logoUrl ? "Replace logo" : "Upload logo"}
              </button>
              {logoUrl ? (
                <button
                  type="button"
                  className="btn btn-secondary btn-small"
                  onClick={() => onChange({ logoUrl: null })}
                >
                  Remove logo
                </button>
              ) : null}
              <input
                ref={fileInputRef}
                type="file"
                accept={ACCEPTED_LOGO_TYPES.map((t) => t.mime).join(",")}
                onChange={(e) => void handleLogoChange(e)}
                className="visually-hidden"
                aria-label="Choose a logo file"
              />
            </div>
          </div>
          <div className="upload-dropzone__types" data-testid="logo-constraint-chips">
            {ACCEPTED_LOGO_TYPES.map((t) => (
              <span key={t.mime} className="upload-dropzone__chip">
                {t.label}
              </span>
            ))}
            <span className="upload-dropzone__limit">up to {MAX_LOGO_KB}KB</span>
          </div>
          {logoError ? (
            <p role="alert" className="widget-form-field__error">
              {logoError}
            </p>
          ) : null}
        </div>

        <div className="widget-form-field">
          <span className="widget-form-field__label">Accent colour</span>
          <div className="widget-accent-row">
            <input
              type="color"
              value={HEX_COLOR_PATTERN.test(accentInput) ? accentInput : "#0E4F4A"}
              onChange={(e) => handleAccentChange(e.target.value)}
              aria-label="Accent colour picker"
              className="widget-accent-swatch"
            />
            <input
              type="text"
              value={accentInput}
              onChange={(e) => handleAccentChange(e.target.value)}
              aria-label="Accent colour hex value"
              className="widget-accent-hex"
              maxLength={7}
            />
          </div>
          {showContrastWarning && contrastRatio !== null ? (
            <p className="widget-form-field__warning" data-testid="contrast-warning">
              This colour has a contrast ratio of {contrastRatio.toFixed(1)}:1 against white text — under 4.5:1 may
              be hard to read. You can still save it.
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}
