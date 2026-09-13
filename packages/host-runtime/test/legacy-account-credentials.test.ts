import { afterEach, describe, expect, it, vi } from "vitest";
import { importLegacyAccountCredentials } from "../src/account/legacy-account-credentials.js";
import { nativeDigest } from "../src/account/native-profile-vault.js";
import {
  createNativeAccountTestState,
  credential,
  nativeAccountIds,
  type NativeAccountTestState,
} from "./fixtures/native-account-state.js";

const resources: NativeAccountTestState[] = [];
afterEach(async () => {
  for (const state of resources.splice(0)) await state.close();
});
async function fixture() {
  const state = await createNativeAccountTestState();
  resources.push(state);
  await state.seedAccounts({
    current: { accountId: nativeAccountIds.a, credential: credential("a") },
    saved: [],
  });
  const sources = new Map([
    ["current", credential("a")],
    ["other", credential("b")],
  ]);
  const read = vi.fn(async (home: string) => sources.get(home) ?? null);
  const check = vi.fn(async () => {});
  const input = {
    store: state.store,
    registryDigest: nativeDigest("legacy-registry"),
    homes: ["current", "other"],
    readCredentials: read,
    assertAdmission: check,
  };
  return { state, sources, read, check, input };
}

describe("non-destructive legacy Account credential adoption", () => {
  it("imports only missing identities, encrypts complete bytes and retains current native authentication", async () => {
    const f = await fixture();
    const before = (await f.state.store.readCredentials())?.serializeForNativeStore();
    await importLegacyAccountCredentials(f.input);
    const vault = f.state.store.vault;
    expect(vault.currentAccountId).toBe(nativeAccountIds.a);
    expect(vault.accounts).toHaveLength(2);
    expect(vault.legacyRegistryDigest).toBe(f.input.registryDigest);
    const added = vault.accounts.find((a) => a.accountId !== nativeAccountIds.a);
    if (!added) throw new Error("Missing adopted Account");
    expect(f.state.store.restoreCredential(added).serializeForNativeStore()).toBe(
      credential("b").serializeForNativeStore(),
    );
    expect((await f.state.store.readCredentials())?.serializeForNativeStore()).toBe(before);
    expect(f.sources.get("other")?.serializeForNativeStore()).toBe(
      credential("b").serializeForNativeStore(),
    );
    expect(f.check).toHaveBeenCalledTimes(2);
  });

  it("does not resurrect an Account deleted after successful adoption", async () => {
    const f = await fixture();
    await importLegacyAccountCredentials(f.input);
    await f.state.store.mutate((next) => {
      next.accounts = next.accounts.filter((a) => a.accountId === nativeAccountIds.a);
    });
    f.read.mockClear();
    await importLegacyAccountCredentials(f.input);
    expect(f.state.store.vault.accounts).toHaveLength(1);
    expect(f.read).not.toHaveBeenCalled();
  });

  it("never overwrites a saved newer grant with an old legacy grant", async () => {
    const f = await fixture();
    await f.state.seedAccounts({
      current: { accountId: nativeAccountIds.a, credential: credential("a") },
      saved: [{ accountId: nativeAccountIds.b, credential: credential("b", 3) }],
    });
    await importLegacyAccountCredentials(f.input);
    const saved = f.state.store.vault.accounts.find((a) => a.accountId === nativeAccountIds.b);
    if (!saved) throw new Error("Missing saved Account");
    expect(f.state.store.restoreCredential(saved).serializeForNativeStore()).toBe(
      credential("b", 3).serializeForNativeStore(),
    );
  });

  it("retains missing legacy credentials as source data rather than inventing a signed-in identity", async () => {
    const f = await fixture();
    f.sources.delete("other");
    await importLegacyAccountCredentials(f.input);
    expect(f.state.store.vault.accounts).toHaveLength(1);
  });

  it.each(["writer", "source-changed", "registry-changed", "pending-transaction", "write-failed"])(
    "does not partially adopt when %s",
    async (failure) => {
      const f = await fixture();
      const before = f.state.store.vault;
      if (failure === "writer") f.check.mockRejectedValueOnce(new Error("Unknown writer"));
      if (failure === "source-changed")
        f.read
          .mockImplementationOnce(async () => credential("a"))
          .mockImplementationOnce(async () => credential("b", 2));
      if (failure === "registry-changed")
        f.check
          .mockResolvedValueOnce(undefined)
          .mockRejectedValueOnce(new Error("Changed registry"));
      if (failure === "pending-transaction")
        vi.spyOn(f.state.store, "readJournal").mockRejectedValue(
          new Error("Unresolved transaction"),
        );
      if (failure === "write-failed")
        f.state.files.failNext({
          operation: "replace",
          phase: "before",
          matches: (_, name) => name === "vault.json",
        });
      await expect(importLegacyAccountCredentials(f.input)).rejects.toThrow();
      expect(f.state.store.vault).toEqual(before);
    },
  );

  it("recognizes a durable import despite a lost write acknowledgement", async () => {
    const f = await fixture();
    f.state.files.failNext({
      operation: "replace",
      phase: "after",
      matches: (_, name) => name === "vault.json",
    });
    await expect(importLegacyAccountCredentials(f.input)).resolves.toBeUndefined();
    expect(f.state.store.vault.accounts).toHaveLength(2);
    expect(f.state.store.vault.legacyRegistryDigest).toBe(f.input.registryDigest);
  });

  it("refuses changed registry provenance instead of silently adding a different set", async () => {
    const f = await fixture();
    await importLegacyAccountCredentials(f.input);
    await expect(
      importLegacyAccountCredentials({ ...f.input, registryDigest: nativeDigest("different") }),
    ).rejects.toThrow();
    expect(f.state.store.vault.accounts).toHaveLength(2);
  });
});
