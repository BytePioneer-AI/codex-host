import path from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  root: path.resolve(import.meta.dirname, ".."),
  build: {
    assetsInlineLimit: 100000,
  },
  test: {
    environment: "node",
    include: [
      "packages/**/test/**/*.test.ts",
      "packages/repository-automation/test/**/*.test.mjs",
      "tests/release/**/*.test.mjs",
      "tools/**/*.test.mjs",
    ],
    maxWorkers: 4,
    passWithNoTests: false,
  },
});
