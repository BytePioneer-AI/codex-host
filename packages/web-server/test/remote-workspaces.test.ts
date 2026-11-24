import assert from "node:assert/strict";
import { it } from "node:test";
import { remoteWorkspaceGroups } from "../src/remote-workspaces.ts";
import { RemoteSessions, remoteSessionId } from "../src/remote-sessions.ts";
import { RemoteProjectDraft } from "../src/remote-project-draft.ts";
import { type RemoteSessionOperation } from "@codexhost/shared-contracts";
import { Workspaces } from "../src/workspaces.ts";
import { DataDir } from "../src/store.ts";
import { EventHub, RpcRegistry, StreamRegistry } from "../src/transport.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
