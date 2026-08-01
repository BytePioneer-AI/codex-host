import { describe, expect, it } from "vitest";

import { CLAUDE_CODE_COMMAND_ENV, createExternalHarnessAdapters } from "../src/index.js";

describe("Host external Harness composition", () => {
  it("registers Pi and Claude Code by default without resolving executables", async () => {
    const adapters = createExternalHarnessAdapters({ PATH: "" });

    expect([...adapters.keys()]).toEqual(["pi", "claude-code"]);
    expect(adapters.get("claude-code")?.harnessId).toBe("claude-code");
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
