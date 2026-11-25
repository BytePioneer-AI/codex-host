import { it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { REMOTE_PEERS_METHODS as methods } from "@codexhost/shared-contracts";
import { parseConnectionLink, PeerHostStore } from "../src/peer-host-store.ts";
import { PeerHostManager, createCompositeRemoteCall } from "../src/peer-host-manager.ts";
import { PeerEndpointError, peerEndpoint, resolveServerVersion } from "../src/peer-manifest.ts";
import { readRemoteThreadStatus } from "../src/remote-session-delivery.ts";
import { DataDir } from "../src/store.ts";
import { Workspaces } from "../src/workspaces.ts";
import { EventHub, RpcRegistry, StreamRegistry } from "../src/transport.ts";
it("normalizes credential links, enforces SSRF host policy, and classifies LAN/Tailscale/Relay", () => {
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
    const result = parseConnectionLink(`http://${host}:4400/path?token=value`, {
      allowLoopback: host === "[::1]",
    });
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
    "http://127.0.0.1:4400/#token=x",
    "http://localhost:4400/#token=x",
    "http://[::1]:4400/#token=x",
    "http://[::ffff:127.0.0.1]:4400/#token=x",
    "http://169.254.169.254/#token=x",
    "http://[::ffff:169.254.169.254]/#token=x",
    "http://metadata.google.internal/#token=x",
    "http://0.0.0.0:4400/#token=x",
    "http://[::ffff:0.0.0.0]:4400/#token=x",
  ])
    assert.throws(() => parseConnectionLink(bad));
  for (const blockedEvenWithLoopback of [
    "http://[::ffff:169.254.169.254]/#token=x",
    "http://[::ffff:0.0.0.0]:4400/#token=x",
  ])
    assert.throws(() => parseConnectionLink(blockedEvenWithLoopback, { allowLoopback: true }));
});

it("recovers gracefully from corrupt remote-peers-v1.json, skips 0.0.0 version, and enforces dir boundaries", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "peer-store-"));
  const outside = mkdtempSync(join(tmpdir(), "peer-outside-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  const data = new DataDir(root);
  const store = new PeerHostStore(data);
  writeFileSync(data.path("remote-peers-v1.json"), "{corrupt-json", "utf8");
  assert.deepEqual(store.load(), []);

  // Server version resolution skips placeholder 0.0.0 and respects injected release version.
  const pkgZero = join(root, "pkg-zero.json");
  const pkgReal = join(root, "pkg-real.json");
  writeFileSync(pkgZero, JSON.stringify({ version: "0.0.0" }), "utf8");
  writeFileSync(pkgReal, JSON.stringify({ version: "0.25.1" }), "utf8");
  assert.equal(resolveServerVersion(undefined, [pkgZero, pkgReal]), "0.25.1");
  assert.equal(resolveServerVersion("0.0.0", [pkgZero, pkgReal]), "0.25.1");
  assert.equal(resolveServerVersion("0.99.0", [pkgZero, pkgReal]), "0.99.0");
  const repoVersion = resolveServerVersion(undefined, [
    resolve(import.meta.dirname, "../package.json"),
    resolve(import.meta.dirname, "../../../package.json"),
  ]);
  assert.notEqual(repoVersion, "0.0.0");

  const spacedDir = join(root, "folder with space ");
  mkdirSync(spacedDir);
  if (process.platform !== "win32") {
    symlinkSync(outside, join(root, "escape-link"));
  }
  const ws = new Workspaces(data, root, true);
  const rpc = new RpcRegistry();
  ws.register(rpc, new StreamRegistry());
  await assert.rejects(
    peerEndpoint(
      "GET",
      new URL("http://localhost/api/peer/v1/manifest"),
      {},
      ws,
      rpc,
      undefined,
      "1",
      [root],
    ),
    (err: unknown) => err instanceof PeerEndpointError && err.status === 503,
  );
  // Listing at the allowed root filters out escaping symlinks and clamps parentPath at allowed roots.
  const listedRoot = (await peerEndpoint(
    "GET",
    new URL(`http://localhost/api/peer/v1/dirs?path=${encodeURIComponent(root)}`),
    {},
    ws,
    rpc,
    "epoch-1",
    "1",
    [root],
  )) as { path: string; parentPath: string | null; entries: { name: string }[] };
  if (process.platform !== "win32") {
    assert.equal(listedRoot.parentPath, null);
    assert.ok(listedRoot.entries.some((e) => e.name === "folder with space "));
    assert.ok(!listedRoot.entries.some((e) => e.name === "escape-link"));

    // Trailing-space directory listing and creation both preserve trailing spaces.
    const listed = (await peerEndpoint(
      "GET",
      new URL(`http://localhost/api/peer/v1/dirs?path=${encodeURIComponent(spacedDir)}`),
      {},
      ws,
      rpc,
      "epoch-1",
      "1",
      [root],
    )) as { path: string; parentPath: string | null };
    assert.equal(listed.path, spacedDir);
    assert.equal(listed.parentPath, root);
    const createdSpaced = (await peerEndpoint(
      "POST",
      new URL("http://localhost/api/peer/v1/dirs"),
      { parentPath: root, name: "trail-space " },
      ws,
      rpc,
      "epoch-1",
      "1",
      [root],
    )) as { path: string; name: string };
    assert.equal(createdSpaced.name, "trail-space ");
    assert.ok(statSync(join(root, "trail-space ")).isDirectory());
  } else {
    assert.ok(listedRoot.entries.some((e) => e.name.trim() === "folder with space"));
  }

  // Out-of-bounds GET /dirs, POST /dirs, POST /workspaces, and symlink escape all return 403.
  const forbiddenOutside = process.platform === "win32" ? dirname(homedir()) : outside;
  const outOfBoundsPaths =
    process.platform === "win32"
      ? [forbiddenOutside]
      : [outside, join(root, "..", "..", "etc"), "/", "/etc", join(root, "escape-link")];
  for (const forbidden of outOfBoundsPaths) {
    await assert.rejects(
      peerEndpoint(
        "GET",
        new URL(`http://localhost/api/peer/v1/dirs?path=${encodeURIComponent(forbidden)}`),
        {},
        ws,
        rpc,
        "epoch-1",
        "1",
        [root],
      ),
      (err: unknown) => err instanceof PeerEndpointError && err.status === 403,
      `GET /dirs should reject ${forbidden}`,
    );
  }
  await assert.rejects(
    peerEndpoint(
      "POST",
      new URL("http://localhost/api/peer/v1/dirs"),
      { parentPath: forbiddenOutside, name: "nope" },
      ws,
      rpc,
      "epoch-1",
      "1",
      [root],
    ),
    (err: unknown) => err instanceof PeerEndpointError && err.status === 403,
  );
  await assert.rejects(
    peerEndpoint(
      "POST",
      new URL("http://localhost/api/peer/v1/workspaces"),
      { path: forbiddenOutside },
      ws,
      rpc,
      "epoch-1",
      "1",
      [root],
    ),
    (err: unknown) => err instanceof PeerEndpointError && err.status === 403,
  );
  // Tilde and relative paths are rejected consistently across /dirs and /workspaces.
  for (const relativeOrTilde of ["~/../..", "~/../../etc", "../outside"]) {
    await assert.rejects(
      peerEndpoint(
        "POST",
        new URL("http://localhost/api/peer/v1/workspaces"),
        { path: relativeOrTilde },
        ws,
        rpc,
        "epoch-1",
        "1",
        [root],
      ),
      (err: unknown) => err instanceof PeerEndpointError && err.status === 400,
    );
    await assert.rejects(
      peerEndpoint(
        "GET",
        new URL(`http://localhost/api/peer/v1/dirs?path=${encodeURIComponent(relativeOrTilde)}`),
        {},
        ws,
        rpc,
        "epoch-1",
        "1",
        [root],
      ),
      (err: unknown) => err instanceof PeerEndpointError && err.status === 400,
    );
    await assert.rejects(
      peerEndpoint(
        "POST",
        new URL("http://localhost/api/peer/v1/dirs"),
        { parentPath: relativeOrTilde, name: "nope" },
        ws,
        rpc,
        "epoch-1",
        "1",
        [root],
      ),
      (err: unknown) => err instanceof PeerEndpointError && err.status === 400,
    );
  }
  assert.equal(ws.list().filter((w) => !w.remote).length, 0);
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
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname.endsWith("/events")) {
        stream = res;
        res.writeHead(200);
        res.write(
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
      for await (const chunk of req) chunks.push(chunk);
      const p = JSON.parse(Buffer.concat(chunks).toString() || "{}") as Record<string, unknown>;
      try {
        let reply;
        if (url.pathname.startsWith("/api/peer"))
          reply = await peerEndpoint(req.method ?? "GET", url, p, ws, rpc, epoch, "1", [root]);
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
              : p.method === "codexhost/thread/catalog/read"
                ? {
                    threads: [],
                    ownership: [],
                    officialCursor: { live: null },
                    archivedThreadIds: [],
                  }
                : p.method === "codexhost/thread/tree/read"
                  ? { parents: {} }
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
    { allowLoopback: true },
  );
  t.after(() => {
    manager.close();
    a.close();
    b.close();
    rmSync(root, { recursive: true, force: true });
  });
  const rpc = new RpcRegistry();
  manager.register(rpc);
  const invoke = async <T = Record<string, unknown>>(
    action: keyof typeof methods,
    input: object = {},
    local = true,
  ): Promise<T> => {
    const r = await rpc.dispatch(
      methods[action],
      { args: input },
      { local, credential: local ? "local" : "mobile", release() {} },
    );
    assert.ok(!JSON.stringify(r).includes(token));
    if (!r.ok) throw Error(r.error.message);
    return r.value as T;
  };
  const add = (origin: string, secret = token, local = true) =>
    invoke<{ peer: { peerId: string; hostId: string } }>(
      "add",
      { connectionUrl: `${origin}/#token=${secret}` },
      local,
    );
  const unauthenticated = await rpc.dispatch(methods.add, {
    args: { connectionUrl: `${a.origin}/#token=${token}` },
  });
  assert.equal(unauthenticated.ok, false);
  assert.equal(unauthenticated.error.code, "auth/required");
  // Non-local authenticated callers cannot mutate peer topology or trigger outbound probes.
  for (const [action, input] of [
    ["test", { connectionUrl: `${a.origin}/#token=${token}` }],
    ["add", { connectionUrl: `${a.origin}/#token=${token}` }],
    ["update", { peerId: "bad", name: "Hijacked" }],
    ["remove", { peerId: "bad" }],
  ] as const) {
    const denied = await rpc.dispatch(
      methods[action],
      { args: input },
      { local: false, credential: "mobile", release() {} },
    );
    assert.equal(denied.ok, false, `non-local ${action} should be rejected`);
    assert.equal(denied.error.code, "auth/local-required");
  }
  assert.equal(
    (await invoke<{ ok: boolean }>("test", { connectionUrl: `${a.origin}/#token=${token}` }, true))
      .ok,
    true,
  );
  await assert.rejects(add("http://localhost:100"), /itself/);
  await assert.rejects(add(a.origin, "bad"), /token/);
  const [one] = await Promise.all([add(a.origin, token, true), add(b.origin, token, true)]);
  if (process.platform !== "win32") {
    assert.equal(statSync(join(root, "remote-peers-v1.json")).mode & 0o777, 0o600);
  }
  const peerId = one.peer.peerId,
    hostId = one.peer.hostId;
  // Non-local callers still retain reconnect/list/dir/workspace operations.
  assert.equal(
    (await invoke<{ peer: { peerId: string } }>("reconnect", { peerId }, false)).peer.peerId,
    peerId,
  );
  const call = createCompositeRemoteCall(manager, async () => {
    throw Error("No Desktop");
  });
  assert.equal(((await call({ kind: "hosts" })) as unknown[]).length, 3);
  assert.equal(
    (await invoke<{ peers: { peerId: string; state: string }[] }>("list", {}, false)).peers.find(
      (p) => p.peerId === "bad",
    )?.state,
    "auth-error",
  );
  const { path } = await invoke<{ path: string }>(
    "createDir",
    { peerId, parentPath: root, name: "project" },
    false,
  );
  assert.ok(
    (
      await invoke<{ entries: { path: string }[] }>("listDirs", { peerId, path: root }, false)
    ).entries.some((e) => e.path === path),
  );
  await assert.rejects(invoke("createDir", { peerId, parentPath: root, name: ".." }, false));
  const { workspaceId, manifest } = await invoke<{
    workspaceId: string;
    manifest: { projects: unknown[] };
  }>("createWorkspace", { peerId, path }, false);
  assert.equal(manifest.projects.length, 1);
  await invoke("renameWorkspace", { peerId, workspaceId, title: "Renamed" });
  assert.equal(manager.hosts().find((h) => h.hostId === hostId)?.projects?.[0]?.name, "Renamed");
  await invoke("deleteWorkspace", { peerId, workspaceId });
  assert.ok(statSync(path).isDirectory());
  assert.equal(manager.client("remote-control:desktop"), undefined);
  assert.equal(manager.source("remote-control:desktop"), undefined);
  const source = manager.source(hostId);
  assert.ok(source);
  assert.deepEqual((await source.listThreads()).rows, []);
  const base = { hostId, threadId: "t", epoch: a.epoch };
  await source.history("t", "web-remote:t").refresh();
  await call({ kind: "prompt", ...base, text: "hello" });
  await call({ kind: "respond", ...base, requestId: 1, result: { decision: "accept" } });
  assert.ok(
    a.calls.some((item) => {
      const p = item as { method?: string; params?: { input?: { text?: string }[] } };
      return p.method === "turn/start" && p.params?.input?.[0]?.text === "hello";
    }),
  );
  assert.ok(
    a.calls.some((item) => {
      const p = item as { requestId?: number; epoch?: string };
      return p.requestId === 1 && p.epoch === a.epoch;
    }),
  );
  await sleep(200);
  let deltaChanges = 0;
  manager.onChange = () => {
    deltaChanges += 1;
  };
  const eventStream = a.stream();
  assert.ok(eventStream);
  eventStream.write(
    JSON.stringify({
      type: "changed",
      cursor: { epoch: a.epoch, sequence: 2 },
      threadId: "t",
      method: "item/agentMessage/delta",
    }) + "\n",
  );
  await sleep(160);
  assert.equal(deltaChanges, 0);
  const changed = new Promise<string | undefined>((r) => (manager.onChange = r));
  eventStream.write(
    JSON.stringify({
      type: "changed",
      cursor: { epoch: a.epoch, sequence: 3 },
      threadId: "t",
      method: "thread/name/updated",
    }) + "\n",
  );
  assert.equal(await changed, hostId);
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

it("aborts and reconnects a half-open silent event stream after streamIdleTimeoutMs", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "peer-idle-"));
  const token = "idle-secret";
  const epoch = randomUUID();
  let streamConnections = 0;
  let firstStreamClosed = false;
  const openStreams: ServerResponse[] = [];
  const server = createServer((req, res) => {
    if (req.headers.authorization !== "Bearer " + token) {
      res.writeHead(401).end();
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/api/peer/v1/manifest") {
      res.end(
        JSON.stringify({
          version: "1",
          epoch,
          platform: process.platform,
          hostname: "silent-peer",
          homeDir: root,
          projects: [],
        }),
      );
      return;
    }
    if (url.pathname === "/api/ch/v1/events") {
      streamConnections += 1;
      openStreams.push(res);
      if (streamConnections === 1) {
        res.on("close", () => {
          firstStreamClosed = true;
        });
      }
      res.writeHead(200);
      res.write(
        JSON.stringify({ type: "hello", version: 1, cursor: { epoch, sequence: 1 }, reset: true }) +
          "\n",
      );
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const store = new PeerHostStore(new DataDir(root));
  const manager = new PeerHostManager(store, async () => [], new EventHub(root), {
    allowLoopback: true,
    streamIdleTimeoutMs: 100,
  });
  t.after(() => {
    manager.close();
    for (const s of openStreams) s.destroy();
    server.closeAllConnections();
    server.close();
    rmSync(root, { recursive: true, force: true });
  });
  const rpc = new RpcRegistry();
  manager.register(rpc);
  const added = await rpc.dispatch(
    methods.add,
    { args: { connectionUrl: `${origin}/#token=${token}` } },
    { local: true, credential: "local", release() {} },
  );
  assert.equal(added.ok, true);

  for (let i = 0; i < 80 && !(streamConnections >= 2 && firstStreamClosed); i++) {
    await sleep(50);
  }
  assert.equal(firstStreamClosed, true);
  assert.ok(
    streamConnections >= 2,
    `expected reconnect after idle timeout, got ${streamConnections}`,
  );
});

it("starts new Codex & external threads without bogus thread/resume and retains pre-materialized IDs", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "peer-start-prompt-"));
  const token = "start-secret";
  const epoch = randomUUID();
  const rpcCalls: { method: string; params: Record<string, unknown> }[] = [];
  let materialized = false;
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== "Bearer " + token) {
      res.writeHead(401).end();
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/api/peer/v1/manifest") {
      res.end(
        JSON.stringify({
          version: "0.25.1",
          epoch,
          platform: process.platform,
          hostname: "peer-b",
          homeDir: root,
          projects: [],
        }),
      );
      return;
    }
    if (url.pathname === "/api/ch/v1/events") {
      res.writeHead(200);
      res.write(
        JSON.stringify({ type: "hello", version: 1, cursor: { epoch, sequence: 1 }, reset: true }) +
          "\n",
      );
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as {
      method?: string;
      params?: Record<string, unknown>;
    };
    const method = body.method ?? "";
    const params = body.params ?? {};
    rpcCalls.push({ method, params });

    if (method === "thread/resume") {
      res.writeHead(400, { "content-type": "application/json" }).end(
        JSON.stringify({
          error: {
            code: -32600,
            message: `no rollout found for thread id ${String(params.threadId)}`,
          },
        }),
      );
      return;
    }
    if (method === "codexhost/sessions/loaded/list") {
      // Official Codex threads are never listed in external idle-release loaded sessions.
      res.end(JSON.stringify({ result: [] }));
      return;
    }
    if (method === "thread/start") {
      const id = String(params.model ?? "").includes("claude-code")
        ? "ext-thread-1"
        : "codex-thread-1";
      res.end(
        JSON.stringify({
          result: {
            thread: {
              id,
              cwd: root,
              modelProvider: id.startsWith("ext") ? "codexhost" : "openai",
              createdAt: 1,
              updatedAt: 1,
              status: { type: "idle" },
              turns: [],
            },
          },
        }),
      );
      return;
    }
    if (method === "codexhost/thread/inspect") {
      const isExt = String(params.threadId).startsWith("ext");
      res.end(
        JSON.stringify({
          result: isExt ? { owner: "external", harnessId: "claude-code" } : { owner: "codex" },
        }),
      );
      return;
    }
    if (method === "codexhost/thread/tree/read") {
      res.end(JSON.stringify({ result: { parents: {} } }));
      return;
    }
    if (method === "codexhost/thread/catalog/read") {
      res.end(
        JSON.stringify({
          result: {
            threads: materialized
              ? [
                  {
                    id: "codex-thread-1",
                    cwd: root,
                    modelProvider: "openai",
                    createdAt: 1,
                    updatedAt: 2,
                    status: { type: "idle" },
                    turns: [],
                  },
                ]
              : [],
            ownership: materialized ? [{ threadId: "codex-thread-1", owner: "codex" }] : [],
            officialCursor: { live: null },
            archivedThreadIds: [],
          },
        }),
      );
      return;
    }
    if (method === "thread/list") {
      res.end(
        JSON.stringify({
          result: {
            data: materialized
              ? [
                  {
                    id: "codex-thread-1",
                    cwd: root,
                    modelProvider: "openai",
                    createdAt: 1,
                    updatedAt: 2,
                    status: { type: "idle" },
                    turns: [],
                  },
                ]
              : [],
            nextCursor: null,
          },
        }),
      );
      return;
    }
    if (method === "turn/start") {
      if (params.threadId === "fail-thread") {
        res
          .writeHead(400, { "content-type": "application/json" })
          .end(JSON.stringify({ error: { code: -32073, message: "Adapter rejected turn" } }));
        return;
      }
      res.end(JSON.stringify({ result: { turn: { id: "turn-1" } } }));
      return;
    }
    res.end(JSON.stringify({ result: {} }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const store = new PeerHostStore(new DataDir(root));
  const manager = new PeerHostManager(store, async () => [], new EventHub(root), {
    allowLoopback: true,
  });
  t.after(() => {
    manager.close();
    server.closeAllConnections();
    server.close();
    rmSync(root, { recursive: true, force: true });
  });
  const rpc = new RpcRegistry();
  manager.register(rpc);
  const added = await rpc.dispatch(
    methods.add,
    { args: { connectionUrl: `${origin}/#token=${token}` } },
    { local: true, credential: "local", release() {} },
  );
  assert.equal(added.ok, true);
  const hostId = (added.value as { peer: { hostId: string } }).peer.hostId;
  const call = createCompositeRemoteCall(manager, async () => {
    throw Error("No Desktop");
  });

  // 1. Official Codex startSelected + prompt must not call thread/resume or send empty config.
  await call({
    kind: "startSelected",
    hostId,
    epoch,
    cwd: root,
    harnessId: "codex",
    model: "gpt-5.4",
  });
  const startCall = rpcCalls.find((c) => c.method === "thread/start");
  assert.ok(startCall);
  assert.equal("config" in startCall.params, false);
  assert.equal("serviceTier" in startCall.params, false);

  await call({
    kind: "prompt",
    hostId,
    epoch,
    threadId: "codex-thread-1",
    text: "hello codex",
    requestId: "req-1",
  });
  assert.equal(
    rpcCalls.some((c) => c.method === "thread/resume"),
    false,
  );

  // Once materialized in catalog/read, source.listThreads() returns the thread with codex ownership.
  materialized = true;
  const source = manager.source(hostId);
  assert.ok(source);
  const postList = await source.listThreads();
  assert.equal(postList.rows[0]?.id, "codex-thread-1");
  assert.equal(postList.harnessIds.get("codex-thread-1"), "codex");

  // 2. External Harness startSelected + prompt also succeeds cleanly.
  await call({
    kind: "startSelected",
    hostId,
    epoch,
    cwd: root,
    harnessId: "claude-code",
    model: "codexhost-harness:claude-code:haiku",
  });
  await call({
    kind: "prompt",
    hostId,
    epoch,
    threadId: "ext-thread-1",
    text: "hello claude",
  });

  // 3. Structured JSON-RPC errors surface their actual message instead of generic HTTP 400.
  await assert.rejects(
    call({
      kind: "prompt",
      hostId,
      epoch,
      threadId: "fail-thread",
      text: "trigger error",
    }),
    /Adapter rejected turn/,
  );

  // 4. Reconnect, disable, and remove close previous PeerThreadSource instances.
  const firstSource = manager.source(hostId);
  assert.ok(firstSource);
  const peerId = (added.value as { peer: { peerId: string } }).peer.peerId;
  await rpc.dispatch(
    methods.reconnect,
    { args: { peerId } },
    { local: true, credential: "local", release() {} },
  );
  const secondSource = manager.source(hostId);
  assert.ok(secondSource && secondSource !== firstSource);
  await assert.rejects(firstSource.host.request("codexhost/thread/tree/read", {}), {
    code: "remote/offline",
  });

  await rpc.dispatch(
    methods.update,
    { args: { peerId, enabled: false } },
    { local: true, credential: "local", release() {} },
  );
  assert.equal(manager.source(hostId), undefined);
  await assert.rejects(secondSource.host.request("codexhost/thread/tree/read", {}), {
    code: "remote/offline",
  });

  await rpc.dispatch(
    methods.update,
    { args: { peerId, enabled: true } },
    { local: true, credential: "local", release() {} },
  );
  const thirdSource = manager.source(hostId);
  assert.ok(thirdSource);
  await rpc.dispatch(
    methods.remove,
    { args: { peerId } },
    { local: true, credential: "local", release() {} },
  );
  assert.equal(manager.source(hostId), undefined);
  assert.equal(manager.client(hostId), undefined);
  await assert.rejects(thirdSource.host.request("codexhost/thread/tree/read", {}), {
    code: "remote/offline",
  });
});

it("preserves peer manifest across same-origin reconnect/update and clears it on origin change or disable", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "peer-manifest-preserve-"));
  const token = "preserve-secret";
  const startPeer = async (projectName: string, hostname: string) => {
    const epoch = randomUUID();
    let holdManifest = false;
    const heldManifests: Array<() => void> = [];
    const openStreams: ServerResponse[] = [];
    const server = createServer((req, res) => {
      if (req.headers.authorization !== "Bearer " + token) {
        res.writeHead(401).end();
        return;
      }
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/api/peer/v1/manifest") {
        const send = () => {
          if (res.destroyed || res.writableEnded) return;
          res.end(
            JSON.stringify({
              version: "1",
              epoch,
              platform: process.platform,
              hostname,
              homeDir: root,
              projects: [{ id: `ws-${hostname}`, name: projectName, path: root, threadIds: [] }],
            }),
          );
        };
        if (holdManifest) {
          heldManifests.push(send);
        } else {
          send();
        }
        return;
      }
      if (url.pathname === "/api/ch/v1/events") {
        openStreams.push(res);
        res.writeHead(200);
        res.write(
          JSON.stringify({
            type: "hello",
            version: 1,
            cursor: { epoch, sequence: 1 },
            reset: true,
          }) + "\n",
        );
        return;
      }
      res.writeHead(404).end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    return {
      origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      epoch,
      setHoldManifest(value: boolean) {
        holdManifest = value;
      },
      releaseManifests() {
        while (heldManifests.length > 0) {
          heldManifests.shift()?.();
        }
      },
      close() {
        while (heldManifests.length > 0) {
          heldManifests.shift()?.();
        }
        for (const stream of openStreams) stream.destroy();
        server.closeAllConnections();
        server.close();
      },
    };
  };

  const [peerA, peerB] = await Promise.all([
    startPeer("Alpha", "peer-a"),
    startPeer("Beta", "peer-b"),
  ]);
  const store = new PeerHostStore(new DataDir(root));
  const manager = new PeerHostManager(store, async () => [], new EventHub(root), {
    allowLoopback: true,
  });
  t.after(() => {
    manager.close();
    peerA.close();
    peerB.close();
    rmSync(root, { recursive: true, force: true });
  });

  const rpc = new RpcRegistry();
  manager.register(rpc);
  const invoke = async <T = Record<string, unknown>>(
    action: keyof typeof methods,
    input: object,
  ): Promise<T> => {
    const res = await rpc.dispatch(
      methods[action],
      { args: input },
      { local: true, credential: "local", release() {} },
    );
    assert.equal(res.ok, true);
    return res.value as T;
  };

  const added = await invoke<{ peer: { peerId: string; hostId: string } }>("add", {
    connectionUrl: `${peerA.origin}/#token=${token}`,
  });
  const { peerId, hostId } = added.peer;
  const hostSnapshot = () => manager.hosts().find((h) => h.hostId === hostId);
  assert.equal(hostSnapshot()?.projects?.[0]?.name, "Alpha");
  assert.equal(hostSnapshot()?.epoch, peerA.epoch);

  const observedOnChange: Array<{
    projects: { name: string }[] | undefined;
    epoch: string | undefined;
  }> = [];
  manager.onChange = (changedHostId) => {
    if (changedHostId !== hostId) return;
    const h = hostSnapshot();
    observedOnChange.push({
      projects: h?.projects?.map((project) => ({ name: project.name })),
      epoch: h?.epoch,
    });
  };

  // Hold manifest probes so we observe the transient state right after reconnect / update.
  peerA.setHoldManifest(true);
  await invoke("reconnect", { peerId });
  assert.deepEqual(
    hostSnapshot()?.projects?.map((project) => project.name),
    ["Alpha"],
  );
  assert.equal(hostSnapshot()?.epoch, peerA.epoch);
  assert.equal(hostSnapshot()?.state, "connecting");
  assert.ok(observedOnChange.length > 0);
  assert.ok(observedOnChange.every((entry) => entry.projects?.[0]?.name === "Alpha"));

  observedOnChange.length = 0;
  await invoke("update", { peerId, name: "Peer A Renamed" });
  assert.equal(hostSnapshot()?.displayName, "Peer A Renamed");
  assert.deepEqual(
    hostSnapshot()?.projects?.map((project) => project.name),
    ["Alpha"],
  );
  assert.equal(hostSnapshot()?.epoch, peerA.epoch);
  assert.ok(observedOnChange.length > 0);
  assert.ok(observedOnChange.every((entry) => entry.projects?.[0]?.name === "Alpha"));

  // Switching origin must clear the previous host's manifest before the new host probes.
  peerB.setHoldManifest(true);
  await invoke("update", { peerId, connectionUrl: `${peerB.origin}/#token=${token}` });
  assert.equal(hostSnapshot()?.projects, undefined);
  assert.equal(hostSnapshot()?.epoch, undefined);

  peerB.setHoldManifest(false);
  peerB.releaseManifests();
  for (let i = 0; i < 60 && hostSnapshot()?.projects?.[0]?.name !== "Beta"; i++) {
    await sleep(25);
  }
  assert.equal(hostSnapshot()?.projects?.[0]?.name, "Beta");
  assert.equal(hostSnapshot()?.epoch, peerB.epoch);

  // Disabling the peer clears the cached manifest and removes it from hosts() while keeping it in list.
  await invoke("update", { peerId, enabled: false });
  assert.equal(hostSnapshot(), undefined);
  assert.equal(manager.client(hostId)?.manifest, undefined);
  const listedAfterDisable = await invoke<{
    peers: Array<{ peerId: string; enabled: boolean; state: string; projectCount: number }>;
  }>("list", {});
  const disabledSummary = listedAfterDisable.peers.find((peer) => peer.peerId === peerId);
  assert.equal(disabledSummary?.enabled, false);
  assert.equal(disabledSummary?.state, "disabled");
  assert.equal(disabledSummary?.projectCount, 0);
});

it("accepts writable and read-only peer thread status through readRemoteThreadStatus", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "peer-status-readonly-"));
  const token = "status-secret";
  const epoch = randomUUID();
  let canAcceptDirectInput: boolean | undefined;
  const openStreams: ServerResponse[] = [];
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== "Bearer " + token) {
      res.writeHead(401).end();
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/api/peer/v1/manifest") {
      res.end(
        JSON.stringify({
          version: "1",
          epoch,
          platform: process.platform,
          hostname: "status-peer",
          homeDir: root,
          projects: [],
        }),
      );
      return;
    }
    if (url.pathname === "/api/ch/v1/events") {
      openStreams.push(res);
      res.writeHead(200);
      res.write(
        JSON.stringify({ type: "hello", version: 1, cursor: { epoch, sequence: 1 }, reset: true }) +
          "\n",
      );
      return;
    }
    if (url.pathname === "/api/ch/v1/snapshot") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as {
        threadId?: string;
      };
      res.end(
        JSON.stringify({
          result: {
            cursor: { epoch, sequence: 1 },
            thread: {
              id: body.threadId ?? "t-1",
              cwd: root,
              modelProvider: "openai",
              createdAt: 1,
              updatedAt: 2,
              status: { type: "active", activeFlags: [] },
              turns: [],
              ...(canAcceptDirectInput === undefined ? {} : { canAcceptDirectInput }),
            },
            activeTurnId: "turn-1",
            turnsPage: { data: [], nextCursor: null },
            configuration: {},
            interactions: [],
          },
        }),
      );
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const store = new PeerHostStore(new DataDir(root));
  const manager = new PeerHostManager(store, async () => [], new EventHub(root), {
    allowLoopback: true,
  });
  t.after(() => {
    manager.close();
    for (const stream of openStreams) stream.destroy();
    server.closeAllConnections();
    server.close();
    rmSync(root, { recursive: true, force: true });
  });

  const rpc = new RpcRegistry();
  manager.register(rpc);
  const added = await rpc.dispatch(
    methods.add,
    { args: { connectionUrl: `${origin}/#token=${token}` } },
    { local: true, credential: "local", release() {} },
  );
  assert.equal(added.ok, true);
  const hostId = (added.value as { peer: { hostId: string } }).peer.hostId;
  const invoke = createCompositeRemoteCall(manager, async () => {
    throw Error("No Desktop");
  });

  // Writable threads with omitted or true canAcceptDirectInput pass status validation.
  canAcceptDirectInput = undefined;
  const omittedStatus = await readRemoteThreadStatus(invoke, { hostId, threadId: "t-1" });
  assert.equal(omittedStatus.status, "active");
  assert.equal(omittedStatus.turnId, "turn-1");
  assert.equal(omittedStatus.readOnly, undefined);

  canAcceptDirectInput = true;
  const writableStatus = await readRemoteThreadStatus(invoke, { hostId, threadId: "t-1" });
  assert.equal(writableStatus.readOnly, undefined);

  // Read-only threads surface readOnly: true.
  canAcceptDirectInput = false;
  const readOnlyStatus = await readRemoteThreadStatus(invoke, { hostId, threadId: "t-1" });
  assert.equal(readOnlyStatus.readOnly, true);

  // Explicit readOnly: false from legacy/peer status payloads is also accepted.
  const explicitFalse = await readRemoteThreadStatus(
    async () => ({
      threadId: "t-1",
      status: "idle",
      turnId: null,
      epoch,
      supportsDelivery: true,
      readOnly: false,
    }),
    { hostId, threadId: "t-1" },
  );
  assert.equal(explicitFalse.readOnly, false);
});

it("skips origin check on same-origin update, keeps connection on rename, filters disabled peers from hosts(), and sends lightweight status snapshots", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "peer-update-fast-"));
  const token = "fast-secret";
  const epoch = randomUUID();
  let streamConnections = 0;
  const snapshotBodies: Array<Record<string, unknown>> = [];
  const openStreams: ServerResponse[] = [];
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== "Bearer " + token) {
      res.writeHead(401).end();
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/api/peer/v1/manifest") {
      res.end(
        JSON.stringify({
          version: "1",
          epoch,
          platform: process.platform,
          hostname: "fast-peer",
          homeDir: root,
          projects: [{ id: "ws-1", name: "Repo", path: root, threadIds: [] }],
        }),
      );
      return;
    }
    if (url.pathname === "/api/ch/v1/events") {
      streamConnections += 1;
      openStreams.push(res);
      res.writeHead(200);
      res.write(
        JSON.stringify({ type: "hello", version: 1, cursor: { epoch, sequence: 1 }, reset: true }) +
          "\n",
      );
      return;
    }
    if (url.pathname === "/api/ch/v1/snapshot") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<
        string,
        unknown
      >;
      snapshotBodies.push(body);
      res.end(
        JSON.stringify({
          result: {
            cursor: { epoch, sequence: 1 },
            activeTurnId: "turn-active",
            thread: {
              id: String(body.threadId ?? "t-1"),
              cwd: root,
              modelProvider: "openai",
              createdAt: 1,
              updatedAt: 2,
              status: { type: "active" },
              turns: [],
            },
            turnsPage: {
              data: [{ id: "turn-done", status: "completed", items: [], fingerprint: "fp-done-1" }],
              nextCursor: null,
            },
            configuration: {},
            interactions: [],
          },
        }),
      );
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  let originsCalls = 0;
  const store = new PeerHostStore(new DataDir(root));
  store.save([
    {
      peerId: "offline-enabled",
      name: "Offline Peer",
      origin: "http://127.0.0.1:1",
      token: "unused",
      enabled: true,
      createdAt: "now",
      updatedAt: "now",
    },
  ]);
  const manager = new PeerHostManager(
    store,
    async () => {
      originsCalls += 1;
      return [];
    },
    new EventHub(root),
    { allowLoopback: true },
  );
  t.after(() => {
    manager.close();
    for (const stream of openStreams) stream.destroy();
    server.closeAllConnections();
    server.close();
    rmSync(root, { recursive: true, force: true });
  });

  const rpc = new RpcRegistry();
  manager.register(rpc);
  const invoke = async <T = Record<string, unknown>>(
    action: keyof typeof methods,
    input: object = {},
  ): Promise<T> => {
    const res = await rpc.dispatch(
      methods[action],
      { args: input },
      { local: true, credential: "local", release() {} },
    );
    assert.equal(res.ok, true);
    return res.value as T;
  };

  const added = await invoke<{ peer: { peerId: string; hostId: string; color?: string } }>("add", {
    connectionUrl: `${origin}/#token=${token}`,
    color: "purple",
  });
  const { peerId, hostId } = added.peer;
  assert.equal(added.peer.color, "purple");
  assert.equal(manager.hosts().find((h) => h.hostId === hostId)?.color, "purple");
  // Legacy records without a persisted color load cleanly with color omitted.
  assert.equal(
    manager.hosts().find((h) => h.hostId === "remote-peer:offline-enabled")?.color,
    undefined,
  );
  for (let i = 0; i < 40 && streamConnections < 1; i++) await sleep(20);
  assert.equal(originsCalls, 1);

  // Status snapshot requests compact payloads with truncateToolOutput and learned knownTurns.
  const call = createCompositeRemoteCall(manager, async () => {
    throw Error("No Desktop");
  });
  await readRemoteThreadStatus(call, { hostId, threadId: "t-1" });
  await readRemoteThreadStatus(call, { hostId, threadId: "t-1" });
  assert.deepEqual(snapshotBodies[0], {
    threadId: "t-1",
    knownTurns: [],
    truncateToolOutput: true,
  });
  assert.deepEqual(snapshotBodies[1], {
    threadId: "t-1",
    knownTurns: [{ id: "turn-done", fingerprint: "fp-done-1" }],
    truncateToolOutput: true,
  });

  // Name-only and color-only updates neither call origins() nor reconnect the client/source.
  const clientBeforeRename = manager.client(hostId);
  const sourceBeforeRename = manager.source(hostId);
  const streamsBeforeRename = streamConnections;
  originsCalls = 0;
  await invoke("update", { peerId, name: "Renamed Fast" });
  assert.equal(originsCalls, 0);
  assert.equal(manager.client(hostId), clientBeforeRename);
  assert.equal(manager.source(hostId), sourceBeforeRename);
  assert.equal(streamConnections, streamsBeforeRename);
  assert.equal(manager.hosts().find((h) => h.hostId === hostId)?.displayName, "Renamed Fast");
  assert.equal(manager.hosts().find((h) => h.hostId === hostId)?.color, "purple");

  const recolored = await invoke<{ peer: { color?: string } }>("update", {
    peerId,
    color: "amber",
  });
  assert.equal(originsCalls, 0);
  assert.equal(manager.client(hostId), clientBeforeRename);
  assert.equal(manager.source(hostId), sourceBeforeRename);
  assert.equal(streamConnections, streamsBeforeRename);
  assert.equal(recolored.peer.color, "amber");
  assert.equal(manager.hosts().find((h) => h.hostId === hostId)?.color, "amber");
  assert.equal(store.load().find((r) => r.peerId === peerId)?.color, "amber");

  const cleared = await invoke<{ peer: { color?: string } }>("update", {
    peerId,
    color: null,
  });
  assert.equal(originsCalls, 0);
  assert.equal(manager.client(hostId), clientBeforeRename);
  assert.equal(streamConnections, streamsBeforeRename);
  assert.equal(cleared.peer.color, undefined);
  assert.equal(manager.hosts().find((h) => h.hostId === hostId)?.color, undefined);
  assert.equal(store.load().find((r) => r.peerId === peerId)?.color, undefined);

  // Disabling does not call origins(), excludes the peer from hosts(), keeps it in list,
  // and still keeps enabled-but-offline peers in hosts().
  originsCalls = 0;
  await invoke("update", { peerId, enabled: false });
  assert.equal(originsCalls, 0);
  assert.equal(
    manager.hosts().some((h) => h.hostId === hostId),
    false,
  );
  assert.equal(
    manager.hosts().some((h) => h.hostId === "remote-peer:offline-enabled"),
    true,
  );
  const allPeers = await invoke<{ peers: Array<{ peerId: string; enabled: boolean }> }>("list");
  assert.equal(allPeers.peers.find((p) => p.peerId === peerId)?.enabled, false);
});
