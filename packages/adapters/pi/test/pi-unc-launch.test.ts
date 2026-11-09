import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PiRpcFaultError,
  piRpcProcessCommand,
  type PiRpcProcessOptions,
} from "../src/pi-rpc-session.js";
import { isWindowsUncDirectory } from "../src/pi-unc-launch.js";

const unc = String.raw`\\wsl.localhost\Ubuntu\home\dev\项目 space`;
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function root(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-unc-test-"));
  roots.push(directory);
  return directory;
}
function file(filePath: string, contents = ""): string {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents, { mode: 0o755 });
  return filePath;
}
function fixture(name: string): string {
  return readFileSync(path.join(import.meta.dirname, "fixtures", name), "utf8");
}
const probe = `console.log(JSON.stringify({
  cwd: process.cwd(), args: process.argv.slice(2), thread: process.env.CODEXHOST_THREAD_ID,
  managedRoot: process.env.PI_MANAGED_INSTALL_ROOT, agentDir: process.env.PI_CODING_AGENT_DIR
}));`;
function npmInstallation(shim = "pi-npm.cmd") {
  const directory = path.join(root(), "npm space %literal%");
  const command = file(path.join(directory, "pi.cmd"), fixture(shim));
  const packageDirectory = path.join(
    directory,
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
  );
  const manifestPath = file(
    path.join(packageDirectory, "package.json"),
    JSON.stringify({
      name: "@earendil-works/pi-coding-agent",
      bin: { pi: "dist/bundle/cli.js" },
    }),
  );
  const entry = file(path.join(packageDirectory, "dist/bundle/cli.js"), probe);
  return { directory, command, packageDirectory, manifestPath, entry };
}
function managedInstallation(standalone = false) {
  const directory = path.join(root(), "agent", "bin");
  const source = fixture("pi-managed.cmd");
  const command = file(
    path.join(directory, "pi.cmd"),
    standalone
      ? source.replace(
          'SET "node=node"',
          'SET "node=node"\nIF EXIST "%LOCALAPPDATA%\\pi-node\\current\\node.exe" SET "node=%LOCALAPPDATA%\\pi-node\\current\\node.exe"',
        )
      : source,
  );
  const installRoot = path.join(path.dirname(directory), "install");
  const markerPath = file(
    path.join(installRoot, "managed-install.json"),
    JSON.stringify({
      kind: "pi-managed-install",
      schemaVersion: 1,
      layout: "releases-v1",
      entrypoint: { type: "script", path: command },
    }),
  );
  const launcher = file(
    path.join(directory, "pi-launcher.js"),
    `
const fs = require("node:fs"), path = require("node:path"), { spawnSync } = require("node:child_process");
const installRoot = path.join(__dirname, "..", "install");
const version = fs.readFileSync(path.join(installRoot, "current-version"), "utf8").trim();
const entry = path.join(installRoot, "releases", version, "cli.js");
const result = spawnSync(process.execPath, [entry, ...process.argv.slice(2)], {
  stdio: "inherit", env: { ...process.env, PI_MANAGED_INSTALL_ROOT: installRoot }
});
process.exit(result.status ?? 1);
`,
  );
  file(path.join(installRoot, "current-version"), "version-two\n");
  file(path.join(installRoot, "releases", "version-one", "cli.js"), "process.exit(91)");
  file(path.join(installRoot, "releases", "version-two", "cli.js"), probe);
  return { directory, command, installRoot, markerPath, launcher };
}
function invocation(command: string, overrides: Partial<PiRpcProcessOptions> = {}) {
  return piRpcProcessCommand(
    { cwd: unc, command, environment: {}, ...overrides },
    {
      platform: "win32",
      isExecutable: () => true,
    },
  );
}

describe("Windows UNC directory classification", () => {
  it.each([
    unc,
    String.raw`\\wsl$\Ubuntu\home\dev`,
    "//server/share/project",
    String.raw`\\?\UNC\server\share\project`,
  ])("recognizes %s", (cwd) => {
    expect(isWindowsUncDirectory(cwd)).toBe(true);
  });
  it.each([
    String.raw`C:\project`,
    String.raw`\\?\C:\project`,
    String.raw`\\.\pipe\pi`,
    "/home/dev",
    "relative",
    String.raw`\\server`,
  ])("does not classify %s as a network directory", (cwd) => {
    expect(isWindowsUncDirectory(cwd)).toBe(false);
  });
});

describe("Pi UNC process invocation", () => {
  it.each(["pi-npm.cmd", "pi-npm-12.cmd"])(
    "launches the same npm package directly without CMD or shell quoting: %s",
    (shim) => {
      const { command, entry } = npmInstallation(shim);
      const result = invocation(command);
      expect(result).toEqual({
        command: process.execPath,
        arguments: [entry, "--mode", "rpc"],
        windowsVerbatimArguments: false,
      });
    },
  );
  it.each(["pi-npm.cmd", "pi-npm-12.cmd"])(
    "rejects extra environment setup or arguments in %s",
    (shim) => {
      const { command } = npmInstallation(shim);
      const source = fixture(shim);
      for (const modified of [
        "SET EXTRA=custom\n" + source,
        source.replace(" %*", " --custom %*"),
      ]) {
        file(command, modified);
        expect(() => invocation(command)).toThrowError(
          expect.objectContaining({ name: "PiRpcFaultError", kind: "unavailable" }),
        );
      }
    },
  );
  it("preserves extension and model arguments as literal argv", () => {
    const { command, entry } = npmInstallation();
    const result = invocation(command, {
      fastExtension: String.raw`C:\Host space\fast%literal%.mjs`,
      subagentExtension: String.raw`C:\Host\observer.mjs`,
      model: { provider: "provider", id: "model & literal" },
    });
    expect(result.arguments).toEqual([
      entry,
      "--extension",
      String.raw`C:\Host space\fast%literal%.mjs`,
      "--extension",
      String.raw`C:\Host\observer.mjs`,
      "--mode",
      "rpc",
      "--provider",
      "provider",
      "--model",
      "model & literal",
    ]);
  });
  it("preserves empty-session model and thinking restoration", () => {
    const { command, entry } = npmInstallation();
    expect(
      invocation(command, {
        sessionFile: "empty-session.jsonl",
        emptySessionConfiguration: {
          model: { provider: "provider", id: "model" },
          thinkingLevel: "high",
        },
      }).arguments,
    ).toEqual([
      entry,
      "--mode",
      "rpc",
      "--provider",
      "provider",
      "--model",
      "model",
      "--thinking",
      "high",
      "--session",
      "empty-session.jsonl",
    ]);
  });
  it.each([
    [
      { sessionFile: "source space %literal%.jsonl" },
      ["--session", "source space %literal%.jsonl"],
    ],
    [
      { forkSessionFile: "source space %literal%.jsonl" },
      ["--fork", "source space %literal%.jsonl"],
    ],
  ] as const)("preserves restore/fork arguments: %j", (options, tail) => {
    const { command, entry } = npmInstallation();
    expect(invocation(command, options).arguments).toEqual([entry, "--mode", "rpc", ...tail]);
  });
  it("accepts npm's string-form bin declaration", () => {
    const { command, manifestPath, entry } = npmInstallation();
    file(
      manifestPath,
      JSON.stringify({ name: "@earendil-works/pi-coding-agent", bin: "dist/bundle/cli.js" }),
    );
    expect(invocation(command).arguments[0]).toBe(entry);
  });
  it("does not borrow a package from an ancestor of the selected shim", () => {
    const { directory } = npmInstallation();
    const command = file(path.join(directory, "nested", "pi.cmd"), fixture("pi-npm.cmd"));
    expect(() => invocation(command)).toThrow("cannot safely start in a UNC working directory");
  });
  it("keeps npm's adjacent Node preference", () => {
    const { command, directory } = npmInstallation();
    const node = file(path.join(directory, "node.exe"));
    const nodeShims = root();
    file(path.join(nodeShims, "node.cmd"));
    expect(invocation(command, { environment: { PATH: nodeShims } }).command).toBe(node);
  });
  it("keeps Node selected from the session PATH", () => {
    const { command } = npmInstallation();
    const directory = root();
    const node = file(path.join(directory, "node.exe"));
    expect(invocation(command, { environment: { PATH: directory } }).command).toBe(node);
  });
  describe.each(["npm", "npm-12", "managed", "managed-standalone"])(
    "%s PATH Node selection",
    (kind) => {
      function installation() {
        return kind.startsWith("npm")
          ? npmInstallation(kind === "npm-12" ? "pi-npm-12.cmd" : "pi-npm.cmd")
          : managedInstallation(kind === "managed-standalone");
      }
      it.each([".cmd", ".bat"])("refuses a Node %s preferred by PATHEXT", (extension) => {
        const { command } = installation();
        const directory = root();
        file(path.join(directory, "node" + extension), "@echo off\nset EXTRA=custom\n");
        file(path.join(directory, "node.exe"));
        expect(() =>
          invocation(command, {
            environment: { Path: directory, pathext: `${extension};.EXE` },
          }),
        ).toThrowError(
          expect.objectContaining({
            name: "PiRpcFaultError",
            kind: "unavailable",
            message: expect.stringContaining("PATH Node batch launchers are not bypassed"),
          }),
        );
      });
      it("does not skip an earlier PATH Node batch shim for a later executable", () => {
        const { command } = installation();
        const first = root();
        const second = root();
        file(path.join(first, "node.cmd"), "@echo off\nset EXTRA=custom\n");
        file(path.join(second, "node.exe"));
        expect(() =>
          invocation(command, {
            environment: { PATH: `${first};${second}`, PATHEXT: ".EXE;.CMD" },
          }),
        ).toThrow(PiRpcFaultError);
      });
      it.each([".EXE;.CMD", ".COM;.EXE;.CMD"])(
        "keeps the native Node selected by PATHEXT=%s",
        (pathext) => {
          const { command } = installation();
          const directory = root();
          file(path.join(directory, "node.cmd"));
          const executable = file(path.join(directory, "node.exe"));
          const com = file(path.join(directory, "node.com"));
          expect(
            invocation(command, { environment: { PATH: directory, PATHEXT: pathext } }).command,
          ).toBe(pathext.startsWith(".COM") ? com : executable);
        },
      );
    },
  );
  it.each([false, true])(
    "runs the native managed launcher (standalone Node setup: %s)",
    (standalone) => {
      const { command, launcher } = managedInstallation(standalone);
      expect(invocation(command)).toEqual({
        command: process.execPath,
        arguments: [launcher, "--mode", "rpc"],
        windowsVerbatimArguments: false,
      });
    },
  );
  it("retains a managed installation's dedicated Node when present", () => {
    const { command } = managedInstallation(true);
    const localAppData = root();
    const node = file(path.join(localAppData, "pi-node", "current", "node.exe"));
    const nodeShims = root();
    file(path.join(nodeShims, "node.cmd"));
    expect(
      invocation(command, { environment: { localappdata: localAppData, PATH: nodeShims } }).command,
    ).toBe(node);
  });
  it("does not force dedicated Node on a managed launcher that uses PATH", () => {
    const { command } = managedInstallation();
    const localAppData = root();
    file(path.join(localAppData, "pi-node", "current", "node.exe"));
    expect(invocation(command, { environment: { LOCALAPPDATA: localAppData } }).command).toBe(
      process.execPath,
    );
  });
  it("accepts CRLF and BOM in standard launchers and managed markers", () => {
    const { command, markerPath } = managedInstallation();
    file(command, "\uFEFF" + readFileSync(command, "utf8").replaceAll("\n", "\r\n"));
    file(markerPath, "\uFEFF" + readFileSync(markerPath, "utf8"));
    expect(invocation(command).command).toBe(process.execPath);
  });
  it.each([
    "custom",
    "modified-npm",
    "foreign-package",
    "escaping-bin",
    "missing-bin",
    "foreign-marker",
    "missing-launcher",
    "modified-managed",
    "malformed-marker",
  ])("refuses %s without falling back to CMD or another Pi", (scenario) => {
    const npm = npmInstallation();
    let command = npm.command;
    if (scenario === "custom")
      command = file(path.join(root(), "custom.bat"), "@echo off\ncustom pi %*");
    if (scenario === "modified-npm") file(command, "set EXTRA=custom\n" + fixture("pi-npm.cmd"));
    if (scenario === "foreign-package")
      file(
        npm.manifestPath,
        JSON.stringify({ name: "unrelated", bin: { pi: "dist/bundle/cli.js" } }),
      );
    if (scenario === "escaping-bin")
      file(
        npm.manifestPath,
        JSON.stringify({ name: "@earendil-works/pi-coding-agent", bin: { pi: "../outside.js" } }),
      );
    if (scenario === "missing-bin") rmSync(npm.entry);
    if (
      ["foreign-marker", "missing-launcher", "modified-managed", "malformed-marker"].includes(
        scenario,
      )
    ) {
      const managed = managedInstallation();
      command = managed.command;
      if (scenario === "foreign-marker")
        file(
          managed.markerPath,
          JSON.stringify({
            kind: "pi-managed-install",
            schemaVersion: 1,
            layout: "releases-v1",
            entrypoint: { type: "script", path: npm.command },
          }),
        );
      if (scenario === "missing-launcher") rmSync(managed.launcher);
      if (scenario === "modified-managed")
        file(command, "set EXTRA=custom\n" + fixture("pi-managed.cmd"));
      if (scenario === "malformed-marker") file(managed.markerPath, "not json");
    }
    expect(() => invocation(command)).toThrow("cannot safely start in a UNC working directory");
  });
  it("does not inspect or bypass a custom batch launcher in an ordinary directory", () => {
    const command = String.raw`C:\custom\pi.bat`;
    const result = invocation(command, { cwd: String.raw`D:\project` });
    expect(result.command).toMatch(/cmd\.exe$/iu);
    expect(result.arguments.slice(0, 4)).toEqual(["/d", "/v:off", "/s", "/c"]);
  });
  it.each(["linux", "darwin"] as const)("does not change %s invocations", (platform) => {
    const command = "/opt/pi.cmd";
    expect(
      piRpcProcessCommand(
        { cwd: unc, command, environment: {} },
        { platform, isExecutable: () => true },
      ),
    ).toEqual({ command, arguments: ["--mode", "rpc"], windowsVerbatimArguments: false });
  });
  it("does not change a native executable even in a UNC directory", () => {
    const command = String.raw`C:\Pi\pi.exe`;
    expect(invocation(command)).toEqual({
      command,
      arguments: ["--mode", "rpc"],
      windowsVerbatimArguments: false,
    });
  });
  it.each(["npm", "npm-12", "managed"] as const)(
    "executes the %s Node entry with literal argv, cwd and session environment",
    (kind) => {
      const installation =
        kind === "managed"
          ? managedInstallation()
          : npmInstallation(kind === "npm-12" ? "pi-npm-12.cmd" : "pi-npm.cmd");
      const result = invocation(installation.command, {
        sessionFile: 'source %literal% & "quoted".jsonl',
      });
      const cwd = root();
      const child = spawnSync(result.command, result.arguments, {
        cwd,
        encoding: "utf8",
        timeout: 5_000,
        env: {
          ...process.env,
          CODEXHOST_THREAD_ID: "thread-audit",
          PI_CODING_AGENT_DIR: "isolated-agent-directory",
          PI_MANAGED_INSTALL_ROOT: "inherited-managed-root",
        },
      });
      expect(child.status, child.stderr).toBe(0);
      expect(JSON.parse(child.stdout)).toEqual({
        cwd: realpathSync(cwd),
        args: ["--mode", "rpc", "--session", 'source %literal% & "quoted".jsonl'],
        thread: "thread-audit",
        agentDir: "isolated-agent-directory",
        managedRoot:
          kind === "managed" && "installRoot" in installation
            ? realpathSync(installation.installRoot)
            : "inherited-managed-root",
      });
    },
  );
});
