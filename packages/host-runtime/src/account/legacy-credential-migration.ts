import { createDecipheriv } from "node:crypto";
import { NativeCodexCredentials } from "./native-codex-credentials.js";
import {
  NativeAccountError,
  nativeDigest,
  parseVault,
  parseJournal,
  profileCurrent,
  restoreCredential,
  snapshotCredential,
  serializePrivate,
  type NativeProfileAccount,
  type NativeProfileVault,
  type StoredNativeCredential,
} from "./native-profile-vault.js";
import type { PrivateCredentialFiles, NativeLoginStage } from "./native-account-store.js";

/** Read-only legacy AES support. No new encrypted payloads or keys are created. */
function convertPayload(
  key: Buffer | undefined,
  homeId: string,
  account: NativeProfileAccount,
  payload: StoredNativeCredential,
): StoredNativeCredential {
  if ("format" in payload) {
    restoreCredential(account, payload);
    return payload;
  }
  let raw: Buffer | undefined;
  try {
    if (!key) throw new NativeAccountError("keyring-unavailable");
    const nonce = Buffer.from(payload.nonce, "base64");
    const tag = Buffer.from(payload.tag, "base64");
    if (nonce.length !== 12 || tag.length !== 16) throw new Error("envelope");
    const cipher = createDecipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(
      Buffer.from(
        JSON.stringify([
          "codexhost-native-profile-v1",
          homeId,
          account.accountId,
          account.identity,
          payload.digest,
        ]),
      ),
    );
    cipher.setAuthTag(tag);
    raw = Buffer.concat([cipher.update(Buffer.from(payload.ciphertext, "base64")), cipher.final()]);
    if (nativeDigest(raw) !== payload.digest || !Buffer.from(raw.toString("utf8")).equals(raw))
      throw new Error("digest");
    return snapshotCredential(account, NativeCodexCredentials.parse(raw.toString("utf8")));
  } catch {
    throw new NativeAccountError("recovery-required");
  } finally {
    raw?.fill(0);
  }
}

/**
 * Called under the existing home lease, before any Account operation. All files
 * are validated/converted before the first write. Per-file CAS replacements are
 * restartable: mixed old/new files normalize deterministically on the next open,
 * preserving journal revisions, phases, digests and exact credential bytes.
 */
export async function migrateLegacyCredentials(input: {
  files: PrivateCredentialFiles;
  directory: string;
  homeId: string;
  readLegacyKey(): Promise<Buffer | null>;
  parseStage(bytes: Buffer): NativeLoginStage;
}): Promise<void> {
  const files: Array<{ name: string; bytes: Buffer; next?: Buffer }> = [];
  let key: Buffer | undefined;
  try {
    for (const name of ["vault.json", "transaction.json", "login.json"]) {
      const bytes = await input.files.read(input.directory, name);
      if (bytes) files.push({ name, bytes });
    }
    const vaultFile = files.find((file) => file.name === "vault.json");
    if (!vaultFile) {
      if (files.length) throw new NativeAccountError("recovery-required");
      return;
    }
    const vault = parseVault(vaultFile.bytes, input.homeId);
    const journalFile = files.find((file) => file.name === "transaction.json");
    const journal = journalFile ? parseJournal(journalFile.bytes, input.homeId) : null;
    const stageFile = files.find((file) => file.name === "login.json");
    const stage = stageFile ? input.parseStage(stageFile.bytes) : null;
    const accounts = [
      ...vault.accounts,
      ...(journal
        ? [
            ...journal.before.accounts,
            ...journal.after.accounts,
            ...(journal.rollback?.accounts ?? []),
          ]
        : []),
      ...(stage?.candidate ? [stage.candidate] : []),
    ];
    const payloads = [...accounts.map((a) => a.payload), journal?.source, journal?.target];
    if (!payloads.some((payload) => payload && "cipher" in payload)) return;
    try {
      key = (await input.readLegacyKey()) ?? undefined;
      if (!key || key.length !== 32) throw new Error("missing key");
    } catch {
      throw new NativeAccountError("keyring-unavailable");
    }
    const convert = (account: NativeProfileAccount) => {
      if (account.payload)
        account.payload = convertPayload(key, input.homeId, account, account.payload);
    };
    const convertVault = (value: NativeProfileVault) => value.accounts.forEach(convert);
    convertVault(vault);
    vaultFile.next = serializePrivate(vault);
    if (journal && journalFile) {
      for (const field of ["source", "target"] as const) {
        const account = profileCurrent(field === "source" ? journal.before : journal.after);
        const payload = journal[field];
        if (account && payload)
          journal[field] = convertPayload(key, input.homeId, account, payload);
      }
      convertVault(journal.before);
      convertVault(journal.after);
      if (journal.rollback) convertVault(journal.rollback);
      journalFile.next = serializePrivate(journal);
      parseJournal(journalFile.next, input.homeId);
    }
    if (stage && stageFile) {
      if (stage.candidate) convert(stage.candidate);
      stageFile.next = Buffer.from(JSON.stringify(stage));
      input.parseStage(stageFile.next);
    }
    for (const file of files) {
      if (!file.next) continue;
      await input.files.replace(input.directory, file.name, file.next, nativeDigest(file.bytes));
      const observed = await input.files.read(input.directory, file.name);
      try {
        if (!observed?.equals(file.next)) throw new NativeAccountError("recovery-required");
      } finally {
        observed?.fill(0);
      }
    }
  } finally {
    key?.fill(0);
    for (const file of files) {
      file.bytes.fill(0);
      file.next?.fill(0);
    }
  }
}
