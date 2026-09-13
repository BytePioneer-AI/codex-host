import { afterEach, describe, expect, it } from "vitest";
import type { CodexAccountLoginCompleted } from "@codexhost/shared-contracts";

import { NativeCodexAccounts } from "../src/account/native-codex-accounts.js";
import { newProfile } from "../src/account/native-account-store.js";
import type { NativeLoginStage } from "../src/account/native-account-store.js";
import type { NativeProfileJournal } from "../src/account/native-profile-vault.js";
import {
  credential,
  createNativeAccountTestState,
  nativeAccountIds,
  type NativeAccountTestState,
} from "./fixtures/native-account-state.js";

const resources: Array<{
  state: NativeAccountTestState;
  manager?: NativeCodexAccounts;
}> = [];

function attachManager(state: NativeAccountTestState, manager: NativeCodexAccounts): void {
  const resource = resources.find((candidate) => candidate.state === state);
  if (!resource) throw new Error("missing synthetic resource");
  resource.manager = manager;
}

afterEach(async () => {
  await Promise.all(
    resources.splice(0).map(async ({ state, manager }) => {
      await manager?.close();
      await state.close();
    }),
  );
});

async function managedA() {
  const state = await createNativeAccountTestState();
  const a = credential("a");
  await state.seedAccounts({
    current: { accountId: nativeAccountIds.a, credential: a },
  });
  const manager = await state.initializeManager();
  resources.push({ state, manager });
  return { state, manager, a };
}

function completedEvent(success = true) {
  return {
    method: "account/login/completed",
    params: { loginId: "native-login", success },
  } as const;
}

describe("native Codex Account manager combinations", () => {
  it("recovers a first-login Journal before considering automatic import", async () => {
    const state = await createNativeAccountTestState();
    resources.push({ state });
    const b = credential("b");
    await state.seedAccounts({
      current: null,
      saved: [{ accountId: nativeAccountIds.b, credential: b }],
    });
    const before = state.store.vault;
    const after = structuredClone(before);
    after.currentAccountId = nativeAccountIds.b;
    after.revision++;
    after.lastOperationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const afterB = after.accounts.find((account) => account.accountId === nativeAccountIds.b);
    const beforeB = before.accounts.find((account) => account.accountId === nativeAccountIds.b);
    if (!afterB || !beforeB?.payload) throw new Error("missing synthetic B");
    afterB.payload = null;
    const journal: NativeProfileJournal = {
      version: 1,
      operationId: after.lastOperationId,
      phase: "prepared",
      before,
      after,
      source: null,
      target: beforeB.payload,
    };
    await state.store.writeJournal(journal);
    await state.store.install(b, null);

    const manager = new NativeCodexAccounts({
      store: state.store,
      runtime: state.runtime,
    });
    attachManager(state, manager);
    await manager.initialize();

    expect(manager.currentAccountId()).toBe(nativeAccountIds.b);
    expect(state.store.vault.accounts).toHaveLength(1);
    expect(state.store.vault.accounts[0]?.accountId).toBe(nativeAccountIds.b);
    expect(await state.store.readJournal()).toBeNull();
  });

  it("cleans an unconfirmed staging crash without importing its early native file", async () => {
    const state = await createNativeAccountTestState();
    resources.push({ state });
    const a = credential("a");
    const b = credential("b");
    await state.seedAccounts({
      current: { accountId: nativeAccountIds.a, credential: a },
    });
    const stage = await state.store.createStage();
    state.files.seed(state.store.stageHome(stage), "auth.json", b.serializeForNativeStore());

    const manager = new NativeCodexAccounts({
      store: state.store,
      runtime: state.runtime,
    });
    attachManager(state, manager);
    await manager.initialize();

    expect(manager.currentAccountId()).toBe(nativeAccountIds.a);
    expect(state.store.vault.accounts).toHaveLength(1);
    expect(await state.store.readStage()).toBeNull();
    expect((await state.store.readCredentials())?.serializeForNativeStore()).toBe(
      a.serializeForNativeStore(),
    );
  });

  it("buffers an early matching native event, saves B, and never alters permanent A", async () => {
    const { state, manager, a } = await managedA();
    const b = credential("b");
    const permanentBefore = state.files.peek(state.store.home, "auth.json");
    const completed = new Promise<CodexAccountLoginCompleted>((resolve) =>
      manager.subscribeLogin(resolve),
    );
    state.runtime.startHook = async (home) => {
      if (home === state.store.home) return;
      state.files.seed(home, "auth.json", b.serializeForNativeStore());
      state.runtime.emit(completedEvent());
    };

    await manager.startLogin();
    const result = await completed;

    expect(result).toMatchObject({ success: true, saved: true, cleanupRequired: false });
    expect(manager.currentAccountId()).toBe(nativeAccountIds.a);
    expect(state.store.vault.accounts.map((account) => account.accountId).sort()).toEqual(
      [nativeAccountIds.a, result.accountId].sort(),
    );
    const savedB = state.store.vault.accounts.find(
      (account) => account.accountId === result.accountId,
    );
    expect(savedB?.identity.subject).toBe("b");
    expect(state.files.peek(state.store.home, "auth.json")).toEqual(permanentBefore);
    expect((await state.store.readCredentials())?.serializeForNativeStore()).toBe(
      a.serializeForNativeStore(),
    );
    expect(state.runtime.maximumActive).toBe(1);
  });

  it("cancels staging before cleanup and ignores a late completion event", async () => {
    const { state, manager } = await managedA();
    const events: unknown[] = [];
    manager.subscribeLogin((value) => events.push(value));
    const login = await manager.startLogin();

    await expect(manager.cancelLogin(login.loginId)).resolves.toBe(true);
    state.runtime.emit(completedEvent());
    await Promise.resolve();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ success: false, saved: false, cleanupRequired: false });
    expect(state.store.vault.accounts).toHaveLength(1);
    expect(await state.store.readStage()).toBeNull();
    expect(state.runtime.activeHome).toBe(state.store.home);
  });

  it("uses new credentials for a same-current re-login", async () => {
    const { state, manager } = await managedA();
    const a2 = credential("a", 2);
    const completed = new Promise<CodexAccountLoginCompleted>((resolve) =>
      manager.subscribeLogin(resolve),
    );
    state.runtime.startHook = async (home) => {
      if (home === state.store.home) return;
      state.files.seed(home, "auth.json", a2.serializeForNativeStore());
      state.runtime.emit(completedEvent());
    };

    await manager.startLogin(nativeAccountIds.a);
    expect(await completed).toMatchObject({ success: true, saved: true });
    expect(manager.currentAccountId()).toBe(nativeAccountIds.a);
    expect((await state.store.readCredentials())?.serializeForNativeStore()).toBe(
      a2.serializeForNativeStore(),
    );
  });

  it("logs out through the credential transaction and remains ready", async () => {
    const { state, manager } = await managedA();

    await manager.logout();

    expect(manager.snapshot()).toMatchObject({
      phase: "ready",
      currentAccountId: null,
      cleanupRequired: false,
    });
    expect(await state.store.readCredentials()).toBeNull();
    const savedA = state.store.vault.accounts.find(
      (account) => account.accountId === nativeAccountIds.a,
    );
    expect(savedA?.payload).not.toBeNull();
  });

  it("reports unavailable instead of ready when native facts conflict", async () => {
    const state = await createNativeAccountTestState();
    resources.push({ state });
    await state.seedAccounts({
      current: { accountId: nativeAccountIds.a, credential: credential("a") },
    });
    state.files.seed(
      state.store.home,
      "auth.json",
      credential("third-party").serializeForNativeStore(),
    );
    const manager = new NativeCodexAccounts({
      store: state.store,
      runtime: state.runtime,
    });
    attachManager(state, manager);

    await expect(manager.initialize()).rejects.toThrow("Codex Account recovery-required");
    expect(manager.snapshot()).toMatchObject({
      phase: "unavailable",
      cleanupRequired: true,
      capabilities: { recover: true },
    });
  });

  it("finishes a verified staged candidate left by a crash", async () => {
    const state = await createNativeAccountTestState();
    resources.push({ state });
    const a = credential("a");
    const b = credential("b");
    await state.seedAccounts({
      current: { accountId: nativeAccountIds.a, credential: a },
    });
    const stage: NativeLoginStage = await state.store.createStage();
    const candidate = newProfile(b, nativeAccountIds.b);
    candidate.payload = state.store.snapshotCredential(candidate, b);
    stage.candidate = candidate;
    await state.store.writeStage(stage);
    const manager = new NativeCodexAccounts({
      store: state.store,
      runtime: state.runtime,
    });
    attachManager(state, manager);

    await manager.initialize();

    expect(manager.snapshot()).toMatchObject({
      phase: "ready",
      currentAccountId: nativeAccountIds.a,
    });
    expect(
      state.store.vault.accounts.some((account) => account.accountId === nativeAccountIds.b),
    ).toBe(true);
    expect(await state.store.readStage()).toBeNull();
  });
});
