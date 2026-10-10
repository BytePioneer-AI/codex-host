import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { resolve } from "node:path";
import { it } from "node:test";
import { FakeChHost, startFakeChDebugger } from "./support/ch-host.ts";
import { startServer } from "./support/server.ts";
import { PNG } from "./support/image.ts";

it("image RPCs retain auth/origin checks and bound request bodies before saving or native dispatch", async (t) => {
  const host = new FakeChHost();
  host.add("thread", "/project");
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
});
