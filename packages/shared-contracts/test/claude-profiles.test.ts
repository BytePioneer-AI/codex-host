import { describe, expect, it } from "vitest";

import { claudeCodeProfileSchema, parseClaudeCodeProfiles } from "../src/index.js";

describe("claudeCodeProfileSchema", () => {
  it("accepts a valid profile", () => {
    const valid = {
      id: "claude-custom",
      name: "Claude Custom",
      description: "Claude Code Custom Profile",
      command: "/Users/test/.local/bin/claude-custom",
      configDir: "/Users/test/.claude-custom",
      icon: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
      environment: {
        TEST_ENV: "1",
      },
    };
    const parsed = claudeCodeProfileSchema.parse(valid);
    expect(parsed.id).toBe("claude-custom");
    expect(parsed.name).toBe("Claude Custom");
    expect(parsed.command).toBe("/Users/test/.local/bin/claude-custom");
    expect(parsed.configDir).toBe("/Users/test/.claude-custom");
  });

  it("rejects profile with id 'claude-code'", () => {
    expect(() =>
      claudeCodeProfileSchema.parse({
        id: "claude-code",
        name: "Conflict",
      }),
    ).toThrow();
  });

  it("rejects invalid id", () => {
    expect(() =>
      claudeCodeProfileSchema.parse({
        id: "Invalid_ID",
        name: "Invalid",
      }),
    ).toThrow();
  });

  it("parses profiles array or file schema with version", () => {
    const list = [
      {
        id: "claude-custom",
        name: "Claude Custom",
        configDir: "/Users/test/.claude-custom",
      },
      {
        id: "claude-work",
        name: "Claude Work",
        configDir: "/Users/test/.claude-work",
      },
    ];

    expect(parseClaudeCodeProfiles(list)).toHaveLength(2);
    expect(
      parseClaudeCodeProfiles({
        version: 1,
        profiles: list,
      }),
    ).toHaveLength(2);
  });

  it("rejects duplicate profile ids in profiles list", () => {
    const duplicate = [
      {
        id: "claude-custom",
        name: "Claude Custom",
        configDir: "/Users/test/.claude-1",
      },
      {
        id: "claude-custom",
        name: "Claude Duplicate",
        configDir: "/Users/test/.claude-2",
      },
    ];

    expect(() => parseClaudeCodeProfiles(duplicate)).toThrow();
  });
});
