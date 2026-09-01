import { describe, expect, it, vi } from "vitest";

import type { HarnessInspection } from "@codexhost/harness-adapter";
import {
  CLAUDE_CODE_COMMAND_ENV,
  GROK_COMMAND_ENV,
  OPENCODE_COMMAND_ENV,
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
      "opencode",
      "grok",
      "omp",
      "codebuddy",
    ]);
    expect(adapters.get("claude-code")?.harnessId).toBe("claude-code");
    expect(adapters.get("deepseek-harness")?.harnessId).toBe("deepseek-harness");
    expect(adapters.get("omp")?.harnessId).toBe("omp");
    expect(adapters.get("grok")?.harnessId).toBe("grok");
    expect(adapters.get("opencode")?.harnessId).toBe("opencode");
    expect(adapters.get("codebuddy")?.harnessId).toBe("codebuddy");
    await Promise.all([...adapters.values()].map((adapter) => adapter.close()));
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

  it("preserves an explicit user-installed OpenCode command", async () => {
    const adapters = createExternalHarnessAdapters({
      PATH: "",
      [OPENCODE_COMMAND_ENV]: "/synthetic/opencode",
    });

    await expect(adapters.get("opencode")?.inspect()).resolves.toMatchObject({
      status: "notInstalled",
      error: { code: "notInstalled" },
    });
    await Promise.all([...adapters.values()].map((adapter) => adapter.close()));
  });
});
