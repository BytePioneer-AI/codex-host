import { describe, expect, it, vi } from "vitest";
import {
  encodeHarnessPluginRoute,
  harnessIdSchema,
  harnessModelRefSchema,
} from "@codexhost/shared-contracts";
import {
  createNativeScheduleWorkspaceThread,
  type NativeProjectThreadCreator,
} from "../src/renderer-schedule-workspace.js";
import type { RendererHostRouting } from "../src/renderer-host-routing.js";

const model = encodeHarnessPluginRoute({
  harnessId: harnessIdSchema.parse("pi"),
  model: harnessModelRefSchema.parse({ id: "chosen" }),
});
const workspace = { id: "project-a", label: "项目 A", cwd: "/work/项目 A" };
const created = {
  status: "created",
  conversationId: "external-empty",
  firstTurn: { status: "not-requested" },
};
function fixture() {
  const thread = {
    id: created.conversationId,
    cwd: workspace.cwd,
    status: { type: "idle" },
    turns: [],
    historyMode: "paginated",
  };
  const inspection = {
    owner: "external",
    harnessId: "pi",
    transportModelId: model,
    history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
    locked: true,
  };
  const turns = { data: [] as unknown[], nextCursor: null as string | null };
  const queue = { data: [] as unknown[], nextCursor: null as string | null };
  const sendRequest = vi.fn<(method: string, params: unknown) => Promise<unknown>>(
    async (method) => {
      switch (method) {
        case "thread/read":
          return { thread };
        case "thread/turns/list":
          return turns;
        case "thread/queue/list":
          return queue;
        case "codexhost/thread/inspect":
          return inspection;
        case "thread/archive":
          return {};
        default:
          throw Error(`Unexpected ${method}`);
      }
    },
  );
  const rpc = {
    startConversation: vi.fn<(input: unknown, options: unknown) => Promise<typeof created>>(
      async () => created,
    ),
  };
  const connection = { status: "ready", client: { hostId: "local", rpc } };
  const family = new Map([["local", { value: { get: () => connection } }]]);
  const store = { parent: null, familyBindings: new Map([[{ kind: "signal-family" }, family]]) };
  const scope = { node: store, chain: [], scope: {}, get: () => connection, set() {}, watch() {} };
  const hook = <T>(handle: T) => ({ memoizedState: { current: handle }, next: null });
  const mainFiber = { memoizedState: hook(scope), return: { memoizedState: hook({ ...scope }) } };
  const main = { querySelectorAll: () => [], __reactFiber$fixture: mainFiber };
  const catalog = new Map([
    [
      workspace.id,
      {
        source: "codex",
        group: {
          projectKind: "local",
          projectId: workspace.id,
          path: workspace.cwd,
          label: workspace.label,
          rootPaths: [workspace.cwd],
        },
      },
    ],
  ]);
  const row = {
    querySelectorAll: () => [],
    __reactFiber$fixture: { memoizedProps: { projectByKey: catalog } },
  };
  const root = { querySelectorAll: (selector: string) => (selector === "main" ? [main] : [row]) };
  const policy = { scopedCreation: true, select: vi.fn(), clear: vi.fn() };
  const manager = { kind: "main-process-rpc", getHostId: () => "local", sendRequest };
  let current: unknown = manager;
  const routing = {
    forHost: () => ({ manager: current, policy }),
  } as unknown as RendererHostRouting;
  const create = vi.fn<NativeProjectThreadCreator>(async (input) => {
    input.assertRequestCurrent?.();
    // The native project creator forwards its explicit Model without a Composer clientThreadId.
    await rpc.startConversation(
      { input: [], cwd: workspace.cwd, collaborationMode: { settings: { model: input.model } } },
      { clientThreadId: undefined },
    );
    input.onSettled(created);
    return { kind: "creation", result: created };
  });
  const controller = new AbortController();
  const start = () =>
    createNativeScheduleWorkspaceThread(
      root,
      routing,
      create,
      { workspace, model, title: "Task" },
      controller.signal,
    );
  const archived = () => sendRequest.mock.calls.filter(([method]) => method === "thread/archive");
  const settle = () => {
    const call = create.mock.calls[0];
    if (!call) throw Error("Native creation was not invoked");
    call[0].onSettled(created);
  };
  return {
    start,
    create,
    controller,
    thread,
    inspection,
    turns,
    queue,
    scope,
    mainFiber,
    catalog,
    rpc,
    policy,
    sendRequest,
    archived,
    settle,
    replaceConnection: () => {
      current = {};
    },
    replaceRpc: () => {
      connection.client.rpc = { ...rpc };
    },
  };
}

describe("main-process workspace schedule creation", () => {
  it("uses the root app scope and explicit carrier without selecting or clearing any Composer draft", async () => {
    const f = fixture();
    const thread = await f.start();
    expect(thread.threadId).toBe(created.conversationId);
    expect(f.create).toHaveBeenCalledExactlyOnceWith({
      scope: expect.objectContaining({ node: f.scope.node }),
      target: { type: "project", projectId: workspace.id, environment: { type: "local" } },
      model,
      title: "Task",
      prompt: "",
      startWithoutFirstTurn: true,
      onSettled: expect.any(Function),
      assertRequestCurrent: expect.any(Function),
    });
    expect(f.rpc.startConversation).toHaveBeenCalledExactlyOnceWith(
      { input: [], cwd: workspace.cwd, collaborationMode: { settings: { model } } },
      { clientThreadId: undefined },
    );
    expect(f.sendRequest.mock.calls.map(([method]) => method)).toEqual([
      "thread/read",
      "thread/turns/list",
      "thread/queue/list",
      "codexhost/thread/inspect",
    ]);
    expect(f.sendRequest).toHaveBeenCalledWith("thread/read", {
      threadId: created.conversationId,
      includeTurns: false,
    });
    expect(f.policy.select).not.toHaveBeenCalled();
    expect(f.policy.clear).not.toHaveBeenCalled();
    thread.retain();
    f.controller.abort();
    await thread.discard?.();
    expect(f.archived()).toEqual([]);
  });

  it("rejects missing, draft-only or ambiguous app scopes before creating anything", async () => {
    for (const kind of ["missing", "draft", "ambiguous"] as const) {
      const f = fixture();
      if (kind === "missing")
        f.mainFiber.memoizedState = { memoizedState: { current: null }, next: null } as never;
      else if (kind === "draft") f.scope.node.parent = {} as never;
      else f.mainFiber.return.memoizedState.memoizedState.current.node = { ...f.scope.node };
      if (kind === "missing") f.mainFiber.return.memoizedState = f.mainFiber.memoizedState;
      await expect(f.start()).rejects.toThrow("scope is missing or ambiguous");
      expect(f.create).not.toHaveBeenCalled();
    }
  });

  it("checks the selected project and abort signal before invoking native creation", async () => {
    const f = fixture();
    f.catalog.clear();
    await expect(f.start()).rejects.toThrow("workspace is no longer available");
    expect(f.create).not.toHaveBeenCalled();
    const g = fixture();
    g.controller.abort();
    await expect(g.start()).rejects.toThrow();
    expect(g.create).not.toHaveBeenCalled();
  });

  it("archives a late confirmed empty chat once when the dialog closes during creation", async () => {
    const f = fixture();
    const ready = Promise.withResolvers<unknown>();
    f.create.mockImplementation(() => ready.promise);
    const pending = f.start();
    f.controller.abort();
    f.settle();
    ready.resolve({ kind: "creation", result: created });
    await expect(pending).rejects.toThrow();
    expect(f.archived()).toEqual([["thread/archive", { threadId: created.conversationId }]]);
    expect(f.create).toHaveBeenCalledTimes(1);
  });

  it("reports an unknown outcome without retrying and cleans up late settlement even without abort", async () => {
    const f = fixture();
    f.create.mockResolvedValue({ kind: "creation", result: { status: "outcome-unknown" } });
    await expect(f.start()).rejects.toThrow("not confirmed");
    f.settle();
    await vi.waitFor(() => expect(f.archived()).toHaveLength(1));
    expect(f.create).toHaveBeenCalledTimes(1);
  });

  it.each(["cwd", "carrier", "owner", "first-turn"])(
    "rejects a mismatched %s and cleans up the confirmed empty chat",
    async (kind) => {
      const f = fixture();
      if (kind === "cwd") f.thread.cwd = "/wrong";
      if (kind === "carrier") f.inspection.transportModelId = "gpt-native";
      if (kind === "owner") f.inspection.owner = "codex";
      if (kind === "first-turn")
        f.create.mockResolvedValue({
          kind: "creation",
          result: { ...created, firstTurn: { status: "accepted" } },
        });
      await expect(f.start()).rejects.toThrow();
      expect(f.archived()).toHaveLength(1);
      expect(f.create).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["turn", "active", "queue", "cursor"])(
    "does not archive a chat with %s activity",
    async (kind) => {
      const f = fixture();
      const thread = await f.start();
      if (kind === "turn") f.turns.data.push({ id: "started-turn" });
      if (kind === "active") f.thread.status.type = "active";
      if (kind === "queue") f.queue.data.push({ id: "queued" });
      if (kind === "cursor") f.turns.nextCursor = "more";
      await thread.discard?.();
      expect(f.archived()).toEqual([]);
    },
  );

  it("does not treat metadata's omitted Turns as proof of an empty chat", async () => {
    const f = fixture();
    f.turns.data.push({ id: "existing-turn" });
    await expect(f.start()).rejects.toThrow("empty state could not be confirmed");
    expect(f.archived()).toEqual([]);
  });

  it.each(["read", "history", "queue", "archive"])(
    "surfaces %s cleanup failure and never retries creation",
    async (kind) => {
      const f = fixture();
      f.inspection.transportModelId = "wrong-carrier";
      const original = f.sendRequest.getMockImplementation();
      if (!original) throw Error("Request implementation is missing");
      const failMethod = {
        read: "thread/read",
        history: "thread/turns/list",
        queue: "thread/queue/list",
        archive: "thread/archive",
      }[kind];
      f.sendRequest.mockImplementation(async (method, params) => {
        if (method === failMethod) throw Error(`${kind} unavailable`);
        return original(method, params);
      });
      await expect(f.start()).rejects.toThrow(`Chat cleanup failed: ${kind} unavailable`);
      expect(f.create).toHaveBeenCalledTimes(1);
    },
  );

  it("rejects malformed read identities and never archives an unverified identity", async () => {
    const f = fixture();
    f.thread.id = "some-other-chat";
    await expect(f.start()).rejects.toThrow("could not be read");
    expect(f.archived()).toEqual([]);
  });

  it.each(["route", "rpc"])(
    "guards native creation against a changed %s connection",
    async (kind) => {
      const f = fixture();
      f.create.mockImplementation(async (input) => {
        if (kind === "route") f.replaceConnection();
        else f.replaceRpc();
        input.assertRequestCurrent?.();
        return { kind: "creation", result: created };
      });
      await expect(f.start()).rejects.toThrow("local connection changed");
      expect(f.rpc.startConversation).not.toHaveBeenCalled();
      expect(f.create).toHaveBeenCalledTimes(1);
    },
  );
});
