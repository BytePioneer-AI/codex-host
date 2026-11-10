import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { decodeHarnessPluginRoute } from "@codexhost/shared-contracts";
import { DataDir } from "../src/store.ts";
import { Workspaces } from "../src/workspaces.ts";
import { EventHub, RpcRegistry, StreamRegistry, type StreamHandler } from "../src/transport.ts";
import { ChSessions } from "../src/ch-sessions.ts";
import { DesktopChHostClient } from "../src/ch-host-client.ts";
import { projectGroupRoot } from "../src/ch-project-groups.ts";
import { FakeChHost, startFakeChDebugger } from "./support/ch-host.ts";

it("shares canonical CH identity and cwd without a Web index/history or physical mkdir", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ch-web-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const host = new FakeChHost();
  host.add("gui-thread", join(root, "deleted-worktree"));
  const data = new DataDir(root),
    events = new EventHub(root),
    workspaces = new Workspaces(data, root),
    sessions = new ChSessions(host, workspaces, events),
    rpc = new RpcRegistry();
  t.after(() => sessions.close());
  sessions.register(rpc, new StreamRegistry());
  sessions.registerCommands(rpc);
  const emitted = t.mock.method(events, "emit");
  const call = async <T>(method: string, args: object = {}): Promise<T> => {
    const result = await rpc.dispatch(method, { args });
    assert.ok(result.ok, result.ok ? undefined : result.error.message);
    return result.value as T;
  };
  const commands = await call<Array<{ name: string; input?: { hint: string } }>>("commands/list");
  assert.deepEqual(
    commands.map((command) => command.name),
    ["permission"],
  );
  assert.equal(commands[0]?.input?.hint, "<mode>");
  const list = await call<{
    items: Array<{
      sessionId: string;
      cwd: string;
      projections: { values: Record<string, unknown> };
    }>;
  }>("session/list");
  assert.equal(list.items[0]?.sessionId, "gui-thread");
  assert.deepEqual(list.items[0]?.projections.values.threadReference, { hostId: "local" });
  assert.equal(workspaces.ownerOf("gui-thread")?.path, join(root, "deleted-worktree"));
  assert.equal(existsSync(join(root, "deleted-worktree")), false);
  const projections = await call<{ values: Record<string, unknown> }>("session/projections", {
    request: { sessionId: "gui-thread" },
  });
  assert.deepEqual(projections.values.attachmentInput, { enabled: false });
  assert.deepEqual(projections.values.threadReference, { hostId: "local" });
  const canonical = host.threads.get("gui-thread");
  assert.ok(canonical);
  assert.equal(canonical.cwd, join(root, "deleted-worktree"));
  assert.deepEqual(readdirSync(root), ["workspaces.json"]);
  const draft = await call<{ sessionId: string }>("session/create", { request: { cwd: root } });
  assert.equal(
    host.requests.some((req) => req.method === "thread/start"),
    false,
    "creating browser draft must not allocate native history",
  );
  await call("session/prompt", {
    request: {
      sessionId: draft.sessionId,
      requestId: "send-1",
      content: [{ type: "text", text: "hello from Web" }],
      mode: "queue",
    },
  });
  const created = [...host.threads.values()].find((row) => row.id !== "gui-thread");
  assert.ok(created);
  assert.equal(created.cwd, root);
  assert.equal(created.turns.length, 1);
  const lifecycle = emitted.mock.calls.map((call) => call.arguments);
  const bound = lifecycle.findIndex(([event]) => event === "codexhost/session-bound");
  const removed = lifecycle.findIndex(
    ([event, id]) => event === "api-session/removed" && id === draft.sessionId,
  );
  assert.ok(bound >= 0 && removed > bound, "remove the draft only after canonical navigation");
  assert.deepEqual(lifecycle[bound], ["codexhost/session-bound", draft.sessionId, created.id]);
  assert.ok(!lifecycle.some(([event, id]) => event === "api-session/removed" && id === created.id));
  const start = host.requests.find((req) => req.method === "thread/start");
  assert.ok(start);
  assert.equal("projectId" in start.params, false);
  assert.equal(host.requests.filter((req) => req.method === "turn/start").length, 1);
  const again = await call<{ items: Array<{ sessionId: string }> }>("session/list");
  assert.ok(again.items.some((row) => row.sessionId === created.id));
  assert.ok(!again.items.some((row) => row.sessionId === draft.sessionId));
  assert.deepEqual(readdirSync(root), ["workspaces.json"]);
});

it("resolves an existing unbound draft summary without native reads, then follows its bound alias", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ch-direct-draft-"));
  const host = new FakeChHost();
  host.add("unrelated", root);
  const sessions = new ChSessions(
    host,
    new Workspaces(new DataDir(root), root),
    new EventHub(root),
  );
  t.after(async () => {
    await sessions.close();
    rmSync(root, { recursive: true, force: true });
  });
  const rpc = new RpcRegistry();
  sessions.register(rpc, new StreamRegistry());
  sessions.registerCommands(rpc);
  const call = async <T>(method: string, args: object): Promise<T> => {
    const result = await rpc.dispatch(method, { args });
    assert.ok(result.ok, result.ok ? undefined : result.error.message);
    return result.value as T;
  };
  interface Summary {
    sessionId: string;
    blank: boolean;
    cwd?: string;
    projections: { values: Record<string, unknown> };
  }
  const draft = await call<{ sessionId: string }>("session/create", { request: { cwd: root } });
  assert.match(draft.sessionId, /^draft-[0-9a-f-]+$/u);
  const projectless = await call<{ sessionId: string }>("session/create", { request: {} });
  await call("commands/execute", { agentId: draft.sessionId, line: "/permission auto" });
  const controls = t.mock.method(sessions.catalog, "inspect", async () => {
    throw new Error("Draft controls must not be read for a summary");
  });
  const projects = t.mock.method(host, "projects", async () => {
    throw new Error("Projects must not be read for a direct summary");
  });
  host.requests.length = 0;
  const direct = await call<{ items: Summary[] }>("session/list", {
    request: { sessionId: draft.sessionId },
  });
  assert.equal(direct.items.length, 1);
  assert.equal(direct.items[0]?.sessionId, draft.sessionId);
  assert.equal(direct.items[0]?.blank, true);
  assert.equal(direct.items[0]?.cwd, root);
  assert.deepEqual(direct.items[0]?.projections.values.harnessIdentity, {
    id: "fake",
    name: "CH Harness",
  });
  assert.equal(direct.items[0]?.projections.values.nativePermissions, undefined);
  assert.equal(direct.items[0]?.projections.values.permissions, undefined);
  const loose = await call<{ items: Summary[] }>("session/list", {
    request: { sessionId: projectless.sessionId },
  });
  assert.deepEqual(
    loose.items.map((row) => ({ id: row.sessionId, blank: row.blank, cwd: row.cwd })),
    [{ id: projectless.sessionId, blank: true, cwd: undefined }],
  );
  assert.equal(
    host.requests.length,
    0,
    "an unbound draft never requests native ownership, thread/read or the catalog",
  );
  assert.equal(controls.mock.callCount(), 0);
  assert.equal(projects.mock.callCount(), 0);
  assert.equal(host.threads.size, 1, "summary recovery must not create a native Thread");

  controls.mock.restore();
  await call("session/prompt", {
    request: {
      sessionId: draft.sessionId,
      content: [{ type: "text", text: "first message" }],
      mode: "queue",
    },
  });
  const start = host.requests.find((req) => req.method === "thread/start");
  assert.ok(start);
  assert.equal(
    decodeHarnessPluginRoute(start.params.model)?.permissionModeId,
    "auto",
    "reading the summary preserves the draft's selected permission mode",
  );
  const canonical = [...host.threads.keys()].find((id) => id !== "unrelated");
  assert.ok(canonical);
  host.requests.length = 0;
  const bound = await call<{ items: Summary[] }>("session/list", {
    request: { sessionId: draft.sessionId },
  });
  assert.deepEqual(
    bound.items.map((row) => ({ id: row.sessionId, blank: row.blank })),
    [{ id: canonical, blank: false }],
  );
  assert.deepEqual(
    host.requests.map((req) => ({ method: req.method, threadId: req.params.threadId })),
    [
      { method: "codexhost/thread/inspect", threadId: canonical },
      { method: "thread/read", threadId: canonical },
    ],
  );
  assert.equal(projects.mock.callCount(), 0);
});

it("projects imported branch provenance in both list rows and opened history", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ch-import-source-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const host = new FakeChHost();
  const branch = host.add("imported-branch", root);
  const source = { harnessId: "pi", nativeSessionId: "native-source" };
  branch.codexhostImportSource = source;
  host.add("original-session", root);
  const sessions = new ChSessions(
    host,
    new Workspaces(new DataDir(root), root),
    new EventHub(root),
  );
  t.after(() => sessions.close());
  const rpc = new RpcRegistry();
  sessions.register(rpc, new StreamRegistry());
  const list = await rpc.dispatch("session/list", { args: {} });
  assert.ok(list.ok);
  const { items } = list.value as {
    items: Array<{
      sessionId: string;
      projections: { values: Record<string, unknown> };
    }>;
  };
  assert.deepEqual(
    items.find((item) => item.sessionId === branch.id)?.projections.values.codexhostImportSource,
    source,
  );
  assert.equal(
    items.find((item) => item.sessionId === "original-session")?.projections.values
      .codexhostImportSource,
    null,
  );
  assert.equal(
    host.requests.some((request) => request.method === "thread/read"),
    false,
  );
  const opened = await rpc.dispatch("session/projections", {
    args: { request: { sessionId: branch.id } },
  });
  assert.ok(opened.ok);
  assert.deepEqual(
    (opened.value as { values: Record<string, unknown> }).values.codexhostImportSource,
    source,
  );
});

it("searches the displayed title at every fallback level", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ch-title-search-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const host = new FakeChHost();
  host.add("named", join(root, "project"), " Named title ");
  host.add("preview", join(root, "project"), "").preview = " First prompt ";
  host.add("whitespace", join(root, "project"), " \n ").preview = " Another prompt ";
  host.add("directory", join(root, "fallback-directory"), "");
  host.add("id-fallback", "", "", false);
  const sessions = new ChSessions(
    host,
    new Workspaces(new DataDir(root), root),
    new EventHub(root),
  );
  t.after(() => sessions.close());
  const rpc = new RpcRegistry();
  sessions.register(rpc, new StreamRegistry());
  const list = await rpc.dispatch("session/list", { args: {} });
  assert.ok(list.ok);
  const { items } = list.value as {
    items: Array<{ sessionId: string; projections: { values: { title: string } } }>;
  };
  assert.deepEqual(
    items.map((item) => item.projections.values.title).sort(),
    ["Named title", "First prompt", "Another prompt", "fallback-directory", "id-fallback"].sort(),
  );
  for (const item of items) {
    const title = item.projections.values.title;
    const result = await rpc.dispatch("session/search", {
      args: { request: { query: title.toUpperCase() } },
    });
    assert.ok(result.ok);
    assert.deepEqual(result.value, {
      items: [{ sessionId: item.sessionId, snippet: title }],
      hasMore: false,
    });
  }
});

it("starts a late steer directly when CH is already idle, preserving its delivery policy", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ch-late-steer-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const host = new FakeChHost();
  host.add("idle-thread", root);
  const sessions = new ChSessions(
    host,
    new Workspaces(new DataDir(root), root),
    new EventHub(root),
  );
  t.after(() => sessions.close());
  const rpc = new RpcRegistry();
  sessions.register(rpc, new StreamRegistry());
  const result = await rpc.dispatch("session/prompt", {
    args: {
      request: {
        sessionId: "idle-thread",
        requestId: "late-steer",
        content: [{ type: "text", text: "keep this message" }],
        mode: "steer",
      },
    },
  });
  assert.ok(result.ok, result.ok ? undefined : result.error.message);
  assert.equal(
    host.requests.some((request) => request.method === "turn/steer"),
    false,
  );
  assert.deepEqual(host.requests.find((request) => request.method === "turn/start")?.params, {
    threadId: "idle-thread",
    input: [{ type: "text", text: "keep this message", text_elements: [] }],
    clientUserMessageId: "late-steer",
  });
});

it("shares one native history read across concurrent browser consumers", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ch-read-sharing-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const host = new FakeChHost();
  host.add("history", root);
  const sessions = new ChSessions(
    host,
    new Workspaces(new DataDir(root), root),
    new EventHub(root),
  );
  t.after(() => sessions.close());
  const rpc = new RpcRegistry();
  sessions.register(rpc, new StreamRegistry());
  await rpc.dispatch("session/list", { args: {} });
  const replies = await Promise.all(
    [1, 2, 3].map(() =>
      rpc.dispatch("session/projections", { args: { request: { sessionId: "history" } } }),
    ),
  );
  assert.ok(replies.every((reply) => reply.ok));
  assert.equal(host.requests.filter((request) => request.method === "thread/turns/list").length, 1);
});

it("reuses idle history and does not wait for Harness configuration", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ch-fast-history-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const host = new FakeChHost();
  host.add("history", root);
  const request = host.request.bind(host);
  let release!: () => void;
  const configuration = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
    if (method === "codexhost/harness/inspect") await configuration;
    return request<T>(method, params);
  };
  const sessions = new ChSessions(
    host,
    new Workspaces(new DataDir(root), root),
    new EventHub(root),
  );
  t.after(() => sessions.close());
  const rpc = new RpcRegistry();
  sessions.register(rpc, new StreamRegistry());
  await rpc.dispatch("session/list", { args: {} });
  const read = () =>
    rpc.dispatch("session/projections", { args: { request: { sessionId: "history" } } });
  let timeout: NodeJS.Timeout | undefined;
  const result = await Promise.race([
    read(),
    new Promise<never>((_, reject) => {
      timeout = setTimeout(
        () => reject(new Error("History is blocked by Harness configuration")),
        500,
      );
    }),
  ]).finally(() => clearTimeout(timeout));
  assert.ok(result.ok);
  release();
  assert.ok((await read()).ok);
  assert.equal(host.requests.filter((r) => r.method === "thread/turns/list").length, 1);
  const row = host.threads.get("history");
  assert.ok(row);
  row.updatedAt += 1;
  await rpc.dispatch("session/list", { args: {} });
  assert.ok((await read()).ok);
  assert.equal(host.requests.filter((r) => r.method === "thread/turns/list").length, 2);
});

it("does not create project groups from auto-assigned cwd alone", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ch-cwd-filter-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const host = new FakeChHost();
  host.add("auto-thread", join(root, "generated-unselected-directory"), "Unselected", false);
  const workspaces = new Workspaces(new DataDir(root), root);
  const original = workspaces.attachReferencedSession(
    "auto-thread",
    join(root, "generated-unselected-directory"),
  );
  delete original.origin;
  const sessions = new ChSessions(host, workspaces, new EventHub(root));
  t.after(() => sessions.close());
  const rpc = new RpcRegistry();
  sessions.register(rpc, new StreamRegistry());
  const result = await rpc.dispatch("session/list", { args: {} });
  assert.ok(result.ok);
  assert.ok(workspaces.get(original.workspaceId), "Existing navigation data is not deleted");
  assert.ok(!workspaces.list().some((folder) => folder.workspaceId === original.workspaceId));
  assert.equal(
    workspaces.ownerOf("auto-thread"),
    undefined,
    "An execution cwd is not evidence of a selected project",
  );
});

it("workspace mirror: saves complete multi-member groups once and repeats without writes or frames", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ch-workspace-mirror-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const host = new FakeChHost();
  for (let i = 0; i < 12; i++) host.add(`thread-${i}`, join(root, `project-${i % 2}`));
  const data = new DataDir(root);
  const workspaces = new Workspaces(data, root);
  const sessions = new ChSessions(host, workspaces, new EventHub(root));
  t.after(() => sessions.close());
  const rpc = new RpcRegistry();
  const streams = new StreamRegistry();
  let follow: StreamHandler | undefined;
  const register = streams.register.bind(streams);
  streams.register = (name, handler) => {
    if (name === "workspace/follow") follow = handler;
    register(name, handler);
  };
  workspaces.register(rpc, streams);
  sessions.register(rpc, streams);
  const frames: unknown[] = [];
  assert.ok(follow);
  await follow(
    {},
    {
      id: "workspaces",
      closed: false,
      push: (frame) => frames.push(structuredClone(frame)),
      end() {},
      fail() {},
      onClose() {},
    },
  );
  frames.length = 0;
  const writes = t.mock.method(data, "writeJson");
  assert.ok((await rpc.dispatch("session/list", { args: {} })).ok);
  assert.equal(writes.mock.callCount(), 1);
  const items = workspaces.list();
  assert.equal(items.length, 2);
  for (const workspace of items) {
    assert.deepEqual(
      workspace.sessionIds,
      [...host.threads.values()]
        .filter((thread) => thread.cwd === workspace.path)
        .map((thread) => thread.id),
    );
    assert.equal(existsSync(workspace.path), false);
  }
  assert.deepEqual(data.readJson("workspaces.json", { items: [] }).items, items);
  assert.deepEqual(frames, [
    ...items.map((workspace) => ({ type: "upsert", workspace })),
    { type: "order", workspaceIds: items.map((workspace) => workspace.workspaceId) },
  ]);
  writes.mock.resetCalls();
  frames.length = 0;
  assert.ok((await rpc.dispatch("session/list", { args: {} })).ok);
  assert.equal(writes.mock.callCount(), 0);
  assert.deepEqual(frames, []);
  assert.deepEqual(workspaces.list(), items);
});

it("workspace mirror: preserves Web information and identities across native title and root changes", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ch-workspace-regroup-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const firstRoot = join(root, "first");
  const secondRoot = join(root, "second");
  const host = new FakeChHost();
  const moving = host.add("moving", join(root, "outside-worktree"), "Moving", false);
  host.add("second-root", join(secondRoot, "nested"), "Second", false);
  host.add("projectless", root, "No project", false);
  host.add("web-session", root, "Web session");
  const project = { id: "project", name: "Native title", rootPaths: [firstRoot, secondRoot] };
  host.projectSnapshot.projects.push(project);
  Object.assign(host.projectSnapshot.assignments, {
    moving: project.id,
    "second-root": project.id,
  });
  const data = new DataDir(root);
  const workspaces = new Workspaces(data, root);
  const rpc = new RpcRegistry();
  const streams = new StreamRegistry();
  let follow: StreamHandler | undefined;
  const register = streams.register.bind(streams);
  streams.register = (name, handler) => {
    if (name === "workspace/follow") follow = handler;
    register(name, handler);
  };
  workspaces.register(rpc, streams);
  const explicit = workspaces.create(root).workspace;
  workspaces.attachSession("manual-session", explicit.workspaceId, root);
  workspaces.attachSession("projectless", explicit.workspaceId, root);
  workspaces.attachSession("web-session", explicit.workspaceId, root);
  assert.ok(
    (
      await rpc.dispatch("workspace/rename", {
        args: { request: { workspaceId: explicit.workspaceId, title: "My workspace" } },
      })
    ).ok,
  );
  const savedExplicit = structuredClone(explicit);
  const sessions = new ChSessions(host, workspaces, new EventHub(root));
  t.after(() => sessions.close());
  sessions.register(rpc, streams);
  assert.ok((await rpc.dispatch("session/list", { args: {} })).ok);
  const first = workspaces.byPath(firstRoot);
  const second = workspaces.byPath(secondRoot);
  assert.ok(first && second);
  assert.deepEqual(
    first.sessionIds,
    ["moving"],
    "an assigned root-external worktree uses its project",
  );
  assert.deepEqual(second.sessionIds, ["second-root"]);
  const frames: unknown[] = [];
  assert.ok(follow);
  await follow(
    {},
    {
      id: "workspaces",
      closed: false,
      push: (frame) => frames.push(structuredClone(frame)),
      end() {},
      fail() {},
      onClose() {},
    },
  );
  frames.length = 0;
  const writes = t.mock.method(data, "writeJson");
  moving.cwd = join(secondRoot, "worktree");
  project.name = "Renamed native project";
  assert.ok((await rpc.dispatch("session/list", { args: {} })).ok);
  assert.equal(writes.mock.callCount(), 1);
  assert.deepEqual(workspaces.get(explicit.workspaceId), savedExplicit);
  assert.deepEqual(
    workspaces.list().find((workspace) => workspace.workspaceId === explicit.workspaceId)
      ?.sessionIds,
    savedExplicit.sessionIds.filter((id) => id !== "projectless"),
  );
  const updated = workspaces.byPath(secondRoot);
  assert.ok(updated);
  assert.equal(updated.workspaceId, second.workspaceId);
  assert.equal(updated.createdAt, second.createdAt);
  assert.equal(updated.title, project.name);
  assert.deepEqual(updated.sessionIds, ["second-root", "moving"]);
  const firstProject = workspaces
    .list()
    .find((workspace) => workspace.workspaceId === first.workspaceId);
  assert.ok(firstProject, "complete project definitions survive without loaded members");
  assert.equal(firstProject.title, project.name);
  assert.deepEqual(firstProject.sessionIds, []);
  assert.deepEqual(frames, [
    { type: "upsert", workspace: firstProject },
    { type: "upsert", workspace: updated },
  ]);
  writes.mock.resetCalls();
  frames.length = 0;
  workspaces.syncReferencedSessions([], new Map([["projectless", undefined]]));
  assert.equal(writes.mock.callCount(), 0, "reference-only changes need no disk write");
  const visibleExplicit = workspaces
    .list()
    .find((workspace) => workspace.workspaceId === explicit.workspaceId);
  assert.deepEqual(visibleExplicit?.sessionIds, savedExplicit.sessionIds);
  assert.deepEqual(frames, [
    { type: "remove", workspaceId: first.workspaceId },
    { type: "remove", workspaceId: second.workspaceId },
    { type: "upsert", workspace: visibleExplicit },
    { type: "order", workspaceIds: [explicit.workspaceId] },
  ]);
});

it("workspace mirror: propagates a failed save without accepting the mirror", (t) => {
  const root = mkdtempSync(join(tmpdir(), "ch-workspace-save-failure-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const data = new DataDir(root);
  const workspaces = new Workspaces(data, root);
  const explicit = workspaces.create(root).workspace;
  const before = structuredClone(workspaces.list());
  const cwd = join(root, "project");
  const references = [{ sessionId: "thread", cwd, title: "Native" }];
  const groups = new Map([["thread", cwd]]);
  const writes = t.mock.method(data, "writeJson", () => {
    throw new Error("disk full");
  });
  assert.throws(() => workspaces.syncReferencedSessions(references, groups), /disk full/);
  assert.deepEqual(workspaces.list(), before);
  assert.equal(workspaces.byPath(cwd), undefined);
  assert.deepEqual(data.readJson("workspaces.json", { items: [] }).items, [explicit]);
  writes.mock.restore();
  workspaces.syncReferencedSessions(references, groups);
  assert.deepEqual(workspaces.ownerOf("thread")?.sessionIds, ["thread"]);
});

it("groups assigned worktrees under their GUI project without changing execution cwd", () => {
  const root = resolve("computer", "project");
  const snapshot = {
    projects: [{ id: "p", name: "Selected", rootPaths: [root] }],
    assignments: { assigned: "p" },
    projectless: ["unselected"],
  };
  assert.equal(
    projectGroupRoot(snapshot, "assigned", resolve("computer", "worktrees", "isolated")),
    root,
  );
  assert.equal(projectGroupRoot(snapshot, "nested", join(root, "subdirectory")), root);
  assert.equal(projectGroupRoot(snapshot, "unselected", join(root, "generated")), undefined);
  assert.equal(projectGroupRoot(snapshot, "unknown", `${root}-other`), undefined);
});

it("uses existing Desktop routing without installing code, and does not retry rejected writes", async (t) => {
  const host = new FakeChHost();
  host.add("thread", "/workspace");
  const debuggerServer = await startFakeChDebugger(host);
  t.after(() => debuggerServer.close());
  const client = new DesktopChHostClient(debuggerServer.endpoint);
  t.after(() => client.close());
  const list = await client.request<{ data: Array<{ id: string }> }>("thread/list", {});
  assert.equal(list.data[0]?.id, "thread");
  assert.deepEqual(await client.projects(["thread"]), host.projectSnapshot);
  await assert.rejects(
    client.request("turn/start", { threadId: "missing", input: [] }),
    /Missing CH Thread/,
  );
  assert.equal(host.requests.filter((req) => req.method === "turn/start").length, 1);
  await assert.rejects(client.request("shell/execute", {}), /Unsupported CH method/);
});

it("keeps a Thread created during an in-flight catalog read for its first history read", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ch-first-history-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const host = new FakeChHost();
  host.add("existing", root);
  const events = new EventHub(root);
  const emitted = t.mock.method(events, "emit");
  const sessions = new ChSessions(host, new Workspaces(new DataDir(root), root), events);
  t.after(() => sessions.close());
  const rpc = new RpcRegistry();
  sessions.register(rpc, new StreamRegistry());
  assert.ok((await rpc.dispatch("session/list", { args: {} })).ok);
  // The next catalog read snapshots the Host before the first message creates a Thread,
  // then stays in flight past replacing the catalog.
  const request = host.request.bind(host);
  const projects = host.projects.bind(host);
  let releaseList!: () => void;
  const listHeld = new Promise<void>((resolve) => {
    releaseList = resolve;
  });
  let releaseProjects!: () => void;
  const projectsHeld = new Promise<void>((resolve) => {
    releaseProjects = resolve;
  });
  let replaced!: () => void;
  const catalogReplaced = new Promise<void>((resolve) => {
    replaced = resolve;
  });
  let holding = true;
  host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
    const result = await request<T>(method, params);
    if (method === "codexhost/thread/catalog/read" && holding) await listHeld;
    return result;
  };
  host.projects = async () => {
    if (holding) {
      replaced();
      await projectsHeld;
    }
    return projects();
  };
  const staleList = rpc.dispatch("session/list", { args: {} });
  const draft = await rpc.dispatch("session/create", { args: { request: { cwd: root } } });
  assert.ok(draft.ok);
  const prompt = await rpc.dispatch("session/prompt", {
    args: {
      request: {
        sessionId: (draft.value as { sessionId: string }).sessionId,
        requestId: "first",
        content: [{ type: "text", text: "first message" }],
        mode: "queue",
      },
    },
  });
  assert.ok(prompt.ok, prompt.ok ? undefined : prompt.error.message);
  const created = [...host.threads.values()].find((row) => row.id !== "existing");
  assert.ok(created);
  releaseList();
  await catalogReplaced;
  holding = false;
  const history = rpc.dispatch("session/projections", {
    args: { request: { sessionId: created.id } },
  });
  releaseProjects();
  const result = await history;
  assert.ok(result.ok, result.ok ? undefined : result.error.message);
  assert.ok((await staleList).ok);
  assert.ok(
    !emitted.mock.calls.some(
      (call) => call.arguments[0] === "api-session/removed" && call.arguments[1] === created.id,
    ),
    "an external Thread created after the snapshot must not be removed by it",
  );
});
