import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { FakeChHost, startFakeChDebugger } from "./support/ch-host.ts";
import { startServer } from "./support/server.ts";

test("video streaming requires authentication and a local workspace, and supports byte seeking", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ch-workspace-video-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bytes = Buffer.from("0123456789");
  const name = "视频 #1.MP4";
  writeFileSync(join(root, name), bytes);
  writeFileSync(join(root, "page.html"), "<script>alert(1)</script>");
  writeFileSync(join(root, "empty.mp4"), "");
  const host = new FakeChHost();
  host.add("video-thread", root);
  const debug = await startFakeChDebugger(host);
  t.after(() => debug.close());
  const url = new URL(
    await startServer(
      t,
      resolve(import.meta.dirname, ".."),
      ["--import", "tsx", "src/main.ts"],
      ["--ch-cdp", debug.endpoint],
      { authenticated: true },
    ),
  );
  const headers = { authorization: `Bearer ${url.searchParams.get("token")}` };
  await fetch(new URL("/api/session/list", url), {
    method: "POST",
    headers: { ...headers, "content-type": "application/json", origin: url.origin },
    body: JSON.stringify({
      type: "client-request",
      rpcId: "video",
      method: "session/list",
      payload: { args: {} },
    }),
  });
  const media = (path = name, sessionId = "video-thread") =>
    new URL(`/api/workspace-file/video?${new URLSearchParams({ sessionId, path })}`, url);
  assert.equal((await fetch(media(), { redirect: "manual" })).status, 401);
  const full = await fetch(media(), { headers });
  assert.equal(full.status, 200);
  assert.equal(full.headers.get("content-type"), "video/mp4");
  assert.equal(full.headers.get("accept-ranges"), "bytes");
  assert.equal(full.headers.get("content-disposition"), "inline");
  assert.equal(full.headers.get("x-content-type-options"), "nosniff");
  assert.equal(full.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), bytes);
  for (const [range, start, end] of [
    ["bytes=2-5", 2, 5],
    ["bytes=7-", 7, 9],
    ["bytes=-3", 7, 9],
    ["bytes=8-999999999999999999999", 8, 9],
    ["bytes=-99", 0, 9],
  ] as const) {
    const part = await fetch(media(), { headers: { ...headers, range } });
    assert.equal(part.status, 206, range);
    assert.equal(part.headers.get("content-range"), `bytes ${start}-${end}/10`);
    assert.equal(part.headers.get("content-length"), String(end - start + 1));
    assert.deepEqual(Buffer.from(await part.arrayBuffer()), bytes.subarray(start, end + 1));
  }
  for (const range of ["bytes=10-", "bytes=-0", "bytes=999999999999999999999-"]) {
    const part = await fetch(media(), { headers: { ...headers, range } });
    assert.equal(part.status, 416);
    assert.equal(part.headers.get("content-range"), "bytes */10");
    assert.equal((await part.arrayBuffer()).byteLength, 0);
  }
  // Unsupported/invalid ranges and conditional ranges fall back to a complete response.
  for (const extra of [
    { range: "bytes=5-2" },
    { range: "bytes=0-1,4-5" },
    { range: "items=0-1" },
    { range: "bytes=2-5", "if-range": '"old"' },
  ]) {
    const reply = await fetch(media(), { headers: { ...headers, ...extra } });
    assert.equal(reply.status, 200);
    assert.deepEqual(Buffer.from(await reply.arrayBuffer()), bytes);
  }
  const head = await fetch(media(), {
    method: "HEAD",
    headers: { ...headers, range: "bytes=2-5" },
  });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), "10");
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  for (const [path, id, status] of [
    [name, "unknown", 404],
    [".", "video-thread", 404],
    ["missing.mp4", "video-thread", 404],
    ["page.html", "video-thread", 415],
  ] as const)
    assert.equal((await fetch(media(path, id), { headers })).status, status);
  assert.equal(
    (await fetch(media("empty.mp4"), { headers: { ...headers, range: "bytes=0-" } })).status,
    416,
  );
  // Match existing preview/download semantics for absolute paths outside cwd.
  const absolute = await fetch(media(join(root, name)), { headers });
  assert.equal(absolute.status, 200);
  assert.deepEqual(Buffer.from(await absolute.arrayBuffer()), bytes);
});
