import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it, vi } from "vitest";
import type { HarnessInspection } from "@codexhost/harness-adapter";
import { warmup as warmupClaude } from "@codexhost/adapter-claude-code/plugin";
import { warmup as warmupAntigravity } from "@codexhost/adapter-antigravity/plugin";

import { installedHarnessPluginOptions, loadHarnessPlugins } from "../src/index.js";

const sourceRuntimeUrl = pathToFileURL(path.resolve("packages/host-runtime/dist/main.js")).href;
const pluginRoot = path.resolve("packages/host-runtime/dist/plugins");
const classes = {
  pi: "PiAdapter",
  "claude-code": "ClaudeCodeAdapter",
  "deepseek-harness": "DeepSeekHarnessAdapter",
  opencode: "OpenCodeAdapter",
  grok: "GrokAdapter",
  omp: "OmpAdapter",
  antigravity: "AntigravityAdapter",
};

const unavailable: HarnessInspection = {
  status: "notInstalled",
  error: { code: "notInstalled", message: "synthetic", retryable: false },
};

function load(environment: NodeJS.ProcessEnv = {}) {
  return loadHarnessPlugins({
    roots: [pluginRoot],
    context: {
      environment: { PATH: "", ...environment },
      platform: process.platform,
      managedRemoteHost: false,
    },
    warmup: false,
  });
}

describe("installed Harness composition", () => {
  it.each([
    ["Claude Code", warmupClaude],
    ["Antigravity", warmupAntigravity],
  ] as const)(
    "preserves %s best-effort asynchronous prefetch inside the plugin",
    async (_name, warmup) => {
      const deferred = Promise.withResolvers<HarnessInspection>();
      const inspect = vi.fn(() => deferred.promise);
      const prefetch = warmup({ inspect });
      expect(inspect).toHaveBeenCalledOnce();
      deferred.resolve(unavailable);
      await expect(prefetch).resolves.toBeUndefined();
      await expect(
        warmup({
          inspect: async () => {
            throw new Error("synthetic");
          },
        }),
      ).resolves.toBeUndefined();
    },
  );

  it("loads all seven preinstalled plugin factories without static registration or executable discovery", async () => {
    const registry = await load();
    try {
      expect(
        registry
          .list()
          .map(({ id }) => id)
          .sort(),
      ).toEqual(Object.keys(classes).sort());
      for (const [id, adapter] of registry.adapters) {
        expect(adapter.harnessId).toBe(id);
        // esbuild may suffix class names when a plugin contains two protocol generations.
        expect(adapter.constructor.name.replace(/\d+$/u, "")).toBe(
          classes[id as keyof typeof classes],
        );
      }
      expect(registry.list().find(({ id }) => id === "omp")?.icon).toMatch(
        /^data:image\/svg\+xml/u,
      );
    } finally {
      await registry.close();
    }
  });

  it.each([
    ["pi", "CODEXHOST_PI_COMMAND"],
    ["claude-code", "CODEXHOST_CLAUDE_COMMAND"],
    ["grok", "CODEXHOST_GROK_COMMAND"],
    ["opencode", "CODEXHOST_OPENCODE_COMMAND"],
    ["omp", "CODEXHOST_OMP_COMMAND"],
    ["antigravity", "CODEXHOST_ANTIGRAVITY_COMMAND"],
  ])(
    "preserves the explicit %s command rather than finding another local installation",
    async (id, commandVariable) => {
      const registry = await load({ [commandVariable]: path.resolve(".missing-fixture", id) });
      try {
        const adapter = [...registry.adapters].find(([key]) => key === id)?.[1];
        expect(await adapter?.inspect()).toMatchObject({
          status: "notInstalled",
          error: { code: "notInstalled" },
        });
      } finally {
        await registry.close();
      }
    },
  );

  it("keeps managed macOS execution behind the plugin's Broker with no direct CLI fallback", async () => {
    const registry = await loadHarnessPlugins({
      roots: [pluginRoot],
      context: {
        environment: { PATH: "", CODEXHOST_CLAUDE_COMMAND: "/must/not/spawn/in/background" },
        platform: "darwin",
        managedRemoteHost: true,
        brokerDescriptorPath: path.resolve(".missing-fixture", "broker.json"),
      },
      warmup: false,
    });
    try {
      const adapter = [...registry.adapters].find(([id]) => id === "claude-code")?.[1];
      expect(adapter?.constructor.name).toBe("BrokeredHarnessAdapter");
      expect(await adapter?.inspect()).toMatchObject({
        status: "unavailable",
        error: { code: "unavailable", stage: "harnessBroker" },
      });
    } finally {
      await registry.close();
    }
  });

  it("creates independent instances for concurrent Host connections", async () => {
    const [first, second] = await Promise.all([load(), load()]);
    try {
      for (const [id, adapter] of first.adapters) expect(adapter).not.toBe(second.adapters.get(id));
      await first.close();
      expect(second.list()).toHaveLength(7);
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });

  it("derives preinstalled resources from the actual runtime, not cwd or a local Host's resources", () => {
    const data = path.resolve("fixture", "data");
    const local = installedHarnessPluginOptions(
      { CODEXHOST_DATA_DIR: data },
      false,
      sourceRuntimeUrl,
    );
    expect(local.pluginRoots).toEqual([pluginRoot, path.join(data, "plugins")]);
    const remoteRuntimeUrl = pathToFileURL(
      path.resolve("remote", "runtime", "app", "host-runtime.mjs"),
    ).href;
    const remote = installedHarnessPluginOptions(
      { CODEXHOST_DATA_DIR: data },
      true,
      remoteRuntimeUrl,
    );
    expect(remote.pluginRoots[0]).toBe(path.resolve("remote", "runtime", "app", "plugins"));
    expect(remote.pluginContext.openLocalUrl).toBeUndefined();
  });
});
