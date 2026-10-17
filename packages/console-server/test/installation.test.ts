import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  installedLauncherCandidates,
  launchCommand,
  parseInspectDocument,
  resolveLauncherExecutable,
  type ConsoleInstallation,
} from "../src/installation.js";

describe("console installation", () => {
  it("finds the Launcher beside release payloads", () => {
    expect(installedLauncherCandidates("/opt/codexhost/app", "linux")).toEqual([
      path.join("/opt/codexhost", "bin", "codexhost"),
    ]);
    expect(
      installedLauncherCandidates(
        "/Applications/codexhost.app/Contents/Resources/app",
        "darwin",
      )[0],
    ).toBe(path.join("/Applications/codexhost.app/Contents", "MacOS", "codexhost"));
    expect(installedLauncherCandidates("C:/codexhost/app", "win32")[0]).toBe(
      path.join("C:/codexhost", "bin", "codexhost.exe"),
    );
  });

  it("prefers the Launcher handed over by the caller", () => {
    const configured = path.resolve("/custom/codexhost");
    expect(
      resolveLauncherExecutable(
        "/opt/codexhost/app",
        { CODEXHOST_LAUNCHER_EXECUTABLE: configured },
        "linux",
        (candidate) => candidate === configured,
      ),
    ).toBe(configured);
    expect(resolveLauncherExecutable("/opt/codexhost/app", {}, "linux", () => false)).toBeNull();
  });

  it("starts npm installations through the npm wrapper", () => {
    const installation: ConsoleInstallation = {
      appDirectory: "/pkg/app",
      distribution: {
        schemaVersion: 1,
        version: "1.0.0",
        distribution: "npm",
        target: "linux-x64",
      },
      launcherExecutable: "/pkg/bin/codexhost",
    };
    expect(
      launchCommand(installation, {
        CODEXHOST_NPM_NODE_PATH: path.resolve("/usr/bin/node"),
        CODEXHOST_NPM_LAUNCHER_PATH: path.resolve("/lib/cli/bin/codexhost.js"),
      }),
    ).toEqual({
      command: path.resolve("/usr/bin/node"),
      args: [path.resolve("/lib/cli/bin/codexhost.js")],
    });
    expect(launchCommand(installation, {})).toBeNull();
    expect(launchCommand({ ...installation, distribution: null }, {})).toEqual({
      command: "/pkg/bin/codexhost",
      args: ["launch"],
    });
  });

  it.each(["macos-arm64", "windows-x64"] as const)(
    "starts %s installer builds without the browser-opening no-argument entrypoint",
    (target) => {
      const launcher = path.resolve("/installed/codexhost");
      expect(
        launchCommand(
          {
            appDirectory: path.resolve("/installed/app"),
            distribution: { schemaVersion: 1, version: "1.0.0", distribution: "installer", target },
            launcherExecutable: launcher,
          },
          {},
        ),
      ).toEqual({ command: launcher, args: ["launch"] });
    },
  );

  it("rejects inspect output from an unknown schema", () => {
    expect(() => parseInspectDocument({ schemaVersion: 2, runtime: {} })).toThrow("schema");
  });

  it("preserves CLI selection diagnostics while accepting older schema v1 launchers", () => {
    const document = {
      schemaVersion: 1,
      launcherVersion: "1.0.0",
      launcherExecutable: "/installed/codexhost",
      desktop: {
        platform: "linux",
        version: "1.2.3",
        build: "1.2.3",
        installRoot: "/usr/lib/chatgpt",
        processIds: [],
      },
      desktopError: null,
      runtime: { descriptorPath: null, running: false, launcherPid: null },
    };
    expect(parseInspectDocument(document).desktop?.executableCodexCli).toBeUndefined();
    const selected = {
      ...document,
      desktop: {
        ...document.desktop,
        packagedCodexCli: "/usr/lib/chatgpt/resources/codex",
        executableCodexCli: "/independent/codex",
        codexCliSource: "command-line",
      },
    };
    expect(parseInspectDocument(selected).desktop).toEqual(selected.desktop);
  });
});
