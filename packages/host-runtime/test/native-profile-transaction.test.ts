import { afterEach, describe, expect, it } from "vitest";

import { NativeProfileTransaction } from "../src/account/native-profile-transaction.js";
import {
  credential,
  createNativeAccountTestState,
  nativeAccountIds,
  type NativeAccountTestState,
} from "./fixtures/native-account-state.js";

const states: NativeAccountTestState[] = [];

async function switchingState() {
  const state = await createNativeAccountTestState({ readyRuntime: true });
  states.push(state);
  const a1 = credential("a", 1);
  const b1 = credential("b", 1);
  await state.seedAccounts({
    current: { accountId: nativeAccountIds.a, credential: a1 },
    saved: [{ accountId: nativeAccountIds.b, credential: b1 }],
  });
  await state.runtime.start();
  return { state, a1, b1, transaction: new NativeProfileTransaction(state.store, state.runtime) };
}

afterEach(async () => {
  await Promise.all(states.splice(0).map((state) => state.close()));
});

describe("native profile transaction combinations", () => {
  it("captures the stopped latest A1 to A2 snapshot and completes A to B to A", async () => {
    const { state, b1, transaction } = await switchingState();
    const a2 = credential("a", 2);
    state.runtime.rotateOnNextStop(state.store.home, a2);

    await transaction.execute(nativeAccountIds.b);
    expect(state.store.vault.currentAccountId).toBe(nativeAccountIds.b);
    const savedA = state.store.vault.accounts.find(
      (account) => account.accountId === nativeAccountIds.a,
    );
    if (!savedA) throw new Error("missing saved A");
    expect(state.store.decrypt(savedA).serializeForNativeStore()).toBe(
      a2.serializeForNativeStore(),
    );
    expect((await state.store.readCredentials())?.serializeForNativeStore()).toBe(
      b1.serializeForNativeStore(),
    );

    await transaction.execute(nativeAccountIds.a);
    expect(state.store.vault.currentAccountId).toBe(nativeAccountIds.a);
    expect((await state.store.readCredentials())?.serializeForNativeStore()).toBe(
      a2.serializeForNativeStore(),
    );
    expect(state.runtime.maximumActive).toBe(1);
  });

  it("recovers the source when prepared persistence fails before installation", async () => {
    const { state, a1, transaction } = await switchingState();
    state.files.failNext({
      operation: "replace",
      phase: "before",
      matches: (_directory, name) => name === "transaction.json",
    });

    await expect(transaction.execute(nativeAccountIds.b)).rejects.toMatchObject({
      code: "switch-failed",
      ready: true,
    });
    expect(state.store.vault.currentAccountId).toBe(nativeAccountIds.a);
    expect((await state.store.readCredentials())?.serializeForNativeStore()).toBe(
      a1.serializeForNativeStore(),
    );
    expect(await state.store.readJournal()).toBeNull();
  });

  it("preserves refreshed A and refreshed B when target verification fails", async () => {
    const { state, transaction } = await switchingState();
    const a2 = credential("a", 2);
    const b2 = credential("b", 2);
    state.runtime.rotateOnNextStop(state.store.home, a2);
    state.runtime.startHook = async (home) => {
      if (home !== state.store.home) return;
      const installed = await state.store.readCredentials();
      if (installed?.identity.subject === "b") {
        state.runtime.rotateOnNextStop(home, b2);
        state.runtime.verifyError = new Error("synthetic target verification failure");
      }
    };

    await expect(transaction.execute(nativeAccountIds.b)).rejects.toMatchObject({
      code: "switch-failed",
      ready: true,
    });
    expect(state.store.vault.currentAccountId).toBe(nativeAccountIds.a);
    expect((await state.store.readCredentials())?.serializeForNativeStore()).toBe(
      a2.serializeForNativeStore(),
    );
    const savedB = state.store.vault.accounts.find(
      (account) => account.accountId === nativeAccountIds.b,
    );
    if (!savedB) throw new Error("missing saved B");
    expect(state.store.decrypt(savedB).serializeForNativeStore()).toBe(
      b2.serializeForNativeStore(),
    );
  });

  it("never rolls back a durable Vault commit after a lost replacement acknowledgement", async () => {
    const { state, b1, transaction } = await switchingState();
    state.files.failNext({
      operation: "replace",
      phase: "after",
      matches: (_directory, name) => name === "vault.json",
    });

    await expect(transaction.execute(nativeAccountIds.b)).rejects.toMatchObject({
      code: "recovery-required",
      ready: false,
    });
    expect(state.store.vault.currentAccountId).toBe(nativeAccountIds.b);
    expect((await state.store.readCredentials())?.serializeForNativeStore()).toBe(
      b1.serializeForNativeStore(),
    );

    await expect(transaction.recover()).resolves.toBe("target");
    expect(state.store.vault.currentAccountId).toBe(nativeAccountIds.b);
    expect(await state.store.readJournal()).toBeNull();
  });

  it("keeps the committed target when Journal cleanup succeeds but its acknowledgement is lost", async () => {
    const { state, b1, transaction } = await switchingState();
    state.files.failNext({
      operation: "remove",
      phase: "after",
      matches: (_directory, name) => name === "transaction.json",
    });

    await expect(transaction.execute(nativeAccountIds.b)).rejects.toMatchObject({
      code: "recovery-required",
      ready: false,
    });
    expect(state.store.vault.currentAccountId).toBe(nativeAccountIds.b);
    expect((await state.store.readCredentials())?.serializeForNativeStore()).toBe(
      b1.serializeForNativeStore(),
    );
    expect(await state.store.readJournal()).toBeNull();
  });

  it("recovers forward after committed Journal cleanup fails before removal", async () => {
    const { state, b1, transaction } = await switchingState();
    state.files.failNext({
      operation: "remove",
      phase: "before",
      matches: (_directory, name) => name === "transaction.json",
    });

    await expect(transaction.execute(nativeAccountIds.b)).rejects.toMatchObject({
      code: "recovery-required",
      ready: false,
    });
    expect(state.store.vault.currentAccountId).toBe(nativeAccountIds.b);
    expect((await state.store.readCredentials())?.serializeForNativeStore()).toBe(
      b1.serializeForNativeStore(),
    );
    expect((await state.store.readJournal())?.phase).toBe("vault-committed");

    await expect(transaction.recover()).resolves.toBe("target");
    expect(state.store.vault.currentAccountId).toBe(nativeAccountIds.b);
    expect(await state.store.readJournal()).toBeNull();
  });
});
