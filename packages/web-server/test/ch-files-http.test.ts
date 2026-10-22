import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { request as httpRequest } from "node:http";
import { once } from "node:events";
import { it } from "node:test";
import { FakeChHost, startFakeChDebugger } from "./support/ch-host.ts";
import { startServer } from "./support/server.ts";

it("raw file uploads retain auth/origin checks without file quotas, stay draft-only and pass only Session-owned paths to CH", async (t) => {
  const host = new FakeChHost();
  host.add("other", "/workspace");
  host.add("official", "/workspace").modelProvider = "openai";
  const debug = await startFakeChDebugger(host);
  t.after(() => debug.close());
  const url = new URL(
    await startServer(
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
    ),
  );
  const token = url.searchParams.get("token");
  assert.ok(token);
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/octet-stream",
    origin: url.origin,
  };
  const call = async (method: string, request: unknown) => {
    const response = await fetch(new URL(`/api/${method}`, url), {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        type: "client-request",
        rpcId: "file-test",
        method,
        payload: { args: { request } },
      }),
    });
    return (await response.json()) as { result: { ok: boolean; value?: { sessionId?: string } } };
  };
  const created = await call("session/create", { cwd: "/workspace" });
  const id = created.result.value?.sessionId;
  assert.ok(id);
  const endpoint = new URL("/api/session/uploadFileBinary", url);
  endpoint.searchParams.set("sessionId", id);
  endpoint.searchParams.set("name", "notes.txt");
  const bytes = Buffer.from("A file from Web\n\0\xff", "utf8");
  assert.equal((await fetch(endpoint, { method: "POST", body: bytes })).status, 401);
  assert.equal(
    (
      await fetch(endpoint, {
        method: "POST",
        body: bytes,
        headers: { ...headers, origin: "http://untrusted.invalid" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(endpoint, {
        method: "POST",
        body: bytes,
        headers: { ...headers, "content-type": "text/plain" },
      })
    ).status,
    415,
  );
  // Both declared-length and chunked uploads exceed the old 64 MiB limit and
  // bypass the unrelated 48 MiB JSON RPC body gate without aggregating bytes.
  for (const declared of [true, false]) {
    const largeEndpoint = new URL(endpoint);
    largeEndpoint.searchParams.set("name", "large.bin");
    const result = await new Promise<{ status: number; ok: boolean; bytes: number }>(
      (done, reject) => {
        const request = httpRequest(
          largeEndpoint,
          {
            method: "POST",
            headers: { ...headers, ...(declared ? { "content-length": 65 * 1024 * 1024 } : {}) },
          },
          (response) => {
            let body = "";
            response.setEncoding("utf8");
            response.on("data", (chunk) => {
              body += String(chunk);
            });
            response.on("end", () => {
              const parsed = JSON.parse(body) as {
                ok: boolean;
                value?: { file?: { bytes?: number } };
              };
              done({
                status: response.statusCode ?? 0,
                ok: parsed.ok,
                bytes: parsed.value?.file?.bytes ?? -1,
              });
            });
          },
        );
        request.on("error", reject);
        void (async () => {
          const block = Buffer.alloc(1024 * 1024, 42);
          for (let i = 0; i < 65; i++) if (!request.write(block)) await once(request, "drain");
          request.end();
        })().catch(reject);
      },
    );
    assert.deepEqual(result, { status: 200, ok: true, bytes: 65 * 1024 * 1024 });
  }
  const upload = await fetch(endpoint, { method: "POST", headers, body: bytes });
  const stored = (await upload.json()) as {
    ok: boolean;
    value: { receiptId: string; file: { bytes: number; name: string } };
  };
  assert.equal(stored.ok, true);
  assert.equal(stored.value.file.bytes, bytes.length);
  assert.equal(
    host.requests.some((r) => r.method === "thread/start"),
    false,
  );
  const content = [
    { type: "file", receiptId: stored.value.receiptId },
    { type: "text", text: "Inspect it" },
  ];
  assert.equal((await call("session/prompt", { sessionId: "other", content })).result.ok, false);
  assert.equal(
    host.requests.some((r) => r.method === "turn/start"),
    false,
  );
  assert.equal((await call("session/prompt", { sessionId: id, content })).result.ok, true);
  const sent = host.requests.find((r) => r.method === "turn/start");
  assert.ok(sent);
  const input = sent.params.input as Array<{ type: string; text: string }>;
  assert.ok(input.every((part) => part.type === "text"));
  const path = /## notes.txt: (.+)\n/u.exec(input[0]?.text ?? "")?.[1];
  assert.ok(path);
  assert.deepEqual(readFileSync(path), bytes);
  assert.equal(input[0]?.text.endsWith("## My request:\nInspect it"), true);
  assert.equal(
    (await call("session/prompt", { sessionId: String(sent.params.threadId), content })).result.ok,
    false,
    "accepted receipts are retired, not silently reused",
  );
  endpoint.searchParams.set("sessionId", "official");
  const rejected = await fetch(endpoint, { method: "POST", headers, body: bytes });
  assert.equal(((await rejected.json()) as { ok: boolean }).ok, false);
  assert.equal(host.requests.filter((r) => r.method === "turn/start").length, 1);
});
