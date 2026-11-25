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
    sendRequest: vi.fn(async (method: string): Promise<unknown> =>
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
describe("Desktop remote session boundary", () => {
  it("retains a new Thread that persists and unloads during catalog discovery", async () => {
    const f = fixture();
    const hostId = "remote-ssh-discovered:a";
    let persisted = false;
    f.route(hostId).manager.sendRequest.mockImplementation(async (method) => {
      const page =
        method === "thread/loaded/list"
          ? { data: persisted ? [] : ["same"] }
          : { data: persisted ? [{ id: "same" }] : [], nextCursor: null };
      persisted = true;
      return page;
    });
    const page = await rendererRemoteSession(f.target, {
      kind: "list",
      hostId,
      archived: false,
      cursor: null,
      includeLoaded: true,
    });
    expect(page).toMatchObject({ data: [{ id: "same" }], loaded: ["same"] });
  });

  it.each([true, false])("opens unmaterialized first-turn history (paged=%s)", async (paged) => {
    const f = fixture();
    const hostId = "remote-ssh-discovered:a";
    const missing = Object.assign(
      new Error(
        "thread same is not materialized yet; thread/turns/list is unavailable before first user message",
      ),
      { jsonRpcCode: -32600 },
    );
    f.route(hostId).manager.sendRequest.mockImplementation(async (method) => {
      if (method === "thread/read") return { thread: { id: "same", historyMode: "paginated" } };
      if (method === "thread/turns/list") throw missing;
      return {};
    });
    await expect(
      rendererRemoteSession(f.target, {
        kind: "read",
        hostId,
        threadId: "same",
        ...(paged ? { page: { cursor: null } } : {}),
      }),
    ).resolves.toMatchObject({ result: { thread: { id: "same", turns: [] } } });
  });
  it("starts a Thread on the selected Host with its defaults and fences a changed connection", async () => {
    const f = fixture();
    const hostId = "remote-ssh-discovered:a";
    const snapshot = await f.read(hostId);
    const create = {
      kind: "create",
      hostId,
      cwd: "/remote/center",
      epoch: snapshot.epoch,
    } as const;
    await rendererRemoteSession(f.target, create);
    expect(f.route(hostId).manager.sendRequest).toHaveBeenCalledWith("thread/start", {
      cwd: create.cwd,
      historyMode: "paginated",
    });
    const other = f.route("remote-control:b");
    f.routes.set(hostId, other);
    await expect(rendererRemoteSession(f.target, create)).rejects.toThrow("changed");
    expect(other.manager.sendRequest).not.toHaveBeenCalled();
  });
  it("sends the first Turn after a missing rollout only if the selected Host still has the Thread loaded", async () => {
    const f = fixture();
    const hostId = "remote-ssh-discovered:a";
    const { epoch } = await f.read(hostId);
    const request = f.route(hostId).manager.sendRequest;
    const missing = new Error("no rollout found for thread id same");
    const prompt = { kind: "prompt", hostId, threadId: "same", epoch, text: "hello" } as const;
    request.mockRejectedValueOnce(missing).mockResolvedValueOnce({ data: [] });
    await expect(rendererRemoteSession(f.target, prompt)).rejects.toBe(missing);
    request.mockRejectedValueOnce(missing).mockResolvedValueOnce({ data: ["same"] });
    await rendererRemoteSession(f.target, prompt);
    expect(request.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(1);
  });
  it("stops before the first turn if the target reports a different Harness owner", async () => {
    const f = fixture();
    const hostId = "remote-ssh-discovered:a";
    const { epoch } = await f.read();
    const send = f.route(hostId).manager.sendRequest;
    send
      .mockClear()
      .mockResolvedValueOnce({ thread: { id: "new" } })
      .mockResolvedValueOnce({ owner: "codex" });
    await expect(
      rendererRemoteSession(f.target, {
        kind: "startSelected",
        hostId,
        epoch,
        cwd: "/remote/center",
        model: "selected-model",
        harnessId: "claude-code",
      }),
    ).rejects.toThrow(/did not confirm the selected Harness/);
    expect(send.mock.calls.map(([method]) => method)).toEqual([
      "thread/start",
      "codexhost/thread/inspect",
    ]);
  });

  it("reads usage on the selected remote host and rejects a stale connection", async () => {
    const f = fixture();
    const hostId = "remote-ssh-discovered:a";
    const snapshot = await f.read();
    const request = { kind: "usage", hostId, threadId: "same", epoch: snapshot.epoch } as const;
    await rendererRemoteSession(f.target, request);
    expect(f.route(hostId).manager.sendRequest).toHaveBeenCalledWith(
      "codexhost/thread/usage/inspect",
      { threadId: "same" },
    );
    expect(f.route("remote-control:b").manager.sendRequest).not.toHaveBeenCalled();

    const replacement = fixture().route(hostId);
    f.routes.set(hostId, replacement);
    await expect(rendererRemoteSession(f.target, request)).rejects.toThrow("connection changed");
    expect(replacement.manager.sendRequest).not.toHaveBeenCalled();
  });

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
    expect(old.manager.sendRequest).toHaveBeenCalledTimes(3);
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
      "codexhost/thread/inspect",
      "thread/resume",
      "turn/start",
    ]);
    expect(send).toHaveBeenCalledWith("thread/resume", { threadId: "same", excludeTurns: true });
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
        { hostId: "remote-ssh-discovered:a", online: true, epoch: expect.any(String) },
        { hostId: "remote-control:b", online: true, epoch: expect.any(String) },
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
