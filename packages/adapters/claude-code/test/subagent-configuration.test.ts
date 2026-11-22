import { expect, it } from "vitest";
import { configureSubagentEvent } from "@codexhost/harness-adapter";
import { hostItemIdSchema, hostTurnIdSchema } from "@codexhost/shared-contracts";
const parent = { model: "parent-model", reasoningEffort: "high" };
import { ClaudeSubagentLifecycle } from "../src/subagent-lifecycle.js";

import type { HostEvent } from "@codexhost/harness-adapter";
it("preserves native claude-code child configuration through lifecycle updates", () => {
  const events: HostEvent[] = [];
  const lifecycle = new ClaudeSubagentLifecycle({
    newItemId: () => hostItemIdSchema.parse("call"),
    emit: (event) => events.push(configureSubagentEvent(event, parent)),
  });
  const turnId = hostTurnIdSchema.parse("turn");
  lifecycle.start(turnId, {
    type: "subagent.started",
    callId: "call",
    nativeSubagentId: "child",
    description: "Inspect",
    prompt: "Check it",
    role: "explorer",
    background: false,
    operation: "spawn",
    model: "child-model",
    reasoningEffort: "low",
  });
  lifecycle.update(turnId, { type: "subagent.updated", callId: "call", status: "running" });
  lifecycle.complete(turnId, { type: "subagent.completed", callId: "call", isError: false }, false);
  expect(events[0]).toMatchObject({
    item: {
      prompt: "Check it",
      subagents: [{ model: "child-model", reasoningEffort: "low", role: "explorer" }],
    },
  });
  expect(events.at(-1)).toMatchObject({
    snapshot: {
      item: {
        subagents: [
          {
            model: "child-model",
            reasoningEffort: "low",
            status: "completed",
            nativeSubagentId: "child",
          },
        ],
      },
    },
  });
});
