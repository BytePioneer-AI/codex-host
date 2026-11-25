import { defined } from "./support/defined.ts";
import assert from "node:assert/strict";
import { it } from "node:test";
import {
  RemoteSessions,
  remoteSessionId,
  remoteSessionIdentity,
  type RemotePeerProvider,
} from "../src/remote-sessions.ts";
import { PeerChHostClient, type PeerChTransport } from "../src/peer-ch-host-client.ts";
import { PeerThreadSource } from "../src/peer-thread-source.ts";
import { EventHub, RpcError, RpcRegistry, StreamRegistry } from "../src/transport.ts";
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
import { remoteWorkspaceId } from "../src/remote-workspaces.ts";

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

  const peerProvider: RemotePeerProvider = {
    source: () => undefined,
  };
  const source = new PeerThreadSource({
    hostId,
    host: new PeerChHostClient(transport),
    onCatalogChanged: () => remote.hostsChanged(hostId),
    onThreadChanged: (tid) => peerProvider.onThreadChanged?.(hostId, tid),
    onConnection: (online) => peerProvider.onConnection?.(hostId, online),
    onReset: (e, full) => peerProvider.onReset?.(hostId, e, full),
  });
  peerProvider.source = (h) => (h === hostId ? source : undefined);

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
      status: { type: "active" },
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
    status: { type: "active" },
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

it("removes disabled peer entries/workspaces without writing back in-flight listThreads() results", async (t) => {
  const hostId = "remote-peer:disable-race";
  const epoch = "epoch-disable-1";
  const row: ChThread = {
    id: "t-race",
    name: "Race Thread",
    cwd: "/remote/race",
    modelProvider: "openai",
    createdAt: 1,
    updatedAt: 10,
    status: { type: "idle" },
    turns: [],
  };
  let enabled = true;
  let holdCatalog = false;
  let catalogStarted = Promise.withResolvers<undefined>();
  let catalogGate = Promise.withResolvers<undefined>();

  const transport: PeerChTransport = {
    manifest: () => ({
      version: "1",
      epoch,
      platform: process.platform,
      hostname: "race-peer",
      homeDir: "/remote",
      projects: [{ id: "proj-race", name: "Race Repo", path: "/remote/race", threadIds: [] }],
    }),
    subscribe: (listener) => {
      listener({ type: "connection", online: true });
      listener({ type: "hello", version: 1, cursor: { epoch, sequence: 1 }, reset: true });
      return () => {};
    },
    async post<T>(_route: "rpc" | "snapshot" | "respond", body: object): Promise<T> {
      const { method } = body as { method: string };
      if (method === "codexhost/thread/catalog/read") {
        if (holdCatalog) {
          catalogStarted.resolve(undefined);
          await catalogGate.promise;
        }
        return {
          threads: [row],
          ownership: [{ threadId: row.id, owner: "codex" }],
          officialCursor: { live: null },
          archivedThreadIds: [],
        } as T;
      }
      if (method === "codexhost/thread/tree/read") return { parents: {} } as T;
      return {} as T;
    },
  };

  const root = mkdtempSync(join(tmpdir(), "remote-disable-race-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspaces = new Workspaces(new DataDir(root), root);
  const events = new EventHub("remote-disable-race");
  const removed: string[] = [];
  const origEmit = events.emit.bind(events);
  events.emit = (event, ...args) => {
    if (event === "api-session/removed" && typeof args[0] === "string") removed.push(args[0]);
    origEmit(event, ...args);
  };
  const source = new PeerThreadSource({
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
        return enabled
          ? [
              {
                hostId,
                online: true,
                epoch,
                displayName: "Race Peer",
                projects: [
                  { id: "proj-race", name: "Race Repo", path: "/remote/race", threadIds: [] },
                ],
              },
            ]
          : [];
      }
      throw new Error(`Unexpected op: ${op.kind}`);
    },
    workspaces,
    { source: (id) => (enabled && id === hostId ? source : undefined) },
  );
  t.after(() => {
    catalogGate.resolve(undefined);
    remote.close();
    source.close();
  });

  const rpc = new RpcRegistry();
  rpc.register("session/list", () => ({ items: [] }));
  remote.install(rpc, new StreamRegistry());

  await remote.refresh();
  const sessionId = remoteSessionId(hostId, row.id);
  const before = await rpc.dispatch("session/list", {});
  assert.ok(before.ok);
  assert.ok(
    (before.value as { items: Array<{ sessionId: string }> }).items.some(
      (item) => item.sessionId === sessionId,
    ),
  );
  assert.ok(workspaces.list().some((w) => w.remote?.hostId === hostId));

  // Start an in-flight listThreads() and disable the peer before it resolves.
  holdCatalog = true;
  catalogStarted = Promise.withResolvers<undefined>();
  catalogGate = Promise.withResolvers<undefined>();
  const inFlight = remote.refresh();
  await catalogStarted.promise;

  enabled = false;
  remote.hostsChanged(hostId);
  catalogGate.resolve(undefined);
  await inFlight;
  for (let i = 0; i < 40 && !removed.includes(sessionId); i++) await sleep(15);

  assert.ok(removed.includes(sessionId));
  assert.equal(
    workspaces.list().some((w) => w.remote?.hostId === hostId),
    false,
  );
  const after = await rpc.dispatch("session/list", {});
  assert.ok(after.ok);
  assert.equal(
    (after.value as { items: Array<{ sessionId: string }> }).items.some(
      (item) => item.sessionId === sessionId,
    ),
    false,
  );
});

it("does not re-traverse synced online peers on ordinary session/list or 30s timer and coalesces burst hostsChanged", async (t) => {
  const peerHostId = "remote-peer:quiet-peer";
  const desktopHostId = "remote-control:desktop-1";
  const epoch = "epoch-quiet-1";
  let peerCatalogReads = 0;
  let desktopListReads = 0;
  const peerRow: ChThread = {
    id: "t-peer",
    name: "Peer Thread",
    cwd: "/remote/peer",
    modelProvider: "openai",
    createdAt: 1,
    updatedAt: 10,
    status: { type: "idle" },
    turns: [],
  };
  const transport: PeerChTransport = {
    manifest: () => ({
      version: "1",
      epoch,
      platform: process.platform,
      hostname: "quiet-peer",
      homeDir: "/remote",
      projects: [{ id: "proj-q", name: "Quiet", path: "/remote/peer", threadIds: [] }],
    }),
    subscribe: (listener) => {
      listener({ type: "connection", online: true });
      listener({ type: "hello", version: 1, cursor: { epoch, sequence: 1 }, reset: true });
      return () => {};
    },
    async post<T>(_route: "rpc" | "snapshot" | "respond", body: object): Promise<T> {
      const { method } = body as { method: string };
      if (method === "codexhost/thread/catalog/read") {
        peerCatalogReads += 1;
        return {
          threads: [peerRow],
          ownership: [{ threadId: peerRow.id, owner: "codex" }],
          officialCursor: { live: null },
          archivedThreadIds: [],
        } as T;
      }
      if (method === "codexhost/thread/tree/read") return { parents: {} } as T;
      return {} as T;
    },
  };

  t.mock.timers.enable({ apis: ["setInterval"] });
  const root = mkdtempSync(join(tmpdir(), "remote-quiet-peer-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = new PeerThreadSource({
    hostId: peerHostId,
    host: new PeerChHostClient(transport),
    onCatalogChanged: () => remote.hostsChanged(peerHostId),
    onThreadChanged: () => undefined,
    onConnection: () => undefined,
  });
  const remote: RemoteSessions = new RemoteSessions(
    new EventHub("remote-quiet-peer"),
    async (op) => {
      if (op.kind === "hosts") {
        return [
          {
            hostId: peerHostId,
            online: true,
            epoch,
            displayName: "Quiet Peer",
            projects: [{ id: "proj-q", name: "Quiet", path: "/remote/peer", threadIds: [] }],
          },
          { hostId: desktopHostId, online: true, displayName: "Desktop" },
        ];
      }
      if (op.kind === "list" && op.hostId === desktopHostId) {
        desktopListReads += 1;
        return { data: [], nextCursor: null };
      }
      throw new Error(`Unexpected op: ${op.kind}`);
    },
    new Workspaces(new DataDir(root), root),
    { source: (id) => (id === peerHostId ? source : undefined) },
  );
  t.after(() => {
    remote.close();
    source.close();
  });

  const rpc = new RpcRegistry();
  const streams = new StreamRegistry();
  rpc.register("session/list", () => ({ items: [] }));
  let streamRouter: Parameters<StreamRegistry["routeSessions"]>[0] | undefined;
  streams.routeSessions = (value) => {
    streamRouter = value;
  };
  remote.install(rpc, streams);

  // Register a control subscriber so the 30s interval timer is active.
  await defined(streamRouter)(
    "session/control",
    {},
    {
      id: "ctrl",
      closed: false,
      push() {},
      end() {},
      fail() {},
      onClose() {},
    },
    async (wrapped) => {
      wrapped.push({ type: "baseline" });
    },
  );

  // Initial refresh syncs both the peer and desktop hosts once.
  await remote.refresh();
  assert.equal(peerCatalogReads, 1);
  assert.equal(desktopListReads, 1);

  // Ordinary session/list must not re-traverse the already-synced online peer,
  // while still refreshing the non-event-driven desktop host.
  await rpc.dispatch("session/list", {});
  await sleep(30);
  assert.equal(peerCatalogReads, 1);
  assert.equal(desktopListReads, 2);

  // 30s periodic timer also skips the already-synced online peer while keeping desktop polling.
  t.mock.timers.tick(30_000);
  await sleep(30);
  assert.equal(peerCatalogReads, 1);
  assert.equal(desktopListReads, 3);

  // Burst hostsChanged calls for the same peer coalesce into a single deferred traversal.
  remote.hostsChanged(peerHostId);
  remote.hostsChanged(peerHostId);
  remote.hostsChanged(peerHostId);
  await sleep(100);
  assert.equal(peerCatalogReads, 1);
  await sleep(700);
  assert.equal(peerCatalogReads, 2);
});

it("publishes peer manifest projects and connected state before slow catalog pagination finishes", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "codexhost-peer-early-groups-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const peerHostId = "remote-peer:slow-catalog";
  const epoch = "epoch-early";
  const catalogGate = Promise.withResolvers<undefined>();
  let connected = false;
  let catalogStarted = false;

  const transport: PeerChTransport = {
    async post(route, body) {
      if (route === "rpc") {
        const { method } = body as { method: string };
        if (method === "codexhost/thread/catalog/read") {
          catalogStarted = true;
          await catalogGate.promise;
          return {
            threads: [],
            archivedThreadIds: [],
            ownership: [],
            nextCursor: null,
          } as never;
        }
        if (method === "codexhost/thread/tree/read") return { entries: [] } as never;
      }
      throw new Error(`Unexpected peer request: ${route}`);
    },
    subscribe(listener) {
      listener({ type: "connection", online: true });
      listener({ type: "hello", version: 1, cursor: { epoch, sequence: 1 }, reset: false });
      return () => {};
    },
    manifest: () => undefined,
  };

  const source = new PeerThreadSource({
    hostId: peerHostId,
    host: new PeerChHostClient(transport),
    onCatalogChanged: () => {},
    onThreadChanged: () => {},
    onConnection: () => {},
  });
  const workspaces = new Workspaces(new DataDir(root), root);
  const remote = new RemoteSessions(
    new EventHub("peer-early-groups"),
    async (op) => {
      if (op.kind === "hosts") {
        return connected
          ? [
              {
                hostId: peerHostId,
                online: true,
                epoch,
                displayName: "home",
                state: "connected",
                projects: [
                  { id: "p-1", name: "alpha", path: "/remote/alpha", threadIds: [] },
                  { id: "p-2", name: "beta", path: "/remote/beta", threadIds: [] },
                ],
              },
            ]
          : [
              {
                hostId: peerHostId,
                online: false,
                displayName: "home",
                state: "connecting",
              },
            ];
      }
      throw new Error(`Unexpected op: ${op.kind}`);
    },
    workspaces,
    { source: (id) => (id === peerHostId ? source : undefined) },
  );
  t.after(() => {
    catalogGate.resolve(undefined);
    remote.close();
    source.close();
  });

  // Initial connecting state shows the fallback placeholder group.
  await remote.refresh();
  const initialRemote = workspaces.list().filter((w) => w.remote?.hostId === peerHostId);
  assert.equal(initialRemote.length, 1);
  assert.equal(initialRemote[0]?.remote?.state, "connecting");
  assert.equal(initialRemote[0]?.title, "home");

  // Once manifest arrives, start refresh while catalog pagination is still blocked.
  connected = true;
  const refreshPromise = remote.refresh();
  await sleep(30);
  assert.equal(catalogStarted, true);

  // Real projects and connected state must already be published before catalog pagination ends.
  const earlyRemote = workspaces.list().filter((w) => w.remote?.hostId === peerHostId);
  assert.deepEqual(
    earlyRemote.map((w) => ({ title: w.title, state: w.remote?.state })),
    [
      { title: "alpha", state: "connected" },
      { title: "beta", state: "connected" },
    ],
  );

  catalogGate.resolve(undefined);
  await refreshPromise;
});

it("handles peer tree retirement, control replay, snapshot-rebuild monotonicity, stale retry, legacy fallback clear, and minimal retired diffs", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "codexhost-peer-tree-live-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const hostId = "remote-peer:tree-live";
  let epoch = "11111111-1111-4111-8111-111111111111";
  let seq = 1;
  const listeners = new Set<(u: HostClientUpdate) => void>();
  const emit = (u: HostClientUpdate) => {
    for (const l of [...listeners]) l(u);
  };

  const parentRow: ChThread = {
    id: "p-root",
    cwd: "/remote/repo",
    modelProvider: "codexhost",
    createdAt: 100,
    updatedAt: 200,
    status: { type: "idle" },
    name: "Parent Thread",
    turns: [
      {
        id: "turn-1",
        status: "completed",
        items: [{ id: "u-1", type: "userMessage", content: [{ type: "text", text: "hi" }] }],
      },
    ],
  };
  const childRow: ChThread = {
    id: "p-child",
    cwd: "/remote/repo",
    modelProvider: "codexhost",
    createdAt: 110,
    updatedAt: 210,
    status: { type: "active" },
    name: "Delegated Child",
    turns: [],
  };

  let includeChild = false;
  let treeParents: Record<string, string> = {};
  let failTreeRead = false;
  let legacyFallback = false;
  let holdSnapshot: PromiseWithResolvers<undefined> | undefined;
  let treeReadCalls = 0;

  const transport: PeerChTransport = {
    async post<T>(route: "rpc" | "snapshot" | "respond", body: object): Promise<T> {
      const input = body as Record<string, unknown>;
      if (route === "snapshot") {
        if (holdSnapshot) {
          const gate = holdSnapshot;
          holdSnapshot = undefined;
          await gate.promise;
        }
        const row = input.threadId === childRow.id ? childRow : parentRow;
        return {
          cursor: { epoch, sequence: seq },
          activeTurnId: null,
          thread: { ...row, turns: [] },
          turnsPage: { data: row.turns, nextCursor: null },
          configuration: {},
          queue: { items: [], pausedReason: null },
          interactions: [],
        } as T;
      }
      if (route === "respond") return { resolved: true } as T;
      const method = String(input.method);
      if (method === "codexhost/thread/catalog/read") {
        if (legacyFallback) {
          throw new RpcError("remote/request-failed", "Method not found", { hostCode: -32601 });
        }
        const list = includeChild ? [parentRow, childRow] : [parentRow];
        return {
          threads: list.map((row) => ({ ...row, turns: [] })),
          ownership: list.map((row) => ({
            threadId: row.id,
            owner: "external",
            harnessId: "claude-code",
          })),
          officialCursor: { live: null },
          archivedThreadIds: [],
        } as T;
      }
      if (method === "thread/list") {
        const list = includeChild ? [parentRow, childRow] : [parentRow];
        return { data: list.map((row) => ({ ...row, turns: [] })), nextCursor: null } as T;
      }
      if (method === "codexhost/thread/tree/read") {
        treeReadCalls++;
        if (failTreeRead) throw new RpcError("remote/request-failed", "Temporary tree timeout");
        return { parents: { ...treeParents } } as T;
      }
      if (method === "codexhost/harness/plugins/list") {
        return {
          plugins: [{ id: "claude-code", name: "Claude Code", version: "1.0.0" }],
        } as T;
      }
      if (method === "codexhost/thread/inspect") {
        return {
          owner: "external",
          harnessId: "claude-code",
          locked: true,
          history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
        } as T;
      }
      if (method === "codexhost/harness/inspect") {
        return {
          status: "ready",
          models: [],
          thinkingOptions: [],
          permissionModes: [],
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
      hostname: "peer-tree",
      epoch,
      projects: [{ id: "proj-1", name: "Repo", path: "/remote/repo", threadIds: [] }],
    }),
  };

  const events = new EventHub("peer-tree-live");
  const addedSummaries: Array<{
    sessionId: string;
    running: boolean;
    projections: { values: Record<string, unknown> };
  }> = [];
  const origEmit = events.emit.bind(events);
  events.emit = ((name: string, ...args: unknown[]) => {
    if (name === "api-session/added") {
      addedSummaries.push(args[0] as (typeof addedSummaries)[number]);
    }
    return origEmit(name, ...args);
  }) as typeof events.emit;

  const peerProvider: RemotePeerProvider = { source: () => undefined };
  const source = new PeerThreadSource({
    hostId,
    host: new PeerChHostClient(transport),
    onCatalogChanged: () => remote.hostsChanged(hostId),
    onThreadChanged: (tid) => peerProvider.onThreadChanged?.(hostId, tid),
    onConnection: (online) => peerProvider.onConnection?.(hostId, online),
    onReset: (e, full) => peerProvider.onReset?.(hostId, e, full),
  });
  peerProvider.source = (h) => (h === hostId ? source : undefined);

  const workspaces = new Workspaces(new DataDir(root), root);
  const remote = new RemoteSessions(
    events,
    async (op) => {
      if (op.kind === "hosts") {
        return [
          {
            hostId,
            online: true,
            epoch,
            displayName: "Peer Tree",
            projects: [{ id: "proj-1", name: "Repo", path: "/remote/repo", threadIds: [] }],
          },
        ];
      }
      if (op.kind === "usage") return { threadId: op.threadId, usage: {} };
      throw new Error(`Unexpected op: ${op.kind}`);
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
  rpc.register("session/list", () => ({ items: [] }));
  let streamRouter: Parameters<StreamRegistry["routeSessions"]>[0] | undefined;
  streams.routeSessions = (value) => {
    streamRouter = value;
  };
  remote.install(rpc, streams);

  // Mirror browser ProjectionValueStore.applyLive semantics: frames with seq < currentSeq drop.
  const browserProjections = new Map<string, Map<string, { value: unknown; seq: number }>>();
  const rawControlFrames: Array<{
    type: string;
    sessionId?: string;
    key?: string;
    value?: unknown;
    seq?: number;
  }> = [];
  const acceptFrame = (frame: {
    type: string;
    sessionId?: string;
    key?: string;
    value?: unknown;
    seq?: number;
  }) => {
    rawControlFrames.push(frame);
    if (
      frame.type !== "projection" ||
      typeof frame.sessionId !== "string" ||
      typeof frame.key !== "string" ||
      typeof frame.seq !== "number"
    ) {
      return;
    }
    let sessionMap = browserProjections.get(frame.sessionId);
    if (!sessionMap) {
      sessionMap = new Map();
      browserProjections.set(frame.sessionId, sessionMap);
    }
    const prev = sessionMap.get(frame.key);
    if (prev !== undefined && frame.seq < prev.seq) return;
    sessionMap.set(frame.key, { value: frame.value, seq: frame.seq });
  };

  let closeControl = () => {};
  const openControl = async () => {
    let closed = false;
    const closeListeners: Array<() => void> = [];
    closeControl = () => {
      closed = true;
      for (const fn of closeListeners) fn();
    };
    await defined(streamRouter)(
      "session/control",
      {},
      {
        id: `ctrl-${Math.random()}`,
        get closed() {
          return closed;
        },
        push: (frame) => acceptFrame(frame as Parameters<typeof acceptFrame>[0]),
        end() {},
        fail() {},
        onClose: (fn) => closeListeners.push(fn),
      },
      async (wrappedSink) => {
        wrappedSink.push({ type: "baseline", value: { projections: {} } });
      },
    );
  };
  await openControl();

  const parentSessionId = remoteSessionId(hostId, parentRow.id);
  const childSessionId = remoteSessionId(hostId, childRow.id);
  const browserState = (key: string) => browserProjections.get(childSessionId)?.get(key);

  // 1. Open child before delegation so browser holds sequenced threadTreeParent=null and detailed harnessIdentity.
  await remote.refresh();
  includeChild = true;
  await remote.refresh();
  await remote.read(childSessionId);
  assert.equal(browserState("threadTreeParent")?.value, null);
  assert.deepEqual(browserState("harnessIdentity")?.value, {
    id: "claude-code",
    name: "Claude Code",
  });
  const initialSeq = defined(browserState("threadTreeParent")).seq;

  // 2. Peer restarts (view retired) and only running status toggles: retired path must NOT emit
  //    unchanged catalog fields (title, attachmentInput, harnessIdentity, threadTreeParent).
  epoch = "22222222-2222-4222-8222-222222222222";
  emit({ type: "hello", version: 1, cursor: { epoch, sequence: ++seq }, reset: true });
  rawControlFrames.length = 0;
  childRow.status = { type: "idle" };
  await remote.refresh(hostId);
  assert.equal(
    rawControlFrames.filter((f) => f.type === "projection" && f.sessionId === childSessionId)
      .length,
    0,
    "unchanged catalog fields must not be re-emitted on retired path when only running changed",
  );

  // 3. Delegation parent appears while view is retired: only threadTreeParent is emitted with seq > initialSeq.
  treeParents = { [childRow.id]: parentRow.id };
  childRow.status = { type: "active" };
  rawControlFrames.length = 0;
  await remote.refresh(hostId);
  const deltaFrames = rawControlFrames.filter(
    (f) => f.type === "projection" && f.sessionId === childSessionId,
  );
  assert.deepEqual(
    deltaFrames.map((f) => f.key),
    ["threadTreeParent"],
    "retired path must emit only the changed projection key without overwriting harnessIdentity/title",
  );
  assert.equal(browserState("threadTreeParent")?.value, parentSessionId);
  const retiredParentSeq = defined(browserState("threadTreeParent")).seq;
  assert.ok(retiredParentSeq > initialSeq);

  // 4. P1-3: Control stream closes while retired child's parent changes; reopening replays updated
  //    catalog projections with strictly higher seq so browser converges.
  closeControl();
  treeParents = {};
  await remote.refresh(hostId);
  assert.equal(browserState("threadTreeParent")?.value, parentSessionId);
  await openControl();
  assert.equal(browserState("threadTreeParent")?.value, null);
  const replayedSeq = defined(browserState("threadTreeParent")).seq;
  assert.ok(replayedSeq > retiredParentSeq);

  // 5. P1-2: Rebuild view while snapshot is in flight; retired catalog update advances viewOrigin
  //    mid-flight (setting parent), then rebuilt view finishes and later clears parent. Browser
  //    must accept the rebuilt view's clear frame (strictly monotonic seq).
  const snapshotGate = Promise.withResolvers<undefined>();
  holdSnapshot = snapshotGate;
  const readingChild = remote.read(childSessionId);
  await sleep(15);
  treeParents = { [childRow.id]: parentRow.id };
  await remote.refresh(hostId);
  assert.equal(browserState("threadTreeParent")?.value, parentSessionId);
  const preRebuildRetiredSeq = defined(browserState("threadTreeParent")).seq;
  assert.ok(preRebuildRetiredSeq > replayedSeq);
  // Release snapshot -> readPeer detects viewOrigin advanced past its draft view's lastSeq,
  // rebuilds above the new floor, and subsequent clear on the live view outranks the retired seq.
  snapshotGate.resolve(undefined);
  await readingChild;
  treeParents = {};
  await remote.refresh(hostId);
  assert.equal(browserState("threadTreeParent")?.value, null);
  assert.ok(defined(browserState("threadTreeParent")).seq > preRebuildRetiredSeq);

  // 6. P1-1: Same-epoch transient tree/read failure retains current parent transiently, does NOT
  //    mark peer cleanly synced, and schedules a retry that clears the parent once tree/read recovers.
  treeParents = { [childRow.id]: parentRow.id };
  await remote.refresh(hostId);
  assert.equal(browserState("threadTreeParent")?.value, parentSessionId);
  treeParents = {};
  failTreeRead = true;
  const callsBeforeTransient = treeReadCalls;
  await remote.refresh(hostId);
  assert.equal(treeReadCalls, callsBeforeTransient + 1);
  assert.equal(
    browserState("threadTreeParent")?.value,
    parentSessionId,
    "same-epoch transient failure temporarily keeps confirmed parent",
  );
  failTreeRead = false;
  for (let i = 0; i < 40 && browserState("threadTreeParent")?.value !== null; i++) {
    await sleep(50);
  }
  assert.equal(
    browserState("threadTreeParent")?.value,
    null,
    "automatic retry after transient tree failure must clear stale parent",
  );

  // 7. P2-1 & P1-1 epoch-reset isolation:
  //    (a) Live view: legacy catalog fallback (-32601 -> ownershipAvailable=false) explicitly clears
  //        previously published threadTreeParent to null on both control stream and summary.
  treeParents = { [childRow.id]: parentRow.id };
  await remote.refresh(hostId);
  assert.equal(browserState("threadTreeParent")?.value, parentSessionId);
  const beforeLiveLegacySeq = defined(browserState("threadTreeParent")).seq;
  legacyFallback = true;
  addedSummaries.length = 0;
  await remote.refresh(hostId);
  assert.equal(browserState("threadTreeParent")?.value, null);
  assert.ok(defined(browserState("threadTreeParent")).seq >= beforeLiveLegacySeq);
  assert.equal(
    addedSummaries.findLast((s) => s.sessionId === childSessionId)?.projections.values
      .threadTreeParent,
    null,
  );

  //    (b) Retired view: restore parent, retire on epoch roll (clearing old-epoch parent immediately),
  //        re-establish parent while retired, then fall back to legacy catalog -> retired path emits
  //        strictly higher sequenced threadTreeParent=null and summary clears it.
  legacyFallback = false;
  treeParents = { [childRow.id]: parentRow.id };
  await remote.refresh(hostId);
  assert.equal(browserState("threadTreeParent")?.value, parentSessionId);
  epoch = "33333333-3333-4333-8333-333333333333";
  emit({ type: "hello", version: 1, cursor: { epoch, sequence: ++seq }, reset: true });
  assert.equal(
    browserState("threadTreeParent")?.value,
    null,
    "epoch roll must clear previous epoch's parent before new epoch tree/read settles",
  );
  await remote.refresh(hostId);
  assert.equal(browserState("threadTreeParent")?.value, parentSessionId);
  const beforeRetiredLegacySeq = defined(browserState("threadTreeParent")).seq;
  legacyFallback = true;
  addedSummaries.length = 0;
  await remote.refresh(hostId);
  assert.equal(browserState("threadTreeParent")?.value, null);
  assert.ok(defined(browserState("threadTreeParent")).seq > beforeRetiredLegacySeq);
  assert.equal(
    addedSummaries.findLast((s) => s.sessionId === childSessionId)?.projections.values
      .threadTreeParent,
    null,
  );
});

it("guards stale cross-epoch catalog pages, preserves supplemented parents across transient tree failures, and avoids redundant snapshot rebuilds on control reconnect", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "codexhost-peer-edge-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const hostId = "remote-peer:tree-edge";
  let epoch = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  let seq = 1;
  const listeners = new Set<(update: HostClientUpdate) => void>();
  const emit = (update: HostClientUpdate) => {
    for (const listener of [...listeners]) listener(update);
  };

  const parentRow: ChThread = {
    id: "p-ancestor",
    cwd: "/remote/repo",
    modelProvider: "codexhost",
    createdAt: 100,
    updatedAt: 200,
    status: { type: "idle" },
    name: "Epoch 1 Parent",
    turns: [
      {
        id: "turn-1",
        status: "completed",
        items: [
          { id: "u-1", type: "userMessage", content: [{ type: "text", text: "hello" }] },
          { id: "a-1", type: "agentMessage", text: "world" },
        ],
      },
    ],
  };
  const childRow: ChThread = {
    id: "p-child",
    cwd: "/remote/repo",
    modelProvider: "codexhost",
    createdAt: 110,
    updatedAt: 210,
    status: { type: "active" },
    name: "Delegated Child",
    turns: [],
  };

  let failTreeRead = false;
  const treeParents: Record<string, string> = { [childRow.id]: parentRow.id };
  let holdCatalog: PromiseWithResolvers<unknown> | undefined;
  let holdSnapshot: PromiseWithResolvers<undefined> | undefined;
  let onSnapshotStart: ((threadId: string) => void) | undefined;
  let snapshotCalls = 0;

  const transport: PeerChTransport = {
    async post<T>(route: "rpc" | "snapshot" | "respond", body: object): Promise<T> {
      const input = body as Record<string, unknown>;
      if (route === "snapshot") {
        snapshotCalls++;
        onSnapshotStart?.(String(input.threadId));
        if (holdSnapshot) {
          const gate = holdSnapshot;
          holdSnapshot = undefined;
          await gate.promise;
        }
        const row = input.threadId === childRow.id ? childRow : parentRow;
        return {
          cursor: { epoch, sequence: seq },
          activeTurnId: null,
          thread: { ...row, turns: [] },
          turnsPage: { data: row.turns, nextCursor: null },
          configuration: {},
          queue: { items: [], pausedReason: null },
          interactions: [],
        } as T;
      }
      if (route === "respond") return { resolved: true } as T;
      const method = String(input.method);
      if (method === "codexhost/thread/catalog/read") {
        if (holdCatalog) {
          const gate = holdCatalog;
          holdCatalog = undefined;
          return (await gate.promise) as T;
        }
        // Only child is in regular catalog pages; parent is an unlisted supplemented ancestor.
        return {
          threads: [{ ...childRow, turns: [] }],
          ownership: [{ threadId: childRow.id, owner: "external", harnessId: "claude-code" }],
          officialCursor: { live: null },
          archivedThreadIds: [],
        } as T;
      }
      if (
        method === "thread/read" &&
        (input.params as { threadId?: string })?.threadId === parentRow.id
      ) {
        return { thread: { ...parentRow, turns: [] } } as T;
      }
      if (method === "codexhost/thread/ownership/list") {
        return {
          threads: [{ threadId: parentRow.id, owner: "external", harnessId: "claude-code" }],
        } as T;
      }
      if (method === "codexhost/thread/tree/read") {
        if (failTreeRead) throw new RpcError("remote/request-failed", "Temporary tree error");
        return { parents: { ...treeParents } } as T;
      }
      if (method === "codexhost/harness/plugins/list") {
        return {
          plugins: [{ id: "claude-code", name: "Claude Code", version: "1.0.0" }],
        } as T;
      }
      if (method === "codexhost/thread/inspect") {
        return {
          owner: "external",
          harnessId: "claude-code",
          locked: true,
          history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
        } as T;
      }
      if (method === "codexhost/harness/inspect") {
        return { status: "ready", models: [], thinkingOptions: [], permissionModes: [] } as T;
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
      hostname: "peer-edge",
      epoch,
      projects: [{ id: "proj-1", name: "Repo", path: "/remote/repo", threadIds: [] }],
    }),
  };

  const events = new EventHub("peer-edge");
  const removedIds: string[] = [];
  const origEmit = events.emit.bind(events);
  events.emit = ((name: string, ...args: unknown[]) => {
    if (name === "api-session/removed") removedIds.push(String(args[0]));
    return origEmit(name, ...args);
  }) as typeof events.emit;

  const peerProvider: RemotePeerProvider = { source: () => undefined };
  const source = new PeerThreadSource({
    hostId,
    host: new PeerChHostClient(transport),
    onCatalogChanged: () => remote.hostsChanged(hostId),
    onThreadChanged: (tid) => peerProvider.onThreadChanged?.(hostId, tid),
    onConnection: (online) => peerProvider.onConnection?.(hostId, online),
    onReset: (e, full) => peerProvider.onReset?.(hostId, e, full),
  });
  peerProvider.source = (h) => (h === hostId ? source : undefined);

  const workspaces = new Workspaces(new DataDir(root), root);
  const remote = new RemoteSessions(
    events,
    async (op) => {
      if (op.kind === "hosts") {
        return [
          {
            hostId,
            online: true,
            epoch,
            displayName: "Peer Edge",
            projects: [{ id: "proj-1", name: "Repo", path: "/remote/repo", threadIds: [] }],
          },
        ];
      }
      if (op.kind === "usage") return { threadId: op.threadId, usage: {} };
      throw new Error(`Unexpected op: ${op.kind}`);
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
  rpc.register("session/list", () => ({ items: [] }));
  let streamRouter: Parameters<StreamRegistry["routeSessions"]>[0] | undefined;
  streams.routeSessions = (value) => {
    streamRouter = value;
  };
  remote.install(rpc, streams);

  const browserProjections = new Map<string, Map<string, { value: unknown; seq: number }>>();
  const acceptFrame = (frame: {
    type: string;
    sessionId?: string;
    key?: string;
    value?: unknown;
    seq?: number;
  }) => {
    if (
      frame.type !== "projection" ||
      typeof frame.sessionId !== "string" ||
      typeof frame.key !== "string" ||
      typeof frame.seq !== "number"
    ) {
      return;
    }
    let sessionMap = browserProjections.get(frame.sessionId);
    if (!sessionMap) {
      sessionMap = new Map();
      browserProjections.set(frame.sessionId, sessionMap);
    }
    const prev = sessionMap.get(frame.key);
    if (prev !== undefined && frame.seq < prev.seq) return;
    sessionMap.set(frame.key, { value: frame.value, seq: frame.seq });
  };

  let closeControl = () => {};
  const openControl = async () => {
    let closed = false;
    const closeListeners: Array<() => void> = [];
    closeControl = () => {
      closed = true;
      for (const fn of closeListeners) fn();
    };
    await defined(streamRouter)(
      "session/control",
      {},
      {
        id: `ctrl-${Math.random()}`,
        get closed() {
          return closed;
        },
        push: (frame) => acceptFrame(frame as Parameters<typeof acceptFrame>[0]),
        end() {},
        fail() {},
        onClose: (fn) => closeListeners.push(fn),
      },
      async (wrappedSink) => {
        wrappedSink.push({ type: "baseline", value: { projections: {} } });
      },
    );
  };
  await openControl();

  const parentSessionId = remoteSessionId(hostId, parentRow.id);
  const childSessionId = remoteSessionId(hostId, childRow.id);
  const listItems = async () => {
    const res = await rpc.dispatch("session/list", {});
    assert.equal(res.ok, true);
    return (
      res.value as {
        items: Array<{ sessionId: string; projections: { values: Record<string, unknown> } }>;
      }
    ).items;
  };

  // 1. P1-2: Supplemented parent (unlisted in regular catalog pages) stays alive across
  //    same-epoch transient tree/read failure, keeping both catalog entry and open follower alive.
  await remote.refresh(hostId);
  assert.deepEqual(
    (await listItems()).map((item) => item.sessionId).sort(),
    [childSessionId, parentSessionId].sort(),
  );
  let parentFollowerFailed = false;
  await defined(streamRouter)(
    "session/follow",
    { address: { sessionId: parentSessionId } },
    {
      id: "follow-parent",
      closed: false,
      push() {},
      end() {},
      fail() {
        parentFollowerFailed = true;
      },
      onClose() {},
    },
    async () => {},
  );
  failTreeRead = true;
  removedIds.length = 0;
  await remote.refresh(hostId);
  assert.deepEqual(
    removedIds,
    [],
    "transient tree/read failure must not remove supplemented parent",
  );
  assert.equal(
    parentFollowerFailed,
    false,
    "open supplemented parent follower must stay connected",
  );
  const afterTransientItems = await listItems();
  assert.ok(afterTransientItems.some((item) => item.sessionId === parentSessionId));
  assert.equal(
    afterTransientItems.find((item) => item.sessionId === childSessionId)?.projections.values
      .threadTreeParent,
    parentSessionId,
  );
  failTreeRead = false;

  // 2. P1-1: Hung old-epoch catalog page resolving AFTER new-epoch hello + opened new-epoch view
  //    must be silently discarded without reverting title or terminating the new view's follower.
  const catalogGate = Promise.withResolvers<unknown>();
  holdCatalog = catalogGate;
  const staleRefresh = remote.refresh(hostId);
  await sleep(15);
  epoch = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  parentRow.name = "Epoch 2 Parent";
  childRow.name = "Epoch 2 Child";
  emit({ type: "hello", version: 1, cursor: { epoch, sequence: ++seq }, reset: true });
  // Open child view on epoch 2 and attach a follower while epoch 1's catalog/read is still hung.
  let epoch2FollowerFailed = false;
  await defined(streamRouter)(
    "session/follow",
    { address: { sessionId: childSessionId } },
    {
      id: "follow-epoch2-child",
      closed: false,
      push() {},
      end() {},
      fail() {
        epoch2FollowerFailed = true;
      },
      onClose() {},
    },
    async () => {},
  );
  assert.equal(browserProjections.get(childSessionId)?.get("title")?.value, "Epoch 2 Child");
  // Now resolve the hung epoch-1 catalog page with an outdated epoch-1 title.
  catalogGate.resolve({
    threads: [{ ...childRow, name: "Stale Epoch 1 Child", turns: [] }],
    ownership: [{ threadId: childRow.id, owner: "external", harnessId: "claude-code" }],
    officialCursor: { live: null },
    archivedThreadIds: [],
  });
  await staleRefresh;
  assert.equal(
    epoch2FollowerFailed,
    false,
    "stale old-epoch catalog page must not retire or disconnect the new epoch's view",
  );
  assert.equal(
    browserProjections.get(childSessionId)?.get("title")?.value,
    "Epoch 2 Child",
    "stale old-epoch catalog page must not overwrite the new epoch's title",
  );

  // 3. P2-2 (a): Reopening session/control while a retired view with turns is reading its snapshot
  //    must NOT trigger a redundant snapshot rebuild when loaded turns already meet the seq floor.
  epoch = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  parentRow.name = "Epoch 3 Parent";
  emit({ type: "hello", version: 1, cursor: { epoch, sequence: ++seq }, reset: true });
  await remote.refresh(hostId);
  snapshotCalls = 0;
  const parentGate = Promise.withResolvers<undefined>();
  holdSnapshot = parentGate;
  const readingParent = remote.read(parentSessionId);
  await sleep(15);
  closeControl();
  await openControl();
  parentGate.resolve(undefined);
  await readingParent;
  assert.equal(
    snapshotCalls,
    1,
    "control reconnect during snapshot read must not re-fetch when loaded turns meet seq floor",
  );
  assert.equal(browserProjections.get(parentSessionId)?.get("title")?.value, "Epoch 3 Parent");

  // 4. P2-2 (b): Repeated control reconnects on a zero-turn retired view must hit the bounded
  //    rebuild cap and exit with remote/connection-changed instead of looping forever.
  snapshotCalls = 0;
  onSnapshotStart = (tid) => {
    if (tid === childRow.id) {
      closeControl();
      void openControl();
    }
  };
  await assert.rejects(remote.read(childSessionId), { code: "remote/connection-changed" });
  onSnapshotStart = undefined;
  assert.equal(
    snapshotCalls,
    5,
    "zero-turn rebuild loop must stop after MAX_VIEW_REBUILDS (4 retries)",
  );
});

it("keeps a single-archived official Codex parent archived when a subsequent tree/read fails transiently", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "codexhost-peer-archive-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const hostId = "remote-peer:archive-parent";
  const epoch = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const listeners = new Set<(update: HostClientUpdate) => void>();

  const codexParentRow: ChThread = {
    id: "codex-parent",
    cwd: "/remote/repo",
    modelProvider: "openai",
    createdAt: 100,
    updatedAt: 200,
    status: { type: "idle" },
    name: "Codex Parent",
    turns: [],
  };
  const childRow: ChThread = {
    id: "ext-child",
    cwd: "/remote/repo",
    modelProvider: "codexhost",
    createdAt: 110,
    updatedAt: 210,
    status: { type: "active" },
    name: "Delegated Child",
    turns: [],
  };

  let parentArchivedOnHost = false;
  let failTreeRead = false;
  let omitArchivedOnThreadRead = false;

  const transport: PeerChTransport = {
    async post<T>(route: "rpc" | "snapshot" | "respond", body: object): Promise<T> {
      const input = body as Record<string, unknown>;
      if (route === "snapshot") {
        const row = input.threadId === childRow.id ? childRow : codexParentRow;
        return {
          cursor: { epoch, sequence: 1 },
          activeTurnId: null,
          thread: { ...row, turns: [] },
          turnsPage: { data: [], nextCursor: null },
          configuration: {},
          queue: { items: [], pausedReason: null },
          interactions: [],
        } as T;
      }
      if (route === "respond") return { resolved: true } as T;
      const method = String(input.method);
      if (method === "codexhost/thread/catalog/read") {
        // Active catalog omits archived official Codex parent and returns empty archivedThreadIds.
        const activeRows = parentArchivedOnHost ? [childRow] : [codexParentRow, childRow];
        return {
          threads: activeRows.map((row) => ({ ...row, turns: [] })),
          ownership: activeRows.map((row) =>
            row.id === codexParentRow.id
              ? { threadId: row.id, owner: "codex" }
              : { threadId: row.id, owner: "external", harnessId: "claude-code" },
          ),
          officialCursor: { live: null },
          archivedThreadIds: [],
        } as T;
      }
      if (method === "codexhost/thread/tree/read") {
        if (failTreeRead) throw new RpcError("remote/request-failed", "Temporary tree timeout");
        return { parents: { [childRow.id]: codexParentRow.id } } as T;
      }
      if (
        method === "thread/read" &&
        (input.params as { threadId?: string })?.threadId === codexParentRow.id
      ) {
        return {
          thread: {
            ...codexParentRow,
            ...(omitArchivedOnThreadRead ? {} : { archived: parentArchivedOnHost }),
            turns: [],
          },
        } as T;
      }
      if (method === "codexhost/thread/ownership/list") {
        return { threads: [{ threadId: codexParentRow.id, owner: "codex" }] } as T;
      }
      if (method === "codexhost/harness/plugins/list") {
        return { plugins: [{ id: "claude-code", name: "Claude Code", version: "1.0.0" }] } as T;
      }
      if (method === "codexhost/thread/inspect") {
        return {
          owner: "codex",
          locked: true,
          history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
        } as T;
      }
      if (method === "codexhost/harness/inspect") {
        return { status: "ready", models: [], thinkingOptions: [], permissionModes: [] } as T;
      }
      throw new Error(`Unexpected peer RPC: ${method}`);
    },
    subscribe(listener) {
      listeners.add(listener);
      listener({ type: "connection", online: true });
      listener({ type: "hello", version: 1, cursor: { epoch, sequence: 1 }, reset: false });
      return () => {
        listeners.delete(listener);
      };
    },
    manifest: () => ({
      version: "1.0.0",
      platform: "darwin",
      hostname: "peer-archive",
      epoch,
      projects: [{ id: "proj-1", name: "Repo", path: "/remote/repo", threadIds: [] }],
    }),
  };

  const events = new EventHub("peer-archive");
  const peerProvider: RemotePeerProvider = { source: () => undefined };
  const source = new PeerThreadSource({
    hostId,
    host: new PeerChHostClient(transport),
    onCatalogChanged: () => remote.hostsChanged(hostId),
    onThreadChanged: (tid) => peerProvider.onThreadChanged?.(hostId, tid),
    onConnection: (online) => peerProvider.onConnection?.(hostId, online),
    onReset: (e, full) => peerProvider.onReset?.(hostId, e, full),
  });
  peerProvider.source = (h) => (h === hostId ? source : undefined);

  const workspaces = new Workspaces(new DataDir(root), root);
  const remote = new RemoteSessions(
    events,
    async (op) => {
      if (op.kind === "hosts") {
        return [
          {
            hostId,
            online: true,
            epoch,
            displayName: "Peer Archive",
            projects: [{ id: "proj-1", name: "Repo", path: "/remote/repo", threadIds: [] }],
          },
        ];
      }
      if (op.kind === "archive") {
        if (op.threadId === codexParentRow.id) parentArchivedOnHost = op.archived;
        return { accepted: true };
      }
      if (op.kind === "usage") return { threadId: op.threadId, usage: {} };
      throw new Error(`Unexpected op: ${op.kind}`);
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
  rpc.register("session/list", () => ({ items: [] }));
  rpc.register("workspace/archiveSession", () => ({ archivedSessionIds: [] }));
  streams.routeSessions = () => {};
  remote.install(rpc, streams);

  const parentSessionId = remoteSessionId(hostId, codexParentRow.id);
  const childSessionId = remoteSessionId(hostId, childRow.id);

  // Initial refresh establishes confirmedAncestors with codexParentRow (archived=false).
  await remote.refresh(hostId);
  assert.deepEqual(workspaces.archivedSessionIds(), []);

  // Single-session archive of official Codex parent returns parentSessionId as archived.
  const archiveRes = await rpc.dispatch("workspace/archiveSession", {
    args: { request: { sessionId: parentSessionId, scope: "single" } },
  });
  assert.equal(archiveRes.ok, true);
  assert.deepEqual(archiveRes.value, { archivedSessionIds: [parentSessionId] });
  assert.equal(parentArchivedOnHost, true);

  // Immediately follow with a catalog refresh where tree/read fails transiently and the active
  // catalog only lists the child without repeating codexParentRow in archivedThreadIds.
  failTreeRead = true;
  await remote.refresh(hostId);
  assert.deepEqual(
    workspaces.archivedSessionIds(),
    [parentSessionId],
    "ancestor cache backfill during transient tree failure must not unarchive a confirmed archived parent",
  );
  const listRes = await rpc.dispatch("session/list", {});
  assert.equal(listRes.ok, true);
  const items = (
    listRes.value as {
      items: Array<{ sessionId: string; projections: { values: Record<string, unknown> } }>;
    }
  ).items;
  assert.equal(
    items.find((item) => item.sessionId === childSessionId)?.projections.values.threadTreeParent,
    parentSessionId,
  );

  // Once tree/read recovers, thread/read confirms archived=true and parent stays archived.
  failTreeRead = false;
  await remote.refresh(hostId);
  assert.deepEqual(workspaces.archivedSessionIds(), [parentSessionId]);

  // P1-1: Same-epoch full reset followed by a successful tree/read + ancestor supplement whose
  // thread/read omits `archived` must STILL keep the confirmed archived parent archived.
  omitArchivedOnThreadRead = true;
  for (const listener of [...listeners]) {
    listener({ type: "hello", version: 1, cursor: { epoch, sequence: 2 }, reset: true });
  }
  await remote.refresh(hostId);
  assert.deepEqual(
    workspaces.archivedSessionIds(),
    [parentSessionId],
    "same-epoch full reset + supplement omitting `archived` must not resurrect an archived parent",
  );
});

it("keeps a backfilled parent unarchived when realtime thread/unarchived arrives before a transient tree/read failure", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "codexhost-peer-unarchive-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const hostId = "remote-peer:unarchive-parent";
  const epoch = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const listeners = new Set<(update: HostClientUpdate) => void>();

  const codexParentRow: ChThread = {
    id: "codex-parent",
    cwd: "/remote/repo",
    modelProvider: "openai",
    createdAt: 100,
    updatedAt: 200,
    status: { type: "idle" },
    name: "Codex Parent",
    turns: [],
  };
  const childRow: ChThread = {
    id: "ext-child",
    cwd: "/remote/repo",
    modelProvider: "codexhost",
    createdAt: 110,
    updatedAt: 210,
    status: { type: "active" },
    name: "Delegated Child",
    turns: [],
  };

  let parentArchivedOnHost = true;
  let failTreeRead = false;
  let holdCatalog: PromiseWithResolvers<unknown> | undefined;
  let catalogEntered: PromiseWithResolvers<undefined> | undefined = undefined;

  const transport: PeerChTransport = {
    async post<T>(route: "rpc" | "snapshot" | "respond", body: object): Promise<T> {
      const input = body as Record<string, unknown>;
      if (route === "respond") return { resolved: true } as T;
      const method = String(input.method);
      if (method === "codexhost/thread/catalog/read") {
        if (holdCatalog) {
          const gate = holdCatalog;
          holdCatalog = undefined;
          catalogEntered?.resolve(undefined);
          return (await gate.promise) as T;
        }
        return {
          threads: [{ ...childRow, turns: [] }],
          ownership: [{ threadId: childRow.id, owner: "external", harnessId: "claude-code" }],
          officialCursor: { live: null },
          archivedThreadIds: [],
        } as T;
      }
      if (method === "codexhost/thread/tree/read") {
        if (failTreeRead) throw new RpcError("remote/request-failed", "Temporary tree timeout");
        return { parents: { [childRow.id]: codexParentRow.id } } as T;
      }
      if (
        method === "thread/read" &&
        (input.params as { threadId?: string })?.threadId === codexParentRow.id
      ) {
        return {
          thread: { ...codexParentRow, archived: parentArchivedOnHost, turns: [] },
        } as T;
      }
      if (method === "codexhost/thread/ownership/list") {
        return { threads: [{ threadId: codexParentRow.id, owner: "codex" }] } as T;
      }
      if (method === "codexhost/harness/plugins/list") {
        return { plugins: [{ id: "claude-code", name: "Claude Code", version: "1.0.0" }] } as T;
      }
      throw new Error(`Unexpected peer RPC: ${method}`);
    },
    subscribe(listener) {
      listeners.add(listener);
      listener({ type: "connection", online: true });
      listener({ type: "hello", version: 1, cursor: { epoch, sequence: 1 }, reset: false });
      return () => {
        listeners.delete(listener);
      };
    },
    manifest: () => ({
      version: "1.0.0",
      platform: "darwin",
      hostname: "peer-unarchive",
      epoch,
      projects: [{ id: "proj-1", name: "Repo", path: "/remote/repo", threadIds: [] }],
    }),
  };

  const events = new EventHub("peer-unarchive");
  const peerProvider: RemotePeerProvider = { source: () => undefined };
  const source = new PeerThreadSource({
    hostId,
    host: new PeerChHostClient(transport),
    onCatalogChanged: () => remote.hostsChanged(hostId),
    onThreadChanged: (tid) => peerProvider.onThreadChanged?.(hostId, tid),
    onConnection: (online) => peerProvider.onConnection?.(hostId, online),
    onReset: (e, full) => peerProvider.onReset?.(hostId, e, full),
  });
  peerProvider.source = (h) => (h === hostId ? source : undefined);

  const workspaces = new Workspaces(new DataDir(root), root);
  const remote = new RemoteSessions(
    events,
    async (op) => {
      if (op.kind === "hosts") {
        return [
          {
            hostId,
            online: true,
            epoch,
            displayName: "Peer Unarchive",
            projects: [{ id: "proj-1", name: "Repo", path: "/remote/repo", threadIds: [] }],
          },
        ];
      }
      throw new Error(`Unexpected op: ${op.kind}`);
    },
    workspaces,
    peerProvider,
  );
  t.after(() => {
    remote.close();
    source.close();
  });

  const parentSessionId = remoteSessionId(hostId, codexParentRow.id);

  // Initial refresh supplements the archived parent so both RemoteSessions and confirmedAncestors
  // record it as archived.
  await remote.refresh(hostId);
  assert.deepEqual(workspaces.archivedSessionIds(), [parentSessionId]);

  // Hold a catalog page without the parent while tree/read fails transiently, and deliver
  // realtime `thread/unarchived` before the page resolves.
  const catalogGate = Promise.withResolvers<unknown>();
  const enteredGate = Promise.withResolvers<undefined>();
  holdCatalog = catalogGate;
  catalogEntered = enteredGate;
  failTreeRead = true;
  const unarchiveRefresh = remote.refresh(hostId);
  await enteredGate.promise;
  parentArchivedOnHost = false;
  for (const listener of [...listeners]) {
    listener({
      type: "changed",
      cursor: { epoch, sequence: 2 },
      method: "thread/unarchived",
      threadId: codexParentRow.id,
    });
  }
  catalogGate.resolve({
    threads: [{ ...childRow, turns: [] }],
    ownership: [{ threadId: childRow.id, owner: "external", harnessId: "claude-code" }],
    officialCursor: { live: null },
    archivedThreadIds: [],
  });
  await unarchiveRefresh;
  assert.deepEqual(
    workspaces.archivedSessionIds(),
    [],
    "realtime thread/unarchived before transient tree failure must keep backfilled parent unarchived",
  );
});

it("keeps a restored non-ancestor entry and its open follower alive when an older catalog page omits it", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "codexhost-peer-restore-missing-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const hostId = "remote-peer:restore-missing";
  const epoch = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  const listeners = new Set<(update: HostClientUpdate) => void>();

  const standaloneRow: ChThread = {
    id: "standalone-archived",
    cwd: "/remote/repo",
    modelProvider: "openai",
    createdAt: 100,
    updatedAt: 200,
    status: { type: "idle" },
    name: "Restored Thread",
    turns: [],
  };
  const otherRow: ChThread = {
    id: "other-active",
    cwd: "/remote/repo",
    modelProvider: "codexhost",
    createdAt: 110,
    updatedAt: 210,
    status: { type: "idle" },
    name: "Other Thread",
    turns: [],
  };

  let standaloneArchivedOnHost = false;
  let holdCatalog: PromiseWithResolvers<unknown> | undefined;
  let catalogEntered: PromiseWithResolvers<undefined> | undefined = undefined;

  const transport: PeerChTransport = {
    async post<T>(route: "rpc" | "snapshot" | "respond", body: object): Promise<T> {
      const input = body as Record<string, unknown>;
      if (route === "snapshot") {
        const row = input.threadId === standaloneRow.id ? standaloneRow : otherRow;
        return {
          cursor: { epoch, sequence: 1 },
          activeTurnId: null,
          thread: { ...row, turns: [] },
          turnsPage: { data: [], nextCursor: null },
          configuration: {},
          queue: { items: [], pausedReason: null },
          interactions: [],
        } as T;
      }
      if (route === "respond") return { resolved: true } as T;
      const method = String(input.method);
      if (method === "codexhost/thread/catalog/read") {
        if (holdCatalog) {
          const gate = holdCatalog;
          holdCatalog = undefined;
          catalogEntered?.resolve(undefined);
          return (await gate.promise) as T;
        }
        const activeRows = standaloneArchivedOnHost ? [otherRow] : [standaloneRow, otherRow];
        return {
          threads: activeRows.map((row) => ({ ...row, turns: [] })),
          ownership: activeRows.map((row) =>
            row.id === standaloneRow.id
              ? { threadId: row.id, owner: "codex" }
              : { threadId: row.id, owner: "external", harnessId: "claude-code" },
          ),
          officialCursor: { live: null },
          archivedThreadIds: [],
        } as T;
      }
      if (method === "codexhost/thread/tree/read") return { parents: {} } as T;
      if (method === "codexhost/harness/plugins/list") {
        return { plugins: [{ id: "claude-code", name: "Claude Code", version: "1.0.0" }] } as T;
      }
      if (method === "codexhost/thread/inspect") {
        return {
          owner: "codex",
          locked: true,
          history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
        } as T;
      }
      if (method === "codexhost/harness/inspect") {
        return { status: "ready", models: [], thinkingOptions: [], permissionModes: [] } as T;
      }
      throw new Error(`Unexpected peer RPC: ${method}`);
    },
    subscribe(listener) {
      listeners.add(listener);
      listener({ type: "connection", online: true });
      listener({ type: "hello", version: 1, cursor: { epoch, sequence: 1 }, reset: false });
      return () => {
        listeners.delete(listener);
      };
    },
    manifest: () => ({
      version: "1.0.0",
      platform: "darwin",
      hostname: "peer-restore",
      epoch,
      projects: [{ id: "proj-1", name: "Repo", path: "/remote/repo", threadIds: [] }],
    }),
  };

  const events = new EventHub("peer-restore");
  const removedIds: string[] = [];
  const addedIds: string[] = [];
  const origEmit = events.emit.bind(events);
  events.emit = ((name: string, ...args: unknown[]) => {
    if (name === "api-session/removed") removedIds.push(String(args[0]));
    if (name === "api-session/added") {
      addedIds.push(String((args[0] as { sessionId?: string }).sessionId));
    }
    return origEmit(name, ...args);
  }) as typeof events.emit;

  const peerProvider: RemotePeerProvider = { source: () => undefined };
  const source = new PeerThreadSource({
    hostId,
    host: new PeerChHostClient(transport),
    onCatalogChanged: () => remote.hostsChanged(hostId),
    onThreadChanged: (tid) => peerProvider.onThreadChanged?.(hostId, tid),
    onConnection: (online) => peerProvider.onConnection?.(hostId, online),
    onReset: (e, full) => peerProvider.onReset?.(hostId, e, full),
  });
  peerProvider.source = (h) => (h === hostId ? source : undefined);

  const workspaces = new Workspaces(new DataDir(root), root);
  const remote = new RemoteSessions(
    events,
    async (op) => {
      if (op.kind === "hosts") {
        return [
          {
            hostId,
            online: true,
            epoch,
            displayName: "Peer Restore",
            projects: [{ id: "proj-1", name: "Repo", path: "/remote/repo", threadIds: [] }],
          },
        ];
      }
      if (op.kind === "archive") {
        if (op.threadId === standaloneRow.id) standaloneArchivedOnHost = op.archived;
        return { accepted: true };
      }
      if (op.kind === "usage") return { threadId: op.threadId, usage: {} };
      throw new Error(`Unexpected op: ${op.kind}`);
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
  rpc.register("session/list", () => ({ items: [] }));
  rpc.register("workspace/archiveSession", () => ({ archivedSessionIds: [] }));
  let streamRouter: Parameters<StreamRegistry["routeSessions"]>[0] | undefined;
  streams.routeSessions = (value) => {
    streamRouter = value;
  };
  remote.install(rpc, streams);

  const standaloneSessionId = remoteSessionId(hostId, standaloneRow.id);

  // 1. Load, open follower, and archive standaloneRow.
  await remote.refresh(hostId);
  let followerFailed = false;
  await defined(streamRouter)(
    "session/follow",
    { address: { sessionId: standaloneSessionId } },
    {
      id: "follow-standalone",
      closed: false,
      push() {},
      end() {},
      fail() {
        followerFailed = true;
      },
      onClose() {},
    },
    async () => {},
  );
  const archived = await rpc.dispatch("workspace/archiveSession", {
    args: { request: { sessionId: standaloneSessionId, scope: "single" } },
  });
  assert.equal(archived.ok, true);
  assert.deepEqual(workspaces.archivedSessionIds(), [standaloneSessionId]);

  // 2. Hold an older catalog page that omits standaloneRow (still archived when page started),
  //    then receive realtime `thread/unarchived` before that old page commits.
  const catalogGate = Promise.withResolvers<unknown>();
  const enteredGate = Promise.withResolvers<undefined>();
  holdCatalog = catalogGate;
  catalogEntered = enteredGate;
  const staleRefresh = remote.refresh(hostId);
  await enteredGate.promise;
  removedIds.length = 0;
  addedIds.length = 0;
  standaloneArchivedOnHost = false;
  for (const listener of [...listeners]) {
    listener({
      type: "changed",
      cursor: { epoch, sequence: 2 },
      method: "thread/unarchived",
      threadId: standaloneRow.id,
    });
  }
  catalogGate.resolve({
    threads: [{ ...otherRow, turns: [] }],
    ownership: [{ threadId: otherRow.id, owner: "external", harnessId: "claude-code" }],
    officialCursor: { live: null },
    archivedThreadIds: [],
  });
  await staleRefresh;

  assert.deepEqual(
    removedIds,
    [],
    "stale catalog page omitting a just-unarchived entry must not delete it",
  );
  assert.equal(followerFailed, false, "open follower of just-unarchived entry must stay connected");
  assert.ok(
    addedIds.includes(standaloneSessionId),
    "restored missing entry must emit api-session/added summary",
  );
  assert.deepEqual(workspaces.archivedSessionIds(), []);
  const listRes = await rpc.dispatch("session/list", {});
  assert.equal(listRes.ok, true);
  assert.ok(
    (listRes.value as { items: Array<{ sessionId: string }> }).items.some(
      (item) => item.sessionId === standaloneSessionId,
    ),
  );
});

it("unarchives a supplemented parent in Hub when catalog lists it in archivedThreadIds but thread/read confirms archived: false", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "codexhost-peer-explicit-unarchived-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const hostId = "remote-peer:explicit-unarchived";
  const epoch = "12121212-1212-4121-8121-121212121212";

  const parentRow: ChThread = {
    id: "codex-parent",
    cwd: "/remote/repo",
    modelProvider: "openai",
    createdAt: 100,
    updatedAt: 200,
    status: { type: "idle" },
    name: "Restored Parent",
    turns: [],
  };
  const childRow: ChThread = {
    id: "ext-child",
    cwd: "/remote/repo",
    modelProvider: "codexhost",
    createdAt: 110,
    updatedAt: 210,
    status: { type: "active" },
    name: "Delegated Child",
    turns: [],
  };

  let parentArchivedOnRead = true;

  const transport: PeerChTransport = {
    async post<T>(route: "rpc" | "snapshot" | "respond", body: object): Promise<T> {
      const input = body as Record<string, unknown>;
      if (route === "respond") return { resolved: true } as T;
      const method = String(input.method);
      if (method === "codexhost/thread/catalog/read") {
        // Catalog page still reports parent in archivedThreadIds while omitting it from active threads.
        return {
          threads: [{ ...childRow, turns: [] }],
          ownership: [{ threadId: childRow.id, owner: "external", harnessId: "claude-code" }],
          officialCursor: { live: null },
          archivedThreadIds: [parentRow.id],
        } as T;
      }
      if (method === "codexhost/thread/tree/read") {
        return { parents: { [childRow.id]: parentRow.id } } as T;
      }
      if (
        method === "thread/read" &&
        (input.params as { threadId?: string })?.threadId === parentRow.id
      ) {
        return { thread: { ...parentRow, archived: parentArchivedOnRead, turns: [] } } as T;
      }
      if (method === "codexhost/thread/ownership/list") {
        return { threads: [{ threadId: parentRow.id, owner: "codex" }] } as T;
      }
      if (method === "codexhost/harness/plugins/list") {
        return { plugins: [{ id: "claude-code", name: "Claude Code", version: "1.0.0" }] } as T;
      }
      throw new Error(`Unexpected peer RPC: ${method}`);
    },
    subscribe(listener) {
      listener({ type: "connection", online: true });
      listener({ type: "hello", version: 1, cursor: { epoch, sequence: 1 }, reset: false });
      return () => {};
    },
    manifest: () => ({
      version: "1.0.0",
      platform: "darwin",
      hostname: "peer-explicit-unarchived",
      epoch,
      projects: [{ id: "proj-1", name: "Repo", path: "/remote/repo", threadIds: [] }],
    }),
  };

  const events = new EventHub("peer-explicit-unarchived");
  const peerProvider: RemotePeerProvider = { source: () => undefined };
  const source = new PeerThreadSource({
    hostId,
    host: new PeerChHostClient(transport),
    onCatalogChanged: () => remote.hostsChanged(hostId),
    onThreadChanged: (tid) => peerProvider.onThreadChanged?.(hostId, tid),
    onConnection: (online) => peerProvider.onConnection?.(hostId, online),
    onReset: (e, full) => peerProvider.onReset?.(hostId, e, full),
  });
  peerProvider.source = (h) => (h === hostId ? source : undefined);

  const workspaces = new Workspaces(new DataDir(root), root);
  const remote = new RemoteSessions(
    events,
    async (op) => {
      if (op.kind === "hosts") {
        return [
          {
            hostId,
            online: true,
            epoch,
            displayName: "Peer Explicit Unarchived",
            projects: [{ id: "proj-1", name: "Repo", path: "/remote/repo", threadIds: [] }],
          },
        ];
      }
      throw new Error(`Unexpected op: ${op.kind}`);
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
  rpc.register("session/list", () => ({ items: [] }));
  streams.routeSessions = () => {};
  remote.install(rpc, streams);

  const parentSessionId = remoteSessionId(hostId, parentRow.id);
  const childSessionId = remoteSessionId(hostId, childRow.id);

  // 1. Initially archived on both catalog and thread/read.
  await remote.refresh(hostId);
  assert.deepEqual(workspaces.archivedSessionIds(), [parentSessionId]);

  // 2. Catalog still includes parent in archivedThreadIds, but supplement thread/read returns archived: false.
  parentArchivedOnRead = false;
  await remote.refresh(hostId);
  assert.deepEqual(
    workspaces.archivedSessionIds(),
    [],
    "explicit archived: false on supplement must remove parent from Hub archivedSessionIds",
  );
  const listRes = await rpc.dispatch("session/list", {});
  assert.equal(listRes.ok, true);
  const items = (
    listRes.value as {
      items: Array<{ sessionId: string; projections: { values: Record<string, unknown> } }>;
    }
  ).items;
  assert.ok(items.some((item) => item.sessionId === parentSessionId));
  assert.equal(
    items.find((item) => item.sessionId === childSessionId)?.projections.values.threadTreeParent,
    parentSessionId,
  );
});

it("forwards remote peer questions, external harness approvals, and interaction errors via ChInteractions and clears on offline", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "codexhost-peer-interactions-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const hostId = "remote-peer:peer-interactions";
  const epoch = "33333333-3333-4333-8333-333333333333";
  const threadId = "peer-q-thread";
  const row: ChThread = {
    id: threadId,
    cwd: "/remote/repo",
    modelProvider: "codexhost",
    createdAt: 100,
    updatedAt: 200,
    status: { type: "active" },
    name: "Peer Question Session",
    turns: [
      {
        id: "turn-1",
        status: "inProgress",
        startedAt: 150,
        items: [{ id: "u-1", type: "userMessage", content: [{ type: "text", text: "Ask me" }] }],
      },
    ],
  };
  let pendingInteractions: unknown[] = [
    {
      requestId: "req-question",
      threadId,
      kind: "question",
      interaction: {
        type: "question",
        title: "Need your input",
        questions: [
          {
            id: "choice-1",
            prompt: "Pick A or B",
            type: "choice",
            multiple: false,
            allowOther: false,
            options: [
              { value: "a", label: "Alpha" },
              { value: "b", label: "Beta" },
            ],
          },
        ],
      },
      request: { method: "item/tool/requestUserInput", params: {} },
    },
    {
      requestId: "req-approval",
      threadId,
      kind: "approval",
      interaction: {
        type: "approval",
        title: "Allow external tool?",
        description: "Run external harness command",
        actions: [
          { id: "allow", label: "Allow once", effect: "allowOnce" },
          { id: "deny", label: "Decline", effect: "deny" },
        ],
      },
      request: { method: "mcpServer/elicitation/request", params: {} },
    },
  ];
  let nativeInteractionError: string | undefined = undefined;
  const responses: Array<Record<string, unknown>> = [];
  const listeners = new Set<(update: HostClientUpdate) => void>();

  const transport: PeerChTransport = {
    async post<T>(route: "rpc" | "snapshot" | "respond", body: object): Promise<T> {
      const input = body as Record<string, unknown>;
      if (route === "respond") {
        responses.push(input);
        return { resolved: true } as T;
      }
      if (route === "snapshot") {
        return {
          cursor: { epoch, sequence: 10 },
          thread: {
            ...row,
            turns: [],
            ...(nativeInteractionError ? { nativeInteractionError } : {}),
          },
          turnsPage: {
            data: row.turns,
            nextCursor: null,
          },
          configuration: { native: {} },
          interactions: pendingInteractions,
        } as T;
      }
      const method = String(input.method);
      if (method === "codexhost/thread/catalog/read") {
        return {
          threads: [{ ...row, turns: [] }],
          ownership: [{ threadId, owner: "external", harnessId: "antigravity" }],
          officialCursor: { live: null },
          archivedThreadIds: [],
        } as T;
      }
      if (method === "codexhost/thread/tree/read") return { parents: {} } as T;
      if (method === "codexhost/thread/inspect") {
        return { owner: "external", harnessId: "antigravity", locked: true } as T;
      }
      if (method === "codexhost/harness/plugins/list") {
        return { plugins: [{ id: "antigravity", name: "Antigravity", version: "1.0.0" }] } as T;
      }
      if (method === "codexhost/harness/inspect") {
        return { status: "ready", catalog: { models: [] } } as T;
      }
      throw new Error(`Unexpected peer RPC: ${method}`);
    },
    subscribe(listener) {
      listeners.add(listener);
      listener({ type: "connection", online: true });
      listener({ type: "hello", version: 1, cursor: { epoch, sequence: 1 }, reset: false });
      return () => listeners.delete(listener);
    },
    manifest: () => ({
      version: "1.0.0",
      platform: "darwin",
      hostname: "peer-interactions",
      epoch,
      projects: [{ id: "proj-1", name: "Repo", path: "/remote/repo", threadIds: [] }],
    }),
  };

  const events = new EventHub("peer-interactions");
  const frames: Array<Record<string, unknown>> = [];
  events.handler(
    {},
    {
      id: "browser-client",
      closed: false,
      push: (frame) => frames.push(frame as Record<string, unknown>),
      end() {},
      fail() {},
      onClose() {},
    },
  );
  const peerProvider: RemotePeerProvider = { source: () => undefined };
  const source = new PeerThreadSource({
    hostId,
    host: new PeerChHostClient(transport),
    onCatalogChanged: () => remote.hostsChanged(hostId),
    onThreadChanged: (tid) => peerProvider.onThreadChanged?.(hostId, tid),
    onConnection: (online) => peerProvider.onConnection?.(hostId, online),
    onReset: (e, full) => peerProvider.onReset?.(hostId, e, full),
  });
  peerProvider.source = (h) => (h === hostId ? source : undefined);

  const workspaces = new Workspaces(new DataDir(root), root);
  const remote = new RemoteSessions(
    events,
    async (op) => {
      if (op.kind === "hosts") {
        return [
          {
            hostId,
            online: true,
            epoch,
            displayName: "Peer Interactions",
            projects: [{ id: "proj-1", name: "Repo", path: "/remote/repo", threadIds: [] }],
          },
        ];
      }
      if (op.kind === "usage") return { threadId, usage: {} };
      throw new Error(`Unexpected op: ${op.kind}`);
    },
    workspaces,
    peerProvider,
  );
  t.after(() => {
    remote.close();
    source.close();
  });

  await remote.refresh(hostId);
  const sessionId = remoteSessionId(hostId, threadId);
  const view = await remote.read(sessionId);

  const waterfalls = frames.filter((frame) => frame.type === "waterfall");
  assert.equal(waterfalls.length, 2, "both question and external harness approval must be emitted");
  assert.equal(waterfalls[0]?.agentId, sessionId);
  assert.equal(waterfalls[1]?.agentId, sessionId);
  assert.equal(waterfalls[0]?.event, "user-questions/request");
  assert.equal(waterfalls[1]?.event, "user-questions/request");

  const clientId = String(frames[0]?.clientId);
  events.settle({
    clientId,
    eventId: String(waterfalls[0]?.eventId),
    outcome: { kind: "returned", value: { answers: [{ id: "choice-1", selected: ["Alpha"] }] } },
  });
  events.settle({
    clientId,
    eventId: String(waterfalls[1]?.eventId),
    outcome: {
      kind: "returned",
      value: { answers: [{ id: "approval", selected: ["Allow once"] }] },
    },
  });
  for (let i = 0; i < 100 && responses.length < 2; i++) await sleep(10);
  assert.equal(responses.length, 2);
  assert.deepEqual(responses[0], {
    epoch,
    requestId: "req-question",
    threadId,
    result: { answers: { "choice-1": { answers: ["Alpha"] } } },
  });
  assert.deepEqual(responses[1], {
    epoch,
    requestId: "req-approval",
    threadId,
    result: { action: "accept", content: {} },
  });

  // Verify nativeInteractionError projection and cancellation when peer goes offline.
  nativeInteractionError = "Peer interaction failed";
  pendingInteractions = [
    {
      requestId: "req-before-offline",
      threadId,
      kind: "question",
      interaction: {
        type: "question",
        title: "Offline test",
        questions: [{ id: "q", prompt: "Wait?", type: "text" }],
      },
      request: { method: "item/tool/requestUserInput", params: {} },
    },
  ];
  await remote.read(sessionId, true);
  assert.equal(view.log.projections.nativeInteractionError, "Peer interaction failed");

  for (const listener of [...listeners]) {
    listener({ type: "connection", online: false });
  }
  assert.equal(
    view.log.projections.nativeInteractionError,
    null,
    "going offline must clear stale nativeInteractionError projection",
  );
  const lateFrames: Array<Record<string, unknown>> = [];
  events.handler(
    {},
    {
      id: "late-client-after-offline",
      closed: false,
      push: (frame) => lateFrames.push(frame as Record<string, unknown>),
      end() {},
      fail() {},
      onClose() {},
    },
  );
  assert.equal(
    lateFrames.filter((frame) => frame.type === "waterfall").length,
    0,
    "going offline must clear all pending peer interactions",
  );
});

it("does not revive zombie peer interaction cards when peer disconnects or resets while thread/inspect is in flight", async (t) => {
  for (const disruption of ["offline", "reset"] as const) {
    const root = mkdtempSync(join(tmpdir(), `codexhost-peer-inspect-race-${disruption}-`));
    t.after(() => rmSync(root, { recursive: true, force: true }));

    const hostId = `remote-peer:peer-inspect-race-${disruption}`;
    const epoch = "66666666-6666-4666-8666-666666666666";
    const threadId = "race-thread";
    const row: ChThread = {
      id: threadId,
      cwd: "/remote/repo",
      modelProvider: "codexhost",
      createdAt: 100,
      updatedAt: 200,
      status: { type: "active" },
      name: "Race Thread",
      turns: [
        {
          id: "turn-1",
          status: "inProgress",
          startedAt: 150,
          items: [{ id: "u-1", type: "userMessage", content: [{ type: "text", text: "Ask me" }] }],
        },
      ],
    };
    const pendingInteractions = [
      {
        requestId: "req-zombie",
        threadId,
        kind: "question",
        interaction: {
          type: "question",
          title: "Should not revive",
          questions: [
            {
              id: "q1",
              prompt: "Pick one",
              type: "choice",
              multiple: false,
              allowOther: false,
              options: [{ value: "a", label: "A" }],
            },
          ],
        },
        request: { method: "item/tool/requestUserInput", params: {} },
      },
    ];

    const inspectEntered = Promise.withResolvers<undefined>();
    const inspectGate = Promise.withResolvers<unknown>();
    const listeners = new Set<(update: HostClientUpdate) => void>();

    const transport: PeerChTransport = {
      async post<T>(route: "rpc" | "snapshot" | "respond", body: object): Promise<T> {
        const input = body as Record<string, unknown>;
        if (route === "respond") return { resolved: true } as T;
        if (route === "snapshot") {
          return {
            cursor: { epoch, sequence: 10 },
            thread: { ...row, turns: [] },
            turnsPage: { data: row.turns, nextCursor: null },
            configuration: { native: {} },
            interactions: pendingInteractions,
          } as T;
        }
        const method = String(input.method);
        if (method === "codexhost/thread/catalog/read") {
          return {
            threads: [{ ...row, turns: [] }],
            ownership: [{ threadId, owner: "external", harnessId: "antigravity" }],
            officialCursor: { live: null },
            archivedThreadIds: [],
          } as T;
        }
        if (method === "codexhost/thread/tree/read") return { parents: {} } as T;
        if (method === "codexhost/thread/inspect") {
          inspectEntered.resolve(undefined);
          return (await inspectGate.promise) as T;
        }
        if (method === "codexhost/harness/plugins/list") {
          return { plugins: [{ id: "antigravity", name: "Antigravity", version: "1.0.0" }] } as T;
        }
        if (method === "codexhost/harness/inspect") {
          return { status: "ready", catalog: { models: [] } } as T;
        }
        throw new Error(`Unexpected peer RPC: ${method}`);
      },
      subscribe(listener) {
        listeners.add(listener);
        listener({ type: "connection", online: true });
        listener({ type: "hello", version: 1, cursor: { epoch, sequence: 1 }, reset: false });
        return () => listeners.delete(listener);
      },
      manifest: () => ({
        version: "1.0.0",
        platform: "darwin",
        hostname: `peer-race-${disruption}`,
        epoch,
        projects: [{ id: "proj-1", name: "Repo", path: "/remote/repo", threadIds: [] }],
      }),
    };

    const events = new EventHub(`peer-race-${disruption}`);
    const frames: Array<Record<string, unknown>> = [];
    events.handler(
      {},
      {
        id: "browser-race",
        closed: false,
        push: (frame) => frames.push(frame as Record<string, unknown>),
        end() {},
        fail() {},
        onClose() {},
      },
    );
    const peerProvider: RemotePeerProvider = { source: () => undefined };
    const source = new PeerThreadSource({
      hostId,
      host: new PeerChHostClient(transport),
      onCatalogChanged: () => remote.hostsChanged(hostId),
      onThreadChanged: (tid) => peerProvider.onThreadChanged?.(hostId, tid),
      onConnection: (online) => peerProvider.onConnection?.(hostId, online),
      onReset: (e, full) => peerProvider.onReset?.(hostId, e, full),
    });
    peerProvider.source = (h) => (h === hostId ? source : undefined);

    const workspaces = new Workspaces(new DataDir(root), root);
    const remote = new RemoteSessions(
      events,
      async (op) => {
        if (op.kind === "hosts") {
          return [
            {
              hostId,
              online: true,
              epoch,
              displayName: `Peer Race ${disruption}`,
              projects: [{ id: "proj-1", name: "Repo", path: "/remote/repo", threadIds: [] }],
            },
          ];
        }
        if (op.kind === "usage") return { threadId, usage: {} };
        throw new Error(`Unexpected op: ${op.kind}`);
      },
      workspaces,
      peerProvider,
    );
    t.after(() => {
      remote.close();
      source.close();
    });

    await remote.refresh(hostId);
    const sessionId = remoteSessionId(hostId, threadId);
    const readPromise = remote.read(sessionId);
    await inspectEntered.promise;

    if (disruption === "offline") {
      for (const listener of [...listeners]) {
        listener({ type: "connection", online: false });
      }
    } else {
      for (const listener of [...listeners]) {
        listener({
          type: "hello",
          version: 1,
          cursor: { epoch: "77777777-7777-4777-8777-777777777777", sequence: 1 },
          reset: true,
        });
      }
    }

    inspectGate.resolve({ owner: "external", harnessId: "antigravity", locked: true });
    await readPromise;

    assert.equal(
      frames.filter((frame) => frame.type === "waterfall").length,
      0,
      `must not revive zombie question card after ${disruption} during thread/inspect`,
    );
  }
});

it("serves codexhost/turnDiffs for remote sessions and handles invalid requests and drafts cleanly", async (t) => {
  const hostId = "remote-peer:peer-diffs";
  const threadId = "diff-thread";
  const sessionId = remoteSessionId(hostId, threadId);
  const epoch = "44444444-4444-4444-8444-444444444444";
  const row: ChThread = {
    id: threadId,
    cwd: "/remote/repo",
    modelProvider: "openai",
    createdAt: 100,
    updatedAt: 200,
    status: { type: "idle" },
    name: "Remote Diff Session",
    turns: [
      {
        id: "turn-1",
        status: "completed",
        startedAt: 110,
        completedAt: 120,
        items: [
          { id: "u-1", type: "userMessage", content: [{ type: "text", text: "Edit files" }] },
          {
            id: "fc-1",
            type: "fileChange",
            status: "completed",
            changes: [
              {
                path: "src/a.ts",
                kind: { type: "update", move_path: null },
                diff: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-oldA\n+newA\n",
              },
              {
                path: "src/b.ts",
                kind: { type: "update", move_path: null },
                diff: "--- a/src/b.ts\n+++ b/src/b.ts\n@@ -1 +1 @@\n-oldB\n+newB\n",
              },
            ],
          },
          { id: "a-1", type: "agentMessage", text: "Done" },
        ],
      },
    ],
  };

  const remote = new RemoteSessions(new EventHub("remote-diffs"), async (op) => {
    if (op.kind === "hosts") {
      return [
        {
          hostId,
          online: true,
          epoch,
          displayName: "Peer Diffs",
          projects: [{ id: "proj-1", name: "Repo", path: "/remote/repo", threadIds: [] }],
        },
      ];
    }
    if (op.kind === "list") return { data: [{ ...row, turns: [] }], nextCursor: null };
    if (op.kind === "read") return { result: { thread: row }, epoch, requests: [] };
    if (op.kind === "usage") return { threadId, usage: {} };
    throw new Error(`Unexpected op: ${op.kind}`);
  });
  t.after(() => remote.close());

  const rpc = new RpcRegistry();
  const streams = new StreamRegistry();
  rpc.register("codexhost/turnDiffs", () => {
    throw new Error("local turnDiffs should not be called for remote sessions");
  });
  rpc.register("session/create", () => {
    throw new Error("local session/create should not be called for remote workspaces");
  });
  streams.routeSessions = () => {};
  remote.install(rpc, streams);

  await remote.refresh();
  const allDiffs = await rpc.dispatch("codexhost/turnDiffs", {
    args: { request: { sessionId, turn: 1 } },
  });
  assert.equal(allDiffs.ok, true);
  assert.deepEqual(allDiffs.value, {
    diffs: [
      { path: "src/a.ts", oldText: "oldA", newText: "newA" },
      { path: "src/b.ts", oldText: "oldB", newText: "newB" },
    ],
  });

  const filtered = await rpc.dispatch("codexhost/turnDiffs", {
    args: { request: { sessionId, turn: 1, path: "src/b.ts" } },
  });
  assert.equal(filtered.ok, true);
  assert.deepEqual(filtered.value, {
    diffs: [{ path: "src/b.ts", oldText: "oldB", newText: "newB" }],
  });

  const missingTurn = await rpc.dispatch("codexhost/turnDiffs", {
    args: { request: { sessionId, turn: 99 } },
  });
  assert.equal(missingTurn.ok, false);
  if (!missingTurn.ok) assert.equal(missingTurn.error.code, "session/diff-not-found");

  const invalidTurn = await rpc.dispatch("codexhost/turnDiffs", {
    args: { request: { sessionId, turn: -1 } },
  });
  assert.equal(invalidTurn.ok, false);
  if (!invalidTurn.ok) assert.equal(invalidTurn.error.code, "session/diff-invalid");

  // Unbound remote draft returns session/diff-not-found instead of remote/unsupported.
  const created = await rpc.dispatch("session/create", {
    args: { request: { workspaceId: remoteWorkspaceId(hostId, "proj-1") } },
  });
  assert.equal(created.ok, true);
  const draftId = (created.value as { sessionId: string }).sessionId;
  const draftDiff = await rpc.dispatch("codexhost/turnDiffs", {
    args: { request: { sessionId: draftId, turn: 1 } },
  });
  assert.equal(draftDiff.ok, false);
  if (!draftDiff.ok) assert.equal(draftDiff.error.code, "session/diff-not-found");
});

it("merges remote sessions into session/search with case-insensitive matching, balanced truncation, and hasMore", async (t) => {
  const hostId = "remote-peer:peer-search";
  const epoch = "55555555-5555-4555-8555-555555555555";
  const remoteRows: ChThread[] = Array.from({ length: 15 }, (_, index) => ({
    id: `remote-t-${index}`,
    cwd: "/remote/repo",
    modelProvider: "openai",
    createdAt: 100 + index,
    updatedAt: 200 + index,
    status: { type: "idle" },
    name: index === 0 ? "Unique Remote Alpha" : `Shared Keyword Remote #${index}`,
    turns: [],
  }));

  let localItems: Array<{ sessionId: string; snippet: string }> = [];
  const remote = new RemoteSessions(new EventHub("remote-search"), async (op) => {
    if (op.kind === "hosts") {
      return [
        {
          hostId,
          online: true,
          epoch,
          displayName: "Peer Search",
          projects: [],
        },
      ];
    }
    if (op.kind === "list") return { data: remoteRows, nextCursor: null };
    throw new Error(`Unexpected op: ${op.kind}`);
  });
  t.after(() => remote.close());

  const rpc = new RpcRegistry();
  const streams = new StreamRegistry();
  streams.routeSessions = () => {};
  rpc.register("session/search", (args) => {
    const query = String(
      (args.request as { query?: string } | undefined)?.query ?? "",
    ).toLowerCase();
    return {
      items: localItems.filter((item) => item.snippet.toLowerCase().includes(query)).slice(0, 20),
      hasMore: false,
    };
  });
  remote.install(rpc, streams);
  await remote.refresh();

  // 1. Remote-only match (case-insensitive)
  localItems = [{ sessionId: "local-only", snippet: "Local Beta Task" }];
  const remoteOnly = await rpc.dispatch("session/search", {
    args: { request: { query: "unique remote" } },
  });
  assert.equal(remoteOnly.ok, true);
  assert.deepEqual(remoteOnly.value, {
    items: [
      {
        sessionId: remoteSessionId(hostId, "remote-t-0"),
        snippet: "Unique Remote Alpha",
      },
    ],
    hasMore: false,
  });

  // 2. Local-only match
  const localOnly = await rpc.dispatch("session/search", {
    args: { request: { query: "local beta" } },
  });
  assert.equal(localOnly.ok, true);
  assert.deepEqual(localOnly.value, {
    items: [{ sessionId: "local-only", snippet: "Local Beta Task" }],
    hasMore: false,
  });

  // 3. Mixed local + remote under limit
  localItems = [{ sessionId: "local-shared", snippet: "Shared Keyword Local" }];
  const mixed = await rpc.dispatch("session/search", {
    args: { request: { query: "shared keyword" } },
  });
  assert.equal(mixed.ok, true);
  const mixedVal = mixed.value as {
    items: Array<{ sessionId: string; snippet: string }>;
    hasMore: boolean;
  };
  assert.equal(mixedVal.items.length, 15);
  assert.equal(mixedVal.hasMore, false);
  assert.equal(mixedVal.items[0]?.sessionId, "local-shared");
  assert.equal(mixedVal.items[1]?.sessionId, remoteSessionId(hostId, "remote-t-14"));

  // 4. Overflow (> 20) truncates cleanly, keeps both local and remote results, and sets hasMore: true
  localItems = Array.from({ length: 18 }, (_, i) => ({
    sessionId: `local-shared-${i}`,
    snippet: `Shared Keyword Local #${i}`,
  }));
  const overflow = await rpc.dispatch("session/search", {
    args: { request: { query: "shared keyword" } },
  });
  assert.equal(overflow.ok, true);
  const overflowVal = overflow.value as {
    items: Array<{ sessionId: string; snippet: string }>;
    hasMore: boolean;
  };
  assert.equal(overflowVal.items.length, 20);
  assert.equal(overflowVal.hasMore, true);
  assert.equal(
    overflowVal.items.filter((item) => item.sessionId.startsWith("local-shared-")).length,
    10,
  );
  assert.equal(
    overflowVal.items.filter((item) => item.sessionId.startsWith("web-remote:")).length,
    10,
  );
  assert.equal(overflowVal.items[10]?.sessionId, remoteSessionId(hostId, "remote-t-14"));

  // 5. Empty query merges local + remote under the same cap and sets hasMore when truncated
  const emptyQuery = await rpc.dispatch("session/search", {
    args: { request: { query: "" } },
  });
  assert.equal(emptyQuery.ok, true);
  const emptyVal = emptyQuery.value as {
    items: Array<{ sessionId: string; snippet: string }>;
    hasMore: boolean;
  };
  assert.equal(emptyVal.items.length, 20);
  assert.equal(emptyVal.hasMore, true);
  assert.ok(emptyVal.items.some((item) => item.sessionId.startsWith("web-remote:")));
});
