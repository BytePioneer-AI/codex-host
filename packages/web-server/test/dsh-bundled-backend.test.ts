import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { it } from "node:test";

import { build } from "esbuild";

it("keeps the workspace changes wire fields under a bundled build", async (t) => {
  // Keep the bundle under the repository so external CJS packages resolve
  // their own package files from the hoisted node_modules.
  const scratch = resolve(import.meta.dirname, "../../../.work");
  if (!existsSync(scratch)) mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "dsh-bundled-backend-"));
  t.after(() => {
    if (process.env.KEEP_DEBUG === undefined) rmSync(root, { recursive: true, force: true });
  });
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(join(root, "app"), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "bundle-check", version: "0.0.0" }),
  );
  const entry = join(root, "entry.ts");
  writeFileSync(
    entry,
    `import { createDshWebBackend } from "@codexhost/dsh-web-backend";\n` +
      `const backend = await createDshWebBackend({\n` +
      `  workspaceRoot: ${JSON.stringify(workspace)},\n` +
      `  threadWorkspace: (id) => (id === "local-thread" ? ${JSON.stringify(workspace)} : undefined),\n` +
      `});\n` +
      `const controller = new AbortController();\n` +
      `const stream = await backend.openStream("workspaceFiles/changes", {\n` +
      `  workspaceFileScopeId: "local-thread",\n` +
      `  path: ${JSON.stringify(workspace)},\n` +
      `}, controller.signal);\n` +
      `const first = await stream[Symbol.asyncIterator]().next();\n` +
      `console.log(JSON.stringify(first.value));\n` +
      `controller.abort();\n` +
      `await backend.close();\n`,
  );
  const bundle = join(root, "app/backend.mjs");
  await build({
    entryPoints: [entry],
    outfile: bundle,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    external: ["node-pty", "koffi", "@deepseek-ai/libreoffice-kit"],
    banner: {
      js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
    },
    logLevel: "warning",
  });
  const output = await new Promise<string>((resolveOutput, reject) => {
    import("node:child_process").then(({ execFile }) => {
      execFile(process.execPath, [bundle], { timeout: 30_000 }, (error, stdout, stderr) => {
        if (error) reject(new Error(`${error.message}\n${stderr}`));
        else resolveOutput(stdout);
      });
    }, reject);
  });
  assert.deepEqual(JSON.parse(output.trim()), { kind: "ready" });
});
