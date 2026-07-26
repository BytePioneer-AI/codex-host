import path from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  root: path.resolve(import.meta.dirname, ".."),
  test: {
    environment: "node",
    include: ["packages/**/test/**/*.test.ts", "tools/**/*.test.mjs"],
    passWithNoTests: false,
  },
});
