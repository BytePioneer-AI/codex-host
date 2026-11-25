import assert from "node:assert/strict";
import { it } from "node:test";
import { remoteWorkspaceGroups } from "../src/remote-workspaces.ts";
import { RemoteSessions, remoteSessionId } from "../src/remote-sessions.ts";
import { RemoteProjectDraft } from "../src/remote-project-draft.ts";
import { type RemoteSessionOperation } from "@codexhost/shared-contracts";
import { Workspaces } from "../src/workspaces.ts";
import { DataDir } from "../src/store.ts";
import { EventHub, RpcRegistry, StreamRegistry, type StreamHandler } from "../src/transport.ts";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PeerHostManager } from "../src/peer-host-manager.ts";
import { PeerHostStore } from "../src/peer-host-store.ts";
import { REMOTE_PEERS_METHODS, remotePeerHostId } from "@codexhost/shared-contracts";
import { remoteWorkspaceId } from "../src/remote-workspaces.ts";

it("preserves default and explicitly selected native service tiers on the first remote turn", async () => {
  const target = { hostId: "host", cwd: "/project", epoch: "one" };
  const draft = new RemoteProjectDraft("workspace", "project", target, "Project");
  const call = async (op: RemoteSessionOperation) => {
    if (op.kind === "projectHarnesses") return [];
    assert.equal(op.kind, "inspectHarness");
    return {
      status: "ready",
      catalog: {
        defaultModel: { id: "native", serviceTier: "priority" },
        models: [
          {
            ref: { id: "native" },
            label: "Native",
            fastModel: { id: "native", serviceTier: "priority" },
            supportedThinkingOptionIds: ["low"],
          },
          {
            ref: { id: "native", serviceTier: "ultrafast" },
            label: "Ultrafast",
            supportedThinkingOptionIds: ["high"],
          },
        ],
        thinkingOptions: [
          { id: "low", label: "Low" },
          { id: "high", label: "High" },
        ],
      },
      capabilities: {
        configuration: {
          selectModel: true,
          selectThinkingOption: false,
          selectPermissionMode: false,
          permissionModeScope: "live",
        },
        history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
      },
    };
  };
  const start = { kind: "startSelected", ...target, model: "native", harnessId: "codex" };
  assert.deepEqual(await draft.startOperation(call), { ...start, serviceTier: "priority" });
  const row = (await draft.catalog(call)).groups[0]?.models[0];
  assert.ok(row?.ultrafastModel);
  await draft.select(
    { provider: "codex", model: row.ultrafastModel, reasoningEffort: "high" },
    call,
  );
  assert.deepEqual(await draft.startOperation(call), {
    ...start,
    serviceTier: "ultrafast",
    reasoningEffort: "high",
  });
});

it("qualifies identical peer projects and falls back to the peer ID for unnamed hosts", () => {
  const groups = remoteWorkspaceGroups(
    [
      {
        hostId: "remote-peer:one",
        online: true,
        color: "cyan" as const,
        projects: [{ id: "same", name: "same", path: "/same", threadIds: [] }],
      },
      {
        hostId: "remote-peer:two",
        online: true,
        projects: [{ id: "same", name: "same", path: "/same", threadIds: [] }],
      },
    ],
    [],
  );
  assert.deepEqual(
    groups.map((g) => g.remote?.displayName),
    ["one", "two"],
  );
  assert.deepEqual(
    groups.map((g) => g.remote?.color),
    ["cyan", undefined],
  );
  assert.notEqual(groups[0]?.workspaceId, groups[1]?.workspaceId);
});
it("separates identical remote project names and paths and keeps unmatched sessions visible", () => {
  const hosts = ["mac", "gateway"].map((name) => ({
    hostId: `remote-ssh-discovered:${name}`,
    displayName: name,
    online: name === "mac",
    projects: [{ id: "project", name: "playcodex", path: "/home/work", threadIds: [] }],
  }));
  const groups = remoteWorkspaceGroups(hosts, [
    {
      sessionId: "a",
      hostId: "remote-ssh-discovered:mac",
      threadId: "same",
      cwd: "/home/work/tree",
    },
    {
      sessionId: "b",
      hostId: "remote-ssh-discovered:gateway",
      threadId: "same",
      cwd: "/home/work",
    },
    { sessionId: "c", hostId: "remote-ssh-discovered:mac", threadId: "else", cwd: "/unregistered" },
  ]);
  assert.equal(new Set(groups.map((g) => g.workspaceId)).size, 3);
  assert.deepEqual(groups.flatMap((g) => g.sessionIds).sort(), ["a", "b", "c"]);
  assert.equal(groups.find((g) => g.sessionIds.includes("a"))?.remote?.displayName, "mac");
  assert.equal(groups.find((g) => g.sessionIds.includes("b"))?.remote?.state, "disconnected");
});
it("collects all remote pages into registered project groups, preserves offline rows and rejects local tools", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "remote-workspaces-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const workspaces = new Workspaces(new DataDir(dir), dir);
  workspaces.create(dir);
  let online = true;
  const pages: number[] = [];
  const remote = new RemoteSessions(
    new EventHub("projects"),
    async (op) => {
      if (op.kind === "hosts")
        return [
          {
            hostId: "remote-ssh-discovered:mac",
            displayName: "mac",
            online,
            state: online ? "connected" : "disconnected",
            projects: [{ id: "p", name: "playcodex", path: "/remote/project", threadIds: [] }],
          },
        ];
      if (op.kind !== "list") throw new Error("read-only catalog test");
      const offset = Number(op.cursor ?? 0);
      pages.push(offset);
      return {
        data: Array.from({ length: 100 }, (_, i) => ({
          id: String(offset + i),
          cwd: "/remote/project",
          modelProvider: "openai",
          createdAt: 1,
          updatedAt: 2,
          status: { type: "idle" },
        })),
        nextCursor: offset === 200 ? null : String(offset + 100),
      };
    },
    workspaces,
  );
  t.after(() => remote.close());
  await remote.refresh();
  assert.deepEqual(pages, [0, 100, 200]);
  const group = workspaces.list().find((g) => g.remote);
  assert.ok(group);
  assert.equal(group.sessionIds.length, 300);
  assert.equal(workspaces.list()[0]?.workspaceId, group.workspaceId);
  assert.throws(() => workspaces.get(group.workspaceId), /local workspace/);
  online = false;
  await remote.refresh();
  assert.equal(workspaces.list().find((g) => g.remote)?.sessionIds.length, 300);
  assert.equal(workspaces.list().find((g) => g.remote)?.remote?.state, "disconnected");
});

it("creates on the registered owner, publishes the real ID, and retains the unlisted Thread only while loaded", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "remote-create-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const workspaces = new Workspaces(new DataDir(dir), dir);
  const hostId = "remote-ssh-discovered:mac";
  // The project fits the Controller frame; the longer encoded Harness model does not.
  const project = {
    id: "center",
    name: "Center",
    path: "/remote/" + "界".repeat(5150),
    threadIds: [],
  };
  const longModel = "x".repeat(500);
  const host = {
    hostId,
    online: true,
    epoch: "one",
    projects: [{ ...project, id: "alias", name: "Alias" }, project],
  };
  const thread = {
    id: "real-id",
    cwd: project.path,
    createdAt: 1,
    updatedAt: 1,
    modelProvider: "openai",
    status: { type: "idle" },
  };
  const writes: unknown[] = [];
  const prompted = Promise.withResolvers<undefined>();
  const acknowledge = Promise.withResolvers<undefined>();
  let visibleInCatalog = false;
  const remote: RemoteSessions = new RemoteSessions(
    new EventHub("create"),
    async (op) => {
      if (op.kind === "hosts") return [host, { ...host, hostId: "remote-control:other" }];
      if (op.kind === "list")
        return {
          data: visibleInCatalog && op.hostId === hostId ? [{ ...thread, updatedAt: 2 }] : [],
          nextCursor: null,
          ...(op.includeLoaded ? { loaded: [thread.id], epoch: host.epoch } : {}),
        };
      if (op.kind === "projectHarnesses") return [{ id: "claude", name: "Claude Code" }];
      if (op.kind === "inspectHarness")
        return {
          status: "ready",
          catalog: {
            models: [
              { ref: { id: "standard" }, label: "Standard" },
              { ref: { id: longModel }, label: "Long" },
            ],
            thinkingOptions: [],
          },
          capabilities: {
            configuration: {
              selectModel: true,
              selectThinkingOption: false,
              selectPermissionMode: false,
              permissionModeScope: "live",
            },
            history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
          },
        };
      if (op.kind !== "startSelected" && op.kind !== "prompt")
        throw new Error("unexpected operation");
      writes.push(op);
      if (op.kind === "startSelected") {
        visibleInCatalog = true;
        await remote.refresh();
        visibleInCatalog = false;
      }
      if (op.kind === "prompt") {
        prompted.resolve(undefined);
        await acknowledge.promise;
      }
      return { thread };
    },
    workspaces,
  );
  t.after(() => remote.close());
  const rpc = new RpcRegistry();
  rpc.register("session/create", () => {
    throw new Error("unexpected local create");
  });
  remote.install(rpc, new StreamRegistry());
  await remote.refresh();
  const workspace = workspaces
    .list()
    .find((w) => w.remote?.hostId === hostId && w.title === project.name);
  assert.ok(workspace);
  const { workspaceId } = workspace;
  const create = (extra: Record<string, unknown> = {}) =>
    rpc.dispatch("session/create", { args: { request: { workspaceId, ...extra } } });
  const sessionId = remoteSessionId(hostId, thread.id);
  const opened = await create();
  assert.ok(opened.ok);
  const draftId = (opened.value as { sessionId: string }).sessionId;
  assert.notEqual(draftId, sessionId);
  const call = (method: string, request: Record<string, unknown>) =>
    rpc.dispatch(method, { args: { request: { sessionId: draftId, ...request } } });
  for (const method of [
    "session/list",
    "session/modelCatalog",
    "session/prompt",
    "session/selectModel",
    "session/projections",
  ])
    rpc.register(method, () => {
      throw new Error("local fallback");
    });
  assert.equal((await call("session/modelCatalog", {})).ok, true);
  assert.ok((await call("session/selectModel", { provider: "claude", model: longModel })).ok);
  const oversized = await call("session/prompt", { content: [{ type: "text", text: "ping" }] });
  assert.ok(!oversized.ok);
  assert.equal(oversized.error.code, "remote/too-large");
  assert.deepEqual(writes, []);
  assert.equal(
    (await call("session/selectModel", { provider: "claude", model: "standard" })).ok,
    true,
  );
  assert.equal(
    (await call("session/prompt", { content: [{ type: "text", text: " " }] })).ok,
    false,
  );
  assert.deepEqual(writes, []);
  assert.ok((await call("session/list", {})).ok);
  const withCursor = await call("session/list", { cursor: "next" });
  assert.ok(!withCursor.ok);
  assert.equal(withCursor.error.code, "session/list-invalid");
  assert.equal(
    (await call("session/prompt", { content: [{ type: "text", text: "界".repeat(5100) }] })).ok,
    false,
  );
  assert.deepEqual(writes, []);
  const prompt = { content: [{ type: "text", text: "ping" }], requestId: "first" };
  const sending = Promise.all([call("session/prompt", prompt), call("session/prompt", prompt)]);
  await prompted.promise;
  const duplicate = call("session/prompt", { ...prompt, sessionId });
  try {
    const second = await call("session/prompt", { ...prompt, sessionId, requestId: "second" });
    assert.ok(!second.ok);
    assert.equal(second.error.code, "session/busy");
  } finally {
    acknowledge.resolve(undefined);
  }
  assert.ok((await duplicate).ok);
  const sent = await sending;
  for (const reply of sent) assert.ok(reply.ok, JSON.stringify(reply));
  const direct = await call("session/list", {});
  assert.ok(direct.ok);
  assert.equal((direct.value as { items: { updatedAt: number }[] }).items[0]?.updatedAt, 2000);
  assert.deepEqual(
    (direct.value as { items: { sessionId: string }[] }).items.map((row) => row.sessionId),
    [sessionId],
  );
  assert.equal((await call("session/list", { cursor: "next" })).ok, false);
  const members = () =>
    workspaces
      .list()
      .filter((w) => w.sessionIds.includes(sessionId))
      .map((w) => w.workspaceId);
  assert.deepEqual(members(), [workspaceId]);
  await remote.refresh();
  assert.deepEqual(members(), [workspaceId]);
  assert.equal((await create({ cwd: "/unregistered" })).ok, false);
  assert.equal((await create({ workspaceId: "remote-workspace:unknown" })).ok, false);
  host.online = false;
  assert.equal((await create()).ok, false);
  assert.equal(writes.length, 2);
  assert.match(JSON.stringify(writes[0]), /codexhost\/plugin-v1@/);
  assert.deepEqual(writes[1], {
    kind: "prompt",
    hostId,
    threadId: thread.id,
    epoch: "one",
    text: "ping",
    requestId: "first",
  });
  host.online = true;
  host.epoch = "two";
  await remote.refresh();
  assert.deepEqual(members(), []);
  const reopened = new Workspaces(new DataDir(dir), dir);
  const rediscovered = new RemoteSessions(
    new EventHub("restart"),
    async (op) => {
      if (op.kind === "hosts") return [host];
      if (op.kind === "list") return { data: [thread], nextCursor: null };
      throw new Error("unexpected operation");
    },
    reopened,
  );
  t.after(() => rediscovered.close());
  await rediscovered.refresh();
  assert.deepEqual(
    reopened
      .list()
      .filter((w) => w.sessionIds.includes(sessionId))
      .map((w) => w.workspaceId),
    [workspaceId],
  );
});

it("persists mixed local and multi-remote displayOrder across reloads, offline reconnects, new items, and explicit removals", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "mixed-workspace-order-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const localDir1 = join(root, "local-1");
  const localDir2 = join(root, "local-2");
  const localDir3 = join(root, "local-3");
  mkdirSync(localDir1);
  mkdirSync(localDir2);
  mkdirSync(localDir3);

  const data = new DataDir(root);
  const workspaces = new Workspaces(data, root);
  const rpc = new RpcRegistry();
  const streams = new StreamRegistry();
  const attachFollower = (registry: StreamRegistry, target: unknown[]) => {
    let handler: StreamHandler | undefined;
    const orig = registry.register.bind(registry);
    registry.register = (endpoint, fn) => {
      if (endpoint === "workspace/follow") handler = fn;
      orig(endpoint, fn);
    };
    return () => {
      assert.ok(handler, "workspace/follow handler should be registered");
      void handler(
        {},
        {
          id: "test-stream",
          closed: false,
          push: (frame) => target.push(frame),
          end: () => {},
          fail: () => {},
          onClose: () => {},
        },
      );
    };
  };

  const frames: unknown[] = [];
  const openFollower = attachFollower(streams, frames);
  workspaces.register(rpc, streams);
  openFollower();

  const local1 = workspaces.create(localDir1).workspace;
  const local2 = workspaces.create(localDir2).workspace;

  const hostA = "remote-peer:peer-a";
  const hostB = "remote-peer:peer-b";
  const hostC = "remote-peer:peer-c";
  const makeRemote = (hostId: string, projectId: string, title: string) => ({
    workspaceId: remoteWorkspaceId(hostId, projectId),
    path: `/${title}`,
    title,
    sessionIds: [],
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    remote: { hostId, displayName: hostId.slice("remote-peer:".length), state: "connected" },
  });

  const remA1 = makeRemote(hostA, "a1", "rem-a1");
  const remA2 = makeRemote(hostA, "a2", "rem-a2");
  const remA3 = makeRemote(hostA, "a3", "rem-a3");
  const remB1 = makeRemote(hostB, "b1", "rem-b1");
  const remC1 = makeRemote(hostC, "c1", "rem-c1");

  // Backward compatible default order before any manual reorder: remotes first, then locals.
  workspaces.setRemoteGroups([remA1, remB1]);
  assert.deepEqual(
    workspaces.list().map((w) => w.workspaceId),
    [remA1.workspaceId, remB1.workspaceId, local1.workspaceId, local2.workspaceId],
  );

  // Unknown workspaceId is rejected with workspace/not-found.
  const unknownReply = await rpc.dispatch("workspace/insertBefore", {
    args: {
      request: { workspaceId: "remote-workspace:missing", beforeWorkspaceId: local1.workspaceId },
    },
  });
  assert.equal(unknownReply.ok, false);
  assert.equal(unknownReply.error.code, "workspace/not-found");

  // Interleave local1 before remA1, then remB1 between local2 and remA1 -> [local1, remA1, local2, remB1] -> wait:
  // Start: [remA1, remB1, local1, local2]
  // Move local1 before remA1 => [local1, remA1, remB1, local2]
  const move1 = await rpc.dispatch("workspace/insertBefore", {
    args: { request: { workspaceId: local1.workspaceId, beforeWorkspaceId: remA1.workspaceId } },
  });
  assert.ok(move1.ok);
  assert.deepEqual((move1.value as { workspaceIds: string[] }).workspaceIds, [
    local1.workspaceId,
    remA1.workspaceId,
    remB1.workspaceId,
    local2.workspaceId,
  ]);

  // Move local2 before remB1 => [local1, remA1, local2, remB1]
  const move2 = await rpc.dispatch("workspace/insertBefore", {
    args: { request: { workspaceId: local2.workspaceId, beforeWorkspaceId: remB1.workspaceId } },
  });
  assert.ok(move2.ok);
  assert.deepEqual(
    workspaces.list().map((w) => w.workspaceId),
    [local1.workspaceId, remA1.workspaceId, local2.workspaceId, remB1.workspaceId],
  );

  // Move local2 before local1 => also updates local state.items relative order to [local2, local1].
  const move3 = await rpc.dispatch("workspace/insertBefore", {
    args: { request: { workspaceId: local2.workspaceId, beforeWorkspaceId: local1.workspaceId } },
  });
  assert.ok(move3.ok);
  assert.deepEqual(
    workspaces.list().map((w) => w.workspaceId),
    [local2.workspaceId, local1.workspaceId, remA1.workspaceId, remB1.workspaceId],
  );

  // Reopen from disk and verify pure local order and mixed order both persist.
  const reopened = new Workspaces(data, root);
  assert.deepEqual(
    reopened.list().map((w) => w.workspaceId),
    [local2.workspaceId, local1.workspaceId],
    "pure local order stays consistent with displayOrder",
  );
  reopened.setRemoteGroups([remA1, remB1]);
  assert.deepEqual(
    reopened.list().map((w) => w.workspaceId),
    [local2.workspaceId, local1.workspaceId, remA1.workspaceId, remB1.workspaceId],
  );

  // Move remB1 between local2 and local1 => [local2, remB1, local1, remA1]
  const rpc2 = new RpcRegistry();
  const streams2 = new StreamRegistry();
  const frames2: unknown[] = [];
  const openFollower2 = attachFollower(streams2, frames2);
  reopened.register(rpc2, streams2);
  openFollower2();

  const move4 = await rpc2.dispatch("workspace/insertBefore", {
    args: { request: { workspaceId: remB1.workspaceId, beforeWorkspaceId: local1.workspaceId } },
  });
  assert.ok(move4.ok);
  assert.deepEqual(
    reopened.list().map((w) => w.workspaceId),
    [local2.workspaceId, remB1.workspaceId, local1.workspaceId, remA1.workspaceId],
  );

  // Peer B goes temporarily offline: remB1 disappears from visible list, NOT from displayOrder.
  reopened.setRemoteGroups([remA1]);
  assert.deepEqual(
    reopened.list().map((w) => w.workspaceId),
    [local2.workspaceId, local1.workspaceId, remA1.workspaceId],
  );

  // Reorder while Peer B is offline: move remA1 before local1 -> remB1 keeps its slot before local1.
  const moveWhileOffline = await rpc2.dispatch("workspace/insertBefore", {
    args: { request: { workspaceId: remA1.workspaceId, beforeWorkspaceId: local1.workspaceId } },
  });
  assert.ok(moveWhileOffline.ok);
  assert.deepEqual(
    reopened.list().map((w) => w.workspaceId),
    [local2.workspaceId, remA1.workspaceId, local1.workspaceId],
  );

  // Peer B reconnects -> remB1 returns to its saved slot right after local2, and an order frame broadcasts.
  frames2.length = 0;
  reopened.setRemoteGroups([remA1, remB1]);
  assert.deepEqual(
    reopened.list().map((w) => w.workspaceId),
    [local2.workspaceId, remB1.workspaceId, remA1.workspaceId, local1.workspaceId],
  );
  const lastOrderFrame = [...frames2]
    .reverse()
    .find(
      (frame): frame is { type: "order"; workspaceIds: string[] } =>
        (frame as { type?: string }).type === "order",
    );
  assert.deepEqual(lastOrderFrame?.workspaceIds, [
    local2.workspaceId,
    remB1.workspaceId,
    remA1.workspaceId,
    local1.workspaceId,
  ]);

  // New remote workspaces on existing host A slot right after remA1 in relative order;
  // brand-new host C appends to the tail without displacing pinned local2.
  reopened.setRemoteGroups([remA1, remA2, remA3, remB1, remC1]);
  assert.deepEqual(
    reopened.list().map((w) => w.workspaceId),
    [
      local2.workspaceId,
      remB1.workspaceId,
      remA1.workspaceId,
      remA2.workspaceId,
      remA3.workspaceId,
      local1.workspaceId,
      remC1.workspaceId,
    ],
  );

  // Creating a new local workspace records it at the end of displayOrder, broadcasts the full
  // mixed order, and matches the order after reloading from disk.
  frames2.length = 0;
  const local3 = reopened.create(localDir3).workspace;
  const expectedAfterCreate = [
    local2.workspaceId,
    remB1.workspaceId,
    remA1.workspaceId,
    remA2.workspaceId,
    remA3.workspaceId,
    local1.workspaceId,
    local3.workspaceId,
    remC1.workspaceId,
  ];
  assert.deepEqual(
    reopened.list().map((w) => w.workspaceId),
    expectedAfterCreate,
  );
  const createOrderFrame = [...frames2]
    .reverse()
    .find(
      (frame): frame is { type: "order"; workspaceIds: string[] } =>
        (frame as { type?: string }).type === "order",
    );
  assert.deepEqual(createOrderFrame?.workspaceIds, expectedAfterCreate);
  const reopenedAfterCreate = new Workspaces(data, root);
  reopenedAfterCreate.setRemoteGroups([remA1, remA2, remA3, remB1, remC1]);
  assert.deepEqual(
    reopenedAfterCreate.list().map((w) => w.workspaceId),
    expectedAfterCreate,
  );

  // Deleting a local workspace removes it from persisted displayOrder.
  const delReply = await rpc2.dispatch("workspace/delete", {
    args: { request: { workspaceId: local1.workspaceId } },
  });
  assert.ok(delReply.ok);
  const savedAfterDelete = data.readJson<{ displayOrder?: string[] }>("workspaces.json", {});
  assert.equal(savedAfterDelete.displayOrder?.includes(local1.workspaceId), false);

  // Permanent peer removal cleans displayOrder for that host only.
  reopened.removeRemoteHostOrder(hostB);
  const savedAfterPeerRemove = data.readJson<{ displayOrder?: string[] }>("workspaces.json", {});
  assert.equal(savedAfterPeerRemove.displayOrder?.includes(remB1.workspaceId), false);
  assert.equal(savedAfterPeerRemove.displayOrder?.includes(remA1.workspaceId), true);
  assert.equal(savedAfterPeerRemove.displayOrder?.includes(local2.workspaceId), true);
});

it("PeerHostManager invokes onPeerRemoved only on permanent remove, not disable", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "peer-remove-order-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const data = new DataDir(root);
  const peerId = "peer-alpha";
  const hostId = remotePeerHostId(peerId);
  const store = new PeerHostStore(data);
  store.save([
    {
      peerId,
      name: "alpha",
      origin: "http://127.0.0.1:49999",
      token: "secret-token",
      enabled: true,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    },
  ]);

  const localDir = join(root, "local-dir");
  mkdirSync(localDir);
  const workspaces = new Workspaces(data, root);
  const rpc = new RpcRegistry();
  workspaces.register(rpc, new StreamRegistry());
  const local = workspaces.create(localDir).workspace;
  const rem = {
    workspaceId: remoteWorkspaceId(hostId, "p1"),
    path: "/p1",
    title: "p1",
    sessionIds: [],
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    remote: { hostId, displayName: "alpha", state: "connected" },
  };
  workspaces.setRemoteGroups([rem]);
  assert.ok(
    (
      await rpc.dispatch("workspace/insertBefore", {
        args: { request: { workspaceId: local.workspaceId, beforeWorkspaceId: rem.workspaceId } },
      })
    ).ok,
  );

  const manager = new PeerHostManager(store, async () => [], new EventHub("peers"), {
    allowLoopback: true,
  });
  t.after(() => manager.close());
  const removedHosts: string[] = [];
  manager.onPeerRemoved = (removedHostId) => {
    removedHosts.push(removedHostId);
    workspaces.removeRemoteHostOrder(removedHostId);
  };
  manager.register(rpc);

  const auth = { credential: "local", local: true };
  // Disabling a peer preserves displayOrder entries.
  const disabled = await rpc.dispatch(
    REMOTE_PEERS_METHODS.update,
    { args: { request: { peerId, enabled: false } } },
    auth,
  );
  assert.ok(disabled.ok);
  assert.deepEqual(removedHosts, []);
  assert.equal(
    data
      .readJson<{ displayOrder?: string[] }>("workspaces.json", {})
      .displayOrder?.includes(rem.workspaceId),
    true,
  );

  // Removing a peer triggers onPeerRemoved and strips its entries from displayOrder.
  const removed = await rpc.dispatch(
    REMOTE_PEERS_METHODS.remove,
    { args: { request: { peerId } } },
    auth,
  );
  assert.ok(removed.ok);
  assert.deepEqual(removedHosts, [hostId]);
  assert.equal(
    data
      .readJson<{ displayOrder?: string[] }>("workspaces.json", {})
      .displayOrder?.includes(rem.workspaceId),
    false,
  );
});
