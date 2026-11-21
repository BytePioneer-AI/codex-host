import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parseHostUsage, parseHostUsageRequest } from "@codexhost/harness-adapter";
import { UsageMeter } from "@codexhost/session-runtime/usage-metering";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { writeNativeTimingDatabase } from "./support/native-timing-fixture.js";

import {
  AntigravitySessionUsageTracker,
  normalizeAntigravityUsageModel,
} from "../src/acp-usage.js";

let home: string;
let file: string;
let tracker: AntigravitySessionUsageTracker;

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "agy-acp-usage-"));
  file = path.join(
    home,
    ".gemini/antigravity-cli/brain/session/.system_generated/logs/transcript.jsonl",
  );
  tracker = new AntigravitySessionUsageTracker({ nativeSessionId: "session", homedir: home });
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function planner(step: number, fields: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "PLANNER_RESPONSE",
    source: "MODEL",
    status: "DONE",
    step_index: step,
    input_tokens: 100,
    cache_read_tokens: 50,
    output_tokens: 20,
    model: "gemini-4-carbon-high",
    ...fields,
  });
}

async function transcript(...lines: string[]): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${lines.join("\n")}\n`);
}

const nativePrompt = {
  inputTokens: 100,
  cachedReadTokens: 50,
  cachedWriteTokens: 0,
  outputTokens: 20,
  thoughtTokens: 0,
};

const prompt = {
  inputTokens: 10678,
  outputTokens: 147,
  cachedReadTokens: 8097,
  cachedWriteTokens: 0,
  thoughtTokens: 0,
  totalTokens: 18922,
};

describe("Antigravity usage model identity", () => {
  it.each([
    [" gemini-4-carbon-high ", { model: "gemini-4-carbon", provider: "google" }],
    ["gemini-4-hydrogen-xhigh", { model: "gemini-4-hydrogen", provider: "google" }],
    ["claude-sonnet-5-5-medium", { model: "claude-sonnet-5-5", provider: "anthropic" }],
    ["claude-opus-5-low", { model: "claude-opus-5", provider: "anthropic" }],
    ["claude-opus-4-6-thinking", { model: "claude-opus-4-6", provider: "anthropic" }],
    ["claude-opus-4-6-thinking-xhigh", { model: "claude-opus-4-6", provider: "anthropic" }],
    ["claude-opus-4-6", { model: "claude-opus-4-6", provider: "anthropic" }],
    ["gpt-oss-120b-medium", { model: "gpt-oss-120b" }],
    ["gpt-oss-120b", { model: "gpt-oss-120b" }],
    ["gpt-5-high", { model: "gpt-5", provider: "openai" }],
    ["gpt-5", { model: "gpt-5", provider: "openai" }],
    ["custom-high", { model: "custom-high" }],
    ["", {}],
    [null, {}],
  ])("normalizes %s without inventing model prices", (raw, expected) => {
    expect(normalizeAntigravityUsageModel(raw)).toEqual(expected);
  });
});

describe("Antigravity Session usage", () => {
  it("meters historical and completed live requests without waiting for the Turn to end", async () => {
    const meter = new UsageMeter();
    const prices = { find: () => ({ input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 }) };
    const apply = (update: Awaited<ReturnType<typeof tracker.replayHistoricalRequests>>) => {
      for (const request of update.requests) meter.recordRequest(request, "turn-live");
      meter.recordHistory(update.complete);
      return meter.derive(update.usage, prices);
    };
    await transcript(planner(1));
    expect(apply(await tracker.replayHistoricalRequests())?.totalCostUsd).toBeCloseTo(0.000145, 10);

    tracker.beginTurn();
    meter.turnStarted("turn-live", Date.now());
    // A new request has no final usage yet; keep the historical cost visible.
    expect(apply(await tracker.collectNewTranscriptRequests())?.totalCostUsd).toBeCloseTo(
      0.000145,
      10,
    );
    for (const step of [3, 5]) {
      await appendFile(file, `${planner(step)}\n`);
      const update = await tracker.collectNewTranscriptRequests();
      expect(update.complete).toBe(true);
      expect(update.requests.map((request) => request.requestId)).toEqual([`step:${step}`]);
      expect(apply(update)?.totalCostUsd).toBeCloseTo(0.000145 * ((step + 1) / 2), 10);
      expect(apply(await tracker.collectNewTranscriptRequests())?.totalCostUsd).toBeCloseTo(
        0.000145 * ((step + 1) / 2),
        10,
      );
    }

    const settled = tracker.recordTurnPromptUsage({
      usage: { inputTokens: 200, cachedReadTokens: 100, cachedWriteTokens: 0, outputTokens: 40 },
    });
    expect(settled.complete).toBe(true);
    expect(apply(await tracker.collectNewTranscriptRequests())?.totalCostUsd).toBeCloseTo(
      0.000435,
      10,
    );

    tracker.beginTurn();
    await appendFile(file, `${planner(7, { output_tokens: undefined })}\n`);
    const missing = await tracker.collectNewTranscriptRequests();
    expect(missing.complete).toBe(false);
    expect(apply(missing)).not.toHaveProperty("totalCostUsd");
    await appendFile(file, `${planner(7)}\n`);
    expect(apply(await tracker.collectNewTranscriptRequests())?.totalCostUsd).toBeCloseTo(
      0.00058,
      10,
    );
  });

  it.each(["native", "fallback", "historical", "early"])(
    "times only text output for the hidden-thought sample when native timing is verified (%s)",
    async (mode) => {
      const usage = {
        inputTokens: 8856,
        outputTokens: 544,
        cachedReadTokens: 0,
        cachedWriteTokens: 0,
        thoughtTokens: 48,
        totalTokens: 9400,
      };
      await transcript(
        planner(1, {
          input_tokens: 8856,
          cache_read_tokens: 0,
          output_tokens: 544,
        }),
      );
      if (mode !== "fallback")
        await writeNativeTimingDatabase(home, [
          {
            step: 1,
            input: 8856,
            cached: 0,
            output: 544,
            thought: 48,
            created: 1794763967637.624,
            started: 1794763980519.679,
            completed: 1794763991282.717,
          },
        ]);
      if (mode !== "historical") tracker.beginTurn(1794763967599);
      const update =
        mode === "historical"
          ? await tracker.replayHistoricalRequests()
          : await tracker.collectNewTranscriptRequests(
              mode === "early"
                ? {}
                : {
                    promptUsage: usage,
                    firstOutputAtMs: 1794763980521,
                    completedAtMs: 1794763991289,
                  },
            );
      expect(update.requests).toHaveLength(1);
      expect(update.requests[0]).toMatchObject({
        inputTokens: 8856,
        outputTokens: 544,
        reasoningOutputTokens: 48,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
      });
      if (mode === "fallback") {
        expect(update.requests[0]).not.toHaveProperty("startedAtMs");
        expect(update.requests[0]).not.toHaveProperty("completedAtMs");
        expect(update.requests[0]).not.toHaveProperty("timedOutputTokens");
      } else {
        expect(update.requests[0]).toMatchObject({
          startedAtMs: 1794763980519,
          completedAtMs: 1794763991282,
          timedOutputTokens: 496,
        });
      }
      const meter = new UsageMeter();
      meter.turnStarted("t", 1794763967599);
      for (const request of update.requests)
        meter.recordRequest(request, mode === "historical" ? null : "t");
      if (mode !== "historical") {
        expect(
          (
            await tracker.collectNewTranscriptRequests({
              promptUsage: usage,
              firstOutputAtMs: 1794763980521,
              completedAtMs: 1794763991289,
            })
          ).requests,
        ).toEqual([]);
        expect(tracker.recordTurnPromptUsage({ usage }).complete).toBe(true);
      } else expect(update.complete).toBe(true);
      meter.recordHistory(true);
      const derived = meter.derive(tracker.currentUsage(), {
        find: () => ({ input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }),
      });
      expect(derived).toMatchObject({ inputTokens: 8856, outputTokens: 544, totalCostUsd: 0.0094 });
      if (mode === "fallback" || mode === "historical") {
        expect(derived?.outputTokensPerSecond).toBeUndefined();
        expect(tracker.currentUsage()?.outputTokensPerSecond).toBeUndefined();
      } else {
        expect(derived?.outputTokensPerSecond).toBeCloseTo(46.08, 2);
        expect(derived?.outputTokensPerSecond).toBe(tracker.currentUsage()?.outputTokensPerSecond);
      }
      if (mode === "fallback") expect(derived?.sessionOutputTokensPerSecond).toBeUndefined();
      else expect(derived?.sessionOutputTokensPerSecond).toBeCloseTo(46.08, 2);
    },
  );

  it.each([undefined, 0, 10])(
    "does not attribute a multi-request prompt reasoning aggregate (%s) to individual requests",
    async (thoughtTokens) => {
      await transcript(planner(1), planner(3));
      tracker.beginTurn(1000);
      const usage = {
        inputTokens: 200,
        cachedReadTokens: 100,
        cachedWriteTokens: 0,
        outputTokens: 40,
        ...(thoughtTokens === undefined ? {} : { thoughtTokens }),
      };
      const update = await tracker.collectNewTranscriptRequests({
        promptUsage: usage,
        firstOutputAtMs: 3000,
        completedAtMs: 5000,
      });
      expect(update.requests).toHaveLength(2);
      for (const request of update.requests) {
        expect(request).not.toHaveProperty("startedAtMs");
        expect(request).not.toHaveProperty("reasoningOutputTokens");
      }
      expect(tracker.recordTurnPromptUsage({ usage }).complete).toBe(true);
      expect(update.usage).not.toHaveProperty("outputTokensPerSecond");
    },
  );

  it("does not attach late hidden-thinking timing to an already published stable request", async () => {
    await transcript(planner(1));
    tracker.beginTurn(1000);
    const early = await tracker.collectNewTranscriptRequests();
    expect(early.requests).toHaveLength(1);
    expect(early.requests[0]).not.toHaveProperty("startedAtMs");
    const usage = { ...nativePrompt, thoughtTokens: 10 };
    const final = await tracker.collectNewTranscriptRequests({
      promptUsage: usage,
      firstOutputAtMs: 3000,
      completedAtMs: 5000,
    });
    expect(final.requests).toEqual([]);
    expect(tracker.recordTurnPromptUsage({ usage }).complete).toBe(true);
    expect(final.usage).not.toHaveProperty("outputTokensPerSecond");
  });

  it("keeps nonreasoning fallback timing when transcript cache writes are already explicit", async () => {
    await transcript(planner(1, { cache_write_tokens: 15 }));
    const usage = { ...nativePrompt, cachedWriteTokens: 15 };
    const update = await tracker.collectNewTranscriptRequests({
      promptUsage: usage,
      firstOutputAtMs: 1000,
      completedAtMs: 3000,
    });
    expect(update.requests[0]).toMatchObject({
      inputTokens: 165,
      cacheWriteInputTokens: 15,
      reasoningOutputTokens: 0,
      startedAtMs: 1000,
      completedAtMs: 3000,
    });
    expect(update.usage?.outputTokensPerSecond).toBe(10);
    expect(tracker.recordTurnPromptUsage({ usage }).complete).toBe(true);
  });

  it("does not treat an unavailable reasoning count as zero for client fallback", async () => {
    await transcript(planner(1));
    const usage = {
      inputTokens: 100,
      cachedReadTokens: 50,
      cachedWriteTokens: 0,
      outputTokens: 20,
    };
    const update = await tracker.collectNewTranscriptRequests({
      promptUsage: usage,
      firstOutputAtMs: 1000,
      completedAtMs: 3000,
    });
    expect(update.requests[0]).not.toHaveProperty("reasoningOutputTokens");
    expect(update.requests[0]).not.toHaveProperty("startedAtMs");
    expect(tracker.recordTurnPromptUsage({ usage }).complete).toBe(true);
  });

  it.each([undefined, 10])(
    "times independently verified text output beside unknown/hidden output: %s",
    async (thought) => {
      await transcript(planner(1), planner(3, { output_tokens: 30 }));
      const database = await writeNativeTimingDatabase(home, [
        { step: 1 },
        {
          step: 3,
          created: 10000,
          started: 12000,
          completed: 13000,
          output: 30,
          ...(thought === undefined ? {} : { thought }),
        },
      ]);
      if (thought === undefined) {
        const db = new DatabaseSync(database);
        try {
          db.exec("DELETE FROM steps WHERE idx = 3");
        } finally {
          db.close();
        }
      }
      tracker.beginTurn(1000);
      const usage = {
        ...nativePrompt,
        inputTokens: 200,
        cachedReadTokens: 100,
        outputTokens: 50,
        thoughtTokens: 10,
      };
      const update = await tracker.collectNewTranscriptRequests({
        promptUsage: usage,
        firstOutputAtMs: 3000,
        completedAtMs: 15000,
      });
      expect(update.requests).toHaveLength(2);
      expect(update.requests[0]).toMatchObject({
        startedAtMs: 3000,
        completedAtMs: 5000,
        reasoningOutputTokens: 0,
      });
      if (thought === undefined) {
        expect(update.requests[1]).not.toHaveProperty("startedAtMs");
        expect(update.usage?.outputTokensPerSecond).toBe(10);
      } else {
        expect(update.requests[1]).toMatchObject({
          startedAtMs: 12000,
          completedAtMs: 13000,
          timedOutputTokens: 20,
        });
        expect(update.usage?.outputTokensPerSecond).toBeCloseTo(40 / 3);
      }
      expect(update.requests[1]?.reasoningOutputTokens).toBe(thought);
      expect(update.usage?.outputTokens).toBe(50);
      expect(tracker.recordTurnPromptUsage({ usage }).complete).toBe(true);
    },
  );

  it("does not use native zero-thinking timing when attributable prompt facts report hidden thinking", async () => {
    await transcript(planner(1));
    await writeNativeTimingDatabase(home, [{ step: 1 }]);
    tracker.beginTurn(1000);
    const usage = { ...nativePrompt, thoughtTokens: 10 };
    const update = await tracker.collectNewTranscriptRequests({
      promptUsage: usage,
      firstOutputAtMs: 3000,
      completedAtMs: 5000,
    });
    expect(update.requests[0]).toMatchObject({ reasoningOutputTokens: 10, outputTokens: 20 });
    expect(update.requests[0]).not.toHaveProperty("startedAtMs");
    expect(tracker.recordTurnPromptUsage({ usage }).complete).toBe(true);
  });

  it("retains the last reliable speed when a hidden-thinking request has no verified timing", async () => {
    await transcript(planner(1));
    await writeNativeTimingDatabase(home, [{ step: 1 }]);
    tracker.beginTurn(1000);
    expect((await tracker.collectNewTranscriptRequests()).usage?.outputTokensPerSecond).toBe(10);
    tracker.recordTurnPromptUsage({ usage: nativePrompt });
    tracker.beginTurn(10000);
    await appendFile(file, planner(3) + "\n");
    await writeNativeTimingDatabase(home, [
      { step: 1 },
      {
        step: 3,
        created: 10000,
        started: 12000,
        completed: 12004,
        thought: 10,
        streamDuration: 10,
      },
    ]);
    const update = await tracker.collectNewTranscriptRequests({ completedAtMs: 13000 });
    expect(update.requests[0]).toMatchObject({ reasoningOutputTokens: 10 });
    expect(update.requests[0]).not.toHaveProperty("startedAtMs");
    expect(update.usage).toMatchObject({ outputTokens: 40, outputTokensPerSecond: 10 });
  });

  it.each([
    { historical: false, thought: 0 },
    { historical: false, thought: 10 },
    { historical: true, thought: 0 },
    { historical: true, thought: 10 },
  ])(
    "keeps tool-call accounting but excludes its buffered timing: %j",
    async ({ historical, thought }) => {
      await transcript(
        planner(1),
        planner(3, {
          output_tokens: 1730,
          tool_calls: [{ name: "edit_file", args: { Path: "test" } }],
        }),
      );
      await writeNativeTimingDatabase(home, [
        { step: 1 },
        { step: 3, created: 10000, started: 12000, completed: 12004, output: 1730, thought },
      ]);
      const meter = new UsageMeter();
      meter.turnStarted("t", 1000);
      if (!historical) tracker.beginTurn(1000);
      const update = historical
        ? await tracker.replayHistoricalRequests()
        : await tracker.collectNewTranscriptRequests();
      expect(update.requests).toHaveLength(2);
      expect(update.requests[0]).toMatchObject({ startedAtMs: 3000, completedAtMs: 5000 });
      expect(update.requests[1]).toMatchObject({ outputTokens: 1730 });
      expect(update.requests[1]).not.toHaveProperty("startedAtMs");
      for (const request of update.requests) meter.recordRequest(request, historical ? null : "t");
      meter.recordHistory(
        historical ? update.complete : tracker.recordTurnPromptUsage({}).complete,
      );
      const usage = meter.derive(update.usage, {
        find: () => ({ input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }),
      });
      expect(usage).toMatchObject({ outputTokens: 1750, sessionOutputTokensPerSecond: 10 });
      expect(usage?.totalCostUsd).toBeCloseTo(2050 / 1_000_000);
      expect(usage?.outputTokensPerSecond).toBe(historical ? undefined : 10);
    },
  );

  it("does not fall back to prompt timing for a complete tool call when native timing is absent", async () => {
    await transcript(planner(1, { tool_calls: [{ name: "read_file", args: { Path: "test" } }] }));
    tracker.beginTurn(1000);
    const update = await tracker.collectNewTranscriptRequests({
      firstOutputAtMs: 7996,
      completedAtMs: 8000,
      promptUsage: nativePrompt,
    });
    expect(update.requests).toHaveLength(1);
    expect(update.requests[0]).not.toHaveProperty("startedAtMs");
    expect(update.usage?.outputTokens).toBe(20);
    expect(update.usage?.outputTokensPerSecond).toBeUndefined();
  });

  it("retains the last reliable speed when the next Turn only emits assembled tool calls", async () => {
    await transcript(planner(1));
    await writeNativeTimingDatabase(home, [{ step: 1 }]);
    tracker.beginTurn(1000);
    expect((await tracker.collectNewTranscriptRequests()).usage?.outputTokensPerSecond).toBe(10);
    tracker.endTurn();
    tracker.beginTurn(10000);
    await appendFile(
      file,
      planner(3, { tool_calls: [{ name: "read_file", args: { Path: "test" } }] }) + "\n",
    );
    await writeNativeTimingDatabase(home, [
      { step: 1 },
      { step: 3, created: 10000, started: 12000, completed: 13000 },
    ]);
    const update = await tracker.collectNewTranscriptRequests();
    expect(update.requests).toHaveLength(1);
    expect(update.requests[0]).not.toHaveProperty("startedAtMs");
    expect(update.timings).toEqual([
      { requestId: "step:3", requestStartedAtMs: 10000, timeToFirstOutputMs: 2000 },
    ]);
    expect(update.usage).toMatchObject({ outputTokens: 40, outputTokensPerSecond: 10 });
  });

  it("sums native per-request generation intervals without tool waits", async () => {
    await transcript(planner(1), planner(3, { output_tokens: 30 }));
    await writeNativeTimingDatabase(home, [
      { step: 1 },
      { step: 3, created: 10000, started: 12000, completed: 13000, output: 30 },
    ]);
    tracker.beginTurn(1000);
    const usage = {
      inputTokens: 200,
      cachedReadTokens: 100,
      cachedWriteTokens: 0,
      outputTokens: 50,
      thoughtTokens: 0,
    };
    const update = await tracker.collectNewTranscriptRequests({
      promptUsage: usage,
      firstOutputAtMs: 3000,
      completedAtMs: 18000,
      hasToolCalls: true,
    });
    expect(
      update.requests.map(({ startedAtMs, completedAtMs }) => ({ startedAtMs, completedAtMs })),
    ).toEqual([
      { startedAtMs: 3000, completedAtMs: 5000 },
      { startedAtMs: 12000, completedAtMs: 13000 },
    ]);
    const result = tracker.recordTurnPromptUsage({ usage });
    expect(result.complete).toBe(true);
    expect(result.usage?.outputTokensPerSecond).toBeCloseTo(50 / 3);
  });

  it.each([0, 10])("publishes usage before timing, thought=%i", async (thought) => {
    await transcript(planner(1));
    const database = await writeNativeTimingDatabase(home, [{ step: 1, thought }]);
    const db = new DatabaseSync(database);
    try {
      db.exec("DELETE FROM gen_metadata");
    } finally {
      db.close();
    }
    tracker.beginTurn(1000);
    const early = await tracker.collectNewTranscriptRequests();
    expect(early.complete).toBe(true);
    expect(early.requests).toMatchObject([
      { requestId: "step:1", outputTokens: 20, reasoningOutputTokens: thought },
    ]);
    expect(early.requests[0]).not.toHaveProperty("startedAtMs");
    expect(early.timings).toEqual([]);
    await writeNativeTimingDatabase(home, [{ step: 1, thought }]);
    const completed = await tracker.collectNewTranscriptRequests();
    expect(completed.requests).toEqual([]);
    expect(completed.timings).toEqual([
      {
        requestId: "step:1",
        requestStartedAtMs: 1000,
        timeToFirstOutputMs: 2000,
        output: { outputTokens: 20 - thought, startedAtMs: 3000, completedAtMs: 5000 },
      },
    ]);
    expect(completed.usage?.outputTokensPerSecond).toBe((20 - thought) / 2);
    expect((await tracker.collectNewTranscriptRequests()).timings).toEqual([]);
    const usage = { ...nativePrompt, thoughtTokens: thought };
    expect(
      (await tracker.collectNewTranscriptRequests({ promptUsage: usage, completedAtMs: 8000 }))
        .requests,
    ).toEqual([]);
    expect(tracker.recordTurnPromptUsage({ usage }).complete).toBe(true);
  });

  it("does not time a thinking-only request as a zero-speed measurement", async () => {
    await transcript(planner(1));
    await writeNativeTimingDatabase(home, [{ step: 1, thought: 20 }]);
    tracker.beginTurn(1000);
    const usage = { ...nativePrompt, thoughtTokens: 20 };
    const update = await tracker.collectNewTranscriptRequests({
      promptUsage: usage,
      completedAtMs: 8000,
    });
    expect(update.requests).toHaveLength(1);
    expect(update.requests[0]).toMatchObject({ outputTokens: 20, reasoningOutputTokens: 20 });
    expect(update.requests[0]).not.toHaveProperty("startedAtMs");
    expect(update.requests[0]).not.toHaveProperty("timedOutputTokens");
    expect(update.usage).not.toHaveProperty("outputTokensPerSecond");
  });

  it.each([0, 10])(
    "supplements already published usage with timing available at Turn end, thought=%i",
    async (thought) => {
      await transcript(planner(1));
      const file = await writeNativeTimingDatabase(home, [{ step: 1, thought }]);
      const db = new DatabaseSync(file);
      try {
        db.exec("DELETE FROM gen_metadata");
      } finally {
        db.close();
      }
      tracker.beginTurn(1000);
      const early = await tracker.collectNewTranscriptRequests();
      expect(early.requests).toMatchObject([{ reasoningOutputTokens: thought }]);
      expect(early.requests[0]).not.toHaveProperty("timedOutputTokens");
      await writeNativeTimingDatabase(home, [{ step: 1, thought }]);
      const usage = { ...nativePrompt, thoughtTokens: thought };
      const update = await tracker.collectNewTranscriptRequests({
        promptUsage: usage,
        completedAtMs: 8000,
      });
      expect(update.requests).toEqual([]);
      expect(update.timings).toMatchObject([{ timeToFirstOutputMs: 2000 }]);
      const result = tracker.recordTurnPromptUsage({ usage });
      expect(result.complete).toBe(true);
      expect(result.usage?.outputTokensPerSecond).toBe((20 - thought) / 2);
    },
  );

  it("does not backfill live speed when replaying historical native timings", async () => {
    await transcript(planner(1));
    await writeNativeTimingDatabase(home, [{ step: 1 }]);
    const history = await tracker.replayHistoricalRequests();
    expect(history.complete).toBe(true);
    expect(history.requests[0]).toMatchObject({
      historical: true,
      startedAtMs: 3000,
      completedAtMs: 5000,
    });
    expect(history.usage).not.toHaveProperty("outputTokensPerSecond");
  });

  it("does not reuse inherited or delayed prior-turn intervals for the current speed", async () => {
    tracker.beginTurn(1000);
    tracker.recordTurnPromptUsage({ usage: nativePrompt });
    tracker.beginTurn(10000);
    await transcript(planner(1), planner(3, { output_tokens: 30 }));
    await writeNativeTimingDatabase(home, [
      { step: 1 },
      { step: 3, created: 10000, started: 12000, completed: 13000, output: 30 },
    ]);
    const usage = { ...nativePrompt, outputTokens: 30 };
    const update = await tracker.collectNewTranscriptRequests({
      promptUsage: usage,
      completedAtMs: 15000,
    });
    expect(update.requests[0]).not.toHaveProperty("startedAtMs");
    expect(update.requests[1]).toMatchObject({ startedAtMs: 12000, completedAtMs: 13000 });
    expect(update.timings).toEqual([
      { requestId: "step:3", requestStartedAtMs: 10000, timeToFirstOutputMs: 2000 },
    ]);
    expect(tracker.recordTurnPromptUsage({ usage }).usage?.outputTokensPerSecond).toBe(30);
  });

  it("does not time a tool-bearing single-request Turn using the whole prompt interval", async () => {
    await transcript(planner(1));
    tracker.beginTurn();
    const update = await tracker.collectNewTranscriptRequests({
      promptUsage: nativePrompt,
      firstOutputAtMs: 1000,
      completedAtMs: 3000,
      hasToolCalls: true,
    });
    expect(update.requests[0]).not.toHaveProperty("startedAtMs");
    expect(update.usage).not.toHaveProperty("outputTokensPerSecond");
  });

  it.each([
    { thought: 0, retries: 1 },
    { thought: 10, retries: 1 },
    { thought: 10, attempts: 2 },
    { thought: 10, output: 21 },
  ])("does not time rejected native retries or mismatched usage: %j", async (fields) => {
    await transcript(planner(1));
    await writeNativeTimingDatabase(home, [{ step: 1, ...fields }]);
    tracker.beginTurn(1000);
    const usage = { ...nativePrompt, thoughtTokens: fields.thought };
    const update = await tracker.collectNewTranscriptRequests({
      promptUsage: usage,
      firstOutputAtMs: 3000,
      completedAtMs: 18000,
    });
    expect(update.requests).toHaveLength(1);
    expect(update.requests[0]).not.toHaveProperty("startedAtMs");
    expect(update.requests[0]).not.toHaveProperty("timedOutputTokens");
    expect(update.usage).not.toHaveProperty("outputTokensPerSecond");
    expect(tracker.recordTurnPromptUsage({ usage }).complete).toBe(true);
  });

  it("does not add thoughtTokens twice or time hidden thinking with a text-only interval", async () => {
    await transcript(planner(1, { input_tokens: 13035, cache_read_tokens: 0, output_tokens: 146 }));
    const usage = {
      inputTokens: 13035,
      cachedReadTokens: 0,
      cachedWriteTokens: 0,
      outputTokens: 146,
      thoughtTokens: 107,
      totalTokens: 13181,
    };
    tracker.beginTurn();
    const update = await tracker.collectNewTranscriptRequests({
      promptUsage: usage,
      firstOutputAtMs: 1000,
      completedAtMs: 3000,
    });
    const result = tracker.recordTurnPromptUsage({ usage });
    expect(update.requests).toHaveLength(1);
    expect(result.complete).toBe(true);
    expect(result.usage).toMatchObject({
      inputTokens: 13035,
      outputTokens: 146,
      totalTokens: 13181,
      reasoningOutputTokens: 107,
      sessionCacheUsage: { inputTokens: 13035, cachedInputTokens: 0 },
    });
    expect(update.requests[0]).not.toHaveProperty("startedAtMs");
    expect(result.usage).not.toHaveProperty("outputTokensPerSecond");
  });

  it("combines uncached input, cache reads/writes and reasoning in a validated snapshot", () => {
    tracker.recordContextWindow(9762, 1048576);
    tracker.beginTurn();
    const result = tracker.recordTurnPromptUsage({
      usage: prompt,
      firstOutputAtMs: 1000,
      completedAtMs: 3000,
    });
    expect(result.usage).toEqual({
      contextUsedTokens: 9762,
      contextWindowTokens: 1048576,
      contextUsagePercent: (9762 / 1048576) * 100,
      inputTokens: 18775,
      cachedInputTokens: 8097,
      cacheWriteInputTokens: 0,
      outputTokens: 147,
      reasoningOutputTokens: 0,
      totalTokens: 18922,
    });
    expect(parseHostUsage(result.usage)).toEqual(result.usage);
    expect(result).not.toHaveProperty("fallbackRequest");
    expect(result.complete).toBe(false);
    tracker.beginTurn();
    const next = tracker.recordTurnPromptUsage({
      usage: {
        inputTokens: 10,
        cachedReadTokens: 0,
        cachedWriteTokens: 3,
        outputTokens: 4,
        thoughtTokens: 2,
      },
    });
    expect(next.usage).toMatchObject({
      inputTokens: 18788,
      cachedInputTokens: 8097,
      cacheWriteInputTokens: 3,
      outputTokens: 151,
      reasoningOutputTokens: 2,
      totalTokens: 18939,
      contextWindowTokens: 1048576,
    });
    expect(next.usage).not.toHaveProperty("outputTokensPerSecond");
  });

  it("keeps unknown fields absent and known cache zero explicit", () => {
    expect(tracker.currentUsage()).toBeNull();
    expect(tracker.recordTurnPromptUsage({ usage: {} })).toMatchObject({ usage: null });
    tracker.beginTurn();
    const unknown = tracker.recordTurnPromptUsage({ usage: { inputTokens: 5, outputTokens: 2 } });
    expect(unknown.usage).toEqual({ inputTokens: 5, outputTokens: 2, totalTokens: 7 });
    expect(unknown).not.toHaveProperty("fallbackRequest");
    tracker.beginTurn();
    const zero = tracker.recordTurnPromptUsage({
      usage: { inputTokens: 5, outputTokens: 2, cachedReadTokens: 0 },
    });
    expect(zero).not.toHaveProperty("fallbackRequest");
    expect(zero.complete).toBe(false);
    expect(zero.usage).toEqual({
      inputTokens: 10,
      outputTokens: 4,
      totalTokens: 14,
    });
    expect(zero.usage).not.toHaveProperty("cachedInputTokens");
    expect(zero.usage).not.toHaveProperty("sessionCacheUsage");
    expect(tracker.recordTurnPromptUsage({ usage: { totalTokens: 9 } })).toMatchObject({
      usage: zero.usage,
    });
  });

  it("uses a partial PromptResponse only before any request is available", async () => {
    expect(tracker.recordTurnPromptUsage({ usage: { totalTokens: 9 } })).toMatchObject({
      usage: { totalTokens: 9 },
    });
    await transcript(planner(1));
    const history = await tracker.replayHistoricalRequests();
    expect(history.usage).toMatchObject({ inputTokens: 150, outputTokens: 20, totalTokens: 170 });
    expect(tracker.recordTurnPromptUsage({ usage: { totalTokens: 1 } })).toMatchObject({
      usage: history.usage,
    });
  });

  it.each([
    [{ input_tokens: 100, cache_read_tokens: 0 }, 0],
    [{ input_tokens: 100, cache_read_tokens: undefined }, undefined],
    [{ input_tokens: 0, cache_read_tokens: 0 }, undefined],
  ])("uses the latest request, not the cumulative average, for CH: %j", async (fields, ch) => {
    await transcript(planner(1));
    const history = await tracker.replayHistoricalRequests();
    expect(history.usage?.cacheHitRatePercent).toBe((50 / 150) * 100);
    await appendFile(file, `${planner(3, fields)}\n`);
    const result = await tracker.collectNewTranscriptRequests();
    if (ch === undefined) expect(result.usage).not.toHaveProperty("cacheHitRatePercent");
    else expect(result.usage?.cacheHitRatePercent).toBe(ch);
    expect(tracker.recordTurnPromptUsage({}).usage).toEqual(result.usage);
  });

  it("requires paired valid context facts and clamps the context percentage", () => {
    expect(tracker.recordContextWindow(0, 0)).toBeNull();
    expect(tracker.recordContextWindow(-1, 100)).toBeNull();
    expect(tracker.recordContextWindow(1.5, 100)).toBeNull();
    expect(tracker.recordContextWindow(0, 100)).toEqual({
      contextUsedTokens: 0,
      contextWindowTokens: 100,
      contextUsagePercent: 0,
    });
    expect(tracker.recordContextWindow(200, 100)?.contextUsagePercent).toBe(100);
    expect(tracker.recordContextWindow(1, Number.NaN)?.contextUsedTokens).toBe(200);
  });

  it("replays the latest version of each historical step once and accumulates cache facts", async () => {
    await transcript(
      JSON.stringify({ type: "USER_INPUT", content: "hello" }),
      planner(1),
      planner(1, { output_tokens: 30 }),
      planner(3, { input_tokens: 5, cache_read_tokens: 0, model: undefined }),
    );
    const history = await tracker.replayHistoricalRequests();
    expect(history.complete).toBe(true);
    expect(parseHostUsageRequest(history.requests[0])).toEqual(history.requests[0]);
    expect(history.requests).toEqual([
      {
        requestId: "step:1",
        historical: true,
        model: "gemini-4-carbon",
        provider: "google",
        inputTokens: 150,
        cachedInputTokens: 50,
        cacheWriteInputTokens: 0,
        outputTokens: 30,
      },
      {
        requestId: "step:3",
        historical: true,
        inputTokens: 5,
        cachedInputTokens: 0,
        outputTokens: 20,
      },
    ]);
    expect(history.usage).toEqual({
      inputTokens: 155,
      cachedInputTokens: 50,
      outputTokens: 50,
      totalTokens: 205,
      cacheHitRatePercent: 0,
      sessionCacheUsage: { inputTokens: 155, cachedInputTokens: 50 },
    });
    expect((await tracker.replayHistoricalRequests()).requests).toEqual([]);
    expect((await tracker.collectNewTranscriptRequests()).requests).toEqual([]);
    await appendFile(file, `${planner(5)}\n${planner(5)}\n`);
    const live = await tracker.collectNewTranscriptRequests();
    expect(live.requests.map((request) => request.requestId)).toEqual(["step:5"]);
    expect(live.requests[0]).not.toHaveProperty("historical");
    expect(live.usage).toMatchObject({
      inputTokens: 305,
      cachedInputTokens: 100,
      outputTokens: 70,
      totalTokens: 375,
      cacheHitRatePercent: (50 / 150) * 100,
      sessionCacheUsage: { inputTokens: 305, cachedInputTokens: 100 },
    });
    expect(tracker.recordTurnPromptUsage({})).toMatchObject({ usage: live.usage });
    expect((await tracker.collectNewTranscriptRequests()).requests).toEqual([]);
  });

  it("marks damaged or missing model usage incomplete and retries repaired steps", async () => {
    await transcript(planner(1), planner(3, { output_tokens: undefined }), "{ broken");
    const history = await tracker.replayHistoricalRequests();
    expect(history.complete).toBe(false);
    expect(history.requests).toHaveLength(1);
    expect(history.usage).not.toHaveProperty("sessionCacheUsage");
    await transcript(planner(1), planner(3));
    const repaired = await tracker.collectNewTranscriptRequests();
    expect(repaired.complete).toBe(true);
    expect(repaired.requests.map((request) => request.requestId)).toEqual(["step:3"]);
    expect(repaired.usage?.sessionCacheUsage).toEqual({ inputTokens: 300, cachedInputTokens: 100 });
  });

  it.each([
    [{ firstOutputAtMs: 1000, completedAtMs: 3000 }, true, 10],
    [{ firstOutputAtMs: 1000, completedAtMs: 1000 }, true, undefined],
    [{ firstOutputAtMs: 1000, completedAtMs: 999 }, false, undefined],
    [{ firstOutputAtMs: -1, completedAtMs: 1000 }, false, undefined],
    [{ firstOutputAtMs: 1.5, completedAtMs: 1000 }, false, undefined],
    [{ firstOutputAtMs: Number.NaN, completedAtMs: 1000 }, false, undefined],
    [{ firstOutputAtMs: 1000 }, false, undefined],
    [{ completedAtMs: 1000 }, false, undefined],
  ])("bounds single-request timing: %j", async (clock, hasTiming, tps) => {
    await tracker.replayHistoricalRequests();
    await transcript(planner(1));
    const result = await tracker.collectNewTranscriptRequests({
      ...clock,
      promptUsage: nativePrompt,
    });
    expect(result.requests[0]?.startedAtMs).toBe(
      hasTiming && "firstOutputAtMs" in clock ? clock.firstOutputAtMs : undefined,
    );
    expect(result.requests[0]?.completedAtMs).toBe(
      hasTiming && "completedAtMs" in clock ? clock.completedAtMs : undefined,
    );
    expect(result.usage?.outputTokensPerSecond).toBe(tps);
    const promptResult = tracker.recordTurnPromptUsage({ usage: nativePrompt, ...clock });
    expect(promptResult).not.toHaveProperty("fallbackRequest");
    expect(promptResult.usage?.outputTokensPerSecond).toBe(tps);
  });

  it("retains the latest valid TPS across untimed, invalid and multi-step rounds", async () => {
    await transcript(planner(1));
    await tracker.replayHistoricalRequests();
    tracker.beginTurn();
    await appendFile(file, `${planner(3)}\n`);
    const clock = { firstOutputAtMs: 1000, completedAtMs: 3000 };
    const timed = await tracker.collectNewTranscriptRequests({
      ...clock,
      promptUsage: nativePrompt,
    });
    expect(timed.usage?.outputTokensPerSecond).toBe(10);
    expect(timed.usage).toMatchObject({ inputTokens: 300, outputTokens: 40, totalTokens: 340 });
    tracker.recordTurnPromptUsage({ usage: nativePrompt, ...clock });

    tracker.beginTurn();
    await appendFile(file, `${planner(5)}\n`);
    expect((await tracker.collectNewTranscriptRequests()).usage?.outputTokensPerSecond).toBe(10);
    expect(
      tracker.recordTurnPromptUsage({ usage: nativePrompt }).usage?.outputTokensPerSecond,
    ).toBe(10);

    tracker.beginTurn();
    await appendFile(file, `${planner(7)}\n${planner(9)}\n`);
    const multiPrompt = {
      inputTokens: 200,
      cachedReadTokens: 100,
      cachedWriteTokens: 0,
      outputTokens: 40,
    };
    const multi = await tracker.collectNewTranscriptRequests({
      ...clock,
      promptUsage: multiPrompt,
    });
    expect(multi.usage?.outputTokensPerSecond).toBe(10);
    expect(
      tracker.recordTurnPromptUsage({ usage: multiPrompt, ...clock }).usage?.outputTokensPerSecond,
    ).toBe(10);

    tracker.beginTurn();
    await appendFile(file, `${planner(11, { output_tokens: 0 })}\n`);
    const zero = await tracker.collectNewTranscriptRequests({
      ...clock,
      promptUsage: { ...nativePrompt, outputTokens: 0 },
    });
    expect(zero.usage?.outputTokensPerSecond).toBe(10);
    expect(
      tracker.recordTurnPromptUsage({ usage: { ...nativePrompt, outputTokens: 0 }, ...clock }).usage
        ?.outputTokensPerSecond,
    ).toBe(10);

    tracker.beginTurn();
    await appendFile(file, `${planner(13)}\n`);
    const invalid = await tracker.collectNewTranscriptRequests({
      firstOutputAtMs: 4000,
      completedAtMs: 4000,
      promptUsage: nativePrompt,
    });
    expect(invalid.usage?.outputTokensPerSecond).toBe(10);
    expect(
      tracker.recordTurnPromptUsage({
        usage: nativePrompt,
        firstOutputAtMs: 4000,
        completedAtMs: 3999,
      }).usage?.outputTokensPerSecond,
    ).toBe(10);

    tracker.beginTurn();
    await appendFile(file, `${planner(15, { output_tokens: 40 })}\n`);
    const updated = await tracker.collectNewTranscriptRequests({
      firstOutputAtMs: 6000,
      completedAtMs: 7000,
      promptUsage: { ...nativePrompt, outputTokens: 40 },
    });
    expect(updated.usage).toMatchObject({
      inputTokens: 1200,
      outputTokens: 160,
      totalTokens: 1360,
      outputTokensPerSecond: 40,
    });
    tracker.recordTurnPromptUsage({ usage: { ...nativePrompt, outputTokens: 40 } });
    expect(tracker.recordContextWindow(50, 100)?.outputTokensPerSecond).toBe(40);
    expect((await tracker.replayHistoricalRequests()).usage?.outputTokensPerSecond).toBe(40);
  });

  it.each([1, 2])("does not bill %i refreshed requests again at Turn completion", async (steps) => {
    await tracker.replayHistoricalRequests();
    await transcript();
    tracker.beginTurn();
    for (let step = 1; step <= steps; step++) {
      await appendFile(file, `${planner(step)}\n`);
      expect((await tracker.collectNewTranscriptRequests()).requests).toHaveLength(1);
    }
    const clock = { firstOutputAtMs: 1000, completedAtMs: 3000 };
    const usage = {
      inputTokens: 100 * steps,
      cachedReadTokens: 50 * steps,
      cachedWriteTokens: 0,
      outputTokens: 20 * steps,
      thoughtTokens: 0,
    };
    const final = await tracker.collectNewTranscriptRequests({ ...clock, promptUsage: usage });
    expect(final.requests).toEqual([]);
    expect(final.timings).toEqual(
      steps === 1
        ? [
            {
              requestId: "step:1",
              output: { startedAtMs: 1000, completedAtMs: 3000, outputTokens: 20 },
            },
          ]
        : [],
    );
    const result = tracker.recordTurnPromptUsage({ usage, ...clock });
    expect(result).not.toHaveProperty("fallbackRequest");
    expect(result.usage).toMatchObject({
      inputTokens: 150 * steps,
      outputTokens: 20 * steps,
      totalTokens: 170 * steps,
    });
    expect(result.usage?.outputTokensPerSecond).toBe(steps === 1 ? 10 : undefined);

    tracker.beginTurn();
    expect((await tracker.collectNewTranscriptRequests()).requests).toEqual([]);
    const next = tracker.recordTurnPromptUsage({
      usage: { inputTokens: 10, cachedReadTokens: 0, cachedWriteTokens: 0, outputTokens: 2 },
    });
    expect(next).not.toHaveProperty("fallbackRequest");
    expect(next.complete).toBe(false);
    expect(next.usage).toMatchObject({
      inputTokens: 150 * steps + 10,
      outputTokens: 20 * steps + 2,
    });
  });

  it("does not time the final request as a single-request Turn after an earlier refresh", async () => {
    await transcript(planner(1));
    await tracker.collectNewTranscriptRequests();
    await appendFile(file, `${planner(3)}\n`);
    const clock = { firstOutputAtMs: 1000, completedAtMs: 3000 };
    const collected = await tracker.collectNewTranscriptRequests(clock);
    expect(collected.requests).toHaveLength(1);
    expect(collected.requests[0]).not.toHaveProperty("startedAtMs");
    expect(collected.usage).not.toHaveProperty("outputTokensPerSecond");
    expect(tracker.recordTurnPromptUsage({ usage: prompt, ...clock }).usage).not.toHaveProperty(
      "outputTokensPerSecond",
    );
  });

  it("does not assign whole-turn timing to requests in a multi-step tool loop", async () => {
    await transcript(planner(1), planner(3));
    const clock = { firstOutputAtMs: 1000, completedAtMs: 3000 };
    const collected = await tracker.collectNewTranscriptRequests(clock);
    expect(collected.requests).toHaveLength(2);
    for (const request of collected.requests) {
      expect(request).not.toHaveProperty("startedAtMs");
      expect(request).not.toHaveProperty("completedAtMs");
    }
    expect(collected.usage).not.toHaveProperty("outputTokensPerSecond");
    const result = tracker.recordTurnPromptUsage({ usage: prompt, ...clock });
    expect(result).not.toHaveProperty("fallbackRequest");
    expect(result.usage).not.toHaveProperty("outputTokensPerSecond");
  });

  it("does not time a partial multi-step transcript as one complete request", async () => {
    await transcript(planner(1), planner(3, { output_tokens: undefined }));
    const clock = { firstOutputAtMs: 1000, completedAtMs: 3000 };
    const result = await tracker.collectNewTranscriptRequests(clock);
    expect(result.complete).toBe(false);
    expect(result.requests).toHaveLength(1);
    expect(result.requests[0]).not.toHaveProperty("startedAtMs");
    expect(result.usage).not.toHaveProperty("outputTokensPerSecond");
    expect(tracker.recordTurnPromptUsage({ usage: prompt, ...clock }).usage).not.toHaveProperty(
      "outputTokensPerSecond",
    );
  });

  it("reports a previously populated transcript that disappears as incomplete", async () => {
    await transcript(planner(1));
    await tracker.replayHistoricalRequests();
    await rm(file);
    const result = await tracker.collectNewTranscriptRequests();
    expect(result.complete).toBe(false);
    expect(result.requests).toEqual([]);
    expect(result.usage).not.toHaveProperty("sessionCacheUsage");
  });

  it("does not publish TPS for zero output", async () => {
    await transcript(planner(1, { output_tokens: 0 }));
    const result = await tracker.collectNewTranscriptRequests({
      firstOutputAtMs: 0,
      completedAtMs: 1000,
      promptUsage: { ...nativePrompt, outputTokens: 0 },
    });
    expect(result.requests[0]).toMatchObject({ startedAtMs: 0, completedAtMs: 1000 });
    expect(result.usage).not.toHaveProperty("outputTokensPerSecond");
  });

  it("uses missing-log PromptResponse only for native tokens and bills the late native request once", async () => {
    expect(await tracker.replayHistoricalRequests()).toEqual({
      requests: [],
      complete: true,
      usage: null,
    });
    await transcript();
    expect((await tracker.collectNewTranscriptRequests()).requests).toEqual([]);
    tracker.beginTurn();
    const result = tracker.recordTurnPromptUsage({
      usage: { inputTokens: 100, cachedReadTokens: 50, outputTokens: 20 },
    });
    expect(result).not.toHaveProperty("fallbackRequest");
    expect(result.complete).toBe(false);
    await transcript(planner(1));
    const delayed = await tracker.collectNewTranscriptRequests();
    expect(delayed.requests.map((request) => request.requestId)).toEqual(["step:1"]);
    expect(delayed.complete).toBe(true);
    expect(delayed.usage?.sessionCacheUsage).toEqual({ inputTokens: 150, cachedInputTokens: 50 });
  });

  it.each(["RUNNING", undefined])("waits for a terminal native step (%s)", async (status) => {
    await transcript(planner(1, { status }));
    expect(await tracker.replayHistoricalRequests()).toMatchObject({
      requests: [],
      complete: false,
    });
    await appendFile(file, `${planner(1)}\n`);
    const final = await tracker.collectNewTranscriptRequests();
    expect(final.complete).toBe(true);
    expect(final.requests.map((request) => request.requestId)).toEqual(["step:1"]);
  });

  it.each([
    { model: "gemini-other" },
    { input_tokens: 101 },
    { output_tokens: 21 },
    { cache_read_tokens: 51 },
    { cache_write_tokens: 1 },
  ])("permanently invalidates changed published usage: %j", async (fields) => {
    await transcript(planner(1));
    await tracker.replayHistoricalRequests();
    await appendFile(file, `${planner(1, fields)}\n`);
    const changed = await tracker.collectNewTranscriptRequests();
    expect(changed.requests).toEqual([]);
    expect(changed.complete).toBe(false);
    await appendFile(file, `${planner(1)}\n`);
    expect((await tracker.collectNewTranscriptRequests()).complete).toBe(false);
  });

  it("does not call a derived Session with missing initial logs an empty complete history", async () => {
    const derived = new AntigravitySessionUsageTracker({
      nativeSessionId: "session",
      homedir: home,
      expectedInitialTurns: 3,
    });
    expect(await derived.replayHistoricalRequests()).toEqual({
      requests: [],
      complete: false,
      usage: null,
    });
    expect((await derived.collectNewTranscriptRequests()).complete).toBe(false);
    expect((await tracker.replayHistoricalRequests()).complete).toBe(true);
  });

  it("does not use USER_INPUT row counts as a second Turn identity", async () => {
    tracker = new AntigravitySessionUsageTracker({
      nativeSessionId: "session",
      homedir: home,
      expectedInitialTurns: 4,
    });
    await transcript(planner(1));
    await tracker.replayHistoricalRequests();
    tracker.beginTurn();
    await appendFile(
      file,
      `${JSON.stringify({ type: "USER_INPUT", step_index: 2 })}\n${planner(3)}\n`,
    );
    await tracker.collectNewTranscriptRequests({ promptUsage: nativePrompt });
    const result = tracker.recordTurnPromptUsage({ usage: nativePrompt });
    expect(result.complete).toBe(true);
    expect(result.usage).toMatchObject({ inputTokens: 300, outputTokens: 40 });
  });

  it.each([0, 15])(
    "defers live Claude requests until cacheWrite=%i is known",
    async (cacheWrite) => {
      await transcript(planner(1));
      await tracker.replayHistoricalRequests();
      tracker.beginTurn();
      await appendFile(
        file,
        `${planner(3, { model: "claude-opus-4-6", cache_read_tokens: 20 })}\n`,
      );
      const early = await tracker.collectNewTranscriptRequests();
      expect(early.requests).toEqual([]);
      expect(early.complete).toBe(false);
      const usage = {
        inputTokens: 100,
        cachedReadTokens: 20,
        cachedWriteTokens: cacheWrite,
        outputTokens: 20,
        thoughtTokens: 0,
      };
      const final = await tracker.collectNewTranscriptRequests({
        promptUsage: usage,
        firstOutputAtMs: 1000,
        completedAtMs: 3000,
      });
      expect(final.requests).toHaveLength(1);
      expect(final.requests[0]).toMatchObject({
        inputTokens: 120 + cacheWrite,
        cacheWriteInputTokens: cacheWrite,
        startedAtMs: 1000,
        completedAtMs: 3000,
      });
      expect(tracker.recordTurnPromptUsage({ usage })).toMatchObject({
        complete: true,
        usage: { inputTokens: 270 + cacheWrite, outputTokens: 40 },
      });
      const repeated = await tracker.collectNewTranscriptRequests();
      expect(repeated.requests).toEqual([]);
      expect(repeated.complete).toBe(true);
    },
  );

  it.each([0, 15])(
    "settles a completely late Claude request using cacheWrite=%i without a billable fallback",
    async (write) => {
      tracker.beginTurn();
      tracker.recordTurnPromptUsage({
        usage: {
          inputTokens: 100,
          cachedReadTokens: 20,
          cachedWriteTokens: write,
          outputTokens: 20,
        },
      });
      await transcript(planner(1, { model: "claude-opus-4-6", cache_read_tokens: 20 }));
      const late = await tracker.collectNewTranscriptRequests();
      expect(late.complete).toBe(true);
      expect(late.requests).toHaveLength(1);
      expect(late.requests[0]).toMatchObject({
        requestId: "step:1",
        inputTokens: 120 + write,
        cacheWriteInputTokens: write,
      });
      expect(late.usage).toMatchObject({ inputTokens: 120 + write, outputTokens: 20 });
      expect((await tracker.collectNewTranscriptRequests()).requests).toEqual([]);
    },
  );

  it("fills explicit zero writes for all deferred requests without splitting positive writes", async () => {
    tracker.beginTurn();
    await transcript(
      planner(1, { model: "claude-opus-4-6" }),
      planner(3, { model: "claude-opus-4-6" }),
    );
    expect((await tracker.collectNewTranscriptRequests()).requests).toEqual([]);
    const usage = {
      inputTokens: 200,
      cachedReadTokens: 100,
      cachedWriteTokens: 0,
      outputTokens: 40,
    };
    const final = await tracker.collectNewTranscriptRequests({
      promptUsage: usage,
      firstOutputAtMs: 1000,
      completedAtMs: 3000,
    });
    expect(final.requests).toHaveLength(2);
    expect(
      final.requests.every(
        (request) => request.cacheWriteInputTokens === 0 && request.startedAtMs === undefined,
      ),
    ).toBe(true);
    expect(tracker.recordTurnPromptUsage({ usage }).complete).toBe(true);
  });

  it("retains a partial Turn gap and native totals until its late request arrives", async () => {
    tracker.beginTurn();
    await transcript(planner(1));
    expect((await tracker.collectNewTranscriptRequests()).requests).toHaveLength(1);
    const usage = {
      inputTokens: 200,
      cachedReadTokens: 100,
      cachedWriteTokens: 0,
      outputTokens: 40,
    };
    const final = await tracker.collectNewTranscriptRequests({
      promptUsage: usage,
      firstOutputAtMs: 1000,
      completedAtMs: 3000,
    });
    expect(final.requests).toEqual([]);
    expect(tracker.recordTurnPromptUsage({ usage })).toMatchObject({
      complete: false,
      usage: { inputTokens: 300, outputTokens: 40 },
    });
    expect((await tracker.collectNewTranscriptRequests()).complete).toBe(false);
    await appendFile(file, `${planner(3)}\n`);
    const late = await tracker.collectNewTranscriptRequests();
    expect(late.complete).toBe(true);
    expect(late.requests.map((request) => request.requestId)).toEqual(["step:3"]);
    expect(late.usage).toMatchObject({ inputTokens: 300, outputTokens: 40 });
    expect(late.usage).not.toHaveProperty("outputTokensPerSecond");
    expect((await tracker.collectNewTranscriptRequests()).requests).toEqual([]);
  });

  it("does not add a whole-Turn fallback to two completely delayed requests", async () => {
    tracker.beginTurn();
    tracker.recordTurnPromptUsage({
      usage: { inputTokens: 200, cachedReadTokens: 100, cachedWriteTokens: 0, outputTokens: 40 },
    });
    await transcript(planner(1), planner(3));
    const late = await tracker.collectNewTranscriptRequests();
    expect(late.requests.map((request) => request.requestId)).toEqual(["step:1", "step:3"]);
    expect(late.complete).toBe(true);
    expect(late.usage).toMatchObject({ inputTokens: 300, outputTokens: 40 });
  });

  it("recovers multiple delayed Turns without matching unrelated equal-token requests", async () => {
    tracker.beginTurn();
    tracker.recordTurnPromptUsage({ usage: nativePrompt });
    tracker.beginTurn();
    tracker.recordTurnPromptUsage({ usage: nativePrompt });
    await transcript(planner(1));
    const partial = await tracker.collectNewTranscriptRequests();
    expect(partial.complete).toBe(false);
    expect(partial.usage).toMatchObject({ inputTokens: 300, outputTokens: 40 });
    await appendFile(file, `${planner(3)}\n`);
    const full = await tracker.collectNewTranscriptRequests();
    expect(full.complete).toBe(true);
    expect(full.requests.map((request) => request.requestId)).toEqual(["step:3"]);
    expect(full.usage).toMatchObject({ inputTokens: 300, outputTokens: 40 });
  });

  it("keeps latest-request CH in native step order when an earlier Turn's request arrives last", async () => {
    tracker.beginTurn();
    tracker.recordTurnPromptUsage({ usage: nativePrompt });
    tracker.beginTurn();
    await transcript(planner(3, { input_tokens: 80, cache_read_tokens: 120, output_tokens: 10 }));
    await tracker.collectNewTranscriptRequests();
    tracker.recordTurnPromptUsage({
      usage: { inputTokens: 80, cachedReadTokens: 120, cachedWriteTokens: 0, outputTokens: 10 },
    });
    await appendFile(file, `${planner(1)}\n`);
    const result = await tracker.collectNewTranscriptRequests();
    expect(result.complete).toBe(true);
    expect(result.usage).toMatchObject({
      inputTokens: 350,
      outputTokens: 30,
      cacheHitRatePercent: 60,
    });
  });

  it.each([undefined, {}, { totalTokens: 9 }])(
    "does not retain a cancelled/refused Turn gap for invalid PromptResponse usage %j",
    async (usage) => {
      tracker.beginTurn();
      await transcript(JSON.stringify({ type: "USER_INPUT", step_index: 0 }));
      await tracker.collectNewTranscriptRequests();
      tracker.recordTurnPromptUsage(usage === undefined ? {} : { usage });
      expect((await tracker.collectNewTranscriptRequests()).complete).toBe(true);
      tracker.beginTurn();
      await appendFile(file, `${planner(3)}\n`);
      await tracker.collectNewTranscriptRequests({ promptUsage: nativePrompt });
      expect(tracker.recordTurnPromptUsage({ usage: nativePrompt })).toMatchObject({
        complete: true,
        usage: { inputTokens: 150, outputTokens: 20 },
      });
    },
  );

  it.each([{}, { totalTokens: 170 }, { inputTokens: 100 }, { outputTokens: 20 }])(
    "does not time a request against an incomplete PromptResponse %j",
    async (usage) => {
      tracker.beginTurn();
      await transcript(planner(1));
      const result = await tracker.collectNewTranscriptRequests({
        promptUsage: usage,
        firstOutputAtMs: 1000,
        completedAtMs: 3000,
      });
      expect(result.requests[0]).not.toHaveProperty("startedAtMs");
      expect(result.usage).not.toHaveProperty("outputTokensPerSecond");
      tracker.recordTurnPromptUsage({ usage });
      expect((await tracker.collectNewTranscriptRequests()).complete).toBe(true);
    },
  );

  it("ends a throwing Turn without leaving usage refresh in a running state", async () => {
    tracker.beginTurn();
    tracker.endTurn();
    expect((await tracker.collectNewTranscriptRequests()).complete).toBe(true);
  });

  it("honors an aborted read", async () => {
    await expect(tracker.replayHistoricalRequests(AbortSignal.abort())).rejects.toThrow();
    await expect(
      tracker.collectNewTranscriptRequests({ signal: AbortSignal.abort() }),
    ).rejects.toThrow();
  });

  it("sets implicit zero cacheWrite for Gemini/GPT and reconciles live PromptResponse cacheWrite for Claude", async () => {
    await transcript(
      planner(1, { model: "claude-sonnet-5-5-medium", input_tokens: 100, cache_read_tokens: 20 }),
    );
    const coldClaude = await tracker.replayHistoricalRequests();
    expect(coldClaude.requests[0]).not.toHaveProperty("cacheWriteInputTokens");

    await appendFile(
      file,
      `${planner(3, { model: "claude-sonnet-5-5-medium", input_tokens: 100, cache_read_tokens: 20 })}\n`,
    );
    tracker.beginTurn();
    const liveClaudeZero = await tracker.collectNewTranscriptRequests({
      promptUsage: {
        inputTokens: 100,
        cachedReadTokens: 20,
        cachedWriteTokens: 0,
        outputTokens: 20,
      },
    });
    expect(liveClaudeZero.requests[0]?.cacheWriteInputTokens).toBe(0);
    tracker.recordTurnPromptUsage({
      usage: { inputTokens: 100, cachedReadTokens: 20, cachedWriteTokens: 0, outputTokens: 20 },
    });

    await appendFile(
      file,
      `${planner(5, { model: "claude-sonnet-5-5-medium", input_tokens: 100, cache_read_tokens: 20 })}\n`,
    );
    tracker.beginTurn();
    const liveClaudeWrite = await tracker.collectNewTranscriptRequests({
      promptUsage: {
        inputTokens: 100,
        cachedReadTokens: 20,
        cachedWriteTokens: 15,
        outputTokens: 20,
      },
    });
    expect(liveClaudeWrite.requests[0]).toMatchObject({
      inputTokens: 135,
      cachedInputTokens: 20,
      cacheWriteInputTokens: 15,
    });
  });
});
