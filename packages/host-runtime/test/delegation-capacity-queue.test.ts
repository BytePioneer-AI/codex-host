import { harnessModelRefSchema, harnessThinkingOptionIdSchema } from "@codexhost/shared-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DelegationCapacityQueue,
  type DelegationCapacityRuntime,
} from "../src/delegation-capacity-queue.js";
import type {
  DelegationQueueStore,
  PersistedQueuedDelegation,
} from "../src/delegation-capacity-store.js";
import type {
  DelegationAdmission,
  DelegationAdmissionRequest,
  DelegationStartIdentity,
  DelegationStartInput,
} from "../src/delegation-types.js";

let sequence = 0;

function request(
  patch: Partial<DelegationAdmissionRequest["input"]> = {},
  taskDigest?: string,
): DelegationAdmissionRequest {
  sequence += 1;
  return {
    input: {
      harnessId: "pi",
      task: `task ${sequence}`,
      cwd: "/work",
      parentThreadId: "parent",
      ...patch,
    },
    title: `Task ${sequence}`,
    taskDigest: taskDigest ?? `digest-${sequence}`,
    identity: {
      delegationId: `delegation-${sequence}`,
      threadId: `child-${sequence}`,
      turnId: `turn-${sequence}`,
    },
  };
}

function record(patch: Partial<PersistedQueuedDelegation> = {}): PersistedQueuedDelegation {
  return {
    delegationId: "delegation-stored",
    threadId: "child-stored",
    turnId: "turn-stored",
    harnessId: "pi",
    task: "stored task",
    cwd: "/work",
    parentThreadId: "parent",
    title: "Stored",
    taskDigest: "digest-stored",
    queuedAt: 1,
    ...patch,
  };
}

/** Sessions whose started Threads keep running until a test removes them. */
function sessions() {
  const running = new Set<string>();
  const starts: { input: DelegationStartInput; identity: DelegationStartIdentity }[] = [];
  const hold = { next: false };
  const held = new Map<string, { resolve(): void; reject(error: Error): void }>();
  const runtime: DelegationCapacityRuntime = {
    runningThreadIds: () => running,
    canStart: () => true,
    start: vi.fn(async (input: DelegationStartInput, identity: DelegationStartIdentity) => {
      starts.push({ input, identity });
      if (hold.next) {
        hold.next = false;
        await new Promise<void>((resolve, reject) => {
          held.set(identity.threadId, { resolve, reject });
        });
      }
      running.add(identity.threadId);
    }),
  };
  const started = () => starts.map((start) => start.identity.threadId);
  return { running, starts, hold, held, runtime, started };
}

class MemoryQueueStore implements DelegationQueueStore {
  saved: PersistedQueuedDelegation[] = [];
  saves = 0;
  #adoptable: PersistedQueuedDelegation[];

  constructor(adoptable: PersistedQueuedDelegation[] = []) {
    this.#adoptable = adoptable;
  }

  async adopt() {
    const adopted = this.#adoptable;
    this.#adoptable = [];
    return adopted;
  }

  async save(entries: readonly PersistedQueuedDelegation[]) {
    this.saves += 1;
    this.saved = entries.map((entry) => ({ ...entry }));
  }
}

function queued(admission: DelegationAdmission) {
  if (admission.state !== "queued") throw new Error("expected a queued start");
  return admission;
}

function admitted(admission: DelegationAdmission) {
  if (admission.state !== "admitted") throw new Error("expected an admitted start");
  return admission;
}

const flush = async () => {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
};

describe("DelegationCapacityQueue", () => {
  const queues: DelegationCapacityQueue[] = [];
  const track = (queue: DelegationCapacityQueue) => {
    queues.push(queue);
    return queue;
  };
  afterEach(() => {
    for (const queue of queues.splice(0)) queue.close();
    vi.useRealTimers();
  });

  it("admits every start at once while the limit is off or not yet delivered", async () => {
    const value = sessions();
    for (let index = 0; index < 8; index += 1) value.running.add(`manual-${index}`);
    const store = new MemoryQueueStore();
    const queue = track(new DelegationCapacityQueue(value.runtime, { store }));

    const undelivered = admitted(await queue.admit(request()));
    undelivered.release();
    undelivered.release();
    expect(queue.configure({ enabled: false, maxRunning: 1 })).toEqual({
      enabled: false,
      maxRunning: 1,
    });
    const starts = await Promise.all([1, 2, 3].map(() => queue.admit(request())));
    expect(starts.map((start) => start.state)).toEqual(["admitted", "admitted", "admitted"]);
    expect(await queue.list({})).toEqual([]);
    expect(value.runtime.start).not.toHaveBeenCalled();
    expect(store.saves).toBe(0);
  });

  it("rejects invalid settings", () => {
    const queue = track(new DelegationCapacityQueue(sessions().runtime));
    for (const maxRunning of [0, 33, 1.5]) {
      expect(() => queue.configure({ enabled: true, maxRunning })).toThrow();
    }
  });

  it("queues starts beyond the limit in arrival order, counting manual Threads and starts in flight", async () => {
    const value = sessions();
    value.running.add("manual");
    const store = new MemoryQueueStore();
    const queue = track(new DelegationCapacityQueue(value.runtime, { store }));
    queue.configure({ enabled: true, maxRunning: 2 });

    const first = admitted(await queue.admit(request()));
    const secondRequest = request({ taskName: "Second" });
    const second = queued(await queue.admit(secondRequest));
    const thirdRequest = request({ parentThreadId: "other", cwd: "/other" });
    const third = queued(await queue.admit(thirdRequest));
    expect(second).toEqual({
      state: "queued",
      identity: secondRequest.identity,
      status: "queued",
      position: 1,
      parentThreadId: "parent",
      cwd: "/work",
      title: secondRequest.title,
    });
    expect(third).toMatchObject({ identity: thirdRequest.identity, position: 2 });
    expect(store.saved).toEqual([
      expect.objectContaining({ ...secondRequest.identity, taskName: "Second", harnessId: "pi" }),
      expect.objectContaining(thirdRequest.identity),
    ]);

    expect(
      await queue.read({ threadId: thirdRequest.identity.threadId, view: "result" }),
    ).toMatchObject({
      threadId: thirdRequest.identity.threadId,
      harnessId: "pi",
      title: thirdRequest.title,
      status: "queued",
      queue: { position: 2 },
      turn: null,
      result: { availability: "pending" },
    });
    expect(await queue.peek(secondRequest.identity.threadId)).toEqual({
      status: "queued",
      position: 1,
    });
    expect(
      (await queue.list({ parentThreadId: "parent" })).map(({ threadId, status, queue }) => ({
        threadId,
        status,
        queue,
      })),
    ).toEqual([
      { threadId: secondRequest.identity.threadId, status: "queued", queue: { position: 1 } },
    ]);
    expect((await queue.list({ cwd: "/other/." })).map((row) => row.threadId)).toEqual([
      thirdRequest.identity.threadId,
    ]);
    expect(await queue.list({})).toHaveLength(2);

    // A slot that frees while others wait goes to the head of the queue, never to a newcomer.
    first.release();
    await flush();
    expect(value.started()).toEqual([secondRequest.identity.threadId]);
    expect(queued(await queue.admit(request())).position).toBe(2);
  });

  it("starts queued work in order as running Threads finish", async () => {
    vi.useFakeTimers();
    const value = sessions();
    value.running.add("busy");
    const queue = track(new DelegationCapacityQueue(value.runtime, { pollIntervalMs: 1_000 }));
    queue.configure({ enabled: true, maxRunning: 1 });
    const model = harnessModelRefSchema.parse({ id: "model-a" });
    const firstRequest = request({ model, requestId: "first" });
    queued(await queue.admit(firstRequest));
    const secondRequest = request();
    queued(await queue.admit(secondRequest));

    await vi.advanceTimersByTimeAsync(5_000);
    expect(value.runtime.start).not.toHaveBeenCalled();

    value.running.delete("busy");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(value.starts).toEqual([{ input: firstRequest.input, identity: firstRequest.identity }]);
    expect(
      await queue.read({ threadId: firstRequest.identity.threadId, view: "result" }),
    ).toBeUndefined();
    expect(await queue.peek(secondRequest.identity.threadId)).toEqual({
      status: "queued",
      position: 1,
    });

    await vi.advanceTimersByTimeAsync(5_000);
    expect(value.started()).toEqual([firstRequest.identity.threadId]);
    value.running.delete(firstRequest.identity.threadId);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(value.started()).toEqual([
      firstRequest.identity.threadId,
      secondRequest.identity.threadId,
    ]);
    expect(await queue.list({})).toEqual([]);
  });

  it("starts what fits when the limit is raised, and everything when it is turned off", async () => {
    const value = sessions();
    value.running.add("busy");
    const queue = track(new DelegationCapacityQueue(value.runtime));
    queue.configure({ enabled: true, maxRunning: 1 });
    const waiting: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const next = request();
      queued(await queue.admit(next));
      waiting.push(next.identity.threadId);
    }
    queue.configure({ enabled: true, maxRunning: 3 });
    await flush();
    expect(value.started()).toEqual(waiting.slice(0, 2));
    queue.configure({ enabled: false, maxRunning: 3 });
    await flush();
    expect(value.started()).toEqual(waiting);
  });

  it("reports a queued start that fails to begin as failed", async () => {
    const value = sessions();
    value.running.add("busy");
    const diagnose = vi.fn();
    const store = new MemoryQueueStore();
    const queue = track(new DelegationCapacityQueue(value.runtime, { store, diagnose }));
    queue.configure({ enabled: true, maxRunning: 1 });
    const entry = request();
    queued(await queue.admit(entry));
    value.hold.next = true;
    value.running.delete("busy");
    queue.refresh();
    await flush();
    const read = { threadId: entry.identity.threadId, view: "result" as const };
    expect(await queue.read(read)).toMatchObject({ status: "creating" });
    expect(await queue.peek(entry.identity.threadId)).toEqual({ status: "creating" });
    expect(store.saved).toEqual([expect.objectContaining({ starting: true })]);

    const failure = new Error("Harness is unavailable");
    value.held.get(entry.identity.threadId)?.reject(failure);
    await flush();
    expect(await queue.read(read)).toBeUndefined();
    expect(await queue.finished(read)).toMatchObject({
      status: "failed",
      turn: null,
      result: { availability: "unavailable", message: "Harness is unavailable" },
    });
    expect(diagnose).toHaveBeenCalledWith(failure);
    expect(store.saved).toEqual([]);
  });

  it("restores the stored queue after a restart and resumes it once the limit arrives", async () => {
    const before = sessions();
    before.running.add("busy");
    const store = new MemoryQueueStore();
    const first = track(new DelegationCapacityQueue(before.runtime, { store }));
    first.configure({ enabled: true, maxRunning: 1 });
    const thinkingOptionId = harnessThinkingOptionIdSchema.parse("high");
    const head = request({ requestId: "retry" }, "digest-retry");
    const tail = request({ thinkingOptionId });
    queued(await first.admit(head));
    queued(await first.admit(tail));
    first.close();

    const after = sessions();
    const diagnose = vi.fn();
    const restoredStore = new MemoryQueueStore(store.saved);
    const restored = track(
      new DelegationCapacityQueue(after.runtime, { store: restoredStore, diagnose }),
    );
    expect(await restored.peek(head.identity.threadId)).toEqual({ status: "queued", position: 1 });
    expect(await restored.read({ threadId: tail.identity.threadId, view: "result" })).toMatchObject(
      {
        status: "queued",
        queue: { position: 2 },
      },
    );
    expect(diagnose).toHaveBeenCalledWith("restored 2 queued delegation(s) after a restart");
    // Until the Renderer delivers the limit again, nothing restored starts and nothing overtakes it.
    const newcomer = request();
    expect(queued(await restored.admit(newcomer)).position).toBe(3);
    // A retried start keeps its Thread across the restart.
    expect(
      queued(await restored.admit(request({ requestId: "retry" }, "digest-retry"))).identity,
    ).toEqual(head.identity);
    await flush();
    expect(after.runtime.start).not.toHaveBeenCalled();

    restored.configure({ enabled: true, maxRunning: 2 });
    await flush();
    expect(after.starts).toEqual([
      { input: head.input, identity: head.identity },
      { input: tail.input, identity: tail.identity },
    ]);
    expect(restoredStore.saved.map((entry) => entry.threadId)).toEqual([
      newcomer.identity.threadId,
    ]);
  });

  it("reports a start cut off by the restart as interrupted instead of starting it twice", async () => {
    const value = sessions();
    const store = new MemoryQueueStore([record({ starting: true })]);
    const queue = track(new DelegationCapacityQueue(value.runtime, { store }));
    queue.configure({ enabled: false, maxRunning: 4 });
    await flush();
    expect(value.runtime.start).not.toHaveBeenCalled();
    const read = { threadId: "child-stored", view: "result" as const };
    expect(await queue.read(read)).toBeUndefined();
    expect(await queue.finished(read)).toMatchObject({
      status: "interrupted",
      title: "Stored",
      result: { availability: "unavailable", message: expect.stringContaining("restarted") },
    });
    expect(store.saves).toBe(1);
    expect(store.saved).toEqual([]);
  });

  it("starts the restored queue as if the limit were off when no setting arrives", async () => {
    vi.useFakeTimers();
    const value = sessions();
    const diagnose = vi.fn();
    const queue = track(
      new DelegationCapacityQueue(value.runtime, {
        store: new MemoryQueueStore([record()]),
        diagnose,
        settingsGraceMs: 60_000,
      }),
    );
    await vi.advanceTimersByTimeAsync(59_000);
    expect(value.runtime.start).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(value.started()).toEqual(["child-stored"]);
    expect(diagnose).toHaveBeenCalledWith(
      "no delegation capacity setting arrived; starting the restored queue",
    );
    expect(await queue.list({})).toEqual([]);
  });

  it("removes a waiting start on cancel and reports it interrupted", async () => {
    const value = sessions();
    value.running.add("busy");
    const store = new MemoryQueueStore();
    const queue = track(new DelegationCapacityQueue(value.runtime, { store }));
    queue.configure({ enabled: true, maxRunning: 1 });
    const first = request();
    const second = request();
    queued(await queue.admit(first));
    queued(await queue.admit(second));

    expect(await queue.cancel(first.identity.threadId)).toEqual({
      threadId: first.identity.threadId,
      turnId: null,
      harnessId: "pi",
      cancelled: true,
    });
    expect(await queue.peek(second.identity.threadId)).toEqual({ status: "queued", position: 1 });
    expect(store.saved.map((entry) => entry.threadId)).toEqual([second.identity.threadId]);
    expect(
      await queue.finished({ threadId: first.identity.threadId, view: "result" }),
    ).toMatchObject({
      status: "interrupted",
      result: { availability: "unavailable", message: "Removed from the queue before it started" },
    });
    expect(await queue.cancel(first.identity.threadId)).toBeUndefined();

    value.running.delete("busy");
    queue.refresh();
    await flush();
    expect(value.started()).toEqual([second.identity.threadId]);
  });

  it("leaves a start already under way to its session when cancelled", async () => {
    const value = sessions();
    value.running.add("busy");
    const queue = track(new DelegationCapacityQueue(value.runtime));
    queue.configure({ enabled: true, maxRunning: 1 });
    const entry = request();
    queued(await queue.admit(entry));
    value.hold.next = true;
    value.running.delete("busy");
    queue.refresh();
    await flush();
    let settled = false;
    const cancelling = queue.cancel(entry.identity.threadId).then((result) => {
      settled = true;
      return result;
    });
    await flush();
    expect(settled).toBe(false);
    value.held.get(entry.identity.threadId)?.resolve();
    await expect(cancelling).resolves.toBeUndefined();
    expect(
      await queue.finished({ threadId: entry.identity.threadId, view: "result" }),
    ).toBeUndefined();
  });

  it("returns the waiting entry for a retried start and rejects a conflicting request ID", async () => {
    const value = sessions();
    value.running.add("busy");
    const queue = track(new DelegationCapacityQueue(value.runtime));
    queue.configure({ enabled: true, maxRunning: 1 });
    const original = request({ requestId: "same" }, "digest-a");
    queued(await queue.admit(original));
    expect(queued(await queue.admit(request({ requestId: "same" }, "digest-a"))).identity).toEqual(
      original.identity,
    );
    await expect(queue.admit(request({ requestId: "same" }, "digest-b"))).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    const implicit = request({}, "digest-c");
    queued(await queue.admit(implicit));
    expect(queued(await queue.admit(request({}, "digest-c"))).identity).toEqual(implicit.identity);
    expect(queued(await queue.admit(request({}, "digest-d"))).position).toBe(3);
  });

  it("settles a wait when the start leaves the queue, or reports the timeout", async () => {
    const value = sessions();
    value.running.add("busy");
    const queue = track(new DelegationCapacityQueue(value.runtime));
    queue.configure({ enabled: true, maxRunning: 1 });
    const entry = request();
    queued(await queue.admit(entry));
    await expect(queue.settled(entry.identity.threadId, 10)).resolves.toBe(false);
    const settling = queue.settled(entry.identity.threadId, 60_000);
    value.running.delete("busy");
    queue.refresh();
    await expect(settling).resolves.toBe(true);
    await expect(queue.settled("unknown", 10)).resolves.toBe(true);
  });

  it("stops starting work once closed and keeps the stored queue", async () => {
    const value = sessions();
    value.running.add("busy");
    const store = new MemoryQueueStore();
    const queue = new DelegationCapacityQueue(value.runtime, { store });
    queue.configure({ enabled: true, maxRunning: 1 });
    const entry = request();
    queued(await queue.admit(entry));
    queue.close();
    value.running.delete("busy");
    queue.refresh();
    await flush();
    expect(value.runtime.start).not.toHaveBeenCalled();
    expect(store.saved.map((saved) => saved.threadId)).toEqual([entry.identity.threadId]);
    await expect(queue.admit(request())).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
  });

  it("prepares a Harness-created Thread only for a start that must wait, keeping arrival order", async () => {
    const value = sessions();
    value.running.add("busy");
    const queue = track(new DelegationCapacityQueue(value.runtime));
    queue.configure({ enabled: true, maxRunning: 2 });
    const prepared: string[] = [];
    const native = (threadId: string, task: string) => {
      const base = request({ harnessId: "codex", task }, task);
      return {
        ...base,
        prepare: vi.fn(async () => {
          // A slow backend must not let a later start take this one's place.
          await new Promise((resolve) => setTimeout(resolve, threadId === "native-a" ? 20 : 0));
          prepared.push(threadId);
          return { ...base.identity, threadId };
        }),
      };
    };
    const now = native("unused", "now");
    admitted(await queue.admit(now));
    expect(now.prepare).not.toHaveBeenCalled();
    const [first, second] = await Promise.all([
      queue.admit(native("native-a", "a")),
      queue.admit(native("native-b", "b")),
    ]);
    expect([queued(first).identity.threadId, queued(second).identity.threadId]).toEqual([
      "native-a",
      "native-b",
    ]);
    expect((await queue.list({})).map((entry) => entry.threadId)).toEqual(["native-a", "native-b"]);
    // A retry of a waiting start is answered from the queue without preparing again.
    const retry = native("native-c", "a");
    expect(queued(await queue.admit(retry)).identity.threadId).toBe("native-a");
    expect(retry.prepare).not.toHaveBeenCalled();
    expect(prepared).toEqual(["native-a", "native-b"]);
  });

  it("holds a claimed start in its place until the Turn start settles", async () => {
    const value = sessions();
    value.running.add("busy");
    const adopt = vi.fn(async () => false);
    const store = new MemoryQueueStore();
    const queue = track(new DelegationCapacityQueue({ ...value.runtime, adopt }, { store }));
    queue.configure({ enabled: true, maxRunning: 1 });
    const claimed = request({ harnessId: "codex" });
    const taken = request({ harnessId: "codex" });
    const behind = request();
    for (const entry of [claimed, taken, behind]) queued(await queue.admit(entry));
    const { threadId } = claimed.identity;

    expect(await queue.claim(threadId, "pi")).toBeUndefined();
    const claim = await queue.claim(threadId, "codex");
    expect(claim).toMatchObject({
      identity: claimed.identity,
      input: { ...claimed.input },
      taskDigest: claimed.taskDigest,
    });
    expect(await queue.claim(threadId, "codex")).toBeUndefined();
    expect(await queue.peek(threadId)).toEqual({ status: "creating" });
    expect(await queue.peek(taken.identity.threadId)).toEqual({ status: "queued", position: 1 });
    // A crash during the takeover leaves the start to be checked for a Turn.
    expect(store.saved.find((saved) => saved.threadId === threadId)?.starting).toBe(true);

    let cancelled = false;
    const cancelling = queue.cancel(threadId).then((result) => {
      cancelled = true;
      return result;
    });
    await flush();
    expect(cancelled).toBe(false);
    await claim?.settle("rejected");
    expect(store.saved.find((saved) => saved.threadId === threadId)?.starting).toBeUndefined();
    // The rejected takeover kept the start's place, and the waiting cancel goes on from there.
    expect(await cancelling).toMatchObject({ cancelled: true });
    expect(adopt).toHaveBeenCalledWith(expect.objectContaining({ identity: claimed.identity }));

    const second = await queue.claim(taken.identity.threadId, "codex");
    await second?.settle("started");
    expect(await queue.peek(taken.identity.threadId)).toBeUndefined();
    // Taken-over work is the session's now, not a start that never happened.
    expect(await queue.finished({ threadId: taken.identity.threadId, view: "result" })).toBe(
      undefined,
    );
    expect(store.saved.map((saved) => saved.threadId)).toEqual([behind.identity.threadId]);
    expect(value.runtime.start).not.toHaveBeenCalled();
  });

  it("returns a takeover with an unknown outcome to its place, to be checked first", async () => {
    const value = sessions();
    value.running.add("busy");
    const adopt = vi.fn(async () => true);
    const queue = track(new DelegationCapacityQueue({ ...value.runtime, adopt }));
    queue.configure({ enabled: true, maxRunning: 1 });
    const entry = request({ harnessId: "codex" });
    queued(await queue.admit(entry));
    await (await queue.claim(entry.identity.threadId, "codex"))?.settle("unknown");
    // Its Turn did begin, so a second message joins that Turn instead of repeating the task.
    expect(await queue.claim(entry.identity.threadId, "codex")).toBeUndefined();
    expect(adopt).toHaveBeenCalledOnce();
    expect(await queue.peek(entry.identity.threadId)).toBeUndefined();
  });

  it("leaves a cancelled start whose Thread has a Turn to its session", async () => {
    const value = sessions();
    value.running.add("busy");
    const begun = request({ harnessId: "codex" });
    const empty = request({ harnessId: "codex" });
    const adopt = vi.fn(
      async (queuedStart: { identity: DelegationStartIdentity }) =>
        queuedStart.identity.threadId === begun.identity.threadId,
    );
    const queue = track(new DelegationCapacityQueue({ ...value.runtime, adopt }));
    queue.configure({ enabled: true, maxRunning: 1 });
    for (const entry of [begun, empty]) queued(await queue.admit(entry));

    expect(await queue.cancel(begun.identity.threadId)).toBeUndefined();
    expect(await queue.finished({ threadId: begun.identity.threadId, view: "result" })).toBe(
      undefined,
    );
    expect(await queue.cancel(empty.identity.threadId)).toMatchObject({ cancelled: true });
    expect(
      await queue.finished({ threadId: empty.identity.threadId, view: "result" }),
    ).toMatchObject({ status: "interrupted" });
    expect(adopt).toHaveBeenCalledTimes(2);
  });

  it("checks a native start cut off by a restart for a Turn before using it", async () => {
    const value = sessions();
    const store = new MemoryQueueStore([
      record({ threadId: "native-begun", harnessId: "codex", starting: true }),
      record({ threadId: "native-empty", harnessId: "codex", starting: true }),
      record({ threadId: "pi-starting", starting: true }),
      record({ threadId: "native-waiting", harnessId: "codex" }),
    ]);
    const adopt = vi.fn(
      async (queuedStart: { identity: DelegationStartIdentity }) =>
        queuedStart.identity.threadId === "native-begun",
    );
    const queue = track(new DelegationCapacityQueue({ ...value.runtime, adopt }, { store }));
    expect((await queue.list({})).map((entry) => entry.threadId)).toEqual([
      "native-begun",
      "native-empty",
      "native-waiting",
    ]);
    expect(await queue.finished({ threadId: "pi-starting", view: "result" })).toMatchObject({
      status: "interrupted",
    });
    // Still unknown on disk until checked.
    expect(store.saved.filter((saved) => saved.starting).map((saved) => saved.threadId)).toEqual([
      "native-begun",
      "native-empty",
    ]);

    // Its Turn began before the restart: it is the session's now, not a waiting start.
    expect(await queue.read({ threadId: "native-begun", view: "result" })).toBeUndefined();
    const claim = await queue.claim("native-empty", "codex");
    expect(claim?.identity.threadId).toBe("native-empty");
    await claim?.settle("rejected");
    expect(store.saved.some((saved) => saved.starting)).toBe(false);
    expect(adopt.mock.calls.map(([queuedStart]) => queuedStart.identity.threadId)).toEqual([
      "native-begun",
      "native-empty",
    ]);

    queue.configure({ enabled: true, maxRunning: 4 });
    await vi.waitFor(() => expect(value.started()).toEqual(["native-empty", "native-waiting"]));
  });

  it("stores a start that fails after close as one to check, not as failed", async () => {
    const value = sessions();
    const store = new MemoryQueueStore();
    const queue = new DelegationCapacityQueue(value.runtime, { store });
    value.running.add("busy");
    queue.configure({ enabled: true, maxRunning: 1 });
    const entry = request({ harnessId: "codex" });
    queued(await queue.admit(entry));
    value.hold.next = true;
    value.running.delete("busy");
    queue.refresh();
    await vi.waitFor(() => expect(value.held.has(entry.identity.threadId)).toBe(true));
    await queue.close();
    value.held.get(entry.identity.threadId)?.reject(new Error("backend closed"));
    await vi.waitFor(() => expect(store.saves).toBeGreaterThan(2));
    expect(store.saved).toEqual([
      expect.objectContaining({ threadId: entry.identity.threadId, starting: true }),
    ]);
    expect(await queue.finished({ threadId: entry.identity.threadId, view: "result" })).toBe(
      undefined,
    );
  });
});
