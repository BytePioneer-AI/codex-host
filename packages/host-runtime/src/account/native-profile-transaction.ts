import { randomUUID } from "node:crypto";
import { OfficialAdmissionError } from "../codex-runtime/official-work-gate.js";
import type { NativeAccountRuntime } from "./native-account-runtime.js";
import { type NativeAccountStore, matchProfile } from "./native-account-store.js";
import type { NativeCodexCredentials } from "./native-codex-credentials.js";
import {
  NativeAccountError,
  credentialDigest,
  decideProfileRecovery,
  profileCurrent,
  sameVault,
  serializePrivate,
  type NativeProfileJournal,
  type NativeProfileVault,
} from "./native-profile-vault.js";

export class NativeTransitionError extends Error {
  constructor(
    readonly code: string,
    readonly ready: boolean,
  ) {
    super(`Codex Account ${code}`);
    this.name = "NativeTransitionError";
  }
}
const safeCode = (error: unknown): string => {
  const code =
    typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  return typeof code === "string" &&
    [
      "busy",
      "unsupported-version",
      "unsupported-storage",
      "keyring-unavailable",
      "credential-conflict",
      "unknown-account",
    ].includes(code)
    ? code
    : "switch-failed";
};

/** One transaction runner for switch, first activation, re-login and logout.
 * The caller owns the admission lease. Recovery observes disk, not last awaited step.
 */
export class NativeProfileTransaction {
  constructor(
    private readonly store: NativeAccountStore,
    private readonly runtime: NativeAccountRuntime,
  ) {}

  async execute(
    accountId: string | null,
    replacement?: NativeCodexCredentials,
    operationId: string = randomUUID(),
    stopExternalProcesses = false,
  ): Promise<void> {
    let stopping = false,
      stopped = false;
    const before = this.store.vault;
    try {
      if (await this.store.readJournal()) throw new NativeAccountError("recovery-required");
      const target =
        accountId === null ? null : before.accounts.find((a) => a.accountId === accountId);
      if (target === undefined) throw new NativeAccountError("unknown-account");
      const candidate = target ? (replacement ?? this.store.restoreCredential(target)) : null;
      matchProfile(candidate, target);
      await this.runtime.preflight();
      matchProfile(await this.store.readCredentials(), profileCurrent(before));
      stopping = true;
      await this.runtime.stop();
      stopped = true;
      if (stopExternalProcesses) await this.runtime.stopExternalProcesses();
      // Exit retires native work, but does not prove unrelated Host credential
      // refresh requests have finished. Never clear their leases to force success.
      if (this.runtime.gate.busy) throw new OfficialAdmissionError("busy");
      const source = await this.store.readCredentials();
      matchProfile(source, profileCurrent(before));
      const after = structuredClone(before);
      after.currentAccountId = accountId;
      after.revision++;
      after.lastOperationId = operationId;
      const sourceAccount = profileCurrent(before);
      const sourcePayload =
        sourceAccount && source ? this.store.snapshotCredential(sourceAccount, source) : null;
      const targetPayload =
        target && candidate ? this.store.snapshotCredential(target, candidate) : null;
      for (const account of after.accounts) {
        if (account.accountId === accountId) account.payload = null;
        else if (account.accountId === before.currentAccountId) account.payload = sourcePayload;
      }
      const journal: NativeProfileJournal = {
        version: 1,
        operationId,
        phase: "prepared",
        before,
        after,
        source: sourcePayload,
        target: targetPayload,
      };
      // Capacity/format checks precede credential mutation and cover every durable variant.
      serializePrivate(after);
      serializePrivate(journal);
      await this.store.writeJournal(journal);
      await this.store.install(candidate, source);
      journal.phase = "auth-replaced";
      await this.store.writeJournal(journal);
      await this.#finishTarget(journal);
    } catch (error) {
      if (!stopping)
        throw new NativeTransitionError(safeCode(error), this.runtime.gate.phase !== "unavailable");
      if (!stopped) throw new NativeTransitionError("stop-unconfirmed", false);
      try {
        const journal = await this.store.readJournal();
        if (journal && sameVault(await this.store.reload(), journal.after)) {
          // Durable commit wins over lost acknowledgements and cleanup errors.
          throw new NativeTransitionError("recovery-required", false);
        }
        await this.runtime.stop();
        if (!journal) {
          matchProfile(await this.store.readCredentials(), profileCurrent(before));
          await this.runtime.start();
          await this.runtime.verify(profileCurrent(before)?.identity ?? null);
        } else {
          const outcome = await this.recover(true);
          if (outcome !== "source") throw new NativeTransitionError("recovery-required", false);
        }
      } catch {
        throw new NativeTransitionError("recovery-required", false);
      }
      throw new NativeTransitionError("switch-failed", true);
    }
  }

  /** All previous native writers must be reconciled before any credential inspection. */
  async recover(rollback = false): Promise<"source" | "target" | "none"> {
    await this.runtime.stop();
    const journal = await this.store.readJournal();
    if (!journal) return "none";
    const actual = await this.store.readCredentials();
    const decision = decideProfileRecovery(journal, await this.store.reload(), actual);
    if (decision === "manual") throw new NativeAccountError("recovery-required");
    if (decision === "committed") {
      await this.runtime.start();
      await this.runtime.verify(profileCurrent(journal.after)?.identity ?? null);
      await this.store.clearJournal(journal.operationId);
      return "target";
    }
    if (decision === "source") {
      await this.#finishSource(journal);
      return "source";
    }
    if (rollback || decision === "rollback") {
      // Same identity re-login must retain the installed new grant, never restore old Tokens.
      if (journal.before.currentAccountId === journal.after.currentAccountId)
        throw new NativeAccountError("recovery-required");
      await this.#restoreSource(journal, actual);
      return "source";
    }
    if (journal.phase === "prepared") {
      if (credentialDigest(actual) !== (journal.target?.digest ?? null))
        throw new NativeAccountError("recovery-required");
      journal.phase = "auth-replaced";
      await this.store.writeJournal(journal);
    }
    try {
      await this.#finishTarget(journal);
      return "target";
    } catch {
      if (sameVault(await this.store.reload(), journal.after))
        throw new NativeAccountError("recovery-required");
      await this.runtime.stop();
      if (journal.before.currentAccountId === journal.after.currentAccountId)
        throw new NativeAccountError("recovery-required");
      await this.#restoreSource(journal, await this.store.readCredentials());
      return "source";
    }
  }

  async #finishTarget(journal: NativeProfileJournal): Promise<void> {
    await this.runtime.start();
    await this.runtime.verify(profileCurrent(journal.after)?.identity ?? null);
    matchProfile(await this.store.readCredentials(), profileCurrent(journal.after));
    this.store.assertOwnership();
    await this.store.replaceVault(journal.after, journal.before);
    await this.store.writeJournal({ ...journal, phase: "vault-committed" });
    await this.store.clearJournal(journal.operationId);
  }
  async #restoreSource(
    journal: NativeProfileJournal,
    actual: NativeCodexCredentials | null,
  ): Promise<void> {
    matchProfile(actual, profileCurrent(journal.after));
    const rollback: NativeProfileVault = structuredClone(journal.before);
    rollback.revision++;
    rollback.lastOperationId = journal.operationId;
    const target = profileCurrent(journal.after);
    if (target && actual) {
      const saved = rollback.accounts.find((a) => a.accountId === target.accountId);
      if (!saved) throw new NativeAccountError("recovery-required");
      saved.payload = this.store.snapshotCredential(saved, actual);
      journal.target = saved.payload;
    }
    journal.rollback = rollback;
    // Preserve rotated target bytes durably before touching the installed credential.
    await this.store.writeJournal(journal);
    const source = profileCurrent(journal.before);
    await this.store.install(
      source ? this.store.restoreCredential(source, journal.source) : null,
      actual,
    );
    await this.#finishSource(journal);
  }
  async #finishSource(journal: NativeProfileJournal): Promise<void> {
    matchProfile(await this.store.readCredentials(), profileCurrent(journal.before));
    await this.runtime.start();
    await this.runtime.verify(profileCurrent(journal.before)?.identity ?? null);
    if (journal.rollback) await this.store.replaceVault(journal.rollback, journal.before);
    await this.store.clearJournal(journal.operationId);
  }
}
