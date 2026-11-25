import { globSync } from "node:fs";
import path from "node:path";

import { configDefaults, defineConfig } from "vitest/config";

import { isPlatformTest } from "./platform-tests.mjs";

const root = path.resolve(import.meta.dirname, "..");

const include = [
  "packages/**/test/**/*.test.ts",
  "tests/integration/**/*.test.ts",
  "apps/web-ui/packages/api/session-controller/test/archived-query.test.ts",
  "apps/web-ui/packages/api/session-controller/test/prompt-delivery.test.ts",
  "apps/web-ui/packages/client/connection/test/*.test.ts",
  "apps/web-ui/packages/client/ui-conversation/test/*.test.ts",
  "apps/web-ui/packages/client/ui-input-trigger/test/*.test.ts",
  "apps/web-ui/packages/client/ui-primitives/test/*.test.ts",
  "apps/web-ui/packages/client/ui-sidebar-browser/test/*.test.ts",
  "apps/web-ui/packages/client/ui-sidebar-documentpreview/test/*.test.ts",
  "apps/web-ui/packages/client/hmr/tests/*.spec.ts",
  "packages/repository-automation/test/**/*.test.mjs",
  "tests/release/**/*.test.mjs",
  "tools/**/*.test.mjs",
];

// CODEXHOST_TEST_SCOPE=platform runs only platform-sensitive files. Secondary
// OS lanes (macOS and Windows) use it; Linux x64 covers pure-logic files.
// Linux ARM64 CI runs native checks and package smoke instead of TS tests.
function platformIndependentFiles() {
  return globSync(include, { cwd: root, exclude: (name) => name === "node_modules" })
    .map((file) => file.replaceAll("\\", "/"))
    .filter((file) => !isPlatformTest(path.join(root, file)));
}

const platformOnly = process.env.CODEXHOST_TEST_SCOPE === "platform";

export default defineConfig({
  root,
  test: {
    environment: "node",
    include,
    // Imported DSH packages expose their TypeScript sources; Vite must transform
    // them instead of handing them to Node's native loader.
    server: { deps: { inline: [/@deepseek-ai\//] } },
    // The Web Host owns Node test-runner suites, invoked by npm run test:web.
    exclude: [
      ...configDefaults.exclude,
      "packages/web-server/test/**",
      // Native service tests use Node's runner after building the Rust Launcher.
      "packages/host-runtime/test/native/**",
      ...(platformOnly ? platformIndependentFiles() : []),
    ],
    maxWorkers: 4,
    passWithNoTests: false,
    // Hosted Windows runners have highly variable disk latency (fsync + rename
    // under real-time scanning): the same Mapping Store suite ranges from
    // ~0.4s to ~10s between runs. Keep the default elsewhere so real hangs
    // still fail fast.
    ...(process.platform === "win32" ? { testTimeout: 20_000, hookTimeout: 30_000 } : {}),
  },
});
