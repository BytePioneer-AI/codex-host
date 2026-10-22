import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { ChSessions } from "../src/ch-sessions.ts";
import { DataDir } from "../src/store.ts";
import { EventHub, RpcError, RpcRegistry, StreamRegistry } from "../src/transport.ts";
import { Workspaces } from "../src/workspaces.ts";
import { FakeChHost } from "./support/ch-host.ts";

function setup(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "ch-projectless-web-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const host = new FakeChHost();
  host.add("selected", root);
  const workspaces = new Workspaces(new DataDir(root), root, true);
  const selected = workspaces.create(root).workspace;
  const sessions = new ChSessions(host, workspaces, new EventHub(root));
  t.after(() => sessions.close());
  const rpc = new RpcRegistry();
  sessions.register(rpc, new StreamRegistry());
  const call = async <T>(method: string, request: object = {}): Promise<T> => {
    const result = await rpc.dispatch(method, { args: { request } });
    assert.ok(result.ok, result.ok ? undefined : result.error.message);
    return result.value as T;
  };
  return { root, host, workspaces, selected, rpc, call };
}

it("keeps an unselected draft directory-free, commits through the owner, and never registers its cwd", async (t) => {
  const { root, host, workspaces, call } = setup(t);
  await call("session/list");
  const before = workspaces.list().map((workspace) => workspace.workspaceId);
  const draft = await call<{ sessionId: string }>("session/create");
  const list = await call<{ items: Array<{ sessionId: string; cwd?: string }> }>("session/list");
  assert.equal(list.items.find((item) => item.sessionId === draft.sessionId)?.cwd, undefined);
  assert.equal(workspaces.ownerOf(draft.sessionId), undefined);
  assert.equal(host.requests.filter((request) => request.method === "thread/start").length, 0);
  assert.deepEqual(readdirSync(root), ["workspaces.json"]);
  await call("session/prompt", {
    sessionId: draft.sessionId,
    requestId: "first",
    content: [{ type: "text", text: "Build a fresh task" }],
  });
  const start = host.requests.find((request) => request.method === "thread/start");
  assert.ok(start);
  assert.deepEqual(start.params.projectlessWorkspace, { prompt: "Build a fresh task" });
  assert.equal("cwd" in start.params, false);
  assert.equal("projectId" in start.params, false);
  const canonical = [...host.threads.values()].find((row) => row.id !== "selected");
  assert.ok(canonical);
  assert.equal(canonical.workspaceKind, "projectless");
  await call("session/list");
  assert.equal(workspaces.ownerOf(canonical.id), undefined);
  assert.deepEqual(
    workspaces.list().map((workspace) => workspace.workspaceId),
    before,
  );
  assert.deepEqual(
    readdirSync(root),
    ["workspaces.json"],
    "Web does not allocate owner execution directories or an extra Thread index",
  );
  await call("session/prompt", {
    sessionId: canonical.id,
    requestId: "second",
    content: [{ type: "text", text: "Continue" }],
  });
  assert.equal(host.requests.filter((request) => request.method === "thread/start").length, 1);
  const another = await call<{ sessionId: string }>("session/create");
  await call("session/prompt", {
    sessionId: another.sessionId,
    content: [{ type: "text", text: "Build a fresh task" }],
  });
  const paths = [...host.threads.values()]
    .filter((row) => row.workspaceKind === "projectless")
    .map((row) => row.cwd);
  assert.equal(new Set(paths).size, 2);
});

it("uses an explicitly selected workspace and rejects stale choices instead of selecting none", async (t) => {
  const { root, host, workspaces, selected, rpc, call } = setup(t);
  await call("session/list");
  const draft = await call<{ sessionId: string }>("session/create", {
    workspaceId: selected.workspaceId,
  });
  assert.equal(workspaces.ownerOf(draft.sessionId)?.path, root);
  await call("session/prompt", {
    sessionId: draft.sessionId,
    content: [{ type: "text", text: "Use the selected folder" }],
  });
  const start = host.requests.find((request) => request.method === "thread/start");
  assert.ok(start);
  assert.equal(start.params.cwd, root);
  assert.equal("projectlessWorkspace" in start.params, false);
  const rejected = await rpc.dispatch("session/create", {
    args: { request: { workspaceId: "deleted" } },
  });
  assert.ok(!rejected.ok);
  assert.equal(rejected.error.code, "workspace/invalid-path");
});

it("does not resend an uncertain creation or allow reusing that draft to allocate another directory", async (t) => {
  const { host, rpc, call } = setup(t);
  const request = host.request.bind(host);
  let starts = 0;
  host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
    if (method === "thread/start") {
      starts++;
      throw new RpcError("host/outcome-unknown", "Outcome is unknown; do not retry automatically.");
    }
    return request<T>(method, params);
  };
  const draft = await call<{ sessionId: string }>("session/create");
  for (let index = 0; index < 2; index++) {
    const reply = await rpc.dispatch("session/prompt", {
      args: {
        request: { sessionId: draft.sessionId, content: [{ type: "text", text: "New task" }] },
      },
    });
    assert.ok(!reply.ok);
    assert.equal(reply.error.code, "host/outcome-unknown");
  }
  const replace = await rpc.dispatch("session/create", {
    args: { request: { sessionId: draft.sessionId } },
  });
  assert.ok(!replace.ok);
  assert.equal(replace.error.code, "session/busy");
  assert.equal(starts, 1);
});
