import { afterEach, describe, expect, it, vi } from "vitest";

import { compactDelegationOutput } from "../src/delegation-cli-output.js";
import { DelegationControlRegistry } from "../src/delegation-control-registry.js";
import { routeDelegationRequest } from "../src/delegation-control-server.js";
import { externalClientRouter } from "../src/external-client-routes.js";
import { INTERRUPT_STOP_TIMEOUT_MS } from "../src/delegation-interrupt-send.js";
import {
  DelegationControlError,
  type DelegationControlRegistration,
  type DelegationThreadSnapshot,
  type DelegationThreadStatus,
} from "../src/delegation-types.js";

const registries: DelegationControlRegistry[] = [];
afterEach(() => {
  for (const registry of registries.splice(0)) registry.close();
  vi.useRealTimers();
});

function setup(initial: DelegationThreadStatus = "running") {
  let status = initial;
  const order: string[] = [];
  const snapshot = (threadId = "target"): DelegationThreadSnapshot => ({
    threadId,
    harnessId: "pi",
    status: threadId === "parent" ? "completed" : status,
    turn: { turnId: "old-turn", status },
    progress: [],
    result: { availability: "pending" },
  });
  const api: DelegationControlRegistration = {
    ownsThread: () => true,
    canHandleStart: () => true,
    listHarnesses: vi.fn(),
    inspect: vi.fn(),
    answer: vi.fn(),
    start: vi.fn(),
    list: vi.fn(),
    read: vi.fn(async ({ threadId }) => snapshot(threadId)),
    cancel: vi.fn(async () => {
      order.push("cancel");
      return { threadId: "target", turnId: "old-turn", harnessId: "pi", cancelled: true };
    }),
    wait: vi.fn(async () => {
      order.push("stopped");
      status = "interrupted";
      return { ...snapshot(), timedOut: false };
    }),
    send: vi.fn<DelegationControlRegistration["send"]>(async ({ threadId }) => {
      order.push("send");
      status = "running";
      return {
        threadId,
        turnId: "new-turn",
        harnessId: "pi",
        status: "running",
        next: { read: "read", wait: "wait" },
      };
    }),
  };
  const registry = new DelegationControlRegistry();
  registry.register(api);
  registries.push(registry);
  return {
    registry,
    api,
    order,
    snapshot,
    setStatus: (value: DelegationThreadStatus) => {
      status = value;
    },
  };
}

const send = { threadId: "target", message: "new direction", interrupt: true };

describe("interrupt before send", () => {
  it("cancels a busy Turn, confirms it stopped, then sends exactly once", async () => {
    const { registry, api, order } = setup();
    await expect(registry.send(send)).resolves.toMatchObject({ turnId: "new-turn" });
    expect(order).toEqual(["cancel", "stopped", "send"]);
    expect(api.send).toHaveBeenCalledExactlyOnceWith({
      threadId: "target",
      message: "new direction",
    });
    expect(api.wait).toHaveBeenCalledWith({
      threadId: "target",
      view: "result",
      timeoutMs: expect.any(Number),
    });
  });

  it.each(["completed", "creating"] as const)(
    "sends normally to an idle %s Thread without cancelling or waiting",
    async (status) => {
      const { registry, api, order } = setup(status);
      await registry.send(send);
      expect(order).toEqual(["send"]);
      expect(api.cancel).not.toHaveBeenCalled();
      expect(api.wait).not.toHaveBeenCalled();
    },
  );

  it("validates the new message before cancelling any Turn", async () => {
    const { registry, api } = setup();
    await expect(registry.send({ ...send, message: " " })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    expect(api.cancel).not.toHaveBeenCalled();
    expect(api.send).not.toHaveBeenCalled();
  });

  it("keeps ordinary sends on their existing path", async () => {
    const { registry, api } = setup();
    await registry.send({ threadId: "target", message: "continue" });
    expect(api.read).not.toHaveBeenCalled();
    expect(api.cancel).not.toHaveBeenCalled();
  });

  it.each(["rejected", "failed", "timedOut", "stillRunning", "hungCancel", "hungWait"])(
    "never sends when cancellation is %s",
    async (failure) => {
      vi.useFakeTimers();
      const { registry, api, snapshot } = setup();
      if (failure === "rejected")
        vi.mocked(api.cancel).mockResolvedValue({
          threadId: "target",
          turnId: "old-turn",
          harnessId: "pi",
          cancelled: false,
        });
      if (failure === "failed")
        vi.mocked(api.cancel).mockRejectedValue(
          new DelegationControlError("DELEGATION_FAILED", "Harness refused cancellation"),
        );
      if (failure === "timedOut" || failure === "stillRunning")
        vi.mocked(api.wait).mockResolvedValue({ ...snapshot(), timedOut: failure === "timedOut" });
      if (failure === "hungCancel")
        vi.mocked(api.cancel).mockImplementation(() => new Promise(() => {}));
      if (failure === "hungWait")
        vi.mocked(api.wait).mockImplementation(() => new Promise(() => {}));
      const assertion = expect(registry.send(send)).rejects.toMatchObject({
        code: "DELEGATION_FAILED",
      });
      if (failure === "hungCancel" || failure === "hungWait")
        await vi.advanceTimersByTimeAsync(INTERRUPT_STOP_TIMEOUT_MS);
      await assertion;
      expect(api.send).not.toHaveBeenCalled();
    },
  );

  it("does not send later if a timed-out cancellation eventually resolves", async () => {
    vi.useFakeTimers();
    const { registry, api } = setup();
    let resolveCancel!: (value: Awaited<ReturnType<typeof api.cancel>>) => void;
    vi.mocked(api.cancel).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCancel = resolve;
        }),
    );
    const assertion = expect(registry.send(send)).rejects.toThrow("no new message was sent");
    await vi.advanceTimersByTimeAsync(INTERRUPT_STOP_TIMEOUT_MS);
    await assertion;
    resolveCancel({ threadId: "target", turnId: "old-turn", harnessId: "pi", cancelled: true });
    await vi.advanceTimersByTimeAsync(1);
    expect(api.send).not.toHaveBeenCalled();
    expect(api.wait).not.toHaveBeenCalled();
  });

  it("preserves the existing watch through a slow stop-resend gap, without notifying", async () => {
    vi.useFakeTimers();
    const { registry, api, setStatus, snapshot } = setup();
    await registry.watch({ threadId: "target", notifyThreadId: "parent", timeoutMs: 100_000 });
    const stable = async () => ({
      watches: (await registry.watches()).watches.map((watch) => {
        const copy: Record<string, unknown> = { ...watch };
        delete copy.watchedForMs;
        delete copy.threadStatus;
        return copy;
      }),
    });
    const before = await stable();
    let release!: () => void;
    vi.mocked(api.wait).mockImplementation(async () => {
      setStatus("interrupted");
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { ...snapshot(), timedOut: false };
    });
    const pending = registry.send(send);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(api.send).not.toHaveBeenCalled();
    expect(await stable()).toEqual(before);
    release();
    await pending;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await stable()).toEqual(before);
    expect(api.send).toHaveBeenCalledTimes(1);
    setStatus("completed");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(api.send).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.send).mock.calls[1]?.[0]).toMatchObject({
      threadId: "parent",
      message: expect.stringContaining("completed"),
    });
  });

  it("ignores an in-flight observation that overlaps stop-resend", async () => {
    vi.useFakeTimers();
    const { registry, api, snapshot } = setup();
    await registry.watch({ threadId: "target", notifyThreadId: "parent", timeoutMs: 100_000 });
    let release!: (value: DelegationThreadSnapshot) => void;
    vi.mocked(api.read).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    await vi.advanceTimersByTimeAsync(2_000);
    await registry.send(send);
    release({ ...snapshot(), status: "interrupted" });
    await vi.advanceTimersByTimeAsync(1);
    expect(api.send).toHaveBeenCalledTimes(1);
    expect((await registry.watches()).watches[0]?.state).toBe("watching");
  });

  it("keeps explicit cancel's watch deletion behavior", async () => {
    const { registry } = setup();
    await registry.watch({ threadId: "target", notifyThreadId: "parent", timeoutMs: 100_000 });
    await registry.cancel({ threadId: "target" });
    expect(await registry.watches()).toEqual({ watches: [] });
  });
});

describe("send with watch", () => {
  it("registers only after successful send and exposes the same JSON/compact watch shape", async () => {
    const { registry } = setup("completed");
    const result = await routeDelegationRequest(
      { api: registry, watchApi: registry },
      "/v1/thread/send",
      { ...send, notifyThreadId: "parent", watchTimeoutMs: 1234 },
    );
    expect(result).toMatchObject({
      watch: { state: "watching", threadId: "target", notifyThreadId: "parent", timeoutMs: 1234 },
    });
    expect(compactDelegationOutput("thread send", result)).toEqual({
      thread: "codex://threads/target",
      harnessId: "pi",
      status: "running",
      watch: { state: "watching", notify: "codex://threads/parent", timeoutMs: 1234 },
    });
  });

  it("reports missing parent as notRegistered without failing the successful send", async () => {
    const { registry, api } = setup("completed");
    const result = await routeDelegationRequest(
      { api: registry, watchApi: registry },
      "/v1/thread/send",
      { ...send, watchTimeoutMs: 1234 },
    );
    expect(result).toMatchObject({
      turnId: "new-turn",
      watch: { state: "notRegistered", reason: expect.any(String) },
    });
    expect(api.send).toHaveBeenCalledOnce();
  });

  it("reports watch storage failure without undoing the successful send", async () => {
    const { registry, api } = setup("completed");
    vi.spyOn(registry, "watch").mockRejectedValue(new Error("storage unavailable"));
    const result = await routeDelegationRequest(
      { api: registry, watchApi: registry },
      "/v1/thread/send",
      { threadId: "target", message: "continue", notifyThreadId: "parent", watchTimeoutMs: 1234 },
    );
    expect(result).toMatchObject({
      turnId: "new-turn",
      watch: { state: "notRegistered", reason: "storage unavailable" },
    });
    expect(api.send).toHaveBeenCalledOnce();
  });

  it("does not register on send failure", async () => {
    const { registry, api } = setup();
    vi.mocked(api.send).mockRejectedValue(new DelegationControlError("THREAD_BUSY", "busy"));
    const watch = vi.spyOn(registry, "watch");
    await expect(
      routeDelegationRequest({ api: registry, watchApi: registry }, "/v1/thread/send", {
        threadId: "target",
        message: "continue",
        notifyThreadId: "parent",
        watchTimeoutMs: 1234,
      }),
    ).rejects.toMatchObject({ code: "THREAD_BUSY" });
    expect(watch).not.toHaveBeenCalled();
  });

  it("uses the authenticated external client's identity for send watches", async () => {
    const { registry } = setup("completed");
    const watch = vi.fn(async () => ({
      threadId: "target",
      notifyThreadId: "client:caller",
      state: "watching" as const,
      status: "running" as const,
      timeoutMs: 1234,
    }));
    const router = externalClientRouter({ api: registry, watchApi: { watch, watches: vi.fn() } });
    const call = { client: "caller" } as Parameters<typeof router>[0];
    await router(call, "/v1/thread/send", {
      threadId: "target",
      message: "continue",
      watchTimeoutMs: 1234,
    });
    expect(watch).toHaveBeenCalledWith({
      threadId: "target",
      notifyThreadId: "client:caller",
      timeoutMs: 1234,
    });
    await expect(
      router(call, "/v1/thread/send", {
        threadId: "target",
        message: "continue",
        watchTimeoutMs: 1234,
        notifyThreadId: "client:other",
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });
});
