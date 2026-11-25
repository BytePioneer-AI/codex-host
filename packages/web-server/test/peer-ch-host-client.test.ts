import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { HostClientUpdate } from "@codexhost/desktop-control";
import { PeerChHostClient } from "../src/peer-ch-host-client.ts";
import { PeerHostClient } from "../src/peer-host-client.ts";

it("round-trips rpc, snapshot, respond, projects, and pins over /api/ch/v1/*", async (t) => {
  const token = "peer-ch-secret";
  const epoch = randomUUID();
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401).end();
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/api/peer/v1/manifest") {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          version: "1.0.0",
          platform: "darwin",
          hostname: "remote-mac",
          epoch,
          projects: [
            { id: "proj-1", name: "App", path: "/remote/app", threadIds: ["t-1", "t-2"] },
            { id: "proj-2", name: "Lib", path: "/remote/lib", threadIds: ["t-3"] },
          ],
        }),
      );
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<
      string,
      unknown
    >;
    requests.push({ path: url.pathname, body });
    res.setHeader("content-type", "application/json");
    if (url.pathname === "/api/ch/v1/snapshot") {
      res.end(
        JSON.stringify({
          result: {
            cursor: { epoch, sequence: 4 },
            thread: {
              id: String(body.threadId),
              cwd: "/remote/app",
              modelProvider: "codexhost",
              createdAt: 100,
              updatedAt: 200,
              status: { type: "idle" },
              turns: [],
            },
            turnsPage: { data: [], nextCursor: null },
            configuration: {},
            interactions: [],
          },
        }),
      );
      return;
    }
    if (url.pathname === "/api/ch/v1/respond") {
      res.end(JSON.stringify({ result: { resolved: true } }));
      return;
    }
    if (url.pathname === "/api/ch/v1/rpc") {
      if (body.method === "codexhost/thread/pins/list") {
        res.end(JSON.stringify({ result: { threadIds: ["t-1", "t-1", "t-2"] } }));
        return;
      }
      if (body.method === "codexhost/thread/tree/read") {
        res.end(JSON.stringify({ result: { parents: { "t-2": "t-1" } } }));
        return;
      }
    }
    res.writeHead(404).end(JSON.stringify({ error: { code: -32601, message: "Not found" } }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const peer = new PeerHostClient(
    {
      peerId: "peer-1",
      name: "Peer 1",
      origin,
      token,
      enabled: true,
      createdAt: "now",
      updatedAt: "now",
    },
    () => {},
  );
  const host = new PeerChHostClient(peer.chTransport());
  t.after(() => {
    host.close();
    peer.close();
    server.closeAllConnections();
    server.close();
  });

  await peer.probe();

  const tree = await host.request<{ parents: Record<string, string> }>(
    "codexhost/thread/tree/read",
    {},
  );
  assert.deepEqual(tree, { parents: { "t-2": "t-1" } });

  const snapshot = await host.realtime.snapshot("t-1", {
    knownTurns: [{ id: "turn-1", fingerprint: "fp-1" }],
  });
  assert.equal(snapshot.thread.id, "t-1");
  assert.equal(snapshot.cursor.sequence, 4);

  const responded = await host.realtime.respond({
    epoch,
    threadId: "t-1",
    requestId: 7,
    result: { decision: "accept" },
  });
  assert.deepEqual(responded, { resolved: true });

  const projects = await host.projects(["t-2", "t-999"]);
  assert.deepEqual(projects, {
    projects: [
      { id: "proj-1", name: "App", rootPaths: ["/remote/app"] },
      { id: "proj-2", name: "Lib", rootPaths: ["/remote/lib"] },
    ],
    assignments: { "t-2": "proj-1" },
    projectless: [],
  });

  assert.deepEqual(await host.pins(), ["t-1", "t-2"]);
  assert.deepEqual(
    requests.map((r) => r.path),
    ["/api/ch/v1/rpc", "/api/ch/v1/snapshot", "/api/ch/v1/respond", "/api/ch/v1/rpc"],
  );
});

it("dispatches connection+hello, drops malformed NDJSON lines, replays to late subscribers, and signals disconnect", async (t) => {
  const token = "stream-secret";
  const epoch = randomUUID();
  let streamRes: ServerResponse | undefined;
  let streamReady = Promise.withResolvers<undefined>();
  let failStreams = false;

  const server = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401).end();
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/api/peer/v1/manifest") {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          version: "1.0.0",
          platform: "darwin",
          hostname: "stream-peer",
          epoch,
          projects: [],
        }),
      );
      return;
    }
    if (url.pathname === "/api/ch/v1/events") {
      if (failStreams) {
        res.writeHead(503).end();
        return;
      }
      streamRes = res;
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      streamReady.resolve(undefined);
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const peer = new PeerHostClient(
    {
      peerId: "stream-peer",
      name: "Stream Peer",
      origin,
      token,
      enabled: true,
      createdAt: "now",
      updatedAt: "now",
    },
    () => {},
  );
  const host = new PeerChHostClient(peer.chTransport());
  t.after(() => {
    host.close();
    peer.close();
    server.closeAllConnections();
    server.close();
  });

  const earlyEvents: HostClientUpdate[] = [];
  host.realtime.subscribe((event) => earlyEvents.push(event));
  // Initial offline connection state delivered immediately.
  assert.deepEqual(earlyEvents, [{ type: "connection", online: false }]);

  void peer.start();
  await streamReady.promise;
  assert.ok(streamRes);

  // Send first hello, malformed JSON, schema-invalid event, and a valid changed event.
  streamRes.write(
    JSON.stringify({ type: "hello", version: 1, cursor: { epoch, sequence: 1 }, reset: true }) +
      "\n",
  );
  streamRes.write("{not-valid-json\n");
  streamRes.write(JSON.stringify({ type: "unknown-event", cursor: { epoch, sequence: 2 } }) + "\n");
  streamRes.write(
    JSON.stringify({
      type: "changed",
      cursor: { epoch, sequence: 3 },
      threadId: "thread-1",
      method: "turn/completed",
    }) + "\n",
  );

  for (let i = 0; i < 40 && earlyEvents.length < 4; i++) await sleep(20);
  assert.deepEqual(earlyEvents, [
    { type: "connection", online: false },
    { type: "connection", online: true },
    { type: "hello", version: 1, cursor: { epoch, sequence: 1 }, reset: true },
    {
      type: "changed",
      cursor: { epoch, sequence: 3 },
      threadId: "thread-1",
      method: "turn/completed",
    },
  ]);

  // Late subscriber immediately receives connection: true + hello with latest cursor (reset: false).
  const lateEvents: HostClientUpdate[] = [];
  host.realtime.subscribe((event) => lateEvents.push(event));
  assert.deepEqual(lateEvents, [
    { type: "connection", online: true },
    { type: "hello", version: 1, cursor: { epoch, sequence: 3 }, reset: false },
  ]);

  // Disconnect emits connection: false.
  failStreams = true;
  streamReady = Promise.withResolvers<undefined>();
  streamRes.end();
  for (
    let i = 0;
    i < 40 && !lateEvents.some((e) => e.type === "connection" && e.online === false);
    i++
  ) {
    await sleep(20);
  }
  assert.deepEqual(lateEvents.at(-1), { type: "connection", online: false });
  assert.deepEqual(earlyEvents.at(-1), { type: "connection", online: false });
});
