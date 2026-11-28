import { it, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import {
  DELEGATION_HOST_HARNESSES_METHOD,
  DELEGATION_REMOTE_HOSTS_METHOD,
  REMOTE_PEERS_METHODS as methods,
  remotePeerHostId,
  remotePeerIntroduceResultSchema,
  remotePeerPairingReportSchema,
  remotePeerSummarySchema,
  remotePeerTestResultSchema,
  type RemotePeerAddParams,
  type RemotePeerIntroduceParams,
  type RemotePeerPairingReport,
} from "@codexhost/shared-contracts";
import { AccessTokenStore } from "../src/access-tokens.ts";
import { AccessAuth, CredentialConnections } from "../src/auth.ts";
import {
  loadOrCreatePeerNodeId,
  parseConnectionLink,
  PeerHostStore,
  type PeerDnsLookup,
} from "../src/peer-host-store.ts";
import { PeerHostManager, createCompositeRemoteCall } from "../src/peer-host-manager.ts";
import { PeerEndpointError, peerEndpoint, resolveServerVersion } from "../src/peer-manifest.ts";
import { peerPairingEnabled, servePeerPairing } from "../src/peer-pairing-http.ts";
import { resolvePeerSelfOrigin } from "../src/peer-pairing.ts";
import {
  translateThreadLinksForPeer,
  translateThreadLinksFromPeer,
} from "../src/peer-thread-links.ts";
import { RequestTrust } from "../src/request-trust.ts";
import { deliverRemoteInput, readRemoteThreadStatus } from "../src/remote-session-delivery.ts";
import { DataDir } from "../src/store.ts";
import { Workspaces } from "../src/workspaces.ts";
import { EventHub, RpcError, RpcRegistry, StreamRegistry } from "../src/transport.ts";
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
    "http://metadata.google.internal./#token=x",
    "http://localhost./#token=x",
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
  const [a, b, revoked] = await Promise.all([mock(), mock(), mock()]);
  const store = new PeerHostStore(new DataDir(root));
  store.save([
    {
      peerId: "bad",
      name: "Revoked",
      origin: revoked.origin,
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
    revoked.close();
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

it("forwards queued steer on remote peers via codexhost/thread/queue/send-now and maps errors cleanly", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "peer-queued-steer-"));
  const token = "steer-secret";
  const epoch = randomUUID();
  let threadStatus: "active" | "idle" = "active";
  let rpcCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
  let rpcHandler: (
    method: string,
    params: Record<string, unknown>,
  ) => { status: number; body: Record<string, unknown> } = () => ({
    status: 200,
    body: { result: { sent: true, turnId: "turn-steered-1" } },
  });
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
          hostname: "steer-peer",
          homeDir: root,
          projects: [{ id: "ws-1", name: "Repo", path: root, threadIds: [] }],
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
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<
        string,
        unknown
      >;
      res.end(
        JSON.stringify({
          result: {
            cursor: { epoch, sequence: 1 },
            activeTurnId: threadStatus === "active" ? "turn-active" : null,
            thread: {
              id: String(body.threadId ?? "t-1"),
              cwd: root,
              modelProvider: "codexhost",
              cliVersion: "codexhost",
              createdAt: 1,
              updatedAt: 2,
              status: { type: threadStatus },
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
    if (url.pathname === "/api/ch/v1/rpc") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as {
        method: string;
        params: Record<string, unknown>;
      };
      rpcCalls.push(body);
      const reply = rpcHandler(body.method, body.params);
      res.writeHead(reply.status, { "content-type": "application/json" });
      res.end(JSON.stringify(reply.body));
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
  const { hostId } = (added.value as { peer: { hostId: string } }).peer;
  for (let i = 0; i < 40 && openStreams.length < 1; i++) await sleep(20);

  const invoke = createCompositeRemoteCall(manager, async () => {
    throw Error("No Desktop");
  });
  const identity = { hostId, threadId: "t-steer" };
  const readLegacyStatus = async () => {
    throw Error("Legacy status should not be used");
  };

  // Status advertises queued-steer support on Peer Hosts.
  const status = await readRemoteThreadStatus(invoke, identity);
  assert.equal(status.supportsDelivery, true);
  assert.equal(status.supportsQueuedSteer, true);

  // Active external thread steers queued message via codexhost/thread/queue/send-now.
  assert.deepEqual(
    await deliverRemoteInput(
      invoke,
      identity,
      "session/updateQueue",
      { itemId: "q-1", action: { kind: "steer" } },
      readLegacyStatus,
    ),
    { accepted: true },
  );
  assert.deepEqual(rpcCalls, [
    { method: "codexhost/thread/queue/send-now", params: { threadId: "t-steer", itemId: "q-1" } },
  ]);

  // Native Codex send-now confirmation shapes ({ turnId } and { turn: { id } }) also succeed.
  rpcCalls = [];
  rpcHandler = () => ({ status: 200, body: { result: { turnId: "turn-native-active" } } });
  assert.deepEqual(
    await deliverRemoteInput(
      invoke,
      identity,
      "session/updateQueue",
      { itemId: "q-2", action: { kind: "steer" } },
      readLegacyStatus,
    ),
    { accepted: true },
  );

  rpcHandler = () => ({ status: 200, body: { result: { turn: { id: "turn-native-idle" } } } });
  assert.deepEqual(
    await deliverRemoteInput(
      invoke,
      identity,
      "session/updateQueue",
      { itemId: "q-3", action: { kind: "steer" } },
      readLegacyStatus,
    ),
    { accepted: true },
  );

  // Missing queued item maps to session/queue-item-not-found.
  rpcHandler = () => ({
    status: 400,
    body: { error: { code: -32072, message: "Queued message not found" } },
  });
  await assert.rejects(
    deliverRemoteInput(
      invoke,
      identity,
      "session/updateQueue",
      { itemId: "q-missing", action: { kind: "steer" } },
      readLegacyStatus,
    ),
    (error: unknown) => error instanceof RpcError && error.code === "session/queue-item-not-found",
  );

  // Already-starting queued item maps to session/queue-item-starting.
  rpcHandler = () => ({
    status: 400,
    body: { error: { code: -32072, message: "Queued message is already starting" } },
  });
  await assert.rejects(
    deliverRemoteInput(
      invoke,
      identity,
      "session/updateQueue",
      { itemId: "q-starting", action: { kind: "steer" } },
      readLegacyStatus,
    ),
    (error: unknown) => error instanceof RpcError && error.code === "session/queue-item-starting",
  );

  // Unconfirmed native queue deletion maps to remote/outcome-unknown.
  rpcHandler = () => ({
    status: 400,
    body: {
      error: {
        code: -32095,
        message: "Codex accepted the steer, but queue removal was not confirmed. Do not resend.",
      },
    },
  });
  await assert.rejects(
    deliverRemoteInput(
      invoke,
      identity,
      "session/updateQueue",
      { itemId: "q-unknown", action: { kind: "steer" } },
      readLegacyStatus,
    ),
    (error: unknown) => error instanceof RpcError && error.code === "remote/outcome-unknown",
  );

  // Older peers lacking send-now return remote/steer-unavailable while active and fall back to thread/queue/start while idle.
  rpcCalls = [];
  rpcHandler = (method) =>
    method === "codexhost/thread/queue/send-now"
      ? {
          status: 400,
          body: { error: { code: -32601, message: "Unsupported client channel method" } },
        }
      : { status: 200, body: { result: { turn: { id: "turn-fallback" } } } };
  await assert.rejects(
    deliverRemoteInput(
      invoke,
      identity,
      "session/updateQueue",
      { itemId: "q-old-active", action: { kind: "steer" } },
      readLegacyStatus,
    ),
    (error: unknown) => error instanceof RpcError && error.code === "remote/steer-unavailable",
  );

  threadStatus = "idle";
  rpcCalls = [];
  assert.deepEqual(
    await deliverRemoteInput(
      invoke,
      identity,
      "session/updateQueue",
      { itemId: "q-old-idle", action: { kind: "steer" } },
      readLegacyStatus,
    ),
    { accepted: true },
  );
  assert.deepEqual(rpcCalls, [
    {
      method: "codexhost/thread/queue/send-now",
      params: { threadId: "t-steer", itemId: "q-old-idle" },
    },
    {
      method: "thread/queue/start",
      params: { threadId: "t-steer", queuedSubmissionId: "q-old-idle" },
    },
  ]);
});

it("persists stable nodeId, exposes anonymous peerNodes, supports legacy peers, and blocks self-pairing by nodeId", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "peer-node-identity-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const data = new DataDir(root);

  // 1. node-identity-v1.json persists across reloads with 0600 mode and recovers from corruption.
  const firstNodeId = loadOrCreatePeerNodeId(data);
  assert.ok(firstNodeId.length > 0);
  if (process.platform !== "win32") {
    assert.equal(statSync(data.path("node-identity-v1.json")).mode & 0o777, 0o600);
  }
  assert.equal(loadOrCreatePeerNodeId(data), firstNodeId);

  writeFileSync(data.path("node-identity-v1.json"), "{corrupt-json", "utf8");
  const recoveredCorrupt = loadOrCreatePeerNodeId(data);
  assert.notEqual(recoveredCorrupt, firstNodeId);
  assert.equal(loadOrCreatePeerNodeId(data), recoveredCorrupt);

  writeFileSync(
    data.path("node-identity-v1.json"),
    JSON.stringify({ version: 2, nodeId: "bad/id" }),
    "utf8",
  );
  const localNodeId = loadOrCreatePeerNodeId(data);
  assert.notEqual(localNodeId, recoveredCorrupt);
  assert.equal(loadOrCreatePeerNodeId(data), localNodeId);

  // 2. Helper stub peers: one with localNodeId (self via alias URL), one modern peer B, one legacy peer (no nodeId).
  const secretToken = "peer-identity-secret";
  const makeStubPeer = async (manifestExtra: Record<string, unknown>) => {
    const epoch = randomUUID();
    const server = createServer((req, res) => {
      if (req.headers.authorization !== `Bearer ${secretToken}`) {
        res.writeHead(401).end();
        return;
      }
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/api/peer/v1/manifest") {
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            version: "0.26.1",
            epoch,
            platform: process.platform,
            hostname: "stub-host",
            projects: [],
            capabilities: { delegation: 1 },
            ...manifestExtra,
          }),
        );
        return;
      }
      if (url.pathname === "/api/ch/v1/events") {
        res.writeHead(200);
        res.write(
          `${JSON.stringify({ type: "hello", version: 1, cursor: { epoch, sequence: 1 }, reset: true })}\n`,
        );
        return;
      }
      res.writeHead(404).end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    return {
      origin,
      close: () => {
        server.closeAllConnections();
        server.close();
      },
    };
  };

  const selfAlias = await makeStubPeer({ nodeId: localNodeId });
  const peerB = await makeStubPeer({ nodeId: "node-b-id" });
  const legacyPeer = await makeStubPeer({});
  t.after(() => {
    selfAlias.close();
    peerB.close();
    legacyPeer.close();
  });

  // Load duplicate bindings from disk to exercise routing for existing configurations.
  const peerBId = "peer-b";
  const peerB2HostId = remotePeerHostId("peer-b-duplicate");
  const now = new Date().toISOString();
  const store = new PeerHostStore(data);
  store.save(
    [peerBId, "peer-b-duplicate"].map((peerId) => ({
      peerId,
      name: "Modern B",
      origin: peerB.origin,
      token: secretToken,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    })),
  );
  const manager = new PeerHostManager(store, async () => [], new EventHub(root), {
    allowLoopback: true,
    localNodeId,
  });
  t.after(() => manager.close());
  const rpc = new RpcRegistry();
  manager.register(rpc);
  const localAuth = { local: true, credential: "local", release() {} };

  assert.equal(manager.selfNodeId(), localNodeId);
  assert.equal(manager.nodeIdForHostId("local"), localNodeId);
  assert.equal(manager.hostIdForNodeId(localNodeId), "local");

  // 3. Reject self-pairing via nodeId on `test`, `add`, and `update` even when origin is not in `origins()`.
  const testedSelf = await rpc.dispatch(
    methods.test,
    { args: { connectionUrl: `${selfAlias.origin}/#token=${secretToken}` } },
    localAuth,
  );
  assert.equal(testedSelf.ok, true);
  assert.deepEqual(testedSelf.value, {
    ok: false,
    error: "Cannot pair this server with itself",
  });

  const addedSelf = await rpc.dispatch(
    methods.add,
    { args: { connectionUrl: `${selfAlias.origin}/#token=${secretToken}` } },
    localAuth,
  );
  assert.equal(addedSelf.ok, false);
  assert.match(addedSelf.error.message, /Cannot pair this server with itself/u);

  // 4. Add a legacy Peer (no nodeId) and verify the update self-pair block.
  const peerBHostId = remotePeerHostId(peerBId);
  await manager.waitForInitialConnection(peerBHostId);
  await manager.waitForInitialConnection(peerB2HostId);
  assert.equal(manager.nodeIdForHostId(peerBHostId), "node-b-id");

  const addedLegacy = await rpc.dispatch(
    methods.add,
    { args: { connectionUrl: `${legacyPeer.origin}/#token=${secretToken}`, name: "Legacy" } },
    localAuth,
  );
  assert.equal(addedLegacy.ok, true);
  const legacyInfo = (addedLegacy.value as { peer: { hostId: string; nodeId?: string } }).peer;
  assert.equal(legacyInfo.nodeId, undefined);

  const updatedToSelf = await rpc.dispatch(
    methods.update,
    {
      args: {
        peerId: peerBId,
        connectionUrl: `${selfAlias.origin}/#token=${secretToken}`,
      },
    },
    localAuth,
  );
  assert.equal(updatedToSelf.ok, false);
  assert.match(updatedToSelf.error.message, /Cannot pair this server with itself/u);
  assert.equal(manager.client(peerBHostId)?.record.origin, peerB.origin);

  // 5. Multiple peers with same nodeId: hostIdForNodeId prefers state === "connected".
  const firstClient = manager.client(peerBHostId);
  assert.ok(firstClient);
  firstClient.state = "offline";
  assert.equal(manager.hostIdForNodeId("node-b-id"), peerB2HostId);
  assert.equal(manager.nodeIdForHostId(peerB2HostId), "node-b-id");
  assert.equal(manager.nodeIdForHostId(legacyInfo.hostId), undefined);

  // 6. peerEndpoint manifest exposes nodeId and strictly anonymous peerNodes (no URL/name/token).
  const ws = new Workspaces(data, root, true);
  const wsRpc = new RpcRegistry();
  ws.register(wsRpc, new StreamRegistry());
  const manifest = await peerEndpoint(
    "GET",
    new URL("http://127.0.0.1/api/peer/v1/manifest"),
    {},
    ws,
    wsRpc,
    "epoch-1",
    "0.26.1",
    [root],
    { nodeId: manager.selfNodeId(), peerNodes: manager.peerNodes() },
  );
  const serialized = JSON.stringify(manifest);
  assert.equal(serialized.includes(secretToken), false);
  assert.equal(serialized.includes(peerB.origin), false);
  assert.equal(serialized.includes("Modern B"), false);
  const parsedManifest = manifest as { nodeId?: string; peerNodes?: Record<string, string> };
  assert.equal(parsedManifest.nodeId, localNodeId);
  assert.equal(parsedManifest.peerNodes?.[peerB2HostId], "node-b-id");
  assert.equal(Object.hasOwn(parsedManifest.peerNodes ?? {}, legacyInfo.hostId), false);

  // delegationHosts carries nodeId for modern peers and omits it for legacy peers.
  const dHosts = manager.delegationHosts();
  assert.equal(dHosts.find((h) => h.hostId === peerB2HostId)?.nodeId, "node-b-id");
  assert.equal(dHosts.find((h) => h.hostId === legacyInfo.hostId)?.nodeId, undefined);
});

const pairingAuth = { local: true, credential: "local", release() {} };

async function pairingNode(
  t: TestContext,
  name: string,
  options: {
    nodeId?: string;
    allowLoopback?: boolean;
    dnsLookup?: PeerDnsLookup;
    extraTokens?: string[];
    resolveSelfShare?: (
      origin: string,
      token: string,
      preferredOrigin?: string,
    ) => Promise<{ origin: string; token: string; name: string } | { error: string }>;
    onIntroduceBody?: (body: string) => void;
    introductionFailure?: () => string;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "peer-pairing-"));
  const data = new DataDir(root);
  const store = new PeerHostStore(data);
  const tokens = new AccessTokenStore(data);
  const token = tokens.current().secret;
  const trust = new RequestTrust(undefined);
  const auth = new AccessAuth(tokens, trust, new CredentialConnections());
  const rpc = new RpcRegistry();
  const ws = new Workspaces(data, root, true);
  const epoch = randomUUID();
  const manager = new PeerHostManager(store, async () => [origin], new EventHub(root), {
    allowLoopback: options.allowLoopback ?? true,
    ...(options.dnsLookup === undefined ? {} : { dnsLookup: options.dnsLookup }),
    ...(options.nodeId === undefined ? {} : { localNodeId: options.nodeId }),
    resolveSelfShare: async (preferredOrigin) => {
      if (options.resolveSelfShare) {
        return options.resolveSelfShare(origin, token, preferredOrigin);
      }
      const share = resolvePeerSelfOrigin([], preferredOrigin, origin);
      return "error" in share ? share : { ...share, token, name };
    },
  });
  manager.register(rpc);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", origin);
    const extraAuthorized =
      options.extraTokens?.some((extra) => req.headers.authorization === `Bearer ${extra}`) ??
      false;
    if (!extraAuthorized) {
      const admission = await auth.gate(req, res, url.pathname);
      if (admission.handled) return;
      if (!admission.auth || !trust.sameOrigin(req)) {
        res.writeHead(403).end();
        return;
      }
    }
    if (url.pathname === "/api/peer/v1/peers") {
      if (options.introductionFailure) {
        req.resume();
        res.writeHead(400).end(JSON.stringify({ error: options.introductionFailure() }));
        return;
      }
      if (options.onIntroduceBody) {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => options.onIntroduceBody?.(Buffer.concat(chunks).toString("utf8")));
      }
      await servePeerPairing(req, res, manager);
      return;
    }
    if (url.pathname === "/api/peer/v1/manifest") {
      const manifest = await peerEndpoint("GET", url, {}, ws, rpc, epoch, "1", [], {
        peerPairing: peerPairingEnabled(),
        nodeId: manager.selfNodeId(),
        peerNodes: manager.peerNodes(),
      });
      res.writeHead(200).end(JSON.stringify(manifest));
      return;
    }
    if (url.pathname === "/api/ch/v1/events") {
      res.writeHead(200);
      res.write(
        `${JSON.stringify({ type: "hello", version: 1, cursor: { epoch, sequence: 1 }, reset: false })}\n`,
      );
      return;
    }
    res.writeHead(404).end();
  });
  t.after(() => {
    manager.close();
    server.closeAllConnections();
    server.close();
    tokens.close();
    rmSync(root, { recursive: true, force: true });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const connection = {
    origin,
    token,
    name,
    ...(options.nodeId === undefined ? {} : { expectedNodeId: options.nodeId }),
  };
  return {
    connection,
    manager,
    store,
    rpc,
    introduce: (input: RemotePeerIntroduceParams, headers?: Record<string, string>) =>
      fetch(`${origin}/api/peer/v1/peers`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, ...headers },
        body: JSON.stringify(input),
      }),
    add: async (input: RemotePeerAddParams) => {
      const added = await rpc.dispatch(methods.add, { args: input }, pairingAuth);
      assert.ok(added.ok, JSON.stringify(added));
      const value = added.value as { peer: unknown; pairing?: RemotePeerPairingReport };
      return { peer: remotePeerSummarySchema.parse(value.peer), pairing: value.pairing };
    },
  };
}

it("pairs two Hosts on add, forms a three-Host mesh, and immediately translates links with the refreshed manifests", async (t) => {
  const a = await pairingNode(t, "A", { nodeId: "node-a" });
  const b = await pairingNode(t, "B", { nodeId: "node-b" });
  const c = await pairingNode(t, "C", { nodeId: "node-c" });
  const tested = await a.rpc.dispatch(methods.test, { args: b.connection }, pairingAuth);
  assert.ok(tested.ok);
  assert.deepEqual(
    remotePeerTestResultSchema
      .pick({ nodeId: true, supportsPeerPairing: true, pairedBack: true })
      .parse(tested.value),
    { nodeId: "node-b", supportsPeerPairing: true, pairedBack: false },
  );

  const ab = await a.add({ ...b.connection, pairBack: true });
  assert.deepEqual(
    ab.pairing?.results.map(({ introducedHost, status }) => [introducedHost, status]),
    [["local", "added"]],
  );
  assert.equal(ab.peer.pairedBack, true);
  assert.ok(
    b.store.load().some((p) => p.origin === a.connection.origin && p.token === a.connection.token),
  );

  const ac = await a.add({
    ...c.connection,
    pairBack: true,
    meshPeerIds: [ab.peer.peerId, ab.peer.peerId, "missing"],
  });
  assert.equal(ac.peer.pairedBack, true);
  assert.deepEqual(ac.peer.linkedPeerIds, [ab.peer.peerId]);
  const listAfterMesh = await a.rpc.dispatch(methods.list, { args: {} }, pairingAuth);
  assert.ok(listAfterMesh.ok);
  const peersAfterMesh = (
    listAfterMesh.value as { peers: Array<{ peerId: string; linkedPeerIds?: string[] }> }
  ).peers;
  assert.deepEqual(peersAfterMesh.find((p) => p.peerId === ab.peer.peerId)?.linkedPeerIds, [
    ac.peer.peerId,
  ]);
  assert.deepEqual(peersAfterMesh.find((p) => p.peerId === ac.peer.peerId)?.linkedPeerIds, [
    ab.peer.peerId,
  ]);
  assert.deepEqual(
    ac.pairing?.results.map(({ targetPeerId, introducedHost, status }) => [
      targetPeerId,
      introducedHost,
      status,
    ]),
    [
      [ac.peer.peerId, "local", "added"],
      [ab.peer.peerId, ac.peer.peerId, "added"],
      [ac.peer.peerId, ab.peer.peerId, "added"],
    ],
  );
  assert.deepEqual(
    b.store
      .load()
      .map(({ origin }) => origin)
      .sort(),
    [a.connection.origin, c.connection.origin].sort(),
  );
  assert.deepEqual(
    c.store
      .load()
      .map(({ origin }) => origin)
      .sort(),
    [a.connection.origin, b.connection.origin].sort(),
  );

  const link = (threadId: string, hostId: string) =>
    `thread://${threadId}?hostId=${encodeURIComponent(hostId)}`;
  for (const [target, own, other, otherNodeId] of [
    [b, ab.peer, ac.peer, "node-c"],
    [c, ac.peer, ab.peer, "node-b"],
  ] as const) {
    const targetClient = a.manager.client(own.hostId);
    assert.ok(targetClient);
    const peerNodes = targetClient.manifest?.peerNodes;
    const inTarget = target.manager.hostIdForNodeId(otherNodeId);
    const localInTarget = target.manager.hostIdForNodeId("node-a");
    assert.ok(inTarget && localInTarget);
    const links = `${link("self", "local")} ${link("other", other.hostId)}`;
    const translated = translateThreadLinksForPeer(`${links} ${link("target", own.hostId)}`, {
      targetHostId: own.hostId,
      targetNodeId: targetClient.manifest?.nodeId,
      targetPeerNodes: peerNodes,
      nodeIdForHostId: (hostId) => a.manager.nodeIdForHostId(hostId),
    });
    assert.equal(
      translated,
      `${link("self", localInTarget)} ${link("other", inTarget)} ${link("target", "local")}`,
    );
    assert.equal(
      translateThreadLinksFromPeer(`${link("self", localInTarget)} ${link("other", inTarget)}`, {
        sourcePeerNodes: peerNodes,
        hostIdForNodeId: (nodeId) => a.manager.hostIdForNodeId(nodeId),
      }),
      links,
    );
  }

  const denied = await a.rpc.dispatch(
    methods.syncMesh,
    { args: {} },
    { ...pairingAuth, local: false },
  );
  assert.ok(!denied.ok);
  assert.equal(denied.error.code, "auth/local-required");
  const cb = c.store.load().find(({ origin }) => origin === b.connection.origin);
  assert.ok(cb);
  const removed = await c.rpc.dispatch(
    methods.remove,
    { args: { peerId: cb.peerId } },
    pairingAuth,
  );
  assert.ok(removed.ok);
  await a.manager.client(ac.peer.hostId)?.probe();
  const listOneWay = await a.rpc.dispatch(methods.list, { args: {} }, pairingAuth);
  assert.ok(listOneWay.ok);
  const peersOneWay = (
    listOneWay.value as { peers: Array<{ peerId: string; linkedPeerIds?: string[] }> }
  ).peers;
  assert.deepEqual(peersOneWay.find((p) => p.peerId === ac.peer.peerId)?.linkedPeerIds, []);
  assert.deepEqual(peersOneWay.find((p) => p.peerId === ab.peer.peerId)?.linkedPeerIds, [
    ac.peer.peerId,
  ]);
  const synced = await a.rpc.dispatch(methods.syncMesh, { args: {} }, pairingAuth);
  assert.ok(synced.ok);
  const steps = remotePeerPairingReportSchema.parse(synced.value).results;
  assert.deepEqual(
    steps.map(({ status }) => status),
    ["existing", "existing", "existing", "added"],
  );
  const restored = c.manager.hostIdForNodeId("node-b");
  assert.ok(restored);
  assert.notEqual(restored, `remote-peer:${cb.peerId}`);
  assert.equal(a.manager.client(ac.peer.hostId)?.manifest?.peerNodes?.[restored], "node-b");
  const listRestored = await a.rpc.dispatch(methods.list, { args: {} }, pairingAuth);
  assert.ok(listRestored.ok);
  const peersRestored = (
    listRestored.value as { peers: Array<{ peerId: string; linkedPeerIds?: string[] }> }
  ).peers;
  assert.deepEqual(peersRestored.find((p) => p.peerId === ac.peer.peerId)?.linkedPeerIds, [
    ab.peer.peerId,
  ]);
});

it("rejects duplicate origins and nodeIds on local add and update without changing existing peers", async (t) => {
  const a = await pairingNode(t, "A", { nodeId: "node-a" });
  const b = await pairingNode(t, "B", { nodeId: "node-b" });
  const alias = await pairingNode(t, "B alias", { nodeId: "node-b" });
  const legacy = await pairingNode(t, "Legacy");
  const { peer: modernPeer } = await a.add(b.connection);
  assert.equal(modernPeer.nodeId, "node-b");
  const { peer: legacyPeer } = await a.add(legacy.connection);
  const stored = a.store.load();
  const sameOrigin = {
    connectionUrl: `${legacy.connection.origin}/different-path#token=${legacy.connection.token}`,
  };

  for (const [method, args, conflict] of [
    [methods.add, sameOrigin, /origin/u],
    [methods.add, alias.connection, /nodeId/u],
    [methods.update, { ...sameOrigin, peerId: modernPeer.peerId }, /origin/u],
    [methods.update, { ...alias.connection, peerId: legacyPeer.peerId }, /nodeId/u],
  ] as const) {
    const rejected = await a.rpc.dispatch(method, { args }, pairingAuth);
    assert.equal(rejected.ok, false, `${method} must reject a duplicate ${conflict}`);
    assert.equal(rejected.error.code, "remote/duplicate-peer");
    assert.match(rejected.error.message, conflict);
    assert.deepEqual(a.store.load(), stored);
    assert.deepEqual(
      a.manager.hosts().map((host) => host.hostId),
      [modernPeer.hostId, legacyPeer.hostId],
    );
  }
});

it("keeps verified introductions idempotent and rejects silent origin or token replacement on existing peers", async (t) => {
  const a = await pairingNode(t, "A", { nodeId: "node-a" });
  const rotatedToken = "rotated-secret-token";
  const b = await pairingNode(t, "B", { nodeId: "node-b", extraTokens: [rotatedToken] });
  const moved = await pairingNode(t, "B moved", { nodeId: "node-b" });
  const legacy = await pairingNode(t, "Legacy");
  const ab = await a.add({ ...b.connection, name: "Custom B", color: "cyan" });
  assert.equal(ab.pairing, undefined);
  const same = await a.introduce({
    ...b.connection,
    origin: `${b.connection.origin}/different-path`,
    color: "blue",
  });
  assert.equal(same.status, 200);
  const existing = {
    status: "existing",
    peerId: ab.peer.peerId,
    hostId: ab.peer.hostId,
    nodeId: "node-b",
  };
  assert.deepEqual(await same.json(), existing);

  // Changing origin for an existing nodeId must be rejected with 409 and leave the binding intact.
  const hijackOrigin = await a.introduce({ ...moved.connection, color: "rose" });
  assert.equal(hijackOrigin.status, 409);
  assert.match(((await hijackOrigin.json()) as { error: string }).error, /update it locally/u);

  // Changing token for an existing peer (same nodeId & origin) must also be rejected with 409.
  const hijackToken = await a.introduce({ ...b.connection, token: rotatedToken });
  assert.equal(hijackToken.status, 409);
  assert.match(((await hijackToken.json()) as { error: string }).error, /update it locally/u);

  // Even when the existing record is disabled, introducing a different origin/token is rejected.
  const disabled = await a.rpc.dispatch(
    methods.update,
    { args: { peerId: ab.peer.peerId, enabled: false } },
    pairingAuth,
  );
  assert.ok(disabled.ok);
  const hijackDisabled = await a.introduce({ ...moved.connection, color: "rose" });
  assert.equal(hijackDisabled.status, 409);
  assert.equal(a.store.load()[0]?.origin, b.connection.origin);
  assert.equal(a.store.load()[0]?.token, b.connection.token);
  assert.equal(a.store.load()[0]?.enabled, false);

  // Re-introducing the exact same origin and token re-enables without changing the binding or custom metadata.
  const reenabled = await a.introduce({ ...b.connection, color: "rose" });
  assert.equal(reenabled.status, 200);
  assert.deepEqual(await reenabled.json(), { ...existing, status: "updated" });
  const [stored] = a.store.load();
  assert.deepEqual(stored, {
    peerId: ab.peer.peerId,
    nodeId: "node-b",
    name: "Custom B",
    color: "cyan",
    origin: b.connection.origin,
    token: b.connection.token,
    enabled: true,
    createdAt: ab.peer.createdAt,
    updatedAt: stored?.updatedAt,
  });
  for (const input of [
    { ...moved.connection, expectedNodeId: "different-node" },
    { ...legacy.connection, expectedNodeId: "node-legacy" },
  ]) {
    const rejected = await a.introduce(input);
    assert.equal(rejected.status, 409);
    assert.deepEqual(await rejected.json(), {
      error: "Introduced peer did not match the expected nodeId",
    });
  }
  assert.deepEqual(a.store.load(), [stored]);
  const oldClient = await a.introduce(legacy.connection);
  assert.equal(oldClient.status, 200);
  const oldResult = remotePeerIntroduceResultSchema.parse(await oldClient.json());
  assert.equal(oldResult.nodeId, undefined);
  const legacyAgain = await a.introduce({
    ...legacy.connection,
    origin: `${legacy.connection.origin}/#unused`,
  });
  assert.deepEqual(await legacyAgain.json(), { ...oldResult, status: "existing" });
});

it("blocks DNS-rebinding SSRF in peer probes, pins verified IPs with original Host, and forbids redirects", async (t) => {
  const token = "dns-pin-secret";
  let requestCount = 0;
  const receivedHosts: string[] = [];
  let redirectMode = false;
  const targetServer = createServer((req, res) => {
    requestCount += 1;
    if (typeof req.headers.host === "string") receivedHosts.push(req.headers.host);
    if (redirectMode) {
      res.writeHead(302, { location: "/api/peer/v1/manifest" }).end();
      return;
    }
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401).end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        version: "1",
        epoch: "epoch-dns",
        platform: process.platform,
        hostname: "pinned-peer",
        nodeId: "node-pinned",
        projects: [],
        capabilities: { peerPairing: 1 },
      }),
    );
  });
  targetServer.listen(0, "127.0.0.1");
  await once(targetServer, "listening");
  t.after(() => {
    targetServer.closeAllConnections();
    targetServer.close();
  });
  const port = (targetServer.address() as { port: number }).port;

  let goodLookupCalls = 0;
  const fakeDns: PeerDnsLookup = async (hostname) => {
    switch (hostname) {
      case "loop.attacker.example":
        return [{ address: "127.0.0.1", family: 4 }];
      case "meta.attacker.example":
        return [{ address: "169.254.169.254", family: 4 }];
      case "mixed.attacker.example":
        return [
          { address: "93.184.216.34", family: 4 },
          { address: "169.254.169.254", family: 4 },
        ];
      case "v4mapped.attacker.example":
        return [{ address: "::ffff:127.0.0.1", family: 6 }];
      case "good.peer.example":
        goodLookupCalls += 1;
        // Rebind on any second lookup to prove the probe connects using the pinned first result.
        return goodLookupCalls === 1
          ? [{ address: "127.0.0.1", family: 4 }]
          : [{ address: "169.254.169.254", family: 4 }];
      default:
        return [];
    }
  };

  const strict = await pairingNode(t, "Strict", {
    nodeId: "node-strict",
    allowLoopback: false,
    dnsLookup: fakeDns,
  });
  for (const host of [
    "loop.attacker.example",
    "meta.attacker.example",
    "mixed.attacker.example",
    "v4mapped.attacker.example",
  ]) {
    const res = await strict.introduce({ origin: `http://${host}:${port}`, token });
    assert.equal(res.status, 400, `${host} should be rejected with 400`);
    assert.match(((await res.json()) as { error: string }).error, /not allowed/u);
  }
  assert.equal(requestCount, 0, "no outbound HTTP request should be sent for blocked DNS targets");

  const loopbackAllowed = await pairingNode(t, "LoopbackAllowed", {
    nodeId: "node-loopback",
    allowLoopback: true,
    dnsLookup: fakeDns,
  });
  // Metadata / mixed metadata addresses stay blocked even when allowLoopback is true.
  for (const host of ["meta.attacker.example", "mixed.attacker.example"]) {
    const res = await loopbackAllowed.introduce({ origin: `http://${host}:${port}`, token });
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /not allowed/u);
  }
  assert.equal(requestCount, 0);

  // Redirect responses must be rejected without following Location.
  redirectMode = true;
  goodLookupCalls = 0;
  const redirected = await loopbackAllowed.introduce({
    origin: `http://good.peer.example:${port}`,
    token,
  });
  assert.equal(redirected.status, 422);
  assert.equal(requestCount, 1);
  assert.equal(goodLookupCalls, 1);

  // Valid probe pins the verified IP, performs DNS lookup only once, and preserves original Host.
  redirectMode = false;
  goodLookupCalls = 0;
  const added = await loopbackAllowed.introduce({
    origin: `http://good.peer.example:${port}`,
    token,
  });
  assert.equal(added.status, 200);
  assert.equal(goodLookupCalls, 1);
  assert.equal(receivedHosts.at(-1), `good.peer.example:${port}`);
});

it("does not send a peer's credentials in syncPeerMesh after the peer is removed mid-flight and caps linkedPeerIds", async (t) => {
  const selfShareGate = Promise.withResolvers<undefined>();
  const selfShareStarted = Promise.withResolvers<undefined>();
  const cIntroducedBodies: string[] = [];

  const a = await pairingNode(t, "A", {
    nodeId: "node-a",
    resolveSelfShare: async (origin, token, preferredOrigin) => {
      selfShareStarted.resolve(undefined);
      await selfShareGate.promise;
      const share = resolvePeerSelfOrigin([], preferredOrigin, origin);
      return "error" in share ? share : { ...share, token, name: "A" };
    },
  });
  const b = await pairingNode(t, "B", { nodeId: "node-b" });
  const c = await pairingNode(t, "C", {
    nodeId: "node-c",
    onIntroduceBody: (body) => cIntroducedBodies.push(body),
  });

  const ab = await a.add(b.connection);
  const ac = await a.add(c.connection);
  const clientB = a.manager.client(ab.peer.hostId);
  assert.ok(clientB);

  const syncPromise = a.rpc.dispatch(
    methods.syncMesh,
    { args: { includeSelf: true, includeMesh: true } },
    pairingAuth,
  );
  await selfShareStarted.promise;

  // Remove Peer B while syncPeerMesh is waiting on self-share resolution.
  const removed = await a.rpc.dispatch(
    methods.remove,
    { args: { peerId: ab.peer.peerId } },
    pairingAuth,
  );
  assert.ok(removed.ok);
  assert.equal(clientB.closed, true);
  assert.equal(clientB.record.token, "");

  selfShareGate.resolve(undefined);
  const synced = await syncPromise;
  assert.ok(synced.ok);
  const report = remotePeerPairingReportSchema.parse(synced.value);

  // Peer C must never have received B's token or origin.
  assert.equal(
    cIntroducedBodies.some(
      (body) => body.includes(b.connection.token) || body.includes(b.connection.origin),
    ),
    false,
  );
  const bToC = report.results.find(
    (step) => step.targetPeerId === ac.peer.peerId && step.introducedHost === ab.peer.peerId,
  );
  assert.equal(bToC?.status, "skipped");
  assert.equal(
    c.store.load().some((p) => p.origin === b.connection.origin),
    false,
  );

  // Verify linkedPeerIds is capped at 128 entries to stay within remotePeerSummarySchema.
  const capRoot = mkdtempSync(join(tmpdir(), "peer-linked-cap-"));
  t.after(() => rmSync(capRoot, { recursive: true, force: true }));
  const capStore = new PeerHostStore(new DataDir(capRoot));
  const now = new Date().toISOString();
  capStore.save([
    {
      peerId: "target-peer",
      nodeId: "node-target",
      name: "Target",
      origin: "https://target.example",
      token: "t-target",
      enabled: false,
      createdAt: now,
      updatedAt: now,
    },
    ...Array.from({ length: 140 }, (_, idx) => ({
      peerId: `peer-${idx}`,
      nodeId: "node-shared",
      name: `Peer ${idx}`,
      origin: `https://peer-${idx}.example`,
      token: `t-${idx}`,
      enabled: false,
      createdAt: now,
      updatedAt: now,
    })),
  ]);
  const capManager = new PeerHostManager(capStore, async () => [], new EventHub(capRoot));
  t.after(() => capManager.close());
  const targetClient = capManager.client("remote-peer:target-peer");
  assert.ok(targetClient);
  targetClient.manifest = {
    version: "1",
    platform: process.platform,
    hostname: "target",
    epoch: "ep-1",
    nodeId: "node-target",
    peerNodes: { "remote-peer:other": "node-shared" },
    projects: [],
  };
  const capRpc = new RpcRegistry();
  capManager.register(capRpc);
  const listed = await capRpc.dispatch(methods.list, { args: {} }, pairingAuth);
  assert.ok(listed.ok);
  const targetSummary = remotePeerSummarySchema.parse(
    (listed.value as { peers: Array<{ peerId: string }> }).peers.find(
      (p) => p.peerId === "target-peer",
    ),
  );
  assert.equal(targetSummary.linkedPeerIds?.length, 128);
});

it("isolates partial mesh failures, redacts credentials, and gates the introduction endpoint", async (t) => {
  const a = await pairingNode(t, "A", { nodeId: "node-a" });
  const c = await pairingNode(t, "C", { nodeId: "node-c" });
  const strict = await pairingNode(t, "Strict", { allowLoopback: false });
  const b = await pairingNode(t, "B", {
    nodeId: "node-b",
    introductionFailure: () =>
      `Unexpected peer error: ${a.connection.token} ${b.connection.token} ${c.connection.token}`,
  });
  const leaky = await pairingNode(t, "Leaky", {
    nodeId: "node-leaky",
    introductionFailure: () =>
      "Upstream failure: Bearer foreign-bearer-secret https://peer.example/#token=foreign-link-secret",
  });
  const ac = await a.add(c.connection);
  const ab = await a.add({ ...b.connection, pairBack: true, meshPeerIds: [ac.peer.peerId] });
  assert.equal(ab.peer.pairedBack, false);
  const report = remotePeerPairingReportSchema.parse(ab.pairing);
  assert.deepEqual(
    report.results.map(({ status }) => status),
    ["failed", "added", "failed"],
  );
  for (const { connection } of [a, b, c])
    assert.ok(!JSON.stringify(report).includes(connection.token));
  const aLeaky = await a.add({ ...leaky.connection, pairBack: true });
  const leakyReport = remotePeerPairingReportSchema.parse(aLeaky.pairing);
  assert.equal(leakyReport.results[0]?.error, "Peer pairing failed (details redacted)");
  assert.ok(!JSON.stringify(leakyReport).includes("foreign-bearer-secret"));
  assert.ok(!JSON.stringify(leakyReport).includes("foreign-link-secret"));
  assert.ok(a.store.load().some(({ peerId }) => peerId === ab.peer.peerId));
  assert.ok(c.store.load().some(({ origin }) => origin === b.connection.origin));
  const forged = await a.rpc.dispatch(
    methods.syncMesh,
    {
      args: {
        peerIds: [ac.peer.peerId],
        includeMesh: false,
        selfOrigin: "https://unadvertised.invalid",
      },
    },
    pairingAuth,
  );
  assert.ok(forged.ok);
  assert.match(
    remotePeerPairingReportSchema.parse(forged.value).results[0]?.error ?? "",
    /not a shareable address/u,
  );
  assert.equal(c.store.load().length, 1);

  for (const origin of [b.connection.origin, "http://169.254.169.254/", "http://0.0.0.0/"]) {
    const forbidden = await strict.introduce({ origin, token: b.connection.token });
    assert.equal(forbidden.status, 400);
    assert.match(((await forbidden.json()) as { error: string }).error, /not allowed/u);
  }
  const selfAlias = await pairingNode(t, "A alias", { nodeId: "node-a" });
  for (const connection of [a.connection, selfAlias.connection]) {
    const self = await a.introduce(connection);
    assert.equal(self.status, 400);
    assert.deepEqual(await self.json(), { error: "Cannot pair this server with itself" });
  }
  assert.equal((await a.introduce(c.connection, { authorization: "" })).status, 401);
  assert.equal(
    (await a.introduce(c.connection, { origin: "https://untrusted.invalid" })).status,
    403,
  );
  const oversized = await fetch(`${a.connection.origin}/api/peer/v1/peers`, {
    method: "POST",
    headers: { authorization: `Bearer ${a.connection.token}` },
    body: "a".repeat(33 * 1024),
  });
  assert.equal(oversized.status, 413);
  assert.equal(strict.store.load().length, 0);

  const previous = process.env.CODEXHOST_DISABLE_PEER_PAIRING;
  t.after(() => {
    if (previous === undefined) delete process.env.CODEXHOST_DISABLE_PEER_PAIRING;
    else process.env.CODEXHOST_DISABLE_PEER_PAIRING = previous;
  });
  process.env.CODEXHOST_DISABLE_PEER_PAIRING = "1";
  const response = await a.introduce(c.connection);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "Peer pairing is disabled on this Host" });
  await a.manager.client(ac.peer.hostId)?.probe();
  assert.equal(a.manager.client(ac.peer.hostId)?.summary().supportsPeerPairing, false);
  const skipped = await a.rpc.dispatch(
    methods.syncMesh,
    { args: { peerIds: [ac.peer.peerId] } },
    pairingAuth,
  );
  assert.ok(skipped.ok);
  assert.equal(remotePeerPairingReportSchema.parse(skipped.value).results[0]?.status, "skipped");
});

it("uses shareable local origins in priority order and restricts loopback to a configured fallback", () => {
  const urls = [
    { kind: "lan", url: "http://192.168.1.2:4400/" },
    { kind: "tailscale-https", url: "https://server.ts.net/" },
    { kind: "tailscale-funnel", url: "https://funnel.ts.net/" },
    { kind: "relay", url: "https://server.r.chost.dev/" },
    { kind: "public", url: "https://my-host.example/" },
  ] as const;
  const fallback = "http://127.0.0.1:4400";
  assert.deepEqual(resolvePeerSelfOrigin(urls, undefined, fallback), {
    origin: "https://my-host.example",
  });
  assert.deepEqual(resolvePeerSelfOrigin(urls.slice(0, -1), undefined), {
    origin: "https://server.r.chost.dev",
  });
  assert.deepEqual(resolvePeerSelfOrigin(urls, "https://SERVER.ts.net:443/some/path"), {
    origin: "https://server.ts.net",
  });
  assert.ok("error" in resolvePeerSelfOrigin(urls, fallback, fallback));
  assert.ok("error" in resolvePeerSelfOrigin([], undefined));
  assert.deepEqual(resolvePeerSelfOrigin([], fallback, fallback), { origin: fallback });
});

it("lists reachable remote delegation hosts per session perspective and resolves target host Harnesses", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "peer-delegation-discovery-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const localNodeId = "node-hub-a";
  const token = "delegation-discovery-token";

  const makePeerServer = async (opts: {
    nodeId: string;
    hostname: string;
    delegation: boolean;
    peerNodes?: Record<string, string>;
    harnesses?: Array<{ id: string; name: string }>;
  }) => {
    const server = createServer(async (req, res) => {
      if (req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(401).end();
        return;
      }
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/api/peer/v1/manifest") {
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            version: "0.27.0",
            platform: "darwin",
            hostname: opts.hostname,
            epoch: `epoch-${opts.nodeId}`,
            nodeId: opts.nodeId,
            ...(opts.peerNodes ? { peerNodes: opts.peerNodes } : {}),
            projects: [],
            capabilities: opts.delegation ? { delegation: 1 } : {},
          }),
        );
        return;
      }
      if (url.pathname === "/api/ch/v1/events") {
        res.writeHead(200);
        res.write(
          `${JSON.stringify({ type: "hello", version: 1, cursor: { epoch: `epoch-${opts.nodeId}`, sequence: 1 }, reset: true })}\n`,
        );
        return;
      }
      if (url.pathname === "/api/ch/v1/rpc") {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as {
          method?: string;
          params?: { harnessId?: string };
        };
        if (body.method === "codexhost/harness/plugins/list") {
          res.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify({
              result: {
                plugins: (opts.harnesses ?? [])
                  .filter((h) => h.id !== "codex")
                  .map((h) => ({ id: h.id, name: h.name, version: "1.0.0" })),
              },
            }),
          );
          return;
        }
        if (body.method === "codexhost/harness/inspect") {
          const harnessId = body.params?.harnessId ?? "";
          const found = (opts.harnesses ?? []).find((h) => h.id === harnessId);
          res.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify({
              result: found
                ? {
                    status: "ready",
                    catalog: {
                      models: [
                        {
                          ref: { id: `${found.id}-model` },
                          label: `${found.name} Model`,
                          supportedThinkingOptionIds: ["medium"],
                        },
                      ],
                      defaultModel: { id: `${found.id}-model` },
                      thinkingOptions: [{ id: "medium", label: "Medium" }],
                      defaultThinkingOptionId: "medium",
                    },
                    capabilities: {
                      configuration: {
                        selectModel: true,
                        selectThinkingOption: true,
                        selectPermissionMode: false,
                        permissionModeScope: "live",
                      },
                      history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
                    },
                  }
                : {
                    status: "notInstalled",
                    error: { code: "unavailable", message: "Not installed", retryable: false },
                  },
            }),
          );
          return;
        }
      }
      res.writeHead(404).end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const addr = server.address() as { port: number };
    t.after(() => server.close());
    return `http://127.0.0.1:${addr.port}`;
  };

  // Peer B paired with Hub A (node-hub-a) and Peer C (node-peer-c), but NOT Peer D (node-peer-d).
  const originB = await makePeerServer({
    nodeId: "node-peer-b",
    hostname: "mac-studio",
    delegation: true,
    peerNodes: {
      "remote-peer:a-on-b": localNodeId,
      "remote-peer:c-on-b": "node-peer-c",
    },
    harnesses: [
      { id: "claude-code", name: "Claude Code" },
      { id: "antigravity", name: "Antigravity" },
    ],
  });
  const originC = await makePeerServer({
    nodeId: "node-peer-c",
    hostname: "home-mini",
    delegation: true,
    harnesses: [{ id: "pi", name: "Pi" }],
  });
  const originD = await makePeerServer({
    nodeId: "node-peer-d",
    hostname: "unpaired-box",
    delegation: true,
  });
  const originLegacy = await makePeerServer({
    nodeId: "node-legacy",
    hostname: "legacy-box",
    delegation: false,
  });

  const data = new DataDir(root);
  const events = new EventHub(root);
  const manager = new PeerHostManager(new PeerHostStore(data), async () => [], events, {
    allowLoopback: true,
    localNodeId,
  });
  t.after(() => manager.close());

  const rpc = new RpcRegistry();
  manager.register(rpc, {
    localHostname: "work-mbp",
    localDelegationAvailable: () => true,
    localHarnesses: async () => [{ id: "codex", name: "Codex" }],
  });
  const localAuth = { local: true, credential: "local", release() {} };

  const addPeer = async (origin: string, name: string, color: string) => {
    const added = await rpc.dispatch(
      methods.add,
      { args: { connectionUrl: `${origin}/#token=${token}`, name, color } },
      localAuth,
    );
    assert.equal(added.ok, true);
    const hostId = (added.value as { peer: { hostId: string } }).peer.hostId;
    await manager.waitForInitialConnection(hostId);
    return hostId;
  };

  const hostB = await addPeer(originB, "Mac Studio", "blue");
  const hostC = await addPeer(originC, "Home Mini", "green");
  const hostD = await addPeer(originD, "Unpaired Box", "amber");
  await addPeer(originLegacy, "Legacy Box", "slate");

  // 1. From Hub A's local session: lists only connected delegation-capable peers (B, C, D; not Legacy).
  const fromLocal = await rpc.dispatch(
    DELEGATION_REMOTE_HOSTS_METHOD,
    { args: { request: { sessionHostId: "local" } } },
    localAuth,
  );
  assert.equal(fromLocal.ok, true);
  assert.deepEqual(
    (fromLocal.value as { hosts: Array<{ hostId: string }> }).hosts.map((h) => h.hostId).sort(),
    [hostB, hostC, hostD].sort(),
  );

  // 2. From Peer B's session: lists Hub A (isLocal) and Peer C (in B's peerNodes), excluding B itself and unpaired D.
  const fromPeerB = await rpc.dispatch(
    DELEGATION_REMOTE_HOSTS_METHOD,
    { args: { request: { sessionHostId: hostB } } },
    localAuth,
  );
  assert.equal(fromPeerB.ok, true);
  assert.deepEqual(
    (fromPeerB.value as { hosts: Array<{ hostId: string; isLocal?: boolean }> }).hosts,
    [
      { hostId: "local", name: "work-mbp", isLocal: true, hostname: "work-mbp" },
      { hostId: hostC, name: "Home Mini", color: "green", hostname: "home-mini" },
    ],
  );

  // 3. SSH remote session returns empty list.
  const fromSsh = await rpc.dispatch(
    DELEGATION_REMOTE_HOSTS_METHOD,
    { args: { request: { sessionHostId: "remote-ssh:box" } } },
    localAuth,
  );
  assert.equal(fromSsh.ok, true);
  assert.deepEqual((fromSsh.value as { hosts: unknown[] }).hosts, []);

  // 4. Target host Harnesses: local returns localHarnesses, Peer B returns Peer B's ready Harnesses.
  const localHarnesses = await rpc.dispatch(
    DELEGATION_HOST_HARNESSES_METHOD,
    { args: { request: { hostId: "local" } } },
    localAuth,
  );
  assert.equal(localHarnesses.ok, true);
  assert.deepEqual(localHarnesses.value, { harnesses: [{ id: "codex", name: "Codex" }] });

  const peerBHarnesses = await rpc.dispatch(
    DELEGATION_HOST_HARNESSES_METHOD,
    { args: { request: { hostId: hostB } } },
    localAuth,
  );
  assert.equal(peerBHarnesses.ok, true);
  assert.deepEqual(peerBHarnesses.value, {
    harnesses: [
      { id: "claude-code", name: "Claude Code" },
      { id: "antigravity", name: "Antigravity" },
    ],
  });
});
