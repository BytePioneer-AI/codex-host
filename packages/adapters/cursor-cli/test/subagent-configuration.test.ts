import { describe, expect, it } from "vitest";
import { configureSubagentEvent, configureSubagentSnapshot } from "@codexhost/harness-adapter";
import type { HostSubagentDelegationItem } from "@codexhost/harness-adapter";
import { hostTurnIdSchema, nativeTurnRefSchema } from "@codexhost/shared-contracts";
const parent = { model: "parent-model", reasoningEffort: "high" };
import { cursorDelegation } from "../src/subagents.js";
function delegation(config: Record<string, unknown>): HostSubagentDelegationItem {
  return cursorDelegation("child", { description: "Inspect", prompt: "Check it", ...config });
}
describe("cursor-cli subagent configuration", () => {
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
                harnessId: "cursor-cli",
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
