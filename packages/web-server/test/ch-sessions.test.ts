import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { DataDir } from "../src/store.ts";
import { Workspaces } from "../src/workspaces.ts";
import { EventHub, RpcRegistry, StreamRegistry } from "../src/transport.ts";
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
  const list = await call<{ items: Array<{ sessionId: string; cwd: string }> }>("session/list");
  assert.equal(list.items[0]?.sessionId, "gui-thread");
  assert.equal(workspaces.ownerOf("gui-thread")?.path, join(root, "deleted-worktree"));
  assert.equal(existsSync(join(root, "deleted-worktree")), false);
  const projections = await call<{ values: Record<string, unknown> }>("session/projections", {
    request: { sessionId: "gui-thread" },
  });
  assert.deepEqual(projections.values.attachmentInput, { enabled: false });
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
  const start = host.requests.find((req) => req.method === "thread/start");
  assert.ok(start);
  assert.equal("projectId" in start.params, false);
  assert.equal(host.requests.filter((req) => req.method === "turn/start").length, 1);
  const again = await call<{ items: Array<{ sessionId: string }> }>("session/list");
  assert.ok(again.items.some((row) => row.sessionId === created.id));
  assert.ok(!again.items.some((row) => row.sessionId === draft.sessionId));
  assert.deepEqual(readdirSync(root), ["workspaces.json"]);
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

it("groups assigned worktrees under their GUI project without changing execution cwd", () => {
  const snapshot = {
    projects: [{ id: "p", name: "Selected", rootPaths: ["/computer/project"] }],
    assignments: { assigned: "p" },
    projectless: ["unselected"],
  };
  assert.equal(
    projectGroupRoot(snapshot, "assigned", "/computer/worktrees/isolated"),
    "/computer/project",
  );
  assert.equal(
    projectGroupRoot(snapshot, "nested", "/computer/project/subdirectory"),
    "/computer/project",
  );
  assert.equal(projectGroupRoot(snapshot, "unselected", "/computer/project/generated"), undefined);
  assert.equal(projectGroupRoot(snapshot, "unknown", "/computer/project-other"), undefined);
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
