import path from "node:path";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { harnessIdSchema } from "@codexhost/shared-contracts";
import type { HarnessInspection } from "@codexhost/harness-adapter";
import { warmup as warmupClaude } from "@codexhost/adapter-claude-code/plugin";
import { warmup as warmupAntigravity } from "@codexhost/adapter-antigravity/plugin";

import { installedHarnessPluginOptions, loadHarnessPlugins } from "../src/index.js";

const sourceRuntimeUrl = pathToFileURL(path.resolve("packages/host-runtime/dist/main.js")).href;
const pluginRoot = path.resolve("packages/host-runtime/dist/plugins");
const classes = {
  pi: "PiAdapter",
  copilot: "CopilotAdapter",
  "claude-code": "ClaudeCodeAdapter",
  "deepseek-harness": "DeepSeekHarnessAdapter",
  opencode: "OpenCodeAdapter",
  grok: "GrokAdapter",
  omp: "OmpAdapter",
  "qwen-code": "QwenCodeAdapter",
  antigravity: "AntigravityAdapter",
  "kimi-code": "KimiAdapter",
  "kiro-cli": "KiroAdapter",
  codebuddy: "CodeBuddyAdapter",
  workbuddy: "WorkBuddyAdapter",
  "cursor-cli": "CursorAdapter",
  devin: "DevinAdapter",
  hermes: "HermesAdapter",
  qoder: "QoderAdapter",
  "qoder-cn": "QoderAdapter",
  zcode: "ZcodeAdapter",
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
    loadTimeoutMs: 30_000,
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

  describe("explicit commands", () => {
    const commands: Array<[id: string, variable: string]> = [
      ["copilot", "CODEXHOST_COPILOT_COMMAND"],
      ["pi", "CODEXHOST_PI_COMMAND"],
      ["claude-code", "CODEXHOST_CLAUDE_COMMAND"],
      ["grok", "CODEXHOST_GROK_COMMAND"],
      ["opencode", "CODEXHOST_OPENCODE_COMMAND"],
      ["omp", "CODEXHOST_OMP_COMMAND"],
      ["qwen-code", "CODEXHOST_QWEN_COMMAND"],
      ["antigravity", "CODEXHOST_ANTIGRAVITY_COMMAND"],
      ["kiro-cli", "CODEXHOST_KIRO_COMMAND"],
      ["codebuddy", "CODEXHOST_CODEBUDDY_COMMAND"],
      ["workbuddy", "CODEXHOST_WORKBUDDY_COMMAND"],
      ["cursor-cli", "CODEXHOST_CURSOR_COMMAND"],
      ["devin", "CODEXHOST_DEVIN_COMMAND"],
      ["hermes", "CODEXHOST_HERMES_COMMAND"],
      ["qoder", "CODEXHOST_QODER_COMMAND"],
      ["qoder-cn", "CODEXHOST_QODERCN_COMMAND"],
    ];
    let registry: Awaited<ReturnType<typeof load>>;
    beforeAll(async () => {
      registry = await load(
        Object.fromEntries(
          commands.map(([id, variable]) => [variable, path.resolve(".missing-fixture", id)]),
        ),
      );
    }, 90_000);
    afterAll(async () => registry?.close());

    // Each case inspects a distinct Adapter; none of them opens a Session or closes the registry.
    it.each(commands)(
      "preserves the explicit %s command rather than finding another local installation",
      async (id) => {
        const adapter = [...registry.adapters].find(([key]) => key === id)?.[1];
        expect(await adapter?.inspect()).toMatchObject({
          status: "notInstalled",
          error: { code: id === "hermes" ? "HERMES_NOT_FOUND" : "notInstalled" },
        });
      },
      35_000,
    );
  });

  it("keeps managed macOS execution behind the plugin's Broker with no direct CLI fallback", async () => {
    const registry = await loadHarnessPlugins({
      roots: [pluginRoot],
      context: {
        environment: { PATH: "", CODEXHOST_CLAUDE_COMMAND: "/must/not/spawn/in/background" },
        platform: "darwin",
        managedRemoteHost: true,
        brokerDescriptorPath: path.resolve(".missing-fixture", "broker.json"),
      },
      loadTimeoutMs: 30_000,
      warmup: false,
    });
    try {
      const adapter = [...registry.adapters].find(([id]) => id === "claude-code")?.[1];
      expect(adapter?.constructor.name).toBe("BrokeredHarnessAdapter");
      expect(adapter?.commandCatalog?.commands.map(({ invocation }) => invocation)).toEqual([
        "/compact",
        "/init",
        "/recap",
      ]);
      expect(await adapter?.inspect()).toMatchObject({
        status: "unavailable",
        error: { code: "unavailable", stage: "harnessBroker" },
      });
    } finally {
      await registry.close();
    }
  }, 35_000);

  it("creates independent instances for concurrent Host connections", async () => {
    const [first, second] = await Promise.all([load(), load()]);
    try {
      for (const [id, adapter] of first.adapters) expect(adapter).not.toBe(second.adapters.get(id));
      await first.close();
      expect(second.list()).toHaveLength(Object.keys(classes).length + 1);
      for (const [id, adapter] of first.usageAdapters) {
        expect(adapter).not.toBe(second.usageAdapters.get(id));
      }
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  }, 35_000);

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

it.runIf(Boolean(process.env.CODEXHOST_OPENCODE_REAL_COMMAND))(
  "loads the relocated OpenCode Bundle and opens a real isolated Session",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-opencode-plugin-"));
    const plugins = path.join(root, "plugins");
    let registry: Awaited<ReturnType<typeof loadHarnessPlugins>> | undefined;
    try {
      await cp(path.join(pluginRoot, "opencode"), path.join(plugins, "opencode"), {
        recursive: true,
      });
      await writeFile(
        path.join(plugins, "enabled.json"),
        JSON.stringify({ version: 1, enabled: ["opencode"] }),
      );
      registry = await loadHarnessPlugins({
        roots: [plugins],
        warmup: false,
        context: {
          environment: {
            ...process.env,
            CODEXHOST_OPENCODE_COMMAND: process.env.CODEXHOST_OPENCODE_REAL_COMMAND,
            OPENCODE_TEST_HOME: path.join(root, "home"),
            OPENCODE_CONFIG_DIR: path.join(root, "config"),
            OPENCODE_DISABLE_PROJECT_CONFIG: "true",
            XDG_DATA_HOME: path.join(root, "data"),
            XDG_CACHE_HOME: path.join(root, "cache"),
            XDG_STATE_HOME: path.join(root, "state"),
          },
          platform: process.platform,
          managedRemoteHost: false,
        },
      });
      const adapter = registry.adapters.get(harnessIdSchema.parse("opencode"));
      expect(adapter).toBeDefined();
      if (!adapter) throw new Error("OpenCode plugin was not loaded");
      expect(await adapter.inspect({ cwd: root })).toMatchObject({ status: "ready" });
      const opened = await adapter.open({ kind: "create", cwd: root });
      if (!opened.ok) throw new Error(opened.error.message);
      expect(opened.value.initialState.nativeRef?.harnessId).toBe("opencode");
      expect(await opened.value.readSnapshot()).toMatchObject({ ok: true, value: { turns: [] } });
      await opened.value.close();
    } finally {
      await registry?.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  45_000,
);
