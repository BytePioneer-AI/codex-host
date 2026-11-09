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
