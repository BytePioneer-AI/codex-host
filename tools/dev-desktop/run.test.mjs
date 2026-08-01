import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  developmentArtifacts,
  findPathExecutable,
  launcherInvocation,
  npmBuildInvocation,
  parseArguments,
  runDevelopmentDesktop,
  usage,
  validateDevelopmentArtifacts,
} from "./run.mjs";

const temporaryDirectories = [];

function temporaryDirectory() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "codexhost-dev-desktop-"));
  temporaryDirectories.push(directory);
  return directory;
}

function writeExecutable(filePath) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, "fixture\n");
  chmodSync(filePath, 0o755);
}

function materializeArtifacts(root, platform, nodePath) {
  const artifacts = developmentArtifacts(root, platform, nodePath);
  for (const filePath of Object.values(artifacts)) writeExecutable(filePath);
  return artifacts;
}

function exitingChild(code = 0, signal = null) {
  const child = new EventEmitter();
  queueMicrotask(() => child.emit("exit", code, signal));
  return child;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("development Desktop start", () => {
  it("parses a production-like default and bounded options", () => {
    expect(parseArguments([])).toEqual({ agent: "pi", build: true, help: false });
    expect(parseArguments(["--agent", "codex", "--no-build"])).toEqual({
      agent: "codex",
      build: false,
      help: false,
    });
    expect(parseArguments(["--agent=pi", "--help"])).toEqual({
      agent: "pi",
      build: true,
      help: true,
    });
    expect(usage()).toContain("npm start");
  });

  it("rejects unknown, duplicate, and malformed options", () => {
    expect(() => parseArguments(["--desktop", "private.exe"])).toThrow("unknown option");
    expect(() => parseArguments(["--agent", "claude-code"])).toThrow("must be 'codex' or 'pi'");
    expect(() => parseArguments(["--agent", "pi", "--agent=codex"])).toThrow(
      "may only be provided once",
    );
    expect(() => parseArguments(["--no-build", "--no-build"])).toThrow("may only be provided once");
  });

  it("resolves platform development artifacts and validates regular files", () => {
    const root = temporaryDirectory();
    const nodePath = path.join(root, "runtime", "node.exe");
    const artifacts = materializeArtifacts(root, "win32", nodePath);

    expect(artifacts.launcher).toBe(path.join(root, "target", "debug", "codexhost.exe"));
    expect(artifacts.hostRuntime).toBe(
      path.join(root, "packages", "host-runtime", "dist", "main.js"),
    );
    expect(() => validateDevelopmentArtifacts(artifacts)).not.toThrow();

    rmSync(artifacts.renderer);
    expect(() => validateDevelopmentArtifacts(artifacts)).toThrow(
      "renderer artifact is unavailable",
    );
  });

  it("finds Pi from PATH using platform executable rules", () => {
    const root = temporaryDirectory();
    const first = path.join(root, "missing");
    const second = path.join(root, "bin");
    const pi = path.join(second, "pi.CMD");
    writeExecutable(pi);

    expect(
      findPathExecutable("pi", {
        platform: "win32",
        environment: { Path: `${first};${second}`, PATHEXT: ".EXE;.CMD" },
      }),
    ).toBe(pi);
    expect(
      findPathExecutable("pi", { platform: "linux", environment: { PATH: first } }),
    ).toBeNull();
  });

  it("constructs npm and native launcher commands without internal Host environment", () => {
    expect(npmBuildInvocation({ npm_execpath: "/npm/npm-cli.js" }, "linux", "/node")).toEqual({
      command: "/node",
      arguments: ["/npm/npm-cli.js", "run", "build"],
    });

    const root = path.resolve("repo-fixture");
    const nodePath = path.join(root, "runtime", "node");
    const piPath = path.join(root, "tools", "pi");
    const artifacts = developmentArtifacts(root, "linux", nodePath);
    const invocation = launcherInvocation(artifacts, "codex", piPath);
    expect(invocation.command).toBe(artifacts.launcher);
    expect(invocation.arguments).toEqual([
      "launch",
      "--agent",
      "codex",
      "--shim",
      artifacts.shim,
      "--node",
      nodePath,
      "--host-runtime",
      artifacts.hostRuntime,
      "--desktop-controller",
      artifacts.desktopController,
      "--renderer",
      artifacts.renderer,
      "--pi",
      piPath,
    ]);
    expect(invocation.arguments.join(" ")).not.toContain("observed-host");
  });

  it("builds once and then runs the native launcher in the foreground", async () => {
    const root = temporaryDirectory();
    const nodePath = path.join(root, "runtime", "node.exe");
    materializeArtifacts(root, "win32", nodePath);
    const piDirectory = path.join(root, "pi-bin");
    const piPath = path.join(piDirectory, "pi.CMD");
    writeExecutable(piPath);
    const invocations = [];
    const spawnImplementation = vi.fn((command, arguments_, options) => {
      invocations.push({ command, arguments: arguments_, options });
      return exitingChild();
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(
      runDevelopmentDesktop({
        arguments_: ["--agent", "codex"],
        root,
        platform: "win32",
        nodePath,
        environment: {
          npm_execpath: path.join(root, "npm-cli.js"),
          PATH: piDirectory,
          PATHEXT: ".CMD",
        },
        spawnImplementation,
      }),
    ).resolves.toBe(0);

    expect(invocations).toHaveLength(2);
    expect(invocations[0]).toMatchObject({
      command: nodePath,
      arguments: [path.join(root, "npm-cli.js"), "run", "build"],
    });
    expect(invocations[1].command).toBe(path.join(root, "target", "debug", "codexhost.exe"));
    expect(invocations[1].arguments).toContain(piPath);
    expect(invocations[1].options).toMatchObject({ cwd: root, stdio: "inherit" });
  });

  it("skips builds only when explicitly requested", async () => {
    const root = temporaryDirectory();
    const nodePath = path.join(root, "node");
    const artifacts = materializeArtifacts(root, "linux", nodePath);
    const spawnImplementation = vi.fn(() => exitingChild());
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(
      runDevelopmentDesktop({
        arguments_: ["--no-build"],
        root,
        platform: "linux",
        nodePath,
        environment: { PATH: path.join(root, "missing") },
        spawnImplementation,
      }),
    ).resolves.toBe(0);

    expect(spawnImplementation).toHaveBeenCalledTimes(1);
    expect(spawnImplementation).toHaveBeenCalledWith(
      artifacts.launcher,
      expect.arrayContaining(["launch", "--agent", "pi"]),
      expect.objectContaining({ cwd: root, stdio: "inherit" }),
    );
  });
});
