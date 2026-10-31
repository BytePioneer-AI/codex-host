import { globSync, readFileSync } from "node:fs";
import path from "node:path";

import ts from "typescript";
import { configDefaults, defineConfig } from "vitest/config";

const root = path.resolve(import.meta.dirname, "..");

const decoratorSyntax = /^\s*@[A-Za-z_$][\w$]*/m;

/**
 * Lower TypeScript standard decorators before Vite's default parser sees them.
 * Imported DSH Remote methods declare their endpoints with `@Remote`, and
 * Vite's SSR transform leaves standard decorators as syntax Node cannot parse.
 * Mirrors the imported repository's `standardDecoratorPlugin`.
 */
function standardDecoratorPlugin() {
  return {
    name: "dsh-standard-decorators",
    enforce: "pre",
    transform(code, id) {
      const file = id.split("?", 1)[0];
      if (!/\.[cm]?tsx?$/.test(file) || !decoratorSyntax.test(code)) return;
      const result = ts.transpileModule(code, {
        fileName: file,
        compilerOptions: {
          target: ts.ScriptTarget.ES2024,
          module: ts.ModuleKind.ESNext,
          jsx: file.endsWith("x") ? ts.JsxEmit.ReactJSX : undefined,
          sourceMap: true,
        },
      });
      return {
        code: result.outputText.replace(/\n?\/\/# sourceMappingURL=.*$/u, "\n"),
        map: result.sourceMapText,
      };
    },
  };
}
const include = [
  "packages/**/test/**/*.test.ts",
  "tests/integration/**/*.test.ts",
  "tests/dsh/**/*.spec.ts",
  "packages/repository-automation/test/**/*.test.mjs",
  "tests/release/**/*.test.mjs",
  "tools/**/*.test.mjs",
];

// A test file touches OS behavior when it uses the filesystem, processes,
// paths, the environment, or branches on the platform.
const platformSensitive =
  /node:(fs|child_process|os|path|net|worker_threads|url)|process\.(platform|env|execPath|kill|pid)|win32|tmpdir|spawn|execFile|MappingStore|mkdtemp|\.exe\b|USERPROFILE|APPDATA|\\\\/;

// CODEXHOST_TEST_SCOPE=platform runs only platform-sensitive files. Secondary
// OS lanes (macOS and Windows) use it; Linux x64 covers pure-logic files.
// Linux ARM64 CI runs native checks and package smoke instead of TS tests.
function platformIndependentFiles() {
  return globSync(include, { cwd: root, exclude: (name) => name === "node_modules" })
    .map((file) => file.replaceAll("\\", "/"))
    .filter((file) => !platformSensitive.test(readFileSync(path.join(root, file), "utf8")));
}

const platformOnly = process.env.CODEXHOST_TEST_SCOPE === "platform";

export default defineConfig({
  root,
  plugins: [standardDecoratorPlugin()],
  resolve: {
    alias: {
      // The built browser bundle registers into window.__ModuleLoader__, which
      // unit tests do not install; source mode is the same implementation.
      "@deepseek-ai/dsh-api-gateway/client": path.resolve(
        root,
        "apps/web-ui/packages/api/gateway/src/client/index.ts",
      ),
    },
  },
  build: {
    assetsInlineLimit: 100000,
  },
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
