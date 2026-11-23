import { describe, expect, it } from "vitest";

import {
  filterDelegationCommands,
  filterDelegationTargets,
  findDelegationTrigger,
  harnessCommandDisplayName,
} from "../src/renderer-delegation-mention.js";

describe("delegation mention trigger", () => {
  it("detects # at a word start or after CJK text before the caret", () => {
    expect(findDelegationTrigger("#")).toEqual({ query: "", start: 0 });
    expect(findDelegationTrigger("please #cla")).toEqual({ query: "cla", start: 7 });
    for (const [text, query, start] of [
      ["请#", "", 1],
      ["帮我，#cla", "cla", 3],
      ["「#cla", "cla", 1],
      ["カタカナで#cla", "cla", 5],
      ["ラー#cla", "cla", 2],
      ["\u{20000}#cla", "cla", 2],
      ["＃", "", 0],
      ["请＃cla", "cla", 1],
      ["```py\nx\n```\n#cla", "cla", 12],
      ["```foo```\n#cla", "cla", 10],
      ["```foo``` #cla", "cla", 10],
      ["use `a` #cla", "cla", 8],
      ["use \\` literal #cla", "cla", 15],
      ["use \\\\\\` literal #cla", "cla", 17],
      ["`a\\` #cla", "cla", 5],
      ["`alpha\nbeta` #cla", "cla", 13],
      ["`alpha\n\n#cla", "cla", 8],
      ["`alpha\n```py\n```\n#cla", "cla", 17],
    ] as const) {
      expect(findDelegationTrigger(text), text).toEqual({ query, start });
    }
  });

  it("ignores # inside words, issue numbers, finished tokens and Markdown code", () => {
    expect(findDelegationTrigger("a#cla")).toBeNull();
    expect(findDelegationTrigger("fix #123")).toBeNull();
    expect(findDelegationTrigger("#claude ")).toBeNull();
    for (const text of [
      "C#",
      "issue#12",
      "&#39;",
      "x/#a",
      "한국어#cla",
      "Ａ#cla",
      "１#cla",
      "·#cla",
      "##",
      "＃＃",
      "#＃",
      "＃#",
      "fix ＃123",
      "```py\n#cla",
      "~~~\n#",
      "~~~foo~~~\n#cla",
      "```#",
      "use `#cla",
      "use \\\\`code #cla",
      "`alpha\n#cla",
      "`alpha\n  #cla",
    ]) {
      expect(findDelegationTrigger(text), text).toBeNull();
    }
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
