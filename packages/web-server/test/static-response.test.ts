import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { it } from "node:test";
import { sendAsset } from "../src/static-response.ts";

it("revalidates a compressed settings script and serves new bytes when it changes", async (t) => {
  const original = "window.settingsVersion = 1;\n".repeat(100);
  const updated = original.replaceAll("= 1", "= 2");
  let body = Buffer.from(original);
  const server = createServer((request, response) => {
    void sendAsset(request, response, { contentType: "text/javascript", body }, "no-cache", true);
  });
  server.listen(0, "127.0.0.1");
  t.after(() => {
    server.close();
    server.closeAllConnections();
  });
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/codexhost-settings.js`;

  const first = await fetch(url, { headers: { "accept-encoding": "br" } });
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("content-encoding"), "br");
  assert.equal(await first.text(), original);
  const etag = first.headers.get("etag");
  assert.ok(etag);

  const cached = await fetch(url, {
    headers: { "if-none-match": `"old", ${etag.replace(/^W\//u, "")}` },
  });
  assert.equal(cached.status, 304);
  assert.equal(cached.headers.get("etag"), etag);
  assert.equal(cached.headers.get("vary"), "Accept-Encoding");
  assert.equal(cached.headers.get("cache-control"), "no-cache");
  assert.equal(await cached.text(), "");

  body = Buffer.from(updated);
  const changed = await fetch(url, {
    headers: { "accept-encoding": "br", "if-none-match": etag },
  });
  assert.equal(changed.status, 200);
  assert.ok(changed.headers.get("etag"));
  assert.notEqual(changed.headers.get("etag"), etag);
  assert.equal(changed.headers.get("cache-control"), "no-cache");
  assert.equal(await changed.text(), updated);
});
