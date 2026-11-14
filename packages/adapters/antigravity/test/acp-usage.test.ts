import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parseHostUsage, parseHostUsageRequest } from "@codexhost/harness-adapter";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
  it("combines uncached input, cache reads/writes and reasoning in a validated snapshot", () => {
    tracker.recordContextWindow(9762, 1048576);
    const result = tracker.recordTurnPromptUsage({
      usage: prompt,
      model: "gemini-4-carbon-high",
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
      outputTokensPerSecond: 73.5,
      cacheHitRatePercent: (8097 / 18775) * 100,
      sessionCacheUsage: { inputTokens: 18775, cachedInputTokens: 8097 },
    });
    expect(parseHostUsage(result.usage)).toEqual(result.usage);
    expect(parseHostUsageRequest(result.fallbackRequest)).toEqual({
      requestId: "prompt:1",
      model: "gemini-4-carbon",
      provider: "google",
      inputTokens: 18775,
      cachedInputTokens: 8097,
      cacheWriteInputTokens: 0,
      outputTokens: 147,
      reasoningOutputTokens: 0,
      startedAtMs: 1000,
      completedAtMs: 3000,
    });
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
      outputTokens: 153,
      reasoningOutputTokens: 2,
      totalTokens: 18941,
      cacheHitRatePercent: 0,
      sessionCacheUsage: { inputTokens: 18788, cachedInputTokens: 8097 },
      contextWindowTokens: 1048576,
    });
    expect(next.usage?.outputTokensPerSecond).toBe(73.5);
  });

  it("keeps unknown fields absent and known cache zero explicit", () => {
    expect(tracker.currentUsage()).toBeNull();
    expect(tracker.recordTurnPromptUsage({ usage: {} })).toEqual({ usage: null });
    const unknown = tracker.recordTurnPromptUsage({ usage: { inputTokens: 5, outputTokens: 2 } });
    expect(unknown.usage).toEqual({ inputTokens: 5, outputTokens: 2, totalTokens: 7 });
    expect(unknown.fallbackRequest).not.toHaveProperty("cachedInputTokens");
    const zero = tracker.recordTurnPromptUsage({
      usage: { inputTokens: 5, outputTokens: 2, cachedReadTokens: 0 },
    });
    expect(zero.fallbackRequest).toHaveProperty("cachedInputTokens", 0);
    expect(zero.usage).toEqual({
      inputTokens: 10,
      outputTokens: 4,
      totalTokens: 14,
      cacheHitRatePercent: 0,
    });
    expect(zero.usage).not.toHaveProperty("cachedInputTokens");
    expect(zero.usage).not.toHaveProperty("sessionCacheUsage");
    expect(tracker.recordTurnPromptUsage({ usage: { totalTokens: 9 } })).toEqual({
      usage: zero.usage,
    });
  });

  it("uses a partial PromptResponse only before any request is available", async () => {
    expect(tracker.recordTurnPromptUsage({ usage: { totalTokens: 9 } })).toEqual({
      usage: { totalTokens: 9 },
    });
    await transcript(planner(1));
    const history = await tracker.replayHistoricalRequests();
    expect(history.usage).toMatchObject({ inputTokens: 150, outputTokens: 20, totalTokens: 170 });
    expect(tracker.recordTurnPromptUsage({ usage: { totalTokens: 1 } })).toEqual({
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
    expect(tracker.recordTurnPromptUsage({ usage: prompt }).usage).toEqual(result.usage);
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
    const initialized = new AntigravitySessionUsageTracker({
      nativeSessionId: "session",
      homedir: home,
      initialContextUsedTokens: 10,
      initialContextWindowTokens: 100,
    });
    expect(initialized.currentUsage()?.contextUsagePercent).toBe(10);
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
    expect(history.requests).toEqual([
      {
        requestId: "step:1",
        historical: true,
        model: "gemini-4-carbon",
        provider: "google",
        inputTokens: 150,
        cachedInputTokens: 50,
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
    expect(tracker.recordTurnPromptUsage({ usage: prompt })).toEqual({ usage: live.usage });
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
    const result = await tracker.collectNewTranscriptRequests(clock);
    expect(result.requests[0]?.startedAtMs).toBe(hasTiming ? clock.firstOutputAtMs : undefined);
    expect(result.requests[0]?.completedAtMs).toBe(hasTiming ? clock.completedAtMs : undefined);
    expect(result.usage?.outputTokensPerSecond).toBe(tps);
    const promptResult = tracker.recordTurnPromptUsage({ usage: prompt, ...clock });
    expect(promptResult.fallbackRequest).toBeUndefined();
    expect(promptResult.usage?.outputTokensPerSecond).toBe(tps === undefined ? undefined : 73.5);
  });

  it("retains the latest valid TPS across untimed, invalid and multi-step rounds", async () => {
    await transcript(planner(1));
    await tracker.replayHistoricalRequests();
    await appendFile(file, `${planner(3)}\n`);
    const clock = { firstOutputAtMs: 1000, completedAtMs: 3000 };
    const timed = await tracker.collectNewTranscriptRequests(clock);
    expect(timed.usage?.outputTokensPerSecond).toBe(10);
    expect(timed.usage).toMatchObject({ inputTokens: 300, outputTokens: 40, totalTokens: 340 });

    await appendFile(file, `${planner(5)}\n`);
    expect((await tracker.collectNewTranscriptRequests()).usage?.outputTokensPerSecond).toBe(10);
    expect(tracker.recordTurnPromptUsage({ usage: prompt }).usage?.outputTokensPerSecond).toBe(10);

    await appendFile(file, `${planner(7)}\n${planner(9)}\n`);
    const multi = await tracker.collectNewTranscriptRequests(clock);
    expect(multi.usage?.outputTokensPerSecond).toBe(10);
    expect(
      tracker.recordTurnPromptUsage({ usage: prompt, ...clock }).usage?.outputTokensPerSecond,
    ).toBe(10);

    await appendFile(file, `${planner(11, { output_tokens: 0 })}\n`);
    const zero = await tracker.collectNewTranscriptRequests(clock);
    expect(zero.usage?.outputTokensPerSecond).toBe(10);
    expect(
      tracker.recordTurnPromptUsage({ usage: { inputTokens: 100, outputTokens: 0 }, ...clock })
        .usage?.outputTokensPerSecond,
    ).toBe(10);

    await appendFile(file, `${planner(13)}\n`);
    const invalid = await tracker.collectNewTranscriptRequests({
      firstOutputAtMs: 4000,
      completedAtMs: 4000,
    });
    expect(invalid.usage?.outputTokensPerSecond).toBe(10);
    expect(
      tracker.recordTurnPromptUsage({ usage: prompt, firstOutputAtMs: 4000, completedAtMs: 3999 })
        .usage?.outputTokensPerSecond,
    ).toBe(10);

    await appendFile(file, `${planner(15, { output_tokens: 40 })}\n`);
    const updated = await tracker.collectNewTranscriptRequests({
      firstOutputAtMs: 6000,
      completedAtMs: 7000,
    });
    expect(updated.usage).toMatchObject({
      inputTokens: 1200,
      outputTokens: 160,
      totalTokens: 1360,
      outputTokensPerSecond: 40,
    });
    expect(tracker.recordContextWindow(50, 100)?.outputTokensPerSecond).toBe(40);
    expect((await tracker.replayHistoricalRequests()).usage?.outputTokensPerSecond).toBe(40);
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
    expect(result.fallbackRequest).toBeUndefined();
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
    });
    expect(result.requests[0]).toMatchObject({ startedAtMs: 0, completedAtMs: 1000 });
    expect(result.usage).not.toHaveProperty("outputTokensPerSecond");
  });

  it("handles a missing or empty new transcript and suppresses a delayed fallback duplicate", async () => {
    expect(await tracker.replayHistoricalRequests()).toEqual({
      requests: [],
      complete: true,
      usage: null,
    });
    await transcript();
    expect((await tracker.collectNewTranscriptRequests()).requests).toEqual([]);
    const result = tracker.recordTurnPromptUsage({
      usage: { inputTokens: 100, cachedReadTokens: 50, outputTokens: 20 },
    });
    expect(result.fallbackRequest?.requestId).toBe("prompt:1");
    await transcript(planner(1));
    const delayed = await tracker.collectNewTranscriptRequests();
    expect(delayed.requests).toEqual([]);
    expect(delayed.usage?.sessionCacheUsage).toEqual({ inputTokens: 150, cachedInputTokens: 50 });
  });

  it("honors an aborted read", async () => {
    await expect(tracker.replayHistoricalRequests(AbortSignal.abort())).rejects.toThrow();
    await expect(
      tracker.collectNewTranscriptRequests({ signal: AbortSignal.abort() }),
    ).rejects.toThrow();
  });
});
