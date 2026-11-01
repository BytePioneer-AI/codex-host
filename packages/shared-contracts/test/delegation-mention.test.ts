import { describe, expect, it } from "vitest";

import {
  delegationMentionPath,
  formatDelegationMentionLink,
  harnessCommandMentionPath,
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
});
