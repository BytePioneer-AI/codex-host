import { randomUUID } from "node:crypto";
import { matchProfile, newProfile, type NativeAccountStore } from "./native-account-store.js";
import {
  sameCodexCredentialIdentity,
  type NativeCodexCredentials,
} from "./native-codex-credentials.js";
import {
  NativeAccountError,
  credentialDigest,
  profileCurrent,
  sameVault,
  validateVault,
} from "./native-profile-vault.js";

/** Adopt credentials, not native histories. Caller holds exclusive Account admission,
 * has verified the permanent native identity/storage, and has stopped its backend.
 * Every source is read-only; one Vault CAS records both Accounts and provenance. */
export async function importLegacyAccountCredentials(input: {
  store: NativeAccountStore;
  registryDigest: string;
  homes: readonly string[];
  readCredentials(home: string): Promise<NativeCodexCredentials | null>;
  /** Revalidate source layout and owned-process exit while stopped. */
  assertAdmission(): Promise<void>;
}): Promise<void> {
  const { store } = input;
  const before = await store.reload();
  if (before.legacyRegistryDigest) {
    if (before.legacyRegistryDigest !== input.registryDigest)
      throw new NativeAccountError("migration-required");
    return;
  }
  if ((await store.readJournal()) || (await store.readStage()))
    throw new NativeAccountError("recovery-required");
  await input.assertAdmission();
  const current = await store.readCredentials();
  matchProfile(current, profileCurrent(before));
  const sources = [];
  const next = structuredClone(before);
  for (const home of input.homes) {
    const credential = await input.readCredentials(home);
    sources.push({ home, digest: credentialDigest(credential) });
    if (
      !credential ||
      next.accounts.some((account) =>
        sameCodexCredentialIdentity(account.identity, credential.identity),
      )
    )
      continue;
    const account = newProfile(credential);
    account.payload = store.snapshotCredential(account, credential);
    next.accounts.push(account);
  }
  // Refreshing an old CLI must not race credential capture; never overwrite a saved
  // newer grant with an old source, even when the source has the same identity.
  for (const source of sources) {
    if (credentialDigest(await input.readCredentials(source.home)) !== source.digest)
      throw new NativeAccountError("credential-conflict");
  }
  await input.assertAdmission();
  if (credentialDigest(await store.readCredentials()) !== credentialDigest(current))
    throw new NativeAccountError("credential-conflict");
  next.legacyRegistryDigest = input.registryDigest;
  next.revision++;
  next.lastOperationId = randomUUID();
  try {
    await store.replaceVault(next, before);
  } catch (error) {
    // A successful rename may lose its acknowledgement. Never import twice or
    // resurrect an Account a user subsequently deleted from the adopted Vault.
    if (!sameVault(await store.reload(), validateVault(next, store.homeId))) throw error;
  }
}
