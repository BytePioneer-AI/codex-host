import { FakeHarnessAdapter, FakeHarnessSession } from "@codexhost/harness-adapter/testing";
import type { StoredThreadRecordV1 } from "@codexhost/mapping-store";
import { harnessIdSchema, hostThreadIdSchema, hostTurnIdSchema } from "@codexhost/shared-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopRequestQueue } from "../src/desktop-request-queue.js";
import type { ExternalThreadRepository } from "../src/external-thread-repository.js";
import { ExternalThreadRuntime } from "../src/external-thread-runtime.js";

const MINUTE = 60_000;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture() {
  const adapter = new FakeHarnessAdapter(harnessIdSchema.parse("pi"));
  const opened = await adapter.open({ kind: "create", cwd: "/synthetic" });
  if (!opened.ok) throw new Error(opened.error.message);
  const session = opened.value;
  const nativeSessionRef = session.initialState.nativeRef;
  if (!nativeSessionRef) throw new Error("Missing native identity");
  const id = hostThreadIdSchema.parse("idle-thread");
  const record: StoredThreadRecordV1 = {
    formatVersion: 1,
    revision: 1,
    hostThreadId: id,
    createRequestId: "create-idle",
    harnessId: adapter.harnessId,
    state: "ready",
    nativeSessionRef,
    cwd: "/synthetic",
    title: "Idle",
    archived: false,
    transportModelId: "codexhost/pi-native",
    ephemeral: false,
    historyMode: "legacy",
    turnMappings: [],
    createdAt: "2026-09-15T00:00:00.000Z",
    updatedAt: "2026-09-15T00:00:00.000Z",
  } as StoredThreadRecordV1;
  const repository = {
    find: async () => record,
    alignSnapshot: async () => ({ record, turns: [] }),
    sessionTreeId: async () => id,
  } as unknown as ExternalThreadRepository;
  const queue = new DesktopRequestQueue();
  const canRelease = vi.fn(() => true);
  const diagnose = vi.fn();
  const onClosed = vi.fn(async () => undefined);
  const runtime = new ExternalThreadRuntime({
    adapters: new Map([["pi", adapter]]),
    repository,
    consumeOutputs: async (thread) => {
      for await (const output of thread.session.outputs) void output;
    },
    diagnose,
    idleRelease: { queue, canRelease, onClosed },
  });
  const thread = runtime.register({ record, session, sessionId: id, thread: { id }, turns: [] });
  const close = vi.spyOn(session, "close");
  const nativeOpen = adapter.open.bind(adapter);
  // The shared Fake Adapter resumes the same object, unlike a native persisted session.
  const open = vi.spyOn(adapter, "open").mockImplementation(async (input) =>
    input.kind === "resume"
      ? {
          ok: true,
          value: new FakeHarnessSession(
            adapter.harnessId,
            adapter.catalog,
            undefined,
            input.nativeRef,
          ),
        }
      : nativeOpen(input),
  );
  const idle = runtime.idleRelease;
  return { runtime, thread, id, idle, close, open, queue, diagnose, canRelease, onClosed };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("external Thread idle release", () => {
  it("is disabled by default; validates settings before applying them", async () => {
    const f = await fixture();
    await vi.advanceTimersByTimeAsync(31 * MINUTE);
    f.idle.check();
    await f.queue.drain();
    expect(f.close).not.toHaveBeenCalled();
    for (const timeoutMinutes of [0, 4, 1441, 10.5, NaN, Infinity]) {
      expect(() => f.idle.configure({ enabled: true, timeoutMinutes })).toThrow();
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("lists loaded status without refreshing activity or restoring released sessions", async () => {
    const f = await fixture();
    expect(f.idle.list()[0]).toMatchObject({
      threadId: f.id,
      state: "idle",
      reason: "disabled",
      inactiveMs: 0,
    });
    f.idle.configure({ enabled: true, timeoutMinutes: 10 });
    await vi.advanceTimersByTimeAsync(9 * MINUTE);
    expect(f.idle.list()[0]).toMatchObject({
      state: "idle",
      reason: "timeout",
      inactiveMs: 9 * MINUTE,
    });
    f.thread.running = true;
    expect(f.idle.list()[0]).toMatchObject({ state: "running", reason: "operation" });
    f.thread.running = false;
    f.canRelease.mockReturnValue(false);
    expect(f.idle.list()[0]).toMatchObject({ state: "busy", reason: "background" });
    f.canRelease.mockReturnValue(true);
    f.thread.persistenceError = new Error("Store failed");
    expect(f.idle.list()[0]).toMatchObject({ state: "blocked", reason: "persistence" });
    f.thread.persistenceError = null;
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(f.idle.list()).toEqual([]);
    expect(f.open).not.toHaveBeenCalled();
    f.idle.stop();
  });

  it("closes only at the configured threshold, then resumes the same identity once", async () => {
    const f = await fixture();
    f.idle.configure({ enabled: true, timeoutMinutes: 30 });
    await vi.advanceTimersByTimeAsync(29 * MINUTE);
    expect(f.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(f.onClosed).toHaveBeenCalledWith(f.thread);
    expect(f.runtime.get(f.id)).toBeUndefined();
    const [first, second] = await Promise.all([f.runtime.resolve(f.id), f.runtime.resolve(f.id)]);
    expect(first.kind).toBe("external");
    expect(second.kind).toBe("external");
    if (first.kind !== "external" || second.kind !== "external") throw new Error("Not restored");
    expect(first.thread).toBe(second.thread);
    expect(first.thread).not.toBe(f.thread);
    expect(f.open).toHaveBeenCalledTimes(1);
    expect(f.open).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "resume", nativeRef: f.thread.record.nativeSessionRef }),
    );
    f.idle.stop();
    await first.thread.session.close();
  });

  it("preserves unread steer markers across idle release and Session restore", async () => {
    const f = await fixture();
    const turnId = hostTurnIdSchema.parse("steered-turn");
    f.thread.steeredTurnIds.add(turnId);
    f.idle.configure({ enabled: true, timeoutMinutes: 10 });

    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(f.runtime.get(f.id)).toBeUndefined();
    const restored = await f.runtime.resolve(f.id);

    expect(restored.kind).toBe("external");
    if (restored.kind !== "external") throw new Error("Not restored");
    expect(restored.thread.steeredTurnIds).toEqual(new Set([turnId]));
    f.idle.stop();
    await restored.thread.session.close();
  });

  it.each([
    "running",
    "activeTurn",
    "creating",
    "identity",
    "persistence",
    "output",
    "subagent",
    "hostBusy",
  ])("does not release when blocked by %s", async (reason) => {
    const f = await fixture();
    if (reason === "running") f.thread.running = true;
    if (reason === "activeTurn") f.thread.activeTurnId = "turn" as typeof f.thread.activeTurnId;
    if (reason === "creating") f.thread.record = { ...f.thread.record, state: "creating" };
    if (reason === "identity")
      f.thread.record = { ...f.thread.record, nativeSessionRef: undefined } as StoredThreadRecordV1;
    if (reason === "persistence") f.thread.persistenceError = new Error("Store failed");
    if (reason === "output") f.idle.outputFailed(f.thread);
    if (reason === "subagent")
      f.thread.record = { ...f.thread.record, subagent: {} } as StoredThreadRecordV1;
    if (reason === "hostBusy") f.canRelease.mockReturnValue(false);
    f.idle.configure({ enabled: true, timeoutMinutes: 10 });
    await vi.advanceTimersByTimeAsync(11 * MINUTE);
    expect(f.close).not.toHaveBeenCalled();
    f.idle.stop();
    await f.thread.session.close();
  });

  it("protects detached operations and restarts the idle period after completion", async () => {
    const f = await fixture();
    f.idle.configure({ enabled: true, timeoutMinutes: 10 });
    const gate = deferred();
    const operation = f.idle.runOperation(f.id, async () => {
      await f.runtime.resolve(f.id);
      await gate.promise;
    });
    await vi.advanceTimersByTimeAsync(20 * MINUTE);
    expect(f.close).not.toHaveBeenCalled();
    gate.resolve();
    await operation;
    await vi.advanceTimersByTimeAsync(9 * MINUTE);
    expect(f.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(f.close).toHaveBeenCalledTimes(1);
    f.idle.stop();
  });

  it("releases occupancy in finally after a failed operation", async () => {
    const f = await fixture();
    f.idle.configure({ enabled: true, timeoutMinutes: 10 });
    await expect(
      f.idle.runOperation(f.id, async () => {
        throw new Error("operation");
      }),
    ).rejects.toThrow("operation");
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(f.close).toHaveBeenCalledTimes(1);
    f.idle.stop();
  });

  it("rechecks candidates after queueing and when the setting is disabled", async () => {
    const f = await fixture();
    f.idle.configure({ enabled: true, timeoutMinutes: 10 });
    const gate = deferred();
    const queued = f.queue.run(f.id, () => gate.promise);
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    f.idle.configure({ enabled: false, timeoutMinutes: 10 });
    gate.resolve();
    await queued;
    await f.queue.drain();
    expect(f.close).not.toHaveBeenCalled();
    f.idle.stop();
  });

  it("waits for close AND output drain before admitting a new request", async () => {
    const f = await fixture();
    const drain = deferred();
    f.thread.outputTask = drain.promise;
    f.idle.configure({ enabled: true, timeoutMinutes: 10 });
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(f.idle.list()[0]).toMatchObject({ state: "closing" });
    const admitted = vi.fn(async () => f.runtime.resolve(f.id));
    const request = f.idle.runOperation(f.id, admitted);
    await Promise.resolve();
    expect(admitted).not.toHaveBeenCalled();
    expect(f.open).not.toHaveBeenCalled();
    drain.resolve();
    const result = await request;
    expect(result.kind).toBe("external");
    expect(f.open).toHaveBeenCalledTimes(1);
    f.idle.stop();
    if (result.kind === "external") await result.thread.session.close();
  });

  it.each(["reject", "timeout", "persistence", "output"])(
    "retains and blocks the instance after %s",
    async (failure) => {
      const f = await fixture();
      const late = deferred();
      if (failure === "reject") f.close.mockRejectedValue(new Error("close failed"));
      if (failure === "timeout") f.close.mockImplementation(() => late.promise);
      if (failure === "persistence")
        f.close.mockImplementation(async () => {
          f.thread.persistenceError = new Error("Store failed during close");
          f.thread.outputTask = Promise.resolve();
        });
      if (failure === "output")
        f.close.mockImplementation(async () => {
          f.idle.outputFailed(f.thread);
          f.thread.outputTask = Promise.resolve();
        });
      f.idle.configure({ enabled: true, timeoutMinutes: 10 });
      await vi.advanceTimersByTimeAsync(11 * MINUTE);
      const result = await f.runtime.resolve(f.id);
      expect(result).toMatchObject({ kind: "error", error: { code: -32075 } });
      expect(f.idle.list()[0]).toMatchObject({ state: "failed", reason: "closeFailed" });
      expect(f.runtime.get(f.id)).toBe(f.thread);
      expect(f.open).not.toHaveBeenCalled();
      expect(f.diagnose).toHaveBeenCalled();
      late.resolve();
      await vi.advanceTimersByTimeAsync(30 * MINUTE);
      expect(f.close).toHaveBeenCalledTimes(1);
      expect(f.runtime.get(f.id)).toBe(f.thread);
      f.idle.stop();
    },
  );

  it("does not remove a replacement when an old close completes late", async () => {
    const f = await fixture();
    const late = deferred();
    f.close.mockImplementation(() => late.promise);
    f.thread.outputTask = Promise.resolve();
    f.idle.configure({ enabled: true, timeoutMinutes: 10 });
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    const replacement = f.runtime.register({
      record: f.thread.record,
      session: new FakeHarnessSession(harnessIdSchema.parse(f.thread.harnessId)),
      sessionId: f.id,
      thread: { id: f.id },
      turns: [],
    });
    late.resolve();
    await f.queue.drain();
    expect(f.runtime.get(f.id)).toBe(replacement);
    expect(f.diagnose).toHaveBeenCalled();
    f.idle.stop();
  });

  it("drains an in-flight close on shutdown without cancelling or starting another writer", async () => {
    const f = await fixture();
    const gate = deferred();
    f.close.mockImplementation(async () => {
      await gate.promise;
      await f.idle.consumeOutput(f.thread, async () => undefined);
      await FakeHarnessSession.prototype.close.call(f.thread.session);
    });
    f.idle.configure({ enabled: true, timeoutMinutes: 10 });
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    f.idle.stop();
    let drained = false;
    const draining = f.idle.drain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    gate.resolve();
    await draining;
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(f.open).not.toHaveBeenCalled();
    expect(f.runtime.get(f.id)).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("repeated release/resume cycles retain only the current instance and one scheduler", async () => {
    const f = await fixture();
    f.idle.configure({ enabled: true, timeoutMinutes: 10 });
    for (let index = 0; index < 3; index += 1) {
      const previous = f.runtime.get(f.id);
      await vi.advanceTimersByTimeAsync(10 * MINUTE);
      expect(f.runtime.values()).toHaveLength(0);
      const result = await f.runtime.resolve(f.id);
      if (result.kind !== "external") throw new Error("Resume failed");
      expect(result.thread).not.toBe(previous);
      expect(f.runtime.values()).toEqual([result.thread]);
      expect(vi.getTimerCount()).toBe(1);
    }
    expect(f.open).toHaveBeenCalledTimes(3);
    f.idle.stop();
    await f.runtime.get(f.id)?.session.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("activity and repeated settings do not reset each other; shortening applies at the next check", async () => {
    const f = await fixture();
    f.idle.configure({ enabled: true, timeoutMinutes: 30 });
    await vi.advanceTimersByTimeAsync(15 * MINUTE);
    await f.runtime.resolve(f.id);
    await vi.advanceTimersByTimeAsync(15 * MINUTE);
    expect(f.close).not.toHaveBeenCalled();
    f.idle.configure({ enabled: true, timeoutMinutes: 10 });
    f.idle.configure({ enabled: true, timeoutMinutes: 10 });
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(f.close).toHaveBeenCalledTimes(1);
    f.idle.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
