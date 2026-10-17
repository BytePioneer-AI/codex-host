import path from "node:path";
import { pathToFileURL } from "node:url";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import {
  createRemoteOfficialAppServerPlan,
  delegationCliEnvironment,
  hasLauncherManagedUpdateRuntime,
  MANAGED_REMOTE_APP_SERVER_PROCESS_TITLE,
  resolveHostRuntimePaths,
} from "../src/run-host-runtime.js";

describe("Host Runtime composition", () => {
  it("pins a directly launched remote Runtime to its own packaged CLI and Node", () => {
    const root = mkdtempSync(path.join(tmpdir(), "cx-runtime-cli-"));
    const runtime = path.join(root, "app", "host-runtime.mjs");
    const launcher = path.join(
      root,
      "bin",
      process.platform === "win32" ? "codexhost.exe" : "codexhost",
    );
    try {
      expect(delegationCliEnvironment({}, runtime)).toEqual({});
      mkdirSync(path.dirname(launcher), { recursive: true });
      writeFileSync(launcher, "synthetic executable");
      expect(delegationCliEnvironment({}, runtime)).toEqual({
        CODEXHOST_CLI_PATH: launcher,
        CODEXHOST_CLI_NODE_PATH: process.execPath,
      });
      expect(
        delegationCliEnvironment(
          { CODEXHOST_CLI_PATH: "/explicit/cli", CODEXHOST_CLI_NODE_PATH: process.execPath },
          runtime,
        ),
      ).toEqual({
        CODEXHOST_CLI_PATH: "/explicit/cli",
        CODEXHOST_CLI_NODE_PATH: process.execPath,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
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

  it("keeps application updates off for a source launch while runtime maintenance stays on", () => {
    const sourceRuntime = path.resolve("repo", "packages", "host-runtime", "dist", "main.js");
    const environment = {
      CODEXHOST_LAUNCHER_PID: "4321",
      CODEXHOST_HOST_RUNTIME_PATH: sourceRuntime,
    };

    expect(resolveHostRuntimePaths({ environment })).toEqual({
      packaged: undefined,
      maintenance: sourceRuntime,
    });

    const packagedRuntime = path.resolve("opt", "codexhost", "app", "host-runtime.mjs");
    expect(
      resolveHostRuntimePaths({
        environment,
        hostRuntimeUrl: pathToFileURL(packagedRuntime).href,
      }),
    ).toEqual({ packaged: packagedRuntime, maintenance: packagedRuntime });
    expect(resolveHostRuntimePaths({ environment: {} })).toEqual({
      packaged: undefined,
      maintenance: undefined,
    });
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
