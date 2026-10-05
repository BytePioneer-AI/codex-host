import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  createRemoteOfficialAppServerPlan,
  delegationCliEnvironment,
  externalUiEnabled,
  hasLauncherManagedUpdateRuntime,
  MANAGED_REMOTE_APP_SERVER_PROCESS_TITLE,
} from "../src/run-host-runtime.js";

describe("Host Runtime composition", () => {
  it("keeps the native Launcher as the CLI and supplies npm's Node only when present", () => {
    const launcher = path.resolve("/opt/codexhost/bin/codexhost");
    const node = path.resolve("/usr/local/bin/node");

    expect(delegationCliEnvironment({ CODEXHOST_LAUNCHER_EXECUTABLE: launcher })).toEqual({
      CODEXHOST_CLI_PATH: launcher,
    });
    expect(
      delegationCliEnvironment({
        CODEXHOST_LAUNCHER_EXECUTABLE: launcher,
        CODEXHOST_NPM_NODE_PATH: node,
      }),
    ).toEqual({ CODEXHOST_CLI_PATH: launcher, CODEXHOST_CLI_NODE_PATH: node });
    expect(
      delegationCliEnvironment({
        CODEXHOST_LAUNCHER_EXECUTABLE: launcher,
        CODEXHOST_NPM_NODE_PATH: "node",
      }),
    ).toEqual({ CODEXHOST_CLI_PATH: launcher });
    expect(delegationCliEnvironment({})).toEqual({});
  });


  it("enables External UI for local Launcher hosts with an explicit opt-out", () => {
    expect(externalUiEnabled({})).toBe(false);
    expect(externalUiEnabled({ CODEXHOST_EXTERNAL_UI: "1" })).toBe(true);
    expect(
      externalUiEnabled({ CODEXHOST_LAUNCHER_EXECUTABLE: "/Applications/codexhost.app/launcher" }),
    ).toBe(true);
    expect(
      externalUiEnabled({
        CODEXHOST_LAUNCHER_EXECUTABLE: "/Applications/codexhost.app/launcher",
        CODEXHOST_EXTERNAL_UI: "0",
      }),
    ).toBe(false);
    expect(
      externalUiEnabled({
        CODEXHOST_LAUNCHER_EXECUTABLE: "/opt/codexhost/bin/codexhost",
        CODEXHOST_REMOTE_SSH_MANAGED: "1",
      }),
    ).toBe(false);
  });

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
