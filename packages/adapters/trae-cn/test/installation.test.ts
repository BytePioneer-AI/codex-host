import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createTraeCnInstallation } from "../src/installation.js";

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "trae-cn-installation-"));
  const app = path.join(directory, "Trae CN.app");
  const root = path.join(app, "Contents", "Resources", "app");
  const discovery = path.join(directory, "discovery");
  await mkdir(root, { recursive: true });
  await mkdir(discovery);
  await writeFile(
    path.join(root, "product.json"),
    JSON.stringify({
      applicationName: "trae-cn",
      appVersion: "3.4.12",
      version: "1.107.1",
    }),
  );
  const endpoint = (appRoot = root) => ({
    protocolVersion: 1,
    instanceId: randomUUID(),
    pid: process.pid,
    port: 1,
    token: "a".repeat(64),
    application: {
      name: "Trae CN",
      version: "9.9.9",
      root: appRoot,
      executable: path.join(app, "Contents", "MacOS", "Trae CN"),
    },
    workspaceFolders: [path.join(directory, "unrelated-workspace")],
  });
  const publish = async (appRoot = root) => {
    const value = endpoint(appRoot);
    await writeFile(
      path.join(discovery, `bridge-${process.pid}-${value.instanceId}.json`),
      JSON.stringify(value),
      { mode: 0o600 },
    );
  };
  const environment = { CODEXHOST_TRAE_CN_BRIDGE_DIR: discovery };
  return {
    directory,
    app,
    root,
    publish,
    environment,
    close: () => rm(directory, { recursive: true, force: true }),
  };
}

describe("TRAE CN application version management", () => {
  it("reads the application version rather than the editor-core version and reports the latest as unknown", async () => {
    const f = await fixture();
    try {
      for (const app of [f.app, f.root]) {
        const installation = createTraeCnInstallation({ app, environment: f.environment });
        expect(await installation("check")).toMatchObject({
          currentVersion: "3.4.12",
          versionKind: "application",
          latestVersion: "Unknown",
          latestVersionKind: "unknown",
          updateAvailable: false,
          canUpdate: false,
          manualUpdateUrl: "https://www.trae.cn/",
        });
        await expect(installation("update")).rejects.toMatchObject({ code: "unsupported" });
      }
    } finally {
      await f.close();
    }
  });
  it("checks an active installation outside the Host cwd without connecting to its Agent", async () => {
    const f = await fixture();
    try {
      await f.publish();
      // Discovery has no HTTP listener. Any native or inspect call would fail.
      expect(await createTraeCnInstallation({ environment: f.environment })("check")).toMatchObject(
        { currentVersion: "3.4.12" },
      );
    } finally {
      await f.close();
    }
  });
  it("does not fall back from a wrong explicit installation or accept the international product", async () => {
    const f = await fixture();
    try {
      await f.publish();
      await expect(
        createTraeCnInstallation({
          app: path.join(f.directory, "missing"),
          environment: f.environment,
        })("check"),
      ).rejects.toMatchObject({ code: "notInstalled" });
      await writeFile(
        path.join(f.root, "product.json"),
        JSON.stringify({ applicationName: "trae", appVersion: "3.4.12" }),
      );
      await expect(
        createTraeCnInstallation({ app: f.app, environment: f.environment })("check"),
      ).rejects.toMatchObject({ code: "notInstalled" });
    } finally {
      await f.close();
    }
  });
  it("requires an explicit selection when multiple running installations are present", async () => {
    const f = await fixture();
    try {
      await f.publish();
      const other = path.join(f.directory, "other", "resources", "app");
      await mkdir(other, { recursive: true });
      await writeFile(
        path.join(other, "product.json"),
        JSON.stringify({ applicationName: "trae-cn", appVersion: "3.4.11" }),
      );
      await f.publish(other);
      await expect(
        createTraeCnInstallation({ environment: f.environment })("check"),
      ).rejects.toMatchObject({ code: "configurationRequired" });
      expect(
        await createTraeCnInstallation({ app: f.app, environment: f.environment })("check"),
      ).toMatchObject({ currentVersion: "3.4.12" });
    } finally {
      await f.close();
    }
  });
  it("rejects relative paths and invalid native version metadata", async () => {
    const f = await fixture();
    try {
      await expect(
        createTraeCnInstallation({ app: "relative", environment: f.environment })("check"),
      ).rejects.toMatchObject({ code: "configurationRequired" });
      await writeFile(
        path.join(f.root, "product.json"),
        JSON.stringify({ applicationName: "trae-cn", appVersion: "unknown", version: "1.107.1" }),
      );
      await expect(
        createTraeCnInstallation({ app: f.app, environment: f.environment })("check"),
      ).rejects.toMatchObject({ code: "notInstalled" });
    } finally {
      await f.close();
    }
  });
});
