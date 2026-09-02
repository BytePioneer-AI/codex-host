import path from "node:path";

import { defaultExclude, defineConfig } from "vitest/config";

export default defineConfig({
  root: path.resolve(import.meta.dirname, ".."),
  test: {
    environment: "node",
    include: [
      "packages/**/test/**/*.test.ts",
      "tests/release/**/*.test.mjs",
      "tools/**/*.test.mjs",
    ],
    exclude: [...defaultExclude, "**/._*"],
    maxWorkers: 4,
    passWithNoTests: false,
  },
});
