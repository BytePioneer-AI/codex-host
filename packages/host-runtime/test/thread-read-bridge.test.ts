import { expect, it, vi } from "vitest";
import { ThreadBridge } from "../src/thread-bridge.js";
import type { ThreadBridgeRead } from "@codexhost/shared-contracts";
import { randomUUID } from "node:crypto";

const localId = "12345678-1234-4123-8123-123456789abc";
const remoteId = "22345678-1234-4123-8123-123456789abc";
const clientId = "32345678-1234-4123-8123-123456789abc";
const input = {
  machineId: remoteId,
  threadId: "t",
  view: "messages" as const,
  limit: 2,
  cursor: "cursor",
};
const snapshot = {
  threadId: "t",
  harnessId: "codex",
  status: "completed",
  turn: null,
  progress: [],
  result: { availability: "available", text: "done" },
  messages: [],
  nextCursor: "next",
  hasMore: true,
};

it("routes a bounded read over one attached connection and preserves pagination and machine identity", async () => {
  const bridge = new ThreadBridge(localId);
  const owner = {};
  const send = vi.fn(async (read: ThreadBridgeRead) => {
    bridge.reply(
      {},
      {
        ...read,
        reply: {
          result: { ...snapshot, result: { availability: "available", text: "wrong connection" } },
        },
      },
    );
    bridge.reply(owner, {
      ...read,
      clientId: remoteId,
      reply: {
        result: { ...snapshot, result: { availability: "available", text: "wrong window" } },
      },
    });
    bridge.reply(owner, { ...read, reply: { result: snapshot } });
  });
  bridge.attach(owner, { clientId, machineIds: [remoteId], send });
  expect(await bridge.read(input)).toMatchObject({
    machineId: remoteId,
    nextCursor: "next",
    hasMore: true,
    result: { text: "done" },
  });
  expect(send.mock.calls[0]?.[0].input).toEqual({
    threadId: "t",
    view: "messages",
    limit: 2,
    cursor: "cursor",
  });
  expect(send).toHaveBeenCalledOnce();
});

it("rejects unavailable and expired routes without dispatching", async () => {
  vi.useFakeTimers();
  try {
    const bridge = new ThreadBridge(localId);
    const send = vi.fn(async () => {});
    await expect(bridge.read(input)).rejects.toMatchObject({ code: "RUNTIME_UNREACHABLE" });
    bridge.attach({}, { clientId, machineIds: [remoteId], send });
    await vi.advanceTimersByTimeAsync(45_001);
    await expect(bridge.read(input)).rejects.toMatchObject({ code: "RUNTIME_UNREACHABLE" });
    expect(send).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

it("disconnect rejects pending reads and a second window does not replace the first", async () => {
  const bridge = new ThreadBridge(localId);
  const owner = {};
  const send = vi.fn(async () => {});
  bridge.attach(owner, { clientId, machineIds: [remoteId], send });
  const result = bridge.read(input);
  const assertion = expect(result).rejects.toMatchObject({ code: "RUNTIME_UNREACHABLE" });
  bridge.attach(owner, { clientId: localId, machineIds: [remoteId], send });
  bridge.detach(owner);
  await assertion;
  expect(send).toHaveBeenCalledOnce();
});

it("times out once without retrying and rejects mismatched target snapshots", async () => {
  vi.useFakeTimers();
  try {
    const bridge = new ThreadBridge(localId);
    const owner = {};
    const send = vi.fn(async () => {});
    bridge.attach(owner, { clientId, machineIds: [remoteId], send });
    const result = bridge.read(input);
    const assertion = expect(result).rejects.toMatchObject({ code: "RUNTIME_UNREACHABLE" });
    await vi.advanceTimersByTimeAsync(40_000);
    await assertion;
    expect(send).toHaveBeenCalledOnce();
    bridge.attach(owner, {
      clientId,
      machineIds: [remoteId],
      send: async (read) => {
        bridge.reply(owner, { ...read, reply: { result: { ...snapshot, threadId: "wrong" } } });
      },
    });
    await expect(bridge.read(input)).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
  } finally {
    vi.useRealTimers();
  }
});

it.each(["disconnect", "timeout"])(
  "returns the send request ID and uncertainty after %s without redispatch",
  async (failure) => {
    vi.useFakeTimers();
    try {
      const bridge = new ThreadBridge(localId);
      const owner = {};
      const send = vi.fn(async () => {});
      bridge.attach(owner, { clientId, machineIds: [remoteId], sendMachineIds: [remoteId], send });
      const requestId = randomUUID();
      const pending = bridge.send({
        threadId: "t",
        machineId: remoteId,
        message: "continue",
        requestId,
      });
      const assertion = expect(pending).rejects.toMatchObject({
        code: "OUTCOME_UNKNOWN",
        details: { requestId },
      });
      if (failure === "disconnect") bridge.detach(owner);
      else await vi.advanceTimersByTimeAsync(40_000);
      await assertion;
      expect(send).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  },
);
