import { beforeEach, describe, expect, it, vi } from "vitest";

import { createHarnessInstaller } from "@codexhost/harness-discovery";
import type * as HarnessDiscovery from "@codexhost/harness-discovery";
import { DeepSeekHarnessAdapter } from "../src/deepseek-harness-adapter.js";
import { createHarnessAdapter } from "../src/plugin.js";

vi.mock("../src/deepseek-harness-adapter.js", () => ({
  DeepSeekHarnessAdapter: vi.fn(function () {}),
}));

vi.mock("@codexhost/harness-discovery", async (importOriginal) => ({
  ...(await importOriginal<typeof HarnessDiscovery>()),
  createHarnessInstaller: vi.fn(() => vi.fn(async () => undefined)),
}));

beforeEach(() => vi.clearAllMocks());

describe("DeepSeek plugin construction policy", () => {
  it.each(["auto", "desktop", "web"] as const)(
    "applies saved %s mode ahead of the environment override",
    (connectionMode) => {
      const environment = { CODEXHOST_DEEPSEEK_HARNESS_CONNECTION_MODE: "desktop" };
      createHarnessAdapter({
        environment,
        platform: "darwin",
        managedRemoteHost: false,
        connectionMode,
      });
      expect(DeepSeekHarnessAdapter).toHaveBeenCalledWith({ environment, connectionMode });
    },
  );

  it("uses the environment mode when no saved preference exists", () => {
    const environment = { CODEXHOST_DEEPSEEK_HARNESS_CONNECTION_MODE: "web" };
    createHarnessAdapter({ environment, platform: "darwin", managedRemoteHost: false });
    expect(DeepSeekHarnessAdapter).toHaveBeenCalledWith({ environment, connectionMode: "web" });
  });
  it("installs the npm latest tag instead of pinning an older release", () => {
    const environment = { PATH: "/synthetic/bin" };
    createHarnessAdapter({ environment, platform: "darwin", managedRemoteHost: false });
    expect(createHarnessInstaller).toHaveBeenCalledExactlyOnceWith(environment, {
      npm: "@deepseek-ai/dsh@latest",
    });
  });

  it("preserves the explicit command, endpoint, environment and local Web UI handoff", async () => {
    const environment = {
      CODEXHOST_DEEPSEEK_HARNESS_COMMAND: "/synthetic/dsh",
      CODEXHOST_DEEPSEEK_HARNESS_ENDPOINT: "http://127.0.0.1:12345",
      CODEXHOST_RUNTIME_TOKEN: "synthetic-token",
    };
    const openLocalUrl = vi.fn(async () => undefined);
    createHarnessAdapter({
      environment,
      platform: "darwin",
      managedRemoteHost: false,
      openLocalUrl,
    });
    expect(DeepSeekHarnessAdapter).toHaveBeenCalledWith({
      command: environment.CODEXHOST_DEEPSEEK_HARNESS_COMMAND,
      endpoint: environment.CODEXHOST_DEEPSEEK_HARNESS_ENDPOINT,
      environment,
      openWebUi: expect.any(Function),
    });
    const options = vi.mocked(DeepSeekHarnessAdapter).mock.calls[0]?.[0];
    expect(options?.environment).not.toBe(environment);
    if (!options?.openWebUi) throw new Error("Expected local Web UI handoff");
    await options.openWebUi(new URL("http://127.0.0.1:12345/"));
    expect(openLocalUrl).toHaveBeenCalledExactlyOnceWith("http://127.0.0.1:12345/");
  });

  it("never exposes a local URL opener to a managed remote Adapter", () => {
    createHarnessAdapter({
      environment: {},
      platform: "darwin",
      managedRemoteHost: true,
      openLocalUrl: vi.fn(),
    });
    expect(DeepSeekHarnessAdapter).toHaveBeenCalledExactlyOnceWith({ environment: {} });
  });
});
