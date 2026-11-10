import { describe, it, expect, vi } from "vitest";
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
  it("shows configured offline hosts and restores only already-enabled connections once", async () => {
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
    const hosts = await rendererRemoteSession(f.target, { kind: "hosts" });
    await rendererRemoteSession(f.target, { kind: "hosts" });
    expect(writes).toEqual([
      { action: "connect", hostId: "remote-ssh-discovered:a", enabled: true },
    ]);
    expect(hosts).toContainEqual({
      hostId: "remote-ssh-discovered:a",
      displayName: "mac",
      online: false,
      state: "disconnected",
    });
    expect(hosts).toContainEqual({
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
    expect(old.manager.sendRequest).toHaveBeenCalledTimes(1);
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
      "thread/resume",
      "turn/start",
    ]);
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
