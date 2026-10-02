import { describe, expect, it, vi } from "vitest";
import type { HarnessOutput, HostEvent, HostItemSnapshot } from "@codexhost/harness-adapter";
import { parseHostUsage } from "@codexhost/harness-adapter";
import { hostTurnIdSchema, nativeSessionRefSchema } from "@codexhost/shared-contracts";
import { HermesGatewayTransport, type GatewayRecord } from "../src/gateway-transport.js";
import { HermesGatewaySessionTransport } from "../src/gateway-session-transport.js";
import { HermesSession } from "../src/hermes-session.js";
import {projectGatewayUsage, HermesUsage} from "../src/hermes-usage.js";

const pause = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  const state = {
    usage: {} as GatewayRecord | Promise<GatewayRecord>,
    items: [{ text: "help", kind: "command" }], // intentionally bounded
    catalog: {
      pairs: [
        ["/audit", "Plugin audit"],
        ["/late-plugin", "Beyond completion cap"],
        ["/skill", "Skill"],
        ["/alias", "Quick alias"],
        ["/model", "Switch model"],
        ["/hb", "Recurring task"],
        ["/future-builtin", "Unreviewed"],
        ["/status", "Status"],
      ],
      commands: {
        "/audit": { desktop: null, argument_mode: "text" },
        "/late-plugin": { desktop: null, argument_mode: null },
        "/model": { desktop: "hidden", argument_mode: "text" },
        "/hb": { desktop: null, argument_mode: "text" },
        "/future-builtin": { desktop: null, argument_mode: "text" },
        "/status": { desktop: null, argument_mode: null },
      },
      categories: [
        {
          name: "Plugin commands",
          pairs: [
            ["/audit", "Plugin audit"],
            ["/late-plugin", "Beyond completion cap"],
          ],
        },
        { name: "User commands", pairs: [["/alias", "Quick alias"]] },
      ],
      skills: { "/skill": { usage: 1, origin: "project" } },
    } as GatewayRecord,
  };
  const raw = new HermesGatewayTransport("unused", "/workspace", {});
  const bridge = new HermesGatewaySessionTransport(raw, "runtime", "native", {});
  const request = vi.spyOn(raw, "request").mockImplementation(async (method) => {
    if (method === "session.usage") return await state.usage;
    if (method === "complete.slash") return { items: state.items };
    if (method === "commands.catalog") return state.catalog;
    if (method === "prompt.submit") return { status: "streaming" };
    if (method === "slash.exec") return { output: "Native plugin output" };
    if (method === "session.compress") return { status: "compressed", summary: { noop: false } };
    return {};
  });
  vi.spyOn(raw, "close").mockResolvedValue();
  vi.spyOn(bridge, "readNativeSnapshot").mockResolvedValue({ turns: [] });
  const session = new HermesSession({
    nativeRef: nativeSessionRefSchema.parse({
      harnessId: "hermes",
      nativeSessionId: "native",
      formatVersion: 1,
    }),
    transport: bridge,
    open: { sessionId: "native", session: { sessionId: "native", models: null, modes: null } },
    onSettle: () => {},
  });
  const emit = (type: string, payload: GatewayRecord = {}) =>
    raw.onEvent({ type, session_id: "runtime", payload });
  const start = (text = "question", turnId = "t") =>
    session.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse(turnId),
      input: [{ type: "text", text }],
    });
  return { state, raw, bridge, session, request, emit, start };
}
async function collectAll(outputs: AsyncIterable<HarnessOutput>): Promise<HarnessOutput[]> {
  const result: HarnessOutput[] = [];
  for await (const output of outputs) result.push(output);
  return result;
}
async function eventsUntilComplete(outputs: AsyncIterable<HarnessOutput>): Promise<HostEvent[]> {
  const events: HostEvent[] = [];
  for await (const output of outputs) {
    if (output.kind !== "event") continue;
    events.push(output.event);
    if (output.event.type === "turn.completed") return events;
  }
  return events;
}
function compactItems(events: HostEvent[]): HostItemSnapshot[] {
  return events.flatMap((event) =>
    event.type === "item.completed" && event.snapshot.item.type === "contextCompaction"
      ? [event.snapshot]
      : [],
  );
}

function activityMessages(events: HostEvent[]): HostItemSnapshot[] {
  return events.flatMap((event) =>
    event.type === "item.completed" &&
    event.snapshot.item.type === "agentMessage" &&
    event.snapshot.item.phase === "commentary"
      ? [event.snapshot]
      : [],
  );
}

describe("Hermes native Usage refresh", () => {
  it("projects reliable numeric fields without manufacturing zeros, cache tokens or fees", () => {
    const usage = projectGatewayUsage({
      input: 0,
      output: 3,
      reasoning: 2,
      total: 3,
      context_used: 7,
      context_max: 100,
      context_percent: 7.1,
      cache_hit_pct: 12.5,
      credits_lines: ["10 credits"],
      account_lines: ["50%"],
      cost: "1",
      avg_tps: 1.5,
    });
    expect(usage).toEqual({
      inputTokens: 0,
      outputTokens: 3,
      reasoningOutputTokens: 2,
      totalTokens: 3,
      contextUsedTokens: 7,
      contextWindowTokens: 100,
      contextUsagePercent: 7.1,
      cacheHitRatePercent: 12.5,
    });
    expect(parseHostUsage(usage)).toEqual(usage);
    expect(
      projectGatewayUsage({
        input: "12",
        output: -1,
        total: Infinity,
        context_used: 1.2,
        cache_hit_pct: 101,
      }),
    ).toBeNull();
    expect(projectGatewayUsage({ calls: 0 })).toBeNull();
  });
  it("queues a fresh read after a model/turn boundary rather than accepting an old in-flight poll", async () => {
    const pending = deferred<ReturnType<typeof projectGatewayUsage>>();
    const read = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce({contextWindowTokens: 200});
    const publish = vi.fn();
    const usage = new HermesUsage(read, () => true, publish);
    const first = usage.refresh();
    const fresh = usage.refresh(true);
    pending.resolve({contextWindowTokens: 100});
    await Promise.all([first, fresh]);
    expect(read).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenCalledExactlyOnceWith({contextWindowTokens: 200});
  });
  it("refreshes the runtime session and receives idle native pushes", async () => {
    const f = fixture();
    await pause();
    f.state.usage = { input: 8, context_used: 9, context_max: 100 };
    await f.session.refreshUsage();
    f.emit("session.usage", { usage: { context_used: 4, cache_hit_pct: 25 } });
    await f.session.close();
    const outputs = await collectAll(f.session.outputs);
    expect(
      outputs.filter(
        (output) => output.kind === "event" && output.event.type === "session.usage.changed",
      ),
    ).toMatchObject([
      { event: { usage: { inputTokens: 8, contextUsedTokens: 9, contextWindowTokens: 100 } } },
      {
        event: {
          usage: {
            inputTokens: 8,
            contextUsedTokens: 4,
            contextWindowTokens: 100,
            cacheHitRatePercent: 25,
          },
        },
      },
    ]);
    expect(f.request).toHaveBeenCalledWith(
      "session.usage",
      { session_id: "runtime" },
      f.raw.timeoutMs,
      false,
    );
  });
  it("coalesces polls and discards replies older than a native push", async () => {
    const f = fixture();
    await pause();
    f.request.mockClear();
    const pending = deferred<GatewayRecord>();
    f.state.usage = pending.promise;
    const first = f.session.refreshUsage();
    expect(f.session.refreshUsage()).toBe(first);
    f.emit("session.usage", { usage: { input: 20, context_used: 15 } });
    pending.resolve({ input: 2, context_used: 99 });
    await first;
    expect(f.request.mock.calls.filter(([method]) => method === "session.usage")).toHaveLength(1);
    await f.session.close();
    const outputs = await collectAll(f.session.outputs);
    expect(outputs).toMatchObject([
      {
        event: { type: "session.usage.changed", usage: { inputTokens: 20, contextUsedTokens: 15 } },
      },
    ]);
  });
  it("ignores late closed-session replies and optional refresh failures", async () => {
    const f = fixture();
    await pause();
    const pending = deferred<GatewayRecord>();
    f.state.usage = pending.promise;
    const refreshed = f.session.refreshUsage();
    await f.session.close();
    pending.resolve({ input: 900 });
    await refreshed;
    expect(await collectAll(f.session.outputs)).toEqual([]);
    const other = fixture();
    await pause();
    other.request.mockRejectedValueOnce(new Error("quota query timed out"));
    await expect(other.session.refreshUsage()).resolves.toBeUndefined();
    expect((await other.start()).ok).toBe(true);
    other.emit("message.complete", { status: "complete", text: "answer" });
    const events = await eventsUntilComplete(other.session.outputs);
    expect(events.at(-1)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "succeeded" },
    });
    await other.session.close();
  });
});

describe("Hermes safe dynamic command directory", () => {
  it("uses source metadata beyond the completion cap and excludes skills, quick aliases and unreviewed built-ins", async () => {
    const f = fixture();
    const catalog = await f.session.commands.list();
    expect(catalog.ok).toBe(true);
    if (!catalog.ok) throw new Error("catalog unavailable");
    expect(catalog.value.commands.map((command) => command.invocation)).toEqual([
      "/help",
      "/tools",
      "/context",
      "/version",
      "/compress",
      "/audit",
      "/late-plugin",
      "/status",
    ]);
    expect(
      catalog.value.commands.find((command) => command.invocation === "/audit")?.argumentMode,
    ).toBe("text");
    expect(f.request).toHaveBeenCalledWith(
      "complete.slash",
      { session_id: "runtime", cwd: "/workspace", text: "/" },
      f.raw.timeoutMs,
      false,
    );
    expect((await f.start("/hb every minute")).ok).toBe(false);
    expect((await f.start("/alias")).ok).toBe(false);
    expect((await f.start("/future-builtin")).ok).toBe(false);
    expect(
      f.request.mock.calls.some(
        ([method]) => method === "prompt.submit" || method === "slash.exec",
      ),
    ).toBe(false);
    await f.session.close();
  });
  it("dispatches the advertised plugin with intact arguments and no fabricated history identity", async () => {
    const f = fixture();
    expect(
      (
        await f.session.commands.execute({
          turnId: hostTurnIdSchema.parse("command"),
          commandId: "hermes.audit",
          arguments: { text: "repo\nall" },
        })
      ).ok,
    ).toBe(true);
    const events = await eventsUntilComplete(f.session.outputs);
    expect(f.request).toHaveBeenCalledWith("slash.exec", {
      session_id: "runtime",
      command: "/audit repo\nall",
    });
    expect(f.request.mock.calls.some(([method]) => method === "prompt.submit")).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "succeeded" },
    });
    expect(events.at(-1)).not.toHaveProperty("nativeTurnRef");
    f.state.catalog = { pairs: [], commands: {}, categories: [], skills: {} };
    expect(
      (
        await f.session.commands.execute({
          turnId: hostTurnIdSchema.parse("removed"),
          commandId: "hermes.audit",
        })
      ).ok,
    ).toBe(false);
    await f.session.close();
  });
  it("does not spawn a turn after close or accept concurrent starts while discovery is pending", async () => {
    const f = fixture();
    await pause();
    const pending = deferred<GatewayRecord>();
    const request = f.request.getMockImplementation()!;
    f.request.mockImplementation((method, ...args) =>
      method === "complete.slash" ? pending.promise : request(method, ...args),
    );
    const started = f.start("/audit repo");
    expect(f.session.busy).toBe(true);
    expect((await f.start("question", "other")).ok).toBe(false);
    await f.session.close();
    pending.resolve({ items: [] });
    expect((await started).ok).toBe(false);
    expect(
      f.request.mock.calls.some(
        ([method]) => method === "slash.exec" || method === "prompt.submit",
      ),
    ).toBe(false);
  });
});

describe("Hermes automatic compaction phase", () => {
  it("deduplicates heartbeats and closes successive phases without inferring commit success from text or tokens", async () => {
    const f = fixture();
    await f.start();
    await pause();
    f.emit("status.update", { kind: "compacted", text: "late/unpaired" });
    for (let i = 0; i < 2; i++) {
      f.emit("status.update", { kind: "compacting", text: "progress" });
      f.emit("status.update", { kind: "compacting", text: "heartbeat" });
      f.emit("session.usage", { usage: { context_used: 1 } });
      f.emit("status.update", { kind: "compacted", text: "SUCCESS!" });
    }
    f.emit("message.complete", { status: "complete", text: "answer" });
    const events = await eventsUntilComplete(f.session.outputs);
    expect(activityMessages(events)).toHaveLength(2);
    expect(compactItems(events)).toEqual([]);
    for (const { item } of activityMessages(events)) {
      expect(item).toMatchObject({
        phase: "commentary",
        text: expect.stringContaining("未提供压缩提交结果"),
      });
      expect(item).not.toHaveProperty("phase", "final_answer");
    }
    expect(events.at(-1)).toMatchObject({ outcome: { status: "succeeded" } });
    await f.session.close();
  });
  it.each(["complete", "interrupted", "error"])(
    "retires an unfinished observation when the native turn ends %s",
    async (status) => {
      const f = fixture();
      await f.start();
      await pause();
      f.emit("status.update", { kind: "compacting", text: "progress" });
      f.emit("status.update", { kind: "warning", text: "Compression failed" });
      f.emit("message.complete", { status, text: "answer", error: "native error" });
      const events = await eventsUntilComplete(f.session.outputs);
      expect(compactItems(events)).toEqual([]);
      expect(activityMessages(events)).toMatchObject([
        { item: { phase: "commentary", text: expect.stringContaining("提交结果未知") } },
      ]);
      expect(events.at(-1)).toMatchObject({
        outcome: {
          status:
            status === "complete" ? "succeeded" : status === "interrupted" ? "cancelled" : "failed",
        },
      });
      await f.session.close();
    },
  );
  it("keeps manual compression tied solely to its structured result", async () => {
    const f = fixture();
    const request = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (method, ...args) => {
      if (method === "session.compress") {
        f.emit("status.update", { kind: "compacting", text: "start" });
        f.emit("status.update", { kind: "compacted", text: "done" });
      }
      return request(method, ...args);
    });
    await f.start("/compress");
    const events = await eventsUntilComplete(f.session.outputs);
    expect(compactItems(events)).toMatchObject([{ outcome: { status: "succeeded" } }]);
    expect(
      events.filter(
        (event) => event.type === "item.started" && event.item.type === "contextCompaction",
      ),
    ).toHaveLength(1);
    await f.session.close();
  });
});
