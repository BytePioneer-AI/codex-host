import { globSync, readFileSync } from "node:fs";
import path from "node:path";

import { configDefaults, defineConfig } from "vitest/config";

const root = path.resolve(import.meta.dirname, "..");
const include = [
  "packages/**/test/**/*.test.ts",
  "packages/repository-automation/test/**/*.test.mjs",
  "tests/release/**/*.test.mjs",
  "tools/**/*.test.mjs",
];

// A test file touches OS behavior when it uses the filesystem, processes,
// paths, the environment, or branches on the platform.
const platformSensitive =
  /node:(fs|child_process|os|path|net|worker_threads|url)|process\.(platform|env|execPath|kill|pid)|win32|tmpdir|spawn|execFile|MappingStore|mkdtemp|\.exe\b|USERPROFILE|APPDATA|\\\\/;

// CODEXHOST_TEST_SCOPE=platform runs only platform-sensitive files. Secondary
// OS lanes (Windows) use it; pure-logic files keep full coverage on the
// Linux, macOS, and Linux ARM64 lanes.
function platformIndependentFiles() {
  return globSync(include, { cwd: root, exclude: (name) => name === "node_modules" })
    .map((file) => file.replaceAll("\\", "/"))
    .filter((file) => !platformSensitive.test(readFileSync(path.join(root, file), "utf8")));
}

const platformOnly = process.env.CODEXHOST_TEST_SCOPE === "platform";

export default defineConfig({
  root,
  build: {
    assetsInlineLimit: 100000,
  },
  test: {
    environment: "node",
    include,
    ...(platformOnly
      ? { exclude: [...configDefaults.exclude, ...platformIndependentFiles()] }
      : {}),
    maxWorkers: 4,
    passWithNoTests: false,
    // Hosted Windows runners have highly variable disk latency (fsync + rename
    // under real-time scanning): the same Mapping Store suite ranges from
    // ~0.4s to ~10s between runs. Keep the default elsewhere so real hangs
    // still fail fast.
    ...(process.platform === "win32" ? { testTimeout: 20_000, hookTimeout: 30_000 } : {}),
  },
});
