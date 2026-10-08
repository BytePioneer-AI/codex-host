import type * as ChildProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof ChildProcess>()),
  spawn,
}));
import { RuntimeMaintenance } from "../src/runtime-maintenance.js";
const directories: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.clearAllMocks();
  await Promise.all(directories.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function fixture(remote = false) {
  const root = await mkdtemp(path.join(tmpdir(), "codexhost-maintenance-"));
  directories.push(root);
  const pkg = path.join(root, "node_modules/@codexhost/cli-darwin-arm64");
  const runtimePath = path.join(pkg, "app/host-runtime.mjs");
  await Promise.all(
    ["app", "libexec", "../cli/bin"].map((dir) => mkdir(path.join(pkg, dir), { recursive: true })),
  );
  await writeFile(runtimePath, "// build one");
  await writeFile(path.join(pkg, "libexec/codexhost-updater"), "fixture");
  await writeFile(path.join(pkg, "../cli/bin/codexhost.js"), "fixture");
  const metadataPath = path.join(pkg, "app/codexhost-distribution.json");
  const metadata = (version: string) =>
    writeFile(
      metadataPath,
      JSON.stringify({ schemaVersion: 1, version, distribution: "npm", target: "macos-arm64" }),
    );
  await metadata("0.11.0");
  const control = new RuntimeMaintenance({
    runtimePath,
    remote,
    environment: {
      PATH: process.env.PATH ?? "",
      HOME: root,
      CODEXHOST_DATA_DIR: path.join(root, "data"),
    },
  });
  await control.status();
  return { control, root, runtimePath, metadata };
}
/** Stands in for the shell that starts the helper: echo $!, report status PID, then exit. */
function helperStartedBy(statusPath: string, targetVersion: string, updaterPid: number) {
  const starter = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
  };
  starter.stdout = new EventEmitter();
  queueMicrotask(() => {
    starter.stdout.emit("data", `${updaterPid}\n`);
    void writeFile(
      statusPath,
      JSON.stringify({ phase: "installing", targetVersion, error: null, updaterPid }),
    ).then(() => starter.emit("exit", 0));
  });
  return starter;
}
describe("runtime maintenance", () => {
  it("reads the workspace version for source launches without distribution metadata", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "codexhost-source-"));
    directories.push(root);
    const runtimePath = path.join(root, "packages/host-runtime/dist/main.js");
    await mkdir(path.dirname(runtimePath), { recursive: true });
    await writeFile(runtimePath, "// source build");
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "codexhost", version: "0.11.0" }),
    );
    const control = new RuntimeMaintenance({
      runtimePath,
      remote: false,
      environment: { CODEXHOST_DATA_DIR: path.join(root, "data") },
    });
    expect(await control.status()).toMatchObject({
      runningVersion: "0.11.0-dev",
      installedVersion: "0.11.0-dev",
      restartRequired: false,
      updateSupported: false,
    });
    for (const [version, remote, expected] of [
      ["0.12.0", false, "0.12.0"],
      ["0.12.0", true, "0.12.0"],
      ["0.13.0-rc.1+test", false, "0.13.0-rc.1+test"],
      ["latest", false, null],
    ] as const) {
      const configured = new RuntimeMaintenance({
        runtimePath,
        remote,
        environment: {
          CODEXHOST_DATA_DIR: path.join(root, "data"),
          CODEXHOST_DEV_VERSION: version,
        },
      });
      const status = await configured.status();
      expect(status.runningVersion).toBe(expected);
      expect(status.installedVersion).toBe(expected);
      expect(status.updateSupported).toBe(false);
    }
  });
  it("ignores source version overrides in packaged installations", async () => {
    const f = await fixture();
    f.control.options.environment.CODEXHOST_DEV_VERSION = "0.12.0";
    expect((await f.control.status()).runningVersion).toBe("0.11.0");
  });
  it("drops a recorded update failure once the target version is the one running", async () => {
    const failed = (targetVersion: string) => ({
      phase: "failed",
      targetVersion,
      error: "stopped",
    });
    for (const [targetVersion, phase] of [
      ["0.11.0", "succeeded"],
      ["0.10.0", "succeeded"],
      ["0.12.0", "failed"],
    ] as const) {
      const f = await fixture(true);
      await mkdir(path.join(f.root, "data"), { recursive: true });
      await writeFile(
        path.join(f.root, "data/remote-update.json"),
        JSON.stringify(failed(targetVersion)),
      );
      expect((await f.control.status()).update).toMatchObject({ phase, targetVersion });
    }
  });
  it("retains the actual running version when npm replaces installed files", async () => {
    const f = await fixture();
    await f.metadata("0.12.0");
    expect(await f.control.status()).toMatchObject({
      runningVersion: "0.11.0",
      installedVersion: "0.12.0",
      restartRequired: true,
      updateSupported: false,
    });
  });
  it("detects replaced builds even when the version number is unchanged", async () => {
    const f = await fixture();
    await writeFile(f.runtimePath, "// build two");
    expect(await f.control.status()).toMatchObject({
      runningVersion: "0.11.0",
      installedVersion: "0.11.0",
      restartRequired: true,
    });
    await expect(f.control.start("0.11.0")).rejects.toThrow("npm installation");
  });
  it.skipIf(process.platform === "win32")(
    "immediately launches a restart without checking active sessions",
    async () => {
      const f = await fixture(true);
      let finishActive: (() => void) | undefined;
      const activeOperation = f.control.operation(
        () =>
          new Promise<void>((resolve) => {
            finishActive = resolve;
          }),
      );
      await writeFile(f.runtimePath, "// build two");
      const statusPath = path.join(f.root, "data/remote-update.json");
      spawn.mockImplementation(() => helperStartedBy(statusPath, "0.11.0", process.pid));
      expect((await f.control.start("0.11.0")).update.phase).toBe("installing");
      expect(spawn).toHaveBeenCalledOnce();
      assert(finishActive);
      finishActive();
      await activeOperation;
      await expect(f.control.operation(async () => "turn")).rejects.toThrow("updating");
      const call = spawn.mock.calls[0];
      assert(call);
      // The helper is started through a shell that exits, so the service is not its parent.
      const [command, args, options] = call;
      expect(command).toBe("/bin/sh");
      expect(args[1]).toMatch(/& echo \$!$/u);
      expect(options).toMatchObject({ detached: true });
      const request = JSON.parse(await readFile(args[3], "utf8"));
      expect(request).toMatchObject({ version: "0.11.0", restartOnly: true });
      // A helper that dies without reporting is noticed through its PID, and requests resume.
      await writeFile(
        statusPath,
        JSON.stringify({
          phase: "restarting",
          targetVersion: "0.11.0",
          error: null,
          updaterPid: 999999999,
        }),
      );
      expect((await f.control.status()).update).toMatchObject({
        phase: "failed",
        error: expect.stringContaining("interrupted"),
      });
      expect(await f.control.operation(async () => "turn")).toBe("turn");
    },
  );
  it.skipIf(process.platform === "win32")(
    "rejects a downgrade and coalesces duplicate scheduling",
    async () => {
      const f = await fixture(true);
      const statusPath = path.join(f.root, "data/remote-update.json");
      spawn.mockImplementation(() => helperStartedBy(statusPath, "0.12.0", process.pid));
      await expect(f.control.start("0.10.0")).rejects.toThrow("downgrades");
      const result = await Promise.all([f.control.start("0.12.0"), f.control.start("0.12.0")]);
      expect(result.map((r) => r.update.phase)).toEqual(["installing", "installing"]);
      await expect(f.control.start("0.13.0")).rejects.toThrow("already pending");
    },
  );
  it("reports an interrupted updater instead of waiting forever after a service restart", async () => {
    const f = await fixture();
    await mkdir(path.join(f.root, "data"), { recursive: true });
    await writeFile(
      path.join(f.root, "data/remote-update.json"),
      JSON.stringify({
        phase: "installing",
        targetVersion: "0.12.0",
        error: null,
        updaterPid: 999999999,
      }),
    );
    expect((await f.control.status()).update).toMatchObject({
      phase: "failed",
      error: expect.stringContaining("interrupted"),
    });
  });
  it("detects bundled plugin catalog changes without changing the runtime version", async () => {
    const f = await fixture();
    await mkdir(path.join(path.dirname(f.runtimePath), "plugins"));
    await writeFile(path.join(path.dirname(f.runtimePath), "plugins/enabled.json"), '["pi"]');
    expect((await f.control.status()).restartRequired).toBe(true);
  });
  it.skipIf(process.platform === "win32")(
    "kills the detached helper when start times out before updaterPid is written",
    async () => {
      const f = await fixture(true);
      const statusPath = path.join(f.root, "data/remote-update.json");
      const helperPid = 42_424;
      const kill = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: number | string) => {
        if (pid === helperPid) return true;
        // Preserve liveliness probes used by status().
        if (signal === 0) return true;
        return true;
      }) as typeof process.kill);
      spawn.mockImplementation(() => {
        const starter = new EventEmitter() as EventEmitter & { stdout: EventEmitter };
        starter.stdout = new EventEmitter();
        // Defer exit past the Host attaching listeners (same race the real shell avoids).
        queueMicrotask(() => {
          starter.stdout.emit("data", `${helperPid}\n`);
          queueMicrotask(() => starter.emit("exit", 0));
        });
        return starter;
      });
      vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "Date"] });
      const pending = f.control.start("0.12.0");
      let settled = false;
      void pending.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      for (let i = 0; i < 300 && !settled; i += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        await vi.advanceTimersByTimeAsync(50);
      }
      await expect(pending).rejects.toThrow("Remote updater did not start");
      expect(kill).toHaveBeenCalledWith(helperPid);
      expect(JSON.parse(await readFile(statusPath, "utf8"))).toMatchObject({
        phase: "failed",
        error: "Remote updater did not start",
      });
      // A late helper write still surfaces through status() after the recorded failure.
      await writeFile(
        statusPath,
        JSON.stringify({
          phase: "installing",
          targetVersion: "0.12.0",
          error: null,
          updaterPid: helperPid,
        }),
      );
      expect((await f.control.status()).update.phase).toBe("installing");
      kill.mockRestore();
    },
    15_000,
  );
});
