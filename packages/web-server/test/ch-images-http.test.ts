import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ChAttachments } from "../src/ch-attachments.ts";
import { WebImages } from "../src/web-images.ts";
import { DataDir } from "../src/store.ts";
import { it } from "node:test";
import { FakeChHost, startFakeChDebugger } from "./support/ch-host.ts";
import { startServer } from "./support/server.ts";
import { nativeImageInput, PNG } from "./support/image.ts";

it("image RPCs retain auth/origin checks and bound request bodies before saving or native dispatch", async (t) => {
  const host = new FakeChHost();
  host.add("thread", "/project");
  const root = mkdtempSync(join(tmpdir(), "native-images-http-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "codex-clipboard-test.png");
  writeFileSync(path, Buffer.from(PNG, "base64"));
  const content = nativeImageInput(path, "Native history");
  const nativeMessage = host.add("desktop", "/project").turns[0]?.items[0];
  assert.ok(nativeMessage);
  nativeMessage.content = content;
  host.add("official", "/project").modelProvider = "openai";
  const projected = new ChAttachments(new WebImages(new DataDir(join(root, "web")))).project(
    "desktop",
    content,
  ) as Array<{ attachment: { attachmentId: string } }>;
  const attachmentId = projected[0]?.attachment.attachmentId;
  assert.ok(attachmentId);
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
  const endpoint = new URL("/api/session/prompt", url);
  const envelope = JSON.stringify({
    type: "client-request",
    rpcId: "image",
    method: "session/prompt",
    payload: {
      args: {
        request: {
          sessionId: "thread",
          content: [{ type: "image", mediaType: "image/png", data: PNG }],
        },
      },
    },
  });
  assert.equal((await fetch(endpoint, { method: "POST", body: envelope })).status, 401);
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  assert.equal(
    (
      await fetch(endpoint, {
        method: "POST",
        body: envelope,
        headers: { ...headers, origin: "http://untrusted.invalid" },
      })
    ).status,
    403,
  );
  const status = await new Promise<number>((resolveStatus, reject) => {
    const request = httpRequest(
      endpoint,
      { method: "POST", headers: { ...headers, "content-length": 49 * 1024 * 1024 } },
      (response) => {
        response.resume();
        response.on("end", () => {
          resolveStatus(response.statusCode ?? 0);
          request.destroy();
        });
      },
    );
    request.on("error", reject);
    request.end("{}");
  });
  assert.equal(status, 413);
  assert.equal(
    host.requests.some((call) => call.method === "turn/start"),
    false,
  );
  const response = await fetch(endpoint, {
    method: "POST",
    body: envelope,
    headers: { ...headers, origin: url.origin },
  });
  assert.equal(response.status, 200);
  const result = (await response.json()) as { result: { ok: boolean } };
  assert.equal(result.result.ok, true);
  assert.equal(host.requests.filter((call) => call.method === "turn/start").length, 1);

  const imageEndpoint = new URL("/api/session/attachment", url);
  const imageBody = (sessionId: string, id = attachmentId) =>
    JSON.stringify({
      type: "client-request",
      rpcId: "native-image",
      method: "session/attachment",
      payload: {
        args: { request: { sessionId, attachmentId: id, path: "/private/untrusted.png" } },
      },
    });
  assert.equal(
    (await fetch(imageEndpoint, { method: "POST", body: imageBody("desktop") })).status,
    401,
  );
  assert.equal(
    (
      await fetch(imageEndpoint, {
        method: "POST",
        body: imageBody("desktop"),
        headers: { ...headers, origin: "http://untrusted.invalid" },
      })
    ).status,
    403,
  );
  const read = await fetch(imageEndpoint, { method: "POST", body: imageBody("desktop"), headers });
  const imageResult = (await read.json()) as { result: { ok: boolean; value: { data: string } } };
  assert.equal(imageResult.result.ok, true);
  assert.equal(
    imageResult.result.value.data,
    PNG,
    "an extra browser-supplied path cannot redirect a native image read",
  );
  const deniedReads: Array<[string, string]> = [
    ["thread", attachmentId],
    ["official", attachmentId],
    ["desktop", path],
  ];
  for (const [sessionId, id] of deniedReads) {
    const denied = await fetch(imageEndpoint, {
      method: "POST",
      body: imageBody(sessionId, id),
      headers,
    });
    assert.equal(((await denied.json()) as { result: { ok: boolean } }).result.ok, false);
  }
  assert.equal(
    host.requests.filter((call) => call.method === "turn/start").length,
    1,
    "native image reads are read-only",
  );
});
