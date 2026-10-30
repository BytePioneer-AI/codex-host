import { defineConfig } from "vitest/config";

import baseConfig from "./vitest.config.js";

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: ["packages/adapters/deepseek-harness/test/**/*.test.ts"],
    coverage: {
      enabled: true,
      provider: "v8",
      include: ["packages/adapters/deepseek-harness/src/**/*.ts"],
      reporter: ["text", "json-summary", "html"],
      reportsDirectory: "coverage/deepseek-harness",
      thresholds: { statements: 80, branches: 80, functions: 80, lines: 80 },
    },
  },
});
