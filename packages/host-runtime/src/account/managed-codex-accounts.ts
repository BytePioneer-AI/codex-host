import { randomUUID } from "node:crypto";

import type { JsonObject, JsonValue } from "@codexhost/protocol-core";
import type {
  CodexAccountListResult,
  CodexAccountLoginCompleted,
  CodexAccountLoginStartResult,
  CodexAccountSummary,
  CodexAccountUsageResult,
  AccountCreditsSnapshot,
} from "@codexhost/shared-contracts";
import type { OfficialWorkGate, OfficialChangeLease } from "../codex-runtime/official-work-gate.js";
import type { CodexCredentialFiles } from "./codex-credential-files.js";
import type {
  CredentialSwitchJournal,
  CredentialSwitchRecord,
} from "./credential-switch-journal.js";
import type { CodexAccountSwitcher } from "./codex-account-switcher.js";
import type { ManagedCodexAccountQuotas } from "./managed-codex-account-quotas.js";
import {
  sameCodexCredentialIdentity,
  type NativeCodexCredentials,
} from "./native-codex-credentials.js";
import type { OfficialAccountRuntime } from "./official-account-runtime.js";
import type { SavedCodexAccounts, SavedCodexAccount } from "./saved-codex-accounts.js";

export interface CodexAccountControl {
  snapshot(): CodexAccountListResult;
  currentAccountId(): string | null;
  switch(accountId: string): Promise<void>;
  remove(accountId: string): Promise<void>;
  startLogin(accountId?: string): Promise<CodexAccountLoginStartResult>;
  cancelLogin(loginId: string): Promise<boolean>;
  observe(value: JsonValue): void;
  subscribeLogin(listener: (value: CodexAccountLoginCompleted) => void): () => void;
  inspectInactiveUsage?(
    accountId: string,
    forceRefresh?: boolean,
  ): Promise<CodexAccountUsageResult>;
  recordUsage?(
    accountId: string,
    accountCredits: AccountCreditsSnapshot,
  ): Promise<CodexAccountUsageResult>;
  cachedUsage?(accountId: string): CodexAccountUsageResult | null;
}

type PendingLogin = {
  accountId: string;
  loginId: string;
  source: SavedCodexAccount | null;
  sourceCredential: NativeCodexCredentials | null;
  change: OfficialChangeLease;
  completing: boolean;
  timeout?: NodeJS.Timeout;
};

const record = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Shared Host account state. All mutations use the sole official owner. */
export class ManagedCodexAccounts implements CodexAccountControl {
  readonly #accounts: SavedCodexAccounts;
  readonly #credentials: CodexCredentialFiles;
  readonly #runtime: OfficialAccountRuntime;
  readonly #switcher: CodexAccountSwitcher;
  readonly #journal: CredentialSwitchJournal;
  readonly #gate: OfficialWorkGate;
  readonly #quotas: ManagedCodexAccountQuotas;
  readonly #loginListeners = new Set<(value: CodexAccountLoginCompleted) => void>();
  #login: PendingLogin | null = null;

  constructor(input: {
    accounts: SavedCodexAccounts;
    credentials: CodexCredentialFiles;
    runtime: OfficialAccountRuntime;
    switcher: CodexAccountSwitcher;
    journal: CredentialSwitchJournal;
    gate: OfficialWorkGate;
    quotas: ManagedCodexAccountQuotas;
  }) {
    this.#accounts = input.accounts;
    this.#credentials = input.credentials;
    this.#runtime = input.runtime;
    this.#switcher = input.switcher;
    this.#journal = input.journal;
    this.#gate = input.gate;
    this.#quotas = input.quotas;
  }

  async initialize(): Promise<void> {
    await this.#accounts.initialize();
    await this.#quotas.initialize(
      new Set(this.#accounts.list().map((account) => account.accountId)),
    );
    if (this.#accounts.list().length === 0) {
      const current = await this.#credentials.readCurrent();
      if (current) {
        await this.#runtime.preflight();
        await this.#runtime.start();
        try {
          await this.#runtime.verify(current.identity);
        } finally {
          await this.#runtime.stop();
        }
        const account = await this.#accounts.saveVerifiedAccount({
          identity: current.identity,
          ...(current.email ? { email: current.email, label: current.email } : {}),
          ...(current.planType ? { planType: current.planType } : {}),
        });
        await this.#credentials.save(account, current);
        await this.#accounts.setCurrentAccountId(account.accountId);
      }
    }
    await this.#switcher.recover();
  }

  snapshot(): CodexAccountListResult {
    return {
      version: 2,
      currentAccountId: this.#accounts.getCurrentAccountId(),
      phase: this.#gate.phase,
      revision: this.#gate.revision,
      capabilities: { manage: true, switch: true, login: true, delete: true },
      accounts: this.#accounts.list().map((account): CodexAccountSummary => ({
        accountId: account.accountId,
        label: account.label,
        ...(account.email ? { email: account.email } : {}),
        ...(account.planType ? { planType: account.planType } : {}),
      })),
    };
  }

  currentAccountId(): string | null {
    return this.#accounts.getCurrentAccountId();
  }
  switch(accountId: string): Promise<void> {
    return this.#switcher.switch(accountId);
  }

  async inspectInactiveUsage(
    accountId: string,
    forceRefresh = false,
  ): Promise<CodexAccountUsageResult> {
    const account = this.#accounts.list().find((candidate) => candidate.accountId === accountId);
    if (!account) throw new Error("Unknown Codex Account");
    if (accountId === this.#accounts.getCurrentAccountId()) {
      throw new Error("Current Codex Account quota must use the official backend");
    }
    return this.#quotas.inspect(account, forceRefresh);
  }

  recordUsage(
    accountId: string,
    accountCredits: AccountCreditsSnapshot,
  ): Promise<CodexAccountUsageResult> {
    if (!this.#accounts.list().some((candidate) => candidate.accountId === accountId)) {
      return Promise.reject(new Error("Unknown Codex Account"));
    }
    return this.#quotas.record(accountId, accountCredits);
  }

  cachedUsage(accountId: string): CodexAccountUsageResult | null {
    return this.#quotas.get(accountId);
  }

  async remove(accountId: string): Promise<void> {
    const change = this.#gate.beginChange();
    try {
      const account = this.#accounts.list().find((candidate) => candidate.accountId === accountId);
      if (!account) throw new Error("Unknown Codex Account");
      if (accountId === this.#accounts.getCurrentAccountId()) {
        throw new Error("Current Codex Account cannot be deleted");
      }
      change.assertIdle();
      await this.#credentials.remove(account);
      await this.#accounts.remove(accountId);
      await this.#quotas.remove(accountId);
    } finally {
      change.finish("ready");
    }
  }

  async startLogin(accountId?: string): Promise<CodexAccountLoginStartResult> {
    if (this.#login) throw new Error("Codex Account sign-in is already in progress");
    const requested = accountId
      ? this.#accounts.list().find((candidate) => candidate.accountId === accountId)
      : undefined;
    if (accountId && !requested) throw new Error("Unknown Codex Account");
    const pendingAccountId = requested?.accountId ?? randomUUID();
    const change = this.#gate.beginChange();
    let source: SavedCodexAccount | null = null;
    let sourceCredential: NativeCodexCredentials | null = null;
    let stopped = false;
    try {
      await this.#runtime.preflight();
      await this.#runtime.assertNativeIdle();
      change.assertIdle();
      source =
        this.#accounts
          .list()
          .find((candidate) => candidate.accountId === this.#accounts.getCurrentAccountId()) ??
        null;
      const transaction: CredentialSwitchRecord = {
        version: 1,
        transactionId: randomUUID(),
        operation: "login",
        sourceAccountId: source?.accountId ?? null,
        targetAccountId: pendingAccountId,
        stage: "prepared",
      };
      await this.#journal.write(transaction);
      await this.#runtime.stop();
      stopped = true;
      this.#gate.retired();
      sourceCredential = await this.#credentials.readCurrent();
      if (
        (source === null) !== (sourceCredential === null) ||
        (source &&
          sourceCredential &&
          !sameCodexCredentialIdentity(source.identity, sourceCredential.identity))
      )
        throw new Error("Current Codex Account identity is inconsistent");
      if (source && sourceCredential) await this.#credentials.save(source, sourceCredential);
      await this.#journal.write({ ...transaction, stage: "source-saved" });
      await this.#credentials.install(null, sourceCredential);
      await this.#journal.write({ ...transaction, stage: "target-installed" });
      await this.#runtime.start();
      const response = await this.#runtime.controlRequest("account/login/start", {
        type: "chatgptDeviceCode",
      });
      const result = record(response.result) ? response.result : null;
      if (
        !result ||
        result.type !== "chatgptDeviceCode" ||
        typeof result.loginId !== "string" ||
        typeof result.verificationUrl !== "string" ||
        typeof result.userCode !== "string"
      )
        throw new Error("Codex Account sign-in is unsupported");
      const pending: PendingLogin = {
        accountId: pendingAccountId,
        loginId: result.loginId,
        source,
        sourceCredential,
        change,
        completing: false,
      };
      pending.timeout = setTimeout(() => {
        if (this.#login !== pending || pending.completing) return;
        pending.completing = true;
        void this.#completeLogin(pending, false);
      }, 10 * 60_000);
      pending.timeout.unref();
      this.#login = pending;
      return {
        accountId: pendingAccountId,
        loginId: result.loginId,
        verificationUrl: result.verificationUrl,
        userCode: result.userCode,
      };
    } catch {
      if (!stopped) {
        change.finish(this.#gate.phase === "unavailable" ? "unavailable" : "ready");
      } else {
        await this.#restoreLoginSource({
          accountId: accountId ?? randomUUID(),
          loginId: "failed",
          source,
          sourceCredential,
          change,
          completing: true,
        })
          .then(() => this.#journal.clear())
          .catch(() => change.finish("unavailable"));
      }
      throw new Error("Codex Account sign-in failed");
    }
  }

  async cancelLogin(loginId: string): Promise<boolean> {
    const pending = this.#login;
    if (!pending || pending.loginId !== loginId) return false;
    if (pending.completing) return true;
    pending.completing = true;
    try {
      await this.#runtime.controlRequest("account/login/cancel", { loginId });
    } catch {
      // Stop and restore from native facts even if cancellation acknowledgement was lost.
    }
    await this.#completeLogin(pending, false);
    return true;
  }

  observe(value: JsonValue): void {
    if (!record(value) || value.method !== "account/login/completed" || !record(value.params))
      return;
    const loginId = value.params.loginId;
    const success = value.params.success;
    const pending = this.#login;
    if (
      !pending ||
      pending.loginId !== loginId ||
      typeof success !== "boolean" ||
      pending.completing
    )
      return;
    pending.completing = true;
    void this.#completeLogin(pending, success);
  }

  subscribeLogin(listener: (value: CodexAccountLoginCompleted) => void): () => void {
    this.#loginListeners.add(listener);
    return () => this.#loginListeners.delete(listener);
  }

  async #completeLogin(pending: PendingLogin, success: boolean): Promise<void> {
    if (pending.timeout) clearTimeout(pending.timeout);
    let completed = false;
    try {
      if (!success) throw new Error("Native sign-in failed");
      await this.#runtime.stop();
      this.#gate.retired();
      const candidate = await this.#credentials.readCurrent();
      if (!candidate) throw new Error("Native sign-in produced no credentials");
      await this.#runtime.start();
      await this.#runtime.verify(candidate.identity);
      await this.#runtime.stop();
      this.#gate.retired();
      const latest = await this.#credentials.readCurrent();
      if (!latest || !sameCodexCredentialIdentity(candidate.identity, latest.identity))
        throw new Error("Native sign-in credentials are unavailable");
      const requested = this.#accounts
        .list()
        .find((candidate) => candidate.accountId === pending.accountId);
      if (requested && !sameCodexCredentialIdentity(requested.identity, latest.identity))
        throw new Error("Native sign-in identity does not match the requested Account");
      const account = await this.#accounts.saveVerifiedAccount({
        preferredAccountId: pending.accountId,
        identity: latest.identity,
        ...(latest.email ? { email: latest.email, label: latest.email } : {}),
        ...(latest.planType ? { planType: latest.planType } : {}),
      });
      await this.#credentials.save(account, latest);
      const source = pending.source;
      const keepSignedIn = source === null || source.accountId === account.accountId;
      if (keepSignedIn) {
        await this.#runtime.start();
        await this.#runtime.verify(latest.identity);
        await this.#accounts.setCurrentAccountId(account.accountId);
      } else {
        await this.#credentials.install(pending.sourceCredential, latest);
        await this.#runtime.start();
        if (!source) throw new Error("Codex Account source is unavailable");
        await this.#runtime.verify(source.identity);
      }
      await this.#journal.clear();
      pending.change.finish("ready");
      this.#emitLogin({
        accountId: account.accountId,
        loginId: pending.loginId,
        success: true,
        error: null,
      });
      completed = true;
    } catch {
      try {
        await this.#restoreLoginSource(pending);
        await this.#journal.clear();
        this.#emitLogin({
          accountId: pending.accountId,
          loginId: pending.loginId,
          success: false,
          error: "Codex Account sign-in failed",
        });
        completed = true;
      } catch {
        pending.change.finish("unavailable");
        this.#emitLogin({
          accountId: pending.accountId,
          loginId: pending.loginId,
          success: false,
          error: "Codex Account recovery failed",
        });
      }
    } finally {
      if (this.#login === pending) this.#login = null;
      if (!completed && this.#gate.phase === "changing") pending.change.finish("unavailable");
    }
  }

  async #restoreLoginSource(pending: PendingLogin): Promise<void> {
    await this.#runtime.stop();
    this.#gate.retired();
    const actual = await this.#credentials.readCurrent();
    await this.#credentials.install(pending.sourceCredential, actual);
    await this.#runtime.start();
    await this.#runtime.verify(pending.source?.identity ?? null);
    pending.change.finish("ready");
  }

  #emitLogin(value: CodexAccountLoginCompleted): void {
    for (const listener of this.#loginListeners) {
      try {
        listener(value);
      } catch {
        // One Desktop connection cannot affect transaction ownership.
      }
    }
  }
}

export class UnavailableCodexAccounts implements CodexAccountControl {
  constructor(
    private readonly reason: CodexAccountListResult["capabilities"]["reason"] = "recovery-required",
    private readonly state: () => Pick<CodexAccountListResult, "phase" | "revision"> = () => ({
      phase: "unavailable",
      revision: 0,
    }),
  ) {}
  snapshot(): CodexAccountListResult {
    const state = this.state();
    return {
      version: 2,
      currentAccountId: null,
      phase: state.phase,
      revision: state.revision,
      capabilities: {
        manage: false,
        switch: false,
        login: false,
        delete: false,
        reason: this.reason,
      },
      accounts: [],
    };
  }
  currentAccountId(): null {
    return null;
  }
  switch(): Promise<void> {
    return Promise.reject(
      Object.assign(new Error("Codex Account is unavailable"), { code: "unavailable" }),
    );
  }
  remove(): Promise<void> {
    return Promise.reject(
      Object.assign(new Error("Codex Account is unavailable"), { code: "unavailable" }),
    );
  }
  startLogin(): Promise<CodexAccountLoginStartResult> {
    return Promise.reject(
      Object.assign(new Error("Codex Account is unavailable"), { code: "unavailable" }),
    );
  }
  cancelLogin(): Promise<boolean> {
    return Promise.reject(
      Object.assign(new Error("Codex Account is unavailable"), { code: "unavailable" }),
    );
  }
  observe(): void {}
  subscribeLogin(): () => void {
    return () => undefined;
  }
}

export class SingleNativeCodexAccount implements CodexAccountControl {
  constructor(private readonly summary: () => CodexAccountListResult) {}
  snapshot(): CodexAccountListResult {
    return this.summary();
  }
  currentAccountId(): string | null {
    return this.summary().currentAccountId;
  }
  switch(): Promise<void> {
    return Promise.reject(new Error("SSH Host Account switching is unsupported"));
  }
  remove(): Promise<void> {
    return Promise.reject(new Error("SSH Host Account management is unsupported"));
  }
  startLogin(): Promise<CodexAccountLoginStartResult> {
    return Promise.reject(new Error("SSH Host Account management is unsupported"));
  }
  cancelLogin(): Promise<boolean> {
    return Promise.reject(new Error("SSH Host Account management is unsupported"));
  }
  observe(): void {}
  subscribeLogin(): () => void {
    return () => undefined;
  }
}
