import { afterEach, expect, it, vi } from "vitest";
import type { JsonObject } from "@codexhost/protocol-core";
import { NativeThreadTitles } from "../src/native-thread-title.js";
import type { NativeClientReply } from "../src/native-client-channel.js";

const input = { prompt: "Fix the timer", cwd: "/synthetic" };
afterEach(() => vi.useRealTimers());

function fixture() {
  let next = 0;
  const accepted = Promise.withResolvers<string>();
  const creation = Promise.withResolvers<NativeClientReply>();
  const state = {
    delayCreation: false,
    complete: false,
    status: "completed",
    configuration: { result: { config: { mcp_servers: {} } } } as NativeClientReply,
    startFailure: undefined as NativeClientReply | undefined,
    threadId: undefined as string | undefined,
  };
  const diagnose = vi.fn();
  const request = vi.fn(async (method: string, params: JsonObject): Promise<NativeClientReply> => {
    if (method === "config/read") return state.configuration;
    if (method === "thread/start")
      return (
        state.startFailure ??
        (state.delayCreation
          ? creation.promise
          : { result: { thread: { id: state.threadId ?? `title-${++next}` } } })
      );
    if (method === "turn/start") {
      const threadId = String(params.threadId);
      if (state.complete) complete(threadId, "Timer repair", state.status);
      accepted.resolve(threadId);
      return { result: { turn: { id: `turn-${threadId}` } } };
    }
    if (method === "turn/interrupt" || method === "thread/unsubscribe") return { result: {} };
    throw new Error(`Unexpected native title request: ${method}`);
  });
  const titles = new NativeThreadTitles({ request, respond: vi.fn(async () => {}) }, 100, diagnose);
  function complete(threadId: string, title: string, status = "completed") {
    titles.observe({
      method: "item/completed",
      params: { threadId, item: { type: "agentMessage", text: JSON.stringify({ title }) } },
    });
    titles.observe({
      method: "turn/completed",
      params: { threadId, turn: { id: `turn-${threadId}`, status, items: [] } },
    });
  }
  return { titles, request, state, accepted, creation, complete, diagnose };
}

it("accepts a completed structured title arriving before the start acknowledgement and unloads its ephemeral thread", async () => {
  const f = fixture();
  f.state.complete = true;
  expect(await f.titles.generate(input)).toBe("Timer repair");
  expect(f.request).toHaveBeenCalledWith(
    "thread/start",
    expect.objectContaining({
      ephemeral: true,
      permissions: ":read-only",
      approvalPolicy: "never",
    }),
  );
  const config = f.request.mock.calls.find(([method]) => method === "thread/start")?.[1].config;
  expect(Object.keys(config as JsonObject).filter((key) => key.startsWith("mcp_servers"))).toEqual(
    [],
  );
  expect(f.request).toHaveBeenLastCalledWith("thread/unsubscribe", { threadId: "title-1" });
  expect(f.titles.observe({ method: "turn/completed", params: { threadId: "user-chat" } })).toBe(
    false,
  );
});

it("disables configured MCPs in the requested cwd without copying transports or credentials", async () => {
  const f = fixture();
  f.state.complete = true;
  f.state.configuration = {
    result: {
      config: {
        mcp_servers: {
          stdio_1: {
            enabled: true,
            command: "/synthetic/stdio",
            args: ["synthetic-capability"],
            tool_timeout_sec: null,
          },
          "http-2": {
            enabled: true,
            url: "https://synthetic.invalid",
            http_headers: { Authorization: "synthetic-header" },
          },
          "already.disabled": { enabled: false, command: "/synthetic/disabled" },
        },
      },
    },
  };
  expect(await f.titles.generate(input)).toBe("Timer repair");
  expect(f.request).toHaveBeenCalledWith("config/read", { includeLayers: false, cwd: input.cwd });
  const params = f.request.mock.calls.find(([method]) => method === "thread/start")?.[1];
  expect(
    Object.entries(params?.config as JsonObject).filter(([key]) => key.startsWith("mcp_servers")),
  ).toEqual([
    ["mcp_servers.stdio_1.enabled", false],
    ["mcp_servers.http-2.enabled", false],
  ]);
  expect(JSON.stringify(params)).not.toMatch(
    /synthetic-capability|synthetic-header|synthetic\.invalid|\/synthetic\/stdio/,
  );
});

it.each<{ reply: NativeClientReply; reason: string }>([
  { reply: { error: { code: -32603, message: "a synthetic secret" } }, reason: "rpc_error" },
  { reply: { result: { config: { mcp_servers: [] } } }, reason: "invalid_response" },
  {
    reply: { result: { config: { mcp_servers: { malformed: null } } } },
    reason: "invalid_response",
  },
  {
    reply: { result: { config: { mcp_servers: { "private.name": { enabled: true } } } } },
    reason: "unsafe_mcp_name",
  },
])("skips title generation after config/read reports $reason", async ({ reply, reason }) => {
  const f = fixture();
  f.state.complete = true;
  f.state.configuration = reply;
  expect(await f.titles.generate(input)).toBeNull();
  expect(f.request).not.toHaveBeenCalledWith("thread/start", expect.anything());
  expect(f.request).not.toHaveBeenCalledWith("turn/start", expect.anything());
  expect(f.diagnose).toHaveBeenCalledExactlyOnceWith({
    stage: "config/read",
    reason,
    jobId: expect.any(Number),
    ...("error" in reply ? { rpcCode: reply.error.code } : {}),
  });
});

it("reports a native invalid transport failure without exposing the error text or input", async () => {
  const f = fixture();
  f.state.startFailure = {
    error: {
      code: -32600,
      message: `failed to load configuration: invalid transport\n${input.prompt} ${input.cwd} synthetic-secret`,
    },
  };
  expect(await f.titles.generate(input)).toBeNull();
  expect(f.diagnose).toHaveBeenCalledExactlyOnceWith({
    stage: "thread/start",
    reason: "invalid_transport",
    jobId: expect.any(Number),
    rpcCode: -32600,
  });
  expect(f.request).not.toHaveBeenCalledWith("turn/start", expect.anything());
});

it("does not accept a title from a failed turn", async () => {
  const f = fixture();
  f.state.complete = true;
  f.state.status = "failed";
  expect(await f.titles.generate(input)).toBeNull();
});

it("keeps concurrent title results isolated by native thread and ignores commentary", async () => {
  const f = fixture();
  const first = f.titles.generate(input);
  const second = f.titles.generate(input);
  await vi.waitFor(() =>
    expect(f.request.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(2),
  );
  f.complete("title-2", "Second conversation");
  f.titles.observe({
    method: "item/completed",
    params: {
      threadId: "title-1",
      item: { type: "agentMessage", text: '{"title":"First conversation"}' },
    },
  });
  f.titles.observe({
    method: "item/completed",
    params: {
      threadId: "title-1",
      item: { type: "agentMessage", phase: "commentary", text: "Working..." },
    },
  });
  f.titles.observe({
    method: "turn/completed",
    params: { threadId: "title-1", turn: { id: "turn-title-1", status: "completed", items: [] } },
  });
  expect(await first).toBe("First conversation");
  expect(await second).toBe("Second conversation");
});

it("interrupts and unloads a timed-out turn instead of publishing partial output", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const threadId = "01900000-0000-7000-8000-000000000001";
  f.state.threadId = threadId;
  const result = f.titles.generate(input);
  await f.accepted.promise;
  f.titles.observe({
    method: "item/completed",
    params: { threadId, item: { type: "agentMessage", text: '{"title":"Incomplete"}' } },
  });
  await vi.advanceTimersByTimeAsync(100);
  expect(await result).toBeNull();
  expect(f.diagnose).toHaveBeenCalledExactlyOnceWith({
    stage: "timeout",
    reason: "timed_out",
    jobId: expect.any(Number),
    threadId,
  });
  expect(f.request).toHaveBeenCalledWith("turn/interrupt", {
    threadId,
    turnId: `turn-${threadId}`,
  });
  expect(f.request).toHaveBeenLastCalledWith("thread/unsubscribe", { threadId });
});

it("unloads a thread whose creation resolves after timeout without starting a turn", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.state.delayCreation = true;
  const result = f.titles.generate(input);
  await vi.advanceTimersByTimeAsync(100);
  expect(await result).toBeNull();
  f.creation.resolve({ result: { thread: { id: "late-thread" } } });
  await vi.runAllTimersAsync();
  expect(f.request.mock.calls.some(([method]) => method === "turn/start")).toBe(false);
  expect(f.request).toHaveBeenLastCalledWith("thread/unsubscribe", { threadId: "late-thread" });
});

it("discards a result after the official connection changes without unsubscribing on the replacement connection", async () => {
  const f = fixture();
  const result = f.titles.generate(input);
  await f.accepted.promise;
  f.titles.reset();
  f.complete("title-1", "Stale title");
  expect(await result).toBeNull();
  expect(f.request.mock.calls.some(([method]) => method === "thread/unsubscribe")).toBe(false);
  f.state.complete = true;
  expect(await f.titles.generate(input)).toBe("Timer repair");
});
