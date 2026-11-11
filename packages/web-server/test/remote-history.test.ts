import assert from "node:assert/strict";
import { it } from "node:test";
import { RemoteSessions, remoteSessionId } from "../src/remote-sessions.ts";
import { ChThreadHistory } from "../src/ch-thread-history.ts";
import { EventHub, RpcRegistry, StreamRegistry } from "../src/transport.ts";
import type { RemoteSessionOperation } from "@codexhost/shared-contracts";

it("opens and pages a long remote external Thread without full-history reads", async (t) => {
  const hostId = "remote-ssh-discovered:a",
    threadId = "long-46";
  const row = {
    id: threadId,
    cwd: "/remote",
    modelProvider: "codexhost",
    createdAt: 1,
    updatedAt: 2,
    status: { type: "idle" },
    historyMode: "paginated",
    turns: [],
  };
  const calls: RemoteSessionOperation[] = [];
  let losePage = false;
  const turn = (id: string) => ({
    id,
    status: "completed",
    items: [{ id: id + "-answer", type: "agentMessage", text: id }],
  });
  const remote = new RemoteSessions(new EventHub("history"), async (operation) => {
    calls.push(operation);
    if (operation.kind === "hosts") return [{ hostId, online: true }];
    if (operation.kind === "list") return { data: [row], nextCursor: null };
    if (operation.kind === "read") {
      assert.equal(operation.metadataOnly, true);
      return { result: { thread: row }, epoch: "connection-a", requests: [] };
    }
    if (operation.kind === "turns") {
      assert.equal(operation.threadId, threadId);
      assert.equal(operation.epoch, "connection-a");
      if (losePage) throw new Error("Lost read reply");
      return operation.cursor === null
        ? { data: [turn("newest"), turn("middle")], nextCursor: "older" }
        : { data: [turn("oldest")], nextCursor: null };
    }
    throw new Error("Unexpected mutation");
  });
  t.after(() => remote.close());
  const rpc = new RpcRegistry();
  rpc.register("session/page", () => {
    throw new Error("Remote history must not route locally");
  });
  remote.install(rpc, new StreamRegistry());
  await remote.refresh();
  const id = remoteSessionId(hostId, threadId);
  const view = await remote.read(id);
  assert.ok(view instanceof ChThreadHistory);
  assert.deepEqual(
    view.thread.turns.map((turn) => turn.id),
    ["middle", "newest"],
  );
  losePage = true;
  await assert.rejects(
    view.loadOlder(),
    (error) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "remote/offline",
  );
  losePage = false;
  const result = await rpc.dispatch("session/page", {
    args: {
      request: {
        sessionId: id,
        throughSeq: view.log.lastSeq,
        beforeSeq: view.log.firstSeq,
        maxMessages: 20,
      },
    },
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(
    view.thread.turns.map((turn) => turn.id),
    ["oldest", "middle", "newest"],
  );
  assert.equal(
    calls.filter((operation) => operation.kind === "turns" && operation.cursor === "older").length,
    2,
  );
});

it("a rejected oversized history page does not mark the remote Host offline", async (t) => {
  const hostId = "remote-ssh-discovered:fixture";
  let oversized = false;
  const row = {
    id: "thread",
    cwd: "/fixture",
    modelProvider: "openai",
    historyMode: "paginated",
    status: { type: "idle" },
    createdAt: 1,
    updatedAt: 1,
    turns: [],
  };
  const remote = new RemoteSessions(new EventHub("size-fixture"), async (operation) => {
    if (operation.kind === "hosts") return [{ hostId, online: true }];
    if (operation.kind === "list") return { data: [row], nextCursor: null };
    if (operation.kind === "read")
      return { result: { thread: row }, epoch: "stable", requests: [] };
    if (operation.kind === "turns") {
      if (oversized)
        throw Object.assign(new Error("Remote history response exceeds the 16 MiB limit"), {
          code: -32094,
        });
      return { data: [{ id: "turn", status: "completed", items: [] }], nextCursor: null };
    }
    throw new Error("Unexpected fixture operation");
  });
  t.after(() => remote.close());
  const rpc = new RpcRegistry();
  rpc.register("session/projections", () => null);
  remote.install(rpc, new StreamRegistry());
  await remote.refresh();
  const id = remoteSessionId(hostId, "thread");
  await remote.read(id);
  oversized = true;
  row.updatedAt += 1;
  await assert.rejects(
    remote.read(id),
    (error) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "remote/too-large",
  );
  const result = await rpc.dispatch("session/projections", {
    args: { request: { sessionId: id } },
  });
  assert.equal(result.ok, true);
  if (!result.ok) throw Error("Projection fixture failed");
  const values = (result.value as { values: Record<string, { state: string }> }).values;
  assert.equal(values.nativeConnection?.state, "connected");
});
