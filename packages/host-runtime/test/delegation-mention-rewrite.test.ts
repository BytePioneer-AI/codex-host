import { describe, expect, it } from "vitest";

import {
  rewriteDelegationMentionInput,
  rewriteDelegationMentionText,
} from "../src/delegation-mention-rewrite.js";

const skill = {
  name: "codexhost-delegation",
  path: "/home/u/.agents/skills/codexhost-delegation/SKILL.md",
};
const link = "[@Claude Code](subagent://codexhost.claude-code)";

describe("delegation mention rewrite", () => {
  it("forwards native input untouched without a carrier", () => {
    expect(rewriteDelegationMentionInput([{ type: "text", text: "hello" }], skill)).toBeNull();
  });

  it("replaces the carrier, adds an explicit instruction and the native Skill item", () => {
    const image = { type: "localImage", path: "/tmp/a.png" };
    const rewritten = rewriteDelegationMentionInput(
      [{ type: "text", text: `${link} review this change` }, image],
      skill,
    );
    expect(rewritten).toHaveLength(3);
    const [text, second, third] = rewritten ?? [];
    expect(second).toEqual(image);
    expect(third).toEqual({ type: "skill", ...skill });
    const body = (text as { text: string }).text;
    expect(body.startsWith("@Claude Code review this change\n\n[codexhost delegation]")).toBe(true);
    expect(body).toContain("Harness `claude-code`");
    expect(body).not.toContain("subagent://");
  });

  it("falls back to the text instruction when the managed Skill is unavailable", () => {
    const rewritten = rewriteDelegationMentionInput([{ type: "text", text: link }], null);
    expect(rewritten).toHaveLength(1);
    expect((rewritten?.[0] as { text: string }).text).toMatch(
      /^@Claude Code\n\n\[codexhost delegation\]/u,
    );
  });

  it("does not attach the Skill twice", () => {
    const rewritten = rewriteDelegationMentionInput(
      [
        { type: "text", text: link },
        { type: "skill", ...skill },
      ],
      skill,
    );
    expect(rewritten?.filter((item) => (item as { type: string }).type === "skill")).toHaveLength(
      1,
    );
  });

  it("rewrites External Harness text", () => {
    const text = rewriteDelegationMentionText(`${link} fix the test`);
    expect(text).toContain("@Claude Code fix the test");
    expect(text).toContain("codexhost-delegation");
    expect(text).toContain("through the executable in CODEXHOST_CLI_PATH");
    expect(text).not.toContain("`codexhost delegate");
    expect(rewriteDelegationMentionText("plain")).toBe("plain");
  });

  it("rewrites remote host+Harness, host-only, and mixed local/remote mentions distinctly", () => {
    const remoteSpecific =
      "[@Mac Studio · Claude Code](subagent://codexhost-remote/remote-peer%3Apeer-studio/claude-code)";
    const remoteHostOnly = "[@Home Mini](subagent://codexhost-remote/remote-peer%3Apeer-home)";

    const specificRewritten = rewriteDelegationMentionInput(
      [{ type: "text", text: `${remoteSpecific} run tests` }],
      skill,
    );
    const specificBody = (specificRewritten?.[0] as { text: string }).text;
    expect(specificBody).toContain("@Mac Studio · Claude Code run tests");
    expect(specificBody).toContain("remote Host `remote-peer:peer-studio`, Harness `claude-code`");
    expect(specificBody).toContain(
      "delegate start --host <hostId> --harness <id> --cwd <remote-path>",
    );
    expect(specificBody).toContain("project list --host <hostId>");
    expect(specificBody).not.toContain("harness list --host <hostId>");
    expect(specificBody).not.toContain("subagent://");

    const hostOnlyBody = rewriteDelegationMentionText(`${remoteHostOnly} check disk space`);
    expect(hostOnlyBody).toContain("@Home Mini check disk space");
    expect(hostOnlyBody).toContain("remote Host `remote-peer:peer-home`, Harness unspecified");
    expect(hostOnlyBody).toContain("harness list --host <hostId>");
    expect(hostOnlyBody).toContain(
      "delegate start --host <hostId> --harness <id> --cwd <remote-path>",
    );

    const mixedRewritten = rewriteDelegationMentionInput(
      [{ type: "text", text: `${link} and ${remoteSpecific}` }],
      skill,
    );
    const mixedBody = (mixedRewritten?.[0] as { text: string }).text;
    expect(mixedBody).toContain("@Claude Code (Harness `claude-code`)");
    expect(mixedBody).toContain(
      "@Mac Studio · Claude Code (remote Host `remote-peer:peer-studio`, Harness `claude-code`)",
    );
    expect(mixedBody).toContain("For local targets, run `delegate start --harness <id>`.");
  });
});
