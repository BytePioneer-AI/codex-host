import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { USAGE_STATISTICS_METHOD } from "@codexhost/shared-contracts";
import { loadHarnessPlugins } from "../src/harness-plugin-loader.js";
import { ModelPriceCatalog } from "../src/model-prices.js";
import { UsageStatistics } from "../src/usage-statistics.js";
import { createFixture, stopFixture } from "./app-server-host-fixture.js";

let root: string, plugins: string, home: string;
const thread = "00000000-0000-4000-8000-000000000001";
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "codex-usage-plugin-"));
  plugins = path.join(root, "plugins");
  home = path.join(root, "native");
  await mkdir(plugins);
  await mkdir(path.join(home, "sessions"), { recursive: true });
  await cp(
    path.resolve("packages/host-runtime/dist/plugins/codex-usage"),
    path.join(plugins, "codex-usage"),
    { recursive: true },
  );
  await writeFile(
    path.join(plugins, "enabled.json"),
    JSON.stringify({ version: 1, enabled: ["codex-usage"] }),
  );
  const timestamp = "2026-01-01T00:00:00Z";
  await writeFile(
    path.join(home, "sessions", `rollout-2026-01-01T00-00-00-${thread}.jsonl`),
    [
      { timestamp, type: "session_meta", payload: { id: thread, session_id: thread } },
      { timestamp, type: "turn_context", payload: { turn_id: "t", model: "test-model" } },
      {
        timestamp,
        type: "token_usage_record",
        payload: {
          thread_id: thread,
          session_id: thread,
          turn_id: "t",
          response_id: "r",
          usage: {
            input_tokens: 1000000,
            output_tokens: 1000000,
            cached_input_tokens: 500000,
            cache_write_input_tokens: 0,
            reasoning_output_tokens: 200000,
          },
        },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n") + "\n",
  );
  await writeFile(
    path.join(root, "pricing.json"),
    JSON.stringify({ models: { "test-model": { input: 1, output: 2, cacheRead: 0.1 } } }),
  );
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

it("loads a relocated Codex usage bundle independently of Desktop or workspace modules", async () => {
  const options = {
    roots: [plugins],
    context: {
      environment: { CODEX_HOME: home },
      platform: process.platform,
      managedRemoteHost: false,
    },
  };
  const a = await loadHarnessPlugins(options),
    b = await loadHarnessPlugins(options);
  try {
    expect(a.adapters.size).toBe(0);
    expect(a.list()).toMatchObject([{ id: "codex-usage", kind: "usage", name: "Codex" }]);
    const first = [...a.usageAdapters.values()][0],
      second = [...b.usageAdapters.values()][0];
    expect(first).toBeDefined();
    expect(first).not.toBe(second);
    await a.close();
    const signal = new AbortController().signal;
    await expect(first?.usageStatistics.listSources(signal)).rejects.toThrow();
    const sources = await second?.usageStatistics.listSources(signal);
    expect(sources).toHaveLength(1);
    const source = sources?.[0];
    if (!source) throw new Error("missing source");
    expect(await second?.usageStatistics.readSource(source.id, signal)).toHaveLength(1);
    expect(await readFile(path.join(plugins, "codex-usage", "plugin.mjs"), "utf8")).toContain(
      '"token_usage_record"',
    );
  } finally {
    await a.close();
    await b.close();
  }
});

it("serves Codex plugin usage through the normal Host statistics and reprices without native calls", async () => {
  const usageStatistics = new UsageStatistics({
    directory: path.join(root, "cache"),
    prices: new ModelPriceCatalog({ directory: root }),
    now: () => Date.parse("2026-01-02T00:00:00Z"),
  });
  const fixture = createFixture({
    pluginDirectory: plugins,
    environment: { CODEX_HOME: home },
    usageStatistics,
  });
  try {
    await fixture.host.handleConsoleRequest(USAGE_STATISTICS_METHOD, { range: "all" });
    await usageStatistics.settled();
    expect(
      await fixture.host.handleConsoleRequest(USAGE_STATISTICS_METHOD, { range: "all" }),
    ).toMatchObject({
      result: {
        failures: [],
        byHarness: [{ harness: "codex-usage", requests: 1 }],
        byModel: [
          {
            model: "test-model",
            requests: 1,
            inputTokens: 1000000,
            outputTokens: 1000000,
            cachedInputTokens: 500000,
            reasoningOutputTokens: 200000,
            costUsd: 2.55,
            unpricedRequests: 0,
          },
        ],
      },
    });
    expect(
      await fixture.host.handleConsoleRequest("codexhost/harness/plugins/list", {}),
    ).toMatchObject({ result: { plugins: [{ id: "codex-usage", kind: "usage" }] } });
    expect(
      await fixture.host.handleConsoleRequest("codexhost/harness/inspect", {
        harnessId: "codex-usage",
      }),
    ).toHaveProperty("error");
    await writeFile(
      path.join(root, "pricing.json"),
      JSON.stringify({ models: { "test-model": { input: 2, output: 4, cacheRead: 0.2 } } }),
    );
    expect(
      await fixture.host.handleConsoleRequest(USAGE_STATISTICS_METHOD, { range: "all" }),
    ).toMatchObject({ result: { totals: { costUsd: 5.1 } } });
  } finally {
    usageStatistics.close();
    await stopFixture(fixture);
  }
});

it("does not execute or expose a disabled statistics plugin", async () => {
  await writeFile(path.join(plugins, "enabled.json"), JSON.stringify({ version: 1, enabled: [] }));
  const registry = await loadHarnessPlugins({
    roots: [plugins],
    context: {
      environment: { CODEX_HOME: home },
      platform: process.platform,
      managedRemoteHost: false,
    },
  });
  try {
    expect(registry.list()).toEqual([]);
    expect(registry.usageAdapters.size).toBe(0);
  } finally {
    await registry.close();
  }
});
