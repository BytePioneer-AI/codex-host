import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { harnessInspectionSchema } from "@codexhost/shared-contracts";

import { OmoAdapter } from "../src/omo-adapter.js";

describe("OmO Adapter availability", () => {
  it("reports notInstalled when no omo executable resolves", async () => {
    const adapter = new OmoAdapter({
      environment: { PATH: "" },
      discovery: {
        platform: process.platform,
        homeDirectory: path.join(os.tmpdir(), "omo-no-home"),
        isExecutable: () => false,
        subdirectories: () => [],
      },
    });
    const inspection = await adapter.inspect();
    expect(harnessInspectionSchema.parse(inspection)).toMatchObject({
      status: "notInstalled",
      error: { code: "notInstalled", retryable: false },
    });
    await adapter.close();
  });

  it("reports ready with honest empty capabilities when the CLI resolves", async () => {
    const adapter = new OmoAdapter({ resolveExecutable: () => "/fake/omo" });
    const inspection = await adapter.inspect({ purpose: "availability" });
    expect(inspection).toMatchObject({
      status: "ready",
      catalog: { models: [], thinkingOptions: [] },
      capabilities: {
        configuration: {
          selectModel: false,
          selectThinkingOption: false,
          selectPermissionMode: false,
          permissionModeScope: "live",
        },
        history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
      },
    });
    expect(harnessInspectionSchema.parse(inspection)).toEqual(inspection);
    await adapter.close();
  });

  it("treats a configured but unusable command as not installed, not a crash", async () => {
    const missing = path.join(os.tmpdir(), "omo missing path", 'om"o', "omo.exe");
    const adapter = new OmoAdapter({
      environment: { PATH: "", CODEXHOST_OMO_COMMAND: `"${missing}"` },
    });
    await expect(adapter.inspect()).resolves.toMatchObject({
      status: "notInstalled",
      error: { code: "notInstalled", retryable: false },
    });
    await adapter.close();
  });

  it("returns a typed unsupported result when opening a Session", async () => {
    const adapter = new OmoAdapter({ resolveExecutable: () => "/fake/omo" });
    await expect(adapter.open({ kind: "create", cwd: os.tmpdir() })).resolves.toMatchObject({
      ok: false,
      error: { code: "unsupported", retryable: false },
    });
    await adapter.close();
  });

  it("closes idempotently and rejects later work as invalid state", async () => {
    const adapter = new OmoAdapter({ resolveExecutable: () => "/fake/omo" });
    await Promise.all([adapter.close(), adapter.close()]);
    await expect(adapter.close()).resolves.toBeUndefined();
    await expect(adapter.inspect()).resolves.toMatchObject({
      status: "unavailable",
      error: { code: "invalidState" },
    });
    await expect(adapter.open({ kind: "create", cwd: os.tmpdir() })).resolves.toMatchObject({
      ok: false,
      error: { code: "invalidState" },
    });
  });
});
