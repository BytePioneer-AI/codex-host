import { describe, it, expect, vi } from "vitest";
import {
  autoConnectMemory,
  restoreDisconnectedAutoConnect,
  startAutoConnectRestore,
} from "../src/remote-auto-connect.js";
import {
  rendererRemoteSession,
  type RemoteSessionTarget,
} from "../src/renderer-remote-sessions.js";
import { remoteConnectionsExpression } from "../src/remote-connections-control.js";

function fixture() {
  const requests = [
    { id: 7, method: "item/commandExecution/requestApproval", params: { threadId: "same" } },
  ];
  const manager = () => ({
    sendRequest: vi.fn(async (method: string) =>
      method === "thread/read" ? { thread: { id: "same" } } : {},
    ),
    getConversation: () => ({ requests }),
    replyWithCommandExecutionApprovalDecision: vi.fn(),
    replyWithFileChangeApprovalDecision: vi.fn(),
  });
  const routes = new Map([
    ["remote-ssh-discovered:a", { manager: manager() }],
    ["remote-control:b", { manager: manager() }],
  ]);
  const target: RemoteSessionTarget = {
    __codexhostHostRoutingV1: {
      knownHostIds: () => ["local", ...routes.keys()],
      forHost: (id) => routes.get(id) ?? null,
    },
  };
  const read = (hostId = "remote-ssh-discovered:a") =>
    rendererRemoteSession(target, { kind: "read", hostId, threadId: "same" }) as Promise<{
      epoch: string;
      requests: unknown[];
    }>;
  const route = (id: string) => {
    const value = routes.get(id);
    if (!value) throw new Error("Missing fixture route");
    return value;
  };
  return { target, routes, read, requests, route };
}
describe("Desktop existing remote session boundary", () => {
  const hosts = (target: RemoteSessionTarget) =>
    rendererRemoteSession(
      target,
      { kind: "hosts" },
      restoreDisconnectedAutoConnect,
      autoConnectMemory,
    );

  it("shows configured offline hosts and retries a disconnected auto-connect SSH host", async () => {
    const f = fixture();
    const writes: unknown[] = [];
    f.target.__codexhostRendererBindingProbeV1 = {
      async remoteConnections(input) {
        const op = input as { action: string; hostId?: string };
        if (op.action === "catalog")
          return [
            { hostId: "remote-ssh-discovered:a", displayName: "mac", autoConnect: true },
            {
              hostId: "remote-ssh-discovered:disabled",
              displayName: "disabled",
              autoConnect: false,
            },
          ];
        if (op.action === "connect") {
          writes.push(op);
          throw new Error("unknown connect outcome");
        }
        return { state: op.hostId === "remote-control:b" ? "connected" : "disconnected" };
      },
    };
    const listed = await hosts(f.target);
    await hosts(f.target);
    expect(writes).toEqual([
      { action: "connect", hostId: "remote-ssh-discovered:a", enabled: false },
      { action: "connect", hostId: "remote-ssh-discovered:a", enabled: true },
      { action: "connect", hostId: "remote-ssh-discovered:a", enabled: false },
      { action: "connect", hostId: "remote-ssh-discovered:a", enabled: true },
    ]);
    expect(listed).toContainEqual({
      hostId: "remote-ssh-discovered:a",
      displayName: "mac",
      online: false,
      state: "disconnected",
    });
    expect(listed).toContainEqual({
      hostId: "remote-ssh-discovered:disabled",
      displayName: "disabled",
      online: false,
      state: "disconnected",
    });
  });
  it("isolates identical native thread and approval IDs by host and preserves observers", async () => {
    const f = fixture();
    const a = await f.read(),
      b = await f.read("remote-control:b");
    expect(a.epoch).not.toBe(b.epoch);
    expect((await f.read()).requests).toEqual(a.requests);
    await rendererRemoteSession(f.target, {
      kind: "respond",
      hostId: "remote-ssh-discovered:a",
      threadId: "same",
      epoch: a.epoch,
      requestId: 7,
      result: { decision: "accept" },
    });
    expect(
      f.route("remote-ssh-discovered:a").manager.replyWithCommandExecutionApprovalDecision,
    ).toHaveBeenCalledWith("same", 7, "accept");
    expect(
      f.route("remote-control:b").manager.replyWithCommandExecutionApprovalDecision,
    ).not.toHaveBeenCalled();
    expect((await f.read("remote-control:b")).requests).toHaveLength(1);
    expect((await f.read()).requests).toHaveLength(0);
  });
  it("rejects disconnected and replaced routes before writes", async () => {
    const f = fixture(),
      a = await f.read();
    const old = f.route("remote-ssh-discovered:a");
    f.routes.delete("remote-ssh-discovered:a");
    await expect(
      rendererRemoteSession(f.target, {
        kind: "prompt",
        hostId: "remote-ssh-discovered:a",
        threadId: "same",
        epoch: a.epoch,
        text: "hello",
      }),
    ).rejects.toThrow(/offline/);
    f.routes.set("remote-ssh-discovered:a", { manager: old.manager });
    await expect(
      rendererRemoteSession(f.target, {
        kind: "prompt",
        hostId: "remote-ssh-discovered:a",
        threadId: "same",
        epoch: a.epoch,
        text: "hello",
      }),
    ).rejects.toThrow(/changed/);
    expect(old.manager.sendRequest).toHaveBeenCalledTimes(2);
  });
  it("does not replay an approval after an unknown native dispatch outcome", async () => {
    const f = fixture(),
      a = await f.read();
    const send =
      f.route("remote-ssh-discovered:a").manager.replyWithCommandExecutionApprovalDecision;
    send.mockImplementation(() => {
      throw new Error("disconnected after write");
    });
    const operation = {
      kind: "respond" as const,
      hostId: "remote-ssh-discovered:a",
      threadId: "same",
      epoch: a.epoch,
      requestId: 7,
      result: { decision: "accept" },
    };
    await expect(rendererRemoteSession(f.target, operation)).rejects.toThrow("disconnected");
    await expect(rendererRemoteSession(f.target, operation)).rejects.toThrow("no longer pending");
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("rejects cross-thread approval IDs and unadvertised response forms", async () => {
    const f = fixture(),
      a = await f.read();
    await expect(
      rendererRemoteSession(f.target, {
        kind: "respond",
        hostId: "remote-ssh-discovered:a",
        threadId: "other",
        epoch: a.epoch,
        requestId: 7,
        result: { decision: "accept" },
      }),
    ).rejects.toThrow("no longer pending");
    await expect(
      rendererRemoteSession(f.target, {
        kind: "respond",
        hostId: "remote-ssh-discovered:a",
        threadId: "same",
        epoch: a.epoch,
        requestId: 7,
        result: { decision: "acceptForSession" },
      }),
    ).rejects.toThrow("Unsupported");
  });
  it("resumes only the selected existing thread and never retries turn/start", async () => {
    const f = fixture(),
      a = await f.read();
    const send = f.route("remote-ssh-discovered:a").manager.sendRequest;
    send.mockImplementation(async (method) => {
      if (method === "turn/start") throw new Error("lost result");
      return {};
    });
    await expect(
      rendererRemoteSession(f.target, {
        kind: "prompt",
        hostId: "remote-ssh-discovered:a",
        threadId: "same",
        epoch: a.epoch,
        text: "hello",
      }),
    ).rejects.toThrow("lost result");
    expect(send.mock.calls.map(([method]) => method)).toEqual([
      "thread/read",
      "thread/read",
      "thread/resume",
      "turn/start",
    ]);
  });
  it("restores a disconnected SSH host from the injected controller expression", async () => {
    const f = fixture();
    const writes: unknown[] = [];
    f.target.__codexhostRendererBindingProbeV1 = {
      async remoteConnections(input) {
        const op = input as { action: string; hostId?: string; enabled?: boolean };
        if (op.action === "catalog")
          return [{ hostId: "remote-ssh-discovered:a", displayName: "mac", autoConnect: true }];
        if (op.action === "connect") {
          writes.push({ hostId: op.hostId, enabled: op.enabled });
          return null;
        }
        return { state: op.hostId === "remote-ssh-discovered:a" ? "disconnected" : "connected" };
      },
    };
    const expression = remoteConnectionsExpression({
      action: "session",
      operation: { kind: "hosts" },
    });
    const evaluate = new Function("window", `return ${expression}`) as (
      window: RemoteSessionTarget,
    ) => Promise<unknown>;
    await evaluate(f.target);
    expect(writes).toEqual([
      { hostId: "remote-ssh-discovered:a", enabled: false },
      { hostId: "remote-ssh-discovered:a", enabled: true },
    ]);
  });
  it("releases a connected SSH host from the injected controller expression", async () => {
    const f = fixture();
    const released: string[] = [];
    autoConnectMemory(f.target).onConnected = (hostId) => released.push(hostId);
    let connected = false;
    f.target.__codexhostRendererBindingProbeV1 = {
      async remoteConnections(input) {
        const op = input as { action: string; hostId?: string; enabled?: boolean };
        if (op.action === "catalog")
          return [{ hostId: "remote-ssh-discovered:a", displayName: "mac", autoConnect: true }];
        if (op.action === "connect") {
          if (op.enabled) connected = true;
          return null;
        }
        return {
          state:
            op.hostId === "remote-ssh-discovered:a" && !connected ? "disconnected" : "connected",
        };
      },
    };
    const expression = remoteConnectionsExpression({
      action: "session",
      operation: { kind: "hosts" },
    });
    const evaluate = new Function("window", `return ${expression}`) as (
      window: RemoteSessionTarget,
    ) => Promise<unknown>;
    await evaluate(f.target);
    expect(released).toEqual(["remote-ssh-discovered:a"]);
  });
  it("releases a recovered SSH host through the startup hook, then stops until it drops", async () => {
    const f = fixture();
    const released: string[] = [];
    const stop = startAutoConnectRestore(
      f.target,
      { list: async () => [], state: async () => null, connect: async () => undefined },
      {
        setTimeout() {
          return 0;
        },
        clearTimeout() {
          return undefined;
        },
      },
      { delaysMs: [], onConnected: (hostId) => released.push(hostId) },
    );
    const script: Array<readonly string[] | null> = [
      ["remote-ssh-discovered:a"],
      null,
      ["remote-ssh-discovered:a"],
      [],
      ["remote-ssh-discovered:a"],
    ];
    const restore: typeof restoreDisconnectedAutoConnect = async () => {
      const next = script.shift();
      return next === undefined ? [] : next;
    };
    f.target.__codexhostRendererBindingProbeV1 = {
      async remoteConnections() {
        return [];
      },
    };
    const read = () =>
      rendererRemoteSession(f.target, { kind: "hosts" }, restore, autoConnectMemory, 1);
    await read();
    await read();
    await read();
    expect(released).toEqual(["remote-ssh-discovered:a"]);
    await read();
    await read();
    expect(released).toEqual(["remote-ssh-discovered:a", "remote-ssh-discovered:a"]);
    stop.dispose();
    await read();
    expect(released).toEqual(["remote-ssh-discovered:a", "remote-ssh-discovered:a"]);
  });
  it("releases an SSH host the state read finds connected after restore missed it", async () => {
    const f = fixture();
    const released: string[] = [];
    autoConnectMemory(f.target).onConnected = (hostId) => released.push(hostId);
    let sshConnected = false;
    f.target.__codexhostRendererBindingProbeV1 = {
      async remoteConnections(input) {
        const op = input as { action: string; hostId?: string };
        if (op.action === "catalog") return [];
        if (op.action === "state")
          return {
            state:
              op.hostId === "remote-ssh-discovered:a" && !sshConnected
                ? "disconnected"
                : "connected",
          };
        return null;
      },
    };
    const restore: typeof restoreDisconnectedAutoConnect = async () => [];
    const read = () =>
      rendererRemoteSession(f.target, { kind: "hosts" }, restore, autoConnectMemory, 1);
    const first = (await read()) as Array<{ hostId: string; state: string }>;
    expect(first.find((row) => row.hostId === "remote-ssh-discovered:a")?.state).toBe(
      "disconnected",
    );
    expect(released).toEqual([]);
    sshConnected = true;
    await read();
    expect(released).toEqual(["remote-ssh-discovered:a"]);
  });
  it("still lists hosts when the startup release hook throws", async () => {
    const f = fixture();
    let calls = 0;
    autoConnectMemory(f.target).onConnected = () => {
      calls += 1;
      if (calls === 1) throw new Error("release failed");
    };
    f.target.__codexhostRendererBindingProbeV1 = {
      async remoteConnections(input) {
        const op = input as { action: string; hostId?: string };
        if (op.action === "catalog")
          return [{ hostId: "remote-ssh-discovered:a", displayName: "mac", autoConnect: true }];
        if (op.action === "state") return { state: "connected" };
        return null;
      },
    };
    const read = () =>
      rendererRemoteSession(
        f.target,
        { kind: "hosts" },
        restoreDisconnectedAutoConnect,
        autoConnectMemory,
        1,
      );
    await expect(read()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ hostId: "remote-ssh-discovered:a", state: "connected" }),
      ]),
    );
    await read();
    expect(calls).toBe(2);
  });
  it("serializes data in the Controller expression and excludes local operations", async () => {
    const f = fixture();
    const expression = remoteConnectionsExpression({
      action: "session",
      operation: { kind: "hosts" },
    });
    const evaluate = new Function("window", `return ${expression}`);
    expect(await evaluate(f.target)).toEqual({
      result: [
        { hostId: "remote-ssh-discovered:a", online: true },
        { hostId: "remote-control:b", online: true },
      ],
    });
    expect(() =>
      remoteConnectionsExpression({
        action: "session",
        operation: { kind: "read", hostId: "local", threadId: "same" },
      }),
    ).toThrow();
  });
});
