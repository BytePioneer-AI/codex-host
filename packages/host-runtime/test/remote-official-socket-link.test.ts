import type { ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmod, lstat, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import path from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createRemoteOfficialAppServerListener } from "../src/remote-official-app-server.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  // Keep Unix socket paths below macOS's sockaddr_un limit.
  const root = await mkdtemp("/tmp/ch-link-");
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, "target");
  const socketPath = path.join(root, "official");
  const servers: Server[] = [];
  cleanups.push(async () => {
    for (const server of servers) {
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  const bind = async () => {
    const server = createServer();
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(target, resolve);
    });
    await chmod(target, 0o600);
    return server;
  };
  const child = Object.assign(new EventEmitter(), {
    stderr: new PassThrough(),
    kill: vi.fn(() => {
      queueMicrotask(() => child.emit("exit", null, "SIGTERM"));
      return true;
    }),
  });
  const listener = createRemoteOfficialAppServerListener({
    stockCodexPath: "/synthetic/codex",
    arguments: ["app-server", "--listen", `unix://${socketPath}`],
    socketPath,
    environment: {},
    diagnosticOutput: new PassThrough(),
    spawnOfficial: (() => child as unknown as ChildProcess) as typeof spawn,
  });
  cleanups.push(() => listener.close());
  return { root, target, socketPath, bind, listener, child };
}

describe.skipIf(process.platform === "win32")("official Unix socket links", () => {
  it("accepts a private socket link and removes only the link on shutdown", async () => {
    const f = await fixture();
    await f.bind();
    await symlink(f.target, f.socketPath);
    await f.listener.listen();
    await f.listener.close();
    await expect(lstat(f.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await lstat(f.target)).isSocket()).toBe(true);
  });

  it("waits for a dangling link's target to become a socket", async () => {
    const f = await fixture();
    await f.bind();
    const staged = path.join(f.root, "staged");
    await rename(f.target, staged);
    await symlink(f.target, f.socketPath);
    const listening = f.listener.listen();
    const result = expect(listening).resolves.toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(f.child.kill).not.toHaveBeenCalled();
    await rename(staged, f.target);
    await result;
  });

  it("cleans up an owned link after the backend has removed its target", async () => {
    const f = await fixture();
    const server = await f.bind();
    await symlink(f.target, f.socketPath);
    await f.listener.listen();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await f.listener.close();
    await expect(lstat(f.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes a dangling link when the backend exits before readiness", async () => {
    const f = await fixture();
    await symlink(f.target, f.socketPath);
    const failure = expect(f.listener.listen()).rejects.toThrow(
      "exited before its socket was ready",
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    f.child.emit("exit", 1, null);
    await failure;
    await expect(lstat(f.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes a dangling link after startup times out and the backend stops", async () => {
    const f = await fixture();
    await symlink(f.target, f.socketPath);
    await expect(f.listener.listen()).rejects.toThrow("socket was not ready after 10000ms");
    await expect(f.listener.closed).resolves.toMatchObject({ signal: "SIGTERM" });
    await expect(lstat(f.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  }, 15_000);

  it("preserves a dangling link owned by another user", async () => {
    const f = await fixture();
    await symlink(f.target, f.socketPath);
    const uid = process.getuid?.();
    if (uid === undefined) throw new Error("Unix uid is unavailable");
    vi.spyOn(process, "getuid").mockReturnValue(uid + 1);
    const failure = expect(f.listener.listen()).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 50));
    f.child.emit("exit", 1, null);
    await failure;
    expect((await lstat(f.socketPath)).isSymbolicLink()).toBe(true);
  });

  it("preserves a replacement link when startup fails", async () => {
    const f = await fixture();
    await symlink(f.target, f.socketPath);
    const failure = expect(f.listener.listen()).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await rename(f.socketPath, path.join(f.root, "original"));
    await symlink(f.target, f.socketPath);
    f.child.emit("exit", 1, null);
    await failure;
    expect((await lstat(f.socketPath)).isSymbolicLink()).toBe(true);
  });

  it("preserves a replacement link at the same path", async () => {
    const f = await fixture();
    await f.bind();
    await symlink(f.target, f.socketPath);
    await f.listener.listen();
    await rename(f.socketPath, path.join(f.root, "original"));
    await symlink(f.target, f.socketPath);
    await f.listener.close();
    expect((await lstat(f.socketPath)).isSymbolicLink()).toBe(true);
  });

  it.each(["file", "shared socket", "foreign owner"])("rejects a link to %s", async (kind) => {
    const f = await fixture();
    if (kind === "file") await writeFile(f.target, "not a socket");
    else await f.bind();
    await symlink(f.target, f.socketPath);
    if (kind === "shared socket") await chmod(f.target, 0o660);
    if (kind === "foreign owner") {
      const uid = process.getuid?.();
      if (uid === undefined) throw new Error("Unix uid is unavailable");
      vi.spyOn(process, "getuid").mockReturnValue(uid + 1);
    }
    await expect(f.listener.listen()).rejects.toThrow();
    expect(f.child.kill).toHaveBeenCalled();
    expect((await lstat(f.socketPath)).isSymbolicLink()).toBe(true);
  });

  it("continues to accept and clean up a direct socket", async () => {
    const f = await fixture();
    await f.bind();
    await rename(f.target, f.socketPath);
    await f.listener.listen();
    await f.listener.close();
    await expect(lstat(f.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
