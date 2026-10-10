import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { it } from "node:test";
import { clientChannelEventSchema } from "@codexhost/shared-contracts";
import { FakeChChannel, startFakeChChannel } from "./support/ch-channel.ts";
import { startFakeChDebugger } from "./support/ch-host.ts";
import { startServer } from "./support/server.ts";
import { defined } from "./support/defined.ts";
import { createChHostClient } from "../src/ch-host-client.ts";

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
    const token = randomBytes(24).toString("base64url");
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
        "--token",
        token,
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
