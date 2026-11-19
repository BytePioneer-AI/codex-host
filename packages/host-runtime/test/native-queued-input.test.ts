import { expect, it, vi } from "vitest";
import type { JsonObject } from "@codexhost/protocol-core";
import { NativeClientChannel, type NativeClientReply } from "../src/native-client-channel.js";
import { ClientChannelEvents } from "../src/client-channel-events.js";
import { submitNativeQueuedInput } from "../src/native-queued-input.js";

const params = {
  threadId: "thread",
  delivery: "queue",
  clientUserMessageId: "web-message",
  input: [
    { type: "text", text: "是apec", text_elements: [] },
    { type: "localImage", path: "/tmp/image.png" },
  ],
};
const item = { id: "queued", clientUserMessageId: params.clientUserMessageId, input: params.input };
const added = { result: { queuedSubmission: item } };
const started = { result: { turn: { id: "new", status: "inProgress", items: [] } } };

function fixture(options: { status?: string; head?: string | null } = {}) {
  const { status = "idle", head = item.id } = options;
  return vi.fn<(method: string, params: JsonObject) => Promise<NativeClientReply>>(
    async (method) => {
      if (method === "thread/queue/add") return added;
      if (method === "thread/queue/list")
        return { result: { data: head === null ? [] : [{ ...item, id: head }], nextCursor: null } };
      if (method === "thread/read")
        return { result: { thread: { id: params.threadId, status: { type: status } } } };
      if (method === "thread/queue/start") return started;
      throw new Error(`Unexpected native request ${method}`);
    },
  );
}

it("starts an idle queued-mode submission without reading history, preserving identity and attachments", async () => {
  const request = fixture();
  expect(await submitNativeQueuedInput(request, params)).toEqual(started);
  expect(request.mock.calls.map(([method]) => method)).toEqual([
    "thread/read",
    "thread/queue/add",
    "thread/queue/list",
    "thread/queue/start",
  ]);
  expect(request).toHaveBeenNthCalledWith(1, "thread/read", {
    threadId: params.threadId,
    includeTurns: false,
  });
  expect(request).toHaveBeenNthCalledWith(2, "thread/queue/add", params);
  expect(request).toHaveBeenLastCalledWith("thread/queue/start", {
    threadId: "thread",
    queuedSubmissionId: item.id,
  });
  expect(
    request.mock.calls.some(([method]) => method === "turn/start" || method === "turn/steer"),
  ).toBe(false);
});

it.each(["active", "notLoaded", "systemError"])(
  "leaves input queued when the native runtime is %s rather than confirmed idle",
  async (status) => {
    const request = fixture({ status });
    expect(await submitNativeQueuedInput(request, params)).toEqual(added);
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/read",
      "thread/queue/add",
    ]);
  },
);

it("does not skip or resume an existing queue, including after interruption", async () => {
  const request = fixture({ head: "desktop-message" });
  expect(await submitNativeQueuedInput(request, params)).toEqual(added);
  expect(request.mock.calls.map(([method]) => method)).toEqual([
    "thread/read",
    "thread/queue/add",
    "thread/queue/list",
  ]);
});

it("does not restart input already consumed by native automatic advancement", async () => {
  const request = fixture({ head: null });
  expect(await submitNativeQueuedInput(request, params)).toEqual(added);
  expect(request).toHaveBeenCalledTimes(3);
});

it("does not resume input queued just before Desktop interrupts the active Turn", async () => {
  let stopped = false;
  const request = vi.fn(async (method: string): Promise<NativeClientReply> => {
    if (method === "thread/read")
      return {
        result: { thread: { id: params.threadId, status: { type: stopped ? "idle" : "active" } } },
      };
    if (method === "thread/queue/add") {
      stopped = true;
      return added;
    }
    throw new Error(`Must not start after interruption: ${method}`);
  });
  expect(await submitNativeQueuedInput(request, params)).toEqual(added);
  expect(stopped).toBe(true);
  expect(request).toHaveBeenCalledTimes(2);
});

it.each([
  "thread already has an active or pending turn",
  `queued submission not found: ${item.id}`,
])("preserves native acceptance when another client wins the start race: %s", async (message) => {
  const request = fixture();
  const implementation = request.getMockImplementation();
  if (!implementation) throw new Error("Missing native fixture");
  request.mockImplementation((method, input) =>
    method === "thread/queue/start"
      ? Promise.resolve({ error: { code: -32600, message } })
      : implementation(method, input),
  );
  expect(await submitNativeQueuedInput(request, params)).toEqual(added);
  expect(request).toHaveBeenCalledTimes(4);
});

it.each(["thread/queue/list", "thread/queue/start"])(
  "reports accepted input without resubmitting after an unconfirmed %s",
  async (failedMethod) => {
    const request = fixture();
    const implementation = request.getMockImplementation();
    if (!implementation) throw new Error("Missing native fixture");
    request.mockImplementation((method, input) =>
      method === failedMethod
        ? Promise.resolve({ error: { code: -32093, message: "Timeout" } })
        : implementation(method, input),
    );
    expect(await submitNativeQueuedInput(request, params)).toMatchObject({
      error: { code: -32095, message: expect.stringContaining("do not resend") },
    });
    expect(request.mock.calls.filter(([method]) => method === "thread/queue/add")).toHaveLength(1);
    expect(
      request.mock.calls.filter(([method]) => method === "thread/queue/start").length,
    ).toBeLessThanOrEqual(1);
  },
);

it.each([{}, { turn: {} }])(
  "does not treat a malformed start acknowledgment as execution: %j",
  async (result) => {
    const request = fixture();
    const implementation = request.getMockImplementation();
    if (!implementation) throw new Error("Missing native fixture");
    request.mockImplementation((method, input) =>
      method === "thread/queue/start" ? Promise.resolve({ result }) : implementation(method, input),
    );
    expect(await submitNativeQueuedInput(request, params)).toMatchObject({
      error: { code: -32095 },
    });
  },
);

it("keeps queue and steer policies per submission without consuming another client's input", async () => {
  const queued = fixture({ status: "active" });
  const request = vi.fn<(method: string, params: JsonObject) => Promise<NativeClientReply>>(
    async (method, input) => {
      if (method === "thread/resume") return { result: { thread: { id: "thread" } } };
      if (method === "turn/steer") return { result: { turnId: "previous" } };
      if (method === "turn/start") return started;
      return queued(method, input);
    },
  );
  const channel = new NativeClientChannel({
    events: new ClientChannelEvents(),
    request,
    respond: async () => {},
  });
  expect(await channel.request("turn/start", params)).toEqual(added);
  const steer = {
    threadId: "thread",
    expectedTurnId: "previous",
    clientUserMessageId: "another-client",
    input: [{ type: "text", text: "change direction" }],
  };
  expect(await channel.request("turn/steer", steer)).toEqual({ result: { turnId: "previous" } });
  expect(request).toHaveBeenLastCalledWith("turn/steer", steer);
  const direct = { threadId: "thread", input: steer.input, clientUserMessageId: "idle-steer" };
  expect(await channel.request("turn/start", direct)).toEqual(started);
  expect(request).toHaveBeenLastCalledWith("turn/start", direct);
  expect(queued.mock.calls.map(([method]) => method)).toEqual(["thread/read", "thread/queue/add"]);
});

it.each(["thread/read", "thread/queue/add"])(
  "preserves a %s error before acceptance without trying to start",
  async (failedMethod) => {
    const error = { error: { code: -32602, message: "Invalid input" } };
    const request = fixture();
    const implementation = request.getMockImplementation();
    if (!implementation) throw new Error("Missing native fixture");
    request.mockImplementation((method, input) =>
      method === failedMethod ? Promise.resolve(error) : implementation(method, input),
    );
    expect(await submitNativeQueuedInput(request, params)).toEqual(error);
    expect(request.mock.calls.map(([method]) => method)).toEqual(
      failedMethod === "thread/read" ? ["thread/read"] : ["thread/read", "thread/queue/add"],
    );
  },
);

it.each([{}, { thread: {} }, { thread: { id: "other", status: { type: "idle" } } }])(
  "rejects an unconfirmed native runtime before accepting input: %j",
  async (result) => {
    const request = fixture();
    request.mockResolvedValueOnce({ result });
    expect(await submitNativeQueuedInput(request, params)).toMatchObject({
      error: { code: -32603 },
    });
    expect(request).toHaveBeenCalledExactlyOnceWith("thread/read", {
      threadId: params.threadId,
      includeTurns: false,
    });
  },
);

it("submits the first message on a new native Thread even while its history is unavailable", async () => {
  const native = fixture();
  const request = vi.fn(async (method: string, input: JsonObject): Promise<NativeClientReply> => {
    if (method === "thread/start")
      return { result: { thread: { id: params.threadId, status: { type: "idle" } } } };
    if (method === "thread/turns/list")
      return {
        error: {
          code: -32600,
          message: `thread ${params.threadId} is not materialized yet; thread/turns/list is unavailable before first user message`,
        },
      };
    return native(method, input);
  });
  const channel = new NativeClientChannel({
    events: new ClientChannelEvents(),
    request,
    respond: async () => {},
  });
  await channel.request("thread/start", {});
  expect(await channel.request("turn/start", params)).toEqual(started);
  expect(request.mock.calls.map(([method]) => method)).toEqual([
    "thread/start",
    "thread/read",
    "thread/queue/add",
    "thread/queue/list",
    "thread/queue/start",
  ]);
});

it("reports already accepted input if the connection drops before start confirmation", async () => {
  const request = fixture();
  const implementation = request.getMockImplementation();
  if (!implementation) throw new Error("Missing native fixture");
  request.mockImplementation((method, input) => {
    if (method === "thread/queue/start") throw new Error("Disconnected");
    return implementation(method, input);
  });
  expect(await submitNativeQueuedInput(request, params)).toMatchObject({ error: { code: -32095 } });
  expect(request).toHaveBeenCalledTimes(4);
});
