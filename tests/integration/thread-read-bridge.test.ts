import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  THREAD_MANAGE_METHOD,
  THREAD_BRIDGE_MANAGE_METHOD,
  threadManagementParamsSchema,
  type ThreadManagementOperation,
  HOST_IDENTITY_METHOD,
  THREAD_BRIDGE_ATTACH_METHOD,
  THREAD_BRIDGE_READ_METHOD,
  THREAD_BRIDGE_REPLY_METHOD,
  DELEGATION_READ_METHOD,
  DELEGATION_SEND_METHOD,
  THREAD_BRIDGE_SEND_METHOD,
  delegationSendParamsSchema,
  REMOTE_THREAD_REPLY_MAX_BYTES,
  threadBridgeAttachSchema,
  threadBridgeReplySchema,
  parseThreadReference,
} from "@codexhost/shared-contracts";
import type {
  RendererHostRoute,
  RendererHostRouting,
} from "@codexhost/desktop-control/renderer-bindings";
import { ThreadSendReceipts } from "../../packages/host-runtime/src/thread-send-receipts.js";
import { DelegationControlError } from "../../packages/host-runtime/src/delegation-types.js";
import { ThreadBridge } from "../../packages/host-runtime/src/thread-bridge.js";
import { createRendererThreadBridge } from "../../packages/renderer-extension/src/renderer-thread-bridge.js";
import type { RendererMessageTarget } from "../../packages/renderer-extension/src/renderer-manual-compaction.js";

const localId = "12345678-1234-4123-8123-123456789abc";
const remoteId = "22345678-1234-4123-8123-123456789abc";
const clientId = "32345678-1234-4123-8123-123456789abc";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "thread-bridge-"));
  directories.push(directory);
  const listeners = new Set<Parameters<RendererMessageTarget["addEventListener"]>[1]>();
  const messages: RendererMessageTarget = {
    addEventListener: (_type, listener) => {
      listeners.add(listener);
    },
    removeEventListener: (_type, listener) => {
      listeners.delete(listener);
    },
  };
  const routes = new Map<string, RendererHostRoute>();
  const runtime = (machineId: string, hostId: string) => {
    const broker = new ThreadBridge(
      machineId,
      new ThreadSendReceipts(path.join(directory, machineId)),
    );
    const owner = {};
    const read = vi.fn(async (input: { threadId: string }) => ({
      threadId: input.threadId,
      harnessId: "codex",
      status: "completed",
      turn: null,
      progress: [],
      result: { availability: "available", text: machineId },
      messages: [{ id: "m", turnId: "turn", role: "agent", text: machineId }],
      nextCursor: "next-page",
      hasMore: true,
    }));
    const send = vi.fn(async (input: { threadId: string }) => ({
      threadId: input.threadId,
      turnId: "turn",
      harnessId: "codex",
      status: "running" as const,
      next: { read: "read", wait: "wait" },
    }));
    const manage = vi.fn(async (action: ThreadManagementOperation) => ({
      operation: action.operation,
      threadId: action.operation === "create" ? "new-thread" : action.threadId,
    }));
    const sendRequest = vi.fn(async (method: string, input: unknown): Promise<unknown> => {
      if (method === HOST_IDENTITY_METHOD)
        return { machineId, sendSupported: true, manageSupported: true };
      if (method === THREAD_BRIDGE_ATTACH_METHOD) {
        broker.attach(owner, {
          ...threadBridgeAttachSchema.parse(input),
          send: async (params) => {
            for (const listener of listeners)
              listener({
                source: messages,
                data: {
                  type: "mcp-notification",
                  hostId,
                  method:
                    "operation" in params
                      ? params.operation === "manage"
                        ? THREAD_BRIDGE_MANAGE_METHOD
                        : THREAD_BRIDGE_SEND_METHOD
                      : THREAD_BRIDGE_READ_METHOD,
                  params,
                },
              });
          },
        });
        return { machineId, sendSupported: true, manageSupported: true };
      }
      if (method === THREAD_BRIDGE_REPLY_METHOD) {
        broker.reply(owner, threadBridgeReplySchema.parse(input));
        return { machineId, sendSupported: true, manageSupported: true };
      }
      if (method === THREAD_MANAGE_METHOD) {
        const params = threadManagementParamsSchema.parse(input);
        return broker.executeManagement(params, () => manage(params.action));
      }
      if (method === DELEGATION_READ_METHOD) return read(input as { threadId: string });
      if (method === DELEGATION_SEND_METHOD) {
        const params = delegationSendParamsSchema.parse(input);
        return broker.executeSend(params, () => send(params));
      }
      throw new Error(`Unexpected ${method}`);
    });
    const route = { hostId, manager: { sendRequest }, policy: {} } as unknown as RendererHostRoute;
    routes.set(hostId, route);
    return { broker, owner, read, send, manage, sendRequest, route };
  };
  const local = runtime(localId, "local");
  const remote = runtime(remoteId, "ssh:linux");
  const routing: RendererHostRouting = {
    forHost: (id: string) => routes.get(id) ?? null,
    knownHostIds: () => [...routes.keys()],
    hostIdForComposer: () => null,
    forComposer: () => null,
    dispose() {},
  };
  const renderer = createRendererThreadBridge({
    routing: () => routing,
    hostIds: () => [],
    messages,
    clientId,
  });
  await renderer.refresh();
  return { local, remote, renderer, routes, listeners };
}

it("reads Linux from local and local from Linux over the existing connection, keeping pagination", async () => {
  const f = await fixture();
  try {
    const localLink = parseThreadReference(await f.renderer.reference("local-thread", "local"));
    const remoteLink = parseThreadReference(
      await f.renderer.reference("remote-thread", "ssh:linux"),
    );
    expect(
      await f.remote.broker.read({ ...localLink, view: "messages", limit: 2, cursor: "page" }),
    ).toMatchObject({ machineId: localId, result: { text: localId }, nextCursor: "next-page" });
    expect(await f.local.broker.read({ ...remoteLink, view: "result" })).toMatchObject({
      machineId: remoteId,
      result: { text: remoteId },
    });
    expect(f.local.read).toHaveBeenCalledExactlyOnceWith({
      threadId: "local-thread",
      view: "messages",
      limit: 2,
      cursor: "page",
      expectedMachineId: localId,
    });
    expect(f.remote.read).toHaveBeenCalledExactlyOnceWith({
      threadId: "remote-thread",
      view: "result",
      expectedMachineId: remoteId,
    });
    expect(await f.renderer.hostFor({ ...remoteLink, hostId: "wrong-local-alias" })).toBe(
      "ssh:linux",
    );
  } finally {
    f.renderer.dispose();
  }
  expect(f.listeners.size).toBe(0);
});

it("does not dispatch through a disconnected or replaced manager", async () => {
  const f = await fixture();
  try {
    f.routes.delete("local");
    await expect(
      f.remote.broker.read({ threadId: "same-id", machineId: localId, view: "result" }),
    ).rejects.toThrow("disconnected");
    expect(f.local.read).not.toHaveBeenCalled();
    expect(f.remote.read).not.toHaveBeenCalled();
    await f.renderer.refresh();
    await expect(
      f.remote.broker.read({ threadId: "same-id", machineId: localId, view: "result" }),
    ).rejects.toThrow("no connected");
  } finally {
    f.renderer.dispose();
  }
});

it("reports an oversized reply without returning truncated history", async () => {
  const f = await fixture();
  try {
    const original = f.local.read.getMockImplementation();
    if (!original) throw new Error("Fixture read implementation is missing");
    f.local.read.mockImplementation(async (input) => {
      const snapshot = await original(input);
      snapshot.result.text = "x".repeat(REMOTE_THREAD_REPLY_MAX_BYTES);
      return snapshot;
    });
    await expect(
      f.remote.broker.read({ threadId: "t", machineId: localId, view: "result" }),
    ).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
  } finally {
    f.renderer.dispose();
  }
});

it("rejects a connection replacement during a read instead of returning stale content", async () => {
  const f = await fixture();
  try {
    const original = f.local.read.getMockImplementation();
    if (!original) throw new Error("Fixture read implementation is missing");
    f.local.read.mockImplementation(async (input) => {
      f.routes.set("local", { ...f.local.route });
      return original(input);
    });
    await expect(
      f.remote.broker.read({ threadId: "t", machineId: localId, view: "result" }),
    ).rejects.toThrow("changed");
  } finally {
    f.renderer.dispose();
  }
});

it("continues Threads in both directions and deduplicates retries at the destination", async () => {
  const f = await fixture();
  try {
    for (const [source, target, hostId] of [
      [f.local, f.remote, "ssh:linux"],
      [f.remote, f.local, "local"],
    ] as const) {
      const reference = parseThreadReference(await f.renderer.reference("t", hostId));
      const input = { ...reference, message: "continue this task", requestId: randomUUID() };
      const result = await source.broker.send(input);
      expect(result).toMatchObject({
        ...reference,
        requestId: input.requestId,
        status: "running",
        turnId: "turn",
      });
      expect(result.next.read).toContain(reference.machineId);
      expect(result.next).not.toHaveProperty("wait");
      expect(await source.broker.send(input)).toEqual(result);
      expect(target.send).toHaveBeenCalledOnce();
    }
  } finally {
    f.renderer.dispose();
  }
});

it("preserves busy errors from the target instead of starting on the source", async () => {
  const f = await fixture();
  try {
    f.remote.send.mockRejectedValue(new DelegationControlError("THREAD_BUSY", "Thread is active"));
    await expect(
      f.local.broker.send({
        threadId: "t",
        machineId: remoteId,
        message: "continue",
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "THREAD_BUSY" });
    expect(f.local.send).not.toHaveBeenCalled();
  } finally {
    f.renderer.dispose();
  }
});

it("recovers the receipt after a lost connection without sending the message twice", async () => {
  const f = await fixture();
  try {
    const original = f.remote.send.getMockImplementation();
    if (!original) throw new Error("Missing send implementation");
    f.remote.send.mockImplementation(async (input) => {
      f.routes.set("ssh:linux", { ...f.remote.route });
      return original(input);
    });
    const input = {
      threadId: "t",
      machineId: remoteId,
      message: "continue",
      requestId: randomUUID(),
    };
    await expect(f.local.broker.send(input)).rejects.toMatchObject({
      code: "OUTCOME_UNKNOWN",
      details: { requestId: input.requestId },
    });
    await f.renderer.refresh();
    expect(await f.local.broker.send(input)).toMatchObject({
      requestId: input.requestId,
      status: "running",
    });
    expect(f.remote.send).toHaveBeenCalledOnce();
  } finally {
    f.renderer.dispose();
  }
});

it("does not advertise sends to an older read-only Host", async () => {
  const f = await fixture();
  try {
    const original = f.remote.sendRequest.getMockImplementation();
    if (!original) throw new Error("Missing request implementation");
    f.remote.sendRequest.mockImplementation(async (method, params) =>
      method === HOST_IDENTITY_METHOD ? { machineId: remoteId } : original(method, params),
    );
    f.routes.set("ssh:linux", { ...f.remote.route });
    await f.renderer.refresh();
    await expect(
      f.local.broker.send({
        threadId: "t",
        machineId: remoteId,
        message: "continue",
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_UNREACHABLE" });
    expect(f.remote.send).not.toHaveBeenCalled();
    expect(
      await f.local.broker.read({ threadId: "t", machineId: remoteId, view: "result" }),
    ).toMatchObject({ machineId: remoteId });
  } finally {
    f.renderer.dispose();
  }
});

it("manages Threads in both directions, deduplicates creates, and refuses old destinations", async () => {
  const f = await fixture();
  try {
    const input = {
      machineId: localId,
      hostId: "local",
      requestId: randomUUID(),
      action: { operation: "create", cwd: "/work", harnessId: "codex" } as const,
    };
    expect(await f.remote.broker.manage(input)).toMatchObject({
      operation: "create",
      machineId: localId,
      threadId: "new-thread",
    });
    await f.remote.broker.manage(input);
    expect(f.local.manage).toHaveBeenCalledOnce();
    for (const operation of ["rename", "archive", "unarchive", "delete"] as const) {
      const action =
        operation === "rename"
          ? { operation, threadId: "remote-thread", name: "new name" }
          : { operation, threadId: "remote-thread" };
      expect(
        await f.local.broker.manage({ machineId: remoteId, requestId: randomUUID(), action }),
      ).toMatchObject({ operation, threadId: "remote-thread", machineId: remoteId });
    }
    const original = f.local.sendRequest.getMockImplementation();
    if (!original) throw new Error("Missing request implementation");
    f.local.sendRequest.mockImplementation(async (method, params) =>
      method === HOST_IDENTITY_METHOD
        ? { machineId: localId, sendSupported: true }
        : original(method, params),
    );
    f.routes.set("local", { ...f.local.route });
    await f.renderer.refresh();
    await expect(
      f.remote.broker.manage({ ...input, requestId: randomUUID() }),
    ).rejects.toMatchObject({ code: "RUNTIME_UNREACHABLE" });
    expect(f.local.manage).toHaveBeenCalledOnce();
  } finally {
    f.renderer.dispose();
  }
});
