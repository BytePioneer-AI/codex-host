import { describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { HarnessInspection } from "@codexhost/harness-adapter";
import {
  CLAUDE_CODE_COMMAND_ENV,
  GROK_COMMAND_ENV,
  HARNESS_CONFIG_ENV,
  createExternalHarnessAdapters,
  prefetchClaudeCodeModelCatalog,
} from "../src/index.js";

describe("Host external Harness composition", () => {
  it("starts Claude Catalog prefetch immediately without waiting for it", async () => {
    let finish = (): void => undefined;
    const inspection = new Promise<HarnessInspection>((resolve) => {
      finish = () => resolve({} as HarnessInspection);
    });
    const inspect = vi.fn(() => inspection);
    const adapters = new Map([["claude-code", { inspect }]] as const);

    const prefetch = prefetchClaudeCodeModelCatalog(adapters);

    expect(inspect).toHaveBeenCalledOnce();
    finish();
    await expect(prefetch).resolves.toBeUndefined();
  });

  it("isolates a missing or failed Claude prefetch from Host startup", async () => {
    await expect(prefetchClaudeCodeModelCatalog(new Map())).resolves.toBeUndefined();
    const inspect = vi.fn(() => {
      throw new Error("synthetic inspection failure");
    });

    await expect(
      prefetchClaudeCodeModelCatalog(new Map([["claude-code", { inspect }]] as const)),
    ).resolves.toBeUndefined();
  });

  it("registers all external Harnesses by default without resolving executables", async () => {
    const adapters = createExternalHarnessAdapters({ PATH: "" });

    expect([...adapters.keys()]).toEqual([
      "pi",
      "claude-code",
      "deepseek-harness",
      "grok",
      "gemini",
      "omp",
    ]);
    expect(adapters.get("claude-code")?.harnessId).toBe("claude-code");
    expect(adapters.get("deepseek-harness")?.harnessId).toBe("deepseek-harness");
    expect(adapters.get("omp")?.harnessId).toBe("omp");
    expect(adapters.get("grok")?.harnessId).toBe("grok");
    expect(adapters.get("gemini")?.harnessId).toBe("gemini");
    await Promise.all([...adapters.values()].map((adapter) => adapter.close()));
  });

  it("loads Gemini endpoint and model settings from the per-Harness config file", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-config-"));
    const configPath = path.join(directory, "harnesses.json");
    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        harnesses: {
          gemini: {
            command: "/synthetic/gemini",
            baseUrl: "https://gateway.example.test/v1",
            apiKeyEnv: "MY_GEMINI_KEY",
            model: "gemini-2.5-pro",
            models: ["gemini-2.5-pro"],
          },
        },
      }),
    );
    const adapters = createExternalHarnessAdapters({
      PATH: "",
      MY_GEMINI_KEY: "secret",
      [HARNESS_CONFIG_ENV]: configPath,
    });
    await expect(adapters.get("gemini")?.inspect()).resolves.toMatchObject({
      status: "notInstalled",
      error: { code: "notInstalled" },
    });
    await Promise.all([...adapters.values()].map((adapter) => adapter.close()));
    await rm(directory, { recursive: true, force: true });
  });

  it("preserves an explicit user-installed Grok command", async () => {
    const adapters = createExternalHarnessAdapters({
      PATH: "",
      [GROK_COMMAND_ENV]: "/synthetic/grok",
    });

    await expect(adapters.get("grok")?.inspect()).resolves.toMatchObject({
      status: "notInstalled",
      error: { code: "notInstalled" },
    });
    await Promise.all([...adapters.values()].map((adapter) => adapter.close()));
  });

  it("preserves an explicit user-installed Claude Code command", async () => {
    const adapters = createExternalHarnessAdapters({
      PATH: "",
      [CLAUDE_CODE_COMMAND_ENV]: "/synthetic/claude",
    });

    await expect(adapters.get("claude-code")?.inspect()).resolves.toMatchObject({
      status: "notInstalled",
      error: { code: "notInstalled" },
    });
    await Promise.all([...adapters.values()].map((adapter) => adapter.close()));
  });
});
