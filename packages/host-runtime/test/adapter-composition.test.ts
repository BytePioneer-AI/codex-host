import { describe, expect, it } from "vitest";

import {
  CLAUDE_CODE_COMMAND_ENV,
  CLAUDE_CODE_ENABLE_ENV,
  createExternalHarnessAdapters,
} from "../src/index.js";

describe("Host external Harness composition", () => {
  it("registers only Pi by default", async () => {
    const adapters = createExternalHarnessAdapters({ PATH: "" });

    expect([...adapters.keys()]).toEqual(["pi"]);
    await Promise.all([...adapters.values()].map((adapter) => adapter.close()));
  });

  it("registers Claude Code only behind the explicit development switch", async () => {
    const adapters = createExternalHarnessAdapters({
      PATH: "",
      [CLAUDE_CODE_ENABLE_ENV]: "1",
      [CLAUDE_CODE_COMMAND_ENV]: "/synthetic/claude",
    });

    expect([...adapters.keys()]).toEqual(["pi", "claude-code"]);
    expect(adapters.get("claude-code")?.harnessId).toBe("claude-code");
    await Promise.all([...adapters.values()].map((adapter) => adapter.close()));
  });

  it("does not enable Claude for other environment values", async () => {
    const adapters = createExternalHarnessAdapters({
      PATH: "",
      [CLAUDE_CODE_ENABLE_ENV]: "true",
    });

    expect(adapters.has("claude-code")).toBe(false);
    await Promise.all([...adapters.values()].map((adapter) => adapter.close()));
  });
});
