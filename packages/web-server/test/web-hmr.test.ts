/** Development reload channel: rebuilt bundles and shell documents reach open pages over SSE. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, get, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";

import { WebAssets } from "../src/web-assets.ts";
import { HMR_EVENTS_PATH, WebHmr } from "../src/web-hmr.ts";

const PLUGIN = "@fixture/alpha";

function fixture(): { root: string; bundle: string; shell: string } {
  const root = mkdtempSync(join(tmpdir(), "codexhost-web-hmr-"));
  const dir = join(root, "packages/client/alpha");
  mkdirSync(join(dir, "lib"), { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: PLUGIN,
      exports: { "./client": "./lib/client.js" },
      dsh: { client: { platform: "web" } },
    }),
  );
  const bundle = join(dir, "lib/client.js");
  writeFileSync(bundle, "alpha(1);\n");
  mkdirSync(join(root, "apps/web/dist"), { recursive: true });
  mkdirSync(join(root, "vendor"));
  const shell = join(root, "apps/web/dist/index.html");
  writeFileSync(
    shell,
    "<html><head><title>x</title></head><body><script src=a.js></script></body></html>",
  );
  return { root, bundle, shell };
}

/** Collect parsed SSE frames from one open stream. */
async function subscribe(url: string): Promise<{ frames: unknown[]; response: IncomingMessage }> {
  const frames: unknown[] = [];
  const response = await new Promise<IncomingMessage>((resolve) => get(url, resolve));
  response.setEncoding("utf8");
  let buffer = "";
  response.on("data", (chunk: string) => {
    buffer += chunk;
    let end: number;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      if (block.startsWith("data: ")) frames.push(JSON.parse(block.slice("data: ".length)));
    }
  });
  return { frames, response };
}

async function until(condition: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

it("pushes rebuilt plugin bundles and shell documents, skipping unchanged rewrites", async (t) => {
  const { root, bundle, shell } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const assets = new WebAssets({ repoRoot: root, plugins: [PLUGIN], globals: {}, title: "T" });
  const hmr = new WebHmr(assets, 20);
  const server = createServer((request, response) => {
    hmr.connect(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    hmr.close();
    server.close();
  });
  const { port } = server.address() as AddressInfo;
  const { frames, response } = await subscribe(
    `http://127.0.0.1:${String(port)}${HMR_EVENTS_PATH}`,
  );
  assert.equal(response.headers["content-type"], "text/event-stream");

  await until(() => frames.length === 1, "the initial graph");
  const initialRev = assets.graph.entries[0]?.rev;
  assert.deepEqual(frames[0], { type: "graph", graph: assets.graph });

  writeFileSync(bundle, "alpha(2);\n");
  await until(() => frames.length === 2, "the rebuilt frame");
  const rebuilt = frames[1] as { type: string; id: string; rev: string };
  assert.equal(rebuilt.type, "rebuilt");
  assert.equal(rebuilt.id, PLUGIN);
  assert.notEqual(rebuilt.rev, initialRev);
  assert.equal(assets.graph.entries[0]?.rev, rebuilt.rev);
  const served = assets.plugin(`/plugins/??${PLUGIN}/client.js&rev=${rebuilt.rev}`);
  assert.match(served?.body.toString() ?? "", /alpha\(2\)/u);
  assert.match(assets.index().body.toString(), new RegExp(rebuilt.rev, "u"));

  // A watcher's initial rebuild rewrites identical bytes: the page must not reload for it.
  const later = new Date(Date.now() + 5_000);
  utimesSync(bundle, later, later);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(frames.length, 2);

  writeFileSync(
    shell,
    "<html><head><title>x</title></head><body><script src=b.js></script></body></html>",
  );
  await until(() => frames.length === 3, "the shell frame");
  assert.deepEqual(frames[2], { type: "shell" });
  assert.match(assets.index().body.toString(), /b\.js/u);
  response.destroy();
});
