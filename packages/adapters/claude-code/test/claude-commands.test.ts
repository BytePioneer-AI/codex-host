import { describe, expect, it } from "vitest";
import { claudeNativeCommandCatalog, claudeNativePrompt } from "../src/claude-commands.js";

describe("Claude SDK prompt commands", () => {
  it("routes SDK commands through a namespace without leaking identity/config controls", () => {
    // Shape observed from SDK supportedCommands(), with synthetic prompt names.
    const catalog = claudeNativeCommandCatalog({ commands: [] }, [
      { name: "probe", description: "Test prompt", argumentHint: "<message>" },
      { name: "review:probe", description: "Review", argumentHint: "" },
      { name: "clear", description: "Clear", argumentHint: "" },
      { name: "model", description: "Change model", argumentHint: "" },
      { name: "probe", description: "Duplicate", argumentHint: "" },
      { name: "bad name", description: "Invalid", argumentHint: "" },
    ]);
    expect(catalog.commands.map((c) => c.invocation)).toEqual([
      "/claude:probe",
      "/claude:review:probe",
    ]);
    expect(claudeNativePrompt("/claude:probe alpha  beta\ngamma", catalog)).toBe(
      "/probe alpha  beta\ngamma",
    );
    expect(claudeNativePrompt("hello /probe", catalog)).toBe("hello /probe");
    expect(() => claudeNativePrompt("/claude:clear", catalog)).toThrow("no longer available");
  });
});
