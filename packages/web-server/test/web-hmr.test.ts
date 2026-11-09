/** Development shell bridge has no plugin graph or rebuilt transport. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, get, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";

import { WebAssets } from "../src/web-assets.ts";
import { SHELL_EVENTS_PATH, WebShellReload } from "../src/web-hmr.ts";

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

it("only reloads rebuilt shell documents; plugin events belong to the official transport", async (t) => {
  const { root, bundle, shell } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const assets = new WebAssets({ repoRoot: root, plugins: [PLUGIN], globals: {}, title: "T" });
  const hmr = new WebShellReload(assets, 20);
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
    `http://127.0.0.1:${String(port)}${SHELL_EVENTS_PATH}`,
  );
  assert.equal(response.headers["content-type"], "text/event-stream");

  writeFileSync(bundle, "alpha(2);\n");
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(frames, []);
  // A shell rewrite with identical bytes must not reload pages.
  const later = new Date(Date.now() + 5_000);
  utimesSync(shell, later, later);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(frames, []);

  writeFileSync(
    shell,
    "<html><head><title>x</title></head><body><script src=b.js></script></body></html>",
  );
  await until(() => frames.length === 1, "the shell frame");
  assert.deepEqual(frames[0], { type: "shell" });
  assert.match(assets.index().body.toString(), /b\.js/u);
  response.destroy();
});
