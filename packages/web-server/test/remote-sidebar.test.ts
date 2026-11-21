import assert from "node:assert/strict";
import { it } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import { RemoteSidebarPeer } from "@codexhost/host-runtime/remote-sidebar-peer";
import { RemoteSidebar } from "../src/remote-sidebar.ts";
import { remoteSessionId } from "../src/remote-sessions.ts";
import { StreamRegistry } from "../src/transport.ts";
import { FakeChHost, startFakeChDebugger } from "./support/ch-host.ts";
import { startServer } from "./support/server.ts";

/** A real target Web service owns file access and PTYs. Only Desktop's request transport is in-process. */
it("forwards remote file bytes, directory watches and the terminal environment to the owning Web service", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "remote-sidebar-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const nativeId = "center-thread",
    id = remoteSessionId("remote-ssh-discovered:mac", nativeId);
  writeFileSync(join(dir, "known.txt"), "target workspace");
  const host = new FakeChHost();
  host.add(nativeId, dir);
  const debug = await startFakeChDebugger(host);
  t.after(() => debug.close());
  const loginUrl = await startServer(
    t,
    resolve(import.meta.dirname, ".."),
    ["--import", "tsx", "src/main.ts"],
    [
      "--session-source",
      "codexhost",
      "--ch-cdp",
      debug.endpoint,
      "--adapters",
      "test/fake-harness",
    ],
    { authenticated: true },
  );
  const descriptor = mkdtempSync(join(tmpdir(), "peer-ready-"));
  t.after(() => rmSync(descriptor, { recursive: true, force: true }));
  writeFileSync(
    join(descriptor, "web-service-ready.json"),
    JSON.stringify({ pid: process.pid, web_pid: process.pid, loginUrl }),
    { mode: 0o600 },
  );
  const peer = new RemoteSidebarPeer(descriptor);
  t.after(() => peer.close());
  const calls: string[] = [];
  const proxy = new RemoteSidebar(async (received) => {
    assert.equal(received, id);
    return async (action) => {
      calls.push(action.type);
      return peer.run({ nativeId, action });
    };
  });
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    if (!(await proxy.unary(Buffer.concat(chunks).toString(), res))) res.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = "http://127.0.0.1:" + address.port;
  const call = (method: string, args: Record<string, unknown>) =>
    fetch(base, {
      method: "POST",
      body: JSON.stringify({ method, rpcId: "panel", payload: { args } }),
    });
  const local = await call("terminal/environment", { agentId: nativeId });
  assert.equal(local.status, 404);
  const environment = await (await call("terminal/environment", { agentId: id })).json();
  assert.ok(environment.result.ok, JSON.stringify(environment.result.error));
  assert.equal(environment.result.value.cwd, dir);
  const outside = await (
    await call("workspaceFiles/list", { workspaceFileScopeId: id, path: "../" })
  ).json();
  assert.equal(outside.result.error.code, "workspace-file/outside-workspace");
  const binary = await call("workspaceFiles/readBytes", {
    workspaceFileScopeId: id,
    path: "known.txt",
    options: {},
  });
  assert.match(binary.headers.get("content-type") ?? "", /^multipart\/form-data/u);
  assert.match(await binary.text(), /target workspace/u);
  const streams = new StreamRegistry();
  streams.setFallback((name, args, sink) => proxy.stream(name, args, sink));
  const wss = new WebSocketServer({ server });
  wss.on("connection", (socket) => streams.attach(socket));
  t.after(() => wss.close());
  const socket = new WebSocket(base);
  t.after(() => socket.terminate());
  await once(socket, "open");
  const frame = once(socket, "message");
  socket.send(
    JSON.stringify({
      type: "open",
      streamId: "watch",
      endpoint: "workspaceFiles/changes",
      payload: { args: { workspaceFileScopeId: id, path: "." } },
    }),
  );
  assert.deepEqual(JSON.parse(String((await frame)[0])), {
    type: "item",
    streamId: "watch",
    value: { kind: "ready" },
  });
  socket.send(JSON.stringify({ type: "cancel", streamId: "watch" }));
  const closed = once(socket, "close");
  socket.close();
  await closed;
  assert.ok(calls.includes("open") && calls.includes("poll"));
  await assert.rejects(
    peer.run({
      nativeId,
      action: { type: "unary", method: "codexhost/accessTokenGet", rpcId: "forbidden", args: {} },
    }),
  );
});

it("closes a peer while its target thread lookup is pending", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "sidebar-peer-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const descriptor = join(home, ".codexhost");
  mkdirSync(descriptor);
  const server = createServer();
  const request = once(server, "request");
  let upgrades = 0;
  server.on("upgrade", (_request, socket) => {
    upgrades++;
    socket.destroy();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  writeFileSync(
    join(descriptor, "web-service-ready.json"),
    JSON.stringify({
      pid: process.pid,
      web_pid: process.pid,
      loginUrl: "http://127.0.0.1:" + address.port + "/?token=test",
    }),
    { mode: 0o600 },
  );
  const peer = new RemoteSidebarPeer(descriptor);
  t.after(() => peer.close());
  const input = {
    nativeId: "thread",
    action: { type: "open", method: "workspaceFiles/changes", args: { path: "." } },
  };
  const pending = peer.run(input);
  const [, response] = await request;
  peer.close();
  response.end(
    JSON.stringify({ result: { ok: true, value: { items: [{ sessionId: "thread" }] } } }),
  );
  await assert.rejects(pending, /peer is closed/);
  await assert.rejects(peer.run(input), /peer is closed/);
  assert.equal(upgrades, 0);
});
