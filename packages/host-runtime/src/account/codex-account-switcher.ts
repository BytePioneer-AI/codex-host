import { randomUUID } from "node:crypto";

import type { OfficialWorkGate } from "../codex-runtime/official-work-gate.js";
import type { CodexCredentialFiles, CredentialAccountRef } from "./codex-credential-files.js";
import type {
  CredentialSwitchJournal,
  CredentialSwitchRecord,
} from "./credential-switch-journal.js";
import {
  type NativeCodexCredentials,
  sameCodexCredentialIdentity,
  type CodexCredentialIdentity,
} from "./native-codex-credentials.js";
import type { SavedCodexAccount } from "./saved-codex-accounts.js";

export interface SwitchingAccountRegistry {
  list(): SavedCodexAccount[];
  getCurrentAccountId(): string | null;
  setCurrentAccountId(accountId: string | null): Promise<void>;
  saveVerifiedAccount(input: {
    identity: CodexCredentialIdentity;
    preferredAccountId?: string;
    label?: string;
    email?: string;
    planType?: SavedCodexAccount["planType"];
  }): Promise<SavedCodexAccount>;
}

/** Implemented by the single official owner, never by a logical socket client. */
export interface SwitchingOfficialRuntime {
  preflight(): Promise<void>;
  assertNativeIdle(): Promise<void>;
  stop(): Promise<void>;
  start(): Promise<void>;
  /** Native-file identity + account/read + authenticated read; not merely JWT decoding. */
  verify(identity: CodexCredentialIdentity | null): Promise<void>;
}

function isStableAccountOperationError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return [
    "busy",
    "changing",
    "unavailable",
    "authentication-failed",
    "unsupported-version",
    "unsupported-storage",
  ].includes(String(error.code));
}

export class CodexAccountSwitchError extends Error {
  constructor(
    readonly code:
      | "unknown-account"
      | "switch-failed"
      | "stop-unconfirmed"
      | "rollback-failed"
      | "recovery-required",
  ) {
    super(`Codex Account ${code}`);
    this.name = "CodexAccountSwitchError";
  }
}

/** Credential transaction only. It has no Desktop, Harness, history or cleanup ownership. */
export class CodexAccountSwitcher {
  readonly #accounts: SwitchingAccountRegistry;
  readonly #credentials: CodexCredentialFiles;
  readonly #runtime: SwitchingOfficialRuntime;
  readonly #journal: CredentialSwitchJournal;
  readonly gate: OfficialWorkGate;

  constructor(input: {
    accounts: SwitchingAccountRegistry;
    credentials: CodexCredentialFiles;
    runtime: SwitchingOfficialRuntime;
    journal: CredentialSwitchJournal;
    gate: OfficialWorkGate;
  }) {
    this.#accounts = input.accounts;
    this.#credentials = input.credentials;
    this.#runtime = input.runtime;
    this.#journal = input.journal;
    this.gate = input.gate;
  }

  async switch(accountId: string): Promise<void> {
    if (this.gate.phase === "ready" && this.#accounts.getCurrentAccountId() === accountId) return;
    let change = this.gate.beginChange();
    let stopping = false;
    let stopped = false;
    let committed = false;
    let commitAttempted = false;
    let source: SavedCodexAccount | null = null;
    let target: SavedCodexAccount | null = null;
    let original: NativeCodexCredentials | null = null;
    let installed = false;
    let sourceSaved = false;
    let prepared = false;
    try {
      source = this.#account(this.#accounts.getCurrentAccountId());
      target = this.#account(accountId);
      if (!target) throw new CodexAccountSwitchError("unknown-account");
      await this.#runtime.preflight();
      if (await this.#journal.read()) throw new CodexAccountSwitchError("recovery-required");
      const credential = await this.#credentials.load(target);
      this.#match(await this.#credentials.readCurrent(), source);
      await this.#runtime.assertNativeIdle();
      change.assertIdle();
      const record: CredentialSwitchRecord = {
        version: 1,
        transactionId: randomUUID(),
        operation: "switch",
        sourceAccountId: source?.accountId ?? null,
        targetAccountId: target.accountId,
        stage: "prepared",
      };
      // Mark before writing: a failed write can still have atomically installed the record.
      this.#credentials.assertOwnership();
      prepared = true;
      await this.#journal.write(record);
      change.assertIdle();
      stopping = true;
      await this.#runtime.stop();
      stopped = true;
      this.gate.retired();
      original = await this.#credentials.readCurrent();
      this.#match(original, source);
      if (source && original) await this.#credentials.save(source, original);
      sourceSaved = true;
      await this.#journal.write({ ...record, stage: "source-saved" });
      await this.#credentials.install(credential, original);
      installed = true;
      await this.#journal.write({ ...record, stage: "target-installed" });
      await this.#runtime.start();
      await this.#runtime.verify(target.identity);
      this.#match(await this.#credentials.readCurrent(), target);
      await this.#journal.write({ ...record, stage: "verified" });
      change.assertIdle();
      this.#credentials.assertOwnership();
      commitAttempted = true;
      await this.#accounts.setCurrentAccountId(target.accountId);
      committed = true;
      await this.#journal.clear();
      change.finish("ready");
    } catch (error) {
      if (committed || commitAttempted) {
        // Never roll back a durable successful commit just because journal cleanup failed.
        change.finish("unavailable");
        throw new CodexAccountSwitchError("recovery-required");
      }
      if (!stopped) {
        if (stopping) {
          change.finish("unavailable");
          throw new CodexAccountSwitchError("stop-unconfirmed");
        }
        try {
          if (prepared) await this.#journal.clear();
        } catch {
          change.finish("unavailable");
          throw new CodexAccountSwitchError("recovery-required");
        }
        change.finish(
          this.gate.phase === "unavailable" ||
            (error instanceof CodexAccountSwitchError && error.code === "recovery-required")
            ? "unavailable"
            : "ready",
        );
        if (error instanceof CodexAccountSwitchError || isStableAccountOperationError(error))
          throw error;
        throw new CodexAccountSwitchError("switch-failed");
      }
      try {
        if (this.gate.phase === "unavailable") {
          change.finish("unavailable");
          this.#credentials.assertOwnership();
          change = this.gate.beginChange(true);
        }
        // start/installation can throw after creating a writer or replacing the file.
        // Always stop and inspect native facts, not only the last returned operation.
        await this.#runtime.stop();
        const actual = await this.#credentials.readCurrent();
        if (target && this.#is(actual, target)) {
          if (!sourceSaved) throw new CodexAccountSwitchError("recovery-required");
          // Preserve target rotation even when verification failed.
          if (actual) await this.#credentials.save(target, actual);
          if (source) original = await this.#credentials.load(source);
          await this.#credentials.install(original, actual);
        } else {
          this.#match(actual, source);
          if (
            installed ||
            actual?.serializeForNativeStore() !== original?.serializeForNativeStore()
          ) {
            throw new CodexAccountSwitchError("recovery-required");
          }
          // Source snapshot persistence may have failed. Resume its authoritative native
          // file in place, never reinstall an older slot to make the rollback pass.
        }
        await this.#runtime.start();
        await this.#runtime.verify(source?.identity ?? null);
        this.#match(await this.#credentials.readCurrent(), source);
        await this.#journal.clear();
        change.finish("ready");
      } catch {
        change.finish("unavailable");
        throw new CodexAccountSwitchError("rollback-failed");
      }
      throw new CodexAccountSwitchError("switch-failed");
    }
  }

  /** Before user work after Host restart. Preflight may sequentially bootstrap native config. */
  async recover(): Promise<void> {
    const change = this.gate.beginChange(true);
    try {
      await this.#runtime.preflight();
      // A previous owner/process must have been reconciled by stop(), including orphans.
      await this.#runtime.stop();
      this.gate.retired();
      const record = await this.#journal.read();
      let current = this.#account(this.#accounts.getCurrentAccountId());
      const actual = await this.#credentials.readCurrent();
      if (!record) {
        this.#match(actual, current);
        if (current && actual) await this.#credentials.save(current, actual);
      } else if (record.operation === "login") {
        const source = this.#account(record.sourceAccountId);
        if ((current?.accountId ?? null) !== record.sourceAccountId)
          throw new CodexAccountSwitchError("recovery-required");
        if (this.#is(actual, source)) {
          if (source && actual) await this.#credentials.save(source, actual);
        } else if (actual === null) {
          await this.#credentials.install(
            source ? await this.#credentials.load(source) : null,
            null,
          );
        } else {
          await this.#runtime.start();
          await this.#runtime.verify(actual.identity);
          await this.#runtime.stop();
          this.gate.retired();
          const latest = await this.#credentials.readCurrent();
          if (!latest || !sameCodexCredentialIdentity(latest.identity, actual.identity))
            throw new CodexAccountSwitchError("recovery-required");
          const existing = this.#accounts
            .list()
            .find((candidate) => candidate.accountId === record.targetAccountId);
          if (existing && !sameCodexCredentialIdentity(existing.identity, latest.identity))
            throw new CodexAccountSwitchError("recovery-required");
          const target = await this.#accounts.saveVerifiedAccount({
            preferredAccountId: record.targetAccountId,
            identity: latest.identity,
            ...(latest.email ? { email: latest.email, label: latest.email } : {}),
            ...(latest.planType ? { planType: latest.planType } : {}),
          });
          await this.#credentials.save(target, latest);
          if (source) {
            await this.#credentials.install(await this.#credentials.load(source), latest);
          } else {
            await this.#accounts.setCurrentAccountId(target.accountId);
            current = target;
          }
        }
      } else {
        const source = this.#account(record.sourceAccountId);
        const target = this.#account(record.targetAccountId);
        if (!target) throw new CodexAccountSwitchError("recovery-required");
        if (current?.accountId === target.accountId) {
          if (record.stage !== "verified") throw new CodexAccountSwitchError("recovery-required");
          this.#match(actual, target);
          if (actual) await this.#credentials.save(target, actual);
        } else if ((current?.accountId ?? null) === record.sourceAccountId) {
          if (this.#is(actual, source)) {
            if (source && actual) await this.#credentials.save(source, actual);
          } else {
            this.#match(actual, target);
            if (record.stage === "prepared") throw new CodexAccountSwitchError("recovery-required");
            if (actual) await this.#credentials.save(target, actual);
            await this.#credentials.install(
              source ? await this.#credentials.load(source) : null,
              actual,
            );
          }
        } else {
          throw new CodexAccountSwitchError("recovery-required");
        }
      }
      await this.#runtime.start();
      await this.#runtime.verify(current?.identity ?? null);
      this.#match(await this.#credentials.readCurrent(), current);
      await this.#journal.clear();
      change.finish("ready");
    } catch {
      change.finish("unavailable");
      throw new CodexAccountSwitchError("recovery-required");
    }
  }

  #account(accountId: string | null): SavedCodexAccount | null {
    if (accountId === null) return null;
    const account = this.#accounts.list().find((a) => a.accountId === accountId);
    if (!account) throw new CodexAccountSwitchError("unknown-account");
    return account;
  }
  #is(credentials: NativeCodexCredentials | null, account: CredentialAccountRef | null): boolean {
    return account === null
      ? credentials === null
      : credentials !== null && sameCodexCredentialIdentity(credentials.identity, account.identity);
  }
  #match(credentials: NativeCodexCredentials | null, account: CredentialAccountRef | null): void {
    if (!this.#is(credentials, account)) throw new CodexAccountSwitchError("recovery-required");
  }
}
