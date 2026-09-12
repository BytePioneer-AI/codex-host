import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { NativeCodexAccounts } from "../src/account/native-codex-accounts.js";
import {
  createNativeAccountTestState,
  credential,
  nativeAccountIds as ids,
  type NativeAccountTestState,
} from "./fixtures/native-account-state.js";

describe("Account switching while native quota inspection is in flight", () => {
  let state: NativeAccountTestState;
  let manager: NativeCodexAccounts;
  beforeEach(async () => {
    state = await createNativeAccountTestState();
    await state.seedAccounts({
      current: { accountId: ids.a, credential: credential("a") },
      saved: [{ accountId: ids.b, credential: credential("b") }],
    });
    manager = await state.initializeManager();
  });
  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await manager.close();
    await state.close();
  });

  it("fences new requests, preserves the source, and continues the same switch after quota settles", async () => {
    const stop = vi.spyOn(state.runtime, "stop");
    const before = await state.store.readCredentials();
    const release = state.runtime.gate.admit("quota-read");
    const switched = manager.switch(ids.b).then(
      () => "switched",
      (error: unknown) => error,
    );
    try {
      expect(manager.snapshot().phase).toBe("changing");
      expect(manager.snapshot().pendingOperation?.kind).toBe("switch");
      expect(() => state.runtime.gate.admit("quota-read")).toThrow("changing");
      expect(() => state.runtime.gate.admit()).toThrow("changing");
      await expect(manager.switch(ids.b)).rejects.toMatchObject({ code: "changing" });
      expect(await state.store.readJournal()).toBeNull();
      expect(await state.store.readCredentials()).toEqual(before);
      expect(stop).not.toHaveBeenCalled();
    } finally {
      release();
    }
    expect(await switched).toBe("switched");
    expect(stop).toHaveBeenCalledOnce();
    expect(manager.currentAccountId()).toBe(ids.b);
    expect(manager.snapshot().phase).toBe("ready");
    expect(manager.snapshot().pendingOperation).toBeUndefined();
    expect(await state.store.readJournal()).toBeNull();
  });

  it("waits for every admitted quota read rather than only the first one", async () => {
    vi.useFakeTimers();
    const stop = vi.spyOn(state.runtime, "stop");
    const first = state.runtime.gate.admit("quota-read");
    const second = state.runtime.gate.admit("quota-read");
    const switched = manager.switch(ids.b);
    first();
    await vi.advanceTimersByTimeAsync(50);
    expect(manager.snapshot().phase).toBe("changing");
    expect(stop).not.toHaveBeenCalled();
    second();
    await vi.advanceTimersByTimeAsync(50);
    await switched;
    expect(manager.currentAccountId()).toBe(ids.b);
    expect(stop).toHaveBeenCalledOnce();
  });

  it("times out without stopping the backend, clearing the query, or requiring credential recovery", async () => {
    vi.useFakeTimers();
    const stop = vi.spyOn(state.runtime, "stop");
    const before = await state.store.readCredentials();
    const release = state.runtime.gate.admit("quota-read");
    const switched = manager.switch(ids.b).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await switched).toMatchObject({ code: "busy" });
    expect(manager.snapshot()).toMatchObject({
      phase: "ready",
      currentAccountId: ids.a,
      cleanupRequired: false,
    });
    expect(manager.snapshot().pendingOperation).toBeUndefined();
    expect(state.runtime.gate.busy).toBe(true);
    expect(stop).not.toHaveBeenCalled();
    expect(await state.store.readJournal()).toBeNull();
    expect(await state.store.readCredentials()).toEqual(before);
    release();
    expect(state.runtime.gate.busy).toBe(false);
    expect(stop).not.toHaveBeenCalled();
  });

  it.each(["request", "turn", "approval"])(
    "still refuses %s work immediately, even alongside quota inspection",
    async (kind) => {
      const quota = state.runtime.gate.admit("quota-read");
      const release =
        kind === "request"
          ? state.runtime.gate.admit()
          : () => state.runtime.gate.nativeWork(kind, false);
      if (kind !== "request") state.runtime.gate.nativeWork(kind, true);
      try {
        await expect(manager.switch(ids.b)).rejects.toMatchObject({ code: "busy" });
        expect(manager.snapshot().phase).toBe("ready");
        expect(manager.snapshot().pendingOperation).toBeUndefined();
      } finally {
        release();
        quota();
      }
    },
  );

  it("does not restore ready if native ownership becomes unavailable during the wait", async () => {
    vi.useFakeTimers();
    const release = state.runtime.gate.admit("quota-read");
    const switched = manager.switch(ids.b).catch((error: unknown) => error);
    state.runtime.gate.unavailable();
    release();
    await vi.advanceTimersByTimeAsync(50);
    expect(await switched).toMatchObject({ code: "unavailable" });
    expect(manager.snapshot().phase).toBe("unavailable");
    expect(manager.currentAccountId()).toBe(ids.a);
    expect(await state.store.readJournal()).toBeNull();
  });

  it("refuses newly observed native work without clearing it or changing credentials", async () => {
    vi.useFakeTimers();
    const release = state.runtime.gate.admit("quota-read");
    const switched = manager.switch(ids.b).catch((error: unknown) => error);
    state.runtime.gate.nativeWork("late-turn", true);
    await vi.advanceTimersByTimeAsync(50);
    expect(await switched).toMatchObject({ code: "busy" });
    expect(manager.snapshot().phase).toBe("ready");
    expect(manager.currentAccountId()).toBe(ids.a);
    expect(state.runtime.gate.busy).toBe(true);
    expect(await state.store.readJournal()).toBeNull();
    release();
    state.runtime.gate.nativeWork("late-turn", false);
  });

  it("does not silently extend quota draining to logout or deletion", async () => {
    const release = state.runtime.gate.admit("quota-read");
    try {
      await expect(manager.logout()).rejects.toMatchObject({ code: "busy" });
      await expect(manager.remove(ids.b)).rejects.toMatchObject({ code: "busy" });
    } finally {
      release();
    }
  });
});
