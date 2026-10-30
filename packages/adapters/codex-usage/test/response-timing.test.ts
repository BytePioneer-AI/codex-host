import { describe, expect, it } from "vitest";
import { CodexResponseTiming } from "../src/response-timing.js";
import { createUsageStatisticsAdapter } from "../src/plugin.js";

const frame = (method: string, params: object = {}) => ({
  method,
  params: { threadId: "s", turnId: "t", ...params },
});
const started = (id = "t") => frame("turn/started", { turn: { id } });
const delta = (text = "hello") => frame("item/agentMessage/delta", { delta: text });
const complete = (id = "r", usage: unknown = { outputTokens: 100, reasoningOutputTokens: 0 }) =>
  frame("rawResponse/completed", { responseId: id, usage });
const ended = (status = "completed") => frame("turn/completed", { turn: { id: "t", status } });

describe("Codex request-level response timing", () => {
  it("pairs first nonempty output with exact raw completion, not item, usage or turn completion", () => {
    const timing = new CodexResponseTiming();
    timing.observe(started(), 0);
    timing.observe(delta(""), 100);
    timing.observe(delta(), 1000);
    timing.observe(delta(), 1500);
    expect(
      timing.observe(frame("item/completed", { item: { type: "agentMessage" } }), 1600),
    ).toBeNull();
    expect(timing.observe(complete(), 2000)).toEqual({
      sessionId: "s",
      requestTiming: {
        requestId: "r",
        turnId: "t",
        outputTokens: 100,
        startedAtMs: 1000,
        completedAtMs: 2000,
      },
    });
    expect(
      timing.observe(frame("item/commandExecution/outputDelta", { delta: "tool result" }), 4000),
    ).toBeNull();
    expect(
      timing.observe(
        frame("rawResponseItem/completed", { item: { type: "function_call_output" } }),
        4000,
      ),
    ).toBeNull();
    expect(timing.observe(frame("thread/tokenUsage/updated"), 5000)).toBeNull();
    expect(timing.observe(ended(), 6000)).toBeNull();
  });

  it("supports repeated model requests within one turn and ignores duplicate completions without consuming new output", () => {
    const timing = new CodexResponseTiming();
    timing.observe(started(), 0);
    timing.observe(delta(), 1000);
    timing.observe(complete(), 2000);
    timing.observe(delta(), 7000);
    expect(timing.observe(complete(), 7100)).toBeNull();
    timing.observe(started(), 7200);
    expect(timing.observe(complete("r2"), 8000)?.requestTiming?.startedAtMs).toBe(7000);
  });

  it.each([
    ["missing usage", null, true, 2000],
    ["missing first output", { outputTokens: 100, reasoningOutputTokens: 0 }, false, 2000],
    ["invalid reasoning count", { outputTokens: 100, reasoningOutputTokens: 101 }, true, 2000],
    ["invalid counts", { outputTokens: -1, reasoningOutputTokens: 0 }, true, 2000],
    ["zero interval", { outputTokens: 100, reasoningOutputTokens: 0 }, true, 1000],
    ["clock moved back", { outputTokens: 100, reasoningOutputTokens: 0 }, true, 900],
  ])("invalidates the whole turn for %s", (_name, usage, output, end) => {
    const timing = new CodexResponseTiming();
    timing.observe(started(), 0);
    if (output) timing.observe(delta(), 1000);
    expect(timing.observe(complete("r", usage), Number(end))?.timingUnavailable).toEqual({
      turnId: "t",
    });
    timing.observe(delta(), 3000);
    expect(timing.observe(complete("r2"), 4000)?.requestTiming).toBeUndefined();
  });

  it.each(["reasoning", "agentMessage", "plan"])(
    "uses the first %s block start even without visible thinking",
    (type) => {
      const timing = new CodexResponseTiming();
      timing.observe(started(), 0);
      timing.observe(frame("item/started", { item: { type } }), 1000);
      timing.observe(frame("item/started", { item: { type: "agentMessage" } }), 1300);
      timing.observe(delta(), 1400);
      expect(
        timing.observe(complete("r", { outputTokens: 92, reasoningOutputTokens: 42 }), 2000)
          ?.requestTiming,
      ).toMatchObject({ outputTokens: 92, startedAtMs: 1000, completedAtMs: 2000 });
    },
  );

  it.each([{ outputTokens: 92, reasoningOutputTokens: 42 }, { outputTokens: 92 }])(
    "matches the other adapters' first-observed-output fallback with usage %j",
    (usage) => {
      const timing = new CodexResponseTiming();
      timing.observe(started(), 0);
      timing.observe(delta(), 1000);
      expect(timing.observe(complete("r", usage), 2000)?.requestTiming).toMatchObject({
        outputTokens: 92,
        startedAtMs: 1000,
      });
    },
  );

  it("accepts visible reasoning and includes reasoning tokens only once", () => {
    const timing = new CodexResponseTiming();
    timing.observe(started(), 0);
    timing.observe(frame("item/reasoning/summaryTextDelta", { delta: "think" }), 1000);
    timing.observe(delta(), 1200);
    expect(
      timing.observe(complete("r", { outputTokens: 100, reasoningOutputTokens: 30 }), 2000)
        ?.requestTiming,
    ).toMatchObject({ outputTokens: 100, startedAtMs: 1000 });
  });

  it.each(["interrupted", "failed", "completed"])(
    "rejects an unmatched stream at terminal status %s",
    (status) => {
      const timing = new CodexResponseTiming();
      timing.observe(started(), 0);
      timing.observe(delta(), 1000);
      expect(timing.observe(ended(status), 2000)?.timingUnavailable).toBeDefined();
      expect(timing.observe(complete(), 3000)).toBeNull();
    },
  );

  it("invalidates retry ambiguity and resets on the next turn", () => {
    const timing = new CodexResponseTiming();
    timing.observe(started(), 0);
    timing.observe(delta(), 1000);
    timing.observe(frame("error", { willRetry: true }), 1200);
    expect(timing.observe(complete(), 2000)?.timingUnavailable).toBeDefined();
    timing.observe(ended(), 2100);
    timing.observe(started("t2"), 3000);
    timing.observe(frame("item/agentMessage/delta", { turnId: "t2", delta: "new" }), 4000);
    expect(
      timing.observe(
        frame("rawResponse/completed", {
          turnId: "t2",
          responseId: "new",
          usage: { outputTokens: 20, reasoningOutputTokens: 0 },
        }),
        5000,
      )?.requestTiming,
    ).toBeDefined();
  });

  it("does not measure a resumed in-progress turn, another thread, or across reconnect", () => {
    const timing = new CodexResponseTiming();
    timing.observe(delta(), 1000);
    expect(timing.observe(complete(), 2000)).toBeNull();
    timing.observe(started(), 0);
    timing.observe(delta(), 1000);
    expect(
      timing.observe(frame("rawResponse/completed", { threadId: "other", responseId: "r" }), 2000),
    ).toBeNull();
    timing.reset();
    expect(timing.observe(complete(), 3000)).toBeNull();
  });

  it("does not count tools-only output or unfinished hidden items as a measured stream", () => {
    const timing = new CodexResponseTiming();
    timing.observe(started(), 0);
    timing.observe(frame("item/commandExecution/outputDelta", { delta: "tool" }), 1000);
    expect(timing.observe(complete(), 2000)?.timingUnavailable).toBeDefined();
    timing.reset();
    timing.observe(started(), 0);
    timing.observe(frame("item/started", { item: { type: "reasoning" } }), 1000);
    expect(timing.observe(ended(), 2000)?.timingUnavailable).toBeDefined();
  });
});

it("only opts new threads into raw notifications when the native client negotiated experimental APIs", async () => {
  const plugin = createUsageStatisticsAdapter({
    environment: {},
    platform: process.platform,
    managedRemoteHost: false,
  });
  const capability = plugin.sessionUsage;
  if (!capability?.requestOptions) throw new Error("missing capability");
  const initializeParams = { capabilities: { experimentalApi: true } };
  try {
    expect(
      capability.requestOptions({ method: "thread/start", params: {}, initializeParams }),
    ).toEqual({ experimentalRawEvents: true });
    expect(
      capability.requestOptions({ method: "thread/start", params: {}, initializeParams: null }),
    ).toBeNull();
    expect(
      capability.requestOptions({
        method: "thread/start",
        params: {},
        initializeParams: { capabilities: { experimentalApi: false } },
      }),
    ).toBeNull();
    expect(
      capability.requestOptions({
        method: "thread/start",
        params: { experimentalRawEvents: false },
        initializeParams,
      }),
    ).toEqual({ experimentalRawEvents: true });
    expect(
      capability.requestOptions({
        method: "thread/start",
        params: {},
        initializeParams: {
          capabilities: {
            experimentalApi: true,
            optOutNotificationMethods: ["rawResponse/completed"],
          },
        },
      }),
    ).toBeNull(); // A plugin that missed initialization must not claim a working raw subscription.
    for (const method of ["thread/resume", "turn/start", "turn/interrupt", "initialize"])
      expect(capability.requestOptions({ method, params: {}, initializeParams })).toBeNull();

    const params = {
      capabilities: {
        experimentalApi: true,
        otherCapability: true,
        optOutNotificationMethods: ["rawResponse/completed", "rawResponseItem/completed"],
      },
    };
    expect(
      capability.requestOptions({ method: "initialize", params, initializeParams: null }),
    ).toEqual({
      capabilities: {
        ...params.capabilities,
        optOutNotificationMethods: ["rawResponseItem/completed"],
      },
    });
    capability.reset?.(); // Successful initialization resets timing, not subscription intent.
    expect(capability.shouldForwardNotification?.({ method: "rawResponse/completed" })).toBe(false);
    expect(capability.shouldForwardNotification?.({ method: "thread/tokenUsage/updated" })).toBe(
      true,
    );
    expect(params.capabilities.optOutNotificationMethods).toHaveLength(2);
    capability.requestOptions({
      method: "initialize",
      params: initializeParams,
      initializeParams: null,
    });
    expect(capability.shouldForwardNotification?.({ method: "rawResponse/completed" })).toBe(true);
  } finally {
    await plugin.close();
  }
});
