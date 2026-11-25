import { describe, expect, it } from "vitest";
import { harnessCommandMentionPath } from "@codexhost/shared-contracts";
import { brandString } from "@deepseek-ai/dsh-brand";
import type { SessionId } from "@deepseek-ai/dsh-session";
import { formatSessionReferenceMention } from "../../../context/session-reference/src/uri.ts";
import { planUserTextRanges } from "../src/user-text-ranges.ts";

describe("planUserTextRanges", () => {
  const commandLink = (invocation: string) =>
    `[@${invocation}](${harnessCommandMentionPath(invocation)})`;

  it("keeps explicit command, skill, and thread references intact when preceded by a plain @ token", () => {
    const command = commandLink("/plan");
    const commandText = `@notes,${command}`;
    expect(planUserTextRanges(commandText, [])).toEqual([
      { start: 0, end: 6, label: "@notes", kind: "plain" },
      {
        start: 7,
        end: commandText.length,
        label: "/plan",
        kind: "command",
        display: "/plan",
      },
    ]);

    const adjacentCommand = `@notes${command}`;
    expect(planUserTextRanges(adjacentCommand, [])).toEqual([
      { start: 0, end: 6, label: "@notes", kind: "plain" },
      {
        start: 6,
        end: adjacentCommand.length,
        label: "/plan",
        kind: "command",
        display: "/plan",
      },
    ]);

    const skill = '[$eli5](/skills/eli5/SKILL.md "Read this skill")';
    const skillText = `@notes,${skill}`;
    expect(planUserTextRanges(skillText, [])).toEqual([
      { start: 0, end: 6, label: "@notes", kind: "plain" },
      {
        start: 7,
        end: skillText.length,
        label: skill,
        kind: "skill",
        display: "eli5",
      },
    ]);

    const thread = "[@Feature Thread](thread://t-1?hostId=local)";
    const threadText = `@notes,${thread}`;
    expect(planUserTextRanges(threadText, [])).toEqual([
      { start: 0, end: 6, label: "@notes", kind: "plain" },
      {
        start: 7,
        end: threadText.length,
        label: thread,
        kind: "session",
        display: "Feature Thread",
      },
    ]);
  });

  it("keeps plain slash tokens whitespace-bounded against the full text", () => {
    const command = commandLink("/review");
    expect(planUserTextRanges(`/plan${command}`, [], ["plan"])).toEqual([
      {
        start: 5,
        end: 5 + command.length,
        label: "/review",
        kind: "command",
        display: "/review",
      },
    ]);
    expect(planUserTextRanges(`${command}/plan`, [], ["plan"])).toEqual([
      {
        start: 0,
        end: command.length,
        label: "/review",
        kind: "command",
        display: "/review",
      },
    ]);
    expect(planUserTextRanges(`${command} /plan`, [], ["plan"])).toEqual([
      {
        start: 0,
        end: command.length,
        label: "/review",
        kind: "command",
        display: "/review",
      },
      {
        start: command.length + 1,
        end: command.length + 6,
        label: "/plan",
        kind: "plain",
      },
    ]);
  });

  it("preserves literal [ and @[ in DSH session titles and stays linear on missing ) and repeated \\[@ prefixes", () => {
    const dshBracket = formatSessionReferenceMention({
      sessionId: brandString<SessionId>("sess-1"),
      label: "Release [draft",
    });
    expect(planUserTextRanges(`Check ${dshBracket} now`, [])).toEqual([
      {
        start: 6,
        end: 6 + dshBracket.length,
        label: dshBracket,
        kind: "session",
        display: "Release [draft",
      },
    ]);

    const dshAtBracket = formatSessionReferenceMention({
      sessionId: brandString<SessionId>("sess-2"),
      label: "Release @[draft",
    });
    expect(planUserTextRanges(`Check ${dshAtBracket} now`, [])).toEqual([
      {
        start: 6,
        end: 6 + dshAtBracket.length,
        label: dshAtBracket,
        kind: "session",
        display: "Release @[draft",
      },
    ]);

    // 20,000 unclosed `](dsh-session:` prefixes without `)` must stay linear.
    const unclosedDsh = `${"](dsh-session:".repeat(20_000)} ${dshAtBracket}`;
    const startedDsh = performance.now();
    expect(planUserTextRanges(unclosedDsh, [])).toEqual([
      {
        start: unclosedDsh.indexOf(dshAtBracket),
        end: unclosedDsh.indexOf(dshAtBracket) + dshAtBracket.length,
        label: dshAtBracket,
        kind: "session",
        display: "Release @[draft",
      },
    ]);
    expect(performance.now() - startedDsh).toBeLessThan(150);

    const thread = "[@Thread \\[1\\]](thread://t-1?hostId=local)";
    const escapedPrefixes = `${"\\[@".repeat(10_000)} ${thread}`;
    const startedAt = performance.now();
    const ranges = planUserTextRanges(escapedPrefixes, []);
    const elapsedMs = performance.now() - startedAt;
    expect(ranges).toEqual([
      {
        start: escapedPrefixes.indexOf(thread),
        end: escapedPrefixes.indexOf(thread) + thread.length,
        label: thread,
        kind: "session",
        display: "Thread [1]",
      },
    ]);
    expect(elapsedMs).toBeLessThan(150);

    // Even with no valid carrier at the end, 10,000 \[@ prefixes before ](thread:// stays linear.
    const noMatch = `${"\\[@".repeat(10_000)}](thread://t-1?hostId=local)`;
    const startedNoMatch = performance.now();
    expect(planUserTextRanges(noMatch, [])).toEqual([]);
    expect(performance.now() - startedNoMatch).toBeLessThan(150);
  });

  it("stays linear on large unclosed [@ prefixes followed by valid command, harness, and thread carriers", () => {
    const command = commandLink("/plan");
    const harness = "[@Antigravity](subagent://codexhost.antigravity)";
    const thread = "[@Thread \\[1\\]](thread://t-1?hostId=local)";
    const adversarial = `${"[@".repeat(20_000)} ${command} ${harness} ${thread}`;
    const startedAt = performance.now();
    const ranges = planUserTextRanges(adversarial, []);
    const elapsedMs = performance.now() - startedAt;
    expect(ranges).toEqual([
      {
        start: adversarial.indexOf(command),
        end: adversarial.indexOf(command) + command.length,
        label: "/plan",
        kind: "command",
        display: "/plan",
      },
      {
        start: adversarial.indexOf(harness),
        end: adversarial.indexOf(harness) + harness.length,
        label: harness,
        kind: "harness",
        display: "Antigravity",
      },
      {
        start: adversarial.indexOf(thread),
        end: adversarial.indexOf(thread) + thread.length,
        label: thread,
        kind: "session",
        display: "Thread [1]",
      },
    ]);
    expect(elapsedMs).toBeLessThan(250);
  });
});
