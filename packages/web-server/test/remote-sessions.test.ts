import { defined } from "./support/defined.ts";
import assert from "node:assert/strict";
import { it } from "node:test";
import { RemoteSessions, remoteSessionId, remoteSessionIdentity } from "../src/remote-sessions.ts";
import { EventHub, RpcRegistry, StreamRegistry } from "../src/transport.ts";
import type { RemoteSessionOperation } from "@codexhost/shared-contracts";
import type { StreamSink } from "../src/transport.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DataDir } from "../src/store.ts";
import { Workspaces } from "../src/workspaces.ts";

it("archives and undoes through workspace RPCs without losing local archives or other hosts", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "remote-archive-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const workspaces = new Workspaces(new DataDir(directory), directory);
  workspaces.setReferenceArchives(["local-archived"]);
  const rpc = new RpcRegistry(),
    streams = new StreamRegistry();
  let follow: ((args: Record<string, unknown>, sink: StreamSink) => unknown) | undefined;
  const register = streams.register.bind(streams);
  streams.register = (name, handler) => {
    if (name === "workspace/follow") follow = handler;
    register(name, handler);
  };
  workspaces.register(rpc, streams);
  const frames: unknown[] = [];
  await defined(follow)(
    {},
    {
      id: "observer",
      closed: false,
      push: (frame) => frames.push(frame),
      end() {},
      fail() {},
      onClose() {},
    },
  );
  const archived = new Set<string>();
  const writes: RemoteSessionOperation[] = [];
  let loseWrite = false,
    loseRead = false;
  let pauseList = false;
  const listing = Promise.withResolvers<undefined>();
  const releaseList = Promise.withResolvers<undefined>();
  t.after(() => releaseList.resolve(undefined));
  const row = {
    id: "same",
    cwd: "/remote",
    name: "Remote",
    modelProvider: "openai",
    createdAt: 1,
    updatedAt: 2,
    status: { type: "idle" },
    turns: [],
  };
  const remote = new RemoteSessions(
    new EventHub("archive"),
    async (op) => {
      if (op.kind === "hosts")
        return ["remote-control:a", "remote-control:b"].map((hostId) => ({ hostId, online: true }));
      if (op.kind === "list") {
        const data = archived.has(op.hostId) ? [] : [row];
        if (pauseList) {
          pauseList = false;
          listing.resolve(undefined);
          await releaseList.promise;
        }
        return { data, nextCursor: null };
      }
      if (op.kind === "read") {
        if (loseRead) throw new Error("read unavailable");
        return { result: { thread: row }, epoch: "epoch", requests: [] };
      }
      writes.push(op);
      if (loseWrite) throw new Error("unknown outcome");
      if (op.kind === "archive") {
        if (op.archived) archived.add(op.hostId);
        else archived.delete(op.hostId);
      }
      loseRead = true;
      return {};
    },
    workspaces,
  );
  t.after(() => remote.close());
  remote.install(rpc, streams);
  const a = remoteSessionId("remote-control:a", "same"),
    b = remoteSessionId("remote-control:b", "same");
  const call = (method: string, sessionId: string) =>
    rpc.dispatch(method, { args: { request: { sessionId } } });
  await remote.refresh();
  pauseList = true;
  const staleRefresh = remote.refresh();
  await listing.promise;
  assert.deepEqual(await call("workspace/archiveSession", a), {
    ok: true,
    value: { archivedSessionIds: ["local-archived", a] },
  });
  assert.deepEqual(frames.at(-1), { type: "archived", archivedSessionIds: ["local-archived", a] });
  releaseList.resolve(undefined);
  await staleRefresh;
  assert.deepEqual(workspaces.archivedSessionIds(), ["local-archived", a]);
  workspaces.setReferenceArchives(["local-new"]);
  assert.deepEqual(workspaces.archivedSessionIds(), ["local-new", a]);
  await remote.refresh(); // The active catalog no longer contains the archived row; undo still works.
  loseRead = false;
  assert.deepEqual(await call("workspace/unarchiveSession", a), {
    ok: true,
    value: { archivedSessionIds: ["local-new"] },
  });
  assert.deepEqual(
    writes.map((op) => "hostId" in op && op.hostId),
    ["remote-control:a", "remote-control:a"],
  );
  loseRead = false;
  loseWrite = true;
  const failed = await call("workspace/archiveSession", b);
  assert.ok(!failed.ok);
  assert.equal(failed.error.code, "remote/outcome-unknown");
  assert.deepEqual(workspaces.archivedSessionIds(), ["local-new"]);
  assert.equal(writes.length, 3);
});

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
it("retains undo identity when the catalog sees archive before its write acknowledgement", async (t) => {
  const applied = Promise.withResolvers<undefined>();
  const acknowledgement = Promise.withResolvers<undefined>();
  t.after(() => acknowledgement.resolve(undefined));
  let archived = false;
  const row = {
    id: "native",
    cwd: "/remote",
    modelProvider: "openai",
    createdAt: 1,
    updatedAt: 2,
    status: { type: "idle" },
    turns: [],
  };
  const remote = new RemoteSessions(new EventHub("race"), async (op) => {
    if (op.kind === "hosts") return [{ hostId: "remote-control:a", online: true }];
    if (op.kind === "list") return { data: archived ? [] : [row], nextCursor: null };
    if (op.kind === "read") return { result: { thread: row }, epoch: "epoch", requests: [] };
    if (op.kind === "archive") {
      archived = op.archived;
      if (archived) {
        applied.resolve(undefined);
        await acknowledgement.promise;
      }
    }
    return {};
  });
  t.after(() => remote.close());
  const rpc = new RpcRegistry();
  for (const method of ["workspace/archiveSession", "workspace/unarchiveSession"])
    rpc.register(method, () => {
      throw new Error("must not route locally");
    });
  remote.install(rpc, new StreamRegistry());
  const id = remoteSessionId("remote-control:a", "native");
  const call = (method: string) => rpc.dispatch(method, { args: { request: { sessionId: id } } });
  const archiving = call("workspace/archiveSession");
  await applied.promise;
  await remote.refresh();
  acknowledgement.resolve(undefined);
  assert.deepEqual(await archiving, { ok: true, value: { archivedSessionIds: [id] } });
  assert.deepEqual(await call("workspace/unarchiveSession"), {
    ok: true,
    value: { archivedSessionIds: [] },
  });
});
it("returns local sessions while remote discovery is stalled", async (t) => {
  const release = Promise.withResolvers<undefined>();
  t.after(() => release.resolve(undefined));
  const remote = new RemoteSessions(new EventHub("slow"), async () => {
    await release.promise;
    return [];
  });
  t.after(() => remote.close());
  const rpc = new RpcRegistry();
  rpc.register("session/list", () => ({ items: [{ sessionId: "local" }] }));
  remote.install(rpc, new StreamRegistry());
  const result = await Promise.race([
    rpc.dispatch("session/list", {}),
    new Promise((resolve) => setTimeout(() => resolve("blocked"), 100)),
  ]);
  assert.deepEqual(result, { ok: true, value: { items: [{ sessionId: "local" }] } });
});
it("rejects oversized CJK/escaped prompts and invalid input before any write", async (t) => {
  const f = fixture();
  t.after(() => f.remote.close());
  for (const [text, code] of [
    ["中".repeat(6000), "remote/too-large"],
    ["\u0001".repeat(4000), "remote/too-large"],
    ["", "remote/invalid-request"],
    ["a".repeat(8001), "remote/too-large"],
  ]) {
    const result = await f.call("session/prompt", {
      sessionId: remoteSessionId("remote-control:b", "same"),
      content: [{ type: "text", text }],
    });
    assert.ok(!result.ok);
    assert.equal(result.error.code, code);
  }
  assert.equal(f.calls.filter((op) => op.kind === "prompt").length, 0);
});
it("aggregates native owners with distinct host/thread identities and no local cwd", async (t) => {
  const f = fixture();
  t.after(() => f.remote.close());
  await f.remote.refresh();
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
  await f.remote.refresh();
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
  type Frame = { type: string; agentId: string; eventId: string; event: string };
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
  assert.equal(selected.event, "approval/request");
  events.settle({
    eventId: selected.eventId,
    outcome: { kind: "resolved", value: "allowed-once" },
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

it(
  "keeps a following view alive across a transient read failure and stops on close",
  { timeout: 12000 },
  async (t) => {
    const hostId = "remote-ssh-discovered:a";
    let reads = 0,
      closed = false;
    const remote = new RemoteSessions(new EventHub("recovery"), async (op) => {
      if (op.kind === "hosts") return [{ hostId, online: true }];
      const row = {
        id: "same",
        cwd: "/remote",
        modelProvider: "openai",
        createdAt: 1,
        updatedAt: 2,
        status: { type: "idle" },
        turns: [],
        name: reads >= 3 ? "Recovered" : "Before",
      };
      if (op.kind === "list") return { data: [row], nextCursor: null };
      if (op.kind === "read") {
        reads++;
        if (reads === 2) throw Error("temporary disconnect");
        return {
          result: { thread: { ...row, name: reads >= 3 ? "Recovered" : "Before" } },
          epoch: "epoch",
          requests: [],
        };
      }
      return {};
    });
    t.after(() => remote.close());
    const streams = new StreamRegistry();
    let route: Parameters<StreamRegistry["routeSessions"]>[0] | undefined;
    streams.routeSessions = (value) => {
      route = value;
    };
    remote.install(new RpcRegistry(), streams);
    const frames: unknown[] = [];
    const closing: Array<() => void> = [];
    await defined(route)(
      "session/follow",
      { request: { address: { sessionId: remoteSessionId(hostId, "same") } } },
      {
        id: "follow",
        get closed() {
          return closed;
        },
        push: (x) => frames.push(x),
        end() {},
        fail() {},
        onClose: (fn) => {
          closing.push(fn);
        },
      },
      async () => {},
    );
    const deadline = Date.now() + 8000;
    while (reads < 3 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 50));
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(reads >= 3, "following must recover without reopening the session");
    assert.match(JSON.stringify(frames), /Recovered/);
    closed = true;
    for (const close of closing) close();
    const stopped = reads;
    await new Promise((resolve) => setTimeout(resolve, 1700));
    assert.equal(reads, stopped);
  },
);

it("serves cached remote projections and pages without refreshing or cancelling approvals", async (t) => {
  const hostId = "remote-ssh-discovered:a";
  let reads = 0,
    unavailable = false;
  const calls: string[] = [];
  const events = new EventHub("cached");
  const frames: unknown[] = [];
  await events.handler(
    {},
    { id: "events", closed: false, push: (x) => frames.push(x), end() {}, fail() {}, onClose() {} },
  );
  const row = {
    id: "thread",
    cwd: "/remote",
    modelProvider: "openai",
    createdAt: 1,
    updatedAt: 1,
    status: { type: "idle" },
    turns: [],
  };
  const remote = new RemoteSessions(events, async (op) => {
    calls.push(op.kind);
    if (op.kind === "hosts") return [{ hostId, online: true }];
    if (op.kind === "list") return { data: [row], nextCursor: null };
    if (op.kind === "read") {
      reads++;
      if (unavailable) throw Error("offline");
      return {
        result: { thread: row },
        epoch: "epoch",
        requests: [
          {
            id: 1,
            method: "item/commandExecution/requestApproval",
            params: { command: "echo test" },
          },
        ],
      };
    }
    return {};
  });
  t.after(() => remote.close());
  const rpc = new RpcRegistry();
  for (const method of ["session/projections", "session/page", "session/prompt"])
    rpc.register(method, () => {
      throw Error("local handler must not run");
    });
  remote.install(rpc, new StreamRegistry());
  const id = remoteSessionId(hostId, "thread");
  await remote.read(id);
  unavailable = true;
  const before = frames.length;
  const call = (method: string, extra: Record<string, unknown> = {}) =>
    rpc.dispatch(method, { args: { request: { sessionId: id, ...extra } } });
  assert.equal((await call("session/projections")).ok, true);
  assert.equal((await call("session/page", { throughSeq: 0 })).ok, true);
  assert.equal(reads, 1);
  assert.equal(frames.length, before);
  assert.equal(
    (await call("session/prompt", { content: [{ type: "text", text: "do not send" }] })).ok,
    false,
  );
  assert.equal(reads, 2);
  assert.equal(calls.includes("prompt"), false);
});
