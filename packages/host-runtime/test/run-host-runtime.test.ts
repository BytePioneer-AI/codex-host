import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  createRemoteControlOfficialAppServerPlan,
  createRemoteOfficialAppServerPlan,
  delegationCliPath,
  hasLauncherManagedUpdateRuntime,
  MANAGED_REMOTE_APP_SERVER_PROCESS_TITLE,
} from "../src/run-host-runtime.js";

describe("Host Runtime composition", () => {
  it("keeps the managed listener outside the official Desktop bootstrap kill selector", () => {
    const officialDesktopBootstrapKillSelector = /codex.*desktop-ssh-websocket-v0\.sock/;

    expect(MANAGED_REMOTE_APP_SERVER_PROCESS_TITLE).not.toMatch(
      officialDesktopBootstrapKillSelector,
    );
  });

  it("shares one official listener across every remote Host session", () => {
    expect(
      createRemoteOfficialAppServerPlan(
        ["app-server", "--listen", "unix://", "--analytics-default-enabled"],
        "/Users/developer/.codex/app-server-control/app-server-control.sock",
        "fixture1234",
      ),
    ).toEqual({
      socketPath: "/Users/developer/.codex/app-server-control/.c-fixture1234.sock",
      listenerArguments: [
        "app-server",
        "--listen",
        "unix:///Users/developer/.codex/app-server-control/.c-fixture1234.sock",
        "--analytics-default-enabled",
      ],
    });
  });

  it("uses one dynamic loopback listener for the Windows Desktop and Remote Control sessions", () => {
    expect(
      createRemoteControlOfficialAppServerPlan([
        "-c",
        "features.code_mode_host=true",
        "app-server",
        "--analytics-default-enabled",
      ]),
    ).toEqual({
      listenerArguments: [
        "-c",
        "features.code_mode_host=true",
        "app-server",
        "--listen",
        "ws://127.0.0.1:0",
        "--analytics-default-enabled",
      ],
    });
  });

  it("advertises the npm Node launcher instead of its native launcher", () => {
    // An npm installation ships no `runtime/` directory, so the native launcher
    // aborts with a missing-file error before it reaches the delegation CLI.
    // The Node launcher resolves its own Node runtime and works.
    const npmLauncher = path.resolve(
      "npm",
      "node_modules",
      "@codexhost",
      "cli",
      "bin",
      "codexhost.js",
    );
    const nativeLauncher = path.resolve(
      "npm",
      "node_modules",
      "@codexhost",
      "cli-darwin-arm64",
      "bin",
      "codexhost",
    );

    expect(
      delegationCliPath({
        CODEXHOST_NPM_LAUNCHER_PATH: npmLauncher,
        CODEXHOST_LAUNCHER_EXECUTABLE: nativeLauncher,
      }),
    ).toBe(npmLauncher);
  });

  it("keeps the packaged launcher when npm did not provide one", () => {
    const packaged = path.resolve(
      "Applications",
      "codexhost.app",
      "Contents",
      "MacOS",
      "codexhost",
    );

    expect(delegationCliPath({ CODEXHOST_LAUNCHER_EXECUTABLE: packaged })).toBe(packaged);
    expect(delegationCliPath({})).toBeUndefined();
  });

  it("lets an explicit CLI path override every launcher", () => {
    const explicit = path.resolve("custom", "codexhost");

    expect(
      delegationCliPath({
        CODEXHOST_CLI_PATH: explicit,
        CODEXHOST_NPM_LAUNCHER_PATH: path.resolve("npm", "codexhost.js"),
        CODEXHOST_LAUNCHER_EXECUTABLE: path.resolve("native", "codexhost"),
      }),
    ).toBe(explicit);
  });

  it("disables launcher-owned updates for a direct SSH Host invocation", () => {
    expect(hasLauncherManagedUpdateRuntime({})).toBe(false);
    expect(
      hasLauncherManagedUpdateRuntime({
        CODEXHOST_LAUNCHER_PID: "4321",
      }),
    ).toBe(true);
  });

  it("disables npm updates when a copied remote Host Runtime is outside the npm package root", () => {
    const packageRoot = path.resolve("global", "platform-package");
    const remoteRuntime = path.resolve("remote", "runtime", "app", "host-runtime.mjs");
    const environment = {
      CODEXHOST_LAUNCHER_PID: "4321",
      CODEXHOST_NPM_PACKAGE_ROOT: packageRoot,
    };

    expect(hasLauncherManagedUpdateRuntime(environment, remoteRuntime)).toBe(false);
    expect(
      hasLauncherManagedUpdateRuntime(
        environment,
        path.join(packageRoot, "app", "host-runtime.mjs"),
      ),
    ).toBe(true);
  });
});
