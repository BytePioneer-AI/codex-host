import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";
import type { JsonObject } from "@codexhost/protocol-core";
import type { FakeHarnessSession } from "@codexhost/harness-adapter/testing";
import {
  harnessIdSchema,
  hostThreadIdSchema,
  hostTurnIdSchema,
  type HostItemId,
  type HostTurnId,
  LOADED_SESSIONS_METHOD,
  nativeSessionRefSchema,
} from "@codexhost/shared-contracts";

import {
  createFixture,
  requestId,
  startPiThread,
  startPiTurn,
  stopFixture,
  turnEvent,
  writeRequest,
} from "./app-server-host-fixture.js";

type Fixture = ReturnType<typeof createFixture>;

function responseItems(response: JsonObject): JsonObject[] {
  const result = (response.result ?? {}) as JsonObject;
  const thread = (result.thread ?? {}) as JsonObject;
  const turns = (thread.turns ?? []) as JsonObject[];
  return turns.flatMap((turn) => (turn.items ?? []) as JsonObject[]);
}

async function clean(fixture: Fixture, threadId: string, id: number): Promise<JsonObject> {
  writeRequest(fixture.desktopInput, {
    id,
    method: "thread/backgroundTerminals/clean",
    params: { threadId },
  });
  const response = await fixture.collector.waitFor((message) => requestId(message, id));
  return (response ?? {}) as JsonObject;
}

async function readHistory(fixture: Fixture, threadId: string, id: number): Promise<JsonObject[]> {
  writeRequest(fixture.desktopInput, {
    id,
    method: "thread/read",
    params: { threadId, includeTurns: true },
  });
  const response = await fixture.collector.waitFor((message) => requestId(message, id));
  return responseItems(response as JsonObject).filter((item) => item.type === "commandExecution");
}

interface DetachedCommand {
  session: FakeHarnessSession;
  turnId: HostTurnId;
  itemId: HostItemId;
}

/** Runs one Turn whose command detaches; the Turn completes while it runs. */
async function startDetachedTurn(
  fixture: Fixture,
  threadId: string,
  id: number,
): Promise<DetachedCommand> {
  const turnId = await startPiTurn(fixture, threadId, id);
  const session = fixture.adapter.sessions[0];
  if (!session) throw new Error("Fake Pi Session was not opened");
  const itemId = session.startCommandExecution("sleep 100");
  session.detachItem(itemId);
  session.appendText("done");
  session.succeedTurn();
  await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId));
  return { session, turnId: hostTurnIdSchema.parse(turnId), itemId };
}

function appendOutput({ session, turnId, itemId }: DetachedCommand, text: string): void {
  session.emitEvent({
    type: "item.updated",
    turnId,
    itemId,
    update: { type: "output.append", text },
  });
}

function settle({ session, turnId, itemId }: DetachedCommand): void {
  session.emitEvent({
    type: "item.completed",
    turnId,
    snapshot: {
      item: { type: "commandExecution", itemId, command: "sleep 100", cwd: "/synthetic" },
      outcome: { status: "succeeded" },
    },
  });
}

function completedItem(fixture: Fixture, itemId: HostItemId): Promise<JsonObject> {
  return fixture.collector.waitFor(
    (message) =>
      message.method === "item/completed" &&
      ((message.params as JsonObject)?.item as JsonObject | undefined)?.id === itemId,
  );
}

describe("AppServerHost background terminals", () => {
  it("keeps a detached command Item alive across its Turn and settles it later", async () => {
    const fixture = createFixture();
    try {
      const threadId = await startPiThread(fixture);
      const command = await startDetachedTurn(fixture, threadId, 2);

      // The Turn completed; output and completion still arrive on it.
      appendOutput(command, "ready\n");
      await fixture.collector.waitFor(
        (message) =>
          message.method === "item/commandExecution/outputDelta" &&
          (message.params as JsonObject)?.itemId === command.itemId,
      );
      settle(command);
      const completed = await completedItem(fixture, command.itemId);
      expect((completed.params as JsonObject)?.item).toMatchObject({
        id: command.itemId,
        type: "commandExecution",
        status: "completed",
      });
    } finally {
      await stopFixture(fixture);
    }
  });

  it("overlays an unsettled background command onto served history until it settles", async () => {
    const fixture = createFixture();
    try {
      const threadId = await startPiThread(fixture);
      const command = await startDetachedTurn(fixture, threadId, 2);
      appendOutput(command, "ready\n");

      expect(await readHistory(fixture, threadId, 3)).toMatchObject([
        { id: command.itemId, status: "inProgress", aggregatedOutput: "ready\n" },
      ]);

      settle(command);
      await completedItem(fixture, command.itemId);
      expect(await readHistory(fixture, threadId, 4)).toMatchObject([
        { id: command.itemId, status: "completed" },
      ]);
    } finally {
      await stopFixture(fixture);
    }
  });

  it("appends an unsettled background command that history does not contain", async () => {
    const fixture = createFixture();
    try {
      const threadId = await startPiThread(fixture);
      const command = await startDetachedTurn(fixture, threadId, 2);
      const readSnapshot = command.session.readSnapshot.bind(command.session);
      command.session.readSnapshot = async () => {
        const snapshot = await readSnapshot();
        if (!snapshot.ok) return snapshot;
        const turns = snapshot.value.turns.map((turn) => ({
          ...turn,
          items: turn.items.filter(({ item }) => item.itemId !== command.itemId),
        }));
        return { ...snapshot, value: { ...snapshot.value, turns } };
      };

      expect(await readHistory(fixture, threadId, 3)).toMatchObject([
        { id: command.itemId, status: "inProgress" },
      ]);
    } finally {
      await stopFixture(fixture);
    }
  });

  it("stops background terminals only through a loaded Session that supports it", async () => {
    const fixture = createFixture();
    try {
      await fixture.ready;
      // A stored Thread with no loaded Session has no background terminals.
      const record = await fixture.mappingStore.createProvisional({
        hostThreadId: hostThreadIdSchema.parse(randomUUID()),
        createRequestId: "synthetic-background-clean",
        harnessId: harnessIdSchema.parse("pi"),
        cwd: "/synthetic",
        title: "Unloaded",
        transportModelId: "codexhost/pi-native",
        ephemeral: false,
        historyMode: "legacy",
      });
      await fixture.mappingStore.commitReady({
        hostThreadId: record.hostThreadId,
        nativeSessionRef: nativeSessionRefSchema.parse({
          harnessId: "pi",
          nativeSessionId: "unloaded-session",
          formatVersion: 1,
        }),
      });
      expect(await clean(fixture, record.hostThreadId, 2)).toMatchObject({ result: {} });

      const threadId = await startPiThread(fixture);
      expect(await clean(fixture, threadId, 3)).toMatchObject({
        error: {
          code: -32076,
          message: "External Harness does not support stopping background terminals",
        },
      });

      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Fake Pi Session was not opened");
      Object.assign(session, {
        stopBackgroundWork: async () => ({ ok: true as const, value: undefined }),
      });
      expect(await clean(fixture, threadId, 4)).toMatchObject({ result: {} });

      Object.assign(session, {
        stopBackgroundWork: async () => ({
          ok: false as const,
          error: {
            code: "nativeFailure" as const,
            message: "native stop rejected",
            retryable: true,
          },
        }),
      });
      expect(await clean(fixture, threadId, 5)).toMatchObject({
        error: { code: -32083, message: "native stop rejected" },
      });
    } finally {
      await stopFixture(fixture);
    }
  });

  it("keeps a Session with native background work from idle release", async () => {
    const fixture = createFixture();
    try {
      const threadId = await startPiThread(fixture);
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Fake Pi Session was not opened");
      Object.assign(session, { hasBackgroundWork: () => true });
      writeRequest(fixture.desktopInput, { id: 2, method: LOADED_SESSIONS_METHOD, params: {} });
      const response = await fixture.collector.waitFor((message) => requestId(message, 2));
      expect(
        (response.result as JsonObject[]).find((entry) => entry.threadId === threadId),
      ).toMatchObject({
        state: "busy",
        reason: "background",
      });
    } finally {
      await stopFixture(fixture);
    }
  });
});
