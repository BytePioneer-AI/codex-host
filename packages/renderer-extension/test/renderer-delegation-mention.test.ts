import { describe, expect, it } from "vitest";

import {
  filterDelegationCommands,
  filterDelegationTargets,
  findDelegationTrigger,
  harnessCommandDisplayName,
} from "../src/renderer-delegation-mention.js";

describe("delegation mention trigger", () => {
  it("detects # at a word start before the caret", () => {
    expect(findDelegationTrigger("#")).toEqual({ query: "", start: 0 });
    expect(findDelegationTrigger("please #cla")).toEqual({ query: "cla", start: 7 });
  });

  it("ignores # inside words, issue numbers and finished tokens", () => {
    expect(findDelegationTrigger("a#cla")).toBeNull();
    expect(findDelegationTrigger("fix #123")).toBeNull();
    expect(findDelegationTrigger("#claude ")).toBeNull();
  });
});

describe("delegation target filtering", () => {
  const targets = [
    { agent: "codex", label: "Codex" },
    { agent: "claude-code", label: "Claude Code" },
    { agent: "omp", label: "Oh My Pi" },
  ] as const;

  it("prefers prefix matches over substring matches", () => {
    expect(filterDelegationTargets(targets, "c").map(({ agent }) => agent)).toEqual([
      "codex",
      "claude-code",
    ]);
    expect(filterDelegationTargets(targets, "pi").map(({ agent }) => agent)).toEqual(["omp"]);
    expect(filterDelegationTargets(targets, "")).toHaveLength(3);
    expect(filterDelegationTargets(targets, "zzz")).toEqual([]);
  });
});

describe("delegation command filtering", () => {
  const commands = [
    { id: "compact", invocation: "/compact", label: "Compact", argumentMode: "text" },
    { id: "init", invocation: "/init", label: "Init", argumentMode: "none" },
    { id: "recap", invocation: "/recap", label: "Session recap", argumentMode: "none" },
  ] as unknown as Parameters<typeof filterDelegationCommands>[0];

  it("matches invocations with or without the slash and labels", () => {
    expect(filterDelegationCommands(commands, "").map(({ id }) => id)).toEqual([
      "compact",
      "init",
      "recap",
    ]);
    expect(filterDelegationCommands(commands, "/in").map(({ id }) => id)).toEqual(["init"]);
    expect(filterDelegationCommands(commands, "session").map(({ id }) => id)).toEqual(["recap"]);
    expect(filterDelegationCommands(commands, "c").map(({ id }) => id)).toEqual([
      "compact",
      "recap",
    ]);
  });
});

describe("Harness command display names", () => {
  it("humanizes slugs and keeps readable labels", () => {
    expect(harnessCommandDisplayName("/skill:writing-for-agents")).toBe("Writing For Agents");
    expect(harnessCommandDisplayName("frontend-design:frontend-design")).toBe("Frontend Design");
    expect(harnessCommandDisplayName("code_review")).toBe("Code Review");
    expect(harnessCommandDisplayName("Initialize CLAUDE.md")).toBe("Initialize CLAUDE.md");
    expect(harnessCommandDisplayName("压缩上下文")).toBe("压缩上下文");
  });
});
