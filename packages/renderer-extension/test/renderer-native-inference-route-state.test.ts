import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RendererModelClient } from "../src/renderer-model-client.js";
import { createRendererNativeInferenceRoute } from "../src/renderer-native-inference-route.js";
import { hostThreadIdSchema, type HostThreadId } from "@codexhost/shared-contracts";

function deferred() {
  let resolve!: (value: boolean) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<boolean>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function fixture() {
  const verify = vi.fn(async () => true);
  const client = { usesIndependentNativeInference: verify } as unknown as RendererModelClient;
  let eligible = true;
  let targetClient: RendererModelClient | null = client;
  let threadId: HostThreadId | null = hostThreadIdSchema.parse("native-thread");
  let draftCwd: string | null = null;
  const values: boolean[] = [];
  const render = vi.fn(() => {
    values.push(route.update(targetClient, threadId, eligible, draftCwd));
  });
  const route = createRendererNativeInferenceRoute(render);
  return {
    client,
    verify,
    render,
    route,
    values,
    setEligible(value: boolean) {
      eligible = value;
      render();
    },
    setClient(value: RendererModelClient | null) {
      targetClient = value;
      render();
    },
    setDraftCwd(value: string | null) {
      draftCwd = value;
      render();
    },
    setThread(value: string | null) {
      threadId = value === null ? null : hostThreadIdSchema.parse(value);
      render();
    },
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Native inference route revalidation lifecycle", () => {
  it("does not pulse the gate closed during successful same-target refreshes", async () => {
    const f = fixture();
    f.render();
    expect(f.values).toEqual([false]);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.values.at(-1)).toBe(true);
    const check = deferred();
    f.verify.mockReturnValueOnce(check.promise);
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.verify).toHaveBeenCalledTimes(2);
    expect(f.values.at(-1)).toBe(true);
    f.render();
    expect(f.values.at(-1)).toBe(true);
    check.resolve(true);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(16000);
    expect(f.values.slice(1).every(Boolean)).toBe(true);
    f.route.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("automatically revokes the proof if idle config becomes official", async () => {
    const f = fixture();
    f.render();
    await vi.advanceTimersByTimeAsync(0);
    f.verify.mockResolvedValueOnce(false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.values.at(-1)).toBe(false);
    expect(f.verify).toHaveBeenLastCalledWith({ threadId: "native-thread" });
    f.route.dispose();
  });

  it("fails closed on RPC errors without logging request data", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = fixture();
    f.render();
    await vi.advanceTimersByTimeAsync(0);
    f.verify.mockRejectedValueOnce(new Error("private payload"));
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.values.at(-1)).toBe(false);
    expect(warn.mock.calls[0]?.[1]).toBe("Error");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private payload");
    f.route.dispose();
  });

  it("bounds pending revalidation and ignores its late result during the next check", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = fixture();
    f.render();
    await vi.advanceTimersByTimeAsync(0);
    const late = deferred();
    const next = deferred();
    f.verify.mockReturnValueOnce(late.promise).mockReturnValueOnce(next.promise);
    await vi.advanceTimersByTimeAsync(9999);
    expect(f.values.at(-1)).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.values.at(-1)).toBe(false);
    await vi.advanceTimersByTimeAsync(5000);
    late.resolve(true);
    await vi.advanceTimersByTimeAsync(0);
    f.render();
    expect(f.values.at(-1)).toBe(false);
    next.resolve(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.values.at(-1)).toBe(false);
    f.route.dispose();
  });

  it("invalidates immediately on Host or Thread changes and ignores stale completion", async () => {
    const f = fixture();
    const old = deferred();
    f.verify.mockReturnValueOnce(old.promise).mockResolvedValue(false);
    f.render();
    f.setThread("official-thread");
    expect(f.values.at(-1)).toBe(false);
    old.resolve(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.values.at(-1)).toBe(false);
    const other = {
      usesIndependentNativeInference: vi.fn(async () => false),
    } as unknown as RendererModelClient;
    f.setClient(other);
    expect(f.values.at(-1)).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.values.at(-1)).toBe(false);
    f.route.dispose();
  });

  it("clears proof and timers while switching, unmounted or missing its client", async () => {
    const f = fixture();
    f.render();
    await vi.advanceTimersByTimeAsync(0);
    f.setEligible(false);
    expect(f.values.at(-1)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(15000);
    expect(f.verify).toHaveBeenCalledTimes(1);
    f.setEligible(true);
    expect(f.values.at(-1)).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    f.setClient(null);
    expect(vi.getTimerCount()).toBe(0);
    expect(f.values.at(-1)).toBe(false);
    f.route.dispose();
  });

  it("does not retain a pending result or timer after disposal", async () => {
    const f = fixture();
    const pending = deferred();
    f.verify.mockReturnValueOnce(pending.promise);
    f.setThread(null);
    expect(f.verify).toHaveBeenCalledWith(undefined);
    f.route.dispose();
    expect(vi.getTimerCount()).toBe(0);
    pending.resolve(true);
    await vi.advanceTimersByTimeAsync(15000);
    expect(f.render).toHaveBeenCalledTimes(1);
    expect(f.route.update(f.client, null, true)).toBe(false);
  });
  it("re-verifies a new draft against its workspace and ignores it for existing Threads", async () => {
    const f = fixture();
    f.setThread(null);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.verify).toHaveBeenLastCalledWith(undefined);
    f.verify.mockResolvedValueOnce(false);
    f.setDraftCwd("/work/draft");
    expect(f.values.at(-1)).toBe(false);
    expect(f.verify).toHaveBeenLastCalledWith({ cwd: "/work/draft" });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.values.at(-1)).toBe(false);
    f.setThread("native-thread");
    expect(f.verify).toHaveBeenLastCalledWith({ threadId: "native-thread" });
    const calls = f.verify.mock.calls.length;
    await vi.advanceTimersByTimeAsync(0);
    f.setDraftCwd("/work/other");
    expect(f.verify).toHaveBeenCalledTimes(calls);
    f.route.dispose();
  });
});
