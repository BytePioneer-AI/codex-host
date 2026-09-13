import { randomUUID } from "node:crypto";
import type { JsonObject, JsonValue } from "@codexhost/protocol-core";
import {
  codexAccountLoginStartResultSchema,
  jsonObjectSchema,
  type AccountCreditsSnapshot,
  type CodexAccountListResult,
  type CodexAccountLoginCompleted,
  type CodexAccountLoginStartResult,
  type CodexAccountUsageResult,
} from "@codexhost/shared-contracts";
import {
  OfficialAdmissionError,
  type OfficialChangeLease,
} from "../codex-runtime/official-work-gate.js";
import type { CodexAccountControl } from "./codex-account-control.js";
import type { NativeAccountRuntime } from "./native-account-runtime.js";
import {
  type NativeAccountStore,
  matchProfile,
  newProfile,
  type NativeLoginStage,
} from "./native-account-store.js";
import { NativeAccountQuotas } from "./native-account-quotas.js";
import { NativeProfileTransaction, NativeTransitionError } from "./native-profile-transaction.js";
import {
  NativeAccountError,
  profileCurrent,
  type NativeProfileVault,
} from "./native-profile-vault.js";
import { sameCodexCredentialIdentity } from "./native-codex-credentials.js";
import {
  nativeChatgptLoginParamsSchema,
  nativeChatgptLoginResponseSchema,
  type NativeChatgptLogin,
  type NativeChatgptLoginCompleted,
  type NativeChatgptLoginParams,
} from "./native-chatgpt-login.js";

interface PendingLogin {
  stage: NativeLoginStage;
  accountId: string;
  change: OfficialChangeLease;
  cancelled: boolean;
  saved: boolean;
  settling?: Promise<void>;
  timeout?: ReturnType<typeof setTimeout>;
  early: JsonObject[];
  starting: Promise<void>;
  finishStart(): void;
  acceptingEvents: boolean;
  completion: PromiseWithResolvers<NativeChatgptLoginCompleted>;
  onboardingEntrypoint: NativeChatgptLoginCompleted["onboardingEntrypoint"];
}
const object = (value: JsonValue | undefined): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Global Account Module. Login and switching share the same Vault transaction and recovery. */
export class NativeCodexAccounts implements CodexAccountControl {
  readonly #store: NativeAccountStore;
  readonly #runtime: NativeAccountRuntime;
  readonly #transaction: NativeProfileTransaction;
  readonly #quotas: NativeAccountQuotas;
  readonly #instanceId = randomUUID();
  readonly #listeners = new Set<(value: CodexAccountLoginCompleted) => void>();
  readonly #unsubscribe: () => void;
  #lastVault: NativeProfileVault;
  #pending:
    | (NonNullable<CodexAccountListResult["pendingOperation"]> & {
        lease?: OfficialChangeLease;
        cancelStarting?: () => Promise<boolean>;
      })
    | undefined;
  #login: PendingLogin | undefined;
  #cleanupRequired = false;

  constructor(input: {
    store: NativeAccountStore;
    runtime: NativeAccountRuntime;
    fetch?: typeof fetch;
  }) {
    this.#store = input.store;
    this.#runtime = input.runtime;
    this.#lastVault = input.store.vault;
    this.#transaction = new NativeProfileTransaction(input.store, input.runtime);
    this.#quotas = new NativeAccountQuotas({
      files: input.store.files,
      directory: input.store.directory,
      credentials: input.store,
      ...(input.fetch ? { fetch: input.fetch } : {}),
      admitCredentialRefresh: (accountId) => {
        const release = this.#runtime.gate.admit();
        if (accountId === this.currentAccountId()) {
          release();
          throw new NativeAccountError("credential-conflict");
        }
        return release;
      },
    });
    this.#unsubscribe = input.runtime.subscribe((value) => this.observe(value));
  }
  snapshot(): CodexAccountListResult {
    try {
      this.#lastVault = this.#store.vault;
    } catch {
      /* Keep nonsecret committed metadata visible on lease loss. */
    }
    const phase = this.#runtime.gate.phase;
    return {
      version: 2,
      instanceId: this.#instanceId,
      currentAccountId: this.#lastVault.currentAccountId,
      phase,
      revision: this.#runtime.gate.revision + this.#lastVault.revision,
      cleanupRequired: this.#cleanupRequired,
      ...(this.#lastVault.legacyRegistryDigest ? { legacyHistoryPreserved: true } : {}),
      ...(this.#pending
        ? { pendingOperation: { operationId: this.#pending.operationId, kind: this.#pending.kind } }
        : {}),
      capabilities: {
        manage: true,
        switch: phase === "ready",
        login: phase === "ready",
        delete: phase === "ready",
        recover: phase === "unavailable",
        logout: phase === "ready",
        ...(phase === "unavailable" ? { reason: "recovery-required" as const } : {}),
      },
      accounts: this.#lastVault.accounts.map(({ accountId, label, email, planType }) => ({
        accountId,
        label,
        ...(email ? { email } : {}),
        ...(planType ? { planType } : {}),
      })),
    };
  }
  currentAccountId(): string | null {
    return this.snapshot().currentAccountId;
  }

  async initialize(): Promise<void> {
    await this.recover();
    await this.#quotas
      .initialize(new Set(this.#store.vault.accounts.map((a) => a.accountId)))
      .catch(() => undefined);
  }
  async recover(): Promise<void> {
    if (this.#login) await this.cancelLogin(this.#login.stage.operationId);
    const change = await this.#begin("recovery", true);
    try {
      // Never import first. An unfinished first activation must be interpreted by its Journal.
      await this.#transaction.recover();
      const stage = await this.#store.readStage();
      if (stage) {
        if (stage.candidate) await this.#applyVerifiedStage(stage);
        else await this.#store.clearStage(stage);
      }
      const known = await this.#store.reload();
      // Unknown identity is not a reason to start a writer which could refresh it.
      const observed = await this.#store.readCredentials();
      if (known.accounts.length || known.revision !== 0)
        matchProfile(observed, profileCurrent(known));
      await this.#runtime.preflight();
      await this.#runtime.stop();
      const actual = await this.#store.readCredentials();
      const before = await this.#store.reload();
      if (!before.accounts.length && before.revision === 0 && actual) {
        await this.#runtime.start();
        await this.#runtime.verify(actual.identity);
        await this.#runtime.stop();
        const latest = await this.#store.readCredentials();
        if (!latest || !sameCodexCredentialIdentity(latest.identity, actual.identity))
          throw new NativeAccountError("credential-conflict");
        const account = newProfile(latest),
          next = structuredClone(before);
        next.accounts.push(account);
        next.currentAccountId = account.accountId;
        next.revision++;
        next.lastOperationId = randomUUID();
        await this.#store.replaceVault(next, before);
      } else matchProfile(actual, profileCurrent(before));
      await this.#resumePermanent();
      this.#cleanupRequired = false;
      if (!this.#finish(change, true)) throw new NativeAccountError("recovery-required");
    } catch (error) {
      this.#cleanupRequired = true;
      this.#finish(change, false);
      const code =
        typeof error === "object" && error !== null && "code" in error ? error.code : null;
      if (code === "unsupported-storage" || code === "unsupported-version")
        throw new NativeAccountError(code);
      throw new NativeAccountError("recovery-required");
    }
  }
  async switch(accountId: string): Promise<void> {
    if (this.#runtime.gate.phase === "ready" && this.currentAccountId() === accountId) return;
    await this.#changeCredential(accountId, "switch");
  }
  async logout(): Promise<void> {
    if (this.#runtime.gate.phase === "ready" && this.currentAccountId() === null) return;
    await this.#changeCredential(null, "logout");
  }
  async #changeCredential(accountId: string | null, kind: "switch" | "logout"): Promise<void> {
    const operationId = randomUUID();
    const change = await this.#begin(kind, false, operationId, {
      drainQuotaReads: kind === "switch",
    });
    try {
      await this.#transaction.execute(accountId, undefined, operationId);
      if (!this.#finish(change, true)) throw new NativeTransitionError("recovery-required", false);
    } catch (error) {
      const ready = error instanceof NativeTransitionError && error.ready;
      this.#cleanupRequired = !ready;
      this.#finish(change, ready);
      throw error;
    }
  }
  async remove(accountId: string): Promise<void> {
    const before = this.#store.vault;
    const change = await this.#begin("switch");
    try {
      await this.#store.mutate((next) => {
        if (next.currentAccountId === accountId)
          throw new NativeAccountError("credential-conflict");
        if (!next.accounts.some((a) => a.accountId === accountId))
          throw new NativeAccountError("unknown-account");
        next.accounts = next.accounts.filter((a) => a.accountId !== accountId);
      });
      await this.#quotas.remove(accountId);
      if (!this.#finish(change, true)) throw new NativeAccountError("recovery-required");
    } catch (error) {
      const actual = await this.#store.reload().catch(() => null);
      if (
        actual &&
        before.currentAccountId !== accountId &&
        before.accounts.some((a) => a.accountId === accountId) &&
        !actual.accounts.some((a) => a.accountId === accountId)
      ) {
        await this.#quotas.remove(accountId);
        if (this.#finish(change, true)) return;
      }
      this.#finish(
        change,
        error instanceof NativeAccountError &&
          ["credential-conflict", "unknown-account"].includes(error.code),
      );
      throw new NativeAccountError("credential-conflict");
    }
  }

  async startLogin(accountId?: string): Promise<CodexAccountLoginStartResult> {
    const started = await this.#startLogin({ type: "chatgptDeviceCode" }, accountId, false);
    if (started.response.type !== "chatgptDeviceCode")
      throw new NativeAccountError("authentication-failed");
    return codexAccountLoginStartResultSchema.parse({
      accountId: started.accountId,
      loginId: started.response.loginId,
      verificationUrl: started.response.verificationUrl,
      userCode: started.response.userCode,
    });
  }

  async startNativeLogin(params: NativeChatgptLoginParams): Promise<NativeChatgptLogin> {
    return this.#startLogin(nativeChatgptLoginParamsSchema.parse(params), undefined, true);
  }

  async #startLogin(
    params: NativeChatgptLoginParams,
    accountId: string | undefined,
    activateOnSuccess: boolean,
  ): Promise<NativeChatgptLogin & { accountId: string }> {
    const operationId = randomUUID();
    const starting = Promise.withResolvers<undefined>();
    let cancelledBeforeStage = false;
    let pending: PendingLogin | undefined;
    const change = await this.#begin("login", false, operationId, {
      cancelStarting: async () => {
        cancelledBeforeStage = true;
        await starting.promise;
        return this.#login?.stage.operationId === operationId
          ? this.cancelLogin(operationId)
          : true;
      },
    });
    const assertNotCancelled = () => {
      if (cancelledBeforeStage || pending?.cancelled)
        throw new NativeAccountError("authentication-failed");
    };
    let stopping = false;
    try {
      if (accountId && !this.#store.vault.accounts.some((a) => a.accountId === accountId))
        throw new NativeAccountError("unknown-account");
      if ((await this.#store.readStage()) || (await this.#store.readJournal()))
        throw new NativeAccountError("recovery-required");
      assertNotCancelled();
      await this.#runtime.preflight();
      await this.#runtime.assertNativeIdle();
      change.assertIdle();
      assertNotCancelled();
      stopping = true;
      await this.#runtime.stop();
      matchProfile(await this.#store.readCredentials(), profileCurrent(this.#store.vault));
      assertNotCancelled();
      const stage = await this.#store.createStage(accountId, operationId, { activateOnSuccess });
      pending = {
        stage,
        accountId: accountId ?? randomUUID(),
        change,
        cancelled: false,
        saved: false,
        early: [],
        starting: starting.promise,
        finishStart: () => starting.resolve(undefined),
        acceptingEvents: false,
        completion: Promise.withResolvers<NativeChatgptLoginCompleted>(),
        onboardingEntrypoint: null,
      };
      this.#login = pending;
      this.#pending = { operationId: stage.operationId, kind: "login", lease: change };
      assertNotCancelled();
      await this.#runtime.start(this.#store.stageHome(stage));
      assertNotCancelled();
      const requestParams = jsonObjectSchema.parse(
        Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined)),
      );
      const response = await this.#runtime.controlRequest("account/login/start", requestParams);
      const native = nativeChatgptLoginResponseSchema.parse(response.result);
      if (response.error || native.type !== params.type)
        throw new NativeAccountError("authentication-failed");
      stage.nativeLoginId = native.loginId;
      await this.#store.writeStage(stage);
      pending.finishStart();
      if (pending.cancelled) throw new NativeAccountError("authentication-failed");
      pending.acceptingEvents = true;
      pending.timeout = setTimeout(
        () => {
          void this.cancelLogin(stage.operationId).catch(() => undefined);
        },
        Math.max(1, stage.expiresAt - Date.now()),
      );
      pending.timeout.unref();
      // Native completion can precede its start response. Buffer by this operation, not globally.
      for (const value of pending.early.splice(0)) this.observe(value);
      return {
        accountId: pending.accountId,
        response: { ...native, loginId: stage.operationId },
        completed: pending.completion.promise,
      };
    } catch (error) {
      pending?.finishStart();
      if (pending && this.#login !== pending) throw new NativeAccountError("authentication-failed");
      if (pending) await this.#settle(pending, false);
      else if (!stopping) this.#finish(change, this.#runtime.gate.phase !== "unavailable");
      else {
        try {
          await this.#runtime.stop();
          const stage = await this.#store.readStage();
          if (stage) await this.#store.clearStage(stage);
          await this.#resumePermanent();
          this.#finish(change, true);
        } catch {
          this.#cleanupRequired = true;
          this.#finish(change, false);
        }
      }
      if (!stopping && error instanceof OfficialAdmissionError) throw error;
      if (!stopping && error instanceof NativeAccountError && error.code === "unknown-account")
        throw error;
      throw new NativeAccountError("authentication-failed");
    } finally {
      starting.resolve(undefined);
    }
  }
  async cancelLogin(loginId: string): Promise<boolean> {
    const pending = this.#login;
    if (!pending)
      return this.#pending?.kind === "login" && this.#pending.operationId === loginId
        ? (this.#pending.cancelStarting?.() ?? false)
        : false;
    if (pending.stage.operationId !== loginId) return false;
    pending.cancelled = true;
    if (!pending.settling && pending.stage.nativeLoginId) {
      await this.#runtime
        .controlRequest("account/login/cancel", { loginId: pending.stage.nativeLoginId })
        .catch(() => undefined);
    }
    await this.#settle(pending, false);
    return !pending.saved;
  }
  observe(value: JsonValue): void {
    if (!object(value) || value.method !== "account/login/completed" || !object(value.params))
      return;
    const pending = this.#login;
    if (!pending || pending.settling || typeof value.params.success !== "boolean") return;
    if (!pending.acceptingEvents) {
      if (pending.early.length < 32) pending.early.push(value);
      return;
    }
    if (value.params.loginId !== pending.stage.nativeLoginId) return;
    pending.onboardingEntrypoint =
      value.params.onboardingEntrypoint === "life_sciences" ? "life_sciences" : null;
    void this.#settle(pending, value.params.success);
  }
  #settle(pending: PendingLogin, success: boolean): Promise<void> {
    return (pending.settling ??= pending.starting.then(() =>
      this.#completeLogin(pending, success),
    ));
  }
  async #completeLogin(pending: PendingLogin, success: boolean): Promise<void> {
    if (pending.timeout) clearTimeout(pending.timeout);
    let ready = false,
      completed = false;
    try {
      if (success && !pending.cancelled) {
        const candidate = await this.#store.readCredentials(this.#store.stageHome(pending.stage));
        if (!candidate) throw new NativeAccountError("authentication-failed");
        const accounts = this.#store.vault.accounts;
        const requested = accounts.find((a) => a.accountId === pending.stage.requestedAccountId);
        if (requested) matchProfile(candidate, requested);
        await this.#runtime.verify(candidate.identity);
        await this.#runtime.stop();
        const latest = await this.#store.readCredentials(this.#store.stageHome(pending.stage));
        if (!latest || !sameCodexCredentialIdentity(latest.identity, candidate.identity))
          throw new NativeAccountError("credential-conflict");
        if (!pending.cancelled) {
          const existing = accounts.find((a) =>
            sameCodexCredentialIdentity(a.identity, latest.identity),
          );
          const account = newProfile(latest, existing?.accountId ?? pending.accountId);
          account.payload = this.#store.snapshotCredential(account, latest);
          pending.stage.candidate = account;
          pending.accountId = account.accountId;
          await this.#store.writeStage(pending.stage);
          await this.#applyVerifiedStage(pending.stage);
          pending.saved = true;
          completed = true;
        }
      }
      await this.#runtime.stop();
      await this.#store.clearStage(pending.stage);
      await this.#resumePermanent();
      ready = true;
    } catch (error) {
      // Do not reinstall any snapshot of A: staging never changed its native credential.
      // Journal/commit receipts decide whether the new grant is already saved.
      const vault = await this.#store.reload().catch(() => null);
      pending.saved =
        vault?.lastOperationId === pending.stage.operationId ||
        (pending.stage.candidate !== undefined &&
          vault?.accounts.some(
            (a) =>
              a.accountId === pending.stage.candidate?.accountId &&
              a.payload?.digest === pending.stage.candidate?.payload?.digest,
          ) === true);
      if (!pending.stage.candidate && !(await this.#store.readJournal().catch(() => true))) {
        try {
          await this.#runtime.stop();
          await this.#store.clearStage(pending.stage);
          await this.#resumePermanent();
          ready = true;
        } catch {
          /* Retain recovery facts and keep only Codex unavailable. */
        }
      } else if (
        error instanceof NativeTransitionError &&
        error.ready &&
        !(await this.#store.readStage().catch(() => true))
      )
        ready = true;
    } finally {
      this.#cleanupRequired = !ready;
      if (this.#login === pending) this.#login = undefined;
      ready = this.#finish(pending.change, ready);
      const result: CodexAccountLoginCompleted = {
        accountId: pending.accountId,
        loginId: pending.stage.operationId,
        success: completed,
        saved: pending.saved,
        cleanupRequired: !ready,
        error: completed
          ? null
          : pending.saved
            ? "Codex Account saved; recovery is required"
            : "Codex Account sign-in did not complete",
      };
      const nativeSuccess = completed && ready && this.currentAccountId() === pending.accountId;
      pending.completion.resolve({
        loginId: pending.stage.operationId,
        success: nativeSuccess,
        error: nativeSuccess ? null : (result.error ?? "Codex Account recovery is required"),
        onboardingEntrypoint: pending.onboardingEntrypoint,
      });
      for (const listener of this.#listeners) {
        try {
          listener(result);
        } catch {
          /* Consumer isolation. */
        }
      }
    }
  }
  async #applyVerifiedStage(stage: NativeLoginStage): Promise<void> {
    const candidate = stage.candidate;
    if (!candidate) throw new NativeAccountError("recovery-required");
    const before = await this.#store.reload();
    if (before.lastOperationId !== stage.operationId) {
      if (before.currentAccountId !== stage.sourceAccountId)
        throw new NativeAccountError("recovery-required");
      const existing = before.accounts.find((a) => a.accountId === candidate.accountId);
      if (existing && !sameCodexCredentialIdentity(existing.identity, candidate.identity))
        throw new NativeAccountError("credential-conflict");
      if (candidate.accountId === before.currentAccountId) {
        await this.#transaction.execute(
          candidate.accountId,
          this.#store.restoreCredential(candidate),
          stage.operationId,
        );
      } else {
        const next = structuredClone(before);
        next.accounts = next.accounts.filter((a) => a.accountId !== candidate.accountId);
        next.accounts.push(candidate);
        next.revision++;
        next.lastOperationId = stage.operationId;
        await this.#store.replaceVault(next, before);
      }
    }
    if (
      this.#store.vault.currentAccountId !== candidate.accountId &&
      (stage.activateOnSuccess === true ||
        (stage.sourceAccountId === null && this.#store.vault.currentAccountId === null))
    )
      await this.#transaction.execute(candidate.accountId, undefined, stage.operationId);
    await this.#store.clearStage(stage);
  }
  async #resumePermanent(): Promise<void> {
    matchProfile(await this.#store.readCredentials(), profileCurrent(this.#store.vault));
    await this.#runtime.start();
    await this.#runtime.verify(profileCurrent(this.#store.vault)?.identity ?? null);
  }
  async #begin(
    kind: NonNullable<CodexAccountListResult["pendingOperation"]>["kind"],
    recovery = false,
    operationId: string = randomUUID(),
    options: { cancelStarting?: () => Promise<boolean>; drainQuotaReads?: boolean } = {},
  ): Promise<OfficialChangeLease> {
    if (this.#pending) throw new OfficialAdmissionError("changing");
    const { cancelStarting } = options;
    this.#pending = { operationId, kind, ...(cancelStarting ? { cancelStarting } : {}) };
    try {
      const lease = options.drainQuotaReads
        ? await this.#runtime.gate.beginChangeAfterQuotaReads()
        : this.#runtime.gate.beginChange(recovery);
      this.#pending.lease = lease;
      return lease;
    } catch (error) {
      this.#pending = undefined;
      throw error;
    }
  }
  #finish(change: OfficialChangeLease, ready: boolean): boolean {
    if (this.#pending?.lease !== change) return this.#runtime.gate.phase === "ready";
    this.#pending = undefined;
    if (ready) {
      try {
        this.#store.assertOwnership();
      } catch {
        ready = false;
      }
    }
    try {
      if (ready && this.#runtime.gate.phase === "unavailable") {
        change.finish("unavailable");
        this.#runtime.gate.beginChange(true).finish("ready");
      } else change.finish(ready ? "ready" : "unavailable");
    } catch {
      this.#cleanupRequired = true;
      change.finish("unavailable");
      this.#runtime.gate.unavailable();
    }
    return this.#runtime.gate.phase === "ready";
  }
  subscribeLogin(listener: (value: CodexAccountLoginCompleted) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
  async inspectInactiveUsage(accountId: string, refresh = false): Promise<CodexAccountUsageResult> {
    const account = this.#store.vault.accounts.find((a) => a.accountId === accountId);
    if (!account || accountId === this.currentAccountId())
      throw new NativeAccountError("unknown-account");
    return this.#quotas.inspect(account, refresh);
  }
  recordUsage(
    accountId: string,
    credits: AccountCreditsSnapshot,
  ): Promise<CodexAccountUsageResult> {
    return this.#quotas.record(accountId, credits);
  }
  cachedUsage(accountId: string): CodexAccountUsageResult | null {
    return this.#quotas.get(accountId);
  }
  async close(): Promise<void> {
    const operationId =
      this.#login?.stage.operationId ??
      (this.#pending?.kind === "login" ? this.#pending.operationId : undefined);
    if (operationId) await this.cancelLogin(operationId);
    this.#unsubscribe();
  }
}
