import type { NextConfig } from "next";

/**
 * `output: "standalone"` is what makes DELIV-01's `npx` packaging possible at all — it produces
 * a self-contained `.next/standalone/server.js` with no `node_modules` needed at runtime (see
 * RESEARCH.md's "Pattern: npx packaging").
 *
 * `serverExternalPackages` keeps `unpdf` and `mammoth` out of the server bundle so Next.js does
 * not try to inline their worker/binary assets — both are pure-JS parsers invoked at request
 * time during ingestion, not something the bundler needs to tree-shake into client code.
 */
const nextConfig: NextConfig = {
  output: "standalone",
  /**
   * REMOVED: serverExternalPackages: ["unpdf", "mammoth"].
   *
   * It broke every upload in the packaged build. Turbopack rewrites a server-external package into
   * a hashed synthetic id and then cannot resolve it inside `.next/standalone`, so `POST /api/ingest`
   * died with:
   *
   *   Failed to load external module mammoth-ea033c5d84d0b9b2:
   *   Cannot find module 'mammoth-ea033c5d84d0b9b2'
   *
   * The request returned a bodyless 500 and the UI sat on "Uploading…" forever. It reproduces only
   * in the packaged standalone build — `npm run dev` resolves the real module and works — which is
   * why no test, typecheck or build gate caught it.
   *
   * The original rationale was to stop the bundler inlining worker/binary assets. That does not
   * apply here: `unpdf` ships self-contained ESM (`dist/index.mjs` + `dist/pdfjs.mjs`, zero
   * dependencies) and `mammoth` is pure JS. Both bundle cleanly.
   */
  /**
   * The app renders no images — there is no `next/image` usage anywhere in `src/`. Left at its
   * default, Next's image optimizer pulls `sharp` into the standalone trace, and `npm run package`
   * was shipping `@img/sharp-darwin-arm64/lib/sharp-darwin-arm64-0.35.3.node` — a **macOS ARM64
   * native binary** — inside a tarball intended for any buyer's machine.
   *
   * That breaks the premise the whole `npx` delivery rests on. Phase 1 chose `node:sqlite`, `unpdf`
   * and `mammoth` specifically so nothing in the runtime path needs `node-gyp` or a platform build,
   * because a native-module failure on a buyer's Windows or Alpine machine is the one support
   * ticket that cannot be resolved remotely (PITFALLS.md, pitfall 10). A prebuilt darwin-arm64
   * `.node` would simply be the wrong architecture everywhere except this developer's laptop.
   *
   * `unoptimized: true` tells Next it does not need an image optimizer, so `sharp` is never traced.
   * If image rendering is ever added, this must be revisited deliberately — and whatever replaces
   * it must not reintroduce a per-platform binary.
   */
  images: { unoptimized: true },
  /**
   * `images.unoptimized` alone does NOT stop the tracer — verified by rebuilding and finding
   * `sharp-darwin-arm64-0.35.3.node` still in the tarball. Next traces `sharp` into the standalone
   * output whenever it is resolvable in `node_modules`, regardless of whether the optimizer runs.
   * This exclusion is what actually keeps a platform-specific binary out of a cross-platform
   * package.
   */
  outputFileTracingExcludes: {
    "*": ["node_modules/@img/**", "node_modules/sharp/**"],
  },
};

export default nextConfig;
