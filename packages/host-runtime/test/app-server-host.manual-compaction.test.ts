import { describe, expect, it } from "vitest";
import type { HarnessCommandInvocation } from "@codexhost/harness-adapter";
import type { FakeHarnessSession } from "@codexhost/harness-adapter/testing";
import type { JsonObject } from "@codexhost/protocol-core";
import {
  THREAD_MANUAL_COMPACTION_STARTED_METHOD,
  harnessCommandDescriptorSchema,
  hostItemIdSchema,
  hostTurnIdSchema,
} from "@codexhost/shared-contracts";

import {
  createFixture,
  messageParams,
  method,
  requestId,
  startPiThread,
  startPiTurn,
  stopFixture,
  turnEvent,
  writeRequest,
} from "./app-server-host-fixture.js";

const compactCommand = harnessCommandDescriptorSchema.parse({
  id: "fake.compact",
  invocation: "/compact",
  label: "Compact",
  argumentMode: "text",
});

function compactionStarted(message: JsonObject, turnId: string): boolean {
  return (
    turnEvent(message, "item/started", turnId) &&
    (messageParams(message).item as JsonObject | undefined)?.type === "contextCompaction"
  );
}

function installCompactingCommand(session: FakeHarnessSession, descriptor = compactCommand): void {
  session.commands = {
    list: async () => ({ ok: true, value: { commands: [descriptor] } }),
    execute: async ({ turnId }: HarnessCommandInvocation) => {
      session.publishEphemeralCommand(turnId, {
        type: "contextCompaction",
        itemId: hostItemIdSchema.parse(`compaction-${turnId}`),
      });
      return { ok: true, value: { turnId } };
    },
  };
}

describe("manual compaction announcement", () => {
  it.each([
    ["codexhost/thread/command/execute", "succeeded"],
    ["codexhost/thread/command/execute", "failed"],
    ["codexhost/thread/command/execute", "cancelled"],
    ["turn/start", "succeeded"],
    ["turn/start", "failed"],
    ["turn/start", "cancelled"],
  ] as const)(
    "acknowledges compact through %s before start events and settles %s via the existing command Turn",
    async (requestMethod, status) => {
      const fixture = createFixture();
      try {
        const threadId = await startPiThread(fixture);
        const session = fixture.adapter.sessions[0];
        if (!session) throw new Error("Fake Pi Session was not opened");
        let commandTurnId = hostTurnIdSchema.parse("unused");
        session.commands = {
          list: async () => ({ ok: true, value: { commands: [compactCommand] } }),
          execute: async ({ turnId }) => {
            commandTurnId = turnId;
            return { ok: true, value: { turnId } };
          },
        };
        writeRequest(fixture.desktopInput, {
          id: 2,
          method: requestMethod,
          params:
            requestMethod === "turn/start"
              ? {
                  threadId,
                  clientUserMessageId: "compact-message",
                  input: [{ type: "text", text: "/compact" }],
                }
              : { threadId, commandId: compactCommand.id },
        });
        const response = await fixture.collector.waitFor((message) => requestId(message, 2));
        expect(response.error).toBeUndefined();
        const accepted = await fixture.host.clientSnapshot(threadId);
        expect(accepted.command).toMatchObject({
          name: "compact",
          turn: { id: commandTurnId, status: "inProgress" },
        });
        expect(accepted.turnsPage.data).toEqual([]);
        if (requestMethod === "turn/start")
          expect(accepted.submissions).toMatchObject([
            { clientUserMessageId: "compact-message", execution: "operation", status: "running" },
          ]);
        expect(
          fixture.collector.messages.some((message) =>
            method(message, THREAD_MANUAL_COMPACTION_STARTED_METHOD),
          ),
        ).toBe(false);

        const item = {
          type: "contextCompaction" as const,
          itemId: hostItemIdSchema.parse("legacy-compact"),
        };
        const outcome =
          status === "failed"
            ? {
                status,
                error: {
                  code: "nativeFailure" as const,
                  message: "Compaction failed",
                  retryable: false,
                },
              }
            : { status };
        session.emitEvent({ type: "turn.started", turnId: commandTurnId, ephemeral: true });
        session.emitEvent({ type: "item.started", turnId: commandTurnId, item });
        session.emitEvent({
          type: "item.completed",
          turnId: commandTurnId,
          snapshot: { item, outcome },
        });
        session.emitEvent({ type: "turn.completed", turnId: commandTurnId, outcome });
        await fixture.collector.waitFor((message) =>
          turnEvent(message, "turn/completed", commandTurnId),
        );
        const finished = await fixture.host.clientSnapshot(threadId);
        expect(finished.activeTurnId).toBeNull();
        expect(finished.command?.turn.status).toBe(
          status === "succeeded" ? "completed" : status === "cancelled" ? "interrupted" : "failed",
        );
        expect(finished.turnsPage.data).toEqual([]);
        if (requestMethod === "turn/start")
          expect(finished.submissions?.[0]?.status).toBe(
            status === "succeeded" ? "completed" : status,
          );
        expect(
          fixture.collector.messages.filter((message) =>
            method(message, THREAD_MANUAL_COMPACTION_STARTED_METHOD),
          ),
        ).toEqual([
          {
            method: THREAD_MANUAL_COMPACTION_STARTED_METHOD,
            params: { threadId, turnId: commandTurnId },
          },
        ]);
      } finally {
        await stopFixture(fixture);
      }
    },
  );
  it.each([
    ["the command menu", "codexhost/thread/command/execute"],
    ["a typed /compact", "turn/start"],
  ])(
    "announces a command Turn compaction from %s right before its item/started",
    async (_name, requestMethod) => {
      const fixture = createFixture();
      try {
        const threadId = await startPiThread(fixture);
        const session = fixture.adapter.sessions[0];
        if (!session) throw new Error("Fake Pi Session was not opened");
        installCompactingCommand(session);
        const requestedTurnId = hostTurnIdSchema.parse("manual-compact");
        writeRequest(fixture.desktopInput, {
          id: 2,
          method: requestMethod,
          params:
            requestMethod === "turn/start"
              ? { threadId, input: [{ type: "text", text: "/compact" }] }
              : { threadId, commandId: compactCommand.id, turnId: requestedTurnId },
        });
        const response = await fixture.collector.waitFor((message) => requestId(message, 2));
        const result = response.result as JsonObject;
        const turnId = String(
          requestMethod === "turn/start" ? (result.turn as JsonObject).id : result.turnId,
        );
        await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId));

        const announcements = fixture.collector.messages.filter((message) =>
          method(message, THREAD_MANUAL_COMPACTION_STARTED_METHOD),
        );
        expect(announcements).toEqual([
          { method: THREAD_MANUAL_COMPACTION_STARTED_METHOD, params: { threadId, turnId } },
        ]);
        const index = (predicate: (message: JsonObject) => boolean) =>
          fixture.collector.messages.findIndex(predicate);
        const announced = index((message) =>
          method(message, THREAD_MANUAL_COMPACTION_STARTED_METHOD),
        );
        expect(index((message) => turnEvent(message, "turn/started", turnId))).toBeLessThan(
          announced,
        );
        expect(announced + 1).toBe(index((message) => compactionStarted(message, turnId)));
      } finally {
        await stopFixture(fixture);
      }
    },
  );

  it("runs the Harness /compact for Desktop's thread/compact/start", async () => {
    const fixture = createFixture();
    try {
      const threadId = await startPiThread(fixture);
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Fake Pi Session was not opened");
      const executed: HarnessCommandInvocation[] = [];
      installCompactingCommand(session);
      const commands = session.commands;
      if (!commands) throw new Error("Fake Pi Session has no commands");
      session.commands = {
        ...commands,
        execute: async (invocation: HarnessCommandInvocation) => {
          executed.push(invocation);
          return commands.execute(invocation);
        },
      };
      writeRequest(fixture.desktopInput, {
        id: 2,
        method: "thread/compact/start",
        params: { threadId },
      });
      const response = await fixture.collector.waitFor((message) => requestId(message, 2));
      expect(response.error).toBeUndefined();
      expect(response.result).toEqual({});
      expect(executed.map(({ commandId }) => commandId)).toEqual([compactCommand.id]);
      const turnId = String(executed[0]?.turnId);
      await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId));

      const announcements = fixture.collector.messages.filter((message) =>
        method(message, THREAD_MANUAL_COMPACTION_STARTED_METHOD),
      );
      expect(announcements).toEqual([
        { method: THREAD_MANUAL_COMPACTION_STARTED_METHOD, params: { threadId, turnId } },
      ]);
      const index = (predicate: (message: JsonObject) => boolean) =>
        fixture.collector.messages.findIndex(predicate);
      expect(index((message) => method(message, THREAD_MANUAL_COMPACTION_STARTED_METHOD)) + 1).toBe(
        index((message) => compactionStarted(message, turnId)),
      );
    } finally {
      await stopFixture(fixture);
    }
  });

  it("keeps thread/compact/start unsupported for a Harness without /compact", async () => {
    const fixture = createFixture();
    try {
      const threadId = await startPiThread(fixture);
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Fake Pi Session was not opened");
      installCompactingCommand(
        session,
        harnessCommandDescriptorSchema.parse({
          id: "fake.init",
          invocation: "/init",
          label: "Init",
          argumentMode: "none",
        }),
      );
      writeRequest(fixture.desktopInput, {
        id: 2,
        method: "thread/compact/start",
        params: { threadId },
      });
      const response = await fixture.collector.waitFor((message) => requestId(message, 2));
      expect(response.error).toMatchObject({
        code: -32076,
        message: "External Thread does not support thread/compact/start",
      });
    } finally {
      await stopFixture(fixture);
    }
  });

  it.each(["codexhost/thread/command/execute", "turn/start"])(
    "does not announce automatic compaction inside another command through %s",
    async (requestMethod) => {
      const fixture = createFixture();
      try {
        const threadId = await startPiThread(fixture);
        const session = fixture.adapter.sessions[0];
        if (!session) throw new Error("Fake Pi Session was not opened");
        const initCommand = harnessCommandDescriptorSchema.parse({
          id: "fake.init",
          invocation: "/init",
          label: "Init",
          argumentMode: "none",
        });
        installCompactingCommand(session, initCommand);
        writeRequest(fixture.desktopInput, {
          id: 2,
          method: requestMethod,
          params:
            requestMethod === "turn/start"
              ? { threadId, input: [{ type: "text", text: "/init" }] }
              : { threadId, commandId: initCommand.id },
        });
        const response = await fixture.collector.waitFor((message) => requestId(message, 2));
        const result = response.result as JsonObject;
        const turnId = String(
          requestMethod === "turn/start" ? (result.turn as JsonObject).id : result.turnId,
        );
        await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId));
        expect(
          fixture.collector.messages.some((message) => compactionStarted(message, turnId)),
        ).toBe(true);
        expect(
          fixture.collector.messages.some((message) =>
            method(message, THREAD_MANUAL_COMPACTION_STARTED_METHOD),
          ),
        ).toBe(false);
      } finally {
        await stopFixture(fixture);
      }
    },
  );

  it("does not announce automatic compaction inside an ordinary Turn", async () => {
    const fixture = createFixture();
    try {
      const threadId = await startPiThread(fixture);
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Fake Pi Session was not opened");
      const turnId = await startPiTurn(fixture, threadId);
      await fixture.collector.waitFor((message) => turnEvent(message, "turn/started", turnId));
      const itemId = session.startContextCompaction();
      await fixture.collector.waitFor((message) => compactionStarted(message, turnId));
      session.completeItem(itemId, { status: "succeeded" });
      session.appendText("continued");
      session.succeedTurn();
      await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId));

      expect(
        fixture.collector.messages.some((message) =>
          method(message, THREAD_MANUAL_COMPACTION_STARTED_METHOD),
        ),
      ).toBe(false);
    } finally {
      await stopFixture(fixture);
    }
  });
});
