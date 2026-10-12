import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import { OfficialRuntimeClient } from "../src/codex-runtime/official-runtime-scope.js";
import { prepareLocalCodex } from "../src/native-account-host.js";

const stockCodexPath = process.env.CODEXHOST_TEST_STOCK_CODEX_PATH;

describe.skipIf(!stockCodexPath)("native identity reader with the installed Codex CLI", () => {
  it("preserves Desktop's process originator at startup and after backend replacement", async () => {
    if (!stockCodexPath) throw new Error("Missing test Codex CLI path");
    const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-originator-test-"));
    const diagnosticOutput = new PassThrough();
    diagnosticOutput.resume();
    let local: Awaited<ReturnType<typeof prepareLocalCodex>> | undefined;
    let desktop: OfficialRuntimeClient | undefined;
    try {
      // Empty native storage: no credentials, account API requests, or user configuration.
      local = await prepareLocalCodex({
        stockCodexPath,
        arguments: ["app-server"],
        environment: { ...process.env, CODEX_HOME: directory },
        diagnosticOutput,
      });
      desktop = new OfficialRuntimeClient({
        scope: local.officialRuntimeScope,
        output: async () => {},
      });
      const params = {
        clientInfo: { name: "Codex Desktop", version: "originator-test" },
        capabilities: { experimentalApi: true },
      };
      const initialized = await desktop.initializeProtocol(params);
      expect(initialized).toMatchObject({
        result: { userAgent: expect.stringMatching(/^Codex Desktop\//) },
      });
      expect(await local.accountControl.refresh?.()).toMatchObject({
        phase: "ready",
        currentAccountId: null,
        accounts: [],
      });

      await local.officialRuntimeScope.owner.stop();
      await local.officialRuntimeScope.start();
      expect(await desktop.initializeProtocol(params)).toMatchObject({
        result: { userAgent: expect.stringMatching(/^Codex Desktop\//) },
      });
      expect(await local.accountControl.refresh?.()).toMatchObject({ phase: "ready" });
    } finally {
      await desktop?.close();
      await local?.close();
      diagnosticOutput.destroy();
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
