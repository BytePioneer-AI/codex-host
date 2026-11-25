import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import type { RemoteSessionOperation } from "@codexhost/shared-contracts";
import { ChSessions } from "../src/ch-sessions.ts";
import { PeerHostManager, createCompositeRemoteCall } from "../src/peer-host-manager.ts";
import { PeerHostStore } from "../src/peer-host-store.ts";
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
    [{ sessionId: "web-remote:draft-expired" }, "session/not-found"],
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

async function peerFixture(
  t: TestContext,
  options: {
    enabled?: boolean;
    manifestStatus?: number;
    catalogStatus?: number;
    probeGate?: Promise<undefined>;
    listGate?: Promise<undefined>;
    discoveryGate?: Promise<undefined>;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "remote-summary-"));
  const hostId = "remote-peer:target";
  const threadId = "peer-thread";
  const epoch = "peer-epoch";
  const probed = Promise.withResolvers<undefined>();
  const listing = Promise.withResolvers<undefined>();
  const connecting = Promise.withResolvers<undefined>();
  const discovered = Promise.withResolvers<undefined>();
  const server = createServer(async (request, response) => {
    if (request.url === "/api/peer/v1/manifest") {
      probed.resolve(undefined);
      await options.probeGate;
      response.writeHead(options.manifestStatus ?? 200);
      response.end(
        JSON.stringify({ version: "1", platform: "test", hostname: "peer", epoch, projects: [] }),
      );
      return;
    }
    if (request.url?.startsWith("/api/ch/v1/events")) {
      response.writeHead(200).write(
        JSON.stringify({
          type: "hello",
          version: 1,
          cursor: { epoch, sequence: 1 },
          reset: true,
        }) + "\n",
      );
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const { method } = JSON.parse(Buffer.concat(chunks).toString());
    if (method === "codexhost/thread/catalog/read") {
      listing.resolve(undefined);
      await options.listGate;
      response.writeHead(options.catalogStatus ?? 200);
      response.end(
        JSON.stringify({
          result: {
            threads: [
              {
                id: threadId,
                cwd: "/peer",
                modelProvider: "openai",
                createdAt: 1,
                updatedAt: 2,
                status: { type: "idle" },
                turns: [],
              },
            ],
            ownership: [{ threadId, owner: "codex" }],
            officialCursor: { live: null },
            archivedThreadIds: [],
          },
        }),
      );
      return;
    }
    if (method === "codexhost/thread/tree/read") {
      response.end(JSON.stringify({ result: { parents: {} } }));
      return;
    }
    response.end(JSON.stringify({ result: { plugins: [] } }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const store = new PeerHostStore(new DataDir(root));
  const { port } = server.address() as { port: number };
  store.save([
    {
      peerId: "target",
      name: "Peer",
      origin: `http://127.0.0.1:${port}`,
      token: "test-token",
      enabled: options.enabled ?? true,
      createdAt: "now",
      updatedAt: "now",
    },
  ]);
  const events = new EventHub(root);
  const manager = new PeerHostManager(store, async () => [], events, { allowLoopback: true });
  let firstDiscovery = true;
  const remote = new RemoteSessions(
    events,
    createCompositeRemoteCall(manager, async () => {
      if (firstDiscovery) {
        firstDiscovery = false;
        connecting.resolve(undefined);
        await options.discoveryGate;
      }
      return [];
    }),
    undefined,
    manager,
  );
  manager.onChange = (id) => {
    if (id === hostId && manager.client(hostId)?.state === "connected")
      discovered.resolve(undefined);
    remote.hostsChanged(id);
  };
  const rpc = new RpcRegistry();
  rpc.register("session/list", () => ({ items: [{ sessionId: "local" }] }));
  remote.install(rpc, new StreamRegistry());
  t.after(() => {
    remote.close();
    manager.close();
    server.closeAllConnections();
    server.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    hostId,
    threadId,
    lookup: (host: string, thread: string) =>
      rpc.dispatch("session/list", {
        args: { request: { sessionId: remoteSessionId(host, thread) } },
      }),
    sidebar: () => rpc.dispatch("session/list", {}),
    probed: probed.promise,
    listing: listing.promise,
    discoveryStarted: connecting.promise,
    connected: discovered.promise,
  };
}

it(
  "waits for the first Peer connection and a targeted catalog refresh during a cold sidebar load",
  { timeout: 5000 },
  async (t) => {
    const probe = Promise.withResolvers<undefined>();
    const discovery = Promise.withResolvers<undefined>();
    const list = Promise.withResolvers<undefined>();
    t.after(() => {
      probe.resolve(undefined);
      discovery.resolve(undefined);
      list.resolve(undefined);
    });
    const peer = await peerFixture(t, {
      probeGate: probe.promise,
      discoveryGate: discovery.promise,
      listGate: list.promise,
    });
    await peer.probed;
    assert.deepEqual(await peer.sidebar(), {
      ok: true,
      value: { items: [{ sessionId: "local" }] },
    });
    await peer.discoveryStarted;
    const pending = peer.lookup(peer.hostId, peer.threadId);

    probe.resolve(undefined);
    await peer.connected;
    discovery.resolve(undefined);
    await peer.listing;
    list.resolve(undefined);

    const result = await pending;
    assert.ok(result.ok, JSON.stringify(result));
    assert.deepEqual(
      (result.value as { items: Array<{ sessionId: string }> }).items.map((row) => row.sessionId),
      [remoteSessionId(peer.hostId, peer.threadId)],
    );
  },
);

for (const [label, options, host, thread, code] of [
  ["offline Peer", { manifestStatus: 503 }, "remote-peer:target", "peer-thread", "remote/offline"],
  [
    "authentication failure",
    { manifestStatus: 401 },
    "remote-peer:target",
    "peer-thread",
    "remote/offline",
  ],
  [
    "catalog failure",
    { catalogStatus: 503 },
    "remote-peer:target",
    "peer-thread",
    "remote/offline",
  ],
  ["disabled Peer", { enabled: false }, "remote-peer:target", "peer-thread", "remote/not-found"],
  ["removed Peer", {}, "remote-peer:removed", "peer-thread", "remote/not-found"],
  ["missing Thread on an online Peer", {}, "remote-peer:target", "missing", "remote/not-found"],
] as const) {
  it(`classifies direct lookup for ${label}`, { timeout: 5000 }, async (t) => {
    const peer = await peerFixture(t, options);
    const result = await peer.lookup(host, thread);
    assert.ok(!result.ok);
    assert.equal(result.error.code, code);
  });
}

it(
  "bounds the wait for a Peer whose first connection is still pending",
  { timeout: 6000 },
  async (t) => {
    const probe = Promise.withResolvers<undefined>();
    t.after(() => {
      probe.resolve(undefined);
    });
    const peer = await peerFixture(t, { probeGate: probe.promise });
    await peer.probed;
    const result = await peer.lookup(peer.hostId, peer.threadId);
    assert.ok(!result.ok);
    assert.equal(result.error.code, "remote/offline");
  },
);
