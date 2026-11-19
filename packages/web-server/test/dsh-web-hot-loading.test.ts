/** Real Cordis/Loader/ClientModules and official SSE transport, with disposable package files. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, get, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { createDshWebBackend } from "@codexhost/dsh-web-backend";
import { DataDir } from "../src/store.ts";
import { WebUiExtensions } from "../src/ui-extensions.ts";

async function until(test: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!test()) {
    assert.ok(Date.now() < deadline, "condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

it(
  "applies serialized deltas, drains files, isolates failures and keeps official SSE alive at zero plugins",
  { timeout: 15_000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), "codexhost-hot-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const backend = await createDshWebBackend({ workspaceRoot: root, threadWorkspace: () => root });
    t.after(() => backend.close());
    const runtime = await backend.loadPlugins({
      packages: [],
      builtins: [],
      address: () => ({ host: "127.0.0.1", port: 0 }),
      reserved: [{ kind: "prefix", path: "/plugins" }],
    });
    const server = createServer((req, res) => {
      void (async () => {
        if (req.url === "/plugins/events") return runtime.events(req, res);
        if (!(await runtime.handle(req, res))) res.writeHead(404).end();
      })().catch(() => res.writeHead(500).end());
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => {
      server.closeAllConnections();
      server.close();
    });
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const open = async () => {
      const response = await new Promise<IncomingMessage>((resolve) =>
        get(`${url}/plugins/events`, resolve),
      );
      t.after(() => response.destroy());
      assert.equal(response.headers["content-type"], "text/event-stream");
      const frames: { type: string; id?: string; graph?: { entries: { id: string }[] } }[] = [];
      let buffer = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        buffer += chunk;
        let end: number;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (line.startsWith("data: ")) frames.push(JSON.parse(line.slice(6)));
        }
      });
      await until(() => frames.length > 0);
      return { frames, response };
    };
    const first = await open();
    const second = await open();
    assert.deepEqual(first.frames[0]?.graph?.entries, []);
    const store = new WebUiExtensions(new DataDir(join(root, "data")), {
      validate: () => {},
      apply: (packages, changedId) => runtime.update(packages, changedId),
      installPackage: async (stage, spec) => {
        const name = spec.split("@")[0];
        assert.ok(name);
        const directory = join(stage, "node_modules", name);
        mkdirSync(directory, { recursive: true });
        writeFileSync(
          join(stage, "package.json"),
          JSON.stringify({ dependencies: { [name]: "1.0.0" } }),
        );
        writeFileSync(
          join(directory, "package.json"),
          JSON.stringify({
            name,
            version: "1.0.0",
            type: "module",
            exports: { ".": "./index.js", "./client": "./client.js" },
            dsh: { client: { platform: "web", inject: [] } },
          }),
        );
        writeFileSync(
          join(directory, "client.js"),
          `window.__ModuleLoader__.load({id:${JSON.stringify(name)},factory:()=>({apply(){}})});`,
        );
        writeFileSync(join(directory, "resource.txt"), "read during release");
        writeFileSync(
          join(directory, "index.js"),
          `
        import {readFileSync,appendFileSync} from 'node:fs';
        export const inject = ${JSON.stringify(name === "missing" ? ["absentService"] : name === "consumer" ? ["webServer", "probeService"] : ["webServer"])};
        export function apply(ctx) {
          ${name === "provider" ? "ctx.provide('probeService', true);" : ""}
          const identity = Math.random().toString();
          appendFileSync(${JSON.stringify(join(root, "activated"))}, ${JSON.stringify(name + "\n")});
          ctx.effect(() => async () => {
            await new Promise(resolve => setTimeout(resolve, 50));
            await import('@deepseek-ai/cordis');
            const value = readFileSync(new URL('./resource.txt',import.meta.url),'utf8');
            appendFileSync(${JSON.stringify(join(root, "released"))}, ${JSON.stringify(name + ":")} + value + '\\n');
          });
          ctx.effect(() => ctx.webServer.register({kind:'exact',path:${JSON.stringify(name === "reserved" ? "/plugins/events" : "/" + name)},handler(_req,res){res.end(identity)}}));
          ${name === "broken" ? "throw new Error('activation probe');" : ""}
        }
      `,
        );
      },
    });
    for (const name of ["alpha", "beta", "broken", "missing", "reserved", "provider", "consumer"])
      await store.install(`${name}@1.0.0`);
    assert.equal(existsSync(join(root, "activated")), false, "installation executes no entry");
    assert.deepEqual((await store.setEnabled("alpha", true)).loadedIds, ["alpha"]);
    const identity = await (await fetch(`${url}/alpha`)).text();
    await until(
      () => second.frames.at(-1)?.graph?.entries.some((row) => row.id === "alpha") === true,
    );
    assert.equal(
      (await fetch(`${url}/alpha`)).status,
      200,
      "route is ready when management completes",
    );
    await store.setEnabled("beta", true);
    assert.equal(await (await fetch(`${url}/alpha`)).text(), identity);
    for (const name of ["broken", "missing", "reserved"]) {
      const state = await store.setEnabled(name, true);
      assert.ok(state.extensions.find((row) => row.id === name)?.loadError);
      assert.equal(state.loadedIds.includes(name), false);
      assert.equal((await fetch(`${url}/${name}`)).status, 404);
      if (name === "broken") {
        await store.setEnabled("beta", false);
        const unchanged = await store.setEnabled("beta", true);
        assert.match(
          unchanged.extensions.find((row) => row.id === name)?.loadError ?? "",
          /activation probe/,
        );
        assert.equal(
          readFileSync(join(root, "activated"), "utf8")
            .split("\n")
            .filter((row) => row === "broken").length,
          1,
          "unrelated operations do not retry a failed selection",
        );
      }
      await store.setEnabled(name, false);
    }
    assert.match(readFileSync(join(root, "released"), "utf8"), /broken:read during release/);
    assert.equal(
      await (await fetch(`${url}/alpha`)).text(),
      identity,
      "unaffected instance survives failures",
    );
    assert.equal(backend.handles("terminal/attach"), true);
    assert.equal(backend.handles("workspaceFiles/list"), true);
    await store.setEnabled("provider", true);
    await store.setEnabled("consumer", true);
    assert.equal((await fetch(`${url}/consumer`)).status, 200);
    const waiting = await store.setEnabled("provider", false);
    assert.equal(waiting.loadedIds.includes("consumer"), false);
    assert.match(
      waiting.extensions.find((row) => row.id === "consumer")?.loadError ?? "",
      /probeService/,
    );
    assert.equal((await fetch(`${url}/consumer`)).status, 404);
    const resumed = await store.setEnabled("provider", true);
    assert.equal(resumed.loadedIds.includes("consumer"), true);
    assert.equal((await fetch(`${url}/consumer`)).status, 200);
    assert.equal(await (await fetch(`${url}/alpha`)).text(), identity);
    await store.setEnabled("consumer", false);
    await store.setEnabled("provider", false);
    const alpha = store.plugins().find((row) => row.id === "alpha");
    assert.ok(alpha);
    writeFileSync(join(alpha.directory, "client.js"), "// rebuilt\nwindow.__probe = true;");
    await until(() =>
      first.frames.some((frame) => frame.type === "rebuilt" && frame.id === "alpha"),
    );
    assert.equal(
      await (await fetch(`${url}/alpha`)).text(),
      identity,
      "client rebuild does not reload Host entry",
    );
    await Promise.all([
      store.setEnabled("beta", false),
      store.setEnabled("beta", true),
      store.remove("beta"),
    ]);
    assert.equal((await fetch(`${url}/beta`)).status, 404);
    const removing = store.remove("alpha");
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(existsSync(alpha.directory), true, "files survive asynchronous disposer");
    await removing;
    assert.equal(existsSync(alpha.directory), false);
    assert.equal((await fetch(`${url}/alpha`)).status, 404);
    await until(() => second.frames.at(-1)?.graph?.entries.length === 0);
    first.response.destroy();
    const reconnected = await open();
    assert.deepEqual(reconnected.frames[0]?.graph?.entries, []);
    assert.deepEqual(store.state().loadedIds, []);
    assert.match(readFileSync(join(root, "released"), "utf8"), /alpha:read during release/);
  },
);
