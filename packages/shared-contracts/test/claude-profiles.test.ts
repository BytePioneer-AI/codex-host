import { describe, expect, it } from "vitest";

import {
  claudeCodeProfileSchema,
  collectClaudeCodeProfiles,
  parseClaudeCodeProfiles,
} from "../src/index.js";

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
        configDir: "/tmp/test",
      }),
    ).toThrow();
    expect(() =>
      claudeCodeProfileSchema.parse({
        id: "1leading-digit",
        name: "Invalid",
        configDir: "/tmp/test",
      }),
    ).toThrow();
    expect(() =>
      claudeCodeProfileSchema.parse({
        id: "-leading-hyphen",
        name: "Invalid",
        configDir: "/tmp/test",
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

  it("collects valid profiles and skips malformed or duplicate entries", () => {
    const profiles = collectClaudeCodeProfiles({
      version: 1,
      profiles: [
        { id: "claude-a", name: "A", configDir: "/tmp/a" },
        { id: "claude-b", name: "Missing config dir" },
        { id: "claude-c", name: "C", configDir: "/tmp/c" },
        { id: "claude-a", name: "Duplicate A", configDir: "/tmp/a2" },
        { id: "claude-d", name: "D", configDir: "/tmp/d" },
      ],
    });

    expect(profiles.map(({ id }) => id)).toEqual(["claude-a", "claude-c", "claude-d"]);
  });

  it("returns no profiles for a document without a profiles array", () => {
    expect(collectClaudeCodeProfiles({ version: 1 })).toEqual([]);
    expect(collectClaudeCodeProfiles("not-profiles")).toEqual([]);
  });
});
