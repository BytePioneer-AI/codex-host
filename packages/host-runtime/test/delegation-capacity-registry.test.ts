import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { FileDelegationQueueStore } from "../src/delegation-capacity-store.js";
import { DelegationControlRegistry } from "../src/delegation-control-registry.js";
import {
  DelegationControlError,
  type DelegationCapacityGate,
  type DelegationControlRegistration,
  type DelegationStartIdentity,
  type DelegationStartInput,
  type DelegationThreadStatus,
} from "../src/delegation-types.js";

const PARENT = "parent";

/** Rows listed by reference carry no queue place, so the list row type does not declare one. */
function queueOf(thread: object): unknown {
  return "queue" in thread ? thread.queue : undefined;
}

/** A Host session whose delegated starts pass the capacity gate the way the Harness coordinator does. */
function session() {
  const threads = new Map<string, { status: DelegationThreadStatus; turnId: string }>([
    [PARENT, { status: "completed", turnId: "turn-parent" }],
  ]);
  let gate: DelegationCapacityGate | undefined;
  let created = 0;
  const result = (
    identity: DelegationStartIdentity,
    status: DelegationThreadStatus,
    extra: object = {},
  ) => ({
    delegationId: identity.delegationId,
    threadId: identity.threadId,
    turnId: identity.turnId,
    harnessId: "pi",
    deepLink: `codex://threads/${identity.threadId}`,
    status,
    parentThreadId: PARENT,
    cwd: "/work",
    next: { read: "read", wait: "wait" },
    ...extra,
  });
  const snapshot = (threadId: string) => {
    const thread = threads.get(threadId);
    if (!thread) throw new DelegationControlError("THREAD_NOT_FOUND", "Thread was not found");
    return {
      threadId,
      harnessId: "pi",
      status: thread.status,
      turn: { turnId: thread.turnId, status: thread.status },
      progress: [],
      result:
        thread.status === "running"
          ? { availability: "pending" as const }
          : { availability: "available" as const, text: "done" },
      nextCursor: null,
    };
  };
  const registration: DelegationControlRegistration = {
    listHarnesses: async () => ({ harnesses: ["codex", "pi"] }),
    inspect: async () => {
      throw new Error("not used");
    },
    canHandleStart: (input) => input.parentThreadId === PARENT,
    ownsThread: (threadId) => threads.has(threadId),
    useCapacity: (capacity) => {
      gate = capacity;
    },
    runningThreadIds: () =>
      [...threads]
        .filter(([, thread]) => thread.status === "running")
        .map(([threadId]) => threadId),
    start: vi.fn(async (input: DelegationStartInput, admitted?: DelegationStartIdentity) => {
      created += 1;
      const identity = admitted ?? {
        delegationId: `delegation-${created}`,
        threadId: `child-${created}`,
        turnId: `turn-${created}`,
      };
      const admission = admitted
        ? undefined
        : await gate?.admit({
            input: { ...input, parentThreadId: PARENT, cwd: "/work" },
            title: input.taskName ?? input.task,
            taskDigest: input.task,
            identity,
          });
      if (admission?.state === "queued") {
        return result(admission.identity, admission.status, {
          ...(admission.position ? { queue: { position: admission.position } } : {}),
          title: admission.title,
        });
      }
      try {
        threads.set(identity.threadId, { status: "running", turnId: identity.turnId });
      } finally {
        admission?.release();
      }
      return result(identity, "running");
    }),
    send: vi.fn(async ({ threadId }) => ({
      threadId,
      turnId: `turn-sent-${threadId}`,
      harnessId: "pi",
      status: "running" as const,
      next: { read: "read", wait: "wait" },
    })),
    cancel: vi.fn(async ({ threadId }) => ({
      threadId,
      turnId: threads.get(threadId)?.turnId ?? null,
      harnessId: "pi",
      cancelled: threads.get(threadId)?.status === "running",
    })),
    read: vi.fn(async ({ threadId }) => snapshot(threadId)),
    wait: vi.fn(async ({ threadId }) => ({ ...snapshot(threadId), timedOut: false })),
    list: vi.fn(async () => ({
      threads: [...threads].map(([threadId, thread]) => ({
        threadId,
        harnessId: "pi",
        deepLink: `codex://threads/${threadId}`,
        status: thread.status,
      })),
      nextCursor: null,
    })),
  };
  const finish = (threadId: string, status: DelegationThreadStatus = "completed") => {
    const thread = threads.get(threadId);
    if (thread) thread.status = status;
  };
  return { registration, threads, finish };
}

const start = (registry: DelegationControlRegistry, task: string) =>
  registry.start({ harnessId: "pi", task, parentThreadId: PARENT });

describe("delegation capacity in the registry", () => {
  const cleanups: (() => Promise<void> | void)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    vi.useRealTimers();
  });
  const registryWith = (
    options: ConstructorParameters<typeof DelegationControlRegistry>[0] = {},
  ) => {
    const registry = new DelegationControlRegistry(options);
    const value = session();
    registry.register(value.registration);
    cleanups.push(() => registry.close());
    return { registry, ...value };
  };

  it("starts every delegation at once while the limit is off", async () => {
    const { registry, registration } = registryWith();
    for (const task of ["one", "two", "three"]) {
      expect(await start(registry, task)).toMatchObject({ status: "running" });
    }
    registry.capacity.configure({ enabled: false, maxRunning: 1 });
    const result = await start(registry, "four");
    expect(result).toMatchObject({ status: "running" });
    expect(result).not.toHaveProperty("queue");
    expect(registration.start).toHaveBeenCalledTimes(4);
    const listed = await registry.list({ parentThreadId: PARENT, limit: 10, sort: "created-desc" });
    expect(listed.threads.every((thread) => queueOf(thread) === undefined)).toBe(true);
  });

  it("returns a queued Thread at once and shows it in read, list, wait and send", async () => {
    const { registry } = registryWith();
    registry.capacity.configure({ enabled: true, maxRunning: 1 });
    const running = await start(registry, "running");
    const first = await start(registry, "first");
    const second = await start(registry, "second");
    expect(running).toMatchObject({ status: "running" });
    expect(first).toMatchObject({
      status: "queued",
      queue: { position: 1 },
      deepLink: `codex://threads/${first.threadId}`,
      parentThreadId: PARENT,
      cwd: "/work",
      title: "first",
    });
    expect(second).toMatchObject({ status: "queued", queue: { position: 2 } });

    expect(await registry.read({ threadId: second.threadId, view: "result" })).toMatchObject({
      threadId: second.threadId,
      status: "queued",
      queue: { position: 2 },
      turn: null,
      result: { availability: "pending" },
    });
    const listed = await registry.list({ parentThreadId: PARENT, limit: 1, sort: "created-desc" });
    expect(
      listed.threads.map((thread) => ({
        threadId: thread.threadId,
        status: thread.status,
        queue: queueOf(thread),
      })),
    ).toEqual([
      { threadId: first.threadId, status: "queued", queue: { position: 1 } },
      { threadId: second.threadId, status: "queued", queue: { position: 2 } },
      { threadId: PARENT, status: "completed", queue: undefined },
      { threadId: running.threadId, status: "running", queue: undefined },
    ]);
    expect(
      (
        await registry.list({
          parentThreadId: PARENT,
          limit: 1,
          sort: "created-desc",
          cursor: "next-page",
        })
      ).threads.some((thread) => thread.status === "queued"),
    ).toBe(false);
    expect(
      await registry.wait({ threadId: first.threadId, view: "result", timeoutMs: 20 }),
    ).toMatchObject({ status: "queued", queue: { position: 1 }, timedOut: true });
    await expect(
      registry.send({ threadId: first.threadId, message: "more" }),
    ).rejects.toMatchObject({
      code: "THREAD_BUSY",
      details: { status: "queued", queuePosition: 1 },
    });
    await expect(
      registry.wait({ threadId: first.threadId, view: "result", timeoutMs: 0 }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("starts queued Threads under their identity when running Threads finish", async () => {
    const { registry, registration, finish } = registryWith({ capacity: { pollIntervalMs: 5 } });
    registry.capacity.configure({ enabled: true, maxRunning: 1 });
    const running = await start(registry, "running");
    const queued = await start(registry, "queued");
    const waiting = registry.wait({ threadId: queued.threadId, view: "result", timeoutMs: 5_000 });
    finish(running.threadId);
    expect(await waiting).toMatchObject({
      threadId: queued.threadId,
      status: "running",
      timedOut: false,
    });
    expect(registration.start).toHaveBeenLastCalledWith(
      { harnessId: "pi", task: "queued", cwd: "/work", parentThreadId: PARENT },
      { delegationId: queued.delegationId, threadId: queued.threadId, turnId: queued.turnId },
    );
    expect(await registry.read({ threadId: queued.threadId, view: "result" })).toMatchObject({
      status: "running",
      turn: { turnId: queued.turnId },
    });
    await expect(
      registry.send({ threadId: queued.threadId, message: "more" }),
    ).resolves.toMatchObject({
      status: "running",
    });
  });

  it("removes a queued Thread on cancel and then reports it interrupted", async () => {
    const { registry, registration, finish } = registryWith({ capacity: { pollIntervalMs: 5 } });
    registry.capacity.configure({ enabled: true, maxRunning: 1 });
    const running = await start(registry, "running");
    const cancelled = await start(registry, "cancelled");
    const kept = await start(registry, "kept");

    expect(await registry.cancel({ threadId: cancelled.threadId })).toEqual({
      threadId: cancelled.threadId,
      turnId: null,
      harnessId: "pi",
      cancelled: true,
    });
    expect(registration.cancel).not.toHaveBeenCalled();
    expect(await registry.read({ threadId: kept.threadId, view: "result" })).toMatchObject({
      queue: { position: 1 },
    });
    expect(await registry.read({ threadId: cancelled.threadId, view: "result" })).toMatchObject({
      status: "interrupted",
      result: { availability: "unavailable", message: "Removed from the queue before it started" },
    });
    expect(
      await registry.wait({ threadId: cancelled.threadId, view: "result", timeoutMs: 1_000 }),
    ).toMatchObject({ status: "interrupted", timedOut: false });
    expect(await registry.cancel({ threadId: cancelled.threadId })).toMatchObject({
      cancelled: false,
    });
    await expect(
      registry.send({ threadId: cancelled.threadId, message: "more" }),
    ).rejects.toMatchObject({ code: "THREAD_NOT_FOUND" });
    const listed = await registry.list({ parentThreadId: PARENT, limit: 10, sort: "created-desc" });
    expect(listed.threads.map((thread) => thread.threadId)).not.toContain(cancelled.threadId);

    finish(running.threadId);
    await vi.waitFor(() =>
      expect(registration.start).toHaveBeenLastCalledWith(
        expect.objectContaining({ task: "kept" }),
        expect.objectContaining({ threadId: kept.threadId }),
      ),
    );
    expect(registration.start).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ threadId: cancelled.threadId }),
    );
  });

  it("watches a queued Thread through the queue until it stops after starting", async () => {
    vi.useFakeTimers();
    const { registry, registration, finish } = registryWith({
      capacity: { pollIntervalMs: 1_000 },
    });
    registry.capacity.configure({ enabled: true, maxRunning: 1 });
    const running = await start(registry, "running");
    const queued = await start(registry, "queued");

    expect(
      await registry.watch({
        threadId: queued.threadId,
        notifyThreadId: PARENT,
        timeoutMs: 600_000,
        stallAfterMs: 3_000,
      }),
    ).toMatchObject({ state: "watching", status: "queued" });
    // Time spent waiting for a slot is not Harness silence.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(registration.send).not.toHaveBeenCalled();

    finish(running.threadId);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await registry.read({ threadId: queued.threadId, view: "result" })).toMatchObject({
      status: "running",
    });
    expect(registration.send).not.toHaveBeenCalled();
    finish(queued.threadId);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(registration.send).toHaveBeenCalledOnce();
    expect(registration.send).toHaveBeenCalledWith({
      threadId: PARENT,
      message: expect.stringContaining(`codex://threads/${queued.threadId}: completed`),
    });
  });

  it("notifies a watch on a queued Thread that is removed from the queue", async () => {
    vi.useFakeTimers();
    const { registry, registration } = registryWith();
    registry.capacity.configure({ enabled: true, maxRunning: 1 });
    await start(registry, "running");
    const queued = await start(registry, "queued");
    await registry.watch({ threadId: queued.threadId, notifyThreadId: PARENT, timeoutMs: 600_000 });
    await registry.cancel({ threadId: queued.threadId });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(registration.send).toHaveBeenCalledWith({
      threadId: PARENT,
      message: expect.stringContaining(`codex://threads/${queued.threadId}: interrupted`),
    });
  });

  it("keeps the queue across a Host Runtime restart", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-capacity-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const before = registryWith({ capacity: { store: new FileDelegationQueueStore(directory) } });
    before.registry.capacity.configure({ enabled: true, maxRunning: 1 });
    await start(before.registry, "running");
    const queued = await start(before.registry, "queued");
    before.registry.close();

    const after = registryWith({
      capacity: { store: new FileDelegationQueueStore(directory), pollIntervalMs: 5 },
    });
    expect(await after.registry.read({ threadId: queued.threadId, view: "result" })).toMatchObject({
      status: "queued",
      queue: { position: 1 },
    });
    expect(
      (await after.registry.list({ parentThreadId: PARENT, limit: 10, sort: "created-desc" }))
        .threads[0],
    ).toMatchObject({ threadId: queued.threadId, status: "queued" });
    expect(after.registration.start).not.toHaveBeenCalled();
    after.registry.capacity.configure({ enabled: true, maxRunning: 1 });
    await vi.waitFor(() =>
      expect(after.registration.start).toHaveBeenCalledWith(
        expect.objectContaining({ task: "queued", parentThreadId: PARENT }),
        { delegationId: queued.delegationId, threadId: queued.threadId, turnId: queued.turnId },
      ),
    );
    expect(await after.registry.read({ threadId: queued.threadId, view: "result" })).toMatchObject({
      status: "running",
    });
  });
});
