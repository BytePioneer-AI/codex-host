import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import type { HarnessInspection } from "@codexhost/harness-adapter";
import { EXTERNAL_HARNESS_IDS } from "@codexhost/protocol-core";
import { approvalServerName } from "../src/app-server-host.js";
import {
  CLAUDE_CODE_COMMAND_ENV,
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

    expect([...adapters.keys()]).toEqual([
      "pi",
      "claude-code",
      "deepseek-harness",
      "grok",
      "omp",
      "qwen-code",
    ]);
    expect(adapters.get("claude-code")?.harnessId).toBe("claude-code");
    expect(adapters.get("deepseek-harness")?.harnessId).toBe("deepseek-harness");
    expect(adapters.get("omp")?.harnessId).toBe("omp");
    expect(adapters.get("grok")?.harnessId).toBe("grok");
    expect(adapters.get("qwen-code")?.harnessId).toBe("qwen-code");
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

  it("declares every registered Adapter as a manifest dependency", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { dependencies: Record<string, string> };
    for (const id of ["pi", "claude-code", "deepseek-harness", "grok", "omp", "qwen-code"]) {
      expect(manifest.dependencies[`@codexhost/adapter-${id}`]).toBeDefined();
    }
  });
});

describe("approval server names", () => {
  it("names every external Harness", () => {
    for (const harnessId of EXTERNAL_HARNESS_IDS) {
      expect(approvalServerName(harnessId)).toEqual(expect.any(String));
      expect(approvalServerName(harnessId).length).toBeGreaterThan(0);
    }
    expect(approvalServerName("qwen-code")).toBe("Qwen Code");
  });
});
