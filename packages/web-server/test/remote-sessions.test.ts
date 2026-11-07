import { defined } from "./support/defined.ts";
import assert from "node:assert/strict";
import { it } from "node:test";
import { RemoteSessions, remoteSessionId, remoteSessionIdentity } from "../src/remote-sessions.ts";
import { EventHub, RpcRegistry, StreamRegistry } from "../src/transport.ts";
import type { RemoteSessionOperation } from "@codexhost/shared-contracts";
import type { StreamSink } from "../src/transport.ts";

function fixture() {
  const calls: RemoteSessionOperation[] = [];
  let offline = false,
    loseWrite = false;
  const row = {
    id: "same",
    cwd: "/private/remote",
    name: "Remote",
    modelProvider: "openai",
    createdAt: 1,
    updatedAt: 2,
    status: { type: "idle" },
    turns: [],
  };
  const events = new EventHub("fixture"),
    rpc = new RpcRegistry();
  for (const method of [
    "session/list",
    "session/projections",
    "session/prompt",
    "session/rename",
    "session/attachment",
    "session/fork",
    "session/page",
  ])
    rpc.register(method, () =>
      method === "session/list" ? { items: [{ sessionId: "same" }] } : { local: true },
    );
  const remote = new RemoteSessions(events, async (operation) => {
    calls.push(operation);
    if (offline) throw new Error("offline");
    if (operation.kind === "hosts")
      return [
        { hostId: "remote-ssh-discovered:a", online: true },
        { hostId: "remote-control:b", online: true },
      ];
    if (operation.kind === "list") return { data: [row], nextCursor: null };
    if (operation.kind === "read")
      return { epoch: "epoch-" + operation.hostId, result: { thread: row }, requests: [] };
    if (loseWrite) throw new Error("unknown");
    return {};
  });
  remote.install(rpc, new StreamRegistry());
  const call = (method: string, request: object = {}) =>
    rpc.dispatch(method, { args: { request } });
  return {
    remote,
    calls,
    call,
    offline: () => {
      offline = true;
    },
    loseWrite: () => {
      loseWrite = true;
    },
  };
}
it("aggregates native owners with distinct host/thread identities and no local cwd", async (t) => {
  const f = fixture();
  t.after(() => f.remote.close());
  const result = await f.call("session/list");
  assert.ok(result.ok);
  const items = (result.value as { items: Array<{ sessionId: string; cwd?: string }> }).items;
  assert.equal(new Set(items.map((item) => item.sessionId)).size, 3);
  assert.equal(defined(items[0]).sessionId, "same");
  assert.equal(defined(items[1]).cwd, "");
  assert.deepEqual(remoteSessionIdentity(defined(items[1]).sessionId), {
    hostId: "remote-ssh-discovered:a",
    threadId: "same",
  });
  const local = await f.call("session/prompt", { sessionId: "same" });
  assert.deepEqual(local, { ok: true, value: { local: true } });
});
it("routes remote writes exactly once and reports unknown outcomes", async (t) => {
  const f = fixture();
  t.after(() => f.remote.close());
  f.loseWrite();
  const result = await f.call("session/prompt", {
    sessionId: remoteSessionId("remote-control:b", "same"),
    content: [{ type: "text", text: "hello" }],
  });
  assert.ok(!result.ok);
  assert.equal(result.error.code, "remote/outcome-unknown");
  assert.deepEqual(
    f.calls.filter((op) => op.kind === "prompt"),
    [
      {
        kind: "prompt",
        hostId: "remote-control:b",
        threadId: "same",
        epoch: "epoch-remote-control:b",
        text: "hello",
      },
    ],
  );
});
it("keeps offline rows and refuses writes without a current remote read", async (t) => {
  const f = fixture();
  t.after(() => f.remote.close());
  await f.call("session/list");
  f.offline();
  const list = await f.call("session/list");
  assert.ok(list.ok);
  assert.equal((list.value as { items: unknown[] }).items.length, 3);
  const result = await f.call("session/rename", {
    sessionId: remoteSessionId("remote-ssh-discovered:a", "same"),
    title: "new",
  });
  assert.ok(!result.ok);
  assert.equal(result.error.code, "remote/offline");
  assert.equal(f.calls.filter((op) => op.kind === "rename").length, 0);
});
it("never delegates remote attachments, fork, or malformed identities to local handlers", async (t) => {
  const f = fixture();
  t.after(() => f.remote.close());
  for (const method of ["session/attachment", "session/fork"]) {
    const result = await f.call(method, {
      sessionId: remoteSessionId("remote-ssh-discovered:a", "same"),
    });
    assert.ok(!result.ok);
    assert.equal(result.error.code, "remote/unsupported");
  }
  assert.throws(() => remoteSessionIdentity("web-remote:invalid"));
});
it("does not collide when host and thread strings contain delimiters or Unicode", () => {
  assert.notEqual(
    remoteSessionId("remote-ssh-discovered:a:b", "c"),
    remoteSessionId("remote-ssh-discovered:a", "b:c"),
  );
  assert.deepEqual(remoteSessionIdentity(remoteSessionId("remote-ssh-discovered:主机", "线程")), {
    hostId: "remote-ssh-discovered:主机",
    threadId: "线程",
  });
});

it("waits for the local control baseline before publishing remote projection deltas", async (t) => {
  const events = new EventHub("fixture");
  const row = {
    id: "same",
    cwd: "remote",
    modelProvider: "openai",
    createdAt: 1,
    updatedAt: 2,
    status: { type: "idle" },
    turns: [],
  };
  let offline = false;
  const remote = new RemoteSessions(events, async (operation) => {
    if (offline) throw new Error("offline");
    if (operation.kind === "hosts") return [{ hostId: "remote-ssh-discovered:a", online: true }];
    if (operation.kind === "list") return { data: [row], nextCursor: null };
    return { result: { thread: row }, epoch: "fixture", requests: [] };
  });
  t.after(() => remote.close());
  const streams = new StreamRegistry();
  let router: Parameters<StreamRegistry["routeSessions"]>[0] | undefined;
  streams.routeSessions = (value) => {
    router = value;
  };
  remote.install(new RpcRegistry(), streams);
  const frames: unknown[] = [];
  const sink: StreamSink = {
    id: "control",
    closed: false,
    push: (frame) => frames.push(frame),
    end() {},
    fail() {},
    onClose() {},
  };
  const ready = Promise.withResolvers<undefined>();
  const subscribing = defined(router)("session/control", {}, sink, async (forward) => {
    await ready.promise;
    forward.push({ type: "baseline", value: { projections: {} } });
  });
  await remote.read(remoteSessionId("remote-ssh-discovered:a", "same"));
  assert.equal(frames.length, 0);
  ready.resolve(undefined);
  await subscribing;
  offline = true;
  await remote.refresh();
  assert.equal((frames[0] as { type: string }).type, "baseline");
  assert.ok(frames.slice(1).some((frame) => (frame as { type: string }).type === "projection"));
});

it("publishes host-scoped approvals to two clients and routes only the selected answer", async (t) => {
  const events = new EventHub("fixture");
  const frames: unknown[][] = [[], []];
  for (const values of frames) {
    const sink: StreamSink = {
      id: "observer",
      closed: false,
      push: (value) => values.push(value),
      end() {},
      fail() {},
      onClose() {},
    };
    await events.handler({}, sink);
  }
  const operations: RemoteSessionOperation[] = [];
  const row = {
    id: "same",
    cwd: "remote",
    modelProvider: "openai",
    createdAt: 1,
    updatedAt: 2,
    status: { type: "idle" },
    turns: [],
  };
  const remote = new RemoteSessions(events, async (operation) => {
    operations.push(operation);
    if (operation.kind === "hosts")
      return ["remote-ssh-discovered:a", "remote-control:b"].map((hostId) => ({
        hostId,
        online: true,
      }));
    if (operation.kind === "list") return { data: [row], nextCursor: null };
    if (operation.kind === "read")
      return {
        result: { thread: row },
        epoch: "epoch",
        requests: [
          { id: 7, method: "item/commandExecution/requestApproval", params: { threadId: "same" } },
        ],
      };
    return {};
  });
  t.after(() => remote.close());
  await remote.read(remoteSessionId("remote-ssh-discovered:a", "same"));
  await remote.read(remoteSessionId("remote-control:b", "same"));
  type Frame = { type: string; agentId: string; eventId: string };
  const pending = frames.map((values) =>
    (values as Frame[]).filter((frame) => frame.type === "waterfall"),
  );
  assert.equal(defined(pending[0]).length, 2);
  assert.deepEqual(pending[0], pending[1]);
  const selected = defined(
    defined(pending[0]).find(
      (frame) => frame.agentId === remoteSessionId("remote-control:b", "same"),
    ),
  );
  events.settle({
    eventId: selected.eventId,
    outcome: { kind: "resolved", value: { answers: [{ selected: ["Allow once"] }] } },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const replies = operations.filter((operation) => operation.kind === "respond");
  assert.deepEqual(replies, [
    {
      kind: "respond",
      hostId: "remote-control:b",
      threadId: "same",
      epoch: "epoch",
      requestId: 7,
      result: { decision: "accept" },
    },
  ]);
  events.settle({ eventId: selected.eventId, outcome: { kind: "resolved", value: {} } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(operations.filter((operation) => operation.kind === "respond").length, 1);
});
