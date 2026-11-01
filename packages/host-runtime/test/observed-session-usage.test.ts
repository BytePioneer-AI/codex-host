import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  HarnessSessionUsageCapability,
  HarnessSessionUsageHistory,
  HarnessSessionUsageObservation,
} from "@codexhost/harness-adapter/plugin";
import { ModelPriceCatalog } from "../src/model-prices.js";
import { ObservedSessionUsage } from "../src/observed-session-usage.js";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "observed-usage-"));
  await writeFile(
    path.join(directory, "pricing.json"),
    JSON.stringify({ models: { a: { input: 1, output: 2, cacheRead: 0.1 } } }),
  );
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
const history = (): HarnessSessionUsageHistory => ({
  usage: { inputTokens: 1000000, outputTokens: 1000000 },
  complete: true,
  requests: [
    {
      requestId: "r",
      model: "a",
      inputTokens: 1000000,
      outputTokens: 1000000,
      cachedInputTokens: 500000,
      cacheWriteInputTokens: 0,
    },
  ],
});
function setup() {
  let observation: HarnessSessionUsageObservation | null = null;
  const read = vi.fn<HarnessSessionUsageCapability["read"]>().mockResolvedValue(history());
  const provider: HarnessSessionUsageCapability = { observe: () => observation, read };
  const diagnose = vi.fn();
  const bridge = new ObservedSessionUsage(
    () => [provider],
    new ModelPriceCatalog({ directory }),
    diagnose,
  );
  return {
    bridge,
    read,
    diagnose,
    observe: (value: HarnessSessionUsageObservation, at: number) => {
      observation = value;
      return bridge.observe({}, at);
    },
  };
}

it("uses generic plugin facts for cost, deduplication and TTFT without waiting for turn completion", async () => {
  const { bridge, observe } = setup();
  try {
    expect((await bridge.read("s"))?.totalCostUsd).toBe(2.55);
    observe({ sessionId: "s", turn: { id: "t", phase: "started" } }, 1000);
    expect(observe({ sessionId: "s", turn: { id: "t", phase: "output" } }, 1123)).toEqual(["s"]);
    expect(observe({ sessionId: "s", turn: { id: "t", phase: "output" } }, 1300)).toEqual([]);
    expect(await bridge.read("s")).toMatchObject({
      totalCostUsd: 2.55,
      sessionCacheHitRatePercent: 50,
      timeToFirstOutputMs: 123,
    });
    expect(await bridge.read("s")).not.toHaveProperty("outputTokensPerSecond");
    observe({ sessionId: "s", turn: { id: "t", phase: "completed" } }, 2000);
    expect((await bridge.read("s"))?.timeToFirstOutputMs).toBe(123);
  } finally {
    bridge.close();
  }
});

it("replaces rather than adds histories and reprices on read", async () => {
  const { bridge, read } = setup();
  try {
    expect((await bridge.read("s"))?.totalCostUsd).toBe(2.55);
    read.mockResolvedValue({ ...history(), requests: [] });
    expect((await bridge.read("s"))?.totalCostUsd).toBe(0);
    read.mockResolvedValue(history());
    await writeFile(
      path.join(directory, "pricing.json"),
      JSON.stringify({ models: { a: { input: 2, output: 4, cacheRead: 0.2 } } }),
    );
    expect((await bridge.read("s"))?.totalCostUsd).toBe(5.1);
  } finally {
    bridge.close();
  }
});

it("suppresses stale cost after read failure, while retaining live tokens and TTFT", async () => {
  const { bridge, read, observe, diagnose } = setup();
  try {
    await bridge.read("s");
    observe({ sessionId: "s", usage: { inputTokens: 2000000 } }, 1000);
    read.mockRejectedValue(new Error("unstable history"));
    const result = await bridge.read("s");
    expect(result?.inputTokens).toBe(2000000);
    expect(result).not.toHaveProperty("totalCostUsd");
    expect(diagnose).toHaveBeenCalled();
  } finally {
    bridge.close();
  }
});

it("coalesces reads, rejects stale history completeness and ignores completion after close", async () => {
  const { bridge, read, observe } = setup();
  const deferred = Promise.withResolvers<HarnessSessionUsageHistory>();
  read.mockReturnValue(deferred.promise);
  const first = bridge.read("s"),
    second = bridge.read("s");
  expect(read).toHaveBeenCalledTimes(1);
  observe({ sessionId: "s", usage: { inputTokens: 4000000 } }, 1000);
  deferred.resolve(history());
  expect(await first).not.toHaveProperty("totalCostUsd");
  expect(await second).not.toHaveProperty("totalCostUsd");
  bridge.close();
  expect(await bridge.read("s")).toBeNull();
});

it("meters independent response intervals without adding billing entries or tool waiting time", async () => {
  const { bridge, observe, read } = setup();
  try {
    observe({ sessionId: "s", turn: { id: "t", phase: "started" } }, 0);
    observe(
      {
        sessionId: "s",
        requestTiming: {
          turnId: "t",
          requestId: "r1",
          outputTokens: 100,
          startedAtMs: 1000,
          completedAtMs: 2000,
        },
      },
      2000,
    );
    expect(await bridge.read("s")).toMatchObject({
      totalCostUsd: 2.55,
      outputTokensPerSecond: 100,
    });
    observe(
      {
        sessionId: "s",
        requestTiming: {
          turnId: "t",
          requestId: "r2",
          outputTokens: 50,
          startedAtMs: 9000,
          completedAtMs: 9500,
        },
      },
      9500,
    );
    expect(await bridge.read("s")).toMatchObject({
      totalCostUsd: 2.55,
      outputTokensPerSecond: 100,
    });
    // Re-reading history and re-delivering a completion cannot count timing or cost twice.
    observe(
      {
        sessionId: "s",
        requestTiming: {
          turnId: "t",
          requestId: "r2",
          outputTokens: 50,
          startedAtMs: 9000,
          completedAtMs: 9500,
        },
      },
      9600,
    );
    expect((await bridge.read("s"))?.outputTokensPerSecond).toBe(100);
    read.mockRejectedValue(new Error("history unavailable"));
    expect((await bridge.read("s"))?.outputTokensPerSecond).toBe(100);
    observe({ sessionId: "s", timingUnavailable: { turnId: "t" } }, 9700);
    expect((await bridge.read("s"))?.outputTokensPerSecond).toBe(100);
  } finally {
    bridge.close();
  }
});

it("retains speed without historical billing across new turns and reinitialization", async () => {
  const { bridge, observe, read } = setup();
  read.mockResolvedValue(null);
  try {
    observe({ sessionId: "s", turn: { id: "t", phase: "started" } }, 0);
    observe(
      {
        sessionId: "s",
        requestTiming: {
          turnId: "t",
          requestId: "r",
          outputTokens: 100,
          startedAtMs: 1000,
          completedAtMs: 2000,
        },
      },
      2000,
    );
    expect(await bridge.read("s")).toMatchObject({ outputTokensPerSecond: 100 });
    observe({ sessionId: "s", turn: { id: "next", phase: "started" } }, 3000);
    expect((await bridge.read("s"))?.outputTokensPerSecond).toBe(100);
    observe(
      {
        sessionId: "s",
        requestTiming: {
          turnId: "next",
          requestId: "r2",
          outputTokens: 50,
          startedAtMs: 4000,
          completedAtMs: 5000,
        },
      },
      5000,
    );
    bridge.initialized({ capabilities: { experimentalApi: true } });
    expect((await bridge.read("s"))?.outputTokensPerSecond).toBe(50);
    observe(
      {
        sessionId: "s",
        requestTiming: {
          turnId: "next",
          requestId: "late",
          outputTokens: 100,
          startedAtMs: 5000,
          completedAtMs: 6000,
        },
      },
      6000,
    );
    expect((await bridge.read("s"))?.outputTokensPerSecond).toBe(50);
    expect(await bridge.read("other")).toBeNull();
  } finally {
    bridge.close();
  }
});

it("filters plugin-only notifications and fails open on filter errors or shutdown", () => {
  const filter = vi.fn().mockReturnValue(false);
  const diagnose = vi.fn();
  const provider: HarnessSessionUsageCapability = {
    observe: () => null,
    read: async () => null,
    shouldForwardNotification: filter,
  };
  const bridge = new ObservedSessionUsage(
    () => [provider],
    new ModelPriceCatalog({ directory }),
    diagnose,
  );
  expect(bridge.shouldForwardNotification({})).toBe(false);
  filter.mockImplementation(() => {
    throw new Error("filter failed");
  });
  expect(bridge.shouldForwardNotification({})).toBe(true);
  expect(diagnose).toHaveBeenCalledOnce();
  bridge.close();
  filter.mockReturnValue(false);
  expect(bridge.shouldForwardNotification({})).toBe(true);
});

it("works without a plugin", async () => {
  const bridge = new ObservedSessionUsage(() => [], new ModelPriceCatalog({ directory }), vi.fn());
  expect(bridge.observe({})).toEqual([]);
  expect(await bridge.read("s")).toBeNull();
  bridge.close();
});
