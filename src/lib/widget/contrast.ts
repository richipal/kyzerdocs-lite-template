/**
 * WCAG relative-luminance contrast ratio (S-5, UI-SPEC Color section: ADMIN-04's buyer-custom
 * accent rule). Real arithmetic against the actual formula — sRGB channel linearisation, luminance
 * weighting, then `(lighter + 0.05) / (darker + 0.05)` — never a lookup table and never an
 * approximation. The number this module returns is exactly what `BrandingSection.tsx` interpolates
 * into the UI-SPEC's warning copy, so a wrong formula here would put a wrong number in front of the
 * buyer, which is precisely what S-5 exists to prevent.
 */

const HEX_PATTERN = /^#?([0-9a-fA-F]{6})$/;

/** WCAG 2.x sRGB channel linearisation — the piecewise function every reference implementation of
 * relative luminance uses (a straight division below the threshold, a gamma curve above it). */
function srgbChannelToLinear(channel8bit: number): number {
  const c = channel8bit / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance: `0.2126*R + 0.7152*G + 0.0722*B` over the linearised channels. */
function relativeLuminance(hex: string): number {
  const match = HEX_PATTERN.exec(hex);
  if (!match) {
    throw new Error(`contrastRatioAgainstWhite: "${hex}" is not a 6-digit hex colour.`);
  }
  const value = match[1]!;
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  const rLinear = srgbChannelToLinear(r);
  const gLinear = srgbChannelToLinear(g);
  const bLinear = srgbChannelToLinear(b);
  return 0.2126 * rLinear + 0.7152 * gLinear + 0.0722 * bLinear;
}

/** Contrast ratio of `hex` against white (`#FFFFFF`, relative luminance exactly 1), per WCAG's
 * `(lighter + 0.05) / (darker + 0.05)` formula. `#000000` -> 21, `#FFFFFF` -> 1. */
export function contrastRatioAgainstWhite(hex: string): number {
  const colorLuminance = relativeLuminance(hex);
  const whiteLuminance = 1;
  const lighter = Math.max(colorLuminance, whiteLuminance);
  const darker = Math.min(colorLuminance, whiteLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

/** UI-SPEC's threshold: below this, the buyer sees a non-blocking warning with the real ratio. */
export const MIN_ACCESSIBLE_CONTRAST_RATIO = 4.5;
