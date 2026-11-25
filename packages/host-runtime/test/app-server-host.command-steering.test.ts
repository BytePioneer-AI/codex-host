import { describe, expect, it, vi } from "vitest";
import type { HarnessCommandInvocation } from "@codexhost/harness-adapter";
import type { JsonObject } from "@codexhost/protocol-core";
import { harnessCommandDescriptorSchema, hostItemIdSchema } from "@codexhost/shared-contracts";

import {
  createFixture,
  requestId,
  startPiThread,
  startPiTurn,
  stopFixture,
  turnEvent,
  writeRequest,
} from "./app-server-host-fixture.js";

const reviewCommand = harnessCommandDescriptorSchema.parse({
  id: "fake.slash.review",
  invocation: "/review",
  label: "Review",
  argumentMode: "text",
});
const chip = "[@/review](subagent://codexhost-command.review)";

describe("Harness command steering", () => {
  it("preserves command-chip argument whitespace on ordinary turn/start submissions too", async () => {
    const fixture = createFixture();
    try {
      const threadId = await startPiThread(fixture);
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Fake Session was not opened");
      const execute = vi.fn(async ({ turnId }: HarnessCommandInvocation) => {
        session.publishEphemeralCommand(turnId, {
          type: "contextCompaction",
          itemId: hostItemIdSchema.parse("review-start"),
        });
        return { ok: true as const, value: { turnId } };
      });
      session.commands = {
        list: async () => ({ ok: true, value: { commands: [reviewCommand] } }),
        execute,
      };
      const text = "Review:\n    aligned  columns\n\tindent";
      writeRequest(fixture.desktopInput, {
        id: 2,
        method: "turn/start",
        params: { threadId, input: [{ type: "text", text: `${chip} ${text}` }] },
      });
      await expect(
        fixture.collector.waitFor((message) => requestId(message, 2)),
      ).resolves.toMatchObject({ result: { turn: { status: "inProgress" } } });
      expect(execute).toHaveBeenCalledExactlyOnceWith({
        turnId: expect.any(String),
        commandId: reviewCommand.id,
        arguments: { text },
      });
    } finally {
      await stopFixture(fixture);
    }
  });

  it.each([chip, "/review"])(
    "dispatches %s through the command contract after stopping the active Turn, once per message",
    async (carrier) => {
      const fixture = createFixture();
      try {
        const threadId = await startPiThread(fixture);
        const oldTurnId = await startPiTurn(fixture, threadId);
        const session = fixture.adapter.sessions[0];
        if (!session) throw new Error("Fake Session was not opened");
        const executeTurn = vi.spyOn(session, "execute");
        const executeCommand = vi.fn(async ({ turnId }: HarnessCommandInvocation) => {
          session.publishEphemeralCommand(turnId, {
            type: "contextCompaction",
            itemId: hostItemIdSchema.parse("review-command"),
          });
          return { ok: true as const, value: { turnId } };
        });
        session.commands = {
          list: async () => ({ ok: true, value: { commands: [reviewCommand] } }),
          execute: executeCommand,
        };
        const argumentsText = "Review code:\n    const x =  1;\n\treturn x;";
        const params = {
          threadId,
          expectedTurnId: oldTurnId,
          clientUserMessageId: "review-message",
          input: [{ type: "text", text: `${carrier} ${argumentsText}` }],
        };
        writeRequest(fixture.desktopInput, { id: 100, method: "turn/steer", params });
        await vi.waitFor(() =>
          expect(executeTurn).toHaveBeenCalledWith({ type: "turn.cancel", turnId: oldTurnId }),
        );
        expect(executeCommand).not.toHaveBeenCalled();
        writeRequest(fixture.desktopInput, { id: 101, method: "turn/steer", params });
        session.completeCancellation();
        const response = await fixture.collector.waitFor((message) => requestId(message, 100));
        expect(response).not.toHaveProperty("error");
        const replacementId = (response.result as JsonObject).turnId;
        expect(typeof replacementId).toBe("string");
        expect(replacementId).not.toBe(oldTurnId);
        await expect(
          fixture.collector.waitFor((message) => requestId(message, 101)),
        ).resolves.toMatchObject({ result: { turnId: replacementId } });
        expect(executeCommand).toHaveBeenCalledExactlyOnceWith({
          turnId: replacementId,
          commandId: reviewCommand.id,
          arguments: { text: argumentsText },
        });
        expect(executeTurn).not.toHaveBeenCalledWith(
          expect.objectContaining({ type: "turn.start" }),
        );
        await fixture.collector.waitFor((message) =>
          turnEvent(message, "turn/completed", String(replacementId)),
        );
        const index = (predicate: (message: JsonObject) => boolean) =>
          fixture.collector.messages.findIndex(predicate);
        expect(index((message) => turnEvent(message, "turn/completed", oldTurnId))).toBeLessThan(
          index((message) => requestId(message, 100)),
        );
        expect(index((message) => requestId(message, 100))).toBeLessThan(
          index((message) => turnEvent(message, "turn/started", String(replacementId))),
        );
      } finally {
        await stopFixture(fixture);
      }
    },
  );

  it("does not execute a replacement command interrupted while its catalog is loading", async () => {
    const fixture = createFixture();
    try {
      const threadId = await startPiThread(fixture);
      const oldTurnId = await startPiTurn(fixture, threadId);
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Fake Session was not opened");
      session.completeCancellationOnRequest();
      const catalog = Promise.withResolvers<{
        ok: true;
        value: { commands: (typeof reviewCommand)[] };
      }>();
      const list = vi.fn(() => catalog.promise);
      const execute = vi.fn(async ({ turnId }: HarnessCommandInvocation) => ({
        ok: true as const,
        value: { turnId },
      }));
      session.commands = { list, execute };
      writeRequest(fixture.desktopInput, {
        id: 100,
        method: "turn/steer",
        params: { threadId, expectedTurnId: oldTurnId, input: [{ type: "text", text: chip }] },
      });
      await vi.waitFor(() => expect(list).toHaveBeenCalledOnce());
      writeRequest(fixture.desktopInput, {
        id: 101,
        method: "turn/interrupt",
        params: { threadId, turnId: oldTurnId },
      });
      await fixture.collector.waitFor((message) => requestId(message, 101));
      catalog.resolve({ ok: true, value: { commands: [reviewCommand] } });
      await expect(
        fixture.collector.waitFor((message) => requestId(message, 100)),
      ).resolves.toMatchObject({ error: { code: -32074 } });
      expect(execute).not.toHaveBeenCalled();
      expect(await startPiTurn(fixture, threadId, 102)).not.toBe(oldTurnId);
    } finally {
      await stopFixture(fixture);
    }
  });

  it.each(["unknown", "catalog failure", "execute failure", "execute throws"])(
    "reports %s without forwarding the chip as text and releases admission for the next Turn",
    async (failure) => {
      const fixture = createFixture();
      try {
        const threadId = await startPiThread(fixture);
        const oldTurnId = await startPiTurn(fixture, threadId);
        const session = fixture.adapter.sessions[0];
        if (!session) throw new Error("Fake Session was not opened");
        session.completeCancellationOnRequest();
        const executeTurn = vi.spyOn(session, "execute");
        session.commands = {
          list: async () =>
            failure === "catalog failure"
              ? {
                  ok: false,
                  error: { code: "unavailable", message: "catalog offline", retryable: true },
                }
              : { ok: true, value: { commands: failure === "unknown" ? [] : [reviewCommand] } },
          execute: async () => {
            if (failure === "execute throws") throw new Error("command failed");
            return {
              ok: false,
              error: { code: "nativeFailure", message: "command failed", retryable: false },
            };
          },
        };
        writeRequest(fixture.desktopInput, {
          id: 100,
          method: "turn/steer",
          params: {
            threadId,
            expectedTurnId: oldTurnId,
            input: [{ type: "text", text: `${chip} code` }],
          },
        });
        await expect(
          fixture.collector.waitFor((message) => requestId(message, 100)),
        ).resolves.toMatchObject({ error: { code: failure === "unknown" ? -32078 : -32073 } });
        expect(executeTurn).not.toHaveBeenCalledWith(
          expect.objectContaining({ type: "turn.start" }),
        );
        expect(await startPiTurn(fixture, threadId, 102)).not.toBe(oldTurnId);
      } finally {
        await stopFixture(fixture);
      }
    },
  );
});
