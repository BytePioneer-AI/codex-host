import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { it, type TestContext } from "node:test";
import { createDshWebBackend, type WebPluginRuntime } from "@codexhost/dsh-web-backend";
import { readWebPluginBundle } from "@codexhost/dsh-web-backend/plugin-bundles";

function file(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
function fixture(t: TestContext, name = "test-web-plugin") {
  const root = mkdtempSync(join(tmpdir(), "codexhost-native-plugin-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, "node_modules", name);
  file(
    join(directory, "package.json"),
    JSON.stringify({ name, version: "1.0.0", type: "module", exports: { ".": "./index.js" } }),
  );
  return { root, id: name, directory };
}
async function backend(t: TestContext, root: string) {
  const result = await createDshWebBackend({ workspaceRoot: root, threadWorkspace: () => root });
  t.after(() => result.close());
  return result;
}
async function serve(t: TestContext, runtime: WebPluginRuntime) {
  const server = createServer((req, res) => {
    void runtime
      .handle(req, res)
      .then((handled) => {
        if (!handled) res.writeHead(404).end();
      })
      .catch(() => res.writeHead(500).end());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
const ADDRESS = () => ({ host: "127.0.0.1", port: 0 });

it("composes native bundle layers, config expressions and package dependencies with one host Cordis", async (t) => {
  const pkg = fixture(t);
  file(
    join(pkg.directory, "package.json"),
    JSON.stringify({
      name: pkg.id,
      version: "1.0.0",
      type: "module",
      dsh: { bundle: { patch: ["first.yml", "second.yml"] } },
    }),
  );
  const client = join(pkg.root, "node_modules/bundle-client");
  file(
    join(client, "package.json"),
    JSON.stringify({
      name: "bundle-client",
      version: "1.0.0",
      type: "module",
      exports: { ".": "./host.js", "./client": "./client.js" },
      dsh: { client: { platform: "web", inject: [] } },
    }),
  );
  file(join(client, "host.js"), "export function apply() {}\n");
  file(join(client, "client.js"), "window.__bundleClient = true;\n");
  file(
    join(pkg.directory, "first.yml"),
    `- insert:\n    - id: value\n      name: ./value.js\n      config: {value: 1}\n    - id: route\n      name: ./route.js\n      config:\n        text: !!js "'value:' + ctx.get('bundleValue')"\n    - id: client\n      name: bundle-client\n`,
  );
  file(join(pkg.directory, "second.yml"), "- id: value\n  config: {value: 42}\n");
  file(
    join(pkg.directory, "value.js"),
    `export function apply(ctx, config) { ctx.provide('bundleValue', config.value) }`,
  );
  file(
    join(pkg.directory, "route.js"),
    `
    import { Service } from '@deepseek-ai/cordis';
    import Include from '@deepseek-ai/cordis-plugin-include';
    import { EntryTree } from '@deepseek-ai/cordis-plugin-loader';
    if (!(Include.prototype instanceof EntryTree)) throw new Error('Include must use host Loader');
    import { suffix } from 'local-dependency';
    export default class Route extends Service {
      static inject = ['webServer', 'bundleValue'];
      constructor(ctx, config) {
        super(ctx, 'extensionProbe');
        ctx.effect(() => ctx.webServer.register({kind:'prefix', path:'/probe', handler(req,res) {
          res.setHeader('etag', 'native');
          if (req.headers['if-none-match'] === 'native') return res.writeHead(304).end();
          if (req.method !== 'GET' && req.method !== 'HEAD') return res.writeHead(405).end();
          res.end(req.method === 'HEAD' ? undefined : config.text + suffix);
        }}));
      }
    }`,
  );
  file(
    join(pkg.root, "node_modules/local-dependency/package.json"),
    JSON.stringify({ name: "local-dependency", type: "module", exports: "./index.js" }),
  );
  file(
    join(pkg.root, "node_modules/local-dependency/index.js"),
    "export const suffix = ':dependency';",
  );
  file(
    join(pkg.root, "node_modules/@deepseek-ai/cordis/package.json"),
    JSON.stringify({ name: "@deepseek-ai/cordis", type: "module", exports: "./index.js" }),
  );
  file(
    join(pkg.root, "node_modules/@deepseek-ai/cordis/index.js"),
    "throw new Error('downloaded Cordis must not execute');",
  );
  const bundle = readWebPluginBundle(pkg);
  assert.equal(bundle.entries.length, 3);
  const host = await backend(t, pkg.root);
  const runtime = await host.loadPlugins({ packages: [pkg], builtins: [], address: ADDRESS });
  assert.deepEqual(
    runtime.clients.graph().entries.map((entry) => entry.id),
    ["bundle-client"],
  );
  const url = await serve(t, runtime);
  assert.equal(await (await fetch(`${url}/probe/child`)).text(), "value:42:dependency");
  assert.equal((await fetch(`${url}/probe-other`)).status, 404);
  const head = await fetch(`${url}/probe`, { method: "HEAD" });
  assert.equal(head.headers.get("etag"), "native");
  assert.equal(await head.text(), "");
  assert.equal(
    (await fetch(`${url}/probe`, { headers: { "if-none-match": "native" } })).status,
    304,
  );
  assert.equal((await fetch(`${url}/probe`, { method: "POST" })).status, 405);
  await runtime.close();
  assert.equal((await fetch(`${url}/probe`)).status, 404);
});

it("reports required services and preserves the core backend after a failed subtree", async (t) => {
  const pkg = fixture(t);
  file(
    join(pkg.directory, "index.js"),
    "export const inject = ['missingAgentService']; export function apply() { throw new Error('must not run') }",
  );
  const host = await backend(t, pkg.root);
  await assert.rejects(
    host.loadPlugins({ packages: [pkg], builtins: [], address: ADDRESS }),
    /missing services missingAgentService/,
  );
  assert.equal(host.handles("workspaceFiles/list"), true);
  const clean = await host.loadPlugins({ packages: [], builtins: [], address: ADDRESS });
  await clean.close();
});

it("rejects replacing a core service without disposing it", async (t) => {
  const pkg = fixture(t);
  file(join(pkg.directory, "index.js"), "export function apply(ctx) { ctx.provide('fs', {}) }");
  const host = await backend(t, pkg.root);
  await assert.rejects(
    host.loadPlugins({ packages: [pkg], builtins: [], address: ADDRESS }),
    /fs|already|duplicate/,
  );
  assert.equal(host.handles("workspaceFiles/list"), true);
});

it("retains pure client packages without executing the browser entry in Node", async (t) => {
  const pkg = fixture(t);
  file(
    join(pkg.directory, "package.json"),
    JSON.stringify({
      name: pkg.id,
      version: "1.0.0",
      type: "module",
      exports: { "./client": "./client.js" },
      dsh: { client: { platform: "web", inject: [] } },
    }),
  );
  file(join(pkg.directory, "client.js"), "window.__clientOnly = true;\n");
  const host = await backend(t, pkg.root);
  const runtime = await host.loadPlugins({ packages: [pkg], builtins: [], address: ADDRESS });
  assert.equal(runtime.clients.graph().entries[0]?.id, pkg.id);
  const entry = runtime.clients.graph().entries[0];
  assert.ok(entry);
  const response = await runtime.clients.fetchBundle(new Request(`http://localhost/${entry.url}`));
  assert.equal(response.status, 200);
  assert.match(await response.text(), /window.__clientOnly/);
});

it("reports duplicate native routes instead of allowing registration order to replace them", async (t) => {
  const pkg = fixture(t);
  file(
    join(pkg.directory, "index.js"),
    `export const inject=['webServer']; export function apply(ctx) {
    const route = {kind:'exact',path:'/duplicate',handler(_req,res){res.end()}};
    ctx.effect(() => ctx.webServer.register(route));
    ctx.effect(() => ctx.webServer.register(route));
  }`,
  );
  const host = await backend(t, pkg.root);
  await assert.rejects(
    host.loadPlugins({ packages: [pkg], builtins: [], address: ADDRESS }),
    /duplicate exact route/,
  );
});

it("rejects protected routes and cleans effects registered before activation throws", async (t) => {
  const pkg = fixture(t);
  const marker = join(pkg.root, "disposed");
  file(
    join(pkg.directory, "index.js"),
    `import {writeFileSync} from 'node:fs';
    export const inject=['webServer'];
    export function apply(ctx) {
      ctx.effect(() => () => writeFileSync(${JSON.stringify(marker)}, 'disposed'));
      ctx.effect(() => ctx.webServer.register({kind:'prefix',path:'/api',handler(_req,res){res.end('wrong')}}));
    }`,
  );
  const host = await backend(t, pkg.root);
  await assert.rejects(
    host.loadPlugins({
      packages: [pkg],
      builtins: [],
      address: ADDRESS,
      reserved: [{ kind: "prefix", path: "/api" }],
    }),
    /reserved route/,
  );
  assert.equal(readFileSync(marker, "utf8"), "disposed");
  assert.equal(host.handles("terminal/open"), true);
});
