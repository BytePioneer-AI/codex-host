import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { it } from "node:test";
import {
  REMOTE_PEERS_METHODS,
  harnessModelRefIdSchema,
  type PeerDelegationHostsResult,
} from "@codexhost/shared-contracts";
import {
  ClientChannelEvents,
  DelegationControlRegistry,
  createRemotePeerDelegationClient,
  runDelegationCli,
  startClientChannelServer,
  startDelegationControlServer,
  type DelegationStartInput,
  type DelegationThreadSnapshot,
} from "@codexhost/host-runtime";
import { createChHostClient } from "../src/ch-host-client.ts";
import { startPeerDelegationBridge } from "../src/peer-delegation-bridge.ts";
import { servePeerDelegation } from "../src/peer-delegation-http.ts";
import { PeerHostManager } from "../src/peer-host-manager.ts";
import { PeerHostStore } from "../src/peer-host-store.ts";
import { peerEndpoint } from "../src/peer-manifest.ts";
import { DataDir } from "../src/store.ts";
import { EventHub, RpcRegistry, StreamRegistry } from "../src/transport.ts";
import { Workspaces } from "../src/workspaces.ts";

function initGitRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "hello\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
}

async function runCliJson(
  args: string[],
  environment: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const out = new PassThrough();
  const err = new PassThrough();
  let stdout = "";
  let stderr = "";
  out.on("data", (chunk) => {
    stdout += String(chunk);
  });
  err.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const code = await runDelegationCli({
    arguments: args,
    environment,
    output: out,
    diagnosticOutput: err,
  });
  return { code, stdout, stderr };
}

it("enforces capability gate, hop limit, bridge auth/mode/Origin/413, error sanitization, and never retries write operations", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "peer-delegation-gate-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const token = "peer-secret-token-xyz";
  const epoch = randomUUID();
  let advertiseDelegation = false;
  let delegationRequests = 0;

  const peerServer = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
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
          hostname: "node-b",
          homeDir: root,
          projects: [{ id: "p1", name: "proj", path: join(root, "proj"), threadIds: [] }],
          ...(advertiseDelegation ? { capabilities: { delegation: 1 } } : {}),
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
    if (url.pathname === "/api/peer/v1/delegation") {
      delegationRequests += 1;
      void servePeerDelegation(req, res, {
        enabled: advertiseDelegation,
        credential: token,
        chHost: {
          realtime: {
            subscribe: () => () => {},
            snapshot: async () => {
              throw new Error("unused");
            },
            respond: async () => ({ resolved: true }),
            peerDelegationSupported: () => true,
            request: async () => {
              throw new Error(
                `simulated B failure at /Users/secret/private with ${origin}/#token=${token}`,
              );
            },
          },
        },
      });
      return;
    }
    res.writeHead(404).end();
  });
  peerServer.listen(0, "127.0.0.1");
  await once(peerServer, "listening");
  const origin = `http://127.0.0.1:${(peerServer.address() as AddressInfo).port}`;

  const dataA = join(root, "a-data");
  const manager = new PeerHostManager(
    new PeerHostStore(new DataDir(dataA)),
    async () => [],
    new EventHub(dataA),
    { allowLoopback: true },
  );
  const rpc = new RpcRegistry();
  manager.register(rpc);
  const added = await rpc.dispatch(
    REMOTE_PEERS_METHODS.add,
    { args: { connectionUrl: `${origin}/#token=${token}`, name: "Node B" } },
    { local: true, credential: "local", release() {} },
  );
  assert.equal(added.ok, true);
  const hostId = (added.value as { peer: { hostId: string } }).peer.hostId;

  const bridge = await startPeerDelegationBridge({ peerManager: manager, dataDirectory: dataA });
  t.after(async () => {
    await bridge.close();
    manager.close();
    peerServer.closeAllConnections();
    peerServer.close();
  });

  if (process.platform !== "win32") {
    assert.equal(statSync(bridge.descriptorPath).mode & 0o777, 0o600);
  }

  // Bridge rejects missing auth, wrong auth, non-empty Origin, AND empty Origin: "" (P2-1).
  assert.equal(
    (
      await fetch(`${bridge.descriptor.endpoint}/v1/peer/delegation`, {
        method: "POST",
        body: JSON.stringify({ operation: "hosts" }),
      })
    ).status,
    401,
  );
  for (const originHeader of ["http://evil.invalid", ""]) {
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        `${bridge.descriptor.endpoint}/v1/peer/delegation`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${bridge.descriptor.token}`,
            origin: originHeader,
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify({ operation: "hosts" }));
    });
    assert.equal(status, 401);
  }

  // Streaming >2 MiB payload to bridge returns clean 413 without resetting before response (P2-1).
  const oversized = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = httpRequest(
      `${bridge.descriptor.endpoint}/v1/peer/delegation`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${bridge.descriptor.token}`,
          "content-type": "application/json",
        },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    const chunk = Buffer.alloc(64 * 1024, "a");
    for (let i = 0; i < 36; i += 1) {
      req.write(chunk);
    }
    req.end();
  });
  assert.equal(oversized.status, 413);
  assert.equal(JSON.parse(oversized.body).error.code, "INVALID_ARGUMENT");

  // `hosts` never leaks peer token or origin URL, and reports delegation: false when capability is absent.
  const hostsRes = await fetch(`${bridge.descriptor.endpoint}/v1/peer/delegation`, {
    method: "POST",
    headers: { authorization: `Bearer ${bridge.descriptor.token}` },
    body: JSON.stringify({ operation: "hosts" }),
  });
  const hostsText = await hostsRes.text();
  assert.equal(hostsRes.status, 200);
  assert.equal(hostsText.includes(token), false);
  assert.equal(hostsText.includes(origin), false);
  const hostsPayload = JSON.parse(hostsText) as { ok: true; value: PeerDelegationHostsResult };
  assert.equal(hostsPayload.value.hosts[0]?.delegation, false);

  // Without capabilities.delegation=1, bridge rejects with UNSUPPORTED before contacting B.
  const unsupportedRes = await fetch(`${bridge.descriptor.endpoint}/v1/peer/delegation`, {
    method: "POST",
    headers: { authorization: `Bearer ${bridge.descriptor.token}` },
    body: JSON.stringify({
      operation: "listHarnesses",
      hostId,
      hopCount: 1,
      input: {},
    }),
  });
  assert.deepEqual(await unsupportedRes.json(), {
    ok: false,
    error: {
      code: "UNSUPPORTED",
      message: "Remote peer does not support cross-host delegation",
    },
  });
  assert.equal(delegationRequests, 0);

  // Direct B-side hopCount > 1 and nested remote hostId are rejected with 403 FORBIDDEN.
  advertiseDelegation = true;
  const hopRes = await fetch(`${origin}/api/peer/v1/delegation`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ operation: "listHarnesses", hopCount: 2, input: {} }),
  });
  assert.equal(hopRes.status, 403);
  assert.deepEqual(await hopRes.json(), {
    ok: false,
    error: { code: "FORBIDDEN", message: "Peer delegation hop limit exceeded (maximum 1 hop)" },
  });

  const nestedRes = await fetch(`${origin}/api/peer/v1/delegation`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      operation: "read",
      hopCount: 1,
      input: { hostId: "remote-peer:c", threadId: "t1", view: "result" },
    }),
  });
  assert.equal(nestedRes.status, 403);

  // Re-probe so A observes capabilities.delegation=1, then confirm a failing write sends exactly 1 request
  // and NEVER leaks host paths, peer origin URLs, or tokens (P1-1).
  await manager.client(hostId)?.probe();
  delegationRequests = 0;
  const writeRes = await fetch(`${bridge.descriptor.endpoint}/v1/peer/delegation`, {
    method: "POST",
    headers: { authorization: `Bearer ${bridge.descriptor.token}` },
    body: JSON.stringify({
      operation: "send",
      hostId,
      hopCount: 1,
      input: { threadId: "t1", message: "once only" },
    }),
  });
  const writeText = await writeRes.text();
  assert.equal(writeText.includes("/Users/secret"), false);
  assert.equal(writeText.includes(token), false);
  assert.equal(writeText.includes(origin), false);
  const writeBody = JSON.parse(writeText) as { ok: boolean; error?: { code: string } };
  assert.equal(writeBody.ok, false);
  assert.equal(delegationRequests, 1);

  // Closing removes the private descriptor file.
  await bridge.close();
  assert.equal(existsSync(bridge.descriptorPath), false);
});

it("confirms Host Runtime peerDelegation capability before advertising or serving peer delegation (P2-2)", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "peer-delegation-cap-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const clientDir = join(root, "client-hosts");
  const events = new ClientChannelEvents();

  // Start an older/non-delegation ClientChannelServer WITHOUT the `peerDelegation` option.
  const oldChannel = await startClientChannelServer({
    directory: clientDir,
    environment: { ...process.env, CODEXHOST_DATA_DIR: root },
    target: {
      clientEvents: events,
      handleClientRequest: async () => ({ error: { code: -32601, message: "Unsupported" } }),
      clientSnapshot: async () => {
        throw new Error("unused");
      },
      respondClient: async () => ({ resolved: true }),
    },
  });
  const chHost = await createChHostClient({ directory: clientDir });
  t.after(async () => {
    chHost.close();
    await oldChannel.close();
  });

  assert.equal(chHost.realtime?.peerDelegationSupported?.(), false);
  const ws = new Workspaces(new DataDir(join(root, "web")), root, true);
  const rpc = new RpcRegistry();
  const manifest = await peerEndpoint(
    "GET",
    new URL("http://127.0.0.1/api/peer/v1/manifest"),
    {},
    ws,
    rpc,
    events.epoch,
    "0.26.1",
    [],
    { delegation: chHost.realtime?.peerDelegationSupported?.() === true },
  );
  assert.equal((manifest as { capabilities?: { delegation?: number } }).capabilities, undefined);

  // `/api/peer/v1/delegation` refuses with 503 when runtime capability is absent.
  const server = createServer((req, res) => {
    void servePeerDelegation(req, res, { enabled: true, chHost });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const port = (server.address() as AddressInfo).port;
  const reply = await fetch(`http://127.0.0.1:${port}/api/peer/v1/delegation`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ operation: "listHarnesses", hopCount: 1, input: {} }),
  });
  assert.equal(reply.status, 503);
  assert.deepEqual(await reply.json(), {
    ok: false,
    error: {
      code: "UNSUPPORTED",
      message: "Peer delegation is unavailable on this Host",
    },
  });
});

it("isolates multiple Web instances sharing one Host data directory without descriptor overwrite or cleanup race (P1-5)", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "peer-multi-bridge-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sharedHostData = join(root, "shared-host-data");

  async function startStubPeer(name: string) {
    const token = `tok-${name}`;
    const epoch = randomUUID();
    const server = createServer((req, res) => {
      if (req.headers.authorization !== `Bearer ${token}`) {
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
            hostname: name,
            homeDir: root,
            projects: [],
            capabilities: { delegation: 1 },
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
      if (url.pathname === "/api/peer/v1/delegation") {
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ ok: true, value: { harnesses: [name] } }));
        return;
      }
      res.writeHead(404).end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { server, origin, token };
  }

  const peer1 = await startStubPeer("peer-one");
  const peer2 = await startStubPeer("peer-two");

  const webData1 = join(root, "web-1");
  const webData2 = join(root, "web-2");
  const manager1 = new PeerHostManager(
    new PeerHostStore(new DataDir(webData1)),
    async () => [],
    new EventHub(webData1),
    { allowLoopback: true },
  );
  const manager2 = new PeerHostManager(
    new PeerHostStore(new DataDir(webData2)),
    async () => [],
    new EventHub(webData2),
    { allowLoopback: true },
  );
  const rpc1 = new RpcRegistry();
  const rpc2 = new RpcRegistry();
  manager1.register(rpc1);
  manager2.register(rpc2);
  const added1 = await rpc1.dispatch(
    REMOTE_PEERS_METHODS.add,
    { args: { connectionUrl: `${peer1.origin}/#token=${peer1.token}`, name: "Peer 1" } },
    { local: true, credential: "local", release() {} },
  );
  const added2 = await rpc2.dispatch(
    REMOTE_PEERS_METHODS.add,
    { args: { connectionUrl: `${peer2.origin}/#token=${peer2.token}`, name: "Peer 2" } },
    { local: true, credential: "local", release() {} },
  );
  assert.equal(added1.ok, true);
  assert.equal(added2.ok, true);
  const hostId1 = (added1.value as { peer: { hostId: string } }).peer.hostId;
  const hostId2 = (added2.value as { peer: { hostId: string } }).peer.hostId;

  const bridge1 = await startPeerDelegationBridge({
    peerManager: manager1,
    dataDirectory: sharedHostData,
  });
  const bridge2 = await startPeerDelegationBridge({
    peerManager: manager2,
    dataDirectory: sharedHostData,
  });
  t.after(async () => {
    await bridge1.close();
    await bridge2.close();
    manager1.close();
    manager2.close();
    peer1.server.closeAllConnections();
    peer1.server.close();
    peer2.server.closeAllConnections();
    peer2.server.close();
  });

  // Both bridges write distinct files in peer-delegation-bridges/.
  assert.notEqual(bridge1.descriptorPath, bridge2.descriptorPath);
  assert.equal(existsSync(bridge1.descriptorPath), true);
  assert.equal(existsSync(bridge2.descriptorPath), true);

  const client = createRemotePeerDelegationClient({
    ...process.env,
    CODEXHOST_DATA_DIR: sharedHostData,
  });
  const listed = await client.listHosts();
  assert.deepEqual(listed.hosts.map((h) => h.hostId).sort(), [hostId1, hostId2].sort());

  // Routing hits each peer's owning bridge.
  assert.deepEqual(
    await client.call({ hostId: hostId1, operation: "listHarnesses", hopCount: 1, input: {} }),
    { harnesses: ["peer-one"] },
  );
  assert.deepEqual(
    await client.call({ hostId: hostId2, operation: "listHarnesses", hopCount: 1, input: {} }),
    { harnesses: ["peer-two"] },
  );

  // Closing bridge 1 removes only its descriptor; bridge 2 remains intact and reachable.
  await bridge1.close();
  assert.equal(existsSync(bridge1.descriptorPath), false);
  assert.equal(existsSync(bridge2.descriptorPath), true);
  assert.deepEqual(
    await client.call({ hostId: hostId2, operation: "listHarnesses", hopCount: 1, input: {} }),
    { harnesses: ["peer-two"] },
  );
});

it("independently re-sanitizes remote HTTP 200 { ok: false, error } envelopes and validates retained field semantics at the A bridge boundary", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "peer-bridge-resanitize-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const token = "a1b2c3d4e5".repeat(4); // 40-char lowercase hex SHA-formatted token (P1-3)
  const branchToken = "feat-secret-peer-tok";
  const epoch = randomUUID();
  const validSha = "deadbeef".repeat(5);
  let mode: "valid-retained" | "poisoned-retained" | "token-disguised" | "token-in-code" =
    "valid-retained";

  const peerServer = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
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
          hostname: "malicious-b",
          homeDir: root,
          projects: [],
          capabilities: { delegation: 1 },
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
    if (url.pathname === "/api/peer/v1/delegation") {
      if (mode === "valid-retained") {
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            ok: false,
            error: {
              code: "DELEGATION_FAILED",
              message: `git stderr at /Users/victim/repo http://10.0.0.7:9999/#token=${token}`,
              details: {
                leakedUrl: "http://10.0.0.7:9999/#token=super-secret",
                hostPath: "/Users/victim/.ssh/id_rsa",
                validHarnessIds: [
                  "codex",
                  "pi",
                  "/Users/victim/secret-harness",
                  `http://10.0.0.7/#token=${token}`,
                ],
                worktreeRetained: true,
                worktree: {
                  path: "/Users/victim/repo.worktrees/feat-x",
                  branch: "feat-x",
                  base: validSha,
                },
              },
            },
          }),
        );
      } else if (mode === "poisoned-retained") {
        // Poison retained fields themselves with host paths, URLs, and tokens.
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            ok: false,
            error: {
              code: "DELEGATION_FAILED",
              message: "poisoned",
              details: {
                validHarnessIds: ["/Users/victim/secret", "http://10.0.0.7/#token=tok"],
                worktreeRetained: true,
                worktree: {
                  path: "/Users/victim/repo.worktrees/evil",
                  branch: "http://10.0.0.7/#token=tok",
                  base: `/Users/victim/secret-${token}`,
                },
              },
            },
          }),
        );
      } else if (mode === "token-disguised") {
        // Inject syntactically valid SHA-formatted and branch-formatted paired Peer tokens into all 3 retained fields (P1-3).
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            ok: false,
            error: {
              code: "DELEGATION_FAILED",
              message: "disguised token leak",
              details: {
                validHarnessIds: ["codex", token, branchToken, `wrap-${branchToken}`],
                worktreeRetained: true,
                worktree: {
                  path: "/Users/victim/repo.worktrees/disguised",
                  branch: branchToken,
                  base: token,
                },
              },
            },
          }),
        );
      } else {
        // Stuff a synthetic token directly into `error.code` (P1-2).
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            ok: false,
            error: {
              code: `LEAK_${token}`,
              message: `raw ${token}`,
            },
          }),
        );
      }
      return;
    }
    res.writeHead(404).end();
  });
  peerServer.listen(0, "127.0.0.1");
  await once(peerServer, "listening");
  const origin = `http://127.0.0.1:${(peerServer.address() as AddressInfo).port}`;

  const dataA = join(root, "a-data");
  const manager = new PeerHostManager(
    new PeerHostStore(new DataDir(dataA)),
    async () => [],
    new EventHub(dataA),
    { allowLoopback: true },
  );
  const rpc = new RpcRegistry();
  manager.register(rpc);
  const added = await rpc.dispatch(
    REMOTE_PEERS_METHODS.add,
    { args: { connectionUrl: `${origin}/#token=${token}`, name: "Node B" } },
    { local: true, credential: "local", release() {} },
  );
  assert.equal(added.ok, true);
  // Pair a second stub peer whose token has valid git branch / harness-id syntax to verify cross-peer token scrubbing.
  const peerServer2 = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${branchToken}`) {
      res.writeHead(401).end();
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/api/peer/v1/manifest") {
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          version: "0.26.1",
          epoch: randomUUID(),
          platform: process.platform,
          hostname: "peer-2",
          homeDir: root,
          projects: [],
          capabilities: { delegation: 1 },
        }),
      );
      return;
    }
    if (url.pathname === "/api/ch/v1/events") {
      res.writeHead(200);
      res.write(
        `${JSON.stringify({ type: "hello", version: 1, cursor: { epoch: randomUUID(), sequence: 1 }, reset: true })}\n`,
      );
      return;
    }
    res.writeHead(404).end();
  });
  peerServer2.listen(0, "127.0.0.1");
  await once(peerServer2, "listening");
  const origin2 = `http://127.0.0.1:${(peerServer2.address() as AddressInfo).port}`;
  const added2 = await rpc.dispatch(
    REMOTE_PEERS_METHODS.add,
    { args: { connectionUrl: `${origin2}/#token=${branchToken}`, name: "Node C" } },
    { local: true, credential: "local", release() {} },
  );
  assert.equal(added2.ok, true);
  const hostId = (added.value as { peer: { hostId: string } }).peer.hostId;
  const bridge = await startPeerDelegationBridge({ peerManager: manager, dataDirectory: dataA });
  t.after(async () => {
    await bridge.close();
    manager.close();
    peerServer.closeAllConnections();
    peerServer.close();
    peerServer2.closeAllConnections();
    peerServer2.close();
  });

  const reply = await fetch(`${bridge.descriptor.endpoint}/v1/peer/delegation`, {
    method: "POST",
    headers: { authorization: `Bearer ${bridge.descriptor.token}` },
    body: JSON.stringify({
      operation: "start",
      hostId,
      hopCount: 1,
      input: { harnessId: "codex", task: "run", cwd: "/tmp" },
    }),
  });
  const text = await reply.text();
  assert.equal(reply.status, 200);
  assert.equal(text.includes("/Users/victim"), false);
  assert.equal(text.includes("10.0.0.7"), false);
  assert.equal(text.includes(token), false);
  assert.equal(text.includes("super-secret"), false);
  assert.deepEqual(JSON.parse(text), {
    ok: false,
    error: {
      code: "DELEGATION_FAILED",
      message: "Peer delegation operation failed",
      details: {
        validHarnessIds: ["codex", "pi"],
        worktreeRetained: true,
        worktree: { branch: "feat-x", base: validSha },
      },
    },
  });

  // Poisoned validHarnessIds, worktree.branch, and worktree.base are all stripped completely.
  mode = "poisoned-retained";
  const poisonedReply = await fetch(`${bridge.descriptor.endpoint}/v1/peer/delegation`, {
    method: "POST",
    headers: { authorization: `Bearer ${bridge.descriptor.token}` },
    body: JSON.stringify({
      operation: "start",
      hostId,
      hopCount: 1,
      input: { harnessId: "codex", task: "run", cwd: "/tmp" },
    }),
  });
  const poisonedText = await poisonedReply.text();
  assert.equal(poisonedReply.status, 200);
  assert.equal(poisonedText.includes("/Users/victim"), false);
  assert.equal(poisonedText.includes("10.0.0.7"), false);
  assert.equal(poisonedText.includes(token), false);
  assert.deepEqual(JSON.parse(poisonedText), {
    ok: false,
    error: {
      code: "DELEGATION_FAILED",
      message: "Peer delegation operation failed",
      details: {
        worktreeRetained: true,
      },
    },
  });

  // Syntactically valid SHA-formatted & branch-formatted paired Peer tokens are scrubbed from all 3 retained fields (P1-3).
  mode = "token-disguised";
  const disguisedReply = await fetch(`${bridge.descriptor.endpoint}/v1/peer/delegation`, {
    method: "POST",
    headers: { authorization: `Bearer ${bridge.descriptor.token}` },
    body: JSON.stringify({
      operation: "start",
      hostId,
      hopCount: 1,
      input: { harnessId: "codex", task: "run", cwd: "/tmp" },
    }),
  });
  const disguisedText = await disguisedReply.text();
  assert.equal(disguisedReply.status, 200);
  assert.equal(disguisedText.includes(token), false);
  assert.equal(disguisedText.includes(branchToken), false);
  assert.deepEqual(JSON.parse(disguisedText), {
    ok: false,
    error: {
      code: "DELEGATION_FAILED",
      message: "Peer delegation operation failed",
      details: {
        validHarnessIds: ["codex"],
        worktreeRetained: true,
      },
    },
  });

  // Token stuffed into remote `error.code` MUST NOT appear in either HTTP response OR bridge logs (P1-2).
  mode = "token-in-code";
  const logged: string[] = [];
  const origConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map((arg) => String(arg)).join(" "));
  };
  let codeLeakText = "";
  try {
    const codeLeakReply = await fetch(`${bridge.descriptor.endpoint}/v1/peer/delegation`, {
      method: "POST",
      headers: { authorization: `Bearer ${bridge.descriptor.token}` },
      body: JSON.stringify({
        operation: "start",
        hostId,
        hopCount: 1,
        input: { harnessId: "codex", task: "run", cwd: "/tmp" },
      }),
    });
    assert.equal(codeLeakReply.status, 200);
    codeLeakText = await codeLeakReply.text();
  } finally {
    console.error = origConsoleError;
  }
  assert.equal(codeLeakText.includes(token), false);
  assert.equal(logged.join("\n").includes(token), false);
  assert.deepEqual(JSON.parse(codeLeakText), {
    ok: false,
    error: {
      code: "DELEGATION_FAILED",
      message: "Peer delegation operation failed",
    },
  });
});

it("runs end-to-end dual-node loopback delegation (host list, start+worktree+idempotent replay, read, send, wait, answer, cancel, list, 1-hop guard)", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "peer-delegation-e2e-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const dataA = join(root, "node-a-data");
  const dataB = join(root, "node-b-data");
  const repoB = join(root, "node-b-repo");
  initGitRepo(repoB);
  const peerToken = "e2e-peer-secret-token";

  // --- Node B: DelegationControlRegistry + ClientChannelServer(peerDelegation) + Web peer endpoint ---
  const threadsB = new Map<
    string,
    {
      cwd: string;
      status: DelegationThreadSnapshot["status"];
      readCount: number;
      messages: string[];
      cancelled: boolean;
      parentThreadId?: string;
      answered?: { interactionId: string; result: unknown };
    }
  >();
  let nextSeq = 1;
  const registryB = new DelegationControlRegistry({
    remotePeer: {
      listHosts: async () => ({ hosts: [] }),
      call: async () => {
        throw new Error("Node B should not forward remote calls from remote-origin threads");
      },
    },
  });
  registryB.register(
    {
      listHarnesses: async () => ({ harnesses: ["codex", "pi"] }),
      inspect: async (input) => ({
        harnessId: input.harnessId,
        inspection: {
          status: "ready",
          catalog: {
            models: [
              { ref: { id: harnessModelRefIdSchema.parse("pi-model-1") }, label: "Pi Model 1" },
            ],
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
        },
      }),
      canHandleStart: () => true,
      ownsThread: (id) => threadsB.has(id),
      delegationParent: async (id) => threadsB.get(id)?.parentThreadId,
      start: async (input: DelegationStartInput) => {
        const threadId = `b-thread-${nextSeq++}`;
        threadsB.set(threadId, {
          cwd: input.cwd ?? repoB,
          status: "running",
          readCount: 0,
          messages: [input.task],
          cancelled: false,
          ...(input.parentThreadId ? { parentThreadId: input.parentThreadId } : {}),
        });
        return {
          delegationId: `del-${threadId}`,
          threadId,
          turnId: `turn-${threadId}-1`,
          harnessId: input.harnessId,
          deepLink: `codex://threads/${threadId}`,
          status: "running",
          cwd: input.cwd ?? repoB,
          ...(input.parentThreadId !== undefined ? { parentThreadId: input.parentThreadId } : {}),
          next: {
            read: `codexhost thread read ${threadId}`,
            wait: `codexhost thread wait ${threadId}`,
          },
        };
      },
      send: async (input) => {
        const record = threadsB.get(input.threadId);
        assert.ok(record, `thread ${input.threadId} must exist on B`);
        record.messages.push(
          `${input.steer ? "[steer]" : input.interrupt ? "[interrupt]" : "[send]"} ${input.message}`,
        );
        record.status = "running";
        return {
          threadId: input.threadId,
          turnId: `turn-${record.messages.length}`,
          harnessId: "pi",
          status: "running",
          next: { read: "read", wait: "wait" },
        };
      },
      cancel: async (input) => {
        const record = threadsB.get(input.threadId);
        assert.ok(record);
        record.cancelled = true;
        record.status = "interrupted";
        return {
          threadId: input.threadId,
          turnId: "turn-cancel",
          harnessId: "pi",
          cancelled: true,
        };
      },
      read: async (input) => {
        const record = threadsB.get(input.threadId);
        assert.ok(record);
        record.readCount += 1;
        if (record.status === "running" && record.readCount >= 3) {
          record.status = "completed";
        }
        return {
          threadId: input.threadId,
          harnessId: "pi",
          cwd: record.cwd,
          status: record.status,
          turn: { turnId: "turn-1", status: record.status },
          progress: [],
          result:
            record.status === "completed"
              ? { availability: "available", text: `done:${record.messages.join("|")}` }
              : { availability: "pending" },
        };
      },
      wait: async () => {
        throw new Error("A-side wait must poll B's read, never call B's wait");
      },
      answer: async (input) => {
        const record = threadsB.get(input.threadId);
        assert.ok(record);
        record.answered = { interactionId: input.interactionId, result: input.result };
        return {
          threadId: input.threadId,
          interactionId: input.interactionId,
          turnId: "turn-1",
          harnessId: "pi",
          status: "running",
          next: { read: "read", wait: "wait" },
        };
      },
      list: async () => ({
        threads: [...threadsB.entries()].map(([threadId, item]) => ({
          threadId,
          harnessId: "pi",
          deepLink: `codex://threads/${threadId}`,
          status: item.status,
          cwd: item.cwd,
        })),
        nextCursor: null,
      }),
    },
    { harnessCatalog: true },
  );

  const eventsB = new ClientChannelEvents();
  const clientDirB = join(dataB, "client-hosts");
  const channelServerB = await startClientChannelServer({
    directory: clientDirB,
    environment: { ...process.env, CODEXHOST_DATA_DIR: dataB },
    peerDelegation: (params) => registryB.handlePeerDelegationChannelRequest(params),
    target: {
      clientEvents: eventsB,
      handleClientRequest: () =>
        Promise.resolve({ error: { code: -32601, message: "Unsupported" } }),
      clientSnapshot: async () => {
        throw new Error("unused");
      },
      respondClient: async () => ({ resolved: true }),
    },
  });
  const chHostB = await createChHostClient({ directory: clientDirB });
  assert.equal(chHostB.realtime?.peerDelegationSupported?.(), true);
  const wsB = new Workspaces(new DataDir(join(dataB, "web")), repoB, true);
  wsB.create(repoB);
  const rpcB = new RpcRegistry();
  wsB.register(rpcB, new StreamRegistry());

  const webServerB = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${peerToken}`) {
      res.writeHead(401).end();
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/api/ch/v1/events") {
      res.writeHead(200);
      res.write(
        `${JSON.stringify({ type: "hello", version: 1, cursor: { epoch: eventsB.epoch, sequence: 1 }, reset: true })}\n`,
      );
      return;
    }
    if (url.pathname === "/api/peer/v1/delegation") {
      void servePeerDelegation(req, res, { enabled: true, chHost: chHostB, credential: peerToken });
      return;
    }
    if (url.pathname.startsWith("/api/peer/v1/")) {
      void peerEndpoint(req.method ?? "GET", url, {}, wsB, rpcB, eventsB.epoch, "0.26.1", [repoB], {
        delegation: chHostB.realtime?.peerDelegationSupported?.() === true,
      }).then((value) => {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(value));
      });
      return;
    }
    res.writeHead(404).end();
  });
  webServerB.listen(0, "127.0.0.1");
  await once(webServerB, "listening");
  const originB = `http://127.0.0.1:${(webServerB.address() as AddressInfo).port}`;

  // --- Node A: PeerHostManager + PeerDelegationBridge + DelegationControlRegistry + ControlServer ---
  const managerA = new PeerHostManager(
    new PeerHostStore(new DataDir(join(dataA, "web"))),
    async () => [],
    new EventHub(dataA),
    { allowLoopback: true },
  );
  const rpcA = new RpcRegistry();
  managerA.register(rpcA);
  const paired = await rpcA.dispatch(
    REMOTE_PEERS_METHODS.add,
    { args: { connectionUrl: `${originB}/#token=${peerToken}`, name: "Remote B" } },
    { local: true, credential: "local", release() {} },
  );
  assert.equal(paired.ok, true);
  const hostIdB = (paired.value as { peer: { hostId: string } }).peer.hostId;
  const bridgeA = await startPeerDelegationBridge({ peerManager: managerA, dataDirectory: dataA });
  const envA: NodeJS.ProcessEnv = { ...process.env, CODEXHOST_DATA_DIR: dataA };
  const registryA = new DelegationControlRegistry({
    remotePeer: createRemotePeerDelegationClient(envA),
    remoteWaitPollIntervalsMs: [20, 30],
  });
  const controlTokenA = "a-runtime-control-token";
  const controlServerA = await startDelegationControlServer({
    token: controlTokenA,
    api: registryA,
    watchApi: registryA,
  });
  const cliEnvA: NodeJS.ProcessEnv = {
    ...envA,
    CODEXHOST_RUNTIME_ENDPOINT: controlServerA.endpoint,
    CODEXHOST_RUNTIME_TOKEN: controlTokenA,
    CODEXHOST_THREAD_ID: "a-caller-thread",
  };

  t.after(async () => {
    registryA.close();
    registryB.close();
    await controlServerA.close();
    await bridgeA.close();
    managerA.close();
    chHostB.close();
    await channelServerB.close();
    webServerB.closeAllConnections();
    webServerB.close();
  });

  // 1. host list discovers B with projects and delegation=true, without leaking token or origin URL.
  const hostList = await runCliJson(["host", "list"], cliEnvA);
  assert.equal(hostList.code, 0, hostList.stderr);
  assert.equal(hostList.stdout.includes(peerToken), false);
  assert.equal(hostList.stdout.includes(originB), false);
  const hostsParsed = JSON.parse(hostList.stdout) as PeerDelegationHostsResult;
  assert.equal(hostsParsed.hosts.length, 1);
  assert.equal(hostsParsed.hosts[0]?.hostId, hostIdB);
  assert.equal(hostsParsed.hosts[0]?.delegation, true);
  assert.equal(hostsParsed.hosts[0]?.projects[0]?.path, repoB);

  // 2. harness list & inspect on B.
  const hList = await runCliJson(["harness", "list", "--host", hostIdB], cliEnvA);
  assert.equal(hList.code, 0, hList.stderr);
  assert.deepEqual(JSON.parse(hList.stdout), { hostId: hostIdB, harnesses: ["codex", "pi"] });

  const hInspect = await runCliJson(["harness", "inspect", "pi", "--host", hostIdB], cliEnvA);
  assert.equal(hInspect.code, 0, hInspect.stderr);
  assert.equal(JSON.parse(hInspect.stdout).hostId, hostIdB);

  // 3. delegate start on B with --worktree creates worktree on B, and repeating --request-id replays idempotently.
  const startArgs = [
    "delegate",
    "start",
    "--host",
    hostIdB,
    "--harness",
    "pi",
    "--task",
    "implement feature",
    "--cwd",
    repoB,
    "--worktree",
    "feat-b-wt",
    "--request-id",
    "req-e2e-1",
  ];
  const started = await runCliJson(startArgs, cliEnvA);
  assert.equal(started.code, 0, started.stderr);
  const startedJson = JSON.parse(started.stdout) as {
    hostId: string;
    threadId: string;
    deepLink: string;
    cwd: string;
    worktree?: { path: string; branch: string };
    next: { read: string; wait: string };
  };
  assert.equal(startedJson.hostId, hostIdB);
  const expectedLink = `thread://${startedJson.threadId}?hostId=${encodeURIComponent(hostIdB)}`;
  assert.equal(startedJson.deepLink, expectedLink);
  assert.ok(startedJson.next.read.includes(expectedLink));
  assert.ok(startedJson.worktree?.branch === "feat-b-wt");
  assert.ok(existsSync(startedJson.worktree.path), "worktree must be created on B");
  assert.equal(startedJson.cwd, startedJson.worktree.path);

  const replayed = await runCliJson(startArgs, cliEnvA);
  assert.equal(replayed.code, 0, replayed.stderr);
  const replayedJson = JSON.parse(replayed.stdout) as {
    threadId: string;
    worktree?: { path: string; branch: string };
  };
  assert.equal(replayedJson.threadId, startedJson.threadId);
  assert.equal(replayedJson.worktree?.path, startedJson.worktree.path);

  // 4. thread read & send (with --steer) on B using thread:// link.
  const read1 = await runCliJson(["thread", "read", expectedLink], cliEnvA);
  assert.equal(read1.code, 0, read1.stderr);
  assert.equal(JSON.parse(read1.stdout).status, "running");

  const sent = await runCliJson(
    ["thread", "send", expectedLink, "--message", "adjust direction", "--steer", "true"],
    cliEnvA,
  );
  assert.equal(sent.code, 0, sent.stderr);
  assert.equal(JSON.parse(sent.stdout).hostId, hostIdB);

  // 5. thread wait polls B's read from A until B transitions to completed.
  const waited = await runCliJson(
    ["thread", "wait", expectedLink, "--timeout-ms", "3000"],
    cliEnvA,
  );
  assert.equal(waited.code, 0, waited.stderr);
  const waitedJson = JSON.parse(waited.stdout) as DelegationThreadSnapshot & { timedOut: boolean };
  assert.equal(waitedJson.timedOut, false);
  assert.equal(waitedJson.status, "completed");
  assert.equal(waitedJson.hostId, hostIdB);
  assert.match(waitedJson.result.text ?? "", /implement feature\|\[steer\] adjust direction/u);

  // 6. thread answer, thread cancel, and thread list on B.
  const answersPath = join(root, "answers.json");
  writeFileSync(answersPath, JSON.stringify({ answer: "yes" }), "utf8");
  const answered = await runCliJson(
    ["thread", "answer", expectedLink, "--interaction", "q-1", "--answers-file", answersPath],
    cliEnvA,
  );
  assert.equal(answered.code, 0, answered.stderr);
  assert.deepEqual(threadsB.get(startedJson.threadId)?.answered, {
    interactionId: "q-1",
    result: { answer: "yes" },
  });

  const cancelled = await runCliJson(["thread", "cancel", expectedLink], cliEnvA);
  assert.equal(cancelled.code, 0, cancelled.stderr);
  assert.equal(JSON.parse(cancelled.stdout).cancelled, true);

  const listed = await runCliJson(["thread", "list", "--host", hostIdB], cliEnvA);
  assert.equal(listed.code, 0, listed.stderr);
  const listedJson = JSON.parse(listed.stdout) as { threads: Array<{ deepLink: string }> };
  assert.equal(listedJson.threads[0]?.deepLink, expectedLink);

  // 7. 1-hop loop prevention on B: the remote-origin thread (and any local child it spawns) cannot delegate remotely.
  assert.equal(await registryB.resolveRemoteOriginHopCount(startedJson.threadId), 1);
  await assert.rejects(
    registryB.start({
      hostId: "remote-peer:node-a",
      callerThreadId: startedJson.threadId,
      harnessId: "pi",
      task: "loop back to A",
      cwd: "/tmp",
    }),
    (err: unknown) => (err as { code?: string })?.code === "FORBIDDEN",
  );
  await assert.rejects(
    registryB.read({
      hostId: "remote-peer:node-c",
      callerThreadId: startedJson.threadId,
      threadId: "other",
      view: "result",
    }),
    (err: unknown) => (err as { code?: string })?.code === "FORBIDDEN",
  );
  const localChild = await registryB.start({
    parentThreadId: startedJson.threadId,
    harnessId: "pi",
    task: "local sub-task on B",
    cwd: repoB,
  });
  assert.equal(await registryB.resolveRemoteOriginHopCount(localChild.threadId), 1);
  await assert.rejects(
    registryB.send({
      hostId: "remote-peer:node-c",
      callerThreadId: localChild.threadId,
      threadId: "other",
      message: "hop 2",
    }),
    (err: unknown) => (err as { code?: string })?.code === "FORBIDDEN",
  );
});
