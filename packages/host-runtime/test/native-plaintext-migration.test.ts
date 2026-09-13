import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeAccountStore, newProfile } from "../src/account/native-account-store.js";
import type { NativeCodexCredentials } from "../src/account/native-codex-credentials.js";
import {
  nativeDigest,
  profileCurrent,
  sameVault,
  decideProfileRecovery,
  type NativeProfileAccount,
  type LegacyEncryptedCredential,
  type NativeProfileJournal,
} from "../src/account/native-profile-vault.js";
import {
  createNativeAccountTestState,
  credential,
  nativeAccountIds as ids,
  type NativeAccountTestState,
} from "./fixtures/native-account-state.js";

const key = Buffer.alloc(32, 0x5a);
const operationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
// Test-only legacy writer; production has no encryption path.
function legacy(
  homeId: string,
  account: NativeProfileAccount,
  value: NativeCodexCredentials,
): LegacyEncryptedCredential {
  const raw = value.serializeForNativeStore();
  const digest = nativeDigest(raw),
    nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(
    Buffer.from(
      JSON.stringify([
        "codexhost-native-profile-v1",
        homeId,
        account.accountId,
        account.identity,
        digest,
      ]),
    ),
  );
  const ciphertext = Buffer.concat([cipher.update(raw), cipher.final()]).toString("base64");
  return {
    cipher: "aes-256-gcm",
    nonce: nonce.toString("base64"),
    ciphertext,
    tag: cipher.getAuthTag().toString("base64"),
    digest,
  };
}
let state: NativeAccountTestState;
let store: NativeAccountStore;
afterEach(async () => {
  vi.restoreAllMocks();
  await store?.close();
  await state?.close();
});
async function fixture() {
  state = await createNativeAccountTestState();
  await state.seedAccounts({
    current: { accountId: ids.a, credential: credential("a") },
    saved: [{ accountId: ids.b, credential: credential("b") }],
  });
  const before = state.store.vault;
  const a = before.accounts.find((a) => a.accountId === ids.a);
  const b = before.accounts.find((a) => a.accountId === ids.b);
  assert.ok(a && b);
  b.payload = legacy(state.store.homeId, b, credential("b"));
  const after = structuredClone(before);
  after.currentAccountId = ids.b;
  after.lastOperationId = operationId;
  after.revision++;
  const afterA = after.accounts.find((a) => a.accountId === ids.a);
  const afterB = after.accounts.find((a) => a.accountId === ids.b);
  assert.ok(afterA && afterB);
  afterA.payload = legacy(state.store.homeId, a, credential("a"));
  afterB.payload = null;
  const journal: NativeProfileJournal = {
    version: 1,
    operationId,
    phase: "prepared",
    before,
    after,
    source: afterA.payload,
    target: b.payload,
  };
  const candidate = newProfile(credential("c"), ids.c);
  candidate.payload = legacy(state.store.homeId, candidate, credential("c"));
  const stage = {
    version: 1,
    operationId,
    sourceAccountId: ids.a,
    candidate,
    expiresAt: Date.now() + 60_000,
  };
  state.files.seed(state.store.directory, "vault.json", JSON.stringify(before));
  state.files.seed(state.store.directory, "transaction.json", JSON.stringify(journal));
  state.files.seed(state.store.directory, "login.json", JSON.stringify(stage));
  await state.store.close();
  const read = vi.fn(async (): Promise<Buffer | null> => Buffer.from(key));
  store = new NativeAccountStore({ home: state.store.home, files: state.files, keys: { read } });
  return { read, before, journal };
}
async function assertConverted() {
  const vault = store.vault;
  const saved = vault.accounts.find((a) => a.accountId === ids.b);
  assert.ok(saved);
  expect(store.restoreCredential(saved).serializeForNativeStore()).toBe(
    credential("b").serializeForNativeStore(),
  );
  const journal = await store.readJournal();
  assert.ok(journal);
  expect(sameVault(vault, journal.before)).toBe(true);
  expect(decideProfileRecovery(journal, vault, credential("a"))).toBe("source");
  const current = profileCurrent(journal.before);
  assert.ok(current);
  expect(store.restoreCredential(current, journal.source).serializeForNativeStore()).toBe(
    credential("a").serializeForNativeStore(),
  );
  const stage = await store.readStage();
  assert.ok(stage?.candidate);
  expect(store.restoreCredential(stage.candidate).serializeForNativeStore()).toBe(
    credential("c").serializeForNativeStore(),
  );
  for (const name of ["vault.json", "transaction.json", "login.json"]) {
    const raw = state.files.peek(store.directory, name);
    assert.ok(raw);
    expect(raw.toString()).not.toContain('"cipher"');
  }
}

describe("in-place plaintext credential migration", () => {
  it("converts vault, journal and login candidate in place, leaving installed auth untouched and never reading the key again", async () => {
    const { read, before } = await fixture();
    const installed = state.files.peek(state.store.home, "auth.json");
    await store.open();
    await assertConverted();
    expect(store.vault.revision).toBe(before.revision);
    expect(state.files.peek(state.store.home, "auth.json")).toEqual(installed);
    expect(read).toHaveBeenCalledOnce();
    await store.close();
    read.mockRejectedValue(new Error("keyring must not be accessed"));
    await store.open();
    await assertConverted();
    expect(read).toHaveBeenCalledOnce();
  });

  it.each(["vault.json", "transaction.json", "login.json"])(
    "resumes partial conversion after a lost %s write acknowledgement",
    async (name) => {
      await fixture();
      state.files.failNext({
        operation: "replace",
        phase: "after",
        matches: (_directory, file) => file === name,
      });
      await expect(store.open()).rejects.toThrow();
      await store.open();
      await assertConverted();
    },
  );

  it.each(["missing", "wrong", "corrupt-stage"])(
    "does not overwrite any file when %s prevents conversion",
    async (failure) => {
      const { read } = await fixture();
      if (failure === "missing") read.mockResolvedValue(null);
      if (failure === "wrong") read.mockResolvedValue(Buffer.alloc(32, 0x99));
      if (failure === "corrupt-stage") {
        const raw = state.files.peek(store.directory, "login.json");
        assert.ok(raw);
        const stage = JSON.parse(raw.toString());
        stage.candidate.payload.tag = Buffer.alloc(16).toString("base64");
        state.files.seed(store.directory, "login.json", JSON.stringify(stage));
      }
      const names = ["vault.json", "transaction.json", "login.json"];
      const before = names.map((name) => state.files.peek(store.directory, name));
      await expect(store.open()).rejects.toThrow(
        failure === "missing" ? "keyring-unavailable" : "recovery-required",
      );
      expect(names.map((name) => state.files.peek(store.directory, name))).toEqual(before);
    },
  );

  it("never reads or creates a key for a new store or new plaintext credentials", async () => {
    state = await createNativeAccountTestState();
    expect(state.keys.reads).toBe(0);
    await state.seedAccounts({
      current: null,
      saved: [{ accountId: ids.b, credential: credential("b") }],
    });
    expect(state.store.vault.accounts[0]?.payload).toMatchObject({ format: "plaintext" });
    await state.store.close();
    store = new NativeAccountStore({ home: state.store.home, files: state.files });
    await store.open();
    const saved = store.vault.accounts[0];
    assert.ok(saved);
    expect(store.restoreCredential(saved).serializeForNativeStore()).toBe(
      credential("b").serializeForNativeStore(),
    );
  });
});
