import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { requestLauncherUpdate } from "../src/launcher-update.js";
import { startUpdater } from "../src/updater-ready.js";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "launcher-update-"));
  roots.push(root);
  const requestPath = path.join(root, "request-v1.json");
  const request = {
    wait_pid: process.pid + 1,
    wait_executable: "C:\\安装\\bin\\codexhost.exe",
    wait_started_at_micros: "12345678901234567",
    installation: { kind: "npm", prefix: "C:\\原 prefix" },
  };
  await writeFile(requestPath, JSON.stringify(request));
  const identity = vi.fn(async () => ({
    pid: 42,
    executable: request.wait_executable,
    startedAtMicros: request.wait_started_at_micros,
  }));
  return { requestPath, request, identity };
}
test("publishes Launcher intent without changing owner, material or existing status", async () => {
  const f = await fixture();
  await requestLauncherUpdate(f.requestPath, f.request, f.identity);
  expect(JSON.parse(await readFile(f.requestPath, "utf8"))).toEqual({
    ...f.request,
    launch_via_launcher: true,
  });
  expect(f.identity).toHaveBeenCalledWith(f.request.wait_pid);
});
test("production Windows Desktop routing never spawns from the Host or claims a handoff PID", async () => {
  const f = await fixture();
  const spawnUpdater = vi.fn(() => {
    throw new Error("Host cannot spawn");
  });
  const readStatus = vi.fn(async () => null);
  expect(
    await startUpdater({
      platform: "win32",
      prepared: { requestPath: f.requestPath, helperPath: "unused" },
      owner: f.request,
      spawnUpdater,
      readStatus,
      readIdentity: f.identity,
    }),
  ).toBeUndefined();
  expect(spawnUpdater).not.toHaveBeenCalled();
  expect(readStatus).not.toHaveBeenCalled();
  expect(JSON.parse(await readFile(f.requestPath, "utf8"))).toHaveProperty(
    "launch_via_launcher",
    true,
  );
});

test.each(["win32", "darwin", "linux"] as const)(
  "%s direct owner keeps real child ready handoff",
  async (platform) => {
    const f = await fixture();
    let child: ChildProcess | undefined;
    try {
      const pid = await startUpdater({
        platform,
        prepared: { helperPath: process.execPath, requestPath: f.requestPath },
        owner: { ...f.request, wait_pid: platform === "win32" ? process.pid : 42 },
        spawnUpdater: () => {
          child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
          return child;
        },
        readIdentity: () => {
          throw new Error("not a delegated owner");
        },
        readStatus: async () => ({
          schemaVersion: 1,
          version: "1.2.4",
          installation: "npm",
          phase: "waiting-for-exit",
          updatedAt: 1,
        }),
      });
      expect(pid).toBe(child?.pid);
      expect(JSON.parse(await readFile(f.requestPath, "utf8"))).not.toHaveProperty(
        "launch_via_launcher",
      );
    } finally {
      if (child) {
        const exit = once(child, "exit");
        child.kill();
        await exit;
      }
    }
  },
);

test("PID reuse cannot publish a start request", async () => {
  const f = await fixture();
  f.identity.mockResolvedValue({
    pid: 42,
    executable: f.request.wait_executable,
    startedAtMicros: "12345678901234568",
  });
  await expect(requestLauncherUpdate(f.requestPath, f.request, f.identity)).rejects.toThrow(
    "identity changed",
  );
  expect(JSON.parse(await readFile(f.requestPath, "utf8"))).toEqual(f.request);
});
test("a replaced prepared owner cannot be delegated", async () => {
  const f = await fixture();
  await writeFile(
    f.requestPath,
    JSON.stringify({ ...f.request, wait_pid: f.request.wait_pid + 1 }),
  );
  await expect(requestLauncherUpdate(f.requestPath, f.request, f.identity)).rejects.toThrow(
    "owner changed",
  );
  expect(JSON.parse(await readFile(f.requestPath, "utf8"))).not.toHaveProperty(
    "launch_via_launcher",
  );
});
