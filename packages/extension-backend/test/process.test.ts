import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";

// Ignored IPC is intentional: the grandchild keeps a heartbeat until its process tree is reaped.
const plugin = `
import { spawn } from 'node:child_process';
export function activate(ctx) {
  spawn(process.execPath, ['--eval', \"setInterval(() => require('node:fs').appendFileSync(process.argv[1], '.'), 25)\", ctx.dataDir + '/heartbeat'], { stdio: 'ignore' });
  return () => ctx.writeSettings({ disposed: true });
}`;
const runnerPackage = new URL("../dist/index.js", import.meta.url).href;

const exitModes =
  process.platform === "win32" ? ["stop", "exit"] : ["stop", "exit", "SIGINT", "SIGTERM"];
it.each(exitModes)("reaps the backend process tree on %s", async (mode) => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "extension-tree-")));
  const entry = path.join(directory, "backend.mjs");
  await writeFile(entry, plugin);
  const { dev, ino } = await stat(directory, { bigint: true });
  const runner = spawn(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
    import { ExtensionBackendProcess } from ${JSON.stringify(runnerPackage)};
    import { writeFile } from 'node:fs/promises';
    const marker = ${JSON.stringify(path.join(directory, "disposed"))};
    const backend = new ExtensionBackendProcess({
      readSettings: async () => ({}),
      writeSettings: async (values) => { await writeFile(marker, JSON.stringify(values)); return values; },
    });
    await backend.activate(${JSON.stringify({
      extensionId: "sample",
      extensionDir: directory,
      dataDir: directory,
      url: pathToFileURL(entry).href,
      hash: createHash("sha256").update(plugin).digest("hex"),
      installation: `${dev}:${ino}`,
    })});
    const stop = async () => { await backend.stop(); process.exit(0); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    process.once('message', ${JSON.stringify(mode)} === 'exit' ? () => process.exit(0) : stop);
  `,
    ],
    { stdio: ["ignore", "ignore", "inherit", "ipc"] },
  );
  const closed = new Promise<number | null>((resolve) => runner.once("close", resolve));
  const heartbeat = () => readFile(path.join(directory, "heartbeat"), "utf8").catch(() => "");
  try {
    await expect.poll(async () => (await heartbeat()).length).toBeGreaterThan(1);
    if (mode === "SIGINT" || mode === "SIGTERM") runner.kill(mode);
    else runner.send(mode);
    await expect(closed).resolves.toBe(0);
    // A write already in progress may finish just after the kill; sample once it has settled.
    const wait = () => new Promise((resolve) => setTimeout(resolve, 150));
    await wait();
    const stopped = await heartbeat();
    await wait();
    expect(await heartbeat()).toBe(stopped);
    if (mode !== "exit")
      expect(await readFile(path.join(directory, "disposed"), "utf8")).toBe('{"disposed":true}');
  } finally {
    if (runner.connected) runner.send(mode);
    await closed;
    await rm(directory, { recursive: true, force: true });
  }
});
