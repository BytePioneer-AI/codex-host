import path from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  root: path.resolve(import.meta.dirname, ".."),
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
    // A shared CI runner is slower and noisier than a developer machine, and
    // Windows is slower still for process spawns, ESM imports, and native
    // module loads. The 5s default is calibrated for local runs, so on CI it
    // turns ordinary scheduling variance into a red build.
    testTimeout: process.env.CI ? 30_000 : 5_000,
    setupFiles: [path.resolve(import.meta.dirname, "support/timeouts.ts")],
  },
});
