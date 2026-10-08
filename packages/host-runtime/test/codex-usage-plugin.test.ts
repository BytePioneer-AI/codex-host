import { appendFile, cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { USAGE_STATISTICS_METHOD } from "@codexhost/shared-contracts";
import { loadHarnessPlugins } from "../src/harness-plugin-loader.js";
import { ModelPriceCatalog } from "../src/model-prices.js";
import { UsageStatistics } from "../src/usage-statistics.js";
import {
  createFixture,
  stopFixture,
  writeRequest,
  requestId,
  method,
  readJsonLine,
  requiredMessageId,
} from "./app-server-host-fixture.js";

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

it("restores session usage and updates TTFT and request cost during an unfinished official turn", async () => {
  const fixture = createFixture({
    pluginDirectory: plugins,
    environment: { CODEX_HOME: home },
    modelPrices: new ModelPriceCatalog({ directory: root }),
    accountControl: {
      currentAccountId: () => null,
      snapshot: () => ({
        version: 2,
        currentAccountId: null,
        phase: "unavailable",
        revision: 0,
        accounts: [],
      }),
    },
  });
  const inspect = async (id: number) => {
    writeRequest(fixture.desktopInput, {
      id,
      method: "codexhost/thread/usage/inspect",
      params: { threadId: thread },
    });
    return fixture.collector.waitFor((message) => requestId(message, id));
  };
  const emit = (value: object) => fixture.official.stdout.write(JSON.stringify(value) + "\n");
  try {
    expect(await inspect(91)).toMatchObject({
      result: {
        usage: { totalCostUsd: 2.55, sessionCacheHitRatePercent: 50, totalTokens: 2000000 },
      },
    });
    emit({ method: "turn/started", params: { threadId: thread, turn: { id: "live" } } });
    emit({
      method: "item/reasoning/summaryTextDelta",
      params: { threadId: thread, turnId: "live", delta: "thinking" },
    });
    await fixture.collector.waitFor((message) => method(message, "codexhost/thread/usage/updated"));
    expect(await inspect(92)).toMatchObject({
      result: { usage: { timeToFirstOutputMs: expect.any(Number) } },
    });
    await appendFile(
      path.join(home, "sessions", `rollout-2026-01-01T00-00-00-${thread}.jsonl`),
      JSON.stringify({
        timestamp: "2026-01-01T00:01:00Z",
        type: "token_usage_record",
        payload: {
          thread_id: thread,
          session_id: thread,
          turn_id: "t",
          response_id: "r2",
          usage: { input_tokens: 1000000, output_tokens: 1000000, cached_input_tokens: 500000 },
        },
      }) + "\n",
    );
    const notification = {
      method: "thread/tokenUsage/updated",
      params: {
        threadId: thread,
        turnId: "live",
        tokenUsage: {
          total: {
            inputTokens: 2000000,
            outputTokens: 2000000,
            cachedInputTokens: 1000000,
            totalTokens: 4000000,
          },
          last: {
            inputTokens: 1000000,
            outputTokens: 1000000,
            cachedInputTokens: 500000,
            totalTokens: 2000000,
          },
          modelContextWindow: 3000000,
        },
      },
    };
    emit(notification);
    expect(
      await fixture.collector.waitFor((message) => method(message, "thread/tokenUsage/updated")),
    ).toEqual(notification);
    expect(await inspect(93)).toMatchObject({
      result: {
        usage: {
          totalCostUsd: 5.1,
          cacheHitRatePercent: 50,
          contextUsedTokens: 2000000,
          contextWindowTokens: 3000000,
          totalTokens: 4000000,
        },
      },
    });
    expect(fixture.collector.messages.some((message) => method(message, "turn/completed"))).toBe(
      false,
    );
  } finally {
    await stopFixture(fixture);
  }
});

it("subscribes internally despite Desktop raw defaults, preserving its notification exclusions", async () => {
  const fixture = createFixture({
    pluginDirectory: plugins,
    environment: { CODEX_HOME: home },
    modelPrices: new ModelPriceCatalog({ directory: root }),
    accountControl: {
      currentAccountId: () => null,
      snapshot: () => ({
        version: 2,
        currentAccountId: null,
        phase: "unavailable",
        revision: 0,
        accounts: [],
      }),
    },
  });
  try {
    // No preloading via console requests: exercise the real startup subscription race.
    writeRequest(fixture.desktopInput, {
      id: 81,
      method: "initialize",
      params: {
        clientInfo: { name: "usage-test", version: "1" },
        capabilities: {
          experimentalApi: true,
          optOutNotificationMethods: ["rawResponse/completed", "rawResponseItem/completed"],
        },
      },
    });
    const initialize = await readJsonLine(fixture.official.stdin);
    expect(initialize.params).toMatchObject({
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods: ["rawResponseItem/completed"],
      },
    });
    writeRequest(fixture.official.stdout, {
      id: requiredMessageId(initialize),
      result: { userAgent: "fixture" },
    });
    await fixture.collector.waitFor((message) => requestId(message, 81));
    expect(await readJsonLine(fixture.official.stdin)).toMatchObject({ method: "initialized" });
    const params = { model: "native-model", cwd: home, experimentalRawEvents: false };
    writeRequest(fixture.desktopInput, { id: 82, method: "thread/start", params });
    const start = await readJsonLine(fixture.official.stdin);
    expect(start.params).toEqual({ ...params, experimentalRawEvents: true });
    writeRequest(fixture.official.stdout, {
      id: requiredMessageId(start),
      result: { thread: { id: thread } },
    });
    await fixture.collector.waitFor((message) => requestId(message, 82));
    writeRequest(fixture.desktopInput, {
      id: 83,
      method: "thread/resume",
      params: { threadId: thread },
    });
    const resume = await readJsonLine(fixture.official.stdin);
    expect(resume.params).toEqual({ threadId: thread });
    writeRequest(fixture.official.stdout, {
      id: requiredMessageId(resume),
      result: { thread: { id: thread } },
    });
    await fixture.collector.waitFor((message) => requestId(message, 83));
    const emit = (method: string, params: Record<string, unknown>) =>
      writeRequest(fixture.official.stdout, { method, params: { threadId: thread, ...params } });
    emit("turn/started", { turn: { id: "speed-turn" } });
    emit("item/started", { turnId: "speed-turn", item: { type: "reasoning", summary: [] } });
    emit("item/agentMessage/delta", { turnId: "speed-turn", delta: "visible output" });
    await fixture.collector.waitFor((message) => method(message, "item/agentMessage/delta"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    emit("rawResponse/completed", {
      turnId: "speed-turn",
      responseId: "speed-response",
      usage: { outputTokens: 92, reasoningOutputTokens: 42 },
    });
    emit("turn/completed", { turn: { id: "speed-turn" } });
    await fixture.collector.waitFor((message) => method(message, "turn/completed"));
    expect(
      fixture.collector.messages.some((message) => method(message, "rawResponse/completed")),
    ).toBe(false);
    writeRequest(fixture.desktopInput, {
      id: 84,
      method: "codexhost/thread/usage/inspect",
      params: { threadId: thread },
    });
    const usage = await fixture.collector.waitFor((message) => requestId(message, 84));
    expect(usage).toMatchObject({
      result: { usage: { outputTokensPerSecond: expect.any(Number) } },
    });
  } finally {
    await stopFixture(fixture);
  }
});

it("negotiates telemetry even when its cold load exceeds the former 250ms cutoff", async () => {
  const entry = path.join(plugins, "codex-usage", "plugin.mjs");
  await writeFile(
    entry,
    `await new Promise(r => setTimeout(r, 500));\n${await readFile(entry, "utf8")}`,
  );
  const fixture = createFixture({ pluginDirectory: plugins, environment: { CODEX_HOME: home } });
  try {
    const params = {
      clientInfo: { name: "slow-usage-test", version: "1" },
      capabilities: { experimentalApi: true, optOutNotificationMethods: ["rawResponse/completed"] },
    };
    writeRequest(fixture.desktopInput, { id: 81, method: "initialize", params });
    const initialize = await readJsonLine(fixture.official.stdin);
    writeRequest(fixture.official.stdout, {
      id: requiredMessageId(initialize),
      result: { userAgent: "fixture" },
    });
    await fixture.collector.waitFor((message) => requestId(message, 81));
    expect(await readJsonLine(fixture.official.stdin)).toMatchObject({ method: "initialized" });
    expect(initialize.params).toEqual({
      ...params,
      capabilities: { experimentalApi: true, optOutNotificationMethods: [] },
    });
    await fixture.host.handleConsoleRequest("codexhost/harness/plugins/list", {});
    const startParams = { cwd: home, experimentalRawEvents: false };
    writeRequest(fixture.desktopInput, { id: 82, method: "thread/start", params: startParams });
    const start = await readJsonLine(fixture.official.stdin);
    expect(start.params).toEqual({ ...startParams, experimentalRawEvents: true });
    writeRequest(fixture.official.stdout, {
      id: requiredMessageId(start),
      result: { thread: { id: thread } },
    });
    await fixture.collector.waitFor((message) => requestId(message, 82));
  } finally {
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
