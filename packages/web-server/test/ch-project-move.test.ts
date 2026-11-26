import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { setImmediate as immediate } from "node:timers/promises";
import {
  CLIENT_THREAD_PROJECT_MOVE_METHOD,
  THREAD_SECTION_CAPABILITY,
} from "@codexhost/shared-contracts";
import { createChHostClient, DesktopChHostClient } from "../src/ch-host-client.ts";
import { ChSessions } from "../src/ch-sessions.ts";
import { RemoteSessions, remoteSessionId } from "../src/remote-sessions.ts";
import { DataDir } from "../src/store.ts";
import {
  EventHub,
  RpcError,
  RpcRegistry,
  StreamRegistry,
  type StreamHandler,
} from "../src/transport.ts";
import { Workspaces, type WorkspaceView } from "../src/workspaces.ts";
import { FakeChChannel, startFakeChChannel } from "./support/ch-channel.ts";
import { FakeChHost } from "./support/ch-host.ts";

function setup(t: TestContext, host: FakeChHost) {
  const root = mkdtempSync(join(tmpdir(), "ch-project-move-"));
  const row = host.add("moving", join(root, "source"));
  host.projectSnapshot.projects.push({
    id: "target",
    name: "Target",
    rootPaths: [join(root, "target"), join(root, "second-root")],
  });
  const workspaces = new Workspaces(new DataDir(root), root);
  const events = new EventHub(root);
  const sessions = new ChSessions(host, workspaces, events);
  const rpc = new RpcRegistry();
  const follow = new Map<string, StreamHandler>();
  class TestStreams extends StreamRegistry {
    override register(name: string, handler: StreamHandler): void {
      super.register(name, handler);
      follow.set(name, handler);
    }
  }
  const streams = new TestStreams();
  workspaces.register(rpc, streams);
  sessions.register(rpc, streams);
  t.after(async () => {
    await sessions.close();
    rmSync(root, { recursive: true, force: true });
  });
  const call = (method: string, request: object = {}) =>
    rpc.dispatch(method, { args: { request } });
  async function subscribe(name: string, args: Record<string, unknown>) {
    const handler = follow.get(name);
    assert.ok(handler);
    const frames: unknown[] = [];
    await handler(args, {
      id: name,
      closed: false,
      push: (frame) => frames.push(frame),
      end: () => {},
      fail: (code, message) => assert.fail(`${code}: ${message}`),
      onClose: (close) => t.after(close),
    });
    return frames;
  }
  return {
    root,
    row,
    workspaces,
    events,
    rpc,
    streams,
    call,
    list: () => call("session/list"),
    move: (sessionId = row.id) =>
      call("workspace/moveSessionToProject", { sessionId, projectId: "target" }),
    subscribe,
  };
}

function memberships(frames: unknown[], sessionId: string) {
  return (frames as Array<{ type: string; workspace?: WorkspaceView }>).flatMap((frame) =>
    frame.type === "upsert" && frame.workspace?.sessionIds.includes(sessionId)
      ? [frame.workspace.path]
      : [],
  );
}

function baselineProjects(frame: unknown): unknown {
  assert.ok(frame && typeof frame === "object" && "value" in frame);
  const { value } = frame;
  assert.ok(value && typeof value === "object" && "localProjects" in value);
  return value.localProjects;
}

it("drains old catalog reads before broadcasting a project move", { timeout: 5000 }, async (t) => {
  const host = new FakeChHost();
  const { row, root, workspaces, list, move, subscribe } = setup(t, host);
  host.projectSnapshot.sectionProjects = { research: ["target"] };
  const target = host.projectSnapshot.projects.find(({ id }) => id === "target");
  assert.ok(target);
  target.name = "source";
  const entered = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  const written = Promise.withResolvers<undefined>();
  const projects = host.projects.bind(host);
  let block = false;
  host.projects = async (ids?: string[]) => {
    const snapshot = await projects();
    if (block && ids?.includes(row.id)) {
      block = false;
      entered.resolve(undefined);
      await release.promise;
    }
    return snapshot;
  };
  const confirmed = { status: "confirmed", projectId: "target" };
  const request = host.request.bind(host);
  let writes = 0;
  host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
    if (method === "codexhost/thread/sections/list")
      return {
        sections: [{ id: "research", name: "Research", threads: [row], appearance: null }],
        [THREAD_SECTION_CAPABILITY]: true,
      } as T;
    if (method !== CLIENT_THREAD_PROJECT_MOVE_METHOD) return request<T>(method, params);
    assert.deepEqual(params, { threadId: row.id, projectId: "target" });
    writes++;
    host.projectSnapshot.assignments[row.id] = "target";
    written.resolve(undefined);
    return confirmed as T;
  };
  assert.ok((await list()).ok);
  assert.equal(workspaces.ownerOf(row.id)?.path, row.cwd);
  const capable = await subscribe("workspace/follow", { [THREAD_SECTION_CAPABILITY]: true });
  const legacy = await subscribe("workspace/follow", {});
  block = true;
  const older = list();
  await entered.promise;
  const moved = move();
  await written.promise;
  assert.equal(workspaces.ownerOf(row.id)?.path, row.cwd);
  assert.equal(capable.length, 1);
  release.resolve(undefined);
  assert.ok((await older).ok);
  assert.deepEqual(await moved, { ok: true, value: confirmed });
  assert.equal(writes, 1);
  assert.equal(workspaces.ownerOf(row.id)?.path, join(root, "target"));
  assert.equal(row.cwd, join(root, "source"));
  assert.deepEqual(memberships(capable, row.id), [join(root, "target")]);
  assert.deepEqual(memberships(legacy, row.id), [join(root, "target")]);
  const source = workspaces.byPath(row.cwd);
  const primary = workspaces.byPath(join(root, "target"));
  const secondary = workspaces.byPath(join(root, "second-root"));
  assert.ok(source && primary && secondary);
  const owner = {
    id: "project-moving",
    name: "source",
    workspaceIds: [source.workspaceId],
  };
  const destination = {
    id: "target",
    name: "source",
    workspaceIds: [primary.workspaceId, secondary.workspaceId],
  };
  const before = [
    { ...owner, sessionIds: [row.id] },
    { ...destination, sessionIds: [] },
  ];
  const after = [
    { ...owner, sessionIds: [] },
    { ...destination, sessionIds: [row.id] },
  ];
  for (const frames of [capable, legacy]) {
    assert.deepEqual(baselineProjects(frames[0]), before);
    const typed = frames as Array<{ type: string }>;
    assert.deepEqual(
      typed.map(({ type }) => type),
      ["baseline", "upsert", "upsert", "localProjects"],
    );
    assert.deepEqual(frames.at(-1), { type: "localProjects", localProjects: after });
  }
  const baseline = capable[0] as { value: { threadSections: unknown } };
  assert.deepEqual(baseline.value.threadSections, [
    {
      id: "research",
      name: "Research",
      appearance: null,
      threadIds: [row.id],
      workspaceIds: [
        workspaces.byPath(join(root, "target"))?.workspaceId,
        workspaces.byPath(join(root, "second-root"))?.workspaceId,
      ],
    },
  ]);
});

it("uses the native project's ID and binding even when the catalog row still names the old project", async (t) => {
  const host = new FakeChHost();
  const { row, workspaces, list, move, subscribe } = setup(t, host);
  host.projectSnapshot.nativeProjects = true;
  row.projectId = "project-moving";
  const request = host.request.bind(host);
  host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
    if (method !== CLIENT_THREAD_PROJECT_MOVE_METHOD) return request<T>(method, params);
    host.projectSnapshot.assignments[row.id] = "target";
    return { status: "confirmed", projectId: "target" } as T;
  };

  assert.ok((await list()).ok);
  assert.equal(workspaces.ownerOf(row.id)?.projectId, "project-moving");
  assert.deepEqual(await move(), { ok: true, value: { status: "confirmed", projectId: "target" } });
  const target = workspaces.ownerOf(row.id);
  const source = workspaces.list().find(({ projectId }) => projectId === "project-moving");
  assert.equal(target?.projectId, "target");
  assert.deepEqual(baselineProjects((await subscribe("workspace/follow", {}))[0]), [
    { id: "project-moving", name: "source", sessionIds: [], workspaceIds: [source?.workspaceId] },
    { id: "target", name: "Target", sessionIds: [row.id], workspaceIds: [target?.workspaceId] },
  ]);
});

for (const nativeProjects of [false, true]) {
  it(`keeps a cleared Thread out of projects on refresh (nativeProjects=${nativeProjects})`, async (t) => {
    const host = new FakeChHost();
    const { row, workspaces, call, list, subscribe } = setup(t, host);
    host.projectSnapshot.nativeProjects = nativeProjects;
    row.projectId = "project-moving"; // Catalog can still name the old project.
    const request = host.request.bind(host);
    let writes = 0;
    host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
      if (method !== CLIENT_THREAD_PROJECT_MOVE_METHOD) return request<T>(method, params);
      assert.deepEqual(params, { threadId: row.id, projectId: null });
      writes++;
      delete host.projectSnapshot.assignments[row.id];
      host.projectSnapshot.projectless.push(row.id);
      return { status: "unknown" } as T;
    };
    const cwd = row.cwd;
    assert.ok((await list()).ok);
    assert.equal(workspaces.ownerOf(row.id)?.path, cwd);
    assert.deepEqual(
      await call("workspace/moveSessionToProject", { sessionId: row.id, projectId: null }),
      { ok: true, value: { status: "unknown" } },
    );
    for (let i = 0; i < 2; i++) {
      assert.ok((await list()).ok);
      assert.equal(workspaces.ownerOf(row.id), undefined);
      const [baseline] = (await subscribe("workspace/follow", {})) as Array<{
        value: { projectlessSessionIds: string[] };
      }>;
      assert.deepEqual(baseline?.value.projectlessSessionIds, [row.id]);
    }
    assert.equal(writes, 1);
    assert.equal(row.cwd, cwd);
  });
}

it("publishes empty and shared-root projects with only explicit local membership", async (t) => {
  const host = new FakeChHost();
  const { row, root, call, list, move, subscribe, workspaces } = setup(t, host);
  const target = host.projectSnapshot.projects.find(({ id }) => id === "target");
  assert.ok(target);
  target.rootPaths = [row.cwd];
  host.add("cwd-match", row.cwd, "Unassigned", false);
  // Keep the existing cwd-based navigation fallback active for this row.
  host.projectSnapshot.projectless = [];
  host.projectSnapshot.assignments["not-loaded"] = "target";
  const request = host.request.bind(host);
  host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
    if (method !== CLIENT_THREAD_PROJECT_MOVE_METHOD) return request<T>(method, params);
    host.projectSnapshot.assignments[row.id] = "target";
    return { status: "confirmed", projectId: "target" } as T;
  };
  assert.ok((await call("session/create", { sessionId: "draft-new", cwd: root })).ok);
  assert.ok((await list()).ok);
  assert.equal(workspaces.ownerOf("cwd-match")?.path, row.cwd);
  assert.equal((await move("cwd-match")).ok, false);
  const frames = await subscribe("workspace/follow", {});
  assert.deepEqual(baselineProjects(frames[0]), [
    { id: "project-moving", name: "source", sessionIds: [row.id], workspaceIds: [] },
    { id: "target", name: "Target", sessionIds: [], workspaceIds: [] },
  ]);
  assert.deepEqual(await move(), { ok: true, value: { status: "confirmed", projectId: "target" } });
  assert.deepEqual(frames.slice(1), [
    {
      type: "localProjects",
      localProjects: [
        { id: "project-moving", name: "source", sessionIds: [], workspaceIds: [] },
        { id: "target", name: "Target", sessionIds: [row.id], workspaceIds: [] },
      ],
    },
  ]);
  assert.ok((await list()).ok);
  assert.equal(frames.length, 2);
  host.threads.delete(row.id);
  assert.ok((await list()).ok);
  assert.deepEqual(baselineProjects((await subscribe("workspace/follow", {}))[0]), [
    { id: "project-moving", name: "source", sessionIds: [], workspaceIds: [] },
    { id: "target", name: "Target", sessionIds: [], workspaceIds: [] },
  ]);
  assert.equal((await move()).ok, false);
  host.projectSnapshot.projects.length = 0;
  assert.ok((await list()).ok);
  assert.deepEqual(frames.at(-1), { type: "localProjects", localProjects: [] });
  assert.equal((await move()).ok, false);
  assert.deepEqual(baselineProjects((await subscribe("workspace/follow", {}))[0]), []);
});

it("updates project bindings when a local root Workspace row is removed or recreated", async (t) => {
  const { root, workspaces, list, call, subscribe } = setup(t, new FakeChHost());
  workspaces.setRemoteGroups([
    {
      workspaceId: "peer-project",
      path: join(root, "target"),
      title: "Target",
      sessionIds: [],
      remote: { hostId: "peer", displayName: "Peer", state: "online" },
      createdAt: "",
      updatedAt: "",
    },
  ]);
  assert.ok((await list()).ok);
  const targetPath = join(root, "target");
  const source = workspaces.byPath(join(root, "source"));
  const primary = workspaces.byPath(targetPath);
  const secondary = workspaces.byPath(join(root, "second-root"));
  assert.ok(source && primary && secondary);
  const frames = await subscribe("workspace/follow", {});
  const targetFrame = (workspaceIds: string[]) => ({
    type: "localProjects",
    localProjects: [
      {
        id: "project-moving",
        name: "source",
        sessionIds: ["moving"],
        workspaceIds: [source.workspaceId],
      },
      { id: "target", name: "Target", sessionIds: [], workspaceIds },
    ],
  });
  assert.ok((await call("workspace/delete", { workspaceId: primary.workspaceId })).ok);
  assert.deepEqual(frames.slice(1), [
    { type: "remove", workspaceId: primary.workspaceId },
    targetFrame([secondary.workspaceId]),
  ]);
  mkdirSync(targetPath);
  assert.ok((await call("workspace/create", { path: targetPath })).ok);
  const current = workspaces.byPath(targetPath);
  assert.ok(current);
  assert.notEqual(current.workspaceId, primary.workspaceId);
  const expected = targetFrame([current.workspaceId, secondary.workspaceId]);
  assert.deepEqual(frames.at(-1), expected);
  assert.deepEqual(
    baselineProjects((await subscribe("workspace/follow", {}))[0]),
    expected.localProjects,
  );
});

it("validates the local Thread and request before sending any Host move or remote call", async (t) => {
  const host = new FakeChHost();
  const { row, root, events, rpc, streams, call, list, move, subscribe } = setup(t, host);
  host.add("child", row.cwd, "Child", false).parentThreadId = row.id;
  host.add("tree-child", row.cwd, "Tree child", false);
  host.add("pinned", row.cwd, "Pinned", false);
  host.add("archived", row.cwd, "Archived", false);
  host.add("read-only", row.cwd, "Read only", false).canAcceptDirectInput = false;
  host.add("legacy-assignment", row.cwd);
  host.add("unknown-projectless", row.cwd, "Legacy projectless", false);
  host.add("recent", row.cwd, "Confirmed projectless", false);
  host.projectSnapshot.projectMoveBindings = {
    projectIds: ["project-moving", "target"],
    assignments: {
      [row.id]: "project-moving",
      child: null,
      "tree-child": null,
      "read-only": "project-moving",
      archived: "project-moving",
      pinned: "project-moving",
      recent: null,
    },
  };
  host.pinnedIds.push("pinned");
  host.archivedIds.add("archived");
  const request = host.request.bind(host);
  host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> =>
    method === "codexhost/thread/tree/read"
      ? ({ parents: { "tree-child": row.id } } as T)
      : request<T>(method, params);
  assert.ok((await list()).ok);
  assert.ok((await call("session/create", { sessionId: "draft-new", cwd: root })).ok);
  let remoteCalls = 0;
  const remote = new RemoteSessions(events, async () => {
    remoteCalls++;
  });
  remote.install(rpc, streams);
  t.after(() => remote.close());
  const denied = async (
    result: Promise<{ ok: boolean; error?: { code: string } }>,
    code: string,
  ) => {
    const reply = await result;
    assert.equal(reply.ok, false);
    assert.equal(reply.error?.code, code);
  };
  for (const id of [
    "draft-new",
    "child",
    "tree-child",
    "archived",
    "pinned",
    "read-only",
    "legacy-assignment",
    "unknown-projectless",
    "missing",
    remoteSessionId("peer", row.id),
  ])
    await denied(move(id), "workspace/project-unavailable");
  await denied(move("web-remote:bad"), "remote/identity-invalid");
  await denied(
    call("workspace/moveSessionToProject", {
      sessionId: row.id,
      projectId: "project-legacy-assignment",
    }),
    "workspace/project-unavailable",
  );
  for (const params of [
    { sessionId: row.id, projectId: "" },
    { sessionId: row.id },
    { sessionId: row.id, projectId: "target", cwd: root },
    {
      sessionId: row.id,
      projectId: "target",
      address: { sessionId: remoteSessionId("peer", row.id) },
    },
    { threadId: row.id, projectId: "target" },
  ])
    await denied(call("workspace/moveSessionToProject", params), "workspace/project-invalid");
  assert.equal(remoteCalls, 0);
  assert.ok(!host.requests.some(({ method }) => method === CLIENT_THREAD_PROJECT_MOVE_METHOD));
  const [baseline] = (await subscribe("workspace/follow", {})) as Array<{
    value: { projectlessSessionIds: string[] };
  }>;
  assert.ok(baseline);
  assert.ok(baseline.value.projectlessSessionIds.includes("recent"));
  assert.ok(!baseline.value.projectlessSessionIds.includes("unknown-projectless"));
  let moved: unknown;
  host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
    if (method !== CLIENT_THREAD_PROJECT_MOVE_METHOD) return request<T>(method, params);
    moved = params;
    return { status: "confirmed", projectId: "target" } as T;
  };
  assert.deepEqual(await move("recent"), {
    ok: true,
    value: { status: "confirmed", projectId: "target" },
  });
  assert.deepEqual(moved, { threadId: "recent", projectId: "target" });

  const legacy = structuredClone(host.projectSnapshot);
  delete legacy.projectMoveBindings;
  host.projects = async () => legacy;
  assert.ok((await list()).ok);
  assert.deepEqual(baselineProjects((await subscribe("workspace/follow", {}))[0]), []);
  await denied(move(), "workspace/project-unavailable");
});

it("reconciles unknown outcomes without retries or inferring success", async (t) => {
  const host = new FakeChHost();
  const { row, root, workspaces, list, move } = setup(t, host);
  const projects = host.projects.bind(host);
  let reads = 0;
  host.projects = async () => {
    reads++;
    return projects();
  };
  const request = host.request.bind(host);
  let writes = 0;
  const rejection = new RpcError("host/rejected", "Target project no longer exists", {
    hostCode: -32602,
  });
  let error: RpcError | undefined = rejection;
  let reply: unknown;
  host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
    if (method !== CLIENT_THREAD_PROJECT_MOVE_METHOD) return request<T>(method, params);
    writes++;
    if (error) throw error;
    return reply as T;
  };
  assert.ok((await list()).ok);
  const baseline = reads;
  assert.deepEqual(await move(), {
    ok: false,
    error: { code: rejection.code, message: rejection.message, details: rejection.details },
  });
  assert.equal(reads, baseline);
  assert.equal(workspaces.ownerOf(row.id)?.path, row.cwd);
  const ambiguous: Array<{ reply?: unknown; error?: RpcError }> = [
    { reply: { status: "unknown" } },
    { reply: { status: "confirmed", projectId: "other-project" } },
    { reply: { status: "confirmed", projectId: "target", cwd: row.cwd } },
    { error: new RpcError("host/rejected", "Missing result") },
    { error: new RpcError("host/rejected", "Invalid error", { hostCode: -32603 }) },
    { error: new RpcError("host/rejected", "Channel lost", { hostCode: -32093 }) },
    { error: new RpcError("host/resync", "Obsolete reply", { hostCode: -32094 }) },
    { error: new RpcError("host/disconnected", "Connection lost") },
  ];
  host.projectSnapshot.assignments[row.id] = "target";
  for (const outcome of ambiguous) {
    ({ error, reply } = outcome);
    assert.deepEqual(await move(), { ok: true, value: { status: "unknown" } });
    assert.equal(workspaces.ownerOf(row.id)?.path, join(root, "target"));
  }
  assert.equal(reads, baseline + ambiguous.length);
  assert.equal(writes, 1 + ambiguous.length);
  error = undefined;
  reply = { status: "confirmed", projectId: "target" };
  host.projects = async () => {
    throw new Error("Lost workspace read");
  };
  assert.deepEqual(await move(), { ok: true, value: reply });
  assert.equal((await move()).ok, false, "A failed read cannot authorize another write.");
  assert.equal(writes, 2 + ambiguous.length);
});

it("coalesces project and section changes, rejecting late reads", { timeout: 5000 }, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const host = new FakeChChannel();
  host.online = false;
  const { root, row, list, move, subscribe, workspaces } = setup(t, host);
  let sectionName = "Initial";
  const request = host.request.bind(host);
  host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> =>
    method === "codexhost/thread/sections/list"
      ? ({ sections: [{ id: "section", name: sectionName, threads: [row] }] } as T)
      : request<T>(method, params);
  host.online = true;
  for (const listener of host.listeners) listener({ type: "connection", online: true });
  assert.ok((await list()).ok);
  await subscribe("session/follow", { address: { sessionId: row.id } });
  const workspace = await subscribe("workspace/follow", {});
  await immediate();
  const snapshots = host.snapshots;
  const projects = host.projects.bind(host);
  const entered = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  let projectReads = 0;
  host.projects = async (ids?: string[]) => {
    const snapshot = await projects();
    if (ids?.includes(row.id) && ++projectReads === 1) {
      entered.resolve(undefined);
      await release.promise;
    }
    return snapshot;
  };
  sectionName = "Obsolete";
  host.projectSnapshot.projects.push({
    id: "obsolete",
    name: "Obsolete",
    rootPaths: [join(root, "obsolete")],
  });
  host.projectSnapshot.assignments[row.id] = "obsolete";
  const older = list();
  await entered.promise;
  sectionName = "Current";
  host.projectSnapshot.projects.pop();
  host.projectSnapshot.assignments[row.id] = "target";
  host.changed(row.id, "thread/project/updated");
  for (const listener of host.listeners)
    listener({
      type: "sections-changed",
      cursor: { epoch: host.epoch, sequence: ++host.sequence },
    });
  assert.equal((await move()).ok, false, "A pending invalidation retires the source binding.");
  t.mock.timers.tick(100);
  release.resolve(undefined);
  assert.ok((await older).ok);
  await immediate();
  assert.equal(projectReads, 2);
  assert.equal(host.snapshots, snapshots);
  assert.equal(workspaces.ownerOf(row.id)?.path, join(root, "target"));
  assert.deepEqual(memberships(workspace, row.id), [join(root, "target")]);
  assert.deepEqual(workspace.at(-1), {
    type: "threadSections",
    threadSections: [{ id: "section", name: "Current", threadIds: [row.id] }],
  });
  assert.ok(!JSON.stringify(workspace).includes("Obsolete"));
});

it(
  "discards a catalog batch superseded while loading its summaries",
  { timeout: 5000 },
  async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const host = new FakeChChannel();
    const { root, row, events, list, subscribe, workspaces } = setup(t, host);
    host.threads.delete(row.id);
    assert.ok((await list()).ok);
    const workspace = await subscribe("workspace/follow", {});
    const addedAt: Array<string | undefined> = [];
    events.emit = (event) => {
      if (event === "api-session/added") addedAt.push(workspaces.ownerOf(row.id)?.path);
    };

    const entered = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const request = host.request.bind(host);
    host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
      if (method === "codexhost/harness/plugins/list") {
        entered.resolve(undefined);
        await release.promise;
      }
      return request<T>(method, params);
    };
    host.threads.set(row.id, row);
    const older = list();
    await entered.promise;
    host.projectSnapshot.assignments[row.id] = "target";
    host.changed(row.id, "thread/project/updated");
    release.resolve(undefined);

    assert.ok((await older).ok);
    const target = join(root, "target");
    assert.deepEqual(addedAt, [target]);
    assert.deepEqual(memberships(workspace, row.id), [target]);
  },
);

it("keeps a concurrent direct-link Thread without restoring a removed catalog row", async (t) => {
  const host = new FakeChHost();
  const { root, row, call, list, workspaces } = setup(t, host);
  host.projectSnapshot.nativeProjects = true;
  assert.ok((await list()).ok);
  assert.ok(workspaces.ownerOf(row.id));
  host.threads.delete(row.id);

  const entered = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  const projects = host.projects.bind(host);
  t.mock.method(host, "projects", async () => {
    const snapshot = await projects();
    entered.resolve(undefined);
    await release.promise;
    return snapshot;
  });
  const refreshing = list();
  const cwd = join(root, "target");
  try {
    await entered.promise;
    const linked = host.add("direct-link", cwd, "Direct link", false);
    assert.ok((await call("session/list", { sessionId: linked.id })).ok);
  } finally {
    release.resolve(undefined);
  }
  assert.ok((await refreshing).ok);
  assert.equal(workspaces.ownerOf("direct-link")?.path, cwd);
  assert.equal(workspaces.ownerOf(row.id), undefined);
});

it("does not remove a draft's canonical Thread when an older catalog publishes", async (t) => {
  const host = new FakeChHost();
  const { events, call, list } = setup(t, host);
  assert.ok((await list()).ok);
  const emitted = t.mock.method(events, "emit");
  const draft = await call("session/create");
  assert.ok(draft.ok);
  const { sessionId } = draft.value as { sessionId: string };
  const entered = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  const projects = host.projects.bind(host);
  t.mock.method(host, "projects", async () => {
    const snapshot = await projects();
    entered.resolve(undefined);
    await release.promise;
    return snapshot;
  });
  const refreshing = list();
  try {
    await entered.promise;
    const sent = await call("session/prompt", {
      sessionId,
      content: [{ type: "text", text: "Start a Thread" }],
    });
    assert.ok(sent.ok, sent.ok ? undefined : sent.error.message);
  } finally {
    release.resolve(undefined);
  }
  assert.ok((await refreshing).ok);
  const lifecycle = emitted.mock.calls.map(({ arguments: args }) => args);
  const bound = lifecycle.find(
    ([event, id]) => event === "codexhost/session-bound" && id === sessionId,
  );
  assert.ok(bound);
  assert.ok(!lifecycle.some(([event, id]) => event === "api-session/removed" && id === bound[2]));
});

it("does not keep an official Thread deleted while its catalog batch was in flight", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const host = new FakeChChannel();
  t.mock.method(host, "threadOwnership", (threadId: string) => ({ threadId, owner: "codex" }));
  const { row, list, workspaces } = setup(t, host);
  host.projectSnapshot.nativeProjects = true;
  row.modelProvider = "openai";
  assert.ok((await list()).ok);
  assert.ok(workspaces.ownerOf(row.id));

  const entered = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  const projects = host.projects.bind(host);
  t.mock.method(host, "projects", async () => {
    const snapshot = await projects();
    entered.resolve(undefined);
    await release.promise;
    return snapshot;
  });
  const refreshing = list();
  await entered.promise;
  host.threads.delete(row.id);
  host.changed(row.id, "thread/deleted");
  release.resolve(undefined);
  assert.ok((await refreshing).ok);
  assert.equal(workspaces.ownerOf(row.id), undefined);
});

it("only sends a shared Host project move to service owner descriptors", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ch-project-move-owner-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const params = { threadId: "moving", projectId: "target" };
  const legacy = new DesktopChHostClient("http://127.0.0.1:1");
  t.after(() => legacy.close());
  const unsupported = (error: unknown) =>
    error instanceof RpcError && error.code === "host/method-unavailable";
  await assert.rejects(legacy.request(CLIENT_THREAD_PROJECT_MOVE_METHOD, params), unsupported);
  for (const owner of [undefined, "service"] as const) {
    const host = new FakeChChannel();
    let writes = 0;
    const request = host.request.bind(host);
    const confirmed = { status: "confirmed", projectId: "target" };
    host.request = async <T>(method: string, input: Record<string, unknown>): Promise<T> => {
      if (method !== CLIENT_THREAD_PROJECT_MOVE_METHOD) return request<T>(method, input);
      assert.deepEqual(input, params);
      writes++;
      return confirmed as T;
    };
    const directory = join(root, owner ?? "desktop");
    const endpoint = await startFakeChChannel(host, directory, owner);
    try {
      const client = await createChHostClient({ directory });
      try {
        assert.ok(client.realtime);
        for (const send of [client.request, client.realtime.request]) {
          const moving = send(CLIENT_THREAD_PROJECT_MOVE_METHOD, params);
          if (owner === "service") assert.deepEqual(await moving, confirmed);
          else await assert.rejects(moving, unsupported);
        }
        assert.equal(writes, owner === "service" ? 2 : 0);
      } finally {
        client.close();
      }
    } finally {
      await endpoint.close();
    }
  }
});

it(
  "never resends a disconnected write or forwards it to a new Desktop owner",
  { timeout: 7000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "ch-project-move-reconnect-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const serviceHost = new FakeChChannel();
    const submitted = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const params = { threadId: "moving", projectId: "target" };
    let writes = 0;
    const request = serviceHost.request.bind(serviceHost);
    serviceHost.request = async <T>(method: string, input: Record<string, unknown>): Promise<T> => {
      if (method !== CLIENT_THREAD_PROJECT_MOVE_METHOD) return request<T>(method, input);
      assert.deepEqual(input, params);
      writes++;
      submitted.resolve(undefined);
      await release.promise;
      return { status: "confirmed", projectId: "target" } as T;
    };
    const service = await startFakeChChannel(serviceHost, directory, "service");
    const client = await createChHostClient({ directory });
    t.after(() => client.close());
    const lost = assert.rejects(
      client.request(CLIENT_THREAD_PROJECT_MOVE_METHOD, params),
      (error: unknown) =>
        error instanceof RpcError &&
        "hostCode" in error.details &&
        error.details.hostCode === -32093,
    );
    await submitted.promise;
    await service.close();
    release.resolve(undefined);
    await lost;
    const desktopHost = new FakeChChannel();
    const desktop = await startFakeChChannel(desktopHost, directory);
    t.after(() => desktop.close());
    const reconnected = Promise.withResolvers<undefined>();
    const stop = client.realtime?.subscribe((event) => {
      if (event.type === "hello" && event.cursor.epoch === desktopHost.epoch)
        reconnected.resolve(undefined);
    });
    t.after(() => stop?.());
    await reconnected.promise;
    await assert.rejects(
      client.request(CLIENT_THREAD_PROJECT_MOVE_METHOD, params),
      (error: unknown) => error instanceof RpcError && error.code === "host/method-unavailable",
    );
    assert.equal(writes, 1);
    assert.ok(
      !desktopHost.requests.some(({ method }) => method === CLIENT_THREAD_PROJECT_MOVE_METHOD),
    );
  },
);
