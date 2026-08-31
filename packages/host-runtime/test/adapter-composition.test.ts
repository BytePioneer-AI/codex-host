import { describe, expect, it, vi } from "vitest";

import { ClaudeCodeAdapter } from "@codexhost/adapter-claude-code";
import { DeepSeekHarnessAdapter } from "@codexhost/adapter-deepseek-harness";
import { GrokAdapter } from "@codexhost/adapter-grok";
import { OmpAdapter } from "@codexhost/adapter-omp";
import { PiAdapter } from "@codexhost/adapter-pi";
import type { HarnessInspection } from "@codexhost/harness-adapter";
import { FakeHarnessAdapter } from "@codexhost/harness-adapter/testing";
import {
  CLAUDE_CODE_COMMAND_ENV,
  FAKE_HARNESS_ENV,
  GROK_COMMAND_ENV,
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

    expect([...adapters.keys()]).toEqual(["pi", "claude-code", "deepseek-harness", "grok", "omp"]);
    expect(adapters.get("pi")).toBeInstanceOf(PiAdapter);
    expect(adapters.get("claude-code")).toBeInstanceOf(ClaudeCodeAdapter);
    expect(adapters.get("deepseek-harness")).toBeInstanceOf(DeepSeekHarnessAdapter);
    expect(adapters.get("grok")).toBeInstanceOf(GrokAdapter);
    expect(adapters.get("omp")).toBeInstanceOf(OmpAdapter);
    expect(adapters.get("claude-code")?.harnessId).toBe("claude-code");
    expect(adapters.get("deepseek-harness")?.harnessId).toBe("deepseek-harness");
    expect(adapters.get("omp")?.harnessId).toBe("omp");
    expect(adapters.get("grok")?.harnessId).toBe("grok");
    await Promise.all([...adapters.values()].map((adapter) => adapter.close()));
  });

  it("does not enable the Fake Harness when the environment variable is unset or not 1", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      for (const environment of [{ PATH: "" }, { PATH: "", [FAKE_HARNESS_ENV]: "true" }] as const) {
        const adapters = createExternalHarnessAdapters(environment);
        expect(adapters.get("pi")).toBeInstanceOf(PiAdapter);
        expect(adapters.get("claude-code")).toBeInstanceOf(ClaudeCodeAdapter);
        expect(adapters.get("deepseek-harness")).toBeInstanceOf(DeepSeekHarnessAdapter);
        expect(adapters.get("grok")).toBeInstanceOf(GrokAdapter);
        expect(adapters.get("omp")).toBeInstanceOf(OmpAdapter);
        await Promise.all([...adapters.values()].map((adapter) => adapter.close()));
      }
      expect(stderr).not.toHaveBeenCalledWith(
        expect.stringContaining("Fake Harness Adapter is enabled"),
      );
    } finally {
      stderr.mockRestore();
    }
  });

  it("replaces every external Adapter with FakeHarnessAdapter when CODEXHOST_FAKE_HARNESS is 1", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const adapters = createExternalHarnessAdapters({
        PATH: "",
        [FAKE_HARNESS_ENV]: "1",
      });

      expect([...adapters.keys()]).toEqual(["pi", "claude-code", "deepseek-harness", "grok", "omp"]);
      for (const [harnessId, adapter] of adapters) {
        expect(adapter).toBeInstanceOf(FakeHarnessAdapter);
        expect(adapter).not.toBeInstanceOf(PiAdapter);
        expect(adapter.harnessId).toBe(harnessId);
      }
      expect(stderr).toHaveBeenCalledWith(
        "codexhost: Fake Harness Adapter is enabled (CODEXHOST_FAKE_HARNESS=1); external Harnesses will not call real models\n",
      );
      await Promise.all([...adapters.values()].map((adapter) => adapter.close()));
    } finally {
      stderr.mockRestore();
    }
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
