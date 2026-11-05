import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";
import { promisify } from "node:util";
import { WebSocket, createWebSocketStream } from "ws";
import { discoverHostClientChannel } from "@codexhost/desktop-control";
import { StreamThreadPeer } from "../../src/shared-thread-peer.js";

const exec = promisify(execFile);
const repository = path.resolve(import.meta.dirname, "../../../..");
const executable = process.platform === "win32" ? "codexhost.exe" : "codexhost";

it("Desktop web/open starts Web independently of Host restart", { timeout: 180_000 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "codexhost-web-open-"));
  const installation = path.join(root, "installation");
  const app = path.join(installation, "app");
  const launcher = path.join(installation, "bin", executable);
  const node = path.join(
    installation,
    "runtime",
    process.platform === "win32" ? "node.exe" : "node",
  );
  const runtime = path.join(app, "host-runtime.mjs");
  const webRuntime = path.join(app, "web-server.mjs");
  const data = path.join(root, "data");
  const codexHome = path.join(root, "codex");
  const plugins = path.join(root, "plugins");
  await mkdir(path.join(data, "web"), { recursive: true });
  await mkdir(codexHome);
  await mkdir(plugins);
  await writeFile(path.join(plugins, "enabled.json"), JSON.stringify({ version: 1, enabled: [] }));
  await writeFile(
    path.join(data, "web/service.json"),
    JSON.stringify({ host: "127.0.0.1", port: 4478 }),
  );
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) =>
          !key.toUpperCase().startsWith("CODEXHOST_") &&
          !["NODE_OPTIONS", "NODE_PATH"].includes(key.toUpperCase()),
      ),
    ),
    HOME: root,
    USERPROFILE: root,
    LOCALAPPDATA: path.join(root, "local-app-data"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    CODEXHOST_DATA_DIR: data,
    CODEX_HOME: codexHome,
    CODEXHOST_CONSOLE_PORT: "4479",
    SSH_CONNECTION: "smoke",
  };
  await mkdir(path.dirname(launcher), { recursive: true });
  await mkdir(path.dirname(node), { recursive: true });
  await copyFile(path.join(repository, "target/debug", executable), launcher);
  await copyFile(process.execPath, node);
  await exec(
    process.execPath,
    ["packages/host-runtime/scripts/build-release.mjs", "--output", runtime],
    { cwd: repository, timeout: 30_000 },
  );
  await exec(
    process.execPath,
    [
      "--import",
      "tsx",
      "packages/web-server/scripts/build-release.ts",
      "--output",
      app,
      "--platform",
      process.platform,
      "--architecture",
      process.arch,
    ],
    { cwd: repository, timeout: 90_000, maxBuffer: 4 * 1024 * 1024 },
  );
  const { version } = JSON.parse(await readFile(path.join(repository, "package.json"), "utf8"));
  await writeFile(
    path.join(app, "codexhost-distribution.json"),
    JSON.stringify({
      schemaVersion: 1,
      version,
      distribution: "installer",
      target: `${process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux"}-${process.arch}`,
    }),
  );
  const args = [
    "--node",
    node,
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
  const run = (arguments_: string[]) => exec(launcher, arguments_, { env, timeout: 60_000 });
  t.after(async () => {
    await run([
      "web-service",
      "stop",
      "--node",
      process.execPath,
      "--host-node",
      process.execPath,
      "--host-runtime",
      runtime,
      "--web-runtime",
      webRuntime,
      "--data",
      data,
    ]);
    await run(["host", "stop", ...args]);
    await rm(root, { recursive: true, force: true });
  });
  await run(["host", "ensure", ...args]);
  await assert.rejects(readFile(path.join(data, "web-service-ready.json")), { code: "ENOENT" });
  const before = await discoverHostClientChannel(path.join(data, "client-hosts"));
  assert.ok(before);
  const socket = new WebSocket(`ws://127.0.0.1:${before.port}/v1/desktop`, {
    headers: { authorization: `Bearer ${before.token}` },
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const stream = createWebSocketStream(socket);
  const peer = new StreamThreadPeer(stream, stream, () => stream.destroy());
  t.after(() => peer.close());
  const reply = await peer.request("codexhost/web/open", {});
  assert.equal(
    reply.error,
    undefined,
    reply.error ? await readFile(path.join(data, "web-service-failure.txt"), "utf8") : undefined,
  );
  assert.deepEqual(reply.result, {});
  assert.equal((await discoverHostClientChannel(path.join(data, "client-hosts")))?.pid, before.pid);
  const web = JSON.parse(await readFile(path.join(data, "web-service-ready.json"), "utf8")) as {
    pid: number;
    web_pid: number;
    address: string;
    loginUrl: string;
  };
  assert.equal(web.address, "http://127.0.0.1:4478/");
  assert.equal(new URL(web.loginUrl).hash, "");
  const response = await fetch(`${web.loginUrl}#connect-devices`, { redirect: "manual" });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/");
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie);
  const page = () => fetch(web.address, { headers: { cookie } });
  assert.equal((await page()).status, 200);
  const reused = await peer.request("codexhost/web/open", {});
  assert.deepEqual(reused.result, {});
  const reusedWeb = JSON.parse(await readFile(path.join(data, "web-service-ready.json"), "utf8"));
  assert.equal(reusedWeb.web_pid, web.web_pid);
  assert.equal(reusedWeb.loginUrl, web.loginUrl);
  peer.close();
  await peer.closed;
  const restart = await run(["host", "restart", ...args]);
  const after = await discoverHostClientChannel(path.join(data, "client-hosts"));
  assert.ok(after);
  assert.notEqual(after.pid, before.pid);
  const retained = JSON.parse(await readFile(path.join(data, "web-service-ready.json"), "utf8"));
  assert.equal(retained.pid, web.pid);
  assert.equal(retained.web_pid, web.web_pid);
  process.kill(web.web_pid, 0);
  assert.equal((await page()).status, 200);
  t.diagnostic(
    `Host ${before.pid} -> ${after.pid}; Web PID ${web.web_pid} and supervisor ${web.pid} unchanged; HTTP 200; ${restart.stdout.trim()}`,
  );
});
