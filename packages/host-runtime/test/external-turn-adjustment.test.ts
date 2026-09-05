import { describe, expect, it, vi } from "vitest";
import type { HostCommand } from "@codexhost/harness-adapter";
import { FakeHarnessAdapter } from "@codexhost/harness-adapter/testing";
import type { StoredThreadRecordV1 } from "@codexhost/mapping-store";
import { CodexTurnProjector } from "@codexhost/protocol-core";
import { harnessIdSchema, hostThreadIdSchema, hostTurnIdSchema } from "@codexhost/shared-contracts";

import type { ExternalThreadRepository } from "../src/external-thread-repository.js";
import { ExternalThreadRuntime } from "../src/external-thread-runtime.js";
import { ExternalTurnAdjustments } from "../src/external-turn-adjustment.js";

async function fixture(timeoutMs = 30_000) {
  const adapter = new FakeHarnessAdapter(harnessIdSchema.parse("pi"));
  const opened = await adapter.open({ kind: "create", cwd: "/synthetic" });
  if (!opened.ok) throw new Error(opened.error.message);
  const session = opened.value;
  Object.defineProperty(session, "capabilities", {
    value: {
      ...session.capabilities,
      activeTurns: { steer: false, interruptAndContinue: true },
    },
  });
  const threadId = hostThreadIdSchema.parse("thread");
  const turnId = hostTurnIdSchema.parse("old-turn");
  const runtime = new ExternalThreadRuntime({
    adapters: new Map([["pi", adapter]]),
    repository: { find: async () => null } as unknown as ExternalThreadRepository,
    consumeOutputs: async () => undefined,
    diagnose: () => undefined,
  });
  const thread = runtime.register({
    record: {
      formatVersion: 1,
      revision: 1,
      hostThreadId: threadId,
      createRequestId: "create",
      harnessId: adapter.harnessId,
      state: "ready",
      nativeSessionRef: session.initialState.nativeRef,
      cwd: "/synthetic",
      title: "test",
      archived: false,
      transportModelId: "codexhost/pi-native",
      ephemeral: false,
      historyMode: "legacy",
      turnMappings: [],
      createdAt: "2026-09-05T00:00:00.000Z",
      updatedAt: "2026-09-05T00:00:00.000Z",
    } as StoredThreadRecordV1,
    session,
    sessionId: threadId,
    thread: { id: threadId },
    turns: [],
  });
  thread.running = true;
  thread.activeTurnId = turnId;
  thread.projectedTurns.set(turnId, {
    projector: new CodexTurnProjector({
      threadId,
      turnId,
      cwd: thread.cwd,
      startedAtMs: Date.now(),
    }),
  });
  const adjustments = new ExternalTurnAdjustments(runtime, timeoutMs);
  const params = {
    threadId,
    expectedTurnId: turnId,
    clientUserMessageId: "client",
    input: [{ type: "text", text: "adjust" }],
  };
  return { session, thread, runtime, adjustments, params, turnId };
}

describe("External Turn adjustment cancellation boundaries", () => {
  it.each(["timeout", "stop", "close"])(
    "holds execution until outstanding cancellation settles after %s",
    async (action) => {
      const f = await fixture(action === "timeout" ? 20 : 30_000);
      const cancel = Promise.withResolvers<never>();
      const execute = vi.spyOn(f.session, "execute").mockImplementationOnce(() => cancel.promise);
      const result = f.adjustments.execute(f.thread, f.params);
      await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
      // Native terminal can arrive before the cancellation RPC itself returns.
      f.thread.running = false;
      f.thread.activeTurnId = null;
      f.adjustments.terminal(f.thread, {
        type: "turn.completed",
        turnId: f.turnId,
        outcome: { status: "succeeded" },
      });
      if (action === "stop") await f.adjustments.stop(f.thread, f.turnId);
      if (action === "close") f.adjustments.close();
      expect(await result).toMatchObject({ ok: false });
      expect(f.runtime.canStartSessionOperation(f.thread)).toBe(false);
      expect(f.runtime.beginHistoryMutation(f.thread)).toBeNull();
      cancel.resolve({
        ok: false,
        error: { code: "invalidState", message: "Ended", retryable: false },
      } as never);
      await vi.waitFor(() => expect(f.runtime.canStartSessionOperation(f.thread)).toBe(true));
      expect(execute).toHaveBeenCalledOnce();
      await f.session.close();
    },
  );

  it("cancels the newly admitted Turn when Stop races continuation admission", async () => {
    const f = await fixture();
    const admission = Promise.withResolvers<never>();
    const execute = vi
      .spyOn(f.session, "execute")
      .mockResolvedValueOnce({ ok: true, value: { cancellationRequested: true } } as never)
      .mockImplementationOnce(() => admission.promise)
      .mockResolvedValueOnce({ ok: true, value: { cancellationRequested: true } } as never);
    const result = f.adjustments.execute(f.thread, f.params);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    f.thread.running = false;
    f.thread.activeTurnId = null;
    f.adjustments.terminal(f.thread, {
      type: "turn.completed",
      turnId: f.turnId,
      outcome: { status: "cancelled" },
    });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    const nextTurnId = f.thread.activeTurnId;
    expect(nextTurnId).not.toBe(f.turnId);
    const stop = f.adjustments.stop(f.thread, f.turnId);
    admission.resolve({ ok: true, value: { turnId: nextTurnId } } as never);
    const outcome = await result;
    expect(outcome).toMatchObject({ ok: true, value: { turnId: nextTurnId } });
    outcome.releaseProjectionGate();
    expect(await stop).toBe(true);
    expect(execute.mock.calls.map(([command]) => (command as HostCommand).type)).toEqual([
      "turn.cancel",
      "turn.start",
      "turn.cancel",
    ]);
    expect(execute).toHaveBeenLastCalledWith({ type: "turn.cancel", turnId: nextTurnId });
    await f.session.close();
  });

  it("rejects new adjustments after Host closure", async () => {
    const f = await fixture();
    const execute = vi.spyOn(f.session, "execute");
    f.adjustments.close();
    expect(await f.adjustments.execute(f.thread, f.params)).toMatchObject({
      ok: false,
      message: "Host closed before adjustment",
    });
    expect(execute).not.toHaveBeenCalled();
    await f.session.close();
  });

  it.each(["unsupported", "stale", "invalid-input", "ephemeral"])(
    "rejects %s without issuing cancel",
    async (condition) => {
      const f = await fixture();
      if (condition === "unsupported")
        Object.assign(f.session.capabilities.activeTurns ?? {}, { interruptAndContinue: false });
      if (condition === "stale") f.params.expectedTurnId = hostTurnIdSchema.parse("stale");
      if (condition === "invalid-input") f.params.input = [];
      if (condition === "ephemeral") f.thread.ephemeralTurnIds.add(f.turnId);
      const execute = vi.spyOn(f.session, "execute");
      expect(await f.adjustments.execute(f.thread, f.params)).toMatchObject({ ok: false });
      expect(execute).not.toHaveBeenCalled();
      await f.session.close();
    },
  );
});
