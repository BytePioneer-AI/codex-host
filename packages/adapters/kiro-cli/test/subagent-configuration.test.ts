import { kiroChildSnapshot } from "../src/subagents.js";
import { KiroAdapter } from "../src/kiro-adapter.js";
import { describe, expect, it } from "vitest";
import { configureSubagentEvent, configureSubagentSnapshot } from "@codexhost/harness-adapter";
import type { HostSubagentDelegationItem } from "@codexhost/harness-adapter";
import {
  hostTurnIdSchema,
  nativeTurnRefSchema,
  nativeSessionRefSchema,
} from "@codexhost/shared-contracts";
const parent = { model: "parent-model", reasoningEffort: "high" };
import { projectKiroToolCall } from "../src/projection.js";
function delegation(config: Record<string, unknown>): HostSubagentDelegationItem {
  return projectKiroToolCall("call", {
    toolCallId: "call",
    status: "in_progress",
    rawInput: { prompt: "Check it", name: "Inspect", ...config },
    metadata: { kiro: { kind: "agent-subtask", agentSubtaskId: "child" } },
  }) as HostSubagentDelegationItem;
}
describe("kiro-cli subagent configuration", () => {
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
                harnessId: "kiro-cli",
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

it("materializes summary-only Kiro child history scoped to its verified parent", async () => {
  const item = delegation({ model: "native-child", reasoningEffort: "low" });
  const child = item.subagents[0];
  if (!child) throw new Error("Expected Kiro child");
  child.status = "completed";
  child.resultSummary = "Inspection complete";
  const adapter = new KiroAdapter(
    {},
    {
      locateSession: async (_input, sessionId) =>
        sessionId === "parent"
          ? {
              sessionDirectory: "/not-read",
              sessionMeta: { id: "parent", workspacePaths: ["/workspace"] },
              cwd: "/workspace",
            }
          : null,
      readSnapshot: async () => ({
        turns: [
          {
            nativeTurnRef: nativeTurnRefSchema.parse({
              harnessId: "kiro-cli",
              nativeSessionId: "parent",
              nativeTurnKey: "turn",
              formatVersion: 1,
            }),
            input: [],
            items: [{ item, outcome: { status: "succeeded" } }],
            outcome: { status: "succeeded" },
          },
        ],
      }),
    },
  );
  const parent = nativeSessionRefSchema.parse({
    harnessId: "kiro-cli",
    nativeSessionId: "parent",
    formatVersion: 1,
  });
  const snapshot = await adapter.subagents.readSnapshot({
    parent,
    nativeSubagentId: "child",
    cwd: "/workspace",
  });
  expect(snapshot).toMatchObject({
    ok: true,
    value: {
      turns: [
        {
          input: [{ text: "Check it" }],
          items: [{ item: { type: "agentMessage", text: "Inspection complete" } }],
          outcome: { status: "succeeded" },
        },
      ],
    },
  });
  expect(
    await adapter.subagents.readSnapshot({
      parent,
      nativeSubagentId: "unrelated-child",
      cwd: "/workspace",
    }),
  ).toMatchObject({ ok: false });
  expect(() => kiroChildSnapshot("parent", item, "unrelated-child")).toThrow("does not belong");
  child.status = "running";
  expect(kiroChildSnapshot("parent", item, "child").turns[0]?.outcome).toMatchObject({
    status: "unknown",
  });
  await adapter.close();
});

it("prefers Kiro's observed task metadata over requested input configuration", () => {
  const item = projectKiroToolCall("call", {
    toolCallId: "call",
    rawInput: { model: "requested", thinking: "high" },
    metadata: {
      kiro: {
        kind: "agent-subtask",
        agentSubtaskId: "child",
        model: "observed",
        reasoningEffort: "low",
      },
    },
  });
  expect(item).toMatchObject({ subagents: [{ model: "observed", reasoningEffort: "low" }] });
});
