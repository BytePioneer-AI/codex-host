import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { it } from "node:test";
import { HostClientChannel, discoverHostClientChannel } from "@codexhost/desktop-control";
import { snapshotPackagedHost } from "../../src/packaged-host.ts";

const exec = promisify(execFile);
const repository = resolve(import.meta.dirname, "../../../..");
const binary = process.platform === "win32" ? "codexhost.exe" : "codexhost";
const launcher = join(repository, "target/debug", binary);
const service = pathToFileURL(
  join(repository, "packages/host-runtime/dist/shared-host-service.js"),
).href;

async function until(check: () => Promise<boolean>) {
  const end = Date.now() + 15_000;
  while (!(await check())) {
    assert.ok(Date.now() < end, "condition did not settle");
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
}

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "codexhost-restart-"));
  const data = join(root, "data");
  const plugins = join(root, "plugins");
  await mkdir(plugins);
  await writeFile(join(plugins, "enabled.json"), '{"version":1,"enabled":[]}');
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
    LOCALAPPDATA: join(root, "local-app-data"),
  };
  const args = (runtime: string, bundledPlugins = plugins) => [
    "--node",
    process.execPath,
    "--host-runtime",
    runtime,
    "--data",
    data,
    "--plugins",
    bundledPlugins,
    "--codex-home",
    join(root, "codex"),
    "--stock-codex",
    process.execPath,
  ];
  const control = join(root, "control.mjs");
  await writeFile(
    control,
    `import { runSharedHostService } from ${JSON.stringify(service)};
    process.exitCode = await runSharedHostService(process.argv.slice(3), process.env, import.meta.url);`,
  );
  const clients: HostClientChannel[] = [];
  t.after(async () => {
    for (const client of clients) client.close();
    await exec(launcher, ["host", "stop", ...args(control)], { env, timeout: 20_000 });
    await rm(root, { recursive: true, force: true });
  });
  const connect = async () => {
    const directory = join(data, "client-hosts");
    const endpoint = await discoverHostClientChannel(directory);
    assert.ok(endpoint);
    const client = new HostClientChannel(directory, endpoint);
    clients.push(client);
    await client.start();
    return client;
  };
  return { root, data, plugins, env, args, control, connect };
}

it(
  "restart activates the requested build while old Web callers concurrently ensure",
  { timeout: 90_000 },
  async (t) => {
    const { root, data, env, args, control } = await fixture(t);
    const next = join(root, "current-build.mjs");
    const stopped = join(root, "stopped"),
      resume = join(root, "resume");
    await writeFile(
      next,
      `import { runSharedHostService } from ${JSON.stringify(service)};
    import { writeFile, access } from 'node:fs/promises';
    if (process.argv.includes('--stop')) {
      await runSharedHostService(process.argv.slice(3), process.env, import.meta.url);
      await writeFile(${JSON.stringify(stopped)}, 'ready');
      while (!(await access(${JSON.stringify(resume)}).then(() => true, () => false)))
        await new Promise(resolve => setTimeout(resolve, 20));
    } else process.exitCode = await runSharedHostService(process.argv.slice(3), process.env, import.meta.url);`,
    );
    await exec(launcher, ["host", "ensure", ...args(control)], { env, timeout: 45_000 });
    const old = await discoverHostClientChannel(join(data, "client-hosts"));
    assert.ok(old);
    // Invalid build inputs must fail before disturbing the existing owner.
    await assert.rejects(
      exec(launcher, ["host", "restart", ...args(join(root, "missing.mjs"))], { env }),
    );
    assert.equal((await discoverHostClientChannel(join(data, "client-hosts")))?.pid, old.pid);
    const restarting = exec(launcher, ["host", "restart", ...args(next)], { env, timeout: 60_000 });
    void restarting.catch(() => undefined);
    await until(async () => (await readFile(stopped, "utf8").catch(() => "")) === "ready");
    await until(async () => !(await discoverHostClientChannel(join(data, "client-hosts"))));
    const competitors = Array.from({ length: 3 }, () =>
      exec(launcher, ["host", "ensure", ...args(control)], { env, timeout: 60_000 }),
    );
    for (const competitor of competitors) void competitor.catch(() => undefined);
    try {
      // Give the competing native callers time to reach the locked lifecycle operation.
      await new Promise((resolveWait) => setTimeout(resolveWait, 500));
      assert.equal(await discoverHostClientChannel(join(data, "client-hosts")), null);
    } finally {
      await writeFile(resume, "ready");
      await Promise.all([restarting, ...competitors]);
    }
    const owner = JSON.parse(await readFile(join(data, "shared-host-ready.json"), "utf8"));
    assert.notEqual(owner.pid, old.pid);
    assert.equal(owner.runtime, next);
    assert.equal((await discoverHostClientChannel(join(data, "client-hosts")))?.pid, owner.pid);
    // A second explicit restart of the same path must still create a new process.
    await exec(launcher, ["host", "restart", ...args(next)], { env, timeout: 60_000 });
    const restarted = JSON.parse(await readFile(join(data, "shared-host-ready.json"), "utf8"));
    assert.notEqual(restarted.pid, owner.pid);
    assert.equal(restarted.runtime, next);
  },
);

it(
  "a bundled Host can inspect lazy plugin resources after Web output is removed",
  { timeout: 60_000 },
  async (t) => {
    const { root, data, env, args, control, connect } = await fixture(t);
    const distribution = join(root, "web-output");
    for (const directory of ["app", "native", "adapters/probe"])
      await mkdir(join(distribution, directory), { recursive: true });
    await cp(control, join(distribution, "app/host-runtime.mjs"));
    await cp(launcher, join(distribution, "native", binary));
    await writeFile(
      join(distribution, "adapters/enabled.json"),
      '{"version":1,"enabled":["probe"]}',
    );
    await writeFile(
      join(distribution, "adapters/probe/manifest.json"),
      JSON.stringify({
        manifestVersion: 1,
        adapterApiVersion: 1,
        id: "probe",
        name: "Probe",
        version: "0.0.0",
        entry: "./plugin.mjs",
      }),
    );
    await writeFile(
      join(distribution, "adapters/probe/resource.mjs"),
      'export default "original build";',
    );
    await writeFile(
      join(distribution, "adapters/probe/plugin.mjs"),
      `
    export function createHarnessAdapter() { return {
      harnessId: 'probe',
      async inspect() { return { status: 'ready', catalog: {
        models: [{ ref: { id: 'probe' }, label: process.cwd() + ':' + (await import('./resource.mjs')).default }],
        defaultModel: { id: 'probe' }, thinkingOptions: []
      }, capabilities: { configuration: { selectModel: true, selectThinkingOption: false, selectPermissionMode: false, permissionModeScope: 'live' }, history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false } } }; },
      async open() { throw new Error('inspection-only fixture'); },
      async close() {}
    }; }`,
    );
    const snapshot = await snapshotPackagedHost(distribution, data);
    await exec(
      join(snapshot, "native", binary),
      [
        "host",
        "ensure",
        ...args(join(snapshot, "app/host-runtime.mjs"), join(snapshot, "adapters")),
      ],
      { env, cwd: distribution, timeout: 45_000 },
    );
    const first = await discoverHostClientChannel(join(data, "client-hosts"));
    assert.ok(first);
    await rm(distribution, { recursive: true });
    await mkdir(distribution);
    const client = await connect();
    const inspection = await client.request<{
      status: string;
      catalog: { models: Array<{ label: string }> };
    }>("codexhost/harness/inspect", { harnessId: "probe", refresh: true });
    assert.equal(inspection.status, "ready", JSON.stringify(inspection));
    assert.equal(inspection.catalog.models[0]?.label, (await realpath(data)) + ":original build");
    assert.equal((await discoverHostClientChannel(join(data, "client-hosts")))?.pid, first.pid);
  },
);
