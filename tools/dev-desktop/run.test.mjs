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
  runningDesktopCleanupInvocation,
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
  queueMicrotask(() => {
    child.emit("exit", code, signal);
    child.emit("close", code, signal);
  });
  return child;
}

function readyChild() {
  const child = new EventEmitter();
  const stdout = new EventEmitter();
  stdout.setEncoding = () => {};
  child.stdout = stdout;
  child.unref = vi.fn();
  queueMicrotask(() => stdout.emit("data", "ready\n"));
  return child;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("development Desktop start", () => {
  it("rejects the removed host subcommand without starting a process", async () => {
    const spawnImplementation = vi.fn();
    await expect(
      runDevelopmentDesktop({ arguments_: ["host"], spawnImplementation }),
    ).rejects.toThrow("semantic version");
    expect(spawnImplementation).not.toHaveBeenCalled();
  });
  it.each(["build", "restart"])("does not launch Desktop when %s fails", async (failure) => {
    const root = temporaryDirectory();
    const nodePath = path.join(root, "node");
    materializeArtifacts(root, "linux", nodePath);
    const calls = [];
    const spawnImplementation = vi.fn((command, args) => {
      calls.push({ command, args });
      return exitingChild(
        (failure === "build" && args.includes("build")) ||
          (failure === "restart" && args[0] === "host")
          ? 7
          : 0,
      );
    });
    const result = runDevelopmentDesktop({
      root,
      nodePath,
      platform: "linux",
      environment: { npm_execpath: "/npm.js" },
      arguments_: [],
      spawnImplementation,
    });
    if (failure === "build") await expect(result).resolves.toBe(7);
    else await expect(result).rejects.toThrow("Host restart failed");
    expect(calls.some(({ args }) => args[0] === "launch")).toBe(false);
    if (failure === "build") expect(calls.some(({ args }) => args[0] === "host")).toBe(false);
  });
  it.each([0, 7])(
    "routes web --no-build to the preview without Desktop cleanup or build (exit %s)",
    async (code) => {
      const root = temporaryDirectory();
      const nodePath = path.join(root, "node");
      const environment = { PATH: "/fixture/bin" };
      const spawnImplementation = vi.fn(() => exitingChild(code));
      expect(
        await runDevelopmentDesktop({
          arguments_: ["web", "--no-build", "--port", "3181"],
          root,
          nodePath,
          platform: "darwin",
          environment,
          spawnImplementation,
        }),
      ).toBe(code);
      expect(spawnImplementation).toHaveBeenCalledExactlyOnceWith(
        nodePath,
        [
          "--import",
          "tsx",
          path.join(root, "packages/web-server/scripts/preview.ts"),
          "--restart",
          "--port",
          "3181",
        ],
        expect.objectContaining({ cwd: root, env: environment, stdio: "inherit" }),
      );
    },
  );

  it.each([0, 7])(
    "builds Web before preview and stops on build failure (exit %s)",
    async (code) => {
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      const root = temporaryDirectory();
      const nodePath = path.join(root, "node");
      const environment = { npm_execpath: "/fixture/npm-cli.js" };
      const spawnImplementation = vi
        .fn()
        .mockImplementationOnce(() => exitingChild(code))
        .mockImplementation(() => exitingChild());
      expect(
        await runDevelopmentDesktop({
          arguments_: ["web", "--port", "3181"],
          root,
          nodePath,
          environment,
          spawnImplementation,
        }),
      ).toBe(code);
      expect(spawnImplementation).toHaveBeenNthCalledWith(
        1,
        nodePath,
        [environment.npm_execpath, "run", "build:web"],
        expect.objectContaining({ cwd: root, env: environment, stdio: ["ignore", "pipe", "pipe"] }),
      );
      expect(spawnImplementation).toHaveBeenCalledTimes(code === 0 ? 2 : 1);
      if (code === 0) {
        expect(spawnImplementation).toHaveBeenNthCalledWith(
          2,
          nodePath,
          [
            "--import",
            "tsx",
            path.join(root, "packages/web-server/scripts/preview.ts"),
            "--restart",
            "--port",
            "3181",
          ],
          expect.objectContaining({ cwd: root, env: environment, stdio: "inherit" }),
        );
      }
    },
  );

  it("parses the default and bounded options", () => {
    expect(parseArguments([])).toEqual({ build: true, help: false });
    expect(parseArguments(["--no-build"])).toEqual({
      build: false,
      help: false,
    });
    expect(parseArguments(["--help"])).toEqual({
      build: true,
      help: true,
    });
    expect(usage()).toContain("npm start");
    expect(usage()).not.toContain("npm start host");
    expect(() => parseArguments(["host"])).toThrow("semantic version");
    expect(usage()).toContain("Stop any running Codex Desktop");
  });

  it("rejects unknown, duplicate, and malformed options", () => {
    expect(() => parseArguments(["--desktop", "private.exe"])).toThrow("unknown option");
    expect(() => parseArguments(["--agent", "codex"])).toThrow("unknown option");
    expect(() => parseArguments(["--no-build", "--no-build"])).toThrow("may only be provided once");
    for (const value of [undefined, "latest", "0.12", "0.12.0;echo bad"]) {
      expect(() => parseArguments(["--version", ...(value ? [value] : [])])).toThrow(
        "semantic version",
      );
    }
    expect(() => parseArguments(["--version", "0.12.0", "--version", "0.13.0"])).toThrow(
      "may only be provided once",
    );
    for (const arguments_ of [
      ["0.12.0", "0.13.0"],
      ["0.12.0", "--version", "0.13.0"],
      ["--version", "0.12.0", "0.13.0"],
    ]) {
      expect(() => parseArguments(arguments_)).toThrow("may only be provided once");
    }
    for (const version of ["latest", "0.12", "0.12.0;echo bad"]) {
      expect(() => parseArguments([version])).toThrow("semantic version");
    }
  });

  it.each([["0.12.0"], ["--version", "0.12.0"]])(
    "accepts positional and explicit versions: %j",
    (...arguments_) => {
      expect(parseArguments(arguments_)).toEqual({ build: true, help: false, version: "0.12.0" });
      expect(parseArguments([...arguments_, "--no-build"]).build).toBe(false);
    },
  );

  it.each([undefined, "0.12.0", "0.13.0-rc.1+test"])(
    "passes only the explicit source runtime version to the launcher: %s",
    async (version) => {
      const root = temporaryDirectory();
      const nodePath = path.join(root, "node");
      const artifacts = materializeArtifacts(root, "linux", nodePath);
      const spawnImplementation = vi.fn((_command, args) =>
        args[0] === "host" ? exitingChild() : readyChild(),
      );
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      await runDevelopmentDesktop({
        arguments_: [...(version ? [version] : []), "--no-build"],
        root,
        platform: "linux",
        nodePath,
        environment: { PATH: path.join(root, "missing"), CODEXHOST_DEV_VERSION: "0.99.0" },
        spawnImplementation,
      });
      expect(spawnImplementation).toHaveBeenCalledTimes(2);
      expect(spawnImplementation.mock.calls[1][0]).toBe(artifacts.launcher);
      expect(spawnImplementation.mock.calls[1][2].env.CODEXHOST_DEV_VERSION).toBe(version);
    },
  );

  it("does not let inherited npm routing replace the source Host Runtime", async () => {
    const root = temporaryDirectory();
    const nodePath = path.join(root, "node");
    const artifacts = materializeArtifacts(root, "linux", nodePath);
    const spawnImplementation = vi.fn((_command, args) =>
      args[0] === "host" ? exitingChild() : readyChild(),
    );
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const environment = {
      PATH: path.join(root, "missing"),
      CODEXHOST_NPM_NODE_PATH: "/installed/node",
      CODEXHOST_NPM_CLI_PATH: "/installed/npm-cli.js",
      CODEXHOST_NPM_LAUNCHER_PATH: "/installed/codexhost.js",
      CODEXHOST_NPM_PACKAGE_ROOT: "/installed/package",
      CODEXHOST_DATA_DIR: path.join(root, "explicit-data"),
      HTTPS_PROXY: "http://127.0.0.1:1234",
    };
    const original = { ...environment };
    await runDevelopmentDesktop({
      arguments_: ["--no-build"],
      root,
      platform: "linux",
      nodePath,
      environment,
      spawnImplementation,
    });
    const [command, arguments_, options] = spawnImplementation.mock.calls[1];
    expect(command).toBe(artifacts.launcher);
    expect(arguments_).toEqual(expect.arrayContaining(["--host-runtime", artifacts.hostRuntime]));
    for (const key of Object.keys(environment).filter((key) => key.startsWith("CODEXHOST_NPM_"))) {
      expect(options.env).not.toHaveProperty(key);
    }
    expect(options.env.CODEXHOST_DATA_DIR).toBe(environment.CODEXHOST_DATA_DIR);
    expect(options.env.HTTPS_PROXY).toBe(environment.HTTPS_PROXY);
    expect(environment).toEqual(original);
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

  it("constructs bounded platform cleanup commands", () => {
    const windowsInvocation = runningDesktopCleanupInvocation("win32");
    expect(windowsInvocation?.command).toBe("powershell.exe");
    expect(windowsInvocation?.arguments).toEqual(
      expect.arrayContaining(["-NoProfile", "-NonInteractive", "-Command"]),
    );
    const windowsScript = windowsInvocation?.arguments.at(-1);
    expect(windowsScript).toContain("Get-CimInstance Win32_Process");
    expect(windowsScript).toContain("\\windowsapps\\openai.codex_");
    expect(windowsScript).toContain("Stop-Process -Id");
    expect(windowsScript).not.toContain("Get-Process -Name");
    expect(windowsScript).not.toContain("Stop-Process -Name");
    expect(windowsScript).not.toContain("$runtimeProcessIds");

    const macOsInvocation = runningDesktopCleanupInvocation("darwin");
    expect(macOsInvocation?.command).toBe("/bin/sh");
    expect(macOsInvocation?.arguments.at(-1)).toContain(
      "system_desktop_pattern='^/Applications/(ChatGPT|Codex)\\.app/Contents/MacOS/(ChatGPT|Codex)( |$)'",
    );
    expect(macOsInvocation?.arguments.at(-1)).toContain(
      'user_desktop_pattern="^$HOME/Applications/(ChatGPT|Codex)\\.app/Contents/MacOS/(ChatGPT|Codex)( |$)"',
    );
    const macOsScript = macOsInvocation?.arguments.at(-1);
    expect(macOsScript).not.toContain(
      "system_desktop_pattern='^/Applications/(ChatGPT|Codex)\\.app/Contents/'",
    );
    expect(macOsScript).not.toContain(
      'user_desktop_pattern="^$HOME/Applications/(ChatGPT|Codex)\\.app/Contents/"',
    );
    expect(macOsScript).toContain("desktop-runtime-v1.json");
    expect(macOsScript).toContain("lsof -nP -t -iTCP:");
    expect(macOsScript).toContain("ps -p");
    expect(macOsScript).toContain("packages/desktop-control/dist/release-main.js");
    expect(macOsScript).toContain("kill -TERM");
    expect(macOsScript).toContain("pkill -KILL");
    expect(macOsScript).not.toContain("pgrep -x codexhost");
    expect(macOsScript).not.toContain("pkill -KILL -x codexhost");
    expect(runningDesktopCleanupInvocation("linux")).toBeNull();
  });

  it("limits macOS cleanup to Desktop executables, not bundled Web Host subprocesses", () => {
    const script = runningDesktopCleanupInvocation("darwin").arguments.at(-1);
    const systemPattern = script.match(/system_desktop_pattern='([^']+)'/u)?.[1];
    const userPattern = script.match(/user_desktop_pattern="([^"]+)"/u)?.[1];
    expect(systemPattern).toBeDefined();
    expect(userPattern).toBeDefined();
    for (const [pattern, prefix] of [
      [systemPattern, "/Applications"],
      [userPattern.replace("$HOME", "/Users/tester"), "/Users/tester/Applications"],
    ]) {
      const matcher = new RegExp(pattern);
      for (const name of ["ChatGPT", "Codex"]) {
        const app = `${prefix}/${name}.app/Contents`;
        expect(matcher.test(`${app}/MacOS/${name}`)).toBe(true);
        expect(matcher.test(`${app}/MacOS/${name} --remote-debugging-port=9222`)).toBe(true);
        expect(matcher.test(`${app}/Resources/cua_node/bin/node_repl`)).toBe(false);
        expect(
          matcher.test(`${app}/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex app-server`),
        ).toBe(false);
        expect(matcher.test(`${app}/Resources/codex app-server`)).toBe(false);
        expect(matcher.test(`/usr/bin/node server.js --codex-command ${app}/MacOS/${name}`)).toBe(
          false,
        );
      }
    }
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
    const invocation = launcherInvocation(artifacts, piPath);
    expect(invocation.command).toBe(artifacts.launcher);
    expect(invocation.arguments).toEqual([
      "launch",
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

  it("builds once and returns when the native launcher reports ready", async () => {
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
        arguments_: [],
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

    expect(invocations).toHaveLength(4);
    expect(invocations[0].command).toBe("powershell.exe");
    expect(invocations[1]).toMatchObject({
      command: nodePath,
      arguments: [path.join(root, "npm-cli.js"), "run", "build"],
    });
    expect(invocations[2].arguments.slice(0, 2)).toEqual(["host", "restart"]);
    expect(invocations[3].command).toBe(path.join(root, "target", "debug", "codexhost.exe"));
    expect(invocations[3].arguments).toContain(piPath);
    expect(invocations[3].options).toMatchObject({
      cwd: root,
      stdio: ["ignore", "pipe", "inherit"],
    });
  });

  it("rejects unsupported Node.js major versions before any cleanup", async () => {
    const root = temporaryDirectory();
    const originalNode = process.versions.node;
    Object.defineProperty(process.versions, "node", {
      value: "20.19.0",
      configurable: true,
    });
    try {
      await expect(
        runDevelopmentDesktop({
          root,
          platform: "win32",
          nodePath: path.join(root, "node.exe"),
          environment: {},
          spawnImplementation: vi.fn(),
        }),
      ).rejects.toThrow("npm start requires Node.js 22 or 24; current version is 20.19.0");
    } finally {
      Object.defineProperty(process.versions, "node", {
        value: originalNode,
        configurable: true,
      });
    }
  });

  it("accepts Node.js 22 and 24", async () => {
    const root = temporaryDirectory();
    const nodePath = path.join(root, "node.exe");
    materializeArtifacts(root, "win32", nodePath);
    const originalNode = process.versions.node;
    const spawnImplementation = vi.fn(() => exitingChild());
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      for (const version of ["22.19.0", "24.0.0"]) {
        Object.defineProperty(process.versions, "node", {
          value: version,
          configurable: true,
        });
        await expect(
          runDevelopmentDesktop({
            arguments_: ["--no-build"],
            root,
            platform: "win32",
            nodePath,
            environment: { PATH: path.join(root, "missing") },
            spawnImplementation,
          }),
        ).resolves.toBe(0);
      }
    } finally {
      Object.defineProperty(process.versions, "node", {
        value: originalNode,
        configurable: true,
      });
    }
  });

  it("rejects Node.js 23", async () => {
    const root = temporaryDirectory();
    const originalNode = process.versions.node;
    Object.defineProperty(process.versions, "node", {
      value: "23.0.0",
      configurable: true,
    });
    try {
      await expect(
        runDevelopmentDesktop({
          root,
          platform: "win32",
          nodePath: path.join(root, "node.exe"),
          environment: {},
          spawnImplementation: vi.fn(),
        }),
      ).rejects.toThrow("npm start requires Node.js 22 or 24; current version is 23.0.0");
    } finally {
      Object.defineProperty(process.versions, "node", {
        value: originalNode,
        configurable: true,
      });
    }
  });

  it("does not build or launch when Desktop cleanup fails", async () => {
    const root = temporaryDirectory();
    const spawnImplementation = vi.fn(() => exitingChild(7));
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(
      runDevelopmentDesktop({
        root,
        platform: "win32",
        nodePath: path.join(root, "node.exe"),
        environment: {},
        spawnImplementation,
      }),
    ).rejects.toThrow("could not stop the running Codex Desktop: status 7");

    expect(spawnImplementation).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, "--trace-warnings"])(
    "silences only the proxy warning in children while preserving Node options (%s)",
    async (nodeOptions) => {
      const root = temporaryDirectory();
      const nodePath = path.join(root, "node.exe");
      materializeArtifacts(root, "win32", nodePath);
      const environment = {
        PATH: path.join(root, "missing"),
        NODE_USE_ENV_PROXY: "1",
        HTTPS_PROXY: "http://127.0.0.1:7897",
        ...(nodeOptions ? { NODE_OPTIONS: nodeOptions } : {}),
      };
      const originalEnvironment = { ...environment };
      const spawnImplementation = vi.fn(() => exitingChild());
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      vi.spyOn(console, "warn").mockImplementation(() => undefined);

      await expect(
        runDevelopmentDesktop({
          root,
          platform: "win32",
          nodePath,
          environment,
          spawnImplementation,
        }),
      ).resolves.toBe(0);

      // Cleanup, build and Launcher all pass the same selective suppression
      // to their children, without disabling the proxy or changing the caller.
      expect(spawnImplementation).toHaveBeenCalledTimes(4);
      for (const [, , options] of spawnImplementation.mock.calls) {
        expect(options.env).toMatchObject({
          NODE_OPTIONS: [nodeOptions, "--disable-warning=UNDICI-EHPA"].filter(Boolean).join(" "),
          NODE_USE_ENV_PROXY: "1",
          HTTPS_PROXY: environment.HTTPS_PROXY,
        });
      }
      expect(environment).toEqual(originalEnvironment);
    },
  );

  it("skips builds only when explicitly requested", async () => {
    const root = temporaryDirectory();
    const nodePath = path.join(root, "node.exe");
    const artifacts = materializeArtifacts(root, "win32", nodePath);
    const invocations = [];
    const spawnImplementation = vi.fn((command, arguments_, options) => {
      invocations.push({ command, arguments: arguments_, options });
      return exitingChild();
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(
      runDevelopmentDesktop({
        arguments_: ["--no-build"],
        root,
        platform: "win32",
        nodePath,
        environment: { PATH: path.join(root, "missing") },
        spawnImplementation,
      }),
    ).resolves.toBe(0);

    expect(invocations).toHaveLength(3);
    expect(invocations[0].command).toBe("powershell.exe");
    expect(invocations[1].arguments.slice(0, 2)).toEqual(["host", "restart"]);
    expect(invocations[2]).toMatchObject({
      command: artifacts.launcher,
      arguments: expect.arrayContaining(["launch"]),
      options: expect.objectContaining({
        cwd: root,
        stdio: ["ignore", "pipe", "inherit"],
      }),
    });
  });

  it("returns on the launcher ready signal without waiting for it to exit", async () => {
    const root = temporaryDirectory();
    const nodePath = path.join(root, "node.exe");
    const artifacts = materializeArtifacts(root, "win32", nodePath);
    const invocations = [];
    let launcherChild;
    const spawnImplementation = vi.fn((command, arguments_, options) => {
      invocations.push({ command, arguments: arguments_, options });
      if (command === artifacts.launcher && arguments_[0] === "launch") {
        launcherChild = readyChild();
        return launcherChild;
      }
      return exitingChild();
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(
      runDevelopmentDesktop({
        arguments_: ["--no-build"],
        root,
        platform: "win32",
        nodePath,
        environment: { PATH: path.join(root, "missing") },
        spawnImplementation,
      }),
    ).resolves.toBe(0);

    expect(invocations).toHaveLength(3);
    expect(invocations[2].command).toBe(artifacts.launcher);
    expect(launcherChild.unref).toHaveBeenCalled();
  });

  it("propagates a launcher failure when it exits without ready", async () => {
    const root = temporaryDirectory();
    const nodePath = path.join(root, "node.exe");
    materializeArtifacts(root, "win32", nodePath);
    const spawnImplementation = vi.fn((command, args) => {
      if (command === path.join(root, "target", "debug", "codexhost.exe") && args[0] === "launch") {
        return exitingChild(9);
      }
      return exitingChild();
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(
      runDevelopmentDesktop({
        arguments_: ["--no-build"],
        root,
        platform: "win32",
        nodePath,
        environment: { PATH: path.join(root, "missing") },
        spawnImplementation,
      }),
    ).resolves.toBe(9);
  });
});
