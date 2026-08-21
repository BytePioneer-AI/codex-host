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
});
