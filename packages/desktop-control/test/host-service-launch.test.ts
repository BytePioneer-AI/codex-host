import { createServer } from "node:http";
import type * as ChildProcess from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import type { ClientChannelDescriptor } from "@codexhost/shared-contracts";

const native = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof ChildProcess>()),
  execFile: native,
}));
import { ensureHostService, isHostClientChannelOnline } from "../src/host-service-launch.js";

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
  native.mockReset();
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "codexhost-service-discovery-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const token = randomBytes(32).toString("hex"),
    epoch = randomUUID();
  const server = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/x-ndjson" });
    response.write(
      JSON.stringify({ type: "hello", version: 1, cursor: { epoch, sequence: 0 }, reset: true }) +
        "\n",
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  const descriptor: ClientChannelDescriptor = {
    version: 1,
    pid: process.pid,
    port: (server.address() as { port: number }).port,
    token,
    startedAt: Date.now(),
    epoch,
    owner: "service",
  };
  const directory = path.join(root, "client-hosts");
  await mkdir(directory);
  const save = (value: ClientChannelDescriptor) =>
    writeFile(path.join(directory, `host-${process.pid}.json`), JSON.stringify(value), {
      mode: 0o600,
    });
  const launch = {
    launcher: path.join(root, "launcher"),
    runtime: path.join(root, "host-runtime.mjs"),
    dataDirectory: root,
  };
  return { root, descriptor, save, launch };
}

it("joins a healthy authenticated service without spawning another owner", async () => {
  const f = await fixture();
  await f.save(f.descriptor);
  expect(await isHostClientChannelOnline(f.descriptor)).toBe(true);
  await ensureHostService(f.launch);
  expect(native).not.toHaveBeenCalled();
});

it("never takes over a healthy legacy Desktop owner", async () => {
  const f = await fixture();
  const legacy = { ...f.descriptor };
  delete legacy.owner;
  await f.save(legacy);
  await expect(ensureHostService(f.launch)).rejects.toThrow("Desktop-owned");
  expect(native).not.toHaveBeenCalled();
});

it("does not mistake a live PID or wrong epoch for a ready service", async () => {
  const f = await fixture();
  await f.save({ ...f.descriptor, epoch: randomUUID() });
  expect(await isHostClientChannelOnline({ ...f.descriptor, token: "0".repeat(64) })).toBe(false);
  native.mockImplementation((_file, _args, _options, callback) => callback(null, "", ""));
  await expect(ensureHostService(f.launch)).rejects.toThrow("ready authenticated endpoint");
  expect(native).toHaveBeenCalledOnce();
});

it("boots through the native Launcher with sanitized environment and checks the new endpoint", async () => {
  const f = await fixture();
  vi.stubEnv("CODEXHOST_RUNTIME_TOKEN", "fixture-poison");
  vi.stubEnv("NODE_OPTIONS", "--fixture-poison");
  vi.stubEnv("NODE_PATH", "/fixture-poison");
  native.mockImplementation((_file, _args, _options, callback) => {
    void f.save(f.descriptor).then(() => callback(null, "", ""), callback);
  });
  await ensureHostService(f.launch);
  expect(native).toHaveBeenCalledOnce();
  const [file, args, options] = native.mock.calls[0] as [
    string,
    string[],
    { env: NodeJS.ProcessEnv },
  ];
  expect(file).toBe(f.launch.launcher);
  expect(args).toEqual([
    "host",
    "ensure",
    "--node",
    process.execPath,
    "--host-runtime",
    f.launch.runtime,
    "--data",
    f.root,
  ]);
  expect(options.env.NODE_OPTIONS).toBeUndefined();
  expect(options.env.NODE_PATH).toBeUndefined();
  expect(Object.keys(options.env).some((key) => key.toUpperCase().startsWith("CODEXHOST_"))).toBe(
    false,
  );
  expect(options.env.PATH).toBe(process.env.PATH);
});
