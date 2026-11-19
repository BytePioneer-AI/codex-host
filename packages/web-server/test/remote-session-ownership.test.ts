import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import type { RemoteSessionOperation } from "@codexhost/shared-contracts";
import { ChSessions } from "../src/ch-sessions.ts";
import { RemoteSessions, remoteSessionId } from "../src/remote-sessions.ts";
import { DataDir } from "../src/store.ts";
import { EventHub, RpcRegistry, StreamRegistry } from "../src/transport.ts";
import { Workspaces } from "../src/workspaces.ts";
import { FakeChHost } from "./support/ch-host.ts";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "remote-owner-"));
  const host = new FakeChHost();
  host.add("local-thread", root);
  host.add("local-archived", root);
  host.archivedIds.add("local-archived");
  const events = new EventHub(root);
  const workspaces = new Workspaces(new DataDir(root), root);
  const local = new ChSessions(host, workspaces, events);
  const rpc = new RpcRegistry();
  const streams = new StreamRegistry();
  workspaces.register(rpc, streams);
  local.register(rpc, streams);
  const hostId = "remote-control:a";
  const id = remoteSessionId(hostId, "local-thread");
  const row = {
    id: "local-thread",
    cwd: "/remote",
    modelProvider: "openai",
    createdAt: 1,
    updatedAt: 2,
    status: { type: "idle" },
    turns: [],
  };
  let archived = false;
  const operations: RemoteSessionOperation[] = [];
  const remote = new RemoteSessions(
    events,
    async (op) => {
      operations.push(op);
      if (op.kind === "hosts") return [{ hostId, online: true }];
      if (op.kind === "list") return { data: archived ? [] : [row], nextCursor: null };
      if (op.kind === "read") return { result: { thread: row }, epoch: "epoch", requests: [] };
      if (op.kind === "archive") archived = op.archived;
      return {};
    },
    workspaces,
  );
  remote.install(rpc, streams);
  t.after(async () => {
    remote.close();
    await local.close();
    rmSync(root, { recursive: true, force: true });
  });
  const call = (method: string, request: object = {}) =>
    rpc.dispatch(method, { args: { request } });
  return { id, host, workspaces, remote, operations, call, archived: () => archived };
}

it("routes cold remote summaries before the local owner and keeps local lookups targeted", async (t) => {
  const f = fixture(t);
  const summary = await f.call("session/list", { sessionId: f.id });
  assert.ok(summary.ok);
  assert.deepEqual(
    (summary.value as { items: Array<{ sessionId: string }> }).items.map((row) => row.sessionId),
    [f.id],
  );
  assert.deepEqual(f.host.requests, [], "remote summaries must never inspect the local Host");
  assert.deepEqual(
    f.operations.map((op) => op.kind),
    ["hosts", "list"],
  );

  const local = await f.call("session/list", { sessionId: "local-thread" });
  assert.ok(local.ok);
  assert.deepEqual(
    (local.value as { items: Array<{ sessionId: string }> }).items.map((row) => row.sessionId),
    ["local-thread"],
  );
  const localCalls = f.host.requests.length;
  for (const [request, code] of [
    [{ sessionId: remoteSessionId("remote-control:a", "missing") }, "remote/not-found"],
    [{ sessionId: "web-remote:invalid" }, "remote/identity-invalid"],
    [{ sessionId: f.id, cursor: "unexpected" }, "session/list-invalid"],
  ] as const) {
    const result = await f.call("session/list", request);
    assert.ok(!result.ok);
    assert.equal(result.error.code, code);
  }
  assert.equal(f.host.requests.length, localCalls);
});

it("keeps remote archives out of local facts through catalog refreshes and local mutations", async (t) => {
  const f = fixture(t);
  await f.remote.refresh();
  assert.ok((await f.call("session/list")).ok);
  assert.ok((await f.call("workspace/archiveSession", { sessionId: f.id })).ok);
  assert.deepEqual(f.workspaces.archivedSessionIds().sort(), ["local-archived", f.id].sort());

  assert.ok((await f.call("session/list")).ok);
  assert.deepEqual(f.workspaces.localArchivedSessionIds(), ["local-archived"]);
  assert.ok((await f.call("workspace/archiveSession", { sessionId: "local-thread" })).ok);
  assert.deepEqual(f.workspaces.localArchivedSessionIds(), ["local-archived", "local-thread"]);
  const restored = await f.call("workspace/unarchiveSession", { sessionId: f.id });
  assert.deepEqual(restored, {
    ok: true,
    value: { archivedSessionIds: ["local-archived", "local-thread"] },
  });
  assert.equal(f.archived(), false);
  assert.ok((await f.call("workspace/unarchiveSession", { sessionId: "local-thread" })).ok);
  assert.deepEqual(f.workspaces.archivedSessionIds(), ["local-archived"]);
});
