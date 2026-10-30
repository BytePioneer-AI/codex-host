import { FakeHarnessSession } from "@codexhost/harness-adapter/testing";
import type { JsonObject } from "@codexhost/protocol-core";
import { describe, expect, it, vi } from "vitest";

import {
  createFixture,
  method,
  requestId,
  completePiTurn,
  startPiThread,
  startPiTurn,
  stopFixture,
  turnEvent,
  writeRequest,
} from "./app-server-host-fixture.js";

function steeredUserMessage(message: JsonObject, turnId: string): JsonObject | null {
  if (!method(message, "item/started")) return null;
  const params = message.params as JsonObject;
  const item = params.item as JsonObject;
  return params.turnId === turnId && item.type === "userMessage" ? item : null;
}

describe("Native steering", () => {
  it("sends rewritten Delegation mentions to the Harness and shows the typed text", async () => {
    const fixture = createFixture();
    fixture.adapter.supportsSteer = true;
    try {
      const threadId = await startPiThread(fixture);
      const turnId = await startPiTurn(fixture, threadId);
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Fake Session was not opened");
      const typed = "ask [@Grok](subagent://codexhost.grok) to review";

      writeRequest(fixture.desktopInput, {
        id: 30,
        method: "turn/steer",
        params: {
          threadId,
          expectedTurnId: turnId,
          clientUserMessageId: "mention-message",
          input: [{ type: "text", text: typed }],
        },
      });
      await expect(
        fixture.collector.waitFor((message) => requestId(message, 30)),
      ).resolves.toMatchObject({ result: { turnId, delivery: "activeTurn" } });
      const sent = session.steers[0]?.input[0]?.text ?? "";
      expect(sent).toContain("@Grok to review");
      expect(sent).toContain("[codexhost delegation]");
      const item = await fixture.collector.waitFor(
        (message) => steeredUserMessage(message, turnId) !== null,
      );
      expect(steeredUserMessage(item, turnId)).toMatchObject({
        clientId: "mention-message",
        content: [{ type: "text", text: typed }],
      });
    } finally {
      await stopFixture(fixture);
    }
  });

  it("takes a Desktop steer into the active Turn and settles Desktop's optimistic message", async () => {
    const fixture = createFixture();
    fixture.adapter.supportsSteer = true;
    try {
      const threadId = await startPiThread(fixture);
      const turnId = await startPiTurn(fixture, threadId);
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Fake Session was not opened");

      writeRequest(fixture.desktopInput, {
        id: 10,
        method: "codexhost/thread/steering/inspect",
        params: { threadId },
      });
      await expect(
        fixture.collector.waitFor((message) => requestId(message, 10)),
      ).resolves.toMatchObject({ result: { delivery: "activeTurn" } });

      writeRequest(fixture.desktopInput, {
        id: 11,
        method: "turn/steer",
        params: {
          threadId,
          expectedTurnId: turnId,
          clientUserMessageId: "desktop-message",
          input: [{ type: "text", text: "also check the tests" }],
        },
      });
      await expect(
        fixture.collector.waitFor((message) => requestId(message, 11)),
      ).resolves.toMatchObject({ result: { turnId, delivery: "activeTurn" } });
      const item = await fixture.collector.waitFor(
        (message) => steeredUserMessage(message, turnId) !== null,
      );
      expect(steeredUserMessage(item, turnId)).toMatchObject({
        clientId: "desktop-message",
        content: [{ type: "text", text: "also check the tests" }],
      });
      expect(session.steers).toEqual([expect.objectContaining({ type: "turn.steer", turnId })]);

      session.succeedTurn();
      await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId));
    } finally {
      await stopFixture(fixture);
    }
  });

  it("settles the optimistic message when native acceptance completes the Turn", async () => {
    const fixture = createFixture();
    fixture.adapter.supportsSteer = true;
    try {
      const threadId = await startPiThread(fixture);
      const turnId = await startPiTurn(fixture, threadId);
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Fake Session was not opened");
      session.completeTurnOnNextSteerAcceptance();

      writeRequest(fixture.desktopInput, {
        id: 12,
        method: "turn/steer",
        params: {
          threadId,
          expectedTurnId: turnId,
          clientUserMessageId: "finishing-message",
          input: [{ type: "text", text: "final direction" }],
        },
      });

      await expect(
        fixture.collector.waitFor((message) => requestId(message, 12)),
      ).resolves.toMatchObject({ result: { turnId, delivery: "activeTurn" } });
      const item = await fixture.collector.waitFor(
        (message) => steeredUserMessage(message, turnId) !== null,
      );
      expect(steeredUserMessage(item, turnId)).toMatchObject({
        clientId: "finishing-message",
        content: [{ type: "text", text: "final direction" }],
      });
      const completed = await fixture.collector.waitFor((message) =>
        turnEvent(message, "turn/completed", turnId),
      );
      expect(((completed.params as JsonObject).turn as JsonObject).items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "userMessage", clientId: "finishing-message" }),
        ]),
      );
    } finally {
      await stopFixture(fixture);
    }
  });

  it("refuses Fork and undo of a steered Turn until Desktop rereads the Thread", async () => {
    const fixture = createFixture();
    fixture.adapter.supportsSteer = true;
    try {
      const threadId = await startPiThread(fixture);
      const turnId = await startPiTurn(fixture, threadId);
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Fake Session was not opened");

      writeRequest(fixture.desktopInput, {
        id: 11,
        method: "turn/steer",
        params: {
          threadId,
          expectedTurnId: turnId,
          input: [{ type: "text", text: "also check the tests" }],
        },
      });
      await fixture.collector.waitFor((message) => requestId(message, 11));
      session.succeedTurn();
      await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId));

      writeRequest(fixture.desktopInput, {
        id: 12,
        method: "thread/fork",
        params: { threadId, lastTurnId: turnId },
      });
      await expect(
        fixture.collector.waitFor((message) => requestId(message, 12)),
      ).resolves.toMatchObject({ error: { code: -32080 } });
      writeRequest(fixture.desktopInput, {
        id: 13,
        method: "thread/fork",
        params: { threadId },
      });
      await expect(
        fixture.collector.waitFor((message) => requestId(message, 13)),
      ).resolves.toMatchObject({ error: { code: -32080 } });
      writeRequest(fixture.desktopInput, {
        id: 14,
        method: "thread/rollback",
        params: { threadId, numTurns: 1 },
      });
      await expect(
        fixture.collector.waitFor((message) => requestId(message, 14)),
      ).resolves.toMatchObject({ error: { code: -32080 } });

      const nextTurnId = await completePiTurn(fixture, threadId, 15);
      writeRequest(fixture.desktopInput, {
        id: 16,
        method: "thread/fork",
        params: { threadId, beforeTurnId: nextTurnId },
      });
      await expect(
        fixture.collector.waitFor((message) => requestId(message, 16)),
      ).resolves.toMatchObject({ error: { code: -32080 } });
      expect(fixture.adapter.sessions).toHaveLength(1);

      // Reading items or a page containing only the newer, unsteered Turn must
      // not unlock the earlier steered boundary that Desktop has not reread.
      for (const [index, read] of [
        {
          method: "thread/items/list",
          params: { threadId, turnId: nextTurnId },
        },
        {
          method: "thread/turns/list",
          params: { threadId, limit: 1, sortDirection: "desc" },
        },
        {
          method: "thread/resume",
          params: {
            threadId,
            excludeTurns: true,
            initialTurnsPage: { limit: 1, sortDirection: "desc" },
          },
        },
      ].entries()) {
        const id = 100 + index * 2;
        writeRequest(fixture.desktopInput, { id, ...read });
        await expect(
          fixture.collector.waitFor((message) => requestId(message, id)),
        ).resolves.not.toHaveProperty("error");
        writeRequest(fixture.desktopInput, {
          id: id + 1,
          method: "thread/fork",
          params: { threadId, lastTurnId: turnId },
        });
        await expect(
          fixture.collector.waitFor((message) => requestId(message, id + 1)),
        ).resolves.toMatchObject({ error: { code: -32080 } });
      }

      writeRequest(fixture.desktopInput, { id: 17, method: "thread/resume", params: { threadId } });
      await fixture.collector.waitFor((message) => requestId(message, 17));
      writeRequest(fixture.desktopInput, {
        id: 18,
        method: "thread/fork",
        params: { threadId, lastTurnId: turnId },
      });
      const forked = await fixture.collector.waitFor((message) => requestId(message, 18));
      expect(forked).not.toHaveProperty("error");
    } finally {
      await stopFixture(fixture);
    }
  });

  it("keeps steer protection when a busy Thread read returns live projections", async () => {
    const fixture = createFixture();
    fixture.adapter.supportsSteer = true;
    try {
      const threadId = await startPiThread(fixture);
      const turnId = await startPiTurn(fixture, threadId);
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Fake Session was not opened");
      writeRequest(fixture.desktopInput, {
        id: 30,
        method: "turn/steer",
        params: {
          threadId,
          expectedTurnId: turnId,
          input: [{ type: "text", text: "keep this input" }],
        },
      });
      await fixture.collector.waitFor((message) => requestId(message, 30));
      session.succeedTurn();
      await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId));
      const nextTurnId = await startPiTurn(fixture, threadId, 31);
      writeRequest(fixture.desktopInput, {
        id: 32,
        method: "thread/read",
        params: { threadId, includeTurns: true },
      });
      await expect(
        fixture.collector.waitFor((message) => requestId(message, 32)),
      ).resolves.not.toHaveProperty("error");
      session.succeedTurn();
      await fixture.collector.waitFor((message) =>
        turnEvent(message, "turn/completed", nextTurnId),
      );
      writeRequest(fixture.desktopInput, {
        id: 33,
        method: "thread/fork",
        params: { threadId, lastTurnId: turnId },
      });
      await expect(
        fixture.collector.waitFor((message) => requestId(message, 33)),
      ).resolves.toMatchObject({ error: { code: -32080 } });
    } finally {
      await stopFixture(fixture);
    }
  });

  it("keeps Fork and undo blocked after idle Session restoration until history is read", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const fixture = createFixture();
    fixture.adapter.supportsSteer = true;
    try {
      const threadId = await startPiThread(fixture);
      const turnId = await startPiTurn(fixture, threadId);
      const source = fixture.adapter.sessions[0];
      if (!source) throw new Error("Fake Session was not opened");
      writeRequest(fixture.desktopInput, {
        id: 21,
        method: "turn/steer",
        params: {
          threadId,
          expectedTurnId: turnId,
          input: [{ type: "text", text: "preserve this direction" }],
        },
      });
      await fixture.collector.waitFor((message) => requestId(message, 21));
      source.succeedTurn();
      await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId));
      const snapshot = await source.readSnapshot();
      if (!snapshot.ok) throw new Error(snapshot.error.message);
      const nativeOpen = fixture.adapter.open.bind(fixture.adapter);
      vi.spyOn(fixture.adapter, "open").mockImplementation(async (input) => {
        if (input.kind === "resume") {
          return {
            ok: true,
            value: new FakeHarnessSession(
              fixture.adapter.harnessId,
              fixture.adapter.catalog,
              undefined,
              input.nativeRef,
              snapshot.value,
            ),
          };
        }
        if (input.kind === "fork") {
          const nativeSessionId = `${input.sourceRef.nativeSessionId}-fork`;
          return {
            ok: true,
            value: new FakeHarnessSession(
              fixture.adapter.harnessId,
              fixture.adapter.catalog,
              undefined,
              { ...input.sourceRef, nativeSessionId },
              {
                ...snapshot.value,
                turns: snapshot.value.turns.map((turn) => ({
                  ...turn,
                  nativeTurnRef: { ...turn.nativeTurnRef, nativeSessionId },
                  ...(turn.checkpoint
                    ? { checkpoint: { ...turn.checkpoint, nativeSessionId } }
                    : {}),
                })),
              },
            ),
          };
        }
        return nativeOpen(input);
      });
      writeRequest(fixture.desktopInput, {
        id: 22,
        method: "codexhost/settings/idle-release/set",
        params: { enabled: true, timeoutMinutes: 10 },
      });
      await fixture.collector.waitFor((message) => requestId(message, 22));
      await vi.advanceTimersByTimeAsync(11 * 60_000);

      writeRequest(fixture.desktopInput, {
        id: 23,
        method: "thread/fork",
        params: { threadId, lastTurnId: turnId },
      });
      await expect(
        fixture.collector.waitFor((message) => requestId(message, 23)),
      ).resolves.toMatchObject({ error: { code: -32080 } });
      writeRequest(fixture.desktopInput, {
        id: 24,
        method: "thread/rollback",
        params: { threadId, numTurns: 1 },
      });
      await expect(
        fixture.collector.waitFor((message) => requestId(message, 24)),
      ).resolves.toMatchObject({ error: { code: -32080 } });

      writeRequest(fixture.desktopInput, { id: 25, method: "thread/resume", params: { threadId } });
      await fixture.collector.waitFor((message) => requestId(message, 25));
      writeRequest(fixture.desktopInput, {
        id: 26,
        method: "thread/fork",
        params: { threadId, lastTurnId: turnId },
      });
      await expect(
        fixture.collector.waitFor((message) => requestId(message, 26)),
      ).resolves.not.toHaveProperty("error");
    } finally {
      await stopFixture(fixture);
      vi.useRealTimers();
    }
  });

  it("reports replacement mode for a Session without native steering", async () => {
    const fixture = createFixture();
    try {
      const threadId = await startPiThread(fixture);
      await startPiTurn(fixture, threadId);
      writeRequest(fixture.desktopInput, {
        id: 10,
        method: "codexhost/thread/steering/inspect",
        params: { threadId },
      });
      await expect(
        fixture.collector.waitFor((message) => requestId(message, 10)),
      ).resolves.toMatchObject({ result: { delivery: "newTurn" } });
    } finally {
      await stopFixture(fixture);
    }
  });
});

describe("Native steering fallbacks", () => {
  it("guards undoing only the Turns that took steered input", async () => {
    const fixture = createFixture();
    fixture.adapter.supportsSteer = true;
    try {
      const threadId = await startPiThread(fixture);
      const turnId = await startPiTurn(fixture, threadId);
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Fake Session was not opened");
      writeRequest(fixture.desktopInput, {
        id: 60,
        method: "turn/steer",
        params: {
          threadId,
          expectedTurnId: turnId,
          input: [{ type: "text", text: "also check the tests" }],
        },
      });
      await fixture.collector.waitFor((message) => requestId(message, 60));
      session.succeedTurn();
      await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId));
      await completePiTurn(fixture, threadId, 61);

      writeRequest(fixture.desktopInput, {
        id: 62,
        method: "thread/rollback",
        params: { threadId, numTurns: 2 },
      });
      await expect(
        fixture.collector.waitFor((message) => requestId(message, 62)),
      ).resolves.toMatchObject({ error: { code: -32080 } });
      writeRequest(fixture.desktopInput, {
        id: 63,
        method: "thread/rollback",
        params: { threadId, numTurns: 1 },
      });
      const undoLast = await fixture.collector.waitFor((message) => requestId(message, 63));
      expect((undoLast.error as JsonObject | undefined)?.code).not.toBe(-32080);
    } finally {
      await stopFixture(fixture);
    }
  });

  function steer(
    fixture: ReturnType<typeof createFixture>,
    id: number,
    threadId: string,
    turnId: string,
    text: string,
    extra: JsonObject = {},
  ): Promise<JsonObject> {
    writeRequest(fixture.desktopInput, {
      id,
      method: "turn/steer",
      params: {
        threadId,
        expectedTurnId: turnId,
        clientUserMessageId: `message-${id}`,
        input: [{ type: "text", text }],
        ...extra,
      },
    });
    return fixture.collector.waitFor((message) => requestId(message, id));
  }

  it("stops and restarts when the Harness does not take native input", async () => {
    const fixture = createFixture();
    fixture.adapter.supportsSteer = true;
    try {
      const threadId = await startPiThread(fixture);
      const turnId = await startPiTurn(fixture, threadId);
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Fake Session was not opened");
      session.refuseNextSteer();
      session.completeCancellationOnRequest();
      const response = await steer(fixture, 40, threadId, turnId, "take this instead");
      expect(response).toMatchObject({ result: { delivery: "newTurn" } });
      expect((response.result as JsonObject).turnId).not.toBe(turnId);
      expect(session.steers).toHaveLength(0);
      expect(
        fixture.collector.messages.some((message) => steeredUserMessage(message, turnId) !== null),
      ).toBe(false);
      session.succeedTurn();
    } finally {
      await stopFixture(fixture);
    }
  });

  it("keeps a Renderer-presented activeTurn delivery instead of restarting", async () => {
    const fixture = createFixture();
    fixture.adapter.supportsSteer = true;
    try {
      const threadId = await startPiThread(fixture);
      const turnId = await startPiTurn(fixture, threadId);
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Fake Session was not opened");
      session.refuseNextSteer();
      await expect(
        steer(fixture, 41, threadId, turnId, "presented in this Turn", {
          codexhostSteerDelivery: "activeTurn",
        }),
      ).resolves.toMatchObject({ error: { code: -32074 } });
      await expect(
        steer(fixture, 42, threadId, turnId, "now it joins", {
          codexhostSteerDelivery: "activeTurn",
        }),
      ).resolves.toMatchObject({ result: { turnId, delivery: "activeTurn" } });
      session.succeedTurn();
    } finally {
      await stopFixture(fixture);
    }
  });

  it("follows a Renderer-presented newTurn delivery even when native steering is available", async () => {
    const fixture = createFixture();
    fixture.adapter.supportsSteer = true;
    try {
      const threadId = await startPiThread(fixture);
      const turnId = await startPiTurn(fixture, threadId);
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Fake Session was not opened");
      session.completeCancellationOnRequest();
      const response = await steer(fixture, 43, threadId, turnId, "restart with this", {
        codexhostSteerDelivery: "newTurn",
      });
      expect(response).toMatchObject({ result: { delivery: "newTurn" } });
      expect(session.steers).toHaveLength(0);
      session.succeedTurn();
    } finally {
      await stopFixture(fixture);
    }
  });

  it("stops and restarts for a Harness command, and inspection says so", async () => {
    const fixture = createFixture();
    fixture.adapter.supportsSteer = true;
    try {
      const threadId = await startPiThread(fixture);
      const turnId = await startPiTurn(fixture, threadId);
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Fake Session was not opened");
      session.commands = {
        list: async () => ({ ok: true, value: { commands: [] } }),
        execute: async ({ turnId: commandTurnId }) => ({
          ok: true,
          value: { turnId: commandTurnId },
        }),
      };
      writeRequest(fixture.desktopInput, {
        id: 44,
        method: "codexhost/thread/steering/inspect",
        params: { threadId, text: "/compact" },
      });
      await expect(
        fixture.collector.waitFor((message) => requestId(message, 44)),
      ).resolves.toMatchObject({ result: { delivery: "newTurn" } });
      writeRequest(fixture.desktopInput, {
        id: 45,
        method: "codexhost/thread/steering/inspect",
        params: { threadId, text: "plain direction" },
      });
      await expect(
        fixture.collector.waitFor((message) => requestId(message, 45)),
      ).resolves.toMatchObject({ result: { delivery: "activeTurn" } });
      session.completeCancellationOnRequest();
      await steer(fixture, 46, threadId, turnId, "/compact");
      expect(session.steers).toHaveLength(0);
      await vi.waitFor(() =>
        expect(fixture.collector.messages.some((message) => method(message, "turn/started"))).toBe(
          true,
        ),
      );
    } finally {
      await stopFixture(fixture);
    }
  });
});
