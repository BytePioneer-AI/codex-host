import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { it } from "node:test";
import { build } from "esbuild";
import { HostClientChannel, discoverHostClientChannel } from "@codexhost/desktop-control";
import { encodeHarnessPluginRoute, harnessIdSchema } from "@codexhost/shared-contracts";
import { connectLocalSharedHost } from "../../src/local-shared-host.js";

const exec = promisify(execFile);
const repository = path.resolve(import.meta.dirname, "../../../..");
const launcher = path.join(
  repository,
  "target/debug",
  process.platform === "win32" ? "codexhost.exe" : "codexhost",
);
const runtime = path.join(repository, "packages/host-runtime/dist/main.js");
async function until(check: () => Promise<boolean>) {
  const end = Date.now() + 10_000;
  while (!(await check())) {
    assert.ok(Date.now() < end, "condition did not settle");
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

for (const first of ["Web", "Desktop"])
  it(
    `${first}-first native startup is single-owner, survives client exit, and recovers without resending`,
    { timeout: 90_000 },
    async (t) => {
      const root = await mkdtemp(path.join(tmpdir(), "codexhost-independent-"));
      const data = path.join(root, "data"),
        plugins = path.join(root, "plugins"),
        codexHome = path.join(root, "codex");
      await mkdir(path.join(plugins, "fixture"), { recursive: true });
      await mkdir(codexHome, { recursive: true });
      await writeFile(
        path.join(plugins, "enabled.json"),
        JSON.stringify({ version: 1, enabled: ["fixture"] }),
      );
      await build({
        entryPoints: [
          path.join(repository, "packages/host-runtime/test/fixtures/shared-host-plugin.ts"),
        ],
        bundle: true,
        platform: "node",
        format: "esm",
        outfile: path.join(plugins, "fixture/plugin.mjs"),
        logLevel: "silent",
      });
      await writeFile(
        path.join(plugins, "fixture/manifest.json"),
        JSON.stringify({
          manifestVersion: 1,
          id: "fixture",
          name: "Fixture",
          version: "0.0.0",
          adapterApiVersion: 1,
          entry: "./plugin.mjs",
        }),
      );
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
        process.execPath,
      ];
      const clients: HostClientChannel[] = [];
      t.after(async () => {
        for (const client of clients) client.close();
        await exec(launcher, ["host", "stop", ...args], { env, timeout: 15_000 });
        await until(
          async () => !(await discoverHostClientChannel(path.join(data, "client-hosts"))),
        );
        await rm(root, { recursive: true, force: true });
      });
      let desktopThreadId: string | undefined;
      if (first === "Desktop") {
        // The actual Desktop bridge, in a separate short-lived viewer process.
        const bootstrap = path.join(root, "desktop.mjs");
        await writeFile(
          bootstrap,
          `import { connectLocalSharedHost } from ${JSON.stringify(pathToFileURL(path.join(repository, "packages/host-runtime/dist/local-shared-host.js")).href)};\nconst peer = await connectLocalSharedHost(JSON.parse(process.argv[2]));\nconst result = await peer.request("thread/start", ${JSON.stringify({ model: encodeHarnessPluginRoute({ harnessId: harnessIdSchema.parse("fixture") }), cwd: root })}); if (result.error) throw new Error(JSON.stringify(result.error)); console.log(result.result.thread.id); peer.close();\n`,
        );
        const result = await exec(
          process.execPath,
          [
            bootstrap,
            JSON.stringify({
              launcher,
              runtime,
              dataDirectory: data,
              bundledPlugins: plugins,
              codexHome,
              stockCodex: process.execPath,
            }),
          ],
          { env, timeout: 45_000 },
        );
        desktopThreadId = result.stdout.trim();
        assert.match(desktopThreadId, /^[0-9a-f-]{36}$/u);
      }
      // Independent frontends may race or join an owner whose first viewer exited.
      await Promise.all(
        [1, 2].map(() => exec(launcher, ["host", "ensure", ...args], { env, timeout: 45_000 })),
      );
      const endpoint = await discoverHostClientChannel(path.join(data, "client-hosts"));
      assert.ok(endpoint);
      assert.equal(endpoint.owner, "service");
      const connect = async () => {
        const descriptor = await discoverHostClientChannel(path.join(data, "client-hosts"));
        assert.ok(descriptor);
        const client = new HostClientChannel(path.join(data, "client-hosts"), descriptor);
        clients.push(client);
        await client.start();
        return client;
      };
      const web = await connect();
      const desktop = await connectLocalSharedHost({ launcher, runtime, dataDirectory: data });
      t.after(() => desktop.close());
      const id =
        desktopThreadId ??
        (
          await web.request<{ thread: { id: string } }>("thread/start", {
            model: encodeHarnessPluginRoute({ harnessId: harnessIdSchema.parse("fixture") }),
            cwd: root,
          })
        ).thread.id;
      await web.request("turn/start", {
        threadId: id,
        input: [{ type: "text", text: "continue without a UI" }],
        clientUserMessageId: "once",
      });
      assert.ok(
        (await desktop.request("thread/read", { threadId: id, includeTurns: false })).result,
      );
      // Disconnect both transports during execution. The process and Native Session survive.
      desktop.close();
      web.close();
      await until(async () => {
        const commands = await readFile(
          path.join(data, "fixture-native/commands.jsonl"),
          "utf8",
        ).catch(() => "");
        return commands.trim() !== "" && commands.trim().split("\n").length === 1;
      });
      const reopened = await connect();
      await until(async () =>
        JSON.stringify(await reopened.snapshot(id)).includes("completed without either viewer"),
      );
      assert.equal(
        (await discoverHostClientChannel(path.join(data, "client-hosts")))?.pid,
        endpoint.pid,
      );
      const descendant = JSON.parse(
        await readFile(path.join(data, "fixture-native/descendant.json"), "utf8"),
      ) as { pid: number };
      process.kill(descendant.pid, 0);
      const commandLog = await readFile(path.join(data, "fixture-native/commands.jsonl"), "utf8");
      assert.equal(commandLog.trim().split("\n").length, 1);
      // Native metadata is available even though no Desktop process has ever existed.
      await writeFile(
        path.join(codexHome, ".codex-global-state.json"),
        JSON.stringify({
          "local-projects": { p: { id: "p", name: "Existing Project", rootPaths: [root] } },
          "project-order": ["p"],
          "thread-project-assignments": { [id]: { projectKind: "local", projectId: "p" } },
          "pinned-thread-ids": [id],
          "projectless-thread-ids": [],
        }),
      );
      assert.deepEqual(await reopened.request("codexhost/workspace/read", {}), {
        projects: [{ id: "p", name: "Existing Project", rootPaths: [root] }],
        assignments: { [id]: "p" },
        projectless: [],
        pinned: [id],
      });
      for (const client of clients) client.close();
      // Kill only the verified fixture owner. Rust must retire its process tree before admitting a replacement.
      assert.equal(
        (await discoverHostClientChannel(path.join(data, "client-hosts")))?.epoch,
        endpoint.epoch,
      );
      process.kill(endpoint.pid, "SIGKILL");
      await exec(launcher, ["host", "ensure", ...args], { env, timeout: 45_000 });
      assert.throws(
        () => process.kill(descendant.pid, 0),
        "old Harness child must exit before the new owner is admitted",
      );
      const recovered = await connect();
      const newOwner = await discoverHostClientChannel(path.join(data, "client-hosts"));
      assert.ok(newOwner);
      assert.notEqual(newOwner.epoch, endpoint.epoch);
      const list = await recovered.request<{ data: Array<{ id: string }> }>("thread/list", {});
      assert.equal(list.data.filter((thread) => thread.id === id).length, 1);
      assert.ok(
        JSON.stringify(await recovered.snapshot(id)).includes("completed without either viewer"),
      );
      assert.equal(
        await readFile(path.join(data, "fixture-native/commands.jsonl"), "utf8"),
        commandLog,
        "recovery must not resend a completed or uncertain command",
      );
    },
  );
