import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // `.tsx` is required for React component tests (plans 02-08/02-09). The default `node`
    // environment below still applies to all of them; component test files opt into `jsdom` per
    // file via a `// @vitest-environment jsdom` docblock rather than switching the whole suite,
    // since every non-UI test here needs the real `node:sqlite`/filesystem environment.
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "evals/**/*.test.ts"],
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
  },
});
