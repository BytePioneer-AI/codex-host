import { describe, expect, it } from "vitest";
import { mergeLiveHarnessCommands } from "@codexhost/harness-adapter";

import {
  GROK_LIVE_COMMAND_ID_PREFIX,
  grokLiveCommands,
  parseGrokAvailableCommands,
} from "../src/grok-slash-commands.js";

describe("Grok advertised commands", () => {
  it("excludes native skills, keeps workflows and drops UI, trust, loop and goal commands", () => {
    const native = parseGrokAvailableCommands([
      { name: "compact", description: "Compact", input: { hint: "focus" } },
      { name: "always-approve", description: "Approve all" },
      { name: "hooks-add", description: "Add hook" },
      { name: "feedback", description: "Feedback" },
      { name: "loop", description: "Loop" },
      { name: "goal", description: "Set goal" },
      { name: "context", description: "Context" },
      {
        name: "deep-research",
        description: "Research",
        _meta: { workflowSource: "builtin", workflowPath: "/x/deep-research.rhai" },
      },
      {
        name: "code-review",
        description: "Review",
        _meta: { scope: "user", path: "/u/.grok/skills/code-review/SKILL.md" },
      },
      { name: "qualified-skill", _meta: { qualifiedName: "project:qualified-skill" } },
      { name: "windows-skill", _meta: { path: "C:\\skills\\guide\\SKILL.md" } },
      { name: "skill-like-command", _meta: { path: "/commands/guide.md" } },
      { name: "", description: "ignored" },
      "bad",
    ]);
    const catalog = mergeLiveHarnessCommands(
      { commands: [] },
      GROK_LIVE_COMMAND_ID_PREFIX,
      grokLiveCommands(native),
    );
    expect(catalog.commands.map(({ invocation, kind }) => [invocation, kind])).toEqual([
      ["/compact", undefined],
      ["/context", undefined],
      ["/deep-research", undefined],
      ["/skill-like-command", undefined],
    ]);
  });
});
