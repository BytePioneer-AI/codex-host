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
  const state = { delayCreation: false, complete: false, status: "completed" };
  const request = vi.fn(async (method: string, params: JsonObject): Promise<NativeClientReply> => {
    if (method === "config/read") return { result: { config: {} } };
    if (method === "thread/start")
      return state.delayCreation
        ? creation.promise
        : { result: { thread: { id: `title-${++next}` } } };
    if (method === "turn/start") {
      const threadId = String(params.threadId);
      if (state.complete) complete(threadId, "Timer repair", state.status);
      accepted.resolve(threadId);
      return { result: { turn: { id: `turn-${threadId}` } } };
    }
    if (method === "turn/interrupt" || method === "thread/unsubscribe") return { result: {} };
    throw new Error(`Unexpected native title request: ${method}`);
  });
  const titles = new NativeThreadTitles({ request, respond: vi.fn(async () => {}) }, 100);
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
  return { titles, request, state, accepted, creation, complete };
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
  expect(f.request).toHaveBeenLastCalledWith("thread/unsubscribe", { threadId: "title-1" });
  expect(f.titles.observe({ method: "turn/completed", params: { threadId: "user-chat" } })).toBe(
    false,
  );
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
  const result = f.titles.generate(input);
  await f.accepted.promise;
  f.titles.observe({
    method: "item/completed",
    params: { threadId: "title-1", item: { type: "agentMessage", text: '{"title":"Incomplete"}' } },
  });
  await vi.advanceTimersByTimeAsync(100);
  expect(await result).toBeNull();
  expect(f.request).toHaveBeenCalledWith("turn/interrupt", {
    threadId: "title-1",
    turnId: "turn-title-1",
  });
  expect(f.request).toHaveBeenLastCalledWith("thread/unsubscribe", { threadId: "title-1" });
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
