import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { harnessPluginManifestSchema } from "@codexhost/shared-contracts";

import { packageMetadata } from "../src/index.js";
import { createHarnessAdapter } from "../src/plugin.js";

const manifest = harnessPluginManifestSchema.parse(
  JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8")),
);

describe("OmO plugin manifest", () => {
  it("declares the reviewed identity and HTTPS links", () => {
    expect(manifest).toMatchObject({
      manifestVersion: 1,
      id: "omo",
      name: "OmO",
      version: "0.0.0",
      adapterApiVersion: 1,
      entry: "./dist/plugin.js",
      icon: "./assets/icon.svg",
    });
    expect(manifest.links).toEqual({
      website: "https://omo.dev/",
      documentation: "https://omo.dev/docs",
      installation: "https://omo.dev/docs/install",
    });
  });

  it("discloses the independent SUL-1.0 product in both locales", () => {
    expect(manifest.notice?.en).toContain("third-party");
    expect(manifest.notice?.en).toContain("SUL-1.0");
    expect(manifest.notice?.en).toContain("trademarks");
    expect(manifest.notice?.["zh-CN"]).toContain("第三方");
    expect(manifest.notice?.["zh-CN"]).toContain("SUL-1.0");
    expect(manifest.notice?.["zh-CN"]).toContain("商标");
  });

  it("lists the three official installation routes", () => {
    expect(manifest.installation?.commands.map(({ command }) => command)).toEqual([
      "curl -fsSL https://get.omo.dev/install.sh | bash",
      "irm https://get.omo.dev/install.ps1 | iex",
      "bun add -g omo-ai",
    ]);
    expect(manifest.installation?.commands[2]?.terminal).toContain("Node.js 24");
    expect(manifest.installation?.after?.en).toContain("Node.js 24");
    expect(manifest.installation?.after?.["zh-CN"]).toContain("Node.js 24");
  });

  it("ships a self-contained icon without active content", () => {
    const icon = readFileSync(new URL("../assets/icon.svg", import.meta.url), "utf8");
    expect(icon.trimStart().startsWith("<svg")).toBe(true);
    expect(icon).not.toMatch(/<script|onload=/iu);
    expect(Buffer.byteLength(icon)).toBeLessThan(128 * 1024);
  });
});

describe("OmO plugin factory", () => {
  it("constructs the Adapter with version management but no automatic install", async () => {
    const adapter = createHarnessAdapter({
      environment: {},
      platform: process.platform,
      managedRemoteHost: false,
    });
    expect(adapter.harnessId).toBe("omo");
    expect(typeof adapter.installation).toBe("function");
    expect("install" in adapter).toBe(false);
    expect(packageMetadata).toMatchObject({
      name: "@codexhost/adapter-omo",
      adapterContract: "@codexhost/harness-adapter",
    });
    await adapter.close();
  });

  it("passes CODEXHOST_OMO_COMMAND through to availability inspection", async () => {
    const missing = path.join(os.tmpdir(), `omo-plugin-${process.pid}`, "omo.exe");
    const adapter = createHarnessAdapter({
      environment: { PATH: "", CODEXHOST_OMO_COMMAND: missing },
      platform: process.platform,
      managedRemoteHost: false,
    });
    await expect(adapter.inspect()).resolves.toMatchObject({ status: "notInstalled" });
    await adapter.close();
  });
});
