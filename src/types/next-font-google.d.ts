/**
 * `next/font/google` is not a real module — Next.js's build pipeline (webpack/Turbopack)
 * special-cases the literal specifier `"next/font/google"` and swaps in a generated
 * implementation at build time (see `node_modules/next/dist/compiled/@next/font/google`).
 * The published `.d.ts` for it lives at a *directory* import with no explicit extension
 * (`next/font/google/index.d.ts`), which this project's `moduleResolution: "nodenext"` +
 * `"type": "module"` combination cannot resolve for a bare specifier (Node's ESM resolver does
 * not do implicit directory/index resolution the way CommonJS does — see the rest of this
 * codebase's Next.js subpath imports, which all carry an explicit `.js`, e.g. `next/navigation.js`).
 * Appending `.js` here would satisfy `tsc` but breaks Turbopack, which only applies its font
 * transform to the exact string `"next/font/google"`.
 *
 * This ambient declaration mirrors the real (generated) signatures for just the two font loaders
 * this app uses, sourced from
 * `node_modules/next/dist/compiled/@next/font/dist/google/index.d.ts`, so both the compiler and
 * the bundler are satisfied without fighting either one's resolution rules.
 */
declare module "next/font/google" {
  type CssVariable = `--${string}`;
  type Display = "auto" | "block" | "swap" | "fallback" | "optional";
  type NextFont = {
    className: string;
    style: { fontFamily: string; fontWeight?: number; fontStyle?: string };
  };
  type NextFontWithVariable = NextFont & { variable: string };

  export function IBM_Plex_Sans<T extends CssVariable | undefined = undefined>(options?: {
    weight?:
      | "100"
      | "200"
      | "300"
      | "400"
      | "500"
      | "600"
      | "700"
      | "variable"
      | Array<"100" | "200" | "300" | "400" | "500" | "600" | "700">;
    style?: "normal" | "italic" | Array<"normal" | "italic">;
    display?: Display;
    variable?: T;
    preload?: boolean;
    fallback?: string[];
    adjustFontFallback?: boolean;
    subsets?: Array<"cyrillic" | "cyrillic-ext" | "greek" | "latin" | "latin-ext" | "vietnamese">;
    axes?: "wdth"[];
  }): T extends undefined ? NextFont : NextFontWithVariable;

  export function IBM_Plex_Mono<T extends CssVariable | undefined = undefined>(options: {
    weight:
      | "100"
      | "200"
      | "300"
      | "400"
      | "500"
      | "600"
      | "700"
      | Array<"100" | "200" | "300" | "400" | "500" | "600" | "700">;
    style?: "normal" | "italic" | Array<"normal" | "italic">;
    display?: Display;
    variable?: T;
    preload?: boolean;
    fallback?: string[];
    adjustFontFallback?: boolean;
    subsets?: Array<"cyrillic" | "cyrillic-ext" | "latin" | "latin-ext" | "vietnamese">;
  }): T extends undefined ? NextFont : NextFontWithVariable;
}
