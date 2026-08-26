/**
 * Global vitest setup. Extends `expect` with `@testing-library/jest-dom`'s matchers
 * (`toBeInTheDocument`, `toHaveTextContent`, etc.) for the React component tests plan 02-08/02-09
 * add. Safe to load for every test file regardless of environment — `jest-dom`'s matcher
 * functions only touch DOM APIs when actually invoked against a rendered node, never at import
 * time, so the `node`-environment storage/pipeline suites are unaffected by this being global.
 *
 * The type augmentation below targets `@vitest/expect` directly rather than `vitest` — vitest 4
 * re-exports `Assertion` from `@vitest/expect` (`export { Assertion, ... } from '@vitest/expect'`
 * in `vitest`'s own `dist/index.d.ts`), and TypeScript's `declare module 'vitest'` interface-merge
 * does not attach to a symbol that is only re-exported, not originally declared, in that module —
 * `@testing-library/jest-dom/vitest`'s own shipped `declare module 'vitest'` augmentation is a
 * no-op under this package's module graph as a result. Augmenting `@vitest/expect` (the module
 * where `Assertion` is actually declared) is the fix.
 *
 * Deliberately does NOT lift `DATABASE_URL`/`BLOB_READ_WRITE_TOKEN` out of `.env.local` into
 * `process.env` globally (removed in plan 03-05, Task 2 — see
 * `src/lib/storage/test-cloud-env.ts`'s header comment for the full incident). `process.env` is
 * scoped to the worker PROCESS, not to a single test file's module registry, so a global lift here
 * silently leaked a live `DATABASE_URL` into every OTHER test file that happened to share a reused
 * worker thread — once `getStorageDriver()` grew a real `PRODUCT_CONFIG.cloudMode` branch, that
 * leak routed unrelated local-SQLite tests to the real Neon database. Opt-in live suites
 * (`schema.pg.test.ts`, `driver-conformance.test.ts`, `postgres.test.ts`) read their credential via
 * `readCloudTestEnv()` instead, which never mutates `process.env`.
 */
import "@testing-library/jest-dom/vitest";
import type { TestingLibraryMatchers } from "@testing-library/jest-dom/matchers";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- must match `@vitest/expect`'s
// own `Assertion<T = any>` declaration exactly, or TS2428 (mismatched type parameter defaults).
declare module "@vitest/expect" {
  interface Assertion<T = any> extends TestingLibraryMatchers<any, T> {}
  interface AsymmetricMatchersContaining extends TestingLibraryMatchers<any, any> {}
}
