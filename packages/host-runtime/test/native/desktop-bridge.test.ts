import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { it } from "node:test";
import { build } from "esbuild";
import { discoverHostClientChannel, HostClientChannel } from "@codexhost/desktop-control";

const exec = promisify(execFile);
const repository = path.resolve(import.meta.dirname, "../../../..");
const launcher = path.join(
  repository,
  "target/debug",
  process.platform === "win32" ? "codexhost.exe" : "codexhost",
);
const runtime = path.join(repository, "packages/host-runtime/dist/main.js");

it(
  "actual Desktop stdio bridge retains native flags and a native Turn after Desktop exits",
  { timeout: 60_000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "codexhost-desktop-bridge-"));
    const data = path.join(root, "data"),
      codexHome = path.join(root, "codex"),
      plugins = path.join(root, "plugins");
    await mkdir(plugins);
    await mkdir(codexHome);
    await writeFile(
      path.join(plugins, "enabled.json"),
      JSON.stringify({ version: 1, enabled: [] }),
    );
    const nativeFixture = path.join(root, "native-codex.mjs");
    const stockCodex = path.join(
      root,
      process.platform === "win32" ? "fixture-codex.exe" : "fixture-codex",
    );
    await exec(
      "rustc",
      [
        path.join(repository, "packages/host-runtime/test/fixtures/shared-host-native-cli.rs"),
        "--edition=2024",
        "-o",
        stockCodex,
      ],
      { timeout: 30_000 },
    );
    await build({
      entryPoints: [
        path.join(repository, "packages/host-runtime/test/fixtures/shared-host-native-codex.ts"),
      ],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile: nativeFixture,
      banner: {
        js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
      },
      logLevel: "silent",
    });
    const env = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) =>
            !key.toUpperCase().startsWith("CODEXHOST_") &&
            !["NODE_OPTIONS", "NODE_PATH", "NODE_USE_ENV_PROXY"].includes(key.toUpperCase()),
        ),
      ),
      HOME: root,
      USERPROFILE: root,
      LOCALAPPDATA: path.join(root, "local-app-data"),
      NATIVE_FIXTURE_NODE: process.execPath,
    };
    const args = [
      "--node",
      process.execPath,
      "--host-runtime",
      runtime,
      "--data",
      data,
      "--plugins",
      plugins,
      "--codex-home",
      codexHome,
      "--stock-codex",
      stockCodex,
    ];
    const viewers: ReturnType<typeof spawn>[] = [];
    t.after(async () => {
      for (const viewer of viewers) viewer.kill();
      await exec(launcher, ["host", "stop", ...args], { env, timeout: 15_000 });
      const end = Date.now() + 10_000;
      while (await discoverHostClientChannel(path.join(data, "client-hosts"))) {
        assert.ok(Date.now() < end, "service did not stop");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      // Diagnostics remain inside this isolated fixture; assertion failures can
      // report them before cleanup without retaining credentials or descriptors.
      await rm(root, { recursive: true, force: true });
    });
    // Web starts the owner first, without starting stock Codex or a Desktop.
    await exec(launcher, ["host", "ensure", ...args], { env, timeout: 45_000 });
    await assert.rejects(readFile(path.join(codexHome, "native-calls.jsonl")), { code: "ENOENT" });
    const endpoint = await discoverHostClientChannel(path.join(data, "client-hosts"));
    assert.ok(endpoint);
    const ownerPid = endpoint.pid;
    const web = new HostClientChannel(path.join(data, "client-hosts"), endpoint);
    t.after(() => web.close());
    await web.start();

    async function desktop() {
      const child = spawn(
        process.execPath,
        [runtime, "-c", "features.fixture=true", "app-server"],
        {
          env: {
            ...env,
            CODEX_HOME: codexHome,
            CODEXHOST_DATA_DIR: data,
            CODEXHOST_LAUNCHER_EXECUTABLE: launcher,
            CODEXHOST_HOST_RUNTIME_PATH: runtime,
            CODEXHOST_STOCK_CODEX_PATH: stockCodex,
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      viewers.push(child);
      const messages: Array<{ id?: number; result?: Record<string, unknown>; error?: unknown }> =
        [];
      const changed = new Set<() => void>();
      let buffer = "",
        nextId = 0;
      child.stdout.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        let end: number;
        while ((end = buffer.indexOf("\n")) >= 0) {
          messages.push(JSON.parse(buffer.slice(0, end)));
          buffer = buffer.slice(end + 1);
        }
        for (const notify of changed) notify();
      });
      child.stderr.resume();
      const request = async (method: string, params: Record<string, unknown> = {}) => {
        const id = ++nextId;
        child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
        return await new Promise<Record<string, unknown>>((resolve, reject) => {
          const timer = setTimeout(() => {
            changed.delete(check);
            reject(new Error(`Desktop ${method} timed out`));
          }, 10_000);
          const check = () => {
            const reply = messages.find((message) => message.id === id);
            if (!reply) return;
            clearTimeout(timer);
            changed.delete(check);
            if (reply.error) {
              void readFile(path.join(data, "logs", `host-runtime-${ownerPid}.log`), "utf8").then(
                (log) =>
                  reject(
                    new Error(`Desktop ${method} rejected: ${JSON.stringify(reply.error)}\n${log}`),
                  ),
                reject,
              );
            } else if (reply.result) resolve(reply.result);
            else reject(new Error("Desktop response has no result"));
          };
          changed.add(check);
          check();
        });
      };
      await request("initialize", {
        clientInfo: { name: "fixture-desktop", version: "1" },
        capabilities: { experimentalApi: true },
      });
      return { child, request };
    }
    const first = await desktop();
    const created = await first.request("thread/start", { cwd: root });
    const id = (created.thread as { id: string }).id;
    await first.request("turn/start", {
      threadId: id,
      input: [{ type: "text", text: "native fixture only" }],
    });
    const exited = once(first.child, "exit");
    first.child.stdin.end();
    assert.deepEqual(await exited, [0, null]);
    const until = Date.now() + 10_000;
    while (
      !(await readFile(path.join(codexHome, "native-calls.jsonl"), "utf8")).includes(
        "turn/completed",
      )
    ) {
      assert.ok(Date.now() < until, "native Turn did not finish after viewer exit");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const second = await desktop();
    assert.match(
      JSON.stringify(await second.request("thread/read", { threadId: id, includeTurns: true })),
      /native turn survived Desktop exit/u,
    );
    const log = (await readFile(path.join(codexHome, "native-calls.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; feature?: boolean });
    assert.equal(log.filter((entry) => entry.type === "startup").length, 1);
    assert.equal(log.find((entry) => entry.type === "startup")?.feature, true);
    assert.equal(log.filter((entry) => entry.type === "turn/start").length, 1);
    assert.equal(
      (await discoverHostClientChannel(path.join(data, "client-hosts")))?.pid,
      endpoint.pid,
    );
    // Independent lifecycle does not broaden Web into the official Codex path.
    await assert.rejects(web.snapshot(id), /external|owned/u);
    const secondExited = once(second.child, "exit");
    second.child.stdin.end();
    assert.deepEqual(await secondExited, [0, null]);
  },
);
