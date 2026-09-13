import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeCodexAccounts } from "../src/account/native-codex-accounts.js";
import {
  createNativeAccountTestState,
  credential,
  nativeAccountIds as ids,
  type NativeAccountTestState,
} from "./fixtures/native-account-state.js";

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
  manager = new NativeCodexAccounts({
    store: state.store,
    runtime: state.runtime,
  });
  await manager.initialize();
}

describe("Account switch stops native backends", () => {
  it("fences new work and stops the backend before replacing credentials, skipping idle probes", async () => {
    await setup();
    const originalStop = state.runtime.stop.bind(state.runtime);
    const stop = vi.spyOn(state.runtime, "stop").mockImplementation(async () => {
      expect(state.runtime.gate.phase).toBe("changing");
      expect(() => state.runtime.gate.admit()).toThrow("changing");
      expect((await state.store.readCredentials())?.identity).toEqual(credential("a").identity);
      await originalStop();
    });
    await manager.switch(ids.b);
    expect(stop).toHaveBeenCalledOnce();
    expect(manager.currentAccountId()).toBe(ids.b);
    expect(manager.snapshot().phase).toBe("ready");
    expect(state.runtime.verified.at(-1)).toEqual(credential("b").identity);
  });

  it("stops external backends once after owned exit, tolerates respawn, and verifies the target", async () => {
    await setup();
    const stopExternalProcesses = vi.fn(async () => {
      expect(state.runtime.activeHome).toBeUndefined();
      expect((await state.store.readCredentials())?.identity).toEqual(credential("a").identity);
      // An external backend may start again; no second inventory is required.
    });
    Object.assign(state.runtime, { stopExternalProcesses });
    await manager.switch(ids.b);
    expect(stopExternalProcesses).toHaveBeenCalledOnce();
    expect(state.runtime.verified.at(-1)).toEqual(credential("b").identity);
    expect(manager.snapshot().phase).toBe("ready");
  });

  it("does not replace credentials on external stop failure and does not chase processes during rollback", async () => {
    await setup();
    const before = state.files.peek(state.store.home, "auth.json");
    const stopExternalProcesses = vi.fn(async () => {
      throw new Error("exit unconfirmed");
    });
    Object.assign(state.runtime, { stopExternalProcesses });
    await expect(manager.switch(ids.b)).rejects.toMatchObject({ code: "switch-failed" });
    expect(stopExternalProcesses).toHaveBeenCalledOnce();
    expect(state.files.peek(state.store.home, "auth.json")).toEqual(before);
    expect(manager.snapshot().phase).toBe("ready");
  });

  it("does not report success if an external writer replaces credentials after backend verification", async () => {
    await setup();
    const verify = state.runtime.verify.bind(state.runtime);
    vi.spyOn(state.runtime, "verify").mockImplementation(async (identity) => {
      await verify(identity);
      state.files.seed(state.store.home, "auth.json", credential("c").serializeForNativeStore());
    });
    await expect(manager.switch(ids.b)).rejects.toMatchObject({ code: "recovery-required" });
    expect(manager.snapshot().phase).toBe("unavailable");
    expect(await state.store.readJournal()).not.toBeNull();
  });

  it("rejects concurrent work and another switch without queuing or killing twice", async () => {
    await setup();
    const barrier = Promise.withResolvers<undefined>();
    const external = vi
      .spyOn(state.runtime, "stopExternalProcesses")
      .mockImplementation(() => barrier.promise);
    const switched = manager.switch(ids.b);
    await vi.waitFor(() => expect(external).toHaveBeenCalledOnce());
    expect(() => state.runtime.gate.admit()).toThrow("changing");
    await expect(manager.switch(ids.b)).rejects.toMatchObject({ code: "changing" });
    barrier.resolve(undefined);
    await switched;
    expect(external).toHaveBeenCalledOnce();
    expect(() => state.runtime.gate.admit()()).not.toThrow();
  });

  it("does not replace credentials when exit cannot be confirmed", async () => {
    await setup();
    const before = state.files.peek(state.store.home, "auth.json");
    vi.spyOn(state.runtime, "stop").mockRejectedValueOnce(new Error("unconfirmed exit"));
    await expect(manager.switch(ids.b)).rejects.toMatchObject({ code: "stop-unconfirmed" });
    expect(state.files.peek(state.store.home, "auth.json")).toEqual(before);
    expect(await state.store.readJournal()).toBeNull();
    expect(manager.snapshot().phase).toBe("unavailable");
  });

  it("never discards a Host request lease to force credential replacement", async () => {
    await setup();
    const before = state.files.peek(state.store.home, "auth.json");
    const release = state.runtime.gate.admit();
    try {
      await expect(manager.switch(ids.b)).rejects.toMatchObject({ code: "switch-failed" });
      expect(state.files.peek(state.store.home, "auth.json")).toEqual(before);
      expect(state.runtime.gate.busy).toBe(true);
      expect(await state.store.readJournal()).toBeNull();
    } finally {
      release();
    }
  });

  it("rolls back when target identity verification fails", async () => {
    await setup();
    const before = state.files.peek(state.store.home, "auth.json");
    state.runtime.verifyError = new Error("verification failed");
    await expect(manager.switch(ids.b)).rejects.toMatchObject({ code: "switch-failed" });
    expect(state.files.peek(state.store.home, "auth.json")).toEqual(before);
    expect(manager.currentAccountId()).toBe(ids.a);
    expect(manager.snapshot().phase).toBe("ready");
  });
});
