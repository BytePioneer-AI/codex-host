import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { it } from "node:test";
import { gunzipSync } from "node:zlib";
import {
  HOST_EXTENSIONS_RPC,
  HOST_EXTENSION_ASSETS_PREFIX,
  HOST_EXTENSION_UPLOAD_PATH,
  PEER_DELEGATION_CHANNEL_METHOD,
  clientChannelEventSchema,
} from "@codexhost/shared-contracts";
import { FakeChChannel, startFakeChChannel } from "./support/ch-channel.ts";
import { startFakeChDebugger } from "./support/ch-host.ts";
import { startServer } from "./support/server.ts";
import { defined } from "./support/defined.ts";
import { createChHostClient } from "../src/ch-host-client.ts";
import { serveChClientGateway } from "../src/ch-client-gateway.ts";

it(
  "exposes the same generic App protocol through Web authentication, without leaking Host credentials",
  { timeout: 45_000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "ch-app-gateway-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    await assert.rejects(
      createChHostClient({ directory, cdp: "http://127.0.0.1:1" }),
      /client channel not found/u,
    );
    const host = new FakeChChannel();
    host.add("shared", "/computer/shared");
    const list = {
      revision: 2,
      configuration: { revision: 2, enabled: [] },
      diagnostics: [],
      extensions: [],
    };
    const requestHost = host.request.bind(host);
    t.mock.method(host, "request", (method: string, params: Record<string, unknown>) =>
      method === HOST_EXTENSIONS_RPC.list ? Promise.resolve(list) : requestHost(method, params),
    );
    const control = await startFakeChChannel(host, directory);
    t.after(() => control.close());
    const cdp = await startFakeChDebugger(host);
    t.after(() => cdp.close());
    // A valid URL-safe token may start with a dash; use the unambiguous CLI form.
    const token = `-${randomBytes(24).toString("base64url")}`;
    const url = await startServer(
      t,
      resolve(import.meta.dirname, ".."),
      ["--import", "tsx", "src/main.ts"],
      [
        "--session-source",
        "codexhost",
        "--ch-cdp",
        cdp.endpoint,
        "--ch-control-directory",
        directory,
        `--token=${token}`,
      ],
      { authenticated: true },
    );
    const origin = new URL(url).origin;
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    assert.equal((await fetch(`${origin}/api/ch/v1/events`)).status, 401);
    const listBody = JSON.stringify({ method: HOST_EXTENSIONS_RPC.list, params: {} });
    for (const method of [HOST_EXTENSIONS_RPC.list, HOST_EXTENSIONS_RPC.snapshot]) {
      const denied = await fetch(`${origin}/api/ch/v1/rpc`, {
        method: "POST",
        body: JSON.stringify({ method, params: {} }),
      });
      assert.equal(denied.status, 401);
      assert.equal(await denied.text(), "authentication required");
    }
    assert.equal(
      (
        await fetch(`${origin}/api/ch/v1/rpc`, {
          method: "POST",
          body: "not JSON",
        })
      ).status,
      401,
    );
    assert.equal((await fetch(`${origin}${HOST_EXTENSION_ASSETS_PREFIX}sample`)).status, 401);
    assert.equal(
      (await fetch(`${origin}${HOST_EXTENSION_UPLOAD_PATH}`, { method: "POST" })).status,
      401,
    );
    const listed = await fetch(`${origin}/api/ch/v1/rpc`, {
      method: "POST",
      headers,
      body: listBody,
    });
    assert.equal(listed.status, 200);
    assert.deepEqual(await listed.json(), { result: list });
    assert.equal(
      (
        await fetch(`${origin}/api/ch/v1/events`, {
          headers: { ...headers, origin: "http://untrusted.invalid" },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(`${origin}/api/ch/v1/rpc`, {
          method: "POST",
          headers: { ...headers, origin: "http://untrusted.invalid" },
          body: JSON.stringify({ method: "turn/start", params: {} }),
        })
      ).status,
      403,
    );
    const snapshot = await fetch(`${origin}/api/ch/v1/snapshot`, {
      method: "POST",
      headers,
      body: JSON.stringify({ threadId: "shared" }),
    });
    const text = await snapshot.text();
    assert.equal(snapshot.status, 200);
    assert.match(text, /existing CH answer/u);
    assert.doesNotMatch(text, /"token"|"port"|"pid"/u);
    // Snapshot options are opt-in and pass through to the Host unchanged.
    assert.deepEqual(host.snapshotOptions.at(-1), {});
    const compact = await fetch(`${origin}/api/ch/v1/snapshot`, {
      method: "POST",
      headers,
      body: JSON.stringify({ threadId: "shared", knownTurns: [], truncateToolOutput: true }),
    });
    assert.equal(compact.status, 200);
    const compacted = (await compact.json()) as {
      result: { turnsPage: { data: Array<{ fingerprint?: string }> } };
    };
    assert.equal(typeof compacted.result.turnsPage.data[0]?.fingerprint, "string");
    assert.deepEqual(host.snapshotOptions.at(-1), { knownTurns: [], truncateToolOutput: true });
    const malformed = await fetch(`${origin}/api/ch/v1/snapshot`, {
      method: "POST",
      headers,
      body: JSON.stringify({ threadId: "shared", knownTurns: "all" }),
    });
    assert.equal(malformed.status, 400);
    const controller = new AbortController();
    t.after(() => controller.abort());
    const events = await fetch(`${origin}/api/ch/v1/events`, {
      headers,
      signal: controller.signal,
    });
    assert.equal(events.status, 200);
    const reader = defined(events.body).getReader();
    let buffer = "";
    const decoder = new TextDecoder();
    async function next() {
      while (!buffer.includes("\n")) {
        const chunk = await reader.read();
        assert.equal(chunk.done, false);
        buffer += decoder.decode(chunk.value);
      }
      const end = buffer.indexOf("\n"),
        line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      return clientChannelEventSchema.parse(JSON.parse(line));
    }
    const hello = await next();
    assert.equal(hello.type, "hello");
    const reply = await fetch(`${origin}/api/ch/v1/rpc`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        method: "turn/start",
        params: {
          threadId: "shared",
          clientUserMessageId: "native-app",
          input: [{ type: "text", text: "From App protocol" }],
        },
      }),
    });
    assert.equal(reply.status, 200);
    const event = await next();
    assert.equal(event.type, "changed");
    assert.equal(event.cursor.epoch, hello.cursor.epoch);
    controller.abort();
    const replayAbort = new AbortController();
    t.after(() => replayAbort.abort());
    const replay = await fetch(
      `${origin}/api/ch/v1/events?epoch=${hello.cursor.epoch}&after=${hello.cursor.sequence}`,
      { headers, signal: replayAbort.signal },
    );
    const replayReader = defined(replay.body).getReader();
    let frames = "";
    while (!frames.includes('"type":"changed"')) {
      const chunk = await replayReader.read();
      assert.equal(chunk.done, false);
      frames += new TextDecoder().decode(chunk.value);
    }
    assert.match(frames, /"reset":false/u);
    assert.match(frames, /"type":"changed"/u);
    replayAbort.abort();
    assert.equal(host.requests.filter((request) => request.method === "turn/start").length, 1);

    // /api/ch/v1/* and /api/peer/v1/manifest compress JSON payloads >= 1 KiB when gzip is accepted.
    const largeThread = host.add("large", "/computer/large");
    largeThread.turns[0]?.items.push({
      type: "agentMessage",
      id: "large-msg",
      text: "compressible-json-".repeat(120),
    });
    const rawGzipRequest = (path: string, method: "GET" | "POST", body?: unknown) =>
      new Promise<{ status: number; encoding: string | undefined; body: Buffer }>(
        (resolveRequest, rejectRequest) => {
          const payload = body === undefined ? undefined : JSON.stringify(body);
          const req = httpRequest(
            `${origin}${path}`,
            {
              method,
              headers: {
                authorization: `Bearer ${token}`,
                "accept-encoding": "gzip",
                ...(payload === undefined ? {} : { "content-type": "application/json" }),
              },
            },
            (res) => {
              const chunks: Buffer[] = [];
              res.on("data", (chunk: Buffer) => chunks.push(chunk));
              res.on("end", () =>
                resolveRequest({
                  status: res.statusCode ?? 0,
                  encoding: res.headers["content-encoding"],
                  body: Buffer.concat(chunks),
                }),
              );
              res.on("error", rejectRequest);
            },
          );
          req.on("error", rejectRequest);
          if (payload !== undefined) req.write(payload);
          req.end();
        },
      );

    const gzSnap = await rawGzipRequest("/api/ch/v1/snapshot", "POST", { threadId: "large" });
    assert.equal(gzSnap.status, 200);
    assert.equal(gzSnap.encoding, "gzip");
    assert.match(gunzipSync(gzSnap.body).toString("utf8"), /compressible-json-/u);

    const gzRpc = await rawGzipRequest("/api/ch/v1/rpc", "POST", {
      method: "thread/turns/list",
      params: { threadId: "large", itemsView: "full" },
    });
    assert.equal(gzRpc.status, 200);
    assert.equal(gzRpc.encoding, "gzip");
    assert.match(gunzipSync(gzRpc.body).toString("utf8"), /compressible-json-/u);

    // Create enough workspaces so /api/peer/v1/manifest exceeds the 1 KiB compression threshold.
    for (let i = 0; i < 12; i++) {
      const wsPath = join(directory, `workspace-manifest-padding-${String(i)}-${"a".repeat(48)}`);
      mkdirSync(wsPath, { recursive: true });
      const wsRes = await fetch(`${origin}/api/rpc`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          type: "client-request",
          rpcId: `ws-${String(i)}`,
          method: "workspace/create",
          payload: { args: { path: wsPath } },
        }),
      });
      assert.equal(wsRes.status, 200);
    }
    const gzManifest = await rawGzipRequest("/api/peer/v1/manifest", "GET");
    assert.equal(gzManifest.status, 200);
    assert.equal(gzManifest.encoding, "gzip");
    const parsedManifest = JSON.parse(gunzipSync(gzManifest.body).toString("utf8")) as {
      projects: unknown[];
    };
    assert.ok(parsedManifest.projects.length >= 12);
  },
);

it("preserves numeric Host errors on every native client operation", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "ch-app-gateway-errors-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const host = new FakeChChannel();
  const control = await startFakeChChannel(host, directory);
  t.after(() => control.close());
  const client = await createChHostClient({ directory });
  t.after(() => client.close());
  const server = createServer((request, response) => {
    void serveChClientGateway(client, request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  let hostCode = -32072;
  const message = "Native session is busy in another client";
  const reject = async () => {
    throw Object.assign(new Error(message), { code: hostCode });
  };
  t.mock.method(host, "snapshot", reject);
  t.mock.method(host, "request", reject);
  t.mock.method(host, "respond", reject);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/ch/v1`;
  const denied = await fetch(`${base}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method: HOST_EXTENSIONS_RPC.recover, params: {} }),
  });
  assert.equal(denied.status, 403);
  assert.match(await denied.text(), /Authentication must be enabled/u);
  const deniedPeerDelegation = await fetch(`${base}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      method: PEER_DELEGATION_CHANNEL_METHOD,
      params: { operation: "listHarnesses", hopCount: 1, input: {} },
    }),
  });
  assert.equal(deniedPeerDelegation.status, 403);
  assert.match(await deniedPeerDelegation.text(), /\/api\/peer\/v1\/delegation/u);
  const operations = {
    snapshot: { threadId: "shared" },
    rpc: { method: "turn/start", params: { threadId: "shared" } },
    respond: { epoch: host.epoch, threadId: "shared", requestId: 1, result: {} },
  };
  for (const code of [-32072, -32094]) {
    hostCode = code;
    for (const [route, input] of Object.entries(operations)) {
      const reply = await fetch(`${base}/${route}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      assert.equal(reply.status, 400);
      assert.deepEqual(await reply.json(), { error: { code, message } });
    }
  }
});
