import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  harnessPluginManifestSchema,
  HARNESS_PLUGIN_API_VERSION,
} from "@codexhost/shared-contracts";
import { createHarnessAdapter } from "../src/plugin.js";
import { BridgeClient } from "../src/bridge.js";
import type { BridgeInspection } from "../src/protocol.js";

const inspection: BridgeInspection = {
  instanceId: "native-instance",
  application: {
    name: "Trae CN",
    version: "fixture",
    root: "/app/resources/app",
    executable: "/app/Trae CN",
  },
  workspaceFolders: ["/workspace"],
  agentType: "builder_v3",
  models: [{ id: "seed", label: "Seed", provider: "native", multimodal: false }],
};
afterEach(() => vi.restoreAllMocks());

describe("TRAE CN plugin factory", () => {
  it("declares the same public identity, API and emitted entry as its Adapter", () => {
    const manifest = harnessPluginManifestSchema.parse(
      JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8")),
    );
    expect(manifest).toMatchObject({
      id: "trae-cn",
      adapterApiVersion: HARNESS_PLUGIN_API_VERSION,
      entry: "./dist/plugin.js",
      launchCommand: true,
    });
    expect(manifest.installation?.after?.["zh-CN"]).toContain("不使用独立 Trae CLI");
  });
  it("copies construction environment, preserves the explicit app selection and stays cold until inspect", async () => {
    const close = vi.fn();
    const connect = vi
      .spyOn(BridgeClient, "connect")
      .mockResolvedValue({ client: { close } as unknown as BridgeClient, inspection });
    const environment = {
      CODEXHOST_TRAE_CN_BRIDGE_DIR: "/original-bridge",
      CODEXHOST_TRAE_CN_APP: "/fallback-app",
    };
    const first = createHarnessAdapter({
      environment,
      launchCommand: "/selected-app",
      platform: "win32",
      managedRemoteHost: false,
    });
    const second = createHarnessAdapter({
      environment,
      platform: "win32",
      managedRemoteHost: false,
    });
    expect(connect).not.toHaveBeenCalled();
    environment.CODEXHOST_TRAE_CN_BRIDGE_DIR = "/changed-bridge";
    expect((await first.inspect({ cwd: "/workspace" })).status).toBe("ready");
    expect(connect).toHaveBeenNthCalledWith(1, {
      cwd: "/workspace",
      environment: {
        CODEXHOST_TRAE_CN_BRIDGE_DIR: "/original-bridge",
        CODEXHOST_TRAE_CN_APP: "/fallback-app",
      },
      app: "/selected-app",
    });
    await first.close();
    expect(await first.inspect()).toMatchObject({
      status: "unavailable",
      error: { code: "invalidState" },
    });
    expect((await second.inspect({ cwd: "/workspace" })).status).toBe("ready");
    expect(connect).toHaveBeenNthCalledWith(2, {
      cwd: "/workspace",
      environment: {
        CODEXHOST_TRAE_CN_BRIDGE_DIR: "/original-bridge",
        CODEXHOST_TRAE_CN_APP: "/fallback-app",
      },
      app: "/fallback-app",
    });
    await second.close();
    expect(close).toHaveBeenCalledTimes(2);
  });
});
