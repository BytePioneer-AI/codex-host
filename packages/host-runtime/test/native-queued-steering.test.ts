import { expect, it, vi } from "vitest";
import type { JsonObject } from "@codexhost/protocol-core";
import { sendNativeQueuedMessage } from "../src/native-queued-steering.js";
import type { NativeClientReply } from "../src/native-client-channel.js";

const input = [
  { type: "text", text: "follow-up", text_elements: [] },
  { type: "localImage", path: "/tmp/image.png" },
];
const item = { id: "queued", clientUserMessageId: "client-input", input };
function fixture(active = true) {
  const request = vi.fn<(method: string, params: JsonObject) => Promise<NativeClientReply>>(
    async (method) => {
      if (method === "thread/turns/list")
        return {
          result: { data: active ? [{ id: "turn", status: "inProgress" }] : [], nextCursor: null },
        };
      if (method === "thread/queue/list") return { result: { data: [item], nextCursor: null } };
      if (method === "turn/steer") return { result: { turnId: "turn" } };
      if (method === "thread/queue/delete") return { result: { deleted: true } };
      if (method === "thread/queue/start") return { result: { turn: { id: "new" } } };
      throw new Error(method);
    },
  );
  return request;
}

it("steers queued input into the native active Turn, preserving identity and attachments", async () => {
  const request = fixture();
  expect(await sendNativeQueuedMessage(request, "thread", "queued")).toEqual({
    result: { turnId: "turn" },
  });
  expect(request.mock.calls.map(([method]) => method)).toEqual([
    "thread/turns/list",
    "thread/queue/list",
    "turn/steer",
    "thread/queue/delete",
  ]);
  expect(request).toHaveBeenNthCalledWith(3, "turn/steer", {
    threadId: "thread",
    expectedTurnId: "turn",
    clientUserMessageId: "client-input",
    input,
  });
  expect(request).toHaveBeenLastCalledWith("thread/queue/delete", {
    threadId: "thread",
    queuedSubmissionId: "queued",
  });
});

it("uses native queue start only when there is no active Turn", async () => {
  const request = fixture(false);
  expect(await sendNativeQueuedMessage(request, "thread", "queued")).toEqual({
    result: { turn: { id: "new" } },
  });
  expect(request.mock.calls.map(([method]) => method)).toEqual([
    "thread/turns/list",
    "thread/queue/start",
  ]);
});

it.each([-32600, -32090, -32094])(
  "preserves a queue entry after refusal or unknown steer outcome (%s), without fallback",
  async (code) => {
    const request = fixture();
    const implementation = request.getMockImplementation();
    if (!implementation) throw new Error("Missing fixture");
    request.mockImplementation((method, params) =>
      method === "turn/steer"
        ? Promise.resolve({ error: { code, message: "not confirmed" } })
        : implementation(method, params),
    );
    expect(await sendNativeQueuedMessage(request, "thread", "queued")).toEqual({
      error: { code, message: "not confirmed" },
    });
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/turns/list",
      "thread/queue/list",
      "turn/steer",
    ]);
  },
);

it.each([{}, { turnId: "different-turn" }])(
  "does not delete or retry after an invalid steer acknowledgment (%j)",
  async (result) => {
    const request = fixture();
    const implementation = request.getMockImplementation();
    if (!implementation) throw new Error("Missing fixture");
    request.mockImplementation((method, params) =>
      method === "turn/steer" ? Promise.resolve({ result }) : implementation(method, params),
    );
    expect(await sendNativeQueuedMessage(request, "thread", "queued")).toMatchObject({
      error: { code: -32090 },
    });
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/turns/list",
      "thread/queue/list",
      "turn/steer",
    ]);
  },
);

it.each(["reject", "missing", "disconnect"])(
  "reports accepted input with unconfirmed queue removal (%s) without resending",
  async (outcome) => {
    const request = fixture();
    const implementation = request.getMockImplementation();
    if (!implementation) throw new Error("Missing fixture");
    request.mockImplementation(async (method, params) => {
      if (method !== "thread/queue/delete") return implementation(method, params);
      if (outcome === "disconnect") throw new Error("Disconnected");
      return outcome === "missing"
        ? { result: { deleted: false } }
        : { error: { code: -32600, message: "refused" } };
    });
    expect(await sendNativeQueuedMessage(request, "thread", "queued")).toMatchObject({
      error: { code: -32095 },
    });
    expect(request.mock.calls.filter(([method]) => method === "turn/steer")).toHaveLength(1);
  },
);

it("finds an entry beyond the first native queue page", async () => {
  const request = fixture();
  const implementation = request.getMockImplementation();
  if (!implementation) throw new Error("Missing fixture");
  request.mockImplementation((method, params) =>
    method === "thread/queue/list" && !params.cursor
      ? Promise.resolve({ result: { data: [], nextCursor: "next" } })
      : implementation(method, params),
  );
  await sendNativeQueuedMessage(request, "thread", "queued");
  expect(request).toHaveBeenNthCalledWith(3, "thread/queue/list", {
    threadId: "thread",
    limit: 100,
    cursor: "next",
  });
});

it("does not send a deleted queue item", async () => {
  const request = fixture();
  expect(await sendNativeQueuedMessage(request, "thread", "gone")).toMatchObject({
    error: { code: -32602 },
  });
  expect(request).toHaveBeenCalledTimes(2);
});
