import { describe, expect, it } from "vitest";

import { newProfile } from "../src/account/native-account-store.js";
import {
  restoreCredential,
  decideProfileRecovery,
  snapshotCredential,
  nativeDigest,
  parseJournal,
  serializePrivate,
  type NativeProfileJournal,
  type NativeProfileVault,
} from "../src/account/native-profile-vault.js";
import { credential, nativeAccountIds } from "./fixtures/native-account-state.js";

const homeId = nativeDigest("/synthetic/canonical/home");
const operationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function switchingJournal(phase: NativeProfileJournal["phase"] = "prepared") {
  const a = credential("a", 1);
  const b = credential("b", 1);
  const profileA = newProfile(a, nativeAccountIds.a);
  const profileB = newProfile(b, nativeAccountIds.b);
  profileB.payload = snapshotCredential(profileB, b);
  const before: NativeProfileVault = {
    version: 1,
    homeId,
    revision: 7,
    currentAccountId: profileA.accountId,
    lastOperationId: null,
    accounts: [profileA, profileB],
  };
  const after = structuredClone(before);
  after.revision++;
  after.lastOperationId = operationId;
  after.currentAccountId = profileB.accountId;
  const afterA = after.accounts.find((account) => account.accountId === profileA.accountId);
  const afterB = after.accounts.find((account) => account.accountId === profileB.accountId);
  if (!afterA || !afterB) throw new Error("missing synthetic profiles");
  afterA.payload = snapshotCredential(profileA, a);
  afterB.payload = null;
  const journal: NativeProfileJournal = {
    version: 1,
    operationId,
    phase,
    before,
    after,
    source: afterA.payload,
    target: profileB.payload,
  };
  return { a, b, before, after, journal };
}

describe("native profile Vault codec", () => {
  it("preserves plaintext credential bytes and checks digest and identity", () => {
    const original = credential("codec", 3);
    const account = newProfile(original, nativeAccountIds.a);
    const payload = snapshotCredential(account, original);
    expect(payload).toMatchObject({
      format: "plaintext",
      nativeDocument: original.serializeForNativeStore(),
    });
    expect(restoreCredential(account, payload).serializeForNativeStore()).toBe(
      original.serializeForNativeStore(),
    );
    expect(() => restoreCredential(account, { ...payload, digest: "0".repeat(64) })).toThrow(
      "recovery-required",
    );
    expect(() => restoreCredential(newProfile(credential("other")), payload)).toThrow(
      "recovery-required",
    );
  });

  it("validates persisted transaction facts and distinguishes every durable phase", () => {
    const prepared = switchingJournal("prepared");
    expect(parseJournal(serializePrivate(prepared.journal), homeId)).toEqual(prepared.journal);
    expect(decideProfileRecovery(prepared.journal, prepared.before, prepared.a)).toBe("source");
    expect(decideProfileRecovery(prepared.journal, prepared.before, prepared.b)).toBe("target");
    expect(decideProfileRecovery(prepared.journal, prepared.before, credential("unknown"))).toBe(
      "manual",
    );

    const replaced = switchingJournal("auth-replaced");
    expect(decideProfileRecovery(replaced.journal, replaced.before, credential("b", 2))).toBe(
      "target",
    );
    expect(decideProfileRecovery(replaced.journal, replaced.after, replaced.b)).toBe("committed");

    const committed = switchingJournal("vault-committed");
    expect(decideProfileRecovery(committed.journal, committed.before, committed.b)).toBe("manual");
    expect(decideProfileRecovery(committed.journal, committed.after, committed.b)).toBe(
      "committed",
    );
    expect(
      decideProfileRecovery(committed.journal, committed.after, credential("third-party")),
    ).toBe("manual");
  });

  it("uses credential digests to disambiguate same-current re-login facts", () => {
    const a1 = credential("same", 1);
    const a2 = credential("same", 2);
    const profile = newProfile(a1, nativeAccountIds.a);
    const before: NativeProfileVault = {
      version: 1,
      homeId,
      revision: 2,
      currentAccountId: profile.accountId,
      lastOperationId: null,
      accounts: [profile],
    };
    const after = structuredClone(before);
    after.revision++;
    after.lastOperationId = operationId;
    const journal: NativeProfileJournal = {
      version: 1,
      operationId,
      phase: "prepared",
      before,
      after,
      source: snapshotCredential(profile, a1),
      target: snapshotCredential(profile, a2),
    };

    expect(decideProfileRecovery(journal, before, a1)).toBe("source");
    expect(decideProfileRecovery({ ...journal, phase: "auth-replaced" }, before, a2)).toBe(
      "target",
    );

    // Even an identical native envelope has an explicit installation/commit intent.
    const identical = { ...journal, target: journal.source };
    expect(decideProfileRecovery(identical, before, a1)).toBe("source");
    expect(decideProfileRecovery({ ...identical, phase: "auth-replaced" }, before, a1)).toBe(
      "target",
    );
  });
});
