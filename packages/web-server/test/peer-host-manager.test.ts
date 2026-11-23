import { it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { REMOTE_PEERS_METHODS as methods } from "@codexhost/shared-contracts";
import { parseConnectionLink, PeerHostStore } from "../src/peer-host-store.ts";
import { PeerHostManager, createCompositeRemoteCall } from "../src/peer-host-manager.ts";
import { peerEndpoint } from "../src/peer-manifest.ts";
import { DataDir } from "../src/store.ts";
import { Workspaces } from "../src/workspaces.ts";
import { EventHub, RpcRegistry, StreamRegistry } from "../src/transport.ts";
it("normalizes credential links and classifies only actual private addresses as LAN", () => {
  for (const [host, kind] of [
    ["100.64.0.1", "tailscale"],
    ["100.128.0.1", "custom"],
    ["dev.ts.net", "tailscale"],
    ["172.31.0.1", "lan"],
    ["172.32.0.1", "custom"],
    ["10.example.com", "custom"],
    ["[::1]", "lan"],
    ["example.local", "lan"],
  ]) {
    const result = parseConnectionLink(`http://${host}:4400/path?token=value`);
    assert.deepEqual(result, {
      origin: `http://${host}:4400`,
      token: "value",
      encrypted: false,
      transportKind: kind,
    });
  }
  for (const bad of [
    "file:///tmp#token=x",
    "https://user:secret@example.com/#token=x",
    "http://localhost",
  ])
    assert.throws(() => parseConnectionLink(bad));
});
it("pairs authenticated mobile callers with independent peers and recovers event streams", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "hub-"));
  const token = "unique-secret";
  const mock = async () => {
    let epoch = randomUUID();
    let stream: ServerResponse | undefined;
    const calls: unknown[] = [];
    const data = new DataDir(join(root, epoch));
    const ws = new Workspaces(data, root);
    ws.setRemoteGroups([
      {
        workspaceId: "remote",
        title: "other",
        path: "/other",
        remote: { hostId: "other", displayName: "other", state: "connected" },
        sessionIds: [],
        createdAt: "",
        updatedAt: "",
      },
    ]);
    const rpc = new RpcRegistry();
    ws.register(rpc, new StreamRegistry());
    const server = createServer(async (req, res) => {
      if (req.headers.authorization !== "Bearer " + token) {
        res.writeHead(401).end();
        return;
      }
      const url = new URL(req.url!, "http://localhost");
      if (url.pathname.endsWith("/events")) {
        stream = res;
        res.writeHead(200);
        res.write(JSON.stringify({ type: "hello", cursor: { epoch, sequence: 1 } }) + "\n");
        return;
      }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const p = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      try {
        let reply;
        if (url.pathname.startsWith("/api/peer"))
          reply = await peerEndpoint(req.method!, url, p, ws, rpc, epoch, "1");
        else {
          calls.push(p);
          reply = {
            result: url.pathname.endsWith("/snapshot")
              ? {
                  cursor: { epoch, sequence: 1 },
                  thread: {
                    id: "t",
                    cwd: root,
                    modelProvider: "codex",
                    createdAt: 1,
                    updatedAt: 1,
                    status: { type: "idle" },
                    turns: [],
                  },
                  turnsPage: { data: [], nextCursor: null },
                  configuration: {},
                  interactions: [],
                }
              : p.method === "thread/list" || p.method === "thread/turns/list"
                ? { data: [], nextCursor: null }
                : { resolved: true },
          };
        }
        res.end(JSON.stringify(reply));
      } catch {
        res.writeHead(400).end();
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    return {
      origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      epoch,
      calls,
      stream: () => stream,
      async restart() {
        const { port } = server.address() as { port: number };
        server.closeAllConnections();
        await new Promise<void>((r) => server.close(() => r()));
        epoch = randomUUID();
        server.listen(port, "127.0.0.1");
        await once(server, "listening");
        return epoch;
      },
      close: () => {
        server.closeAllConnections();
        server.close();
      },
    };
  };
  const [a, b] = await Promise.all([mock(), mock()]);
  const store = new PeerHostStore(new DataDir(root));
  store.save([
    {
      peerId: "bad",
      name: "Revoked",
      origin: b.origin,
      token: "revoked",
      enabled: true,
      createdAt: "now",
      updatedAt: "now",
    },
  ]);
  const manager = new PeerHostManager(
    store,
    async () => ["http://localhost:100"],
    new EventHub(root),
  );
  t.after(() => {
    manager.close();
    a.close();
    b.close();
    rmSync(root, { recursive: true, force: true });
  });
  const rpc = new RpcRegistry();
  manager.register(rpc);
  const invoke = async (action: keyof typeof methods, input: object = {}) => {
    const r = await rpc.dispatch(
      methods[action],
      { args: input },
      { local: false, credential: "mobile", release() {} },
    );
    assert.ok(!JSON.stringify(r).includes(token));
    if (!r.ok) throw Error(r.error.message);
    return r.value as any;
  };
  const add = (origin: string, secret = token) =>
    invoke("add", { connectionUrl: `${origin}/#token=${secret}` });
  await assert.rejects(add("http://localhost:100"), /itself/);
  await assert.rejects(add(a.origin, "bad"), /token/);
  const [one] = await Promise.all([add(a.origin), add(b.origin)]);
  assert.equal(statSync(join(root, "remote-peers-v1.json")).mode & 0o777, 0o600);
  const peerId = one.peer.peerId,
    hostId = one.peer.hostId;
  const call = createCompositeRemoteCall(manager, async () => {
    throw Error("No Desktop");
  });
  assert.equal(((await call({ kind: "hosts" })) as unknown[]).length, 3);
  assert.equal(
    (await invoke("list")).peers.find((p: { peerId: string }) => p.peerId === "bad").state,
    "auth-error",
  );
  const { path } = await invoke("createDir", { peerId, parentPath: root, name: "project" });
  assert.ok(
    (await invoke("listDirs", { peerId, path: root })).entries.some(
      (e: { path: string }) => e.path === path,
    ),
  );
  await assert.rejects(invoke("createDir", { peerId, parentPath: root, name: ".." }));
  const { workspaceId, manifest } = await invoke("createWorkspace", { peerId, path });
  assert.equal(manifest.projects.length, 1);
  await invoke("renameWorkspace", { peerId, workspaceId, title: "Renamed" });
  assert.equal(manager.hosts().find((h) => h.hostId === hostId)?.projects?.[0]?.name, "Renamed");
  await invoke("deleteWorkspace", { peerId, workspaceId });
  assert.ok(statSync(path).isDirectory());
  assert.deepEqual(await call({ kind: "list", hostId, cursor: null, archived: false }), {
    data: [],
    nextCursor: null,
  });
  const base = { hostId, threadId: "t", epoch: a.epoch };
  await call({ kind: "read", hostId, threadId: "t" });
  await call({ kind: "prompt", ...base, text: "hello" });
  await call({ kind: "respond", ...base, requestId: 1, result: { decision: "accept" } });
  assert.ok(
    a.calls.some((p: any) => p.method === "turn/start" && p.params.input[0].text === "hello"),
  );
  assert.ok(a.calls.some((p: any) => p.requestId === 1 && p.epoch === a.epoch));
  await sleep(200);
  const changed = new Promise<void>((r) => (manager.onChange = r));
  a.stream()!.write(JSON.stringify({ cursor: { epoch: a.epoch, sequence: 2 } }) + "\n");
  await changed;
  const restarted = await a.restart();
  for (
    let i = 0;
    i < 60 &&
    !(
      manager.hosts().find((h) => h.hostId === hostId)?.epoch === restarted &&
      !a.stream()?.destroyed &&
      manager
        .hosts()
        .filter((h) => h.displayName !== "Revoked")
        .every((h) => h.online)
    );
    i++
  )
    await sleep(50);
  assert.ok(!a.stream()?.destroyed);
  assert.equal(manager.hosts().find((h) => h.hostId === hostId)?.epoch, restarted);
  assert.equal(parseConnectionLink("https://foo.r.chost.dev/#token=x").transportKind, "relay");
});
