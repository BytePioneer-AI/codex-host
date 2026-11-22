import { describe, expect, it } from "vitest";
import { configureSubagentEvent, configureSubagentSnapshot } from "@codexhost/harness-adapter";
import type { HostSubagentDelegationItem } from "@codexhost/harness-adapter";
import {
  hostItemIdSchema,
  hostTurnIdSchema,
  nativeTurnRefSchema,
} from "@codexhost/shared-contracts";
const parent = { model: "parent-model", reasoningEffort: "high" };
import { subagent } from "../src/projection.js";
function delegation(config: Record<string, unknown>): HostSubagentDelegationItem {
  const child = subagent(
    { childSessionId: "child" },
    { description: "Inspect", ...config },
    "Task",
  );
  if (!child) throw new Error("Expected child");
  return {
    type: "subagentDelegation",
    itemId: hostItemIdSchema.parse("call"),
    operation: "spawn",
    prompt: "Check it",
    subagents: [child],
  };
}
describe("zcode subagent configuration", () => {
  it.each([{}, { model: "child-model", reasoningEffort: "low" }])(
    "uses native configuration before parent defaults: %j",
    (config) => {
      const item = delegation(config);
      const before = structuredClone(item);
      const event = configureSubagentEvent(
        { type: "item.started", turnId: hostTurnIdSchema.parse("turn"), item },
        parent,
      );
      expect(event).toMatchObject({
        item: {
          type: "subagentDelegation",
          prompt: "Check it",
          subagents: [{ ...parent, ...config }],
        },
      });
      expect(item).toEqual(before);
      const snapshot = configureSubagentSnapshot(
        {
          turns: [
            {
              nativeTurnRef: nativeTurnRefSchema.parse({
                harnessId: "zcode",
                nativeSessionId: "parent",
                nativeTurnKey: "turn",
                formatVersion: 1,
              }),
              input: [],
              items: [{ item, outcome: { status: "succeeded" } }],
              outcome: { status: "succeeded" },
            },
          ],
        },
        parent,
      );
      expect(snapshot.turns[0]?.items[0]?.item).toMatchObject({
        subagents: [{ ...parent, ...config }],
      });
    },
  );
});
