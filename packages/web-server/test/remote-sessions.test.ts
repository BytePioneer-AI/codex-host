import { defined } from "./support/defined.ts";
import assert from "node:assert/strict";
import { it } from "node:test";
import { RemoteSessions, remoteSessionId, remoteSessionIdentity } from "../src/remote-sessions.ts";
import { PeerChHostClient, type PeerChTransport } from "../src/peer-ch-host-client.ts";
import { PeerThreadSource } from "../src/peer-thread-source.ts";
import { EventHub, RpcRegistry, StreamRegistry } from "../src/transport.ts";
import type { RemoteSessionOperation } from "@codexhost/shared-contracts";
import { RemoteSessionError, type HostClientUpdate } from "@codexhost/desktop-control";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { ChThread } from "../src/ch-thread-view.ts";
import type { StreamSink } from "../src/transport.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DataDir } from "../src/store.ts";
import { Workspaces } from "../src/workspaces.ts";

function paginatedUsageFixture(inspect: () => unknown) {
  const identity = { hostId: "remote-control:a", threadId: "same" };
  const sessionId = remoteSessionId(identity.hostId, identity.threadId);
  const host = { hostId: identity.hostId, online: true };
  const row: ChThread = {
    id: identity.threadId,
    cwd: "/remote",
    modelProvider: "openai",
    historyMode: "paginated",
    createdAt: 1,
    updatedAt: 2,
    status: { type: "idle" },
    turns: [],
  };
  const calls: RemoteSessionOperation[] = [];
  const remote = new RemoteSessions(new EventHub("remote-usage"), async (operation) => {
    if (operation.kind === "hosts") return [host];
    if (operation.kind === "list") return { data: [row], nextCursor: null };
    if (operation.kind === "read") {
      const { page } = operation;
      const turns = page?.sortDirection === "desc" ? [...row.turns].reverse() : row.turns;
      const start = page?.cursor ? turns.findIndex((turn) => turn.id === page.cursor) + 1 : 0;
      const data = page ? turns.slice(start, start + (page.limit ?? 20)) : turns;
      return {
        result: { thread: { ...row, turns: data } },
        ...(page
          ? { nextCursor: start + data.length < turns.length ? data.at(-1)?.id : null }
          : { configuration: { owner: "codex", locked: true } }),
        epoch: "epoch",
        requests: [],
      };
    }
    assert.equal(operation.kind, "usage");
    calls.push(operation);
    return { threadId: identity.threadId, usage: await inspect() };
  });
  return { identity, sessionId, host, row, calls, remote };
}

it("projects matching remote usage and makes repeat reads within the refresh period inexpensive", async (t) => {
  let usage = { cacheHitRatePercent: 97.8, totalCostUsd: 2.45 };
  const { identity, sessionId, row, calls, remote } = paginatedUsageFixture(() => usage);
  t.after(() => remote.close());

  const view = await remote.read(sessionId);
  await remote.read(sessionId);
  assert.deepEqual(calls, [{ kind: "usage", ...identity, epoch: "epoch" }]);
  assert.deepEqual(view.log.projections.codexhostUsage, { usage });

  row.updatedAt += 1;
  usage = { cacheHitRatePercent: 85, totalCostUsd: 2.7 };
  await remote.read(sessionId);
  assert.equal(calls.length, 2);
  assert.deepEqual(view.log.projections.codexhostUsage, { usage });
});

it("refreshes usage after a pending read and ignores an older catalog row", async (t) => {
  const identity = { hostId: "remote-control:a", threadId: "same" };
  const sessionId = remoteSessionId(identity.hostId, identity.threadId);
  const row = {
    id: identity.threadId,
    cwd: "/remote",
    modelProvider: "openai",
    createdAt: 1,
    updatedAt: 2,
    status: { type: "idle" },
    turns: [],
  };
  const first = Promise.withResolvers<unknown>();
  const latest = Promise.withResolvers<unknown>();
  let requests = 0;
  const remote = new RemoteSessions(new EventHub("remote-usage-refresh"), async (operation) => {
    if (operation.kind === "hosts") return [{ hostId: identity.hostId, online: true }];
    if (operation.kind === "list") return { data: [{ ...row, updatedAt: 2 }], nextCursor: null };
    if (operation.kind === "read")
      return { result: { thread: { ...row } }, epoch: "epoch", requests: [] };
    assert.equal(operation.kind, "usage");
    if (++requests === 1) return first.promise;
    return latest.promise;
  });
  t.after(() => remote.close());

  const view = await remote.read(sessionId);
  row.updatedAt = 3;
  await remote.read(sessionId);
  row.updatedAt = 4;
  await remote.read(sessionId);
  assert.equal(requests, 1);

  first.resolve({ threadId: identity.threadId, usage: { totalCostUsd: 1 } });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(requests, 2);
  assert.equal(view.log.projections.codexhostUsage, null);

  await remote.refresh();
  const usage = { cacheHitRatePercent: 86, totalCostUsd: 3 };
  latest.resolve({ threadId: identity.threadId, usage });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(view.log.projections.codexhostUsage, { usage });
  assert.equal(requests, 2);
});

it("refreshes usage when paginated history gains a Turn in the same second", async (t) => {
  let usage = { totalCostUsd: 1 };
  let pending: Promise<typeof usage> | undefined;
  const { sessionId, row, remote } = paginatedUsageFixture(() => pending ?? usage);
  t.after(() => remote.close());

  const view = await remote.read(sessionId);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(view.log.projections.codexhostUsage, { usage });

  row.turns.push({ id: "new", status: "completed", items: [] });
  usage = { totalCostUsd: 2 };
  await remote.read(sessionId);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(view.log.projections.codexhostUsage, { usage });

  const stale = Promise.withResolvers<typeof usage>();
  pending = stale.promise;
  row.turns.push({ id: "while-querying", status: "completed", items: [] });
  await remote.read(sessionId);
  row.turns.push({ id: "latest", status: "completed", items: [] });
  await remote.read(sessionId);
  const latest = Promise.withResolvers<typeof usage>();
  pending = latest.promise;
  stale.resolve({ totalCostUsd: 3 });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(view.log.projections.codexhostUsage, { usage });
  usage = { totalCostUsd: 4 };
  latest.resolve(usage);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(view.log.projections.codexhostUsage, { usage });
});

it("retries discarded usage on the first history read after reconnecting", async (t) => {
  const confirmed = { totalCostUsd: 1 };
  let usage: typeof confirmed | Promise<typeof confirmed> = confirmed;
  const { sessionId, host, row, remote } = paginatedUsageFixture(() => usage);
  t.after(() => remote.close());

  const view = await remote.read(sessionId);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const pending = Promise.withResolvers<typeof confirmed>();
  usage = pending.promise;
  row.updatedAt++;
  await remote.read(sessionId);
  host.online = false;
  await remote.refresh();
  pending.resolve({ totalCostUsd: 2 });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(view.log.projections.codexhostUsage, { usage: confirmed });

  host.online = true;
  usage = { totalCostUsd: 3 };
  await remote.refresh();
  await remote.read(sessionId);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(view.log.projections.codexhostUsage, { usage });
});

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
      if (op.kind === "queue") return { available: false };
      if (op.kind === "usage") throw new Error("method unavailable");
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

function fixture(readError?: Error) {
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
    if (operation.kind === "read") {
      if (readError) throw readError;
      return { epoch: "epoch-" + operation.hostId, result: { thread: row }, requests: [] };
    }
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
it("keeps history size errors distinct from an unavailable Desktop", async (t) => {
  const f = fixture(new RemoteSessionError(-32094, "A remote Turn exceeds the history page limit"));
  t.after(() => f.remote.close());
  const result = await f.call("session/projections", {
    sessionId: remoteSessionId("remote-ssh-discovered:a", "same"),
  });
  assert.ok(!result.ok);
  assert.equal(result.error.code, "remote/history-too-large");
  assert.equal(result.error.message, "A remote Turn exceeds the history page limit");
});
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

interface ExternalControlsFixtureOptions {
  modelThinkingAfterConfigure?: string;
  configureResult?: unknown;
  beforeConfigure?: (
    remote: RemoteSessions,
    operation: Extract<RemoteSessionOperation, { kind: "configure" }>,
  ) => void;
  takeNextReadGate?: () => Promise<unknown> | undefined;
  onReadGate?: () => void;
}

function externalControlsFixture(options: ExternalControlsFixtureOptions = {}) {
  const calls: RemoteSessionOperation[] = [];
  let includeMetadata = true;
  let modelId = "claude-model-v1.ZmFibGU";
  let thinkingOptionId = "medium";
  let permissionModeId = "default";
  const row = {
    id: "claude-thread",
    cwd: "/private/remote",
    name: "Claude remote",
    modelProvider: "codexhost",
    createdAt: 1,
    updatedAt: 2,
    status: { type: "idle" },
    turns: [],
  };
  const configuration = () => ({
    owner: "external" as const,
    harnessId: "claude-code",
    transportModelId: modelId,
    effectiveModel: { id: modelId },
    resolvedModelLabel: "Claude Code",
    effectiveThinkingOptionId: thinkingOptionId,
    availableThinkingOptions: [
      { id: "medium", label: "Medium" },
      { id: "high", label: "High" },
    ],
    effectivePermissionModeId: permissionModeId,
    history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
    locked: true as const,
  });
  const inspection = {
    status: "ready" as const,
    catalog: {
      models: [
        {
          ref: { id: "claude-model-v1.ZmFibGU" },
          label: "Claude model one",
          supportedThinkingOptionIds: ["medium", "high"],
        },
        {
          ref: { id: "claude-model-v2" },
          label: "Claude model two",
          supportedThinkingOptionIds: ["medium", "high"],
        },
      ],
      defaultModel: { id: "claude-model-v1.ZmFibGU" },
      thinkingOptions: [
        { id: "medium", label: "Medium" },
        { id: "high", label: "High" },
      ],
      defaultThinkingOptionId: "medium",
    },
    permissionModes: {
      modes: [
        { id: "default", label: "Default" },
        { id: "bypassPermissions", label: "Bypass permissions" },
      ],
      defaultModeId: "default",
    },
    capabilities: {
      configuration: {
        selectModel: true,
        selectThinkingOption: true,
        selectPermissionMode: true,
        permissionModeScope: "live" as const,
      },
      history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
    },
  };
  const harness = {
    id: "claude-code",
    name: "Claude Code",
    version: "1.0.0",
    icon: "data:image/png;base64,AA==",
  };
  const events = new EventHub("external-controls");
  const rpc = new RpcRegistry();
  for (const method of [
    "session/projections",
    "session/modelCatalog",
    "session/selectModel",
    "commands/execute",
  ])
    rpc.register(method, () => {
      throw new Error("must not route locally");
    });
  const remote = new RemoteSessions(events, async (operation) => {
    calls.push(operation);
    if (operation.kind === "hosts") return [{ hostId: "remote-control:claude", online: true }];
    if (operation.kind === "list")
      return {
        data: [{ ...row, status: { ...row.status }, turns: [...row.turns] }],
        nextCursor: null,
      };
    if (operation.kind === "read") {
      const snapshot = {
        result: { thread: { ...row, status: { ...row.status }, turns: [...row.turns] } },
        epoch: "claude-epoch",
        ...(includeMetadata ? { configuration: configuration(), inspection, harness } : {}),
        requests: [],
      };
      const gate = options.takeNextReadGate?.();
      if (gate !== undefined) {
        options.onReadGate?.();
        await gate;
      }
      return snapshot;
    }
    if (operation.kind === "configure") {
      options.beforeConfigure?.(remote, operation);
      if (operation.modelId !== undefined) {
        modelId = operation.modelId;
        if (options.modelThinkingAfterConfigure !== undefined)
          thinkingOptionId = options.modelThinkingAfterConfigure;
      }
      if (operation.thinkingOptionId !== undefined) thinkingOptionId = operation.thinkingOptionId;
      if (operation.permissionModeId !== undefined) permissionModeId = operation.permissionModeId;
      return (
        options.configureResult ?? {
          effectiveModel: { id: modelId },
          effectiveThinkingOptionId: thinkingOptionId,
          effectivePermissionModeId: permissionModeId,
        }
      );
    }
    return {};
  });
  remote.install(rpc, new StreamRegistry());
  const id = remoteSessionId("remote-control:claude", row.id);
  return {
    calls,
    events,
    remote,
    id,
    row,
    configuration,
    dropMetadata: () => {
      includeMetadata = false;
    },
    call: (method: string, request: object = {}) =>
      rpc.dispatch(method, { args: { request: { sessionId: id, ...request } } }),
  };
}

it("projects remote Harness controls and derives its catalog from remote inspection", async (t) => {
  const fixture = externalControlsFixture();
  t.after(() => fixture.remote.close());
  await fixture.remote.read(fixture.id);

  const projections = await fixture.call("session/projections");
  assert.ok(projections.ok, JSON.stringify(projections));
  const values = (projections.value as { values: Record<string, unknown> }).values;
  assert.deepEqual(values.harnessIdentity, {
    id: "claude-code",
    name: "Claude Code",
    icon: "data:image/png;base64,AA==",
  });
  assert.deepEqual(values.modelSelection, {
    lastUsed: {
      provider: "claude-code",
      model: "claude-model-v1.ZmFibGU",
      reasoningEffort: "medium",
    },
    next: {
      provider: "claude-code",
      model: "claude-model-v1.ZmFibGU",
      reasoningEffort: "medium",
    },
  });
  assert.deepEqual(values.permissions, { currentValue: "default" });
  assert.deepEqual(
    (values.nativePermissions as { harnessId: string; selectable: boolean }).harnessId,
    "claude-code",
  );
  assert.equal(
    (values.nativePermissions as { harnessId: string; selectable: boolean }).selectable,
    true,
  );

  const catalog = await fixture.call("session/modelCatalog");
  assert.ok(catalog.ok);
  assert.deepEqual((catalog.value as { groups: unknown[] }).groups, [
    {
      id: "claude-code",
      name: "Claude Code",
      models: [
        {
          id: "claude-model-v1.ZmFibGU",
          name: "Claude model one",
          reasoning: {
            efforts: [
              { id: "medium", name: "Medium" },
              { id: "high", name: "High" },
            ],
            defaultEffort: "medium",
          },
        },
        {
          id: "claude-model-v2",
          name: "Claude model two",
          reasoning: {
            efforts: [
              { id: "medium", name: "Medium" },
              { id: "high", name: "High" },
            ],
            defaultEffort: "medium",
          },
        },
      ],
    },
  ]);
});

it("routes remote model and permission changes as single-setting configure operations", async (t) => {
  const fixture = externalControlsFixture();
  t.after(() => fixture.remote.close());
  await fixture.remote.read(fixture.id);
  const before = fixture.calls.length;

  const modelResult = await fixture.call("session/selectModel", {
    provider: "claude-code",
    model: "claude-model-v2",
    reasoningEffort: "high",
  });
  assert.ok(modelResult.ok, JSON.stringify(modelResult));
  const modelOperations = fixture.calls
    .slice(before)
    .filter(
      (operation): operation is Extract<RemoteSessionOperation, { kind: "configure" }> =>
        operation.kind === "configure",
    );
  assert.equal(modelOperations.length, 2);
  assert.deepEqual(
    modelOperations.map(({ kind, epoch, hostId, threadId, ...settings }) => ({
      kind,
      epoch,
      hostId,
      threadId,
      settings,
    })),
    [
      {
        kind: "configure",
        epoch: "claude-epoch",
        hostId: "remote-control:claude",
        threadId: "claude-thread",
        settings: { modelId: "claude-model-v2" },
      },
      {
        kind: "configure",
        epoch: "claude-epoch",
        hostId: "remote-control:claude",
        threadId: "claude-thread",
        settings: { thinkingOptionId: "high" },
      },
    ],
  );
  for (const operation of modelOperations)
    assert.equal(
      [operation.modelId, operation.thinkingOptionId, operation.permissionModeId].filter(
        (value) => value !== undefined,
      ).length,
      1,
    );

  const permissionResult = await fixture.call("commands/execute", {
    line: "/permission bypassPermissions",
  });
  assert.ok(permissionResult.ok);
  const permissionOperation = fixture.calls.findLast((operation) => operation.kind === "configure");
  assert.equal(permissionOperation?.kind, "configure");
  assert.deepEqual(
    permissionOperation &&
      "permissionModeId" in permissionOperation && {
        permissionModeId: permissionOperation.permissionModeId,
      },
    { permissionModeId: "bypassPermissions" },
  );
});

it("re-reads after model selection before comparing the requested thinking option", async (t) => {
  const fixture = externalControlsFixture({ modelThinkingAfterConfigure: "high" });
  t.after(() => fixture.remote.close());
  await fixture.remote.read(fixture.id);
  const result = await fixture.call("session/selectModel", {
    provider: "claude-code",
    model: "claude-model-v2",
    reasoningEffort: "medium",
  });
  assert.ok(result.ok, JSON.stringify(result));
  const configureOperations = fixture.calls.filter(
    (operation): operation is Extract<RemoteSessionOperation, { kind: "configure" }> =>
      operation.kind === "configure",
  );
  assert.deepEqual(
    configureOperations.map(({ modelId, thinkingOptionId }) => ({ modelId, thinkingOptionId })),
    [
      { modelId: "claude-model-v2", thinkingOptionId: undefined },
      { modelId: undefined, thinkingOptionId: "medium" },
    ],
  );
});

it("does not redundantly configure thinking already selected by the model switch", async (t) => {
  const fixture = externalControlsFixture({ modelThinkingAfterConfigure: "high" });
  t.after(() => fixture.remote.close());
  await fixture.remote.read(fixture.id);
  const result = await fixture.call("session/selectModel", {
    provider: "claude-code",
    model: "claude-model-v2",
    reasoningEffort: "high",
  });
  assert.ok(result.ok, JSON.stringify(result));
  const configureOperations = fixture.calls.filter(
    (operation): operation is Extract<RemoteSessionOperation, { kind: "configure" }> =>
      operation.kind === "configure",
  );
  assert.deepEqual(configureOperations, [
    {
      kind: "configure",
      hostId: "remote-control:claude",
      threadId: "claude-thread",
      epoch: "claude-epoch",
      modelId: "claude-model-v2",
    },
  ]);
});

it("reports partial completion when the post-model read fails without replaying the model", async (t) => {
  let failRead = false;
  const fixture = externalControlsFixture({
    beforeConfigure: () => {
      failRead = true;
    },
    takeNextReadGate: () => {
      if (!failRead) return undefined;
      failRead = false;
      return Promise.reject(new Error("transient read failure"));
    },
  });
  t.after(() => fixture.remote.close());
  const result = await fixture.call("session/selectModel", {
    provider: "claude-code",
    model: "claude-model-v2",
    reasoningEffort: "high",
  });
  assert.ok(!result.ok);
  assert.equal(result.error.code, "remote/configuration-incomplete");
  assert.match(result.error.message, /Model.*confirmed.*Thinking/u);
  assert.deepEqual(
    fixture.calls.filter((op) => op.kind === "configure"),
    [
      {
        kind: "configure",
        hostId: "remote-control:claude",
        threadId: "claude-thread",
        epoch: "claude-epoch",
        modelId: "claude-model-v2",
      },
    ],
  );
  await fixture.remote.read(fixture.id);
  assert.equal(fixture.configuration().effectiveModel.id, "claude-model-v2");
  assert.equal(fixture.configuration().effectiveThinkingOptionId, "medium");
});

it("uses native confirmations when partial reads follow model changes in both directions", async (t) => {
  const fixture = externalControlsFixture({ beforeConfigure: () => fixture.dropMetadata() });
  t.after(() => fixture.remote.close());
  for (const model of ["claude-model-v2", "claude-model-v1.ZmFibGU"]) {
    const result = await fixture.call("session/selectModel", { provider: "claude-code", model });
    assert.ok(result.ok, JSON.stringify(result));
    assert.equal(fixture.configuration().effectiveModel.id, model);
    const projections = await fixture.call("session/projections");
    assert.ok(projections.ok);
    const values = (projections.value as { values: Record<string, unknown> }).values;
    assert.deepEqual(values.modelSelection, {
      lastUsed: { provider: "claude-code", model, reasoningEffort: "medium" },
      next: { provider: "claude-code", model, reasoningEffort: "medium" },
    });
  }
  assert.deepEqual(
    fixture.calls.filter((op) => op.kind === "configure").map((op) => op.modelId),
    ["claude-model-v2", "claude-model-v1.ZmFibGU"],
  );
});

for (const configureResult of [{}, { effectiveModel: { id: 42 } }])
  it(`does not retain stale settings after an unconfirmed configuration response ${JSON.stringify(configureResult)}`, async (t) => {
    const fixture = externalControlsFixture({
      configureResult,
      beforeConfigure: () => fixture.dropMetadata(),
    });
    t.after(() => fixture.remote.close());
    for (const model of ["claude-model-v2", "claude-model-v1.ZmFibGU"]) {
      const result = await fixture.call("session/selectModel", { provider: "claude-code", model });
      assert.ok(result.ok, JSON.stringify(result));
      assert.equal(fixture.configuration().effectiveModel.id, model);
      const projections = await fixture.call("session/projections");
      assert.ok(projections.ok);
      const values = (projections.value as { values: Record<string, unknown> }).values;
      assert.deepEqual(values.modelSelection, { lastUsed: null, next: null });
    }
    assert.equal(fixture.calls.filter((op) => op.kind === "configure").length, 2);
  });

it("compares Thinking with the model confirmation when optional read metadata is missing", async (t) => {
  const fixture = externalControlsFixture({
    modelThinkingAfterConfigure: "high",
    beforeConfigure: () => fixture.dropMetadata(),
  });
  t.after(() => fixture.remote.close());
  const result = await fixture.call("session/selectModel", {
    provider: "claude-code",
    model: "claude-model-v2",
    reasoningEffort: "medium",
  });
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(fixture.configuration().effectiveThinkingOptionId, "medium");
  assert.deepEqual(
    fixture.calls.filter((op) => op.kind === "configure").map((op) => op.thinkingOptionId),
    [undefined, "medium"],
  );
});

it("does not let a pre-configure read overwrite an acknowledged model selection", async (t) => {
  const staleRead = Promise.withResolvers<undefined>();
  const staleReadStarted = Promise.withResolvers<undefined>();
  let armStaleRead = false;
  const fixture = externalControlsFixture({
    beforeConfigure: (remote, operation) => {
      if (operation.modelId !== "claude-model-v2") return;
      armStaleRead = true;
      void remote.read(remoteSessionId("remote-control:claude", "claude-thread"));
    },
    takeNextReadGate: () => {
      if (!armStaleRead) return undefined;
      armStaleRead = false;
      return staleRead.promise;
    },
    onReadGate: () => staleReadStarted.resolve(undefined),
  });
  t.after(() => fixture.remote.close());
  await fixture.remote.read(fixture.id);

  let settled = false;
  const selection = fixture.call("session/selectModel", {
    provider: "claude-code",
    model: "claude-model-v2",
  });
  await staleReadStarted.promise;
  void selection.then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false, "configure waits for the overlapping stale read");

  staleRead.resolve(undefined);
  const result = await selection;
  assert.ok(result.ok, JSON.stringify(result));
  const projections = await fixture.call("session/projections");
  assert.ok(projections.ok);
  const values = (projections.value as { values: Record<string, unknown> }).values;
  assert.deepEqual(values.modelSelection, {
    lastUsed: { provider: "claude-code", model: "claude-model-v2", reasoningEffort: "medium" },
    next: { provider: "claude-code", model: "claude-model-v2", reasoningEffort: "medium" },
  });
});

it("retains same-epoch remote controls across partial reads and catalog refresh summaries", async (t) => {
  const fixture = externalControlsFixture();
  t.after(() => fixture.remote.close());
  const summaries: Array<{ projections: { values: Record<string, unknown> }; running: boolean }> =
    [];
  fixture.events.emit = (event, ...args) => {
    if (event === "api-session/added") summaries.push(args[0] as (typeof summaries)[number]);
  };
  await fixture.remote.read(fixture.id);
  fixture.dropMetadata();
  await fixture.remote.read(fixture.id);
  const projections = await fixture.call("session/projections");
  assert.ok(projections.ok);
  const values = (projections.value as { values: Record<string, unknown> }).values;
  assert.deepEqual(values.harnessIdentity, {
    id: "claude-code",
    name: "Claude Code",
    icon: "data:image/png;base64,AA==",
  });
  assert.equal((values.nativePermissions as { harnessId: string }).harnessId, "claude-code");

  summaries.length = 0;
  fixture.row.status.type = "active";
  await fixture.remote.refresh();
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0]?.running, true);
  assert.deepEqual(summaries[0]?.projections.values.harnessIdentity, {
    id: "claude-code",
    name: "Claude Code",
    icon: "data:image/png;base64,AA==",
  });
});

it("keeps remote history readable and controls unavailable without optional metadata", async (t) => {
  const row = {
    id: "metadata-less",
    cwd: "/private/remote",
    name: "Metadata-less remote",
    modelProvider: "codexhost",
    createdAt: 1,
    updatedAt: 2,
    status: { type: "idle" },
    turns: [
      {
        id: "turn-1",
        status: "completed",
        items: [{ id: "item-1", type: "text", text: "history" }],
      },
    ],
  };
  const calls: RemoteSessionOperation[] = [];
  const remote = new RemoteSessions(new EventHub("metadata-less"), async (operation) => {
    calls.push(operation);
    if (operation.kind === "hosts") return [{ hostId: "remote-control:plain", online: true }];
    if (operation.kind === "list") return { data: [row], nextCursor: null };
    if (operation.kind === "read")
      return { result: { thread: row }, epoch: "plain-epoch", requests: [] };
    return {};
  });
  t.after(() => remote.close());
  const rpc = new RpcRegistry();
  for (const method of ["session/projections", "session/page", "session/selectModel"])
    rpc.register(method, () => {
      throw new Error("must not route locally");
    });
  remote.install(rpc, new StreamRegistry());
  const id = remoteSessionId("remote-control:plain", row.id);
  await remote.read(id);
  const projections = await rpc.dispatch("session/projections", {
    args: { request: { sessionId: id } },
  });
  assert.ok(projections.ok);
  const values = (projections.value as { values: Record<string, unknown> }).values;
  assert.equal(values.nativePermissions, null);
  assert.deepEqual(values.modelSelection, { lastUsed: null, next: null });
  assert.equal(values.harnessIdentity, null);
  assert.ok(
    (
      await rpc.dispatch("session/page", {
        args: { request: { sessionId: id, throughSeq: 0 } },
      })
    ).ok,
  );
  const rejected = await rpc.dispatch("session/selectModel", {
    args: { request: { sessionId: id, provider: "claude-code", model: "claude-model-v2" } },
  });
  assert.ok(!rejected.ok);
  assert.equal(rejected.error.code, "remote/unsupported");
  assert.equal(
    calls.some((operation) => operation.kind === "configure"),
    false,
  );
});

it("does not spin the microtask queue when hostsChanged fires during an archive write", async (t) => {
  const hostA = "remote-peer:peer-a";
  const hostB = "remote-peer:peer-b";
  const hostC = "remote-peer:peer-c";
  const rowA = {
    id: "thread-a",
    cwd: "/remote/a",
    name: "Thread A",
    modelProvider: "openai",
    createdAt: 1,
    updatedAt: 2,
    status: { type: "idle" },
    turns: [],
  };
  let archived = false;
  const listCounts = new Map<string, number>();
  const archiveStarted = Promise.withResolvers<undefined>();
  const archiveGate = Promise.withResolvers<unknown>();
  const postArchiveList = Promise.withResolvers<undefined>();
  let waitingForPostArchiveList = false;

  const remote = new RemoteSessions(new EventHub("remote-archive-refresh"), async (operation) => {
    if (operation.kind === "hosts") {
      return [
        { hostId: hostA, online: true },
        { hostId: hostB, online: true },
        { hostId: hostC, online: true },
      ];
    }
    if (operation.kind === "list") {
      listCounts.set(operation.hostId, (listCounts.get(operation.hostId) ?? 0) + 1);
      if (waitingForPostArchiveList && operation.hostId === hostA) {
        waitingForPostArchiveList = false;
        postArchiveList.resolve(undefined);
      }
      return {
        data: operation.hostId === hostA && !archived ? [rowA] : [],
        nextCursor: null,
      };
    }
    if (operation.kind === "read") {
      return { result: { thread: rowA }, epoch: "epoch-a", requests: [] };
    }
    if (operation.kind === "archive") {
      archiveStarted.resolve(undefined);
      await archiveGate.promise;
      archived = operation.archived;
      return {};
    }
    return {};
  });
  t.after(() => remote.close());

  const rpc = new RpcRegistry();
  rpc.register("session/archive", () => {
    throw new Error("must not route locally");
  });
  remote.install(rpc, new StreamRegistry());

  const sessionId = remoteSessionId(hostA, rowA.id);
  await remote.refresh();
  await remote.read(sessionId);
  const initialCountA = listCounts.get(hostA) ?? 0;
  const initialCountB = listCounts.get(hostB) ?? 0;
  const initialCountC = listCounts.get(hostC) ?? 0;

  const archivePromise = rpc.dispatch("session/archive", {
    args: { request: { sessionId } },
  });
  await archiveStarted.promise;

  // Trigger refreshes for two distinct peers while archiveWrites > 0.
  // Before the fix, this entered a tight microtask loop that starved setTimeout.
  waitingForPostArchiveList = true;
  remote.hostsChanged(hostA);
  remote.hostsChanged(hostB);
  setTimeout(() => archiveGate.resolve({}), 30);

  const archiveResult = await archivePromise;
  assert.equal(archiveResult.ok, true);
  await postArchiveList.promise;
  await new Promise<void>((resolve) => setTimeout(resolve, 20));

  assert.equal(listCounts.get(hostA), initialCountA + 1);
  assert.equal(listCounts.get(hostB), initialCountB + 1);
  // Multi-host dirty queue must not escalate into a full refresh of untouched peers.
  assert.equal(listCounts.get(hostC), initialCountC);
});

it("unarchives an archived remote session without calling read/snapshot beforehand", async (t) => {
  const hostId = "remote-peer:peer-b";
  const row = {
    id: "thread-archived",
    cwd: "/remote/b",
    name: "Archived Remote",
    modelProvider: "openai",
    createdAt: 1,
    updatedAt: 2,
    status: { type: "idle" },
    turns: [],
  };
  let archived = true;
  const order: string[] = [];
  const remote = new RemoteSessions(new EventHub("remote-unarchive"), async (operation) => {
    if (operation.kind === "hosts") return [{ hostId, online: true, epoch: "epoch-b" }];
    if (operation.kind === "list") {
      return { data: archived ? [] : [row], nextCursor: null };
    }
    if (operation.kind === "read") {
      order.push("read");
      if (archived) {
        throw new Error(
          `session ${row.id} is archived. Run codex unarchive to unarchive it first.`,
        );
      }
      return { result: { thread: row }, epoch: "epoch-b", requests: [] };
    }
    if (operation.kind === "archive") {
      order.push(operation.archived ? "archive" : "unarchive");
      archived = operation.archived;
      return {};
    }
    return {};
  });
  t.after(() => remote.close());

  const rpc = new RpcRegistry();
  rpc.register("workspace/unarchiveSession", () => {
    throw new Error("must not route locally");
  });
  rpc.register("session/unarchive", () => {
    throw new Error("must not route locally");
  });
  remote.install(rpc, new StreamRegistry());

  const sessionId = remoteSessionId(hostId, row.id);
  const reply = await rpc.dispatch("workspace/unarchiveSession", {
    args: { request: { sessionId } },
  });
  assert.equal(reply.ok, true);
  assert.equal(archived, false);
  // Must invoke unarchive BEFORE attempting any snapshot/read.
  assert.deepEqual(order, ["unarchive", "read"]);
});

it("uses PeerThreadSource for event-driven follow, incremental paging, harness identity, draft catalog, tree parents, and archive cascade", async (t) => {
  const hostId = "remote-peer:peer-layered";
  const epoch = randomUUID();
  let seq = 1;
  const listeners = new Set<(update: HostClientUpdate) => void>();
  const emit = (update: HostClientUpdate) => {
    for (const listener of [...listeners]) listener(update);
  };
  const makeTurns = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      id: `turn-${i + 1}`,
      status: "completed",
      items: [
        { id: `u-${i + 1}`, type: "userMessage", content: [{ type: "text", text: `Q${i + 1}` }] },
        { id: `a-${i + 1}`, type: "agentMessage", text: `A${i + 1}` },
      ],
    }));

  const parentRow: ChThread = {
    id: "parent-thread",
    cwd: "/remote/secret/repo",
    name: "Parent Thread",
    modelProvider: "codexhost",
    historyMode: "paginated",
    createdAt: 100,
    updatedAt: 200,
    status: { type: "idle" },
    turns: makeTurns(12),
  };
  const childRow: ChThread = {
    id: "child-thread",
    cwd: "/remote/secret/repo",
    name: "Child Thread",
    modelProvider: "openai",
    historyMode: "paginated",
    createdAt: 110,
    updatedAt: 210,
    status: { type: "idle" },
    turns: makeTurns(1),
  };
  const threads = new Map<string, ChThread>([
    [parentRow.id, parentRow],
    [childRow.id, childRow],
  ]);
  const archivedIds = new Set<string>();
  const treeParents: Record<string, string> = { [childRow.id]: parentRow.id };
  const rpcLog: Array<{ method: string; params: Record<string, unknown> }> = [];
  let snapshotCalls = 0;
  let inspectCalls = 0;
  let activeModelId = "claude-one";

  const inspection = {
    status: "ready" as const,
    catalog: {
      models: [
        { ref: { id: "claude-one" }, label: "Claude One", supportedThinkingOptionIds: ["medium"] },
        { ref: { id: "claude-two" }, label: "Claude Two", supportedThinkingOptionIds: ["medium"] },
      ],
      defaultModel: { id: "claude-one" },
      thinkingOptions: [{ id: "medium", label: "Medium" }],
      defaultThinkingOptionId: "medium",
    },
    capabilities: {
      configuration: {
        selectModel: true,
        selectThinkingOption: true,
        selectPermissionMode: false,
        permissionModeScope: "live" as const,
      },
      history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
    },
  };

  const transport: PeerChTransport = {
    async post<T>(route: "rpc" | "snapshot" | "respond", body: object): Promise<T> {
      const input = body as Record<string, unknown>;
      if (route === "snapshot") {
        snapshotCalls++;
        const row = defined(threads.get(String(input.threadId)));
        return {
          cursor: { epoch, sequence: seq },
          thread: { ...row, turns: [] },
          turnsPage: {
            data: structuredClone(row.turns.slice(-5).reverse()),
            nextCursor: row.turns.length > 5 ? (row.turns.at(-5)?.id ?? null) : null,
          },
          configuration: { effectiveModel: { id: activeModelId } },
          queue: { items: [], pausedReason: null },
          interactions: [],
        } as T;
      }
      if (route === "respond") return { resolved: true } as T;
      const method = String(input.method);
      const params = (input.params ?? {}) as Record<string, unknown>;
      rpcLog.push({ method, params });
      if (method === "codexhost/thread/catalog/read") {
        const visible = [...threads.values()].filter(
          (row) => params.includeArchived === true || !archivedIds.has(row.id),
        );
        return {
          threads: visible.map((row) => ({ ...row, turns: [] })),
          ownership: visible.map((row) =>
            row.modelProvider === "codexhost"
              ? { threadId: row.id, owner: "external", harnessId: "claude-code" }
              : { threadId: row.id, owner: "codex" },
          ),
          officialCursor: { live: null },
          archivedThreadIds: [...archivedIds],
        } as T;
      }
      if (method === "codexhost/thread/tree/read") return { parents: { ...treeParents } } as T;
      if (method === "codexhost/harness/plugins/list") {
        return {
          plugins: [
            {
              id: "claude-code",
              name: "Claude Code",
              version: "1.0.0",
              icon: "data:image/png;base64,AA==",
            },
          ],
        } as T;
      }
      if (method === "codexhost/harness/inspect") {
        if (params.harnessId === "codex") {
          return {
            status: "notInstalled",
            error: { code: "unavailable", message: "No Codex", retryable: false },
          } as T;
        }
        return inspection as T;
      }
      if (method === "codexhost/thread/inspect") {
        inspectCalls++;
        const tid = String(params.threadId);
        if (tid === parentRow.id) {
          return {
            owner: "external",
            harnessId: "claude-code",
            transportModelId: activeModelId,
            effectiveModel: { id: activeModelId },
            locked: true,
            history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
          } as T;
        }
        return { owner: "codex", locked: true } as T;
      }
      if (method === "thread/turns/list") {
        const row = defined(threads.get(String(params.threadId)));
        const ordered = [...row.turns].reverse();
        const anchor = typeof params.cursor === "string" ? params.cursor : undefined;
        const start = anchor ? ordered.findIndex((turn) => turn.id === anchor) + 1 : 0;
        const limit = Number(params.limit ?? 5);
        const page = ordered.slice(start, start + limit);
        return {
          data: structuredClone(page),
          nextCursor: start + page.length < ordered.length ? (page.at(-1)?.id ?? null) : null,
        } as T;
      }
      throw new Error(`Unexpected peer RPC: ${method}`);
    },
    subscribe(listener) {
      listeners.add(listener);
      listener({ type: "connection", online: true });
      listener({ type: "hello", version: 1, cursor: { epoch, sequence: seq }, reset: false });
      return () => {
        listeners.delete(listener);
      };
    },
    manifest: () => ({
      version: "1.0.0",
      platform: "darwin",
      hostname: "peer-layered",
      epoch,
      projects: [{ id: "proj-1", name: "Repo", path: "/remote/secret/repo", threadIds: [] }],
    }),
  };

  let onThreadChanged: ((h: string, tid: string) => unknown) | undefined;
  let onConnection: ((h: string, online: boolean) => void) | undefined;
  let onReset: ((h: string, e: string, full: boolean) => void) | undefined;
  const source = new PeerThreadSource({
    hostId,
    host: new PeerChHostClient(transport),
    onCatalogChanged: () => remote.hostsChanged(hostId),
    onThreadChanged: (tid) => onThreadChanged?.(hostId, tid),
    onConnection: (online) => onConnection?.(hostId, online),
    onReset: (e, full) => onReset?.(hostId, e, full),
  });
  const peerProvider = {
    source: (h: string) => (h === hostId ? source : undefined),
    get onThreadChanged() {
      return onThreadChanged;
    },
    set onThreadChanged(fn) {
      onThreadChanged = fn;
    },
    get onConnection() {
      return onConnection;
    },
    set onConnection(fn) {
      onConnection = fn;
    },
    get onReset() {
      return onReset;
    },
    set onReset(fn) {
      onReset = fn;
    },
  };

  const opLog: RemoteSessionOperation[] = [];
  const dir = mkdtempSync(join(tmpdir(), "remote-peer-layered-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const workspaces = new Workspaces(new DataDir(dir), dir);
  const remote: RemoteSessions = new RemoteSessions(
    new EventHub("peer-layered"),
    async (op) => {
      opLog.push(op);
      if (op.kind === "hosts") {
        return [
          {
            hostId,
            online: true,
            epoch,
            displayName: "Peer Layered",
            projects: [{ id: "proj-1", name: "Repo", path: "/remote/secret/repo", threadIds: [] }],
          },
        ];
      }
      if (op.kind === "configure" && op.modelId) {
        activeModelId = op.modelId;
        return { effectiveModel: { id: activeModelId } };
      }
      if (op.kind === "archive") {
        if (op.archived) archivedIds.add(op.threadId);
        else archivedIds.delete(op.threadId);
        return {};
      }
      if (op.kind === "usage") {
        return { threadId: op.threadId, usage: { totalCostUsd: 0.5 } };
      }
      throw new Error(`Unexpected legacy op for Peer: ${op.kind}`);
    },
    workspaces,
    peerProvider,
  );
  t.after(() => {
    remote.close();
    source.close();
  });

  const rpc = new RpcRegistry();
  const streams = new StreamRegistry();
  for (const method of [
    "session/list",
    "session/create",
    "session/modelCatalog",
    "session/selectModel",
    "session/page",
    "session/projections",
    "workspace/archiveSession",
    "workspace/unarchiveSession",
  ]) {
    rpc.register(method, () => (method === "session/list" ? { items: [] } : {}));
  }
  let streamRouter: Parameters<StreamRegistry["routeSessions"]>[0] | undefined;
  streams.routeSessions = (value) => {
    streamRouter = value;
  };
  remote.install(rpc, streams);

  // 1. Refresh lists via PeerThreadSource: no legacy "list" op, cwd="", harnessIdentity without icon, tree parent mapped.
  await remote.refresh();
  assert.equal(
    opLog.some((op) => op.kind === "list"),
    false,
  );
  const listed = await rpc.dispatch("session/list", {});
  assert.ok(listed.ok);
  const items = (
    listed.value as {
      items: Array<{
        sessionId: string;
        cwd: string;
        projections: { values: Record<string, unknown> };
      }>;
    }
  ).items;
  const parentSessionId = remoteSessionId(hostId, parentRow.id);
  const childSessionId = remoteSessionId(hostId, childRow.id);
  const parentItem = defined(items.find((i) => i.sessionId === parentSessionId));
  const childItem = defined(items.find((i) => i.sessionId === childSessionId));
  assert.equal(parentItem.cwd, "");
  assert.equal(childItem.cwd, "");
  assert.deepEqual(parentItem.projections.values.harnessIdentity, {
    id: "claude-code",
    name: "Claude Code",
  });
  assert.equal("icon" in (parentItem.projections.values.harnessIdentity as object), false);
  assert.equal(parentItem.projections.values.threadTreeParent, null);
  assert.equal(childItem.projections.values.threadTreeParent, parentSessionId);

  // 2. Follow is event-driven (no polling), first screen reads only 5 turns, session/page loads older pages.
  const followFrames: unknown[] = [];
  const closeListeners: Array<() => void> = [];
  let followClosed = false;
  await defined(streamRouter)(
    "session/follow",
    { request: { address: { sessionId: parentSessionId } } },
    {
      id: "peer-follow",
      get closed() {
        return followClosed;
      },
      push: (frame) => followFrames.push(frame),
      end() {},
      fail() {},
      onClose: (fn) => closeListeners.push(fn),
    },
    async () => {},
  );
  const firstSnap = defined(followFrames[0]) as {
    type: string;
    cursor: number;
    hasMore: boolean;
    records: Array<{ event: { seq: number } }>;
  };
  assert.equal(firstSnap.type, "snapshot");
  assert.equal(firstSnap.hasMore, true);
  assert.equal(snapshotCalls, 1);
  assert.equal(inspectCalls, 1);
  assert.equal(
    opLog.some((op) => op.kind === "read" || op.kind === "queue"),
    false,
  );

  // Load older page via session/page -> ChThreadHistory.olderPage calls thread/turns/list.
  const pageResult = await rpc.dispatch("session/page", {
    args: {
      request: {
        sessionId: parentSessionId,
        throughSeq: firstSnap.cursor,
        beforeSeq: defined(firstSnap.records[0]).event.seq,
      },
    },
  });
  assert.ok(pageResult.ok);
  assert.ok(rpcLog.some((r) => r.method === "thread/turns/list"));

  // Push a new turn via Peer changed event (no polling) and verify it appears in followFrames.
  parentRow.turns.push({
    id: "turn-13",
    status: "completed",
    items: [
      { id: "u-13", type: "userMessage", content: [{ type: "text", text: "Live Q13" }] },
      { id: "a-13", type: "agentMessage", text: "Live A13" },
    ],
  });
  parentRow.updatedAt += 10;
  emit({
    type: "changed",
    cursor: { epoch, sequence: ++seq },
    threadId: parentRow.id,
    method: "turn/completed",
  });
  for (let i = 0; i < 40 && !JSON.stringify(followFrames).includes("Live A13"); i++) {
    await sleep(25);
  }
  assert.match(JSON.stringify(followFrames), /Live A13/);
  // codexhost/thread/inspect was NOT re-called on same-view refresh!
  assert.equal(inspectCalls, 1);

  // Configuring model invalidates inspect cache so the next read re-inspects.
  const selectResult = await rpc.dispatch("session/selectModel", {
    args: { request: { sessionId: parentSessionId, provider: "claude-code", model: "claude-two" } },
  });
  assert.ok(selectResult.ok, JSON.stringify(selectResult));
  assert.equal(inspectCalls, 2);

  // Close follow sink and verify no further snapshots occur on subsequent events.
  followClosed = true;
  for (const fn of closeListeners) fn();
  const snapsAfterClose = snapshotCalls;
  emit({
    type: "changed",
    cursor: { epoch, sequence: ++seq },
    threadId: parentRow.id,
    method: "turn/completed",
  });
  await sleep(160);
  assert.equal(snapshotCalls, snapsAfterClose);

  // 3. Peer draft modelCatalog uses source.catalog.models() without projectHarnesses/inspectHarness ops.
  const ws = defined(workspaces.list().find((w) => w.remote?.hostId === hostId));
  const created = await rpc.dispatch("session/create", {
    args: { request: { workspaceId: ws.workspaceId } },
  });
  assert.ok(created.ok);
  const draftId = (created.value as { sessionId: string }).sessionId;
  const draftCatalog = await rpc.dispatch("session/modelCatalog", {
    args: { request: { sessionId: draftId } },
  });
  assert.ok(draftCatalog.ok);
  assert.deepEqual((draftCatalog.value as { routableProviders: string[] }).routableProviders, [
    "claude-code",
  ]);
  assert.equal(
    opLog.some((op) => op.kind === "projectHarnesses" || op.kind === "inspectHarness"),
    false,
  );

  // 4. Archive & unarchive cascade to child thread via source.tree.archive.
  const archiveReply = await rpc.dispatch("workspace/archiveSession", {
    args: { request: { sessionId: parentSessionId } },
  });
  assert.ok(archiveReply.ok);
  assert.equal(archivedIds.has(parentRow.id), true);
  assert.equal(archivedIds.has(childRow.id), true);

  const unarchiveReply = await rpc.dispatch("workspace/unarchiveSession", {
    args: { request: { sessionId: parentSessionId } },
  });
  assert.ok(unarchiveReply.ok);
  assert.equal(archivedIds.has(parentRow.id), false);
  assert.equal(archivedIds.has(childRow.id), false);
});

it("derives remote list titles via threadListTitle without leaking cwd and generates titles on peer firstTurn", async (t) => {
  const hostId = "remote-peer:title-peer";
  const epoch = "epoch-title-1";
  const rows: ChThread[] = [
    {
      id: "uuid-posix",
      name: null,
      preview: "",
      cwd: "/remote/合同处理",
      modelProvider: "openai",
      createdAt: 1,
      updatedAt: 10,
      status: { type: "active", activeFlags: [] },
      turns: [],
    },
    {
      id: "uuid-whitespace",
      name: "   ",
      preview: "  \n\t  ",
      cwd: "/remote/project-a",
      modelProvider: "openai",
      createdAt: 1,
      updatedAt: 9,
      status: { type: "idle" },
      turns: [],
    },
    {
      id: "uuid-win",
      name: null,
      preview: "",
      cwd: "C:\\Users\\dev\\合同处理",
      modelProvider: "openai",
      createdAt: 1,
      updatedAt: 8,
      status: { type: "idle" },
      turns: [],
    },
    {
      id: "uuid-long",
      name: null,
      preview: `  hello\n\t ${"a".repeat(90)}`,
      cwd: "/remote/x",
      modelProvider: "openai",
      createdAt: 1,
      updatedAt: 7,
      status: { type: "idle" },
      turns: [],
    },
  ];
  const createdThread: ChThread = {
    id: "uuid-created",
    name: null,
    preview: "",
    cwd: "/remote/合同处理",
    modelProvider: "openai",
    createdAt: 1,
    updatedAt: 20,
    status: { type: "active", activeFlags: [] },
    turns: [],
  };
  let createdInCatalog = false;
  let releaseTitle: (() => void) | undefined;
  const titleGate = new Promise<void>((resolve) => {
    releaseTitle = resolve;
  });
  let generateCalls = 0;

  const manifest = {
    version: "1",
    epoch,
    platform: process.platform,
    hostname: "title-peer",
    homeDir: "/remote",
    projects: [{ id: "proj-1", name: "合同处理", path: "/remote/合同处理", threadIds: [] }],
  };
  const transport: PeerChTransport = {
    manifest: () => manifest,
    subscribe: (listener) => {
      listener({ type: "connection", online: true });
      listener({ type: "hello", version: 1, cursor: { epoch, sequence: 1 }, reset: true });
      return () => {};
    },
    async post<T>(route: "rpc" | "snapshot" | "respond", body: object): Promise<T> {
      if (route === "snapshot") {
        const req = body as { threadId: string };
        const found =
          (createdInCatalog && req.threadId === createdThread.id
            ? createdThread
            : rows.find((r) => r.id === req.threadId)) ?? createdThread;
        return {
          cursor: { epoch, sequence: 1 },
          thread: found,
          turnsPage: { data: [], nextCursor: null },
          configuration: {},
          interactions: [],
        } as T;
      }
      const { method, params } = body as { method: string; params: Record<string, unknown> };
      const activeRows = createdInCatalog ? [...rows, createdThread] : rows;
      if (method === "codexhost/thread/catalog/read") {
        return {
          threads: activeRows,
          ownership: activeRows.map((r) => ({ threadId: r.id, owner: "codex" })),
          officialCursor: { live: null },
          archivedThreadIds: [],
        } as T;
      }
      if (method === "codexhost/thread/tree/read") return { parents: {} } as T;
      if (method === "codexhost/harness/plugins/list") return { plugins: [] } as T;
      if (method === "codexhost/harness/inspect") {
        return {
          status: "ready",
          catalog: {
            models: [{ ref: { id: "gpt-5.4" }, label: "GPT-5.4", supportedThinkingOptionIds: [] }],
            defaultModel: { id: "gpt-5.4" },
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
        } as T;
      }
      if (method === "codexhost/thread/title/generate") {
        generateCalls += 1;
        await titleGate;
        return "合同要点整理" as T;
      }
      if (method === "thread/read") {
        return { thread: createdThread } as T;
      }
      if (method === "thread/name/set") {
        createdThread.name = String(params.name ?? "");
        return {} as T;
      }
      return {} as T;
    },
  };

  const root = mkdtempSync(join(tmpdir(), "remote-title-"));
  const workspaces = new Workspaces(new DataDir(root), root);
  const events = new EventHub("remote-title");
  const peerSource = new PeerThreadSource({
    hostId,
    host: new PeerChHostClient(transport),
    onCatalogChanged: () => remote.hostsChanged(hostId),
    onThreadChanged: () => undefined,
    onConnection: () => undefined,
  });
  const remote: RemoteSessions = new RemoteSessions(
    events,
    async (op) => {
      if (op.kind === "hosts") {
        return [
          {
            hostId,
            online: true,
            epoch,
            displayName: "title-peer",
            projects: manifest.projects,
          },
        ];
      }
      if (op.kind === "create" || op.kind === "startSelected") {
        createdInCatalog = true;
        return { thread: createdThread };
      }
      if (op.kind === "prompt") {
        return { turn: { id: "turn-1" } };
      }
      throw new Error(`Unexpected op: ${op.kind}`);
    },
    workspaces,
    { source: (id) => (id === hostId ? peerSource : undefined) },
  );
  t.after(() => {
    releaseTitle?.();
    remote.close();
    peerSource.close();
    rmSync(root, { recursive: true, force: true });
  });

  const rpc = new RpcRegistry();
  const streams = new StreamRegistry();
  for (const method of ["session/list", "session/create", "session/prompt"]) {
    rpc.register(method, () => (method === "session/list" ? { items: [] } : {}));
  }
  workspaces.register(rpc, streams);
  remote.install(rpc, streams);
  await remote.refresh();

  type ListEntry = {
    sessionId: string;
    cwd: string;
    projections: { values: { title: string } };
  };
  const listSessions = async (): Promise<ListEntry[]> => {
    const res = await rpc.dispatch("session/list", {});
    assert.ok(res.ok);
    return (res.value as { items: ListEntry[] }).items;
  };

  const listed = await listSessions();
  const byId = new Map(listed.map((s) => [s.sessionId, s]));
  const posixSession = defined(byId.get(remoteSessionId(hostId, "uuid-posix")));
  assert.equal(posixSession.projections.values.title, "合同处理");
  assert.equal(posixSession.cwd, "");

  assert.equal(
    defined(byId.get(remoteSessionId(hostId, "uuid-whitespace"))).projections.values.title,
    "project-a",
  );
  assert.equal(
    defined(byId.get(remoteSessionId(hostId, "uuid-win"))).projections.values.title,
    "合同处理",
  );
  assert.equal(
    defined(byId.get(remoteSessionId(hostId, "uuid-long"))).projections.values.title,
    `${`hello ${"a".repeat(90)}`.slice(0, 80)}…`,
  );

  // Creating a new peer session and sending its first turn shows project basename before title generation,
  // then updates to the generated title via tryGenerateThreadTitle + hostsChanged.
  const ws = defined(workspaces.list().find((w) => w.remote?.hostId === hostId));
  const created = await rpc.dispatch("session/create", {
    args: { request: { workspaceId: ws.workspaceId } },
  });
  assert.ok(created.ok);
  const draftId = (created.value as { sessionId: string }).sessionId;
  const sent = await rpc.dispatch("session/prompt", {
    args: {
      request: {
        sessionId: draftId,
        content: [{ type: "text", text: "帮我整理这份合同要点" }],
      },
    },
  });
  assert.ok(sent.ok, JSON.stringify(sent));

  const createdSessionId = remoteSessionId(hostId, createdThread.id);
  const beforeTitle = defined((await listSessions()).find((s) => s.sessionId === createdSessionId));
  assert.equal(beforeTitle.projections.values.title, "合同处理");
  assert.equal(beforeTitle.cwd, "");

  releaseTitle?.();
  for (let i = 0; i < 60; i++) {
    const afterTitle = (await listSessions()).find((s) => s.sessionId === createdSessionId);
    if (afterTitle?.projections.values.title === "合同要点整理") break;
    await sleep(25);
  }
  assert.equal(generateCalls, 1);
  assert.equal(
    defined((await listSessions()).find((s) => s.sessionId === createdSessionId)).projections.values
      .title,
    "合同要点整理",
  );
});
