import { FakeHarnessAdapter, FakeHarnessSession } from "@codexhost/harness-adapter/testing";
import type { StoredThreadRecordV1 } from "@codexhost/mapping-store";
import { harnessIdSchema, hostThreadIdSchema } from "@codexhost/shared-contracts";
import { describe, expect, it, vi } from "vitest";
import { DesktopRequestQueue } from "../src/desktop-request-queue.js";
import type { ExternalThreadRepository } from "../src/external-thread-repository.js";
import { ExternalThreadRuntime } from "../src/external-thread-runtime.js";

async function fixture(archived = true) {
  const adapter = new FakeHarnessAdapter(harnessIdSchema.parse("pi"));
  const opened = await adapter.open({ kind: "create", cwd: "/synthetic" });
  if (!opened.ok) throw new Error(opened.error.message);
  const session = opened.value;
  const nativeSessionRef = session.initialState.nativeRef;
  if (!nativeSessionRef) throw new Error("Missing native identity");
  const id = hostThreadIdSchema.parse("archive-thread-1");
  const record: StoredThreadRecordV1 = {
    formatVersion: 1,
    revision: 1,
    hostThreadId: id,
    createRequestId: "create-archived",
    harnessId: adapter.harnessId,
    state: "ready",
    nativeSessionRef,
    cwd: "/synthetic",
    title: "Archive Thread",
    archived,
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

describe("External thread release on archive (#424)", () => {
  it("immediately releases an idle thread upon archive even if auto idle release is disabled", async () => {
    const f = await fixture(true);
    // Auto-idle release is disabled by default
    expect(f.idle.list()[0]?.reason).toBe("disabled");

    // releaseIfIdle should trigger immediate close without waiting for timer
    f.idle.releaseIfIdle(f.id);
    await f.queue.drain();

    expect(f.close).toHaveBeenCalledTimes(1);
    expect(f.onClosed).toHaveBeenCalledWith(f.thread);
    expect(f.runtime.get(f.id)).toBeUndefined();
  });

  it("does not release an active running thread upon archive", async () => {
    const f = await fixture(true);
    f.thread.running = true;

    f.idle.releaseIfIdle(f.id);
    await f.queue.drain();

    expect(f.close).not.toHaveBeenCalled();
    expect(f.runtime.get(f.id)).toBeDefined();
  });

  it("does not release a thread with background work upon archive", async () => {
    const f = await fixture(true);
    f.canRelease.mockReturnValue(false);

    f.idle.releaseIfIdle(f.id);
    await f.queue.drain();

    expect(f.close).not.toHaveBeenCalled();
    expect(f.runtime.get(f.id)).toBeDefined();
  });

  it("does not release an unarchived active thread", async () => {
    const f = await fixture(false); // archived: false

    f.idle.releaseIfIdle(f.id);
    await f.queue.drain();

    expect(f.close).not.toHaveBeenCalled();
    expect(f.runtime.get(f.id)).toBeDefined();
  });

  it("diagnoses error but does not set closeFailed when release fails upon archive", async () => {
    const f = await fixture(true);
    f.close.mockRejectedValueOnce(new Error("Close failed"));

    f.idle.releaseIfIdle(f.id);
    await f.queue.drain();

    expect(f.close).toHaveBeenCalledTimes(1);
    expect(f.diagnose).toHaveBeenCalled();
    // Archive-triggered release is best-effort and does not set closeFailed
    expect(f.idle.failure(f.thread)).toBeUndefined();
  });
});
