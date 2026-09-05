import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  auditHostBundleMetafile,
  auditHostBundleSource,
  buildReleaseHostBundle,
} from "../../packages/host-runtime/scripts/build-release.mjs";
import {
  buildPreinstalledHarnessPlugins,
  preinstalledHarnessPlugins,
} from "../../scripts/release/harness-plugins.mjs";

function validMetafile(extraInputs = {}) {
  return {
    inputs: {
      "packages/host-runtime/src/release-main.ts": {},
      "packages/host-runtime/src/app-server-host.ts": {},
      "packages/host-runtime/src/harness-plugin-loader.ts": {},
      "packages/host-runtime/src/installed-harness-plugins.ts": {},
      "packages/host-runtime/src/remote-app-server.ts": {},
      "packages/host-runtime/src/remote-control-app-server.ts": {},
      "packages/host-runtime/src/remote-socket-lock.ts": {},
      "packages/harness-broker/dist/index.js": {},
      "node_modules/zod/index.js": {},
      "node_modules/ws/index.js": {},
      ...extraInputs,
    },
  };
}

async function runPackagedHost(host, directory, requests) {
  const official = path.join(directory, "official.mjs");
  await writeFile(
    official,
    `
    import readline from "node:readline";
    for await (const line of readline.createInterface({ input: process.stdin })) {
      const request = JSON.parse(line);
      process.stdout.write(JSON.stringify({ id: request.id, result: { official: true } }) + "\\n");
    }
  `,
  );
  const environment = { ...process.env };
  for (const key of Object.keys(environment))
    if (key.startsWith("CODEXHOST_") || key === "NODE_PATH") delete environment[key];
  Object.assign(environment, {
    HOME: directory,
    USERPROFILE: directory,
    CODEXHOST_DATA_DIR: path.join(directory, "data"),
    CODEXHOST_PLUGIN_DIRECTORY: path.join(directory, "user-plugins"),
    CODEXHOST_STOCK_CODEX_PATH: process.execPath,
    CODEXHOST_DEFAULT_AGENT: "codex",
    CODEXHOST_CLAUDE_COMMAND: path.join(directory, "missing-claude"),
    CODEXHOST_ANTIGRAVITY_COMMAND: path.join(directory, "missing-antigravity"),
  });
  const child = spawn(process.execPath, [host, official], {
    cwd: directory,
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const lines = [];
  let buffer = "",
    stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      lines.push(JSON.parse(buffer.slice(0, end)));
      buffer = buffer.slice(end + 1);
    }
    if (requests.every(({ id }) => lines.some((line) => line.id === id))) child.stdin.end();
  });
  const closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
  });
  const timeout = setTimeout(() => child.kill(), 15_000);
  child.stdin.write(requests.map((request) => JSON.stringify(request)).join("\n") + "\n");
  try {
    const code = await closed;
    expect(code, stderr).toBe(0);
    return { lines, stderr };
  } finally {
    clearTimeout(timeout);
    child.kill();
  }
}

describe("release Host and independent plugin Bundles", () => {
  it("rejects generated plugin output paths that overlap source packages", async () => {
    const repositoryRoot = path.resolve(import.meta.dirname, "../..");
    for (const relative of [".", "packages/adapters/pi", "packages/adapters/pi/src"]) {
      await expect(
        buildPreinstalledHarnessPlugins({
          repositoryRoot,
          outputDirectory: path.resolve(repositoryRoot, relative),
        }),
      ).rejects.toThrow("must not overlap source packages");
    }
  });

  it("accepts a core-only closure", () => {
    expect(auditHostBundleMetafile(validMetafile())).toMatchObject({
      runtimePackages: ["ws", "zod"],
    });
  });

  it.each([
    "packages/adapters/pi/dist/plugin.js",
    "packages/adapters/claude-code/dist/plugin.js",
    "node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs",
    "node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/sdk.mjs",
    "node_modules/@opencode-ai/sdk/index.js",
  ])("rejects a concrete Adapter or Harness SDK leaking into Host: %s", (input) => {
    expect(() => auditHostBundleMetafile(validMetafile({ [input]: {} }))).toThrow(
      "forbidden inputs",
    );
  });

  it("rejects unreviewed packages, source maps and missing public components", () => {
    expect(() =>
      auditHostBundleMetafile(validMetafile({ "node_modules/unreviewed/index.js": {} })),
    ).toThrow("unreviewed runtime packages");
    expect(() => auditHostBundleSource('//# sourceMappingURL="host-runtime.mjs.map"')).toThrow(
      "forbidden references",
    );
    for (const input of [
      "remote-socket-lock",
      "remote-control-app-server",
      "harness-plugin-loader",
      "installed-harness-plugins",
    ]) {
      const meta = validMetafile();
      delete meta.inputs[`packages/host-runtime/src/${input}.ts`];
      expect(() => auditHostBundleMetafile(meta)).toThrow("missing required input");
    }
  });

  it("runs relocated release artifacts with seven plugins, an unknown plugin, and no plugins", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-plugin-release-"));
    const app = path.join(directory, "build", "app");
    const relocated = path.join(directory, "relocated runtime", "app");
    const repositoryRoot = path.resolve(import.meta.dirname, "../..");
    try {
      const hostAudit = await buildReleaseHostBundle({
        repositoryRoot,
        outputPath: path.join(app, "host-runtime.mjs"),
      });
      expect(hostAudit.runtimePackages).toEqual(["ws", "zod"]);
      const pluginAudits = await buildPreinstalledHarnessPlugins({
        repositoryRoot,
        outputDirectory: path.join(app, "plugins"),
      });
      const expectedIds = preinstalledHarnessPlugins().configuration.enabled;
      expect(pluginAudits.map(({ id }) => id)).toEqual(expectedIds);
      expect(pluginAudits.find(({ id }) => id === "claude-code").runtimePackages).toContain(
        "@anthropic-ai/claude-agent-sdk",
      );
      expect(pluginAudits.find(({ id }) => id === "grok").runtimePackages).toContain(
        "@agentclientprotocol/sdk",
      );
      expect(pluginAudits.find(({ id }) => id === "opencode").runtimePackages).toContain(
        "@opencode-ai/sdk",
      );
      expect(pluginAudits.find(({ id }) => id === "deepseek-harness").runtimePackages).toContain(
        "@deepseek-ai/dsh-host-apiproxy",
      );
      const source = await readFile(path.join(app, "host-runtime.mjs"), "utf8");
      expect(source).not.toContain("class ClaudeCodeAdapter");
      expect(source).not.toContain("Claude Code is not installed");
      expect(source).not.toContain("claude-agent-sdk");
      await mkdir(path.dirname(relocated), { recursive: true });
      await rename(app, relocated);
      const requests = [
        { id: 1, method: "codexhost/harness/plugins/list", params: {} },
        { id: 2, method: "initialize", params: {} },
      ];
      const first = await runPackagedHost(
        path.join(relocated, "host-runtime.mjs"),
        directory,
        requests,
      );
      expect(
        first.lines
          .find(({ id }) => id === 1)
          .result.plugins.map(({ id }) => id)
          .sort(),
      ).toEqual([...expectedIds].sort());
      expect(first.lines.find(({ id }) => id === 2)).toMatchObject({ result: { official: true } });
      expect(first.stderr).not.toMatch(/loadFailed|loadTimeout|Dynamic require/u);

      const userRoot = path.join(directory, "user-plugins");
      await mkdir(path.join(userRoot, "unknown-agent"), { recursive: true });
      await writeFile(
        path.join(userRoot, "enabled.json"),
        JSON.stringify({ version: 1, enabled: ["unknown-agent"] }),
      );
      await writeFile(
        path.join(userRoot, "unknown-agent", "manifest.json"),
        JSON.stringify({
          manifestVersion: 1,
          id: "unknown-agent",
          name: "Unknown Agent",
          version: "1",
          adapterApiVersion: 1,
          entry: "plugin.mjs",
        }),
      );
      await writeFile(
        path.join(userRoot, "unknown-agent", "plugin.mjs"),
        `
        export function createHarnessAdapter() {
          const error = { code: "unavailable", message: "synthetic", retryable: false };
          return { harnessId: "unknown-agent", inspect: async () => ({ status: "unavailable", error }), open: async () => ({ ok: false, error }), close: async () => {} };
        }
      `,
      );
      const extended = await runPackagedHost(
        path.join(relocated, "host-runtime.mjs"),
        directory,
        requests,
      );
      expect(
        extended.lines
          .find(({ id }) => id === 1)
          .result.plugins.map(({ id }) => id)
          .sort(),
      ).toEqual([...expectedIds, "unknown-agent"].sort());

      await rm(path.join(relocated, "plugins"), { recursive: true });
      await rm(userRoot, { recursive: true });
      const coreOnly = await runPackagedHost(
        path.join(relocated, "host-runtime.mjs"),
        directory,
        requests,
      );
      expect(coreOnly.lines.find(({ id }) => id === 1)).toMatchObject({ result: { plugins: [] } });
      expect(coreOnly.lines.find(({ id }) => id === 2)).toMatchObject({
        result: { official: true },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 45_000);
});
