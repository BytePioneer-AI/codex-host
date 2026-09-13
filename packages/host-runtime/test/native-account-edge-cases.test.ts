import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexAccountLoginCompleted } from "@codexhost/shared-contracts";
import { NativeAccountStore } from "../src/account/native-account-store.js";
import { NativeCodexAccounts } from "../src/account/native-codex-accounts.js";
import { NativeCodexCredentials } from "../src/account/native-codex-credentials.js";
import { OfficialAdmissionError } from "../src/codex-runtime/official-work-gate.js";
import { NativePrivateFiles } from "../src/native-private-files.js";
import {
  credential,
  createNativeAccountTestState,
  nativeAccountIds,
  type NativeAccountTestState,
} from "./fixtures/native-account-state.js";

const resources: Array<{ state: NativeAccountTestState; manager?: NativeCodexAccounts }> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const { state, manager } of resources.splice(0)) {
    await manager?.close();
    await state.close();
  }
});
async function currentA() {
  const state = await createNativeAccountTestState();
  await state.seedAccounts({
    current: { accountId: nativeAccountIds.a, credential: credential("a") },
  });
  const manager = await state.initializeManager();
  resources.push({ state, manager });
  return { state, manager };
}
function loginWith(state: NativeAccountTestState, value: NativeCodexCredentials): void {
  state.runtime.startHook = async (home) => {
    if (home === state.store.home) return;
    state.files.seed(home, "auth.json", value.serializeForNativeStore());
    state.runtime.emit({
      method: "account/login/completed",
      params: { loginId: "native-login", success: true },
    });
  };
}
function completion(manager: NativeCodexAccounts): Promise<CodexAccountLoginCompleted> {
  return new Promise((resolve) => {
    const stop = manager.subscribeLogin((value) => {
      stop();
      resolve(value);
    });
  });
}

describe("native Account boundary regressions", () => {
  it("refuses unknown current identity before a cold bootstrap can refresh it", async () => {
    const state = await createNativeAccountTestState();
    resources.push({ state });
    await state.seedAccounts({
      current: { accountId: nativeAccountIds.a, credential: credential("a") },
    });
    state.files.seed(
      state.store.home,
      "auth.json",
      credential("outsider").serializeForNativeStore(),
    );
    const preflight = vi.spyOn(state.runtime, "preflight");
    const manager = new NativeCodexAccounts({ store: state.store, runtime: state.runtime });
    await expect(manager.initialize()).rejects.toThrow("recovery-required");
    expect(preflight).not.toHaveBeenCalled();
    expect(state.runtime.starts).toEqual([]);
    await manager.close();
  });

  it("opens an existing plaintext Vault without any keyring access and retains the lease", async () => {
    const state = await createNativeAccountTestState();
    resources.push({ state });
    await state.store.close();
    const keys = { read: vi.fn(async () => null) };
    const store = new NativeAccountStore({ home: state.store.home, files: state.files, keys });
    await expect(store.open()).resolves.toBe(true);
    expect(keys.read).not.toHaveBeenCalled();
    try {
      expect(() => store.assertFileOwnership()).not.toThrow();
      expect(store.vault.accounts).toEqual([]);
      await expect(state.files.lock(store.directory, ".codexhost-writer.lock")).rejects.toThrow();
    } finally {
      await store.close();
    }
  });

  it("uses one operation ID from login admission through staging and its public result", async () => {
    const { state, manager } = await currentA();
    const operations: string[] = [];
    const unsubscribe = state.runtime.gate.subscribe(() => {
      const pending = manager.snapshot().pendingOperation;
      if (pending) operations.push(pending.operationId);
    });
    try {
      const login = await manager.startLogin();
      expect(operations).toEqual([login.loginId]);
      expect((await state.store.readStage())?.operationId).toBe(login.loginId);
      expect(manager.snapshot().pendingOperation?.operationId).toBe(login.loginId);
      await manager.cancelLogin(login.loginId);
    } finally {
      unsubscribe();
    }
  });

  it("refuses logout while busy without stopping A", async () => {
    const { state, manager } = await currentA();
    const stop = vi.spyOn(state.runtime, "stop");
    vi.spyOn(state.runtime, "assertNativeIdle").mockRejectedValueOnce(
      new OfficialAdmissionError("busy"),
    );
    await expect(manager.logout()).rejects.toMatchObject({ code: "busy" });
    expect(stop).not.toHaveBeenCalled();
    expect(manager.snapshot().phase).toBe("ready");
  });

  it("reports busy without stopping A when native persisted work rejects login", async () => {
    const { state, manager } = await currentA();
    const stop = vi.spyOn(state.runtime, "stop");
    vi.spyOn(state.runtime, "assertNativeIdle").mockRejectedValueOnce(
      new OfficialAdmissionError("busy"),
    );
    await expect(manager.startLogin()).rejects.toMatchObject({ code: "busy" });
    expect(stop).not.toHaveBeenCalled();
    expect(manager.snapshot().phase).toBe("ready");
  });

  it("retries exit proof in unavailable recovery without retiring unconfirmed work", async () => {
    const { state, manager } = await currentA();
    const before = state.files.peek(state.store.home, "auth.json");
    state.runtime.gate.nativeWork("disconnected-native-turn", true);
    // Recovery must not stop a healthy busy backend.
    await expect(manager.recover()).rejects.toMatchObject({ code: "busy" });
    state.runtime.gate.unavailable();
    const stop = vi
      .spyOn(state.runtime, "stop")
      .mockRejectedValueOnce(new Error("stop-unconfirmed"));
    await expect(manager.recover()).rejects.toThrow("recovery-required");
    expect(stop).toHaveBeenCalledOnce();
    expect(state.runtime.gate.busy).toBe(true);
    expect(state.files.peek(state.store.home, "auth.json")).toEqual(before);
    await manager.recover();
    expect(state.runtime.gate.busy).toBe(false);
    expect(manager.snapshot().phase).toBe("ready");
  });

  it("keeps first-login recovery pending when activation preflight fails", async () => {
    const state = await createNativeAccountTestState();
    const manager = await state.initializeManager();
    resources.push({ state, manager });
    const originalPreflight = state.runtime.preflight.bind(state.runtime);
    let preflights = 0;
    vi.spyOn(state.runtime, "preflight").mockImplementation(async () => {
      preflights++;
      if (preflights === 2)
        throw Object.assign(new Error("synthetic activation preflight failure"), {
          code: "unsupported-version",
        });
      await originalPreflight();
    });
    loginWith(state, credential("b"));
    const resultPromise = completion(manager);

    await manager.startLogin();
    const result = await resultPromise;

    expect(result).toMatchObject({ success: false, saved: true, cleanupRequired: true });
    expect(manager.snapshot()).toMatchObject({
      phase: "unavailable",
      currentAccountId: null,
      cleanupRequired: true,
      capabilities: { recover: true },
    });
    const stage = await state.store.readStage();
    expect(stage).toMatchObject({ operationId: result.loginId });
    expect(stage?.candidate?.payload).not.toBeNull();
    expect(
      state.store.vault.accounts.find((account) => account.accountId === result.accountId)?.payload
        ?.digest,
    ).toBe(stage?.candidate?.payload?.digest);

    await manager.recover();

    expect(manager.snapshot()).toMatchObject({
      phase: "ready",
      currentAccountId: result.accountId,
      cleanupRequired: false,
    });
    expect((await state.store.readCredentials())?.identity.subject).toBe("b");
    expect(await state.store.readStage()).toBeNull();
  });

  it("retains first-login intent across a crash boundary before activation", async () => {
    const state = await createNativeAccountTestState();
    const manager = await state.initializeManager();
    resources.push({ state, manager });
    const originalPreflight = state.runtime.preflight.bind(state.runtime);
    let preflights = 0;
    const boundary: {
      stage: Awaited<ReturnType<typeof state.store.readStage>>;
      vault: typeof state.store.vault;
    } = { stage: null, vault: state.store.vault };
    vi.spyOn(state.runtime, "preflight").mockImplementation(async () => {
      preflights++;
      if (preflights === 2) {
        boundary.stage = await state.store.readStage();
        boundary.vault = state.store.vault;
        throw new Error("synthetic crash before first activation");
      }
      await originalPreflight();
    });
    loginWith(state, credential("b"));
    const resultPromise = completion(manager);

    await manager.startLogin();
    const result = await resultPromise;

    expect(boundary.stage).toMatchObject({ operationId: result.loginId });
    expect(boundary.stage?.candidate?.accountId).toBe(result.accountId);
    expect(boundary.vault).toMatchObject({
      currentAccountId: null,
      lastOperationId: result.loginId,
    });
    expect(boundary.vault.accounts.some((account) => account.accountId === result.accountId)).toBe(
      true,
    );
    expect(await state.store.readStage()).not.toBeNull();
    expect(await state.store.readJournal()).toBeNull();
    await manager.close();

    const restarted = new NativeCodexAccounts({ store: state.store, runtime: state.runtime });
    const resource = resources.find((candidate) => candidate.state === state);
    if (!resource) throw new Error("missing synthetic resource");
    resource.manager = restarted;
    await restarted.initialize();

    expect(restarted.snapshot()).toMatchObject({
      phase: "ready",
      currentAccountId: result.accountId,
      cleanupRequired: false,
    });
    expect((await state.store.readCredentials())?.identity.subject).toBe("b");
    expect(await state.store.readStage()).toBeNull();
  });

  it("cleans the tracked registration when creating the stage directory fails", async () => {
    const { state, manager } = await currentA();
    vi.spyOn(state.files, "ensureDirectory").mockRejectedValueOnce(
      new Error("synthetic mkdir failure"),
    );
    await expect(manager.startLogin()).rejects.toThrow("authentication-failed");
    expect(await state.store.readStage()).toBeNull();
    expect(manager.snapshot().phase).toBe("ready");
    expect((await state.store.readCredentials())?.identity.subject).toBe("a");
  });

  it("preserves A2 when resuming A refreshes Tokens and then fails after saving B", async () => {
    const { state, manager } = await currentA();
    const verify = state.runtime.verify.bind(state.runtime);
    let fail = true;
    vi.spyOn(state.runtime, "verify").mockImplementation(async (identity) => {
      await verify(identity);
      if (fail && state.runtime.activeHome === state.store.home) {
        fail = false;
        state.files.seed(
          state.store.home,
          "auth.json",
          credential("a", 2).serializeForNativeStore(),
        );
        throw new Error("synthetic failure after native refresh");
      }
    });
    loginWith(state, credential("b"));
    const result = completion(manager);
    await manager.startLogin();
    expect(await result).toMatchObject({ saved: true, cleanupRequired: true });
    expect((await state.store.readCredentials())?.serializeForNativeStore()).toBe(
      credential("a", 2).serializeForNativeStore(),
    );
    await manager.recover();
    expect(manager.snapshot().phase).toBe("ready");
    expect((await state.store.readCredentials())?.serializeForNativeStore()).toBe(
      credential("a", 2).serializeForNativeStore(),
    );
  });

  it("does not replay a stale staged grant after same-current re-login has rotated", async () => {
    const { state, manager } = await currentA();
    const verify = state.runtime.verify.bind(state.runtime);
    let fail = true;
    vi.spyOn(state.runtime, "verify").mockImplementation(async (identity) => {
      await verify(identity);
      if (fail && state.runtime.activeHome === state.store.home) {
        fail = false;
        state.files.seed(
          state.store.home,
          "auth.json",
          credential("a", 3).serializeForNativeStore(),
        );
        throw new Error("synthetic target refresh then failure");
      }
    });
    loginWith(state, credential("a", 2));
    const result = completion(manager);
    await manager.startLogin(nativeAccountIds.a);
    expect(await result).toMatchObject({ success: false, cleanupRequired: true });
    expect((await state.store.readCredentials())?.serializeForNativeStore()).toBe(
      credential("a", 3).serializeForNativeStore(),
    );
    await manager.recover();
    expect(manager.snapshot().phase).toBe("ready");
    expect((await state.store.readCredentials())?.serializeForNativeStore()).toBe(
      credential("a", 3).serializeForNativeStore(),
    );
    expect(await state.store.readStage()).toBeNull();
  });

  it("recognizes committed deletion when the rename acknowledgement is lost", async () => {
    const { state, manager } = await currentA();
    await state.seedAccounts({
      current: { accountId: nativeAccountIds.a, credential: credential("a") },
      saved: [{ accountId: nativeAccountIds.b, credential: credential("b") }],
    });
    state.files.failNext({
      operation: "replace",
      phase: "after",
      matches: (_directory, name) => name === "vault.json",
    });
    await expect(manager.remove(nativeAccountIds.b)).resolves.toBeUndefined();
    expect(manager.snapshot()).toMatchObject({
      phase: "ready",
      currentAccountId: nativeAccountIds.a,
    });
    expect(state.store.vault.accounts).toHaveLength(1);
  });

  it("supports native workspace omission without accepting conflicting users or workspaces", () => {
    const original = JSON.parse(credential("a").serializeForNativeStore());
    delete original.auth_mode;
    delete original.tokens.account_id;
    const idParts = original.tokens.id_token.split(".");
    const id = JSON.parse(Buffer.from(idParts[1], "base64url").toString("utf8"));
    delete id["https://api.openai.com/auth"];
    idParts[1] = Buffer.from(JSON.stringify(id)).toString("base64url");
    original.tokens.id_token = idParts.join(".");
    const bytes = `  ${JSON.stringify(original)}\n`;
    expect(NativeCodexCredentials.parse(bytes).serializeForNativeStore()).toBe(bytes);
    expect(NativeCodexCredentials.parse(bytes).managedOAuthCredential().chatgptAccountId).toBe(
      "shared-team",
    );
    original.tokens.account_id = "another-workspace";
    expect(() => NativeCodexCredentials.parse(JSON.stringify(original))).toThrow(
      "invalid or unsupported",
    );
    delete original.tokens.account_id;
    id.sub = "another-user";
    idParts[1] = Buffer.from(JSON.stringify(id)).toString("base64url");
    original.tokens.id_token = idParts.join(".");
    expect(() => NativeCodexCredentials.parse(JSON.stringify(original))).toThrow(
      "invalid or unsupported",
    );
  });
});

const launcher = process.env.CODEXHOST_TEST_NATIVE_LAUNCHER;
describe.skipIf(!launcher)(
  "Account Store with real private-file Interface and synthetic keys",
  () => {
    it("creates the login parent before the leaf and cleans a real private native file", async () => {
      if (!launcher) throw new Error("Compiled launcher required");
      const root = await realpath(await mkdtemp(path.join(tmpdir(), "codexhost-real-stage-")));
      const files = new NativePrivateFiles({ launcher });
      const store = new NativeAccountStore({
        home: path.join(root, "home"),
        files,
        homeFiles: files.withReadOnlyDirectoryAccess(),
      });
      try {
        await store.open();
        const stage = await store.createStage();
        const home = store.stageHome(stage);
        await files.replace(
          home,
          "auth.json",
          Buffer.from(credential("b").serializeForNativeStore()),
          null,
        );
        expect((await store.readCredentials(home))?.identity.subject).toBe("b");
        await store.clearStage(stage);
        expect(await store.readStage()).toBeNull();
        expect(await store.readCredentials()).toBeNull();
      } finally {
        await store.close();
        await rm(root, { recursive: true, force: true });
      }
    });
  },
);
