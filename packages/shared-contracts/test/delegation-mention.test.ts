import { describe, expect, it } from "vitest";

import {
  delegationMentionPath,
  formatDelegationMentionLink,
  harnessCommandMentionPath,
  harnessCommandReferences,
  restoreHarnessCommandMentions,
  stripDelegationMentions,
} from "../src/index.js";

describe("delegation mention carrier", () => {
  it("formats a Desktop-restorable agent mention link", () => {
    expect(formatDelegationMentionLink({ harnessId: "claude-code", label: "Claude Code" })).toBe(
      "[@Claude Code](subagent://codexhost.claude-code)",
    );
    expect(
      formatDelegationMentionLink({ harnessId: "cursor-cli", label: "Cursor CLI (Experimental)" }),
    ).toBe("[@Cursor CLI Experimental](subagent://codexhost.cursor-cli)");
  });

  it("rejects Harness ids that would break the carrier", () => {
    expect(() => delegationMentionPath("bad id")).toThrow();
    expect(() => delegationMentionPath("../x")).toThrow();
  });

  it("strips carriers into readable mentions without duplicates", () => {
    const result = stripDelegationMentions(
      "[@Claude Code](subagent://codexhost.claude-code) review, then [@Grok](subagent://codexhost.grok) and [@Claude Code](subagent://codexhost.claude-code)",
    );
    expect(result.text).toBe("@Claude Code review, then @Grok and @Claude Code");
    expect(result.mentions).toEqual([
      { harnessId: "claude-code", label: "Claude Code" },
      { harnessId: "grok", label: "Grok" },
    ]);
  });

  it("leaves native custom agent roles and plain text alone", () => {
    const text = "[@reviewer](subagent://reviewer) and #claude";
    expect(stripDelegationMentions(text)).toEqual({ text, mentions: [] });
  });
});

describe("Harness command carrier", () => {
  const link = (invocation: string) => `[@${invocation}](${harnessCommandMentionPath(invocation)})`;

  it("encodes invocations into a Desktop-restorable path", () => {
    expect(harnessCommandMentionPath("/review")).toBe("subagent://codexhost-command.review");
    expect(harnessCommandMentionPath("/frontend-design:frontend-design")).toBe(
      "subagent://codexhost-command.frontend-design%3Afrontend-design",
    );
    expect(harnessCommandMentionPath("/a(b)")).toBe("subagent://codexhost-command.a%28b%29");
    expect(() => harnessCommandMentionPath("/two words")).toThrow();
  });

  it("restores the chip as a leading command with the remaining text as arguments", () => {
    expect(restoreHarnessCommandMentions(`${link("/review")} PR 42`)).toBe("/review PR 42");
    expect(restoreHarnessCommandMentions(`${link("$build")} check  tests`)).toBe(
      "$build check  tests",
    );
    expect(restoreHarnessCommandMentions(`please ${link("/eli5")}  quantum`)).toBe(
      "/eli5 please quantum",
    );
    expect(restoreHarnessCommandMentions(link("/frontend-design:frontend-design"))).toBe(
      "/frontend-design:frontend-design",
    );
    expect(restoreHarnessCommandMentions(`${link("/a")} x ${link("/b")}`)).toBe("/a x");
  });

  it("preserves internal spaces, tabs and code indentation in command arguments", () => {
    const argumentsText = "Review this:\n    const x =  1;\n\treturn x;\nname\t\tvalue";
    expect(restoreHarnessCommandMentions(`${link("/review")} ${argumentsText}`)).toBe(
      `/review ${argumentsText}`,
    );
    expect(
      restoreHarnessCommandMentions(`keep  these\tcolumns ${link("/review")}  and  these`),
    ).toBe("/review keep  these\tcolumns and  these");
    expect(
      restoreHarnessCommandMentions(
        `${link("/review")} first  block ${link("/other")} next\t\tblock`,
      ),
    ).toBe("/review first  block next\t\tblock");
  });

  it("leaves text without a command chip unchanged", () => {
    const text = "[@Claude Code](subagent://codexhost.claude-code) /usage";
    expect(restoreHarnessCommandMentions(text)).toBe(text);
    expect(stripDelegationMentions(`${link("/review")}`).mentions).toEqual([]);
  });

  it("extracts validated command references and ignores malformed or non-command links", () => {
    const first = link("/plan");
    const second = link("/frontend-design:frontend-design");
    const angle = `[@/a(b)](<${harnessCommandMentionPath("/a(b)")}>)`;
    const skillCmd = link("$build");
    const text = `Run ${first} then ${second}, ${angle}, and ${skillCmd}`;
    expect(harnessCommandReferences(text)).toEqual([
      {
        start: text.indexOf(first),
        end: text.indexOf(first) + first.length,
        invocation: "/plan",
        label: "/plan",
        text: first,
      },
      {
        start: text.indexOf(second),
        end: text.indexOf(second) + second.length,
        invocation: "/frontend-design:frontend-design",
        label: "/frontend-design:frontend-design",
        text: second,
      },
      {
        start: text.indexOf(angle),
        end: text.indexOf(angle) + angle.length,
        invocation: "/a(b)",
        label: "/a(b)",
        text: angle,
      },
      {
        start: text.indexOf(skillCmd),
        end: text.indexOf(skillCmd) + skillCmd.length,
        invocation: "$build",
        label: "$build",
        text: skillCmd,
      },
    ]);

    for (const invalid of [
      "[@/bad](subagent://codexhost-command.%E0%A4%A)",
      "[@/bad](subagent://codexhost-command.two%20words)",
      "[@/bad](subagent://codexhost-command.)",
      "[@/bad](subagent://codexhost-command.%2Fplan)",
      "[@/bad](<subagent://codexhost-command.plan)",
      "[@/bad](subagent://codexhost-command.plan>)",
      "[@/bad](<subagent://codexhost-command.plan>>)",
      "[@Antigravity](subagent://codexhost.antigravity)",
      "[/plan](https://example.com)",
    ]) {
      expect(harnessCommandReferences(invalid)).toEqual([]);
      expect(restoreHarnessCommandMentions(invalid)).toBe(invalid);
    }
  });

  it("handles unclosed prefixes, adjacent carriers, and large inputs in linear time without swallowing prose", () => {
    const plan = link("/plan");
    const review = link("/review");

    // Unclosed [@ prefix must not swallow prose before a following valid carrier.
    const withUnclosed = `[@unclosed prose ${plan}`;
    expect(harnessCommandReferences(withUnclosed)).toEqual([
      {
        start: withUnclosed.indexOf(plan),
        end: withUnclosed.length,
        invocation: "/plan",
        label: "/plan",
        text: plan,
      },
    ]);
    expect(restoreHarnessCommandMentions(withUnclosed)).toBe("/plan [@unclosed prose");

    // Adjacent carriers without whitespace both parse and restore cleanly.
    const adjacent = `${plan}${review}`;
    expect(harnessCommandReferences(adjacent).map((ref) => ref.invocation)).toEqual([
      "/plan",
      "/review",
    ]);
    expect(restoreHarnessCommandMentions(adjacent)).toBe("/plan");

    // Large adversarial unclosed prefixes stay linear (no O(n^2) backtracking).
    const adversarial = `${"[@".repeat(20_000)} ${plan}`;
    const startedAt = performance.now();
    const refs = harnessCommandReferences(adversarial);
    const elapsedMs = performance.now() - startedAt;
    expect(refs).toHaveLength(1);
    expect(refs[0]?.invocation).toBe("/plan");
    expect(elapsedMs).toBeLessThan(250);
  });
});
