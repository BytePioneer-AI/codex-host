import { describe, expect, it, vi } from "vitest";

import { createHarnessInstaller } from "@codexhost/harness-discovery";
import type * as HarnessDiscovery from "@codexhost/harness-discovery";
import { createHarnessAdapter } from "../src/plugin.js";

vi.mock("@codexhost/harness-discovery", async (importOriginal) => ({
  ...(await importOriginal<typeof HarnessDiscovery>()),
  createHarnessInstaller: vi.fn(() => vi.fn(async () => undefined)),
}));

describe("OpenCode plugin construction policy", () => {
  it("installs @opencode/cli, the package that provides the opencode command", () => {
    const environment = { PATH: "/synthetic/bin" };
    createHarnessAdapter({ environment, platform: "darwin", managedRemoteHost: false });
    expect(createHarnessInstaller).toHaveBeenCalledExactlyOnceWith(environment, {
      npm: "@opencode/cli",
      allowScripts: "@opencode/cli",
    });
  });
});
