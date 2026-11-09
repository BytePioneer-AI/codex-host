/** Native plugin routes behind the real Web carrier, using disposable installations and a fake Host. */
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { get, request, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it, type TestContext } from "node:test";
import { startServer } from "./support/server.ts";
import { seedWebExtension } from "./support/web-extension.ts";

const TOKEN = "native-plugin-test-token";
const headers = { authorization: `Bearer ${TOKEN}` };
const cwd = resolve(import.meta.dirname, "..");

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "codexhost-plugin-http-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source");
  mkdirSync(source);
  writeFileSync(
    join(source, "package.json"),
    JSON.stringify({
      name: "test-native-web",
      version: "1.0.0",
      type: "module",
      peerDependencies: {
        "@deepseek-ai/cordis": "^4.0.5-alpha.1",
        "@deepseek-ai/cordis-plugin-include": "^1.0.10-alpha.1",
      },
      exports: { ".": "./index.js", "./client": "./client.js" },
      dsh: { client: { platform: "web", inject: [] } },
    }),
  );
  writeFileSync(
    join(source, "client.js"),
    'window.__ModuleLoader__.load({id:"test-native-web",factory:()=>({apply(){}})});',
  );
  writeFileSync(join(source, "resource.txt"), "package resource");
  writeFileSync(
    join(source, "index.js"),
    `
    import { readFileSync, writeFileSync } from 'node:fs';
    import { Service } from '@deepseek-ai/cordis';
    import Include from '@deepseek-ai/cordis-plugin-include';
    import { EntryTree } from '@deepseek-ai/cordis-plugin-loader';
    if (!(Include.prototype instanceof EntryTree)) throw new Error('unshared runtime');
    writeFileSync(${JSON.stringify(join(root, "imported"))}, 'yes');
    export default class Probe extends Service {
      static inject = ['webServer'];
      constructor(ctx) {
        super(ctx, 'pluginProbe');
        ctx.effect(() => () => writeFileSync(${JSON.stringify(join(root, "disposed"))}, 'yes'));
        for (const [kind,path,text] of [['prefix','/test-host','prefix'],['prefix','/test-host/nested','nested'],['exact','/test-host/exact','exact']]) {
          ctx.effect(() => ctx.webServer.register({kind,path,handler(req,res){
            if (req.url === '/test-host/error') throw new Error('request probe');
            if (req.url === '/test-host/resource') return res.end(readFileSync(new URL('./resource.txt',import.meta.url)));
            res.setHeader('etag', 'plugin-etag');
            if (req.headers['if-none-match'] === 'plugin-etag') return res.writeHead(304).end();
            res.end(text);
          }}));
        }
        ctx.effect(() => ctx.webServer.registerUpgrade({path:'/test-upgrade',handler(_req,socket){socket.write('HTTP/1.1 101 Switching Protocols\\r\\nConnection: Upgrade\\r\\nUpgrade: probe\\r\\n\\r\\n')}}));
        ctx.on('webserver/index-inject', table => table.push({kind:'html',placement:'head',html:'<meta name="plugin-injection" content="yes">'}));
        ctx.effect(() => ctx.webServer.tapIndex(html => html.replace('</head>', '<meta name="plugin-tap"></head>')));
      }
    }`,
  );
  return { root, source };
}

async function rpc(base: string, action: string, args = {}) {
  const method = `codexhost/uiExtensions/${action}`;
  const response = await fetch(new URL(`/api/${method}`, base), {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ type: "client-request", rpcId: "probe", method, payload: { args } }),
  });
  const reply = (await response.json()) as {
    result: {
      ok: boolean;
      value: { loadedIds: string[]; extensions: { loadError?: string }[] };
      error?: unknown;
    };
  };
  assert.equal(reply.result.ok, true, JSON.stringify(reply));
  return reply.result.value;
}

function upgrade(base: string, extra: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(new URL("/test-upgrade", base), {
      headers: { connection: "Upgrade", upgrade: "probe", ...extra },
      agent: false,
    });
    req.on("upgrade", (res, socket) => {
      socket.destroy();
      resolve(res.statusCode ?? 0);
    });
    req.on("response", (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

async function subscribe(t: TestContext, base: string) {
  const response = await new Promise<IncomingMessage>((resolve) =>
    get(new URL("/plugins/events", base), { headers }, resolve),
  );
  let closing = false;
  let failure: Error | undefined;
  response.on("error", (error: Error) => {
    if (!closing) failure = error;
  });
  const close = () => {
    closing = true;
    response.destroy();
  };
  t.after(() => {
    close();
    assert.ifError(failure);
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["content-type"], "text/event-stream");
  const graphs: { entries: { id: string }[] }[] = [];
  let buffer = "";
  response.setEncoding("utf8");
  response.on("data", (chunk: string) => {
    buffer += chunk;
    let end: number;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      if (!line.startsWith("data: ")) continue;
      const frame = JSON.parse(line.slice(6));
      if (frame.type === "graph") graphs.push(frame.graph);
    }
  });
  return {
    response,
    close,
    async contains(id: string, present: boolean) {
      const deadline = Date.now() + 5000;
      while (graphs.at(-1)?.entries.some((row) => row.id === id) !== present) {
        assert.ifError(failure);
        assert.ok(Date.now() < deadline, "SSE graph did not converge");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
  };
}

it(
  "preserves native routing, authentication and recovery projections through hot selection changes",
  { timeout: 30_000 },
  async (t) => {
    const { root, source } = fixture(t);
    const data = join(root, "data");
    const pkg = seedWebExtension(data, source);
    let child!: ChildProcess;
    const url = await startServer(
      t,
      cwd,
      ["--import", "tsx", "src/main.ts"],
      ["--data", data, "--token", TOKEN],
      {
        authenticated: true,
        onSpawn: (value) => {
          child = value;
        },
      },
    );
    assert.deepEqual((await rpc(url, "list")).loadedIds, [pkg.id]);
    assert.equal((await fetch(new URL("/plugins/events", url))).status, 401);
    const first = await subscribe(t, url);
    const second = await subscribe(t, url);
    await first.contains(pkg.id, true);
    await second.contains(pkg.id, true);
    assert.equal((await fetch(new URL("/test-host", url))).status, 401);
    const get = (path: string, options: RequestInit = {}) =>
      fetch(new URL(path, url), { ...options, headers: { ...headers, ...options.headers } });
    for (const [path, value] of [
      ["/test-host/exact", "exact"],
      ["/test-host/nested/child", "nested"],
      ["/test-host/child", "prefix"],
    ] as const)
      assert.equal(await (await get(path)).text(), value);
    assert.equal((await get("/test-host-other")).status, 404);
    assert.equal(await (await get("/test-host", { method: "HEAD" })).text(), "");
    assert.equal(
      (await get("/test-host", { headers: { "if-none-match": "plugin-etag" } })).status,
      304,
    );
    assert.equal(
      (await get("/test-host", { method: "POST", headers: { origin: "http://elsewhere.test" } }))
        .status,
      403,
    );
    assert.equal(
      (await get("/test-host", { method: "POST", headers: { origin: new URL(url).origin } }))
        .status,
      200,
    );
    assert.equal((await get("/test-host/error")).status, 500);
    assert.equal(await upgrade(url), 401);
    assert.equal(await upgrade(url, { ...headers, origin: "http://elsewhere.test" }), 401);
    assert.equal(await upgrade(url, { ...headers, origin: new URL(url).origin }), 101);
    assert.match(await (await get("/")).text(), /plugin-injection/);
    assert.match(await (await get("/")).text(), /plugin-tap/);
    for (const path of ["/extensions", "/?extensions=off"])
      assert.doesNotMatch(await (await get(path)).text(), /plugin-injection|plugin-tap/);
    assert.equal((await get("/test-host")).status, 200);
    // Public shell filenames remain core-owned, even with a user plugin mounted.
    assert.equal((await fetch(new URL("/manifest.webmanifest", url))).status, 200);
    const recovery = await (await get("/?extensions=off")).text();
    assert.doesNotMatch(recovery, /dsh-client-hmr|test-native-web/);
    await rpc(url, "setEnabled", { id: pkg.id, enabled: false });
    await first.contains(pkg.id, false);
    await second.contains(pkg.id, false);
    assert.equal((await get("/test-host/resource")).status, 404);
    assert.ok(existsSync(pkg.directory));
    assert.doesNotMatch(await (await get("/")).text(), /plugin-injection|plugin-tap/);
    first.close();
    await rpc(url, "setEnabled", { id: pkg.id, enabled: true });
    await second.contains(pkg.id, true);
    const reconnected = await subscribe(t, url);
    await reconnected.contains(pkg.id, true);
    assert.equal(await (await get("/test-host/resource")).text(), "package resource");
    assert.match(await (await get("/")).text(), /plugin-injection/);
    await rpc(url, "remove", { id: pkg.id });
    await reconnected.contains(pkg.id, false);
    assert.equal((await get("/test-host/resource")).status, 404);
    assert.equal(existsSync(pkg.directory), false);
    second.close();
    reconnected.close();
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await exited;
    assert.ok(existsSync(join(root, "disposed")));
    assert.equal(existsSync(pkg.directory), false);
  },
);

it(
  "does not import disabled or safe-mode Host entries and exposes missing-service diagnostics",
  { timeout: 30_000 },
  async (t) => {
    for (const mode of ["disabled", "safe", "missing"]) {
      await t.test(mode, async (t) => {
        const { root, source } = fixture(t);
        if (mode === "missing")
          writeFileSync(
            join(source, "index.js"),
            "export const inject=['missingAgentService'];export function apply(){}",
          );
        const data = join(root, "data");
        seedWebExtension(data, source);
        if (mode === "disabled") {
          const registry = join(data, "ui-extensions/installed.json");
          const saved = JSON.parse(readFileSync(registry, "utf8"));
          saved.extensions[0].enabledTargets = [];
          writeFileSync(registry, JSON.stringify(saved));
        }
        const url = await startServer(
          t,
          cwd,
          ["--import", "tsx", "src/main.ts"],
          ["--data", data, "--token", TOKEN, ...(mode === "safe" ? ["--safe-mode"] : [])],
          { authenticated: true },
        );
        const state = await rpc(url, "list");
        assert.deepEqual(state.loadedIds, []);
        assert.equal(existsSync(join(root, "imported")), false);
        assert.equal((await fetch(new URL("/test-host", url), { headers })).status, 404);
        if (mode === "missing")
          assert.match(state.extensions[0]?.loadError ?? "", /missingAgentService/);
        if (mode === "safe") {
          await rpc(url, "setEnabled", { id: "test-native-web", enabled: true });
          assert.equal(existsSync(join(root, "imported")), false);
          assert.equal((await fetch(new URL("/plugins/events", url), { headers })).status, 404);
        }
      });
    }
  },
);
