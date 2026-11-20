import assert from "node:assert/strict";
import { it } from "node:test";
import { remoteWorkspaceGroups } from "../src/remote-workspaces.ts";
import { RemoteSessions, remoteSessionId } from "../src/remote-sessions.ts";
import { Workspaces } from "../src/workspaces.ts";
import { DataDir } from "../src/store.ts";
import { EventHub, RpcRegistry, StreamRegistry } from "../src/transport.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  const project = { id: "center", name: "Center", path: "/remote/center", threadIds: [] };
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
  const remote = new RemoteSessions(
    new EventHub("create"),
    async (op) => {
      if (op.kind === "hosts") return [host, { ...host, hostId: "remote-control:other" }];
      if (op.kind === "list")
        return {
          data: [],
          nextCursor: null,
          ...(op.includeLoaded ? { loaded: [thread.id], epoch: host.epoch } : {}),
        };
      if (op.kind !== "create") throw new Error("unexpected operation");
      writes.push(op);
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
  assert.deepEqual(await create(), { ok: true, value: { sessionId, agentPreset: "standard" } });
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
  assert.deepEqual(writes, [{ kind: "create", hostId, epoch: "one", cwd: project.path }]);
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
