import path from "node:path";

import { describe, expect, it } from "vitest";

import { hasLauncherManagedUpdateRuntime } from "../src/run-host-runtime.js";

describe("Host Runtime composition", () => {
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
