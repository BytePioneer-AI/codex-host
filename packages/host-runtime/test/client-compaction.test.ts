import { describe, expect, it } from "vitest";
import type { HostItemOutcome } from "@codexhost/harness-adapter";
import {
  harnessCommandDescriptorSchema,
  hostItemIdSchema,
  hostTurnIdSchema,
} from "@codexhost/shared-contracts";
import {
  createFixture,
  startPiThread,
  startPiTurn,
  stopFixture,
  turnEvent,
} from "./app-server-host-fixture.js";

const descriptor = harnessCommandDescriptorSchema.parse({
  id: "fake.compact",
  invocation: "/compact",
  label: "Compact",
  argumentMode: "none",
});

describe("client compaction lifecycle", () => {
  it.each([
    [{ status: "succeeded" }, "completed"],
    [
      {
        status: "failed",
        error: { code: "nativeFailure", message: "Compression failed", retryable: true },
      },
      "failed",
    ],
    [{ status: "cancelled", reason: "Compression cancelled" }, "interrupted"],
  ] as const)(
    "retains a manual command result outside native history: %s",
    async (outcome, status) => {
      const fixture = createFixture();
      try {
        const threadId = await startPiThread(fixture);
        const session = fixture.adapter.sessions[0];
        if (!session) throw new Error("Missing fake Session");
        const turnId = hostTurnIdSchema.parse("manual-client-compact");
        const item = {
          type: "contextCompaction" as const,
          itemId: hostItemIdSchema.parse("manual-item"),
        };
        session.commands = {
          list: async () => ({ ok: true, value: { commands: [descriptor] } }),
          execute: async ({ turnId }) => {
            session.emitEvent({ type: "turn.started", turnId });
            session.emitEvent({ type: "item.started", turnId, item });
            return { ok: true, value: { turnId } };
          },
        };
        expect(
          await fixture.host.handleClientRequest("codexhost/thread/command/execute", {
            threadId,
            commandId: descriptor.id,
            turnId,
          }),
        ).toMatchObject({ result: { accepted: true, turnId } });
        await fixture.collector.waitFor((message) => turnEvent(message, "item/started", turnId));
        const running = await fixture.host.clientSnapshot(threadId);
        expect(running.turnsPage.data).toEqual([]);
        expect(running.command).toMatchObject({
          name: "compact",
          turn: {
            id: turnId,
            status: "inProgress",
            items: [{ type: "contextCompaction", status: "inProgress" }],
          },
        });

        session.emitEvent({ type: "item.completed", turnId, snapshot: { item, outcome } });
        session.emitEvent({ type: "turn.completed", turnId, outcome, ephemeral: true });
        await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId));
        const settled = await fixture.host.clientSnapshot(threadId);
        expect(settled.turnsPage.data).toEqual([]);
        expect(settled.command).toMatchObject({ name: "compact", turn: { id: turnId, status } });
        expect((await fixture.host.clientSnapshot(threadId)).command).toEqual(settled.command);

        // Normal native history can resume without swallowing the command result.
        const next = await startPiTurn(fixture, threadId, 9);
        await fixture.collector.waitFor((message) => turnEvent(message, "turn/started", next));
        const retainedCommand = { ...settled.command, subsequentTurnId: next };
        expect((await fixture.host.clientSnapshot(threadId)).command).toEqual(retainedCommand);
        session.appendText("continued");
        session.succeedTurn();
        await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", next));
        expect((await fixture.host.clientSnapshot(threadId)).command).toEqual(retainedCommand);

        const admission = Promise.withResolvers<undefined>();
        const entered = Promise.withResolvers<undefined>();
        session.commands.execute = async () => {
          entered.resolve(undefined);
          await admission.promise;
          return {
            ok: false,
            error: { code: "unavailable", message: "Not available", retryable: true },
          };
        };
        const request = fixture.host.handleClientRequest("codexhost/thread/command/execute", {
          threadId,
          commandId: descriptor.id,
          turnId: hostTurnIdSchema.parse("rejected"),
        });
        await entered.promise;
        expect((await fixture.host.clientSnapshot(threadId)).command).toEqual(retainedCommand);
        admission.resolve(undefined);
        expect(await request).toHaveProperty("error");
        const rejected = await fixture.host.clientSnapshot(threadId);
        expect(rejected.activeTurnId).toBeNull();
        expect(rejected.command).toEqual(retainedCommand);
      } finally {
        await stopFixture(fixture);
      }
    },
  );

  it("tracks autonomous continuation and resets the marker only for an accepted new command", async () => {
    const fixture = createFixture();
    try {
      const threadId = await startPiThread(fixture);
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Missing fake Session");
      session.commands = {
        list: async () => ({ ok: true, value: { commands: [descriptor] } }),
        execute: async ({ turnId }) => {
          session.emitEvent({ type: "turn.started", turnId });
          return { ok: true, value: { turnId } };
        },
      };
      const runCommand = async (id: string) => {
        const turnId = hostTurnIdSchema.parse(id);
        expect(
          await fixture.host.handleClientRequest("codexhost/thread/command/execute", {
            threadId,
            commandId: descriptor.id,
            turnId,
          }),
        ).toMatchObject({ result: { accepted: true, turnId } });
        await fixture.collector.waitFor((message) => turnEvent(message, "turn/started", turnId));
        const running = (await fixture.host.clientSnapshot(threadId)).command;
        expect(running).toMatchObject({ turn: { id: turnId, status: "inProgress" } });
        expect(running).not.toHaveProperty("subsequentTurnId");
        session.emitEvent({
          type: "turn.completed",
          turnId,
          outcome: { status: "succeeded" },
          ephemeral: true,
        });
        await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId));
        return (await fixture.host.clientSnapshot(threadId)).command;
      };
      const first = await runCommand("first-command");
      for (const id of ["autonomous-first", "autonomous-second"]) {
        const turnId = hostTurnIdSchema.parse(id);
        session.publishAutonomousTurn(turnId, [{ type: "text", text: "Native continuation" }]);
        await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId));
        expect((await fixture.host.clientSnapshot(threadId)).command).toEqual({
          ...first,
          subsequentTurnId: "autonomous-first",
        });
      }
      const second = await runCommand("second-command");
      expect(second).not.toHaveProperty("subsequentTurnId");
      expect((await fixture.host.clientSnapshot(threadId)).turnsPage.data).toHaveLength(2);
    } finally {
      await stopFixture(fixture);
    }
  });

  it("reports automatic compaction settlement before the ordinary Turn completes", async () => {
    const fixture = createFixture();
    try {
      const threadId = await startPiThread(fixture);
      const turnId = await startPiTurn(fixture, threadId);
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Missing fake Session");
      const id = session.startContextCompaction();
      await fixture.collector.waitFor((message) => turnEvent(message, "item/started", turnId));
      expect((await fixture.host.clientSnapshot(threadId)).turnsPage.data[0]?.items).toContainEqual(
        expect.objectContaining({ type: "contextCompaction", status: "inProgress" }),
      );
      const outcome: HostItemOutcome = {
        status: "failed",
        error: { code: "nativeFailure", message: "No summary", retryable: true },
      };
      session.completeItem(id, outcome);
      await fixture.collector.waitFor((message) => turnEvent(message, "item/completed", turnId));
      const snapshot = await fixture.host.clientSnapshot(threadId);
      expect(snapshot.command).toBeUndefined();
      expect(snapshot.turnsPage.data[0]).toMatchObject({
        status: "inProgress",
        items: expect.arrayContaining([
          expect.objectContaining({
            type: "contextCompaction",
            status: "failed",
            error: { message: "No summary" },
          }),
        ]),
      });
    } finally {
      await stopFixture(fixture);
    }
  });
});
