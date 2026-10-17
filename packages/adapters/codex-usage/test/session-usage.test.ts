import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createUsageStatisticsAdapter } from "../src/plugin.js";
import { createCodexUsageStatistics } from "../src/usage-statistics.js";
import { observeSessionUsage } from "../src/session-observation.js";

const thread = "00000000-0000-4000-8000-000000000001";
let home: string, file: string;
const signal = () => new AbortController().signal;
const line = (type: string, payload: object) =>
  JSON.stringify({ timestamp: "2026-01-01T00:00:00Z", type, payload }) + "\n";
const request = (response: string, model = "model-a") =>
  line("turn_context", { turn_id: response, model }) +
  line("token_usage_record", {
    thread_id: thread,
    session_id: thread,
    turn_id: response,
    response_id: response,
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cached_input_tokens: 80,
      reasoning_output_tokens: 10,
    },
  });
const adapter = () => {
  const plugin = createUsageStatisticsAdapter({
    environment: { CODEX_HOME: home },
    platform: process.platform,
    managedRemoteHost: false,
  });
  if (!plugin.sessionUsage) throw new Error("Missing session usage capability");
  return { ...plugin, sessionUsage: plugin.sessionUsage };
};
beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "session-usage-"));
  await mkdir(path.join(home, "sessions"));
  file = path.join(home, "sessions", `rollout-2026-01-01T00-00-00-${thread}.jsonl`);
  await writeFile(file, line("session_meta", { id: thread, session_id: thread }) + request("r1"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("Codex session usage capability", () => {
  it("replays history, preserves per-request models and deduplicates appended checkpoints", async () => {
    const plugin = adapter();
    const capability = plugin.sessionUsage;
    try {
      expect(await capability.read(thread, signal())).toMatchObject({
        complete: true,
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          cachedInputTokens: 80,
          totalTokens: 120,
          cacheHitRatePercent: 80,
        },
        requests: [{ model: "model-a", historical: true, cacheWriteInputTokens: 0 }],
      });
      await appendFile(file, request("r1") + request("r2", "model-b"));
      const updated = await capability.read(thread, signal());
      expect(updated?.requests.map((r) => r.model)).toEqual(["model-a", "model-b"]);
      expect(updated?.usage?.totalTokens).toBe(240);
      expect(await capability.read(thread, signal())).toEqual(updated);
      await writeFile(
        file,
        line("session_meta", { id: thread, session_id: thread }) + request("r1"),
      );
      expect((await capability.read(thread, signal()))?.requests).toHaveLength(1);
    } finally {
      await plugin.close();
    }
  });

  it("does not claim complete cost before native usage has reached disk", async () => {
    const plugin = adapter();
    try {
      plugin.sessionUsage.observe({
        method: "thread/tokenUsage/updated",
        params: { threadId: thread, tokenUsage: { total: { inputTokens: 200, outputTokens: 40 } } },
      });
      expect((await plugin.sessionUsage.read(thread, signal()))?.complete).toBe(false);
      await appendFile(file, request("r2"));
      expect((await plugin.sessionUsage.read(thread, signal()))?.complete).toBe(true);
    } finally {
      await plugin.close();
    }
  });

  it("restores context from legacy checkpoints and fails closed on incomplete or inherited history", async () => {
    const plugin = adapter();
    try {
      const counts = {
        input_tokens: 100,
        output_tokens: 20,
        cached_input_tokens: 80,
        total_tokens: 120,
      };
      await appendFile(
        file,
        line("event_msg", {
          type: "token_count",
          info: { total_token_usage: counts, last_token_usage: counts, model_context_window: 1000 },
        }),
      );
      expect((await plugin.sessionUsage.read(thread, signal()))?.usage).toMatchObject({
        contextUsedTokens: 120,
        contextWindowTokens: 1000,
      });
      await appendFile(file, '{"type":"token_usage_record","payload":');
      expect((await plugin.sessionUsage.read(thread, signal()))?.complete).toBe(false);
      await writeFile(
        file,
        line("session_meta", { id: thread, session_id: thread, forked_from_id: "parent" }) +
          request("r1"),
      );
      expect((await plugin.sessionUsage.read(thread, signal()))?.complete).toBe(false);
    } finally {
      await plugin.close();
    }
  });

  it("does not invent data for missing sessions, and aborts on close", async () => {
    const plugin = adapter();
    expect(await plugin.sessionUsage.read("missing", signal())).toBeNull();
    await plugin.close();
    await expect(plugin.sessionUsage.read(thread, signal())).rejects.toThrow();
    expect(
      plugin.sessionUsage.observe({
        method: "turn/started",
        params: { threadId: thread, turn: { id: "t" } },
      }),
    ).toBeNull();
  });

  it("normalizes only nonempty reasoning/text output and native token snapshots", () => {
    const params = { threadId: thread, turnId: "t", delta: "thinking" };
    expect(observeSessionUsage({ method: "item/reasoning/summaryTextDelta", params })).toEqual({
      sessionId: thread,
      turn: { id: "t", phase: "output" },
    });
    expect(
      observeSessionUsage({ method: "item/agentMessage/delta", params: { ...params, delta: "" } }),
    ).toBeNull();
    expect(observeSessionUsage({ method: "item/commandExecution/outputDelta", params })).toBeNull();
    expect(
      observeSessionUsage({
        method: "thread/tokenUsage/updated",
        params: {
          threadId: thread,
          tokenUsage: {
            total: { inputTokens: 100, cachedInputTokens: 80, outputTokens: 20 },
            last: { inputTokens: 100, cachedInputTokens: 0, totalTokens: 120 },
            modelContextWindow: 1000,
          },
        },
      }),
    ).toMatchObject({
      usage: {
        cacheHitRatePercent: 0,
        contextWindowTokens: 1000,
        sessionCacheUsage: { inputTokens: 100, cachedInputTokens: 80 },
      },
    });
  });
  it("restores the inherited prefix for session totals without changing global attribution", async () => {
    const parent = "00000000-0000-4000-8000-000000000002";
    const parentFile = path.join(home, "sessions", `rollout-2026-01-01T00-00-00-${parent}.jsonl`);
    const row = (ordinal: number, type: string, payload: object) =>
      JSON.stringify({ ordinal, timestamp: "2026-01-01T00:00:00Z", type, payload }) + "\n";
    const parentRows = (input = 100) =>
      row(0, "session_meta", { id: parent, session_id: parent }) +
      row(1, "turn_context", { turn_id: "parent-turn", model: "parent-model" }) +
      row(2, "token_usage_record", {
        thread_id: parent,
        session_id: parent,
        turn_id: "parent-turn",
        response_id: "p1",
        usage: { input_tokens: input, output_tokens: 10, cached_input_tokens: 50 },
      }) +
      row(3, "event_msg", {
        type: "task_complete",
        turn_id: "parent-turn",
        time_to_first_token_ms: 12,
      }) +
      row(4, "token_usage_record", {
        thread_id: parent,
        session_id: parent,
        response_id: "after-fork",
        usage: { input_tokens: 9000, output_tokens: 900, cached_input_tokens: 0 },
      });
    await writeFile(parentFile, parentRows());
    await writeFile(
      file,
      line("session_meta", {
        id: thread,
        session_id: thread,
        forked_from_id: parent,
        history_base: { thread_id: parent, end_ordinal_exclusive: 4 },
      }) +
        request("child") +
        line("event_msg", {
          type: "task_complete",
          turn_id: "child",
          time_to_first_token_ms: 1234,
        }),
    );
    const plugin = adapter();
    try {
      const restored = await plugin.sessionUsage.read(thread, signal());
      expect(restored).toMatchObject({
        complete: true,
        usage: { inputTokens: 200, outputTokens: 30 },
        lastTurnTiming: { turnId: "child", timeToFirstOutputMs: 1234 },
      });
      expect(restored?.requests.map((r) => r.model)).toEqual(["parent-model", "model-a"]);
      expect(restored?.retainedTurnIds).toContain("child");
      const global = createCodexUsageStatistics({ CODEX_HOME: home }, { sessionId: thread });
      const [source] = await global.listSources(signal());
      if (!source) throw new Error("Missing source");
      expect((await global.readSource(source.id, signal())).map((r) => r.inputTokens)).toEqual([
        100,
      ]);
      await writeFile(
        parentFile,
        parentRows().split("\n").slice(0, 4).join("\n") + "\n" + '{"ordinal":4,"type":',
      );
      expect((await plugin.sessionUsage.read(thread, signal()))?.complete).toBe(true);
      // The child did not change: dependency fingerprints still invalidate inherited totals.
      await writeFile(parentFile, parentRows(200));
      expect((await plugin.sessionUsage.read(thread, signal()))?.usage?.inputTokens).toBe(300);
      await rm(parentFile);
      expect((await plugin.sessionUsage.read(thread, signal()))?.complete).toBe(false);
      await writeFile(parentFile, parentRows());
      expect((await plugin.sessionUsage.read(thread, signal()))?.complete).toBe(true);
    } finally {
      await plugin.close();
    }
  });

  it("rejects unknown fork boundaries and cyclic ancestry without inventing totals", async () => {
    const parent = "00000000-0000-4000-8000-000000000002";
    const parentFile = path.join(home, "sessions", `rollout-2026-01-01T00-00-00-${parent}.jsonl`);
    const metadata = {
      id: thread,
      session_id: thread,
      forked_from_id: parent,
      history_base: { thread_id: parent, end_ordinal_exclusive: 4 },
    };
    await writeFile(file, line("session_meta", metadata) + request("child"));
    await writeFile(
      parentFile,
      line("session_meta", { id: parent, session_id: parent }) +
        line("turn_context", { model: "parent" }),
    );
    const plugin = adapter();
    try {
      expect((await plugin.sessionUsage.read(thread, signal()))?.complete).toBe(false);
      await writeFile(
        parentFile,
        JSON.stringify({
          ordinal: 0,
          timestamp: "2026-01-01T00:00:00Z",
          type: "session_meta",
          payload: {
            id: parent,
            session_id: parent,
            forked_from_id: thread,
            history_base: { thread_id: thread, end_ordinal_exclusive: 1 },
          },
        }) + "\n",
      );
      expect((await plugin.sessionUsage.read(thread, signal()))?.complete).toBe(false);
      expect((await plugin.sessionUsage.read(thread, signal()))?.usage?.inputTokens).toBe(100);
    } finally {
      await plugin.close();
    }
  });
});
