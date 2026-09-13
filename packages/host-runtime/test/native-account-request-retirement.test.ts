import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createNativeAccountTestState,
  credential,
  nativeAccountIds as ids,
  type NativeAccountTestState,
} from "./fixtures/native-account-state.js";
import type { NativeCodexAccounts } from "../src/account/native-codex-accounts.js";
let state: NativeAccountTestState;
let manager: NativeCodexAccounts;
afterEach(async () => {
  vi.restoreAllMocks();
  await manager?.close();
  await state?.close();
});
async function setup() {
  state = await createNativeAccountTestState();
  await state.seedAccounts({
    current: { accountId: ids.a, credential: credential("a") },
    saved: [{ accountId: ids.b, credential: credential("b") }],
  });
  manager = await state.initializeManager();
}
describe("request retirement during Account switch", () => {
  it("stops immediately instead of waiting for quota replies, with no replay into the target", async () => {
    await setup();
    const releaseFirst = state.runtime.gate.admit();
    const releaseSecond = state.runtime.gate.admit();
    const originalStop = state.runtime.stop.bind(state.runtime);
    const stop = vi.spyOn(state.runtime, "stop").mockImplementation(async () => {
      expect(state.runtime.gate.phase).toBe("changing");
      expect(() => state.runtime.gate.admit()).toThrow("changing");
      // The real owner rejects outstanding RPCs and releases their leases on retirement.
      releaseFirst();
      releaseSecond();
      await originalStop();
    });
    const external = vi.spyOn(state.runtime, "stopExternalProcesses");
    await manager.switch(ids.b);
    expect(stop).toHaveBeenCalledOnce();
    expect(external).toHaveBeenCalledOnce();
    expect(manager.currentAccountId()).toBe(ids.b);
    expect(manager.snapshot().phase).toBe("ready");
    expect(state.runtime.gate.busy).toBe(false);
  });
  it("deletes a saved Account without stopping the backend, but respects writer leases", async () => {
    await setup();
    const before = state.files.peek(state.store.home, "auth.json");
    const stop = vi.spyOn(state.runtime, "stop");
    const release = state.runtime.gate.admit();
    try {
      await expect(manager.remove(ids.b)).rejects.toMatchObject({ code: "busy" });
    } finally {
      release();
    }
    await manager.remove(ids.b);
    expect(stop).not.toHaveBeenCalled();
    expect(manager.currentAccountId()).toBe(ids.a);
    expect(manager.snapshot().accounts.map(({ accountId }) => accountId)).toEqual([ids.a]);
    expect(state.files.peek(state.store.home, "auth.json")).toEqual(before);
  });
});
