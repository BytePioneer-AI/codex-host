import { afterEach, describe, expect, it, vi } from "vitest";

import type { NativeCodexAccounts } from "../src/account/native-codex-accounts.js";
import {
  createNativeAccountTestState,
  credential,
  nativeAccountIds,
  type NativeAccountTestState,
} from "./fixtures/native-account-state.js";

const resources: Array<{ state: NativeAccountTestState; manager?: NativeCodexAccounts }> = [];
afterEach(async () => {
  for (const { state, manager } of resources.splice(0)) {
    await manager?.close();
    await state.close();
  }
  vi.restoreAllMocks();
});

async function fixture() {
  const state = await createNativeAccountTestState();
  const resource: { state: NativeAccountTestState; manager?: NativeCodexAccounts } = { state };
  resources.push(resource);
  await state.seedAccounts({
    current: { accountId: nativeAccountIds.a, credential: credential("a") },
    saved: [{ accountId: nativeAccountIds.b, credential: credential("b") }],
  });
  const manager = await state.initializeManager();
  resource.manager = manager;
  return { state, manager };
}

function completion() {
  return {
    method: "account/login/completed",
    params: {
      loginId: "native-login",
      success: true,
      error: null,
      onboardingEntrypoint: "life_sciences",
    },
  };
}

describe("native Desktop login uses the one Account transaction", () => {
  it.each(["chatgpt", "chatgptDeviceCode"] as const)(
    "activates %s login rather than silently adding an inactive identity",
    async (type) => {
      const { state, manager } = await fixture();
      const latestA = credential("a", 2);
      const latestB = credential("b", 3);
      state.runtime.rotateOnNextStop(state.store.home, latestA);
      const params =
        type === "chatgpt"
          ? {
              type,
              codexStreamlinedLogin: true,
              useHostedLoginSuccessPage: true,
              appBrand: "codex" as const,
            }
          : { type };
      const started = await manager.startNativeLogin(params);
      const stage = await state.store.readStage();
      if (!stage) throw new Error("Missing synthetic native login stage");
      expect(stage.activateOnSuccess).toBe(true);
      expect(started.response).toMatchObject({ type, loginId: stage.operationId });
      expect(started.response.loginId).not.toBe("native-login");
      expect(state.runtime.controlRequests).toContainEqual({
        method: "account/login/start",
        params,
      });
      const stageHome = state.store.stageHome(stage);
      state.files.seed(stageHome, "auth.json", credential("b", 2).serializeForNativeStore());
      state.runtime.rotateOnNextStop(stageHome, latestB);
      state.runtime.emit(completion());
      await expect(started.completed).resolves.toEqual({
        loginId: stage.operationId,
        success: true,
        error: null,
        onboardingEntrypoint: "life_sciences",
      });
      expect(manager.snapshot()).toMatchObject({
        phase: "ready",
        currentAccountId: nativeAccountIds.b,
      });
      expect(
        (await state.store.readCredentials())?.serializeForNativeStore() ===
          latestB.serializeForNativeStore(),
      ).toBe(true);
      const savedA = state.store.vault.accounts.find(
        (account) => account.accountId === nativeAccountIds.a,
      );
      if (!savedA) throw new Error("Missing saved synthetic A");
      expect(
        state.store.decrypt(savedA).serializeForNativeStore() === latestA.serializeForNativeStore(),
      ).toBe(true);
      expect(await state.store.readStage()).toBeNull();
      expect(await state.store.readJournal()).toBeNull();
      expect(state.runtime.maximumActive).toBe(1);
    },
  );

  it("retains activation intent after saving B but failing before credential replacement", async () => {
    const { state, manager } = await fixture();
    const started = await manager.startNativeLogin({ type: "chatgpt" });
    const stage = await state.store.readStage();
    if (!stage) throw new Error("Missing synthetic stage");
    state.files.seed(
      state.store.stageHome(stage),
      "auth.json",
      credential("b", 2).serializeForNativeStore(),
    );
    state.files.failNext({
      operation: "replace",
      phase: "before",
      matches: (_directory, name) => name === "transaction.json",
    });
    state.runtime.emit(completion());
    await expect(started.completed).resolves.toMatchObject({
      loginId: stage.operationId,
      success: false,
    });
    expect(manager.snapshot()).toMatchObject({
      phase: "unavailable",
      currentAccountId: nativeAccountIds.a,
    });
    expect(await state.store.readStage()).toMatchObject({
      activateOnSuccess: true,
      operationId: stage.operationId,
    });

    await manager.recover();
    expect(manager.snapshot()).toMatchObject({
      phase: "ready",
      currentAccountId: nativeAccountIds.b,
    });
    expect(await state.store.readStage()).toBeNull();
    // Recovery does not rewrite the already-delivered native operation outcome.
    await expect(started.completed).resolves.toMatchObject({ success: false });
  });

  it.each([
    { phase: "inspection", action: "cancel" },
    { phase: "inspection", action: "close" },
    { phase: "registration", action: "cancel" },
    { phase: "registration", action: "close" },
  ])(
    "settles $action during stage $phase without starting authentication",
    async ({ phase, action }) => {
      const { state, manager } = await fixture();
      const inspected = Promise.withResolvers<undefined>();
      const proceed = Promise.withResolvers<undefined>();
      const pause = async () => {
        inspected.resolve(undefined);
        await proceed.promise;
      };
      if (phase === "inspection") {
        vi.spyOn(state.store, "readStage").mockImplementationOnce(async () => {
          await pause();
          return null;
        });
      } else {
        const createStage = state.store.createStage.bind(state.store);
        vi.spyOn(state.store, "createStage").mockImplementationOnce(async (...args) => {
          const stage = await createStage(...args);
          await pause();
          return stage;
        });
      }
      let started = false;
      const start = manager.startNativeLogin({ type: "chatgpt" }).then(
        () => {
          started = true;
        },
        () => {},
      );
      await inspected.promise;
      const operationId = manager.snapshot().pendingOperation?.operationId;
      if (!operationId) throw new Error("Missing admitted synthetic operation");
      const cancelled =
        action === "close" ? manager.close().then(() => true) : manager.cancelLogin(operationId);
      let settled = false;
      void cancelled.then(() => {
        settled = true;
      });
      await Promise.resolve();
      const settledBeforeProceed = settled;
      proceed.resolve(undefined);
      await start;
      expect(settledBeforeProceed).toBe(false);
      expect(await cancelled).toBe(true);
      expect(started).toBe(false);
      expect(
        state.runtime.controlRequests.some(({ method }) => method === "account/login/start"),
      ).toBe(false);
      expect(state.runtime.starts.every((home) => home === state.store.home)).toBe(true);
      expect(manager.snapshot()).toMatchObject({
        phase: "ready",
        currentAccountId: nativeAccountIds.a,
      });
      expect(await state.store.readStage()).toBeNull();
    },
  );

  it("accepts cancellation from the first published admission snapshot", async () => {
    const { state, manager } = await fixture();
    let cancelled: Promise<boolean> | undefined;
    const unsubscribe = state.runtime.gate.subscribe(() => {
      const pending = manager.snapshot().pendingOperation;
      if (!cancelled && pending?.kind === "login")
        cancelled = manager.cancelLogin(pending.operationId);
    });
    try {
      await expect(manager.startNativeLogin({ type: "chatgpt" })).rejects.toThrow();
      expect(cancelled).toBeDefined();
      expect(await cancelled).toBe(true);
      expect(state.runtime.starts).toEqual([state.store.home]);
      expect(manager.snapshot().phase).toBe("ready");
    } finally {
      unsubscribe();
    }
  });

  it("retains a matching native completion received before the start response", async () => {
    const { state, manager } = await fixture();
    const original = state.runtime.controlRequest.bind(state.runtime);
    vi.spyOn(state.runtime, "controlRequest").mockImplementation(async (method, params) => {
      const response = await original(method, params);
      if (method === "account/login/start") {
        const stage = await state.store.readStage();
        if (!stage) throw new Error("Missing synthetic stage");
        state.files.seed(
          state.store.stageHome(stage),
          "auth.json",
          credential("b", 2).serializeForNativeStore(),
        );
        state.runtime.emit(completion());
      }
      return response;
    });
    const started = await manager.startNativeLogin({ type: "chatgpt" });
    await expect(started.completed).resolves.toMatchObject({
      loginId: started.response.loginId,
      success: true,
    });
    expect(manager.currentAccountId()).toBe(nativeAccountIds.b);
  });

  it("does not report native authentication success when committed credentials require cleanup", async () => {
    const { state, manager } = await fixture();
    const started = await manager.startNativeLogin({ type: "chatgpt" });
    const stage = await state.store.readStage();
    if (!stage) throw new Error("Missing synthetic stage");
    state.files.seed(
      state.store.stageHome(stage),
      "auth.json",
      credential("b", 2).serializeForNativeStore(),
    );
    state.files.failNext({
      operation: "remove",
      phase: "before",
      matches: (_directory, name) => name === "transaction.json",
    });
    state.runtime.emit(completion());
    await expect(started.completed).resolves.toMatchObject({
      success: false,
      error: expect.any(String),
    });
    expect(manager.snapshot()).toMatchObject({
      phase: "unavailable",
      currentAccountId: nativeAccountIds.b,
    });
    expect(await state.store.readJournal()).not.toBeNull();
  });
});
