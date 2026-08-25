import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  createRemoteOfficialAppServerPlan,
  hasLauncherManagedUpdateRuntime,
} from "../src/run-host-runtime.js";

describe("Host Runtime composition", () => {
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
