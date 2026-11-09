import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { ChHostClient } from "../src/ch-host-client.ts";
import { serveVoiceTranscription, registerVoiceStatus } from "../src/voice-http.ts";
import { RpcError, RpcRegistry } from "../src/transport.ts";
import { voiceFailure } from "@codexhost/shared-contracts";
import { startServer } from "./support/server.ts";

async function waitFor(check: () => Promise<boolean>) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await delay(10);
  }
  assert.fail("condition did not become true");
}

const spooled = (root: string) => readdir(join(root, "voice")).catch(() => []);

it("voice upload bounds bytes and deletes temp audio on success, Host failure and disconnect", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "web-voice-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let calls = 0;
  let mode = "success";
  let entered = false;
  let release = () => {};
  const host = {
    request: async (method: string, params: Record<string, unknown>) => {
      calls++;
      entered = true;
      assert.equal(method, "codexhost/voice/transcribe");
      assert.deepEqual(Object.keys(params).sort(), ["mimeType", "path"]);
      assert.equal(await readFile(String(params.path), "utf8"), "audio");
      if (mode === "failure") throw new Error("must not leak raw host errors");
      if (mode === "disconnect")
        await new Promise<void>((done) => {
          release = done;
        });
      return { ok: true, text: "你好" };
    },
  } as unknown as ChHostClient;
  const server = createServer((req, res) => {
    void serveVoiceTranscription(host, root, req, res);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(
    () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  );
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/voice/transcribe`;
  const send = (body: BodyInit, headers = { "content-type": "audio/webm;codecs=opus" }) =>
    fetch(url, { method: "POST", body, headers });
  assert.deepEqual(await (await send("audio")).json(), { ok: true, text: "你好" });
  await waitFor(async () => (await spooled(root)).length === 0);
  mode = "failure";
  assert.deepEqual(await (await send("audio")).json(), voiceFailure("network"));
  await waitFor(async () => (await spooled(root)).length === 0);
  assert.equal((await send(Buffer.alloc(10 * 1024 * 1024 + 1))).status, 413);
  assert.equal((await send("")).status, 400);
  assert.equal((await send("audio", { "content-type": "text/plain" })).status, 415);
  assert.equal(calls, 2);

  // Chunked over-limit requests cannot bypass Content-Length validation.
  await new Promise<void>((done, reject) => {
    const req = httpRequest(
      url,
      { method: "POST", headers: { "content-type": "audio/webm" } },
      (res) => {
        assert.equal(res.statusCode, 413);
        res.resume();
        res.once("end", done);
      },
    );
    req.once("error", reject);
    req.write(Buffer.alloc(10 * 1024 * 1024));
    req.end(Buffer.alloc(1));
  });
  await waitFor(async () => (await spooled(root)).length === 0);
  assert.equal(calls, 2);

  mode = "disconnect";
  entered = false;
  const abort = new AbortController();
  const pending = fetch(url, {
    method: "POST",
    body: "audio",
    headers: { "content-type": "audio/webm" },
    signal: abort.signal,
  }).catch(() => undefined);
  await waitFor(async () => entered);
  abort.abort();
  await pending;
  // The Host call cannot be cancelled: its audio stays readable until it returns.
  assert.equal((await spooled(root)).length, 1);
  release();
  await waitFor(async () => (await spooled(root)).length === 0);

  // An interrupted upload is cleaned even before any Host request.
  const upload = httpRequest(url, { method: "POST", headers: { "content-type": "audio/webm" } });
  upload.on("error", () => {});
  upload.write("partial");
  await waitFor(async () => (await spooled(root)).length > 0);
  upload.destroy();
  await waitFor(async () => (await spooled(root)).length === 0);
  assert.equal(calls, 3);
});

it("distinguishes Host connection failures, RPC errors and incompatible results without leaking raw errors", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "web-voice-errors-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let outcome: { error: unknown } | { result: unknown } = { result: undefined };
  let calls = 0;
  const host = {
    request: async () => {
      calls++;
      if ("error" in outcome) throw outcome.error;
      return outcome.result;
    },
  } as unknown as ChHostClient;
  const server = createServer((req, res) => {
    void serveVoiceTranscription(host, root, req, res);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(
    () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  );
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/voice/transcribe`;
  const cases = [
    { error: new RpcError("host/offline", "private"), code: "network" },
    { error: new RpcError("host/disconnected", "private"), code: "network" },
    { error: new RpcError("host/unavailable", "private"), code: "network" },
    { error: new RpcError("host/rejected", "private", { hostCode: -32093 }), code: "network" },
    { error: new RpcError("host/rejected", "private", { hostCode: -32094 }), code: "network" },
    {
      error: new RpcError(
        "host/rejected",
        "CH is disconnected; reconnect before submitting an operation",
      ),
      code: "network",
    },
    {
      error: new RpcError(
        "host/rejected",
        "CH is disconnected; reconnect before submitting an operation",
        { hostCode: -32601 },
      ),
      code: "host-incompatible",
    },
    { error: new RpcError("host/method-unavailable", "private"), code: "host-incompatible" },
    {
      error: new RpcError("host/rejected", "private", { hostCode: -32601 }),
      code: "host-incompatible",
    },
    {
      error: new RpcError("host/rejected", "private", { hostCode: -32602 }),
      code: "host-incompatible",
    },
    {
      error: new RpcError("host/rejected", "private", { hostCode: -32603 }),
      code: "network",
    },
    { error: new Error("private"), code: "network" },
  ] as const;
  const send = () =>
    fetch(url, { method: "POST", body: "audio", headers: { "content-type": "audio/webm" } });
  for (const entry of cases) {
    outcome = { error: entry.error };
    assert.deepEqual(await (await send()).json(), voiceFailure(entry.code));
    await waitFor(async () => (await spooled(root)).length === 0);
  }
  const invalid: unknown[] = [
    null,
    {},
    { ok: true, text: 42 },
    { ok: false, error: { code: "unknown" } },
    { ok: false, error: { code: "network", message: "private" } },
  ];
  const valid = [
    voiceFailure("login-expired"),
    voiceFailure("rate-limited"),
    { ok: true, text: "你好" },
  ];
  for (const result of [...invalid, ...valid]) {
    outcome = { result };
    assert.deepEqual(
      await (await send()).json(),
      invalid.includes(result) ? voiceFailure("host-incompatible") : result,
    );
    await waitFor(async () => (await spooled(root)).length === 0);
  }
  assert.equal(calls, cases.length + invalid.length + valid.length, "no automatic retry");
});

it("status exposes only parsed availability and handles an old/offline Host", async () => {
  const rpc = new RpcRegistry();
  registerVoiceStatus(rpc, {
    request: async () => ({ available: true }),
  } as unknown as ChHostClient);
  assert.deepEqual(await rpc.dispatch("codexhost/voice/status", {}), {
    ok: true,
    value: { available: true },
  });
  for (const error of [
    new Error("private"),
    new RpcError("host/rejected", "private", { hostCode: -32601 }),
  ]) {
    registerVoiceStatus(rpc, {
      request: async () => {
        throw error;
      },
    });
    assert.deepEqual(await rpc.dispatch("codexhost/voice/status", {}), {
      ok: true,
      value: { available: false },
    });
  }
});

it("real voice routes retain Web authentication and same-origin gates", async (t) => {
  const base = new URL(
    await startServer(
      t,
      resolve(import.meta.dirname, ".."),
      ["--import", "tsx", "src/main.ts"],
      ["--adapters", "test/fake-harness"],
      { authenticated: true },
    ),
  );
  for (const path of ["/api/voice/transcribe", "/api/codexhost/voice/status"]) {
    const url = new URL(path, base);
    assert.equal((await fetch(url, { method: "POST", body: "audio" })).status, 401);
    assert.equal(
      (
        await fetch(url, {
          method: "POST",
          body: "audio",
          headers: {
            authorization: `Bearer ${base.searchParams.get("token")}`,
            origin: "http://untrusted.invalid",
          },
        })
      ).status,
      403,
    );
  }
});
