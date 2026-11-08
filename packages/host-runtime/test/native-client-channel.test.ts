import { expect, it, vi } from "vitest";

import type { JsonObject } from "@codexhost/protocol-core";

import { ClientChannelEvents } from "../src/client-channel-events.js";
import { NativeClientChannel, type NativeClientReply } from "../src/native-client-channel.js";
import { encodeOfficialCodexModelRef } from "../src/official-codex-model-ref.js";

const thread: JsonObject = {
  id: "native-thread",
  cwd: "/synthetic",
  modelProvider: "openai",
  createdAt: 1,
  updatedAt: 1,
  status: { type: "idle" },
  turns: [],
};

function snapshotChannel() {
  const events = new ClientChannelEvents();
  const calls: string[] = [];
  const request = vi.fn(async (method: string): Promise<NativeClientReply> => {
    calls.push(method);
    if (method === "thread/resume") {
      events.changed("native-thread", method);
      return {
        result: {
          thread,
          model: "gpt-5.4",
          reasoningEffort: "high",
          activePermissionProfile: { id: ":workspace" },
        },
      };
    }
    if (method === "thread/read") {
      events.changed("native-thread", "turn/completed");
      return { result: { thread } };
    }
    if (method === "thread/turns/list") return { result: { data: [], nextCursor: null } };
    throw new Error(`Unexpected native method ${method}`);
  });
  const channel = new NativeClientChannel({
    events,
    request,
    respond: vi.fn(async () => undefined),
  });
  return { channel, calls, events, request };
}

it("captures the native snapshot cursor before resume/read I/O and keeps real config", async () => {
  const { channel, calls, request } = snapshotChannel();

  const first = await channel.snapshot("native-thread", {});

  expect(first.cursor.sequence).toBe(0);
  expect(first.configuration).toEqual({
    effectiveModel: encodeOfficialCodexModelRef("gpt-5.4"),
    effectiveThinkingOptionId: "high",
    effectivePermissionModeId: ":workspace",
  });
  expect(calls).toEqual(["thread/resume", "thread/read", "thread/turns/list"]);
  expect(request).toHaveBeenCalledWith("thread/resume", {
    threadId: "native-thread",
    excludeTurns: true,
  });

  await channel.snapshot("native-thread", {});
  expect(calls.filter((method) => method === "thread/resume")).toHaveLength(1);

  channel.resetGeneration();
  await channel.snapshot("native-thread", {});
  expect(calls.filter((method) => method === "thread/resume")).toHaveLength(2);
});

it("serves client inspection and snapshots from confirmed configuration without repeated resume", async () => {
  const { channel, request, calls } = snapshotChannel();
  const before = {
    effectiveModel: encodeOfficialCodexModelRef("gpt-5.4"),
    effectiveThinkingOptionId: "high",
    effectivePermissionModeId: ":workspace",
  };
  expect(
    await channel.request("codexhost/thread/inspect", { threadId: "native-thread" }),
  ).toMatchObject({ result: { owner: "codex", locked: false, ...before } });
  expect(request).toHaveBeenCalledExactlyOnceWith("thread/resume", {
    threadId: "native-thread",
    excludeTurns: true,
  });
  expect((await channel.snapshot("native-thread", {})).configuration).toEqual(before);
  expect(
    await channel.request("codexhost/thread/inspect", { threadId: "native-thread" }),
  ).toMatchObject({ result: before });
  channel.observeMessage({
    method: "thread/settings/updated",
    params: {
      threadId: "native-thread",
      threadSettings: {
        model: "new-model",
        effort: "low",
        activePermissionProfile: { id: ":read-only" },
      },
    },
  });
  const after = {
    effectiveModel: encodeOfficialCodexModelRef("new-model"),
    effectiveThinkingOptionId: "low",
    effectivePermissionModeId: ":read-only",
  };
  expect(
    await channel.request("codexhost/thread/inspect", { threadId: "native-thread" }),
  ).toMatchObject({ result: after });
  expect((await channel.snapshot("native-thread", {})).configuration).toEqual(after);
  expect(calls.filter((method) => method === "thread/resume")).toHaveLength(1);
});

it.each([
  { code: -32600, message: "thread native-thread already has a live local writer" },
  { code: -32000, message: "resume unavailable" },
])("returns inspection without configuration when resume fails: $message", async (error) => {
  const { channel, request } = snapshotChannel();
  request.mockResolvedValueOnce({ error });
  expect(await channel.request("codexhost/thread/inspect", { threadId: "native-thread" })).toEqual({
    result: {
      owner: "codex",
      locked: false,
      history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
    },
  });
  expect(request).toHaveBeenCalledExactlyOnceWith("thread/resume", {
    threadId: "native-thread",
    excludeTurns: true,
  });
  expect(
    await channel.request("codexhost/thread/inspect", { threadId: "native-thread" }),
  ).toMatchObject({ result: { effectiveThinkingOptionId: "high" } });
});

it("validates native command decisions and preserves first-answer semantics", async () => {
  const events = new ClientChannelEvents();
  const respond = vi.fn(async () => undefined);
  const channel = new NativeClientChannel({
    events,
    request: vi.fn(async () => ({ result: {} })),
    respond,
  });
  channel.observeMessage({
    id: "approval-1",
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "native-thread",
      command: "echo safe",
      availableDecisions: ["acceptForSession", "decline", "cancel"],
    },
  });

  const publicId = channel.interactions("native-thread")[0]?.requestId;
  expect(publicId).toBeDefined();
  if (publicId === undefined) throw new Error("Missing native approval");
  await expect(channel.respond(publicId, "native-thread", { decision: "accept" })).rejects.toThrow(
    "not available",
  );
  expect(respond).not.toHaveBeenCalled();
  expect(channel.interactions("native-thread")).toHaveLength(1);

  await channel.respond(publicId, "native-thread", { decision: "acceptForSession" });
  expect(respond).toHaveBeenCalledWith("approval-1", { decision: "acceptForSession" });
  expect(await channel.respond(publicId, "native-thread", { decision: "decline" })).toBe(false);
});

it("rejects stale approval handles after a native backend reuses a request ID", async () => {
  const events = new ClientChannelEvents();
  const changed: unknown[] = [];
  events.subscribe((event) => changed.push(event));
  const respond = vi.fn(async () => undefined);
  const channel = new NativeClientChannel({
    events,
    request: vi.fn(async () => ({ result: {} })),
    respond,
  });
  const approval = {
    id: 1,
    method: "item/fileChange/requestApproval",
    params: { threadId: "native-thread", availableDecisions: ["accept", "decline"] },
  };
  channel.observeMessage(approval);
  const oldId = channel.interactions("native-thread")[0]?.requestId;
  if (oldId === undefined) throw new Error("Missing old approval");
  channel.observeMessage(approval);
  expect(channel.interactions("native-thread")).toHaveLength(1);
  expect(channel.interactions("native-thread")[0]?.requestId).toBe(oldId);
  channel.resetGeneration();
  expect(changed).toContainEqual(
    expect.objectContaining({ threadId: "native-thread", method: "thread/status/changed" }),
  );
  channel.observeMessage(approval);
  const newId = channel.interactions("native-thread")[0]?.requestId;
  if (newId === undefined) throw new Error("Missing new approval");
  expect(newId).not.toBe(oldId);
  expect(channel.isStaleRequestId(oldId)).toBe(true);
  expect(await channel.respond(oldId, "native-thread", { decision: "accept" })).toBe(false);
  expect(respond).not.toHaveBeenCalled();
  expect(await channel.respond(newId, "native-thread", { decision: "accept" })).toBe(true);
  expect(respond).toHaveBeenCalledExactlyOnceWith(1, { decision: "accept" });
});

it("discards snapshots and resumed state from a retired backend generation", async () => {
  let reset = true;
  const events = new ClientChannelEvents();
  const request = vi.fn(async (method: string) => {
    if (method === "thread/resume") {
      if (reset) {
        reset = false;
        channel.resetGeneration();
      }
      return { result: { thread, model: "provider/model:preview" } };
    }
    if (method === "thread/read") return { result: { thread } };
    return { result: { data: [], nextCursor: null } };
  });
  const channel = new NativeClientChannel({
    events,
    request,
    respond: vi.fn(async () => undefined),
  });
  await expect(channel.snapshot("native-thread", {})).rejects.toMatchObject({ code: -32094 });
  expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/resume"]);
  const snapshot = await channel.snapshot("native-thread", {});
  expect(request.mock.calls.filter(([method]) => method === "thread/resume")).toHaveLength(2);
  expect(snapshot.configuration.effectiveModel).toEqual(
    encodeOfficialCodexModelRef("provider/model:preview"),
  );
});

it("does not expose native permission grants as generic approvals", () => {
  const channel = new NativeClientChannel({
    events: new ClientChannelEvents(),
    request: vi.fn(async () => ({ result: {} })),
    respond: vi.fn(async () => undefined),
  });
  channel.observeMessage({
    id: "permission-1",
    method: "item/permissions/requestApproval",
    params: { threadId: "native-thread", permissions: { read: ["/synthetic"] } },
  });
  expect(channel.interactions("native-thread")).toEqual([]);
});

it("reads the native isOther flag for custom answers", () => {
  const channel = new NativeClientChannel({
    events: new ClientChannelEvents(),
    request: vi.fn(async () => ({ result: {} })),
    respond: vi.fn(async () => undefined),
  });
  channel.observeMessage({
    id: 4,
    method: "item/tool/requestUserInput",
    params: {
      threadId: "native-thread",
      questions: [
        { id: "choice", question: "Choose or type", isOther: true, options: [{ label: "Option" }] },
      ],
    },
  });
  expect(channel.interactions("native-thread")[0]?.interaction).toMatchObject({
    type: "question",
    questions: [{ id: "choice", allowOther: true }],
  });
});

it("does not present a native secret question in an unmasked browser field", () => {
  const channel = new NativeClientChannel({
    events: new ClientChannelEvents(),
    request: vi.fn(async () => ({ result: {} })),
    respond: vi.fn(async () => undefined),
  });
  channel.observeMessage({
    id: 8,
    method: "item/tool/requestUserInput",
    params: {
      threadId: "native-thread",
      questions: [{ id: "secret", question: "Secret input", isSecret: true, options: null }],
    },
  });
  expect(channel.interactions("native-thread")).toEqual([]);
});

it("withdraws a resolved native card and invalidates its Thread without a Thread ID in the notification", () => {
  const events = new ClientChannelEvents();
  const updates: unknown[] = [];
  events.subscribe((value) => updates.push(value));
  const channel = new NativeClientChannel({
    events,
    request: vi.fn(async () => ({ result: {} })),
    respond: vi.fn(async () => undefined),
  });
  channel.observeMessage({
    id: "projected-native-id",
    method: "item/fileChange/requestApproval",
    params: { threadId: "native-thread" },
  });
  const before = updates.length;
  channel.observeMessage({
    method: "serverRequest/resolved",
    params: { requestId: "projected-native-id" },
  });
  expect(channel.interactions("native-thread")).toEqual([]);
  expect(updates.slice(before)).toContainEqual(
    expect.objectContaining({ threadId: "native-thread", method: "serverRequest/resolved" }),
  );
});

it.each([
  { method: "item/permissions/requestApproval", params: {} },
  { method: "item/tool/requestUserInput", params: { questions: [{ isSecret: true }] } },
  { method: "item/tool/call", params: {} },
  { method: "currentTime/read", params: {} },
  { method: "applyPatchApproval", params: {} },
  { method: "execCommandApproval", params: {} },
])(
  "rejects unhandled $method offline and leaves it to Desktop online",
  async ({ method, params }) => {
    const events = new ClientChannelEvents();
    const respond = vi.fn(async () => undefined);
    let online = true;
    const channel = new NativeClientChannel({
      events,
      request: vi.fn(async (method: string) => ({
        result: method === "thread/turns/list" ? { data: [], nextCursor: null } : { thread },
      })),
      respond,
      desktopConnected: () => online,
    });
    channel.noteThread("native-thread");
    const request = {
      id: 42,
      method,
      params: { ...params, threadId: "native-thread" },
    };
    channel.observeMessage(request);
    expect(respond).not.toHaveBeenCalled();
    expect(channel.interactions("native-thread")).toEqual([]);
    online = false;
    channel.observeMessage(request);
    expect(respond).toHaveBeenCalledWith(42, null, {
      code: -32601,
      message: expect.stringContaining(method),
    });
    const snapshot = await channel.snapshot("native-thread", {});
    expect(snapshot.thread.nativeInteractionError).toContain("Open Codex Desktop");
  },
);

it.each(["account/chatgptAuthTokens/refresh", "attestation/generate"])(
  "rejects threadless %s without invalidating or adding errors to Threads",
  async (method) => {
    const events = new ClientChannelEvents();
    const changed = vi.spyOn(events, "changed");
    const respond = vi.fn(async () => undefined);
    const channel = new NativeClientChannel({
      events,
      request: vi.fn(async (method: string) => ({
        result: method === "thread/turns/list" ? { data: [], nextCursor: null } : { thread },
      })),
      respond,
    });
    channel.noteThread("native-thread");
    channel.noteThread("another-thread");
    channel.observeMessage({ id: 42, method, params: {} });
    expect(respond).toHaveBeenCalledWith(42, null, {
      code: -32601,
      message: expect.stringContaining(method),
    });
    expect(changed).not.toHaveBeenCalled();
    const snapshot = await channel.snapshot("native-thread", {});
    expect(snapshot.thread.nativeInteractionError).toBeUndefined();
  },
);

it("reads writer-conflicted history without claiming resume and sends to the same Thread after release", async () => {
  let occupied = true;
  const conflict = {
    error: { code: -32600, message: "thread native-thread already has a live local writer" },
  };
  const request = vi.fn(async (method: string): Promise<NativeClientReply> => {
    if (method === "thread/resume") return occupied ? conflict : { result: { thread } };
    if (method === "thread/read") return { result: { thread } };
    if (method === "thread/turns/list")
      return {
        result: { data: [{ id: "turn-1", status: "completed", items: [] }], nextCursor: null },
      };
    return { result: { turn: { id: "turn-2", status: "inProgress" } } };
  });
  const channel = new NativeClientChannel({
    events: new ClientChannelEvents(),
    request,
    respond: vi.fn(async () => undefined),
  });
  const snapshot = await channel.snapshot("native-thread", {});
  expect(snapshot.turnsPage.data[0]?.id).toBe("turn-1");
  expect(snapshot.thread.nativeSendError).toContain("请先在另一端关闭此会话");
  expect(await channel.request("turn/start", { threadId: "native-thread", input: [] })).toEqual(
    conflict,
  );
  expect(request.mock.calls.map(([method]) => method)).toEqual([
    "thread/resume",
    "thread/read",
    "thread/turns/list",
    "thread/resume",
  ]);
  occupied = false;
  expect(
    await channel.request("turn/start", { threadId: "native-thread", input: [] }),
  ).toMatchObject({ result: { turn: { id: "turn-2" } } });
  expect(request).toHaveBeenLastCalledWith("turn/start", { threadId: "native-thread", input: [] });
  expect((await channel.snapshot("native-thread", {})).thread.nativeSendError).toBeUndefined();
});

it("resumes again after archive/unarchive and after thread/closed", async () => {
  const { channel, request } = snapshotChannel();
  await channel.snapshot("native-thread", {});
  request.mockResolvedValueOnce({ result: {} });
  await channel.request("thread/archive", { threadId: "native-thread" });
  request.mockResolvedValueOnce({ result: {} });
  await channel.request("thread/unarchive", { threadId: "native-thread" });
  request.mockImplementationOnce(async () => ({ result: { thread } }));
  request.mockImplementationOnce(async () => ({ result: {} }));
  await channel.request("turn/start", { threadId: "native-thread", input: [] });
  expect(request.mock.calls.map(([method]) => method)).toEqual([
    "thread/resume",
    "thread/read",
    "thread/turns/list",
    "thread/archive",
    "thread/unarchive",
    "thread/resume",
    "turn/start",
  ]);
  channel.observeMessage({ method: "thread/closed", params: { threadId: "native-thread" } });
  await channel.snapshot("native-thread", {});
  expect(request.mock.calls.filter(([method]) => method === "thread/resume")).toHaveLength(3);
});

it("rejects repeated responses after delivery failed instead of reporting resolved or resending", async () => {
  const respond = vi.fn(async () => {
    throw new Error("Synthetic transport failure");
  });
  const channel = new NativeClientChannel({
    events: new ClientChannelEvents(),
    request: vi.fn(async () => ({ result: {} })),
    respond,
  });
  channel.observeMessage({
    id: "approval",
    method: "item/fileChange/requestApproval",
    params: { threadId: "native-thread" },
  });
  const requestId = channel.interactions("native-thread")[0]?.requestId;
  if (requestId === undefined) throw new Error("Missing native approval");
  await expect(channel.respond(requestId, "native-thread", { decision: "accept" })).rejects.toThrow(
    "Synthetic transport failure",
  );
  await expect(channel.respond(requestId, "native-thread", { decision: "accept" })).rejects.toThrow(
    "outcome is unknown",
  );
  expect(respond).toHaveBeenCalledOnce();
});

it("drops native pending interactions and subscriptions on backend generation reset", () => {
  const channel = new NativeClientChannel({
    events: new ClientChannelEvents(),
    request: vi.fn(async () => ({ result: {} })),
    respond: vi.fn(async () => undefined),
  });
  channel.observeMessage({
    id: "approval-2",
    method: "item/fileChange/requestApproval",
    params: { threadId: "native-thread", availableDecisions: ["accept", "decline"] },
  });
  expect(channel.interactions("native-thread")).toHaveLength(1);
  channel.resetGeneration();
  expect(channel.interactions("native-thread")).toEqual([]);
});
