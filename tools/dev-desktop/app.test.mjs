import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  appLauncherEnvironment,
  appLauncherInvocation,
  appUsage,
  developmentAppArtifacts,
  parseAppArguments,
  runDevelopmentApp,
  stopRunningShellAndWeb,
} from "./app.mjs";
import { npmBuildInvocation, validateDevelopmentArtifacts } from "./run.mjs";
import { identifyStopTarget } from "./stop-processes.mjs";

const temporaryDirectories = [];

function temporaryDirectory() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "codexhost-dev-app-"));
  temporaryDirectories.push(directory);
  return directory;
}

function writeExecutable(filePath) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, "fixture\n");
  chmodSync(filePath, 0o755);
}

function materializeAppArtifacts(root, platform, nodePath, { packedWeb = true } = {}) {
  const executableSuffix = platform === "win32" ? ".exe" : "";
  const files = [
    path.join(root, "target", "debug", `codexhost${executableSuffix}`),
    path.join(root, "target", "debug", `codexhost-shim${executableSuffix}`),
    path.join(
      root,
      "apps",
      "desktop-shell",
      "src-tauri",
      "target",
      "debug",
      `codexhost-shell${executableSuffix}`,
    ),
    nodePath,
    path.join(root, "packages", "host-runtime", "dist", "main.js"),
    path.join(root, "packages", "desktop-control", "dist", "release-main.js"),
    path.join(root, "packages", "renderer-extension", "dist", "production.js"),
    packedWeb
      ? path.join(root, "packages", "web-server", "dist", "codexhost-web", "app", "server.mjs")
      : path.join(root, "packages", "web-server", "dist", "main.js"),
  ];
  for (const filePath of files) writeExecutable(filePath);
  writeFileSync(path.join(root, "package-lock.json"), "{}");
  return developmentAppArtifacts(root, platform, nodePath);
}

function exitingChild(code = 0, signal = null) {
  const child = new EventEmitter();
  queueMicrotask(() => {
    child.emit("exit", code, signal);
    child.emit("close", code, signal);
  });
  return child;
}

function runChildStub(invocation, root, spawnImplementation, environment) {
  return new Promise((resolve, reject) => {
    const child = spawnImplementation(invocation.command, invocation.arguments, {
      cwd: root,
      stdio: "inherit",
      env: environment,
      windowsHide: false,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("development desktop shell start (app)", () => {
  it("parses valid app options and rejects conflicting or unknown flags", () => {
    expect(parseAppArguments([])).toEqual({
      buildWeb: true,
      buildShell: true,
      onboarding: true,
      help: false,
    });
    expect(parseAppArguments(["--no-build", "--no-onboarding", "--keep-host"])).toEqual({
      buildWeb: false,
      buildShell: false,
      onboarding: false,
      help: false,
      "keep-host": true,
    });
    expect(parseAppArguments(["--shell-only", "--onboarding", "--restart-host"])).toEqual({
      buildWeb: false,
      buildShell: true,
      onboarding: true,
      help: false,
      "restart-host": true,
    });
    expect(parseAppArguments(["--help"]).help).toBe(true);
    expect(appUsage()).toContain("npm start app");
    expect(appUsage()).toContain("--shell-only");

    for (const [args, message] of [
      [["--no-build", "--no-build"], "may only be provided once"],
      [["--shell-only", "--shell-only"], "may only be provided once"],
      [["--no-build", "--shell-only"], "mutually exclusive"],
      [["--shell-only", "--no-build"], "mutually exclusive"],
      [["--onboarding", "--no-onboarding"], "may only be provided once"],
      [["--restart-host", "--keep-host"], "mutually exclusive"],
      [["--unknown"], "unknown option"],
    ]) {
      expect(() => parseAppArguments(args)).toThrow(message);
    }
  });

  it("rejects Linux before running any build or process", async () => {
    const spawnImplementation = vi.fn();
    await expect(
      runDevelopmentApp({
        arguments_: [],
        root: temporaryDirectory(),
        platform: "linux",
        spawnImplementation,
        npmBuildInvocation,
        validateArtifacts: validateDevelopmentArtifacts,
        nodeVersionSupported: () => true,
        runChild: runChildStub,
      }),
    ).rejects.toThrow("supported only on macOS and Windows");
    expect(spawnImplementation).not.toHaveBeenCalled();
  });

  it("builds web and shell, pins worktree runtime env, clears npm routing, and launches onboarding", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const root = temporaryDirectory();
    const nodePath = path.join(root, "runtime", "node");
    const artifacts = materializeAppArtifacts(root, "darwin", nodePath);
    const calls = [];
    const spawnImplementation = vi.fn((command, args, options) => {
      calls.push({ command, args, options });
      return exitingChild(0);
    });
    const stopExisting = vi.fn(async () => {});
    const restartHost = vi.fn(async () => {});
    const environment = {
      npm_execpath: "/fixture/npm-cli.js",
      CODEXHOST_DATA_DIR: path.join(root, "data"),
      CODEXHOST_NPM_NODE_PATH: "/installed/node",
      CODEXHOST_NPM_CLI_PATH: "/installed/cli.js",
      CODEXHOST_NPM_LAUNCHER_PATH: "/installed/codexhost",
      CODEXHOST_NPM_PACKAGE_ROOT: "/installed/pkg",
      CODEXHOST_WEB_SERVICE: "0",
      CODEXHOST_DEV_VERSION: "0.99.0",
      HTTPS_PROXY: "http://127.0.0.1:8080",
    };

    const code = await runDevelopmentApp({
      arguments_: [],
      root,
      platform: "darwin",
      nodePath,
      environment,
      spawnImplementation,
      npmBuildInvocation,
      validateArtifacts: validateDevelopmentArtifacts,
      nodeVersionSupported: () => true,
      runChild: runChildStub,
      stopExisting,
      restartHost,
    });

    expect(code).toBe(0);
    expect(calls).toHaveLength(3);
    expect(calls[0]).toMatchObject({
      command: nodePath,
      args: ["/fixture/npm-cli.js", "run", "build:web"],
    });
    expect(calls[1]).toMatchObject({
      command: nodePath,
      args: ["/fixture/npm-cli.js", "run", "build:shell"],
    });
    expect(calls[2]).toMatchObject({
      command: artifacts.launcher,
      args: ["app", "--onboarding"],
    });
    const launchEnv = calls[2].options.env;
    expect(launchEnv.CODEXHOST_HOST_NODE_PATH).toBe(nodePath);
    expect(launchEnv.CODEXHOST_HOST_RUNTIME_PATH).toBe(artifacts.hostRuntime);
    expect(launchEnv.CODEXHOST_DESKTOP_SHELL_PATH).toBe(artifacts.shell);
    expect(launchEnv.CODEXHOST_DATA_DIR).toBe(environment.CODEXHOST_DATA_DIR);
    expect(launchEnv.HTTPS_PROXY).toBe(environment.HTTPS_PROXY);
    for (const removed of [
      "CODEXHOST_NPM_NODE_PATH",
      "CODEXHOST_NPM_CLI_PATH",
      "CODEXHOST_NPM_LAUNCHER_PATH",
      "CODEXHOST_NPM_PACKAGE_ROOT",
      "CODEXHOST_WEB_SERVICE",
      "CODEXHOST_DEV_VERSION",
    ]) {
      expect(launchEnv).not.toHaveProperty(removed);
    }
    expect(restartHost).toHaveBeenCalledWith(
      expect.objectContaining({
        otherInterface: "Codex Desktop",
      }),
    );
    expect(stopExisting).toHaveBeenCalledOnce();
  });

  it("supports --shell-only and --no-onboarding without rebuilding Web", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const root = temporaryDirectory();
    const nodePath = path.join(root, "node.exe");
    const artifacts = materializeAppArtifacts(root, "win32", nodePath, { packedWeb: false });
    expect(artifacts.webRuntime).toBe(path.join(root, "packages", "web-server", "dist", "main.js"));
    const calls = [];
    const spawnImplementation = vi.fn((command, args) => {
      calls.push({ command, args });
      return exitingChild(0);
    });

    const code = await runDevelopmentApp({
      arguments_: ["--shell-only", "--no-onboarding"],
      root,
      platform: "win32",
      nodePath,
      environment: { npm_execpath: "/npm-cli.js" },
      spawnImplementation,
      npmBuildInvocation,
      validateArtifacts: validateDevelopmentArtifacts,
      nodeVersionSupported: () => true,
      runChild: runChildStub,
      stopExisting: async () => {},
      restartHost: async () => {},
    });

    expect(code).toBe(0);
    expect(calls).toEqual([
      { command: nodePath, args: ["/npm-cli.js", "run", "build:shell"] },
      { command: artifacts.launcher, args: ["app"] },
    ]);
  });

  it.each(["web", "shell"])("stops immediately when the %s build fails", async (failingStage) => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const root = temporaryDirectory();
    const nodePath = path.join(root, "node");
    const spawnImplementation = vi.fn((_command, args) =>
      exitingChild(
        (failingStage === "web" && args.includes("build:web")) ||
          (failingStage === "shell" && args.includes("build:shell"))
          ? 9
          : 0,
      ),
    );
    const stopExisting = vi.fn();

    const code = await runDevelopmentApp({
      arguments_: [],
      root,
      platform: "darwin",
      nodePath,
      environment: { npm_execpath: "/npm-cli.js" },
      spawnImplementation,
      npmBuildInvocation,
      validateArtifacts: validateDevelopmentArtifacts,
      nodeVersionSupported: () => true,
      runChild: runChildStub,
      stopExisting,
      restartHost: async () => {},
    });

    expect(code).toBe(9);
    expect(stopExisting).not.toHaveBeenCalled();
    expect(spawnImplementation).toHaveBeenCalledTimes(failingStage === "web" ? 1 : 2);
  });

  it("stops only shell, watcher, and Web processes while leaving Host and Desktop untouched", async () => {
    const processes = [
      {
        pid: 10,
        parentPid: 1,
        created: "t",
        command: "/repo/apps/desktop-shell/src-tauri/target/debug/codexhost-shell --onboarding",
      },
      {
        pid: 11,
        parentPid: 1,
        created: "t",
        command: "/node --import tsx /repo/apps/web-ui/scripts/build.ts --watch",
      },
      {
        pid: 12,
        parentPid: 1,
        created: "t",
        command: "/release/bin/codexhost web-service serve --data /data",
      },
      {
        pid: 13,
        parentPid: 12,
        created: "t",
        command: "/node /release/app/web-server.mjs --background",
      },
      {
        pid: 14,
        parentPid: 1,
        created: "t",
        command: "/node /repo/packages/desktop-control/dist/release-main.js",
      },
      {
        pid: 15,
        parentPid: 1,
        created: "t",
        command: "/node /repo/packages/host-runtime/dist/main.js --codexhost-shared-host",
      },
      {
        pid: 16,
        parentPid: 1,
        created: "t",
        command: "/node /release/app/console-server.mjs serve",
      },
    ];
    const stopped = [];
    await stopRunningShellAndWeb({
      platform: "darwin",
      list: async () => processes,
      identify: (candidate) =>
        identifyStopTarget(candidate, {
          json: async (file) =>
            file === "/repo/package.json"
              ? { name: "codexhost" }
              : file === "/release/app/codexhost-distribution.json"
                ? { schemaVersion: 1, distribution: "installer" }
                : null,
        }),
      stop: async (target) => {
        stopped.push(target.kind);
      },
      log: () => {},
    });

    expect(stopped).toEqual(["shell", "watch", "web-supervisor", "web"]);
  });

  it("builds app launcher invocations and clean environment helpers", () => {
    const artifacts = {
      launcher: "/repo/target/debug/codexhost",
      node: "/usr/local/bin/node",
      hostRuntime: "/repo/packages/host-runtime/dist/main.js",
      shell: "/repo/apps/desktop-shell/src-tauri/target/debug/codexhost-shell",
    };
    expect(appLauncherInvocation(artifacts, true)).toEqual({
      command: artifacts.launcher,
      arguments: ["app", "--onboarding"],
    });
    expect(appLauncherInvocation(artifacts, false)).toEqual({
      command: artifacts.launcher,
      arguments: ["app"],
    });
    const env = appLauncherEnvironment({ NODE_OPTIONS: "--max-old-space-size=4096" }, artifacts);
    expect(env.NODE_OPTIONS).toBe("--max-old-space-size=4096 --disable-warning=UNDICI-EHPA");
  });
});
