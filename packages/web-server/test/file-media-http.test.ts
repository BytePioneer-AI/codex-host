import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { startServer } from "./support/server.ts";
import { FakeChHost, startFakeChDebugger } from "./support/ch-host.ts";
import { PNG } from "./support/image.ts";

it("serves authenticated GET/HEAD local images through the existing Markdown URL", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "web-file-media-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "图片 with spaces.png");
  writeFileSync(path, Buffer.from(PNG, "base64"));
  writeFileSync(join(root, "notes.txt"), "not an image");
  const debug = await startFakeChDebugger(new FakeChHost());
  t.after(() => debug.close());
  const url = new URL(
    await startServer(
      t,
      resolve(import.meta.dirname, ".."),
      ["--import", "tsx", "src/main.ts"],
      ["--session-source", "codexhost", "--ch-cdp", debug.endpoint],
      { authenticated: true },
    ),
  );
  const endpoint = new URL(`/api/file?path=${encodeURIComponent(path)}`, url);
  assert.equal((await fetch(endpoint)).status, 401);
  const headers = { authorization: `Bearer ${url.searchParams.get("token")}` };
  const image = await fetch(endpoint, { headers });
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("content-type"), "image/png");
  assert.equal(image.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), Buffer.from(PNG, "base64"));
  const head = await fetch(endpoint, { headers, method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(Number(head.headers.get("content-length")), Buffer.from(PNG, "base64").length);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  for (const name of ["missing.png", "notes.txt"]) {
    endpoint.searchParams.set("path", join(root, name));
    assert.equal((await fetch(endpoint, { headers })).status, 404);
  }
  endpoint.search = "";
  assert.equal((await fetch(endpoint, { headers })).status, 400);
});
