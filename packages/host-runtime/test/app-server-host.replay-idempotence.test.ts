import { describe, expect, it } from "vitest";
import type { HarnessCommandInvocation, HostSubagentState } from "@codexhost/harness-adapter";
import type { FakeHarnessSession } from "@codexhost/harness-adapter/testing";
import type { JsonObject } from "@codexhost/protocol-core";
import {
  THREAD_MANUAL_COMPACTION_STARTED_METHOD,
  harnessCommandDescriptorSchema,
  hostItemIdSchema,
} from "@codexhost/shared-contracts";

import {
  createFixture,
  messageParams,
  method,
  requestId,
  startPiThread,
  startPiTurn,
  stopFixture,
  threadStatus,
  turnEvent,
  writeRequest,
} from "./app-server-host-fixture.js";

function childThreadStarted(message: JsonObject, parentThreadId: string): boolean {
  return (
    method(message, "thread/started") &&
    (messageParams(message).thread as JsonObject | undefined)?.parentThreadId === parentThreadId
  );
}

function compactionStarted(message: JsonObject, turnId: string): boolean {
  return (
    turnEvent(message, "item/started", turnId) &&
    (messageParams(message).item as JsonObject | undefined)?.type === "contextCompaction"
  );
}

describe("AppServerHost replayed external item events", () => {
  it("keeps a completed delegation's replayed item.started from re-activating its child Thread", async () => {
    const fixture = createFixture();
    try {
      const parentThreadId = await startPiThread(fixture);
      const turnId = await startPiTurn(fixture, parentThreadId);
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Fake Pi Session was not opened");
      await fixture.collector.waitFor((message) => turnEvent(message, "turn/started", turnId));

      const subagent: HostSubagentState = {
        subagentId: "agent-call",
        nativeSubagentId: "native-agent-1",
        description: "Analyze files",
        background: false,
        status: "running",
      };
      const itemId = session.startSubagentDelegation(subagent);
      const childStarted = await fixture.collector.waitFor((message) =>
        childThreadStarted(message, parentThreadId),
      );
      const childThreadId = (messageParams(childStarted).thread as JsonObject).id as string;

      // The delegation finishes and the child Thread settles to idle.
      session.replaceSubagents(itemId, [{ ...subagent, status: "completed" }]);
      session.completeItem(itemId, { status: "succeeded" });
      await fixture.collector.waitFor((message) => threadStatus(message, childThreadId, "idle"));

      // A reconnected Harness replays the delegation's original running start.
      session.emitEvent({
        type: "item.started",
        turnId,
        item: { type: "subagentDelegation", itemId, operation: "spawn", subagents: [subagent] },
      });
      session.succeedTurn();
      await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId));

      // The replayed start must not re-materialize the child Thread.
      expect(
        fixture.collector.messages.filter((message) => childThreadStarted(message, parentThreadId)),
      ).toHaveLength(1);
      // Fresh children are created active via thread/started; a replayed running
      // start must not produce a new active transition (or a duplicate Thread).
      expect(
        fixture.collector.messages.filter((message) =>
          threadStatus(message, childThreadId, "active"),
        ),
      ).toHaveLength(0);
      expect(
        fixture.collector.messages.filter((message) =>
          threadStatus(message, childThreadId, "idle"),
        ),
      ).toHaveLength(1);
      // The parent Turn still drains to idle instead of waiting on a phantom child.
      await fixture.collector.waitFor((message) => threadStatus(message, parentThreadId, "idle"));
    } finally {
      await stopFixture(fixture);
    }
  });

  it("announces a manual compaction registration once across a replayed start", async () => {
    const fixture = createFixture();
    try {
      const parentThreadId = await startPiThread(fixture);
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Fake Pi Session was not opened");
      const compactCommand = harnessCommandDescriptorSchema.parse({
        id: "fake.compact",
        invocation: "/compact",
        label: "Compact",
        argumentMode: "text",
      });
      let commandTurnId = "";
      session.commands = {
        list: async () => ({ ok: true, value: { commands: [compactCommand] } }),
        execute: async (invocation: HarnessCommandInvocation) => {
          const turnId = invocation.turnId;
          commandTurnId = String(turnId);
          const itemId = hostItemIdSchema.parse(`compaction-${turnId}`);
          session.emitEvent({ type: "turn.started", turnId });
          session.emitEvent({
            type: "item.started",
            turnId,
            item: { type: "contextCompaction", itemId },
          });
          session.emitEvent({
            type: "item.started",
            turnId,
            item: { type: "contextCompaction", itemId },
          });
          session.emitEvent({
            type: "item.completed",
            turnId,
            snapshot: {
              item: { type: "contextCompaction", itemId },
              outcome: { status: "succeeded" },
            },
          });
          session.emitEvent({ type: "turn.completed", turnId, outcome: { status: "succeeded" } });
          return { ok: true as const, value: { turnId } };
        },
      };
      writeRequest(fixture.desktopInput, {
        id: 2,
        method: "thread/compact/start",
        params: { threadId: parentThreadId },
      });
      const response = await fixture.collector.waitFor((message) => requestId(message, 2));
      expect(response.error).toBeUndefined();
      const turnId = commandTurnId;
      await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId));

      expect(
        fixture.collector.messages.filter((message) =>
          method(message, THREAD_MANUAL_COMPACTION_STARTED_METHOD),
        ),
      ).toEqual([
        {
          method: THREAD_MANUAL_COMPACTION_STARTED_METHOD,
          params: { threadId: parentThreadId, turnId },
        },
      ]);
      expect(
        fixture.collector.messages.filter((message) => compactionStarted(message, turnId)),
      ).toHaveLength(1);
    } finally {
      await stopFixture(fixture);
    }
  });
});
