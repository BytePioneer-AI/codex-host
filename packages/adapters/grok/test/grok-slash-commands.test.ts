import { describe, expect, it } from "vitest";
import { mergeLiveHarnessCommands } from "@codexhost/harness-adapter";

import {
  GROK_LIVE_COMMAND_ID_PREFIX,
  grokLiveCommands,
  parseGrokAvailableCommands,
} from "../src/grok-slash-commands.js";

describe("Grok advertised commands", () => {
  it("marks skills, keeps workflows and drops UI, trust, loop and goal commands", () => {
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
      { name: "", description: "ignored" },
      "bad",
    ]);
    const catalog = mergeLiveHarnessCommands(
      { commands: [] },
      GROK_LIVE_COMMAND_ID_PREFIX,
      grokLiveCommands(native),
    );
    expect(catalog.commands.map(({ invocation, kind }) => [invocation, kind])).toEqual([
      ["/compact", "command"],
      ["/context", "command"],
      ["/deep-research", "command"],
      ["/code-review", "skill"],
    ]);
  });
});
