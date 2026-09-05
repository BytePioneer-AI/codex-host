import {
  harnessModelRefSchema,
  hostItemIdSchema,
  nativeCheckpointRefSchema,
  nativeTurnRefSchema,
} from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import { comparableHistoricalTurn, type HostTurnSnapshot } from "../src/index.js";

function historicalTurn(input: {
  sessionId: string;
  turnId: string;
  checkpointId?: string;
  itemId: string;
  subagentId: string;
  text?: string;
}): HostTurnSnapshot {
  return {
    nativeTurnRef: nativeTurnRefSchema.parse({
      harnessId: "opencode",
      nativeSessionId: input.sessionId,
      nativeTurnKey: input.turnId,
      formatVersion: 1,
    }),
    ...(input.checkpointId
      ? {
          checkpoint: nativeCheckpointRefSchema.parse({
            harnessId: "opencode",
            nativeSessionId: input.sessionId,
            checkpointId: input.checkpointId,
            locator: { messageId: `${input.sessionId}-checkpoint-message` },
            formatVersion: 1,
          }),
        }
      : {}),
    input: [{ type: "text", text: "question" }],
    items: [
      {
        item: {
          type: "agentMessage",
          itemId: hostItemIdSchema.parse(input.itemId),
          text: input.text ?? "answer",
        },
        outcome: { status: "succeeded" },
      },
      {
        item: {
          type: "subagentDelegation",
          itemId: hostItemIdSchema.parse(`${input.itemId}-delegation`),
          operation: "spawn",
          subagents: [
            {
              subagentId: input.subagentId,
              nativeSubagentId: `${input.subagentId}-native`,
              description: "review",
              background: true,
              status: "completed",
            },
          ],
        },
        outcome: { status: "succeeded" },
      },
    ],
    outcome: { status: "succeeded" },
    model: harnessModelRefSchema.parse({ id: "provider.model" }),
  };
}

describe("historical Turn comparison", () => {
  it("normalizes identities that a Native Session derivation may regenerate", () => {
    const source = historicalTurn({
      sessionId: "source",
      turnId: "source-turn",
      checkpointId: "source-checkpoint",
      itemId: "source-item",
      subagentId: "source-subagent",
    });
    const derived = historicalTurn({
      sessionId: "derived",
      turnId: "derived-turn",
      checkpointId: "derived-checkpoint",
      itemId: "derived-item",
      subagentId: "derived-subagent",
    });

    expect(comparableHistoricalTurn(derived)).toEqual(comparableHistoricalTurn(source));
    expect(comparableHistoricalTurn(source)).toEqual({
      nativeTurnRef: { harnessId: "opencode", formatVersion: 1 },
      checkpoint: { harnessId: "opencode", formatVersion: 1 },
      input: [{ type: "text", text: "question" }],
      items: [
        {
          item: { type: "agentMessage", text: "answer" },
          outcome: { status: "succeeded" },
        },
        {
          item: {
            type: "subagentDelegation",
            operation: "spawn",
            subagents: [
              {
                description: "review",
                background: true,
                status: "completed",
              },
            ],
          },
          outcome: { status: "succeeded" },
        },
      ],
      outcome: { status: "succeeded" },
      model: { id: "provider.model" },
    });
  });

  it("retains semantic content, Harness identity, and Checkpoint presence", () => {
    const source = historicalTurn({
      sessionId: "source",
      turnId: "source-turn",
      checkpointId: "source-checkpoint",
      itemId: "source-item",
      subagentId: "source-subagent",
    });
    const changed = historicalTurn({
      sessionId: "derived",
      turnId: "derived-turn",
      checkpointId: "derived-checkpoint",
      itemId: "derived-item",
      subagentId: "derived-subagent",
      text: "different answer",
    });
    const missingCheckpoint = historicalTurn({
      sessionId: "derived",
      turnId: "derived-turn",
      itemId: "derived-item",
      subagentId: "derived-subagent",
    });
    const changedHarness = historicalTurn({
      sessionId: "derived",
      turnId: "derived-turn",
      checkpointId: "derived-checkpoint",
      itemId: "derived-item",
      subagentId: "derived-subagent",
    });
    changedHarness.nativeTurnRef = nativeTurnRefSchema.parse({
      ...changedHarness.nativeTurnRef,
      harnessId: "pi",
    });

    expect(comparableHistoricalTurn(changed)).not.toEqual(comparableHistoricalTurn(source));
    expect(comparableHistoricalTurn(missingCheckpoint)).not.toEqual(
      comparableHistoricalTurn(source),
    );
    expect(comparableHistoricalTurn(changedHarness)).not.toEqual(comparableHistoricalTurn(source));
  });
});
