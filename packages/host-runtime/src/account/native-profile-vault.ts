// Native profile envelope/recovery model adapted from opencodex (MIT),
// commit 2d4d7a22381a2e497c2442902104619e25f937c7. See third-party/opencodex.LICENSE.
import { createHash } from "node:crypto";
import { z } from "zod";
import { codexAccountPlanTypeSchema } from "@codexhost/shared-contracts";
import {
  NativeCodexCredentials,
  codexCredentialIdentitySchema,
  sameCodexCredentialIdentity,
} from "./native-codex-credentials.js";

export class NativeAccountError extends Error {
  constructor(
    readonly code:
      | "recovery-required"
      | "unknown-account"
      | "keyring-unavailable"
      | "unsupported-storage"
      | "unsupported-version"
      | "migration-required"
      | "switch-failed"
      | "stop-unconfirmed"
      | "authentication-failed"
      | "cleanup-required"
      | "credential-conflict",
  ) {
    super(`Codex Account ${code}`);
    this.name = "NativeAccountError";
  }
}

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const encryptedSchema = z
  .object({
    cipher: z.literal("aes-256-gcm"),
    nonce: z.string().max(32),
    ciphertext: z.string().max(400_000),
    tag: z.string().max(32),
    digest: digestSchema,
  })
  .strict();
export type LegacyEncryptedCredential = z.infer<typeof encryptedSchema>;
const plaintextSchema = z
  .object({
    format: z.literal("plaintext"),
    nativeDocument: z.string().max(262_144),
    digest: digestSchema,
  })
  .strict();
// Legacy envelopes are accepted for one-time, in-place conversion only.
const storedCredentialSchema = z.union([plaintextSchema, encryptedSchema]);
export type StoredNativeCredential = z.infer<typeof storedCredentialSchema>;
const accountSchema = z
  .object({
    accountId: z.string().uuid(),
    identity: codexCredentialIdentitySchema,
    label: z.string().min(1).max(256),
    email: z.string().email().max(320).optional(),
    planType: codexAccountPlanTypeSchema.optional(),
    payload: storedCredentialSchema.nullable(),
  })
  .strict();
export type NativeProfileAccount = z.infer<typeof accountSchema>;
const vaultSchema = z
  .object({
    version: z.literal(1),
    homeId: digestSchema,
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    currentAccountId: z.string().uuid().nullable(),
    lastOperationId: z.string().uuid().nullable(),
    /** Credential adoption provenance, not proof of native history migration. */
    legacyRegistryDigest: digestSchema.optional(),
    accounts: z.array(accountSchema).max(128),
  })
  .strict();
export type NativeProfileVault = z.infer<typeof vaultSchema>;
const journalSchema = z
  .object({
    version: z.literal(1),
    operationId: z.string().uuid(),
    phase: z.enum(["prepared", "auth-replaced", "vault-committed"]),
    before: vaultSchema,
    after: vaultSchema,
    source: storedCredentialSchema.nullable(),
    target: storedCredentialSchema.nullable(),
    /** Durable compensation intent preserves rotated target Tokens before restoring source. */
    rollback: vaultSchema.optional(),
  })
  .strict();
export type NativeProfileJournal = z.infer<typeof journalSchema>;
export const VAULT_LIMIT = 4 * 1024 * 1024;
export const JOURNAL_LIMIT = 17 * 1024 * 1024;
export const nativeDigest = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");
export const credentialDigest = (credential: NativeCodexCredentials | null): string | null =>
  credential === null ? null : nativeDigest(credential.serializeForNativeStore());

export function parseProfileAccount(value: unknown): NativeProfileAccount {
  try {
    return accountSchema.parse(value);
  } catch {
    throw new NativeAccountError("recovery-required");
  }
}
export function profileCurrent(vault: NativeProfileVault): NativeProfileAccount | null {
  return vault.accounts.find((account) => account.accountId === vault.currentAccountId) ?? null;
}
export function sameVault(left: NativeProfileVault, right: NativeProfileVault): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
export function validateVault(value: unknown, homeId: string): NativeProfileVault {
  try {
    const vault = vaultSchema.parse(value);
    if (vault.homeId !== homeId) throw new Error("home");
    const ids = new Set<string>();
    const identities = new Set<string>();
    for (const account of vault.accounts) {
      const identity = JSON.stringify(account.identity);
      if (ids.has(account.accountId) || identities.has(identity)) throw new Error("duplicate");
      ids.add(account.accountId);
      identities.add(identity);
      if ((account.accountId === vault.currentAccountId) !== (account.payload === null))
        throw new Error("placement");
    }
    if (vault.currentAccountId !== null && !ids.has(vault.currentAccountId))
      throw new Error("current");
    return vault;
  } catch {
    throw new NativeAccountError("recovery-required");
  }
}
export function parseVault(bytes: Buffer, homeId: string): NativeProfileVault {
  try {
    if (bytes.length > VAULT_LIMIT) throw new Error("large");
    return validateVault(JSON.parse(bytes.toString("utf8")), homeId);
  } catch {
    throw new NativeAccountError("recovery-required");
  }
}
export function parseJournal(bytes: Buffer, homeId: string): NativeProfileJournal {
  try {
    if (bytes.length > JOURNAL_LIMIT) throw new Error("large");
    const journal = journalSchema.parse(JSON.parse(bytes.toString("utf8")));
    validateVault(journal.before, homeId);
    validateVault(journal.after, homeId);
    if (journal.rollback) {
      validateVault(journal.rollback, homeId);
      if (
        journal.rollback.legacyRegistryDigest !== journal.before.legacyRegistryDigest ||
        journal.rollback.currentAccountId !== journal.before.currentAccountId ||
        journal.rollback.revision !== journal.before.revision + 1 ||
        journal.rollback.accounts.length !== journal.before.accounts.length
      )
        throw new Error("rollback");
      for (const prior of journal.before.accounts) {
        const next = journal.rollback.accounts.find(
          (account) => account.accountId === prior.accountId,
        );
        if (!next || !sameCodexCredentialIdentity(next.identity, prior.identity))
          throw new Error("rollback identity");
        if (
          prior.accountId !== journal.after.currentAccountId &&
          JSON.stringify(prior) !== JSON.stringify(next)
        )
          throw new Error("rollback unrelated");
      }
    }
    if (
      journal.after.legacyRegistryDigest !== journal.before.legacyRegistryDigest ||
      journal.after.lastOperationId !== journal.operationId ||
      journal.after.revision !== journal.before.revision + 1 ||
      (profileCurrent(journal.before) === null) !== (journal.source === null) ||
      (profileCurrent(journal.after) === null) !== (journal.target === null)
    )
      throw new Error("invariant");
    // Switching only changes placement/current, not unrelated identities or membership.
    if (journal.before.accounts.length !== journal.after.accounts.length)
      throw new Error("membership");
    for (const before of journal.before.accounts) {
      const after = journal.after.accounts.find((a) => a.accountId === before.accountId);
      if (!after || !sameCodexCredentialIdentity(after.identity, before.identity))
        throw new Error("identity");
      if (
        before.accountId !== journal.before.currentAccountId &&
        before.accountId !== journal.after.currentAccountId &&
        JSON.stringify(before) !== JSON.stringify(after)
      )
        throw new Error("unrelated");
    }
    return journal;
  } catch {
    throw new NativeAccountError("recovery-required");
  }
}
export function serializePrivate(value: NativeProfileVault | NativeProfileJournal): Buffer {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  if (bytes.length > ("phase" in value ? JOURNAL_LIMIT : VAULT_LIMIT))
    throw new NativeAccountError("unsupported-storage");
  return bytes;
}

export function snapshotCredential(
  account: NativeProfileAccount,
  credential: NativeCodexCredentials,
): StoredNativeCredential {
  if (!sameCodexCredentialIdentity(account.identity, credential.identity))
    throw new NativeAccountError("credential-conflict");
  const nativeDocument = credential.serializeForNativeStore();
  return { format: "plaintext", nativeDocument, digest: nativeDigest(nativeDocument) };
}
export function restoreCredential(
  account: NativeProfileAccount,
  payload: StoredNativeCredential,
): NativeCodexCredentials {
  try {
    if (!("format" in payload) || nativeDigest(payload.nativeDocument) !== payload.digest)
      throw new Error("payload");
    const credential = NativeCodexCredentials.parse(payload.nativeDocument);
    if (!sameCodexCredentialIdentity(account.identity, credential.identity))
      throw new Error("identity");
    return credential;
  } catch {
    throw new NativeAccountError("recovery-required");
  }
}

export type ProfileRecoveryDecision = "source" | "target" | "committed" | "rollback" | "manual";
/** Pure observation-first recovery, following opencodex; includes logout and same-user re-login. */
export function decideProfileRecovery(
  journal: NativeProfileJournal,
  vault: NativeProfileVault,
  actual: NativeCodexCredentials | null,
): ProfileRecoveryDecision {
  const matches = (account: NativeProfileAccount | null): boolean =>
    account === null
      ? actual === null
      : actual !== null && sameCodexCredentialIdentity(account.identity, actual.identity);
  if (sameVault(vault, journal.after) && !journal.rollback)
    return matches(profileCurrent(journal.after)) ? "committed" : "manual";
  if (journal.rollback && sameVault(vault, journal.rollback))
    return matches(profileCurrent(journal.before)) ? "source" : "manual";
  if (!sameVault(vault, journal.before) || journal.phase === "vault-committed") return "manual";
  if (journal.rollback)
    return matches(profileCurrent(journal.before))
      ? "source"
      : matches(profileCurrent(journal.after))
        ? "rollback"
        : "manual";
  const source = matches(profileCurrent(journal.before)),
    target = matches(profileCurrent(journal.after));
  if (source && target) {
    const digest = credentialDigest(actual);
    const sourceDigest = journal.source?.digest ?? null;
    const targetDigest = journal.target?.digest ?? null;
    // Identical bytes cannot undo an explicit installation fact during re-login.
    if (digest === sourceDigest && (journal.phase === "prepared" || sourceDigest !== targetDigest))
      return "source";
    if (digest === targetDigest || journal.phase === "auth-replaced") return "target";
    return "manual";
  }
  if (source) return "source";
  if (
    target &&
    (journal.phase === "auth-replaced" ||
      credentialDigest(actual) === (journal.target?.digest ?? null))
  )
    return "target";
  return "manual";
}
