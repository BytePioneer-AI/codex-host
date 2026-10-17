import type { HarnessSession } from "@codexhost/harness-adapter";
import { FakeHarnessAdapter, FakeHarnessSession } from "@codexhost/harness-adapter/testing";
import type { StoredThreadRecordV1 } from "@codexhost/mapping-store";
import { harnessIdSchema, hostThreadIdSchema } from "@codexhost/shared-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExternalThreadRepository } from "../src/external-thread-repository.js";
import { ExternalThreadRuntime } from "../src/external-thread-runtime.js";

function deferred() {
  const { promise, resolve, reject } = Promise.withResolvers<undefined>();
  return { promise, resolve: () => resolve(undefined), reject };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const fixtures: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of fixtures.splice(0)) await cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function fixture() {
  const adapter = new FakeHarnessAdapter(harnessIdSchema.parse("pi"));
  const created = await adapter.open({ kind: "create", cwd: "/synthetic" });
  if (!created.ok) throw new Error(created.error.message);
  const session = created.value as FakeHarnessSession;
  const id = hostThreadIdSchema.parse("recovery-thread");
  const record = {
    formatVersion: 1,
    revision: 1,
    hostThreadId: id,
    createRequestId: "create-recovery",
    harnessId: adapter.harnessId,
    state: "ready",
    nativeSessionRef: session.initialState.nativeRef,
    cwd: "/synthetic",
    title: "Recovery",
    archived: false,
    transportModelId: "codexhost/pi-native",
    ephemeral: false,
    historyMode: "legacy",
    turnMappings: [],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  } as StoredThreadRecordV1;
  const repository = {
    find: vi.fn(async () => record),
    alignSnapshot: vi.fn(async (current: StoredThreadRecordV1) => ({ record: current, turns: [] })),
    sessionTreeId: async () => id,
    setTransportModelId: async (_id: string, transportModelId: string) => ({
      ...record,
      transportModelId,
    }),
  };
  const closeGate = deferred();
  const closeStarted = deferred();
  const closeFinished = deferred();
  const resumeGate = deferred();
  const resumeStarted = deferred();
  let holdResume = false;
  const sessions: HarnessSession[] = [session];
  const realClose = session.close.bind(session);
  const close = vi.spyOn(session, "close").mockImplementation(async () => {
    closeStarted.resolve();
    await closeGate.promise;
    await realClose();
    closeFinished.resolve();
  });
  const realOpen = adapter.open.bind(adapter);
  const open = vi.spyOn(adapter, "open").mockImplementation(async (input) => {
    if (input.kind !== "resume") return realOpen(input);
    resumeStarted.resolve();
    if (holdResume) await resumeGate.promise;
    const next = new FakeHarnessSession(
      adapter.harnessId,
      adapter.catalog,
      undefined,
      input.nativeRef,
    );
    sessions.push(next);
    vi.spyOn(next, "close");
    return { ok: true, value: next };
  });
  const diagnose = vi.fn();
  const runtime = new ExternalThreadRuntime({
    adapters: new Map([["pi", adapter]]),
    repository: repository as unknown as ExternalThreadRepository,
    consumeOutputs: async (thread) => {
      for await (const output of thread.session.outputs) void output;
    },
    diagnose,
  });
  const thread = runtime.register({ record, session, sessionId: id, thread: { id }, turns: [] });
  fixtures.push(async () => {
    closeGate.resolve();
    resumeGate.resolve();
    runtime.idleRelease.stop();
    await runtime.drain();
    await Promise.allSettled(sessions.map((item) => item.close()));
    await adapter.close();
  });
  return {
    adapter,
    runtime,
    repository,
    thread,
    session,
    id,
    open,
    close,
    diagnose,
    closeGate,
    closeStarted,
    closeFinished,
    resumeGate,
    resumeStarted,
    holdResume: () => {
      holdResume = true;
    },
  };
}

const fault = {
  code: "processExited",
  message: "Native Session faulted",
  retryable: false,
} as const;

describe("External Thread recovery lifecycle", () => {
  it("waits for output drain even after close has completed", async () => {
    const f = await fixture();
    const drain = deferred();
    f.thread.outputTask = drain.promise;
    f.runtime.markSessionUnavailable(f.thread);
    const resolving = f.runtime.resolve(f.id);
    try {
      f.closeGate.resolve();
      await f.closeFinished.promise;
      await flush();
      expect(f.open).not.toHaveBeenCalled();
    } finally {
      drain.resolve();
    }
    expect((await resolving).kind).toBe("external");
    expect(f.open).toHaveBeenCalledOnce();
  });

  it("merges concurrent resolves through both delayed close and resume", async () => {
    const f = await fixture();
    f.holdResume();
    f.runtime.markSessionUnavailable(f.thread);
    const resolutions = Array.from({ length: 5 }, () => f.runtime.resolve(f.id));
    await f.closeStarted.promise;
    await flush();
    expect(f.open).not.toHaveBeenCalled();
    f.closeGate.resolve();
    await f.resumeStarted.promise;
    await flush();
    expect(f.open).toHaveBeenCalledOnce();
    f.resumeGate.resolve();
    const results = await Promise.all(resolutions);
    for (const result of results) {
      expect(result.kind).toBe("external");
      if (result.kind === "external") expect(result.thread).toBe(f.runtime.get(f.id));
    }
    expect(f.close).toHaveBeenCalledOnce();
    expect(f.open).toHaveBeenCalledOnce();
  });

  it("shares the barrier between refresh revival, resolve and a queued discard", async () => {
    const f = await fixture();
    f.session.fault(fault);
    const refresh = f.runtime.refresh(f.thread);
    await f.closeStarted.promise;
    const discard = f.runtime.discardUnavailableIdle(f.thread);
    const resolving = f.runtime.resolve(f.id);
    const secondRefresh = f.runtime.refresh(f.thread);
    await flush();
    expect(f.open).not.toHaveBeenCalled();
    f.closeGate.resolve();
    expect(await refresh).toBeNull();
    expect(await secondRefresh).toBeNull();
    await discard;
    const resolved = await resolving;
    expect(resolved.kind).toBe("external");
    expect(f.runtime.get(f.id)).toBe(f.thread);
    expect(f.thread.session).not.toBe(f.session);
    expect(f.thread.sessionUnavailable).toBe(false);
    expect(f.thread.session.close).not.toHaveBeenCalled();
    expect(f.close).toHaveBeenCalledOnce();
    expect(f.open).toHaveBeenCalledOnce();
  });

  it("returns a retryable stale-reference error when discard wins over refresh", async () => {
    const f = await fixture();
    f.runtime.markSessionUnavailable(f.thread);
    const discard = f.runtime.discardUnavailableIdle(f.thread);
    await f.closeStarted.promise;
    const refresh = f.runtime.refresh(f.thread);
    const resolving = f.runtime.resolve(f.id);
    f.closeGate.resolve();
    await discard;
    expect(await refresh).toMatchObject({
      code: -32076,
      message: expect.stringContaining("retry"),
    });
    const result = await resolving;
    if (result.kind !== "external") throw new Error("Expected restored Thread");
    expect(await f.runtime.refresh(result.thread)).toBeNull();
    expect(f.open).toHaveBeenCalledOnce();
  });

  it("retains ownership on rejected close, then retries close before resuming", async () => {
    const f = await fixture();
    f.close.mockRejectedValueOnce(new Error("process is still alive"));
    f.runtime.markSessionUnavailable(f.thread);
    expect(await f.runtime.resolve(f.id)).toMatchObject({
      kind: "error",
      error: { code: -32075, message: expect.stringContaining("Retry") },
    });
    expect(f.runtime.get(f.id)).toBe(f.thread);
    expect(f.open).not.toHaveBeenCalled();
    // The actual Host calls locate before resolve. Both must permit safe retry, not poison a lane.
    const retry = f.runtime.locate(f.id);
    await f.closeStarted.promise;
    expect(f.open).not.toHaveBeenCalled();
    f.closeGate.resolve();
    expect((await retry).kind).toBe("external");
    expect((await f.runtime.resolve(f.id)).kind).toBe("external");
    expect(f.close).toHaveBeenCalledTimes(2);
    expect(f.open).toHaveBeenCalledOnce();
  });

  it("times out without releasing ownership or invoking a second pending close", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const f = await fixture();
    f.runtime.markSessionUnavailable(f.thread);
    const first = f.runtime.resolve(f.id);
    await f.closeStarted.promise;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await first).toMatchObject({ kind: "error", error: { code: -32075 } });
    const second = f.runtime.resolve(f.id);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await second).toMatchObject({ kind: "error", error: { code: -32075 } });
    expect(f.close).toHaveBeenCalledOnce();
    expect(f.open).not.toHaveBeenCalled();
    f.closeGate.resolve();
    await f.closeFinished.promise;
    await flush();
    expect(f.runtime.get(f.id)).toBe(f.thread); // Late completion never retires or restores.
    expect((await f.runtime.resolve(f.id)).kind).toBe("external");
    expect(f.close).toHaveBeenCalledOnce();
    expect(f.open).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("blocks recovery on rejected output drain without repeatedly closing the Session", async () => {
    const f = await fixture();
    const drain = deferred();
    f.thread.outputTask = drain.promise;
    f.runtime.markSessionUnavailable(f.thread);
    f.closeGate.resolve();
    const first = f.runtime.resolve(f.id);
    await f.closeFinished.promise;
    drain.reject(new Error("output drain failed"));
    expect(await first).toMatchObject({ kind: "error", error: { code: -32075 } });
    expect(await f.runtime.resolve(f.id)).toMatchObject({ kind: "error", error: { code: -32075 } });
    expect(f.open).not.toHaveBeenCalled();
    expect(f.close).toHaveBeenCalledOnce();
  });

  it("does not delete an externally registered replacement when old cleanup finishes", async () => {
    const f = await fixture();
    f.runtime.markSessionUnavailable(f.thread);
    const discard = f.runtime.discardUnavailableIdle(f.thread);
    await f.closeStarted.promise;
    const next = new FakeHarnessSession(f.adapter.harnessId);
    const replacement = f.runtime.register({
      record: f.thread.record,
      session: next,
      sessionId: f.id,
      thread: { id: f.id },
      turns: [],
    });
    f.closeGate.resolve();
    await discard;
    expect(f.runtime.get(f.id)).toBe(replacement);
    expect(f.open).not.toHaveBeenCalled();
    await next.close();
  });

  it("keeps a failed restore's unregistered Session owned until its cleanup succeeds", async () => {
    const f = await fixture();
    f.closeGate.resolve();
    f.runtime.markSessionUnavailable(f.thread);
    await f.runtime.discardUnavailableIdle(f.thread);
    f.repository.alignSnapshot.mockRejectedValueOnce(new Error("mapping write failed"));
    const originalOpen = f.open.getMockImplementation();
    if (!originalOpen) throw new Error("Missing resume fixture");
    let closeCandidate: ReturnType<typeof vi.spyOn> | undefined;
    f.open.mockImplementationOnce(async (input) => {
      const result = await originalOpen(input);
      if (result.ok) {
        closeCandidate = vi.spyOn(result.value, "close");
        closeCandidate.mockRejectedValueOnce(new Error("candidate still alive"));
      }
      return result;
    });
    expect(await f.runtime.resolve(f.id)).toMatchObject({ kind: "error", error: { code: -32075 } });
    expect(f.runtime.get(f.id)).toBeUndefined();
    await f.runtime.drain(); // Draining tasks must not discard the failed candidate's blocker.
    expect(closeCandidate).toHaveBeenCalledOnce();
    expect(f.open).toHaveBeenCalledOnce();
    expect((await f.runtime.resolve(f.id)).kind).toBe("external");
    expect(closeCandidate).toHaveBeenCalledTimes(2);
    expect(f.open).toHaveBeenCalledTimes(2);
  });

  it("includes child cleanup in the parent's recovery barrier", async () => {
    const f = await fixture();
    const childId = hostThreadIdSchema.parse("recovery-child");
    const childSession = new FakeHarnessSession(f.adapter.harnessId);
    const childGate = deferred();
    const childClosing = deferred();
    const realClose = childSession.close.bind(childSession);
    vi.spyOn(childSession, "close").mockImplementation(async () => {
      childClosing.resolve();
      await childGate.promise;
      await realClose();
    });
    const child = f.runtime.register({
      record: {
        ...f.thread.record,
        hostThreadId: childId,
        subagent: { parentHostThreadId: f.id, nativeSubagentId: "child" },
      },
      session: childSession,
      sessionId: f.id,
      thread: { id: childId },
      turns: [],
    });
    f.runtime.markSessionUnavailable(f.thread);
    f.closeGate.resolve();
    const resolving = f.runtime.resolve(f.id);
    try {
      await childClosing.promise;
      expect(f.open).not.toHaveBeenCalled();
      expect(f.runtime.get(childId)).toBe(child);
    } finally {
      childGate.resolve();
    }
    expect((await resolving).kind).toBe("external");
    expect(f.runtime.get(childId)).toBeUndefined();
    expect(f.open).toHaveBeenCalledOnce();
  });
});
