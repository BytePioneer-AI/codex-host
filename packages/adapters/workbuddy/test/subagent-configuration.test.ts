import { describe, expect, it } from "vitest";
import { configureSubagentEvent, configureSubagentSnapshot } from "@codexhost/harness-adapter";
import type { HostSubagentDelegationItem } from "@codexhost/harness-adapter";
import { hostTurnIdSchema, nativeTurnRefSchema } from "@codexhost/shared-contracts";
const parent = { model: "parent-model", reasoningEffort: "high" };
import { snapshotFromHistory } from "@codexhost/adapter-codebuddy";
import { WORKBUDDY_RUNTIME_PROFILE } from "../src/common.js";
import { nativeSessionRefSchema } from "@codexhost/shared-contracts";
function delegation(config: Record<string, unknown>): HostSubagentDelegationItem {
  const rows = [
    { id: "user", type: "message", role: "user", content: "delegate" },
    {
      id: "call",
      parentId: "user",
      type: "function_call",
      callId: "spawn",
      name: "Agent",
      arguments: JSON.stringify({ description: "Inspect", prompt: "Check it", ...config }),
    },
    {
      id: "result",
      parentId: "call",
      type: "function_call_result",
      callId: "spawn",
      status: "completed",
      output: { type: "text", text: "Done" },
      providerData: { toolResult: { subAgent: { sessionId: "agent-child" } } },
    },
  ];
  const snapshot = snapshotFromHistory(
    rows.map((row) => JSON.stringify(row)).join("\n"),
    nativeSessionRefSchema.parse({
      harnessId: "workbuddy",
      nativeSessionId: "parent",
      formatVersion: 1,
    }),
    "/workspace",
    WORKBUDDY_RUNTIME_PROFILE,
  );
  const item = snapshot.turns[0]?.items[0]?.item;
  if (item?.type !== "subagentDelegation") throw new Error("Expected WorkBuddy delegation");
  return item;
}

describe("workbuddy subagent configuration", () => {
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
                harnessId: "workbuddy",
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
