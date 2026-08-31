import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { OpenCodeAdapter } from "../src/index.js";

const command = process.env.CODEXHOST_OPENCODE_REAL_COMMAND;

describe.runIf(Boolean(command))("OpenCode Adapter real Server", () => {
  it("inspects and opens an isolated latest-CLI Session without invoking a Model", async () => {
    if (!command) throw new Error("CODEXHOST_OPENCODE_REAL_COMMAND is required");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "codexhost-opencode-real-"));
    const workspace = path.join(root, "workspace");
    await fs.mkdir(workspace, { recursive: true });
    const adapter = new OpenCodeAdapter({
      command,
      startupTimeoutMs: 20_000,
      commandTimeoutMs: 20_000,
      environment: {
        ...process.env,
        OPENCODE_TEST_HOME: path.join(root, "home"),
        OPENCODE_CONFIG_DIR: path.join(root, "config"),
        OPENCODE_DISABLE_PROJECT_CONFIG: "true",
        XDG_DATA_HOME: path.join(root, "data"),
        XDG_CACHE_HOME: path.join(root, "cache"),
        XDG_STATE_HOME: path.join(root, "state"),
      },
    });
    try {
      const inspection = await adapter.inspect({ cwd: workspace, refresh: true });
      if (inspection.status !== "ready") {
        throw new Error(`OpenCode inspection failed: ${JSON.stringify(inspection)}`);
      }
      expect(inspection).toMatchObject({
        status: "ready",
        capabilities: {
          configuration: { selectPermissionMode: false },
          history: { fork: true, forkAcrossCwd: false, rollbackLastTurn: true },
        },
      });
      const opened = await adapter.open({
        kind: "create",
        cwd: workspace,
        executionPolicy: "unattended-full-access",
      });
      if (!opened.ok) throw new Error(opened.error.message);
      expect(opened.value.initialState.nativeRef).toMatchObject({
        harnessId: "opencode",
        locator: {
          directory: await fs.realpath(workspace),
          executionPolicy: "unattended-full-access",
        },
      });
      await expect(opened.value.readSnapshot()).resolves.toMatchObject({
        ok: true,
        value: { turns: [] },
      });
      if (!opened.value.commands) throw new Error("OpenCode Session did not expose commands");
      await expect(opened.value.commands.list()).resolves.toMatchObject({ ok: true });
      const nativeRef = opened.value.initialState.nativeRef;
      if (!nativeRef) throw new Error("OpenCode Session did not expose a Native Ref");
      await opened.value.close();
      const resumed = await adapter.open({ kind: "resume", nativeRef, cwd: workspace });
      if (!resumed.ok) throw new Error(resumed.error.message);
      await expect(resumed.value.readSnapshot()).resolves.toMatchObject({
        ok: true,
        value: { turns: [] },
      });
      await resumed.value.close();
    } finally {
      await adapter.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 45_000);
});
