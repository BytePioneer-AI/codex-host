import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  HarnessResult,
  TurnStartAccepted,
  TurnStartCommand,
} from "@codexhost/harness-adapter";
import { hostThreadIdSchema, hostTurnIdSchema } from "@codexhost/shared-contracts";
import { MappingStore } from "@codexhost/mapping-store";
import { describe, expect, it, vi } from "vitest";
import {
  createFixture,
  requestId,
  startPiThread,
  startPiTurn,
  stopFixture,
  turnEvent,
  writeRequest,
} from "./app-server-host-fixture.js";

describe("AppServerHost Turn recency", () => {
  it.each([
    ["succeeded", "2026-01-01T00:02:00.000Z"],
    ["failed without native identity", "2026-01-01T00:02:00.000Z"],
    ["failed after the clock moved backwards", "2026-01-01T00:00:30.000Z"],
  ] as const)("tracks External Thread recency when a Turn %s", async (outcome, endTime) => {
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    const mappingStoreDirectory = mkdtempSync(path.join(tmpdir(), "codexhost-host-test-"));
    const mappingStore = new MappingStore({
      directory: mappingStoreDirectory,
      now: () => new Date(now),
    });
    const fixture = createFixture({ mappingStore, mappingStoreDirectory });
    try {
      const threadId = await startPiThread(fixture);
      const hostThreadId = hostThreadIdSchema.parse(threadId);
      const updatedAt = async () => (await mappingStore.getThread(hostThreadId))?.updatedAt;
      expect(await updatedAt()).toBe("2026-01-01T00:00:00.000Z");

      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Fake Pi Session was not opened");
      if (outcome !== "succeeded") {
        const turnSession: {
          execute(command: TurnStartCommand): Promise<HarnessResult<TurnStartAccepted>>;
        } = session;
        vi.spyOn(turnSession, "execute").mockImplementationOnce(async ({ turnId }) => {
          session.emitEvent({ type: "turn.started", turnId });
          return { ok: true, value: { turnId } };
        });
      }
      const startTime = "2026-01-01T00:01:00.000Z";
      now = Date.parse(startTime);
      const turnId = hostTurnIdSchema.parse(await startPiTurn(fixture, threadId));
      await fixture.collector.waitFor((message) => turnEvent(message, "turn/started", turnId));
      await vi.waitFor(async () => expect(await updatedAt()).toBe(startTime));

      now = Date.parse(endTime);
      if (outcome === "succeeded") {
        session.appendText("answer");
        session.succeedTurn();
      } else {
        session.emitEvent({
          type: "turn.completed",
          turnId,
          outcome: {
            status: "failed",
            error: { code: "nativeFailure", message: "Native Turn failed", retryable: false },
          },
        });
      }
      await expect(
        fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId)),
      ).resolves.toMatchObject({
        params: { turn: { status: outcome === "succeeded" ? "completed" : "failed" } },
      });
      if (outcome !== "succeeded") {
        expect((await mappingStore.getThread(hostThreadId))?.turnMappings).toEqual([]);
      }
      if (endTime >= startTime) expect(await updatedAt()).toBe(endTime);

      writeRequest(fixture.desktopInput, {
        id: 3,
        method: "thread/read",
        params: { threadId, includeTurns: false },
      });
      const expectedTime = Date.parse(endTime >= startTime ? endTime : startTime) / 1_000;
      await expect(
        fixture.collector.waitFor((message) => requestId(message, 3)),
      ).resolves.toMatchObject({
        result: { thread: { updatedAt: expectedTime, recencyAt: expectedTime } },
      });
    } finally {
      await stopFixture(fixture);
    }
  });
});
