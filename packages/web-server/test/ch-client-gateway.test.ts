import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { it } from "node:test";
import { clientChannelEventSchema } from "@codexhost/shared-contracts";
import { FakeChChannel, startFakeChChannel } from "./support/ch-channel.ts";
import { startFakeChDebugger } from "./support/ch-host.ts";
import { startServer } from "./support/server.ts";
import { defined } from "./support/defined.ts";
import { createChHostClient } from "../src/ch-host-client.ts";
import { serveChClientGateway } from "../src/ch-client-gateway.ts";

it(
  "exposes the same generic App protocol through Web authentication, without leaking Host credentials",
  { timeout: 15000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "ch-app-gateway-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    await assert.rejects(
      createChHostClient({ directory, cdp: "http://127.0.0.1:1" }),
      /client channel not found/u,
    );
    const host = new FakeChChannel();
    host.add("shared", "/computer/shared");
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
