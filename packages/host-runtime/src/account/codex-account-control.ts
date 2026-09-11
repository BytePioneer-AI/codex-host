import type { JsonValue } from "@codexhost/protocol-core";
import type {
  AccountCreditsSnapshot,
  CodexAccountListResult,
  CodexAccountLoginCompleted,
  CodexAccountLoginStartResult,
  CodexAccountUsageResult,
} from "@codexhost/shared-contracts";

/** Global Codex Account control plane. Credentials never cross this boundary. */
export interface CodexAccountControl {
  snapshot(): CodexAccountListResult;
  currentAccountId(): string | null;
  switch(accountId: string): Promise<void>;
  remove(accountId: string): Promise<void>;
  startLogin(accountId?: string): Promise<CodexAccountLoginStartResult>;
  cancelLogin(loginId: string): Promise<boolean>;
  logout(): Promise<void>;
  recover(): Promise<void>;
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

export type UnavailableCodexAccountReason = NonNullable<
  CodexAccountListResult["capabilities"]["reason"]
>;

function unavailable(): Promise<never> {
  return Promise.reject(
    Object.assign(new Error("Codex Account management is unavailable"), {
      code: "unavailable",
    }),
  );
}

export class UnavailableCodexAccounts implements CodexAccountControl {
  constructor(
    private readonly reason: UnavailableCodexAccountReason = "recovery-required",
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
        // This static fallback cannot retry initialization; a live manager exposes recovery.
        recover: false,
        logout: false,
        reason: this.reason,
      },
      accounts: [],
    };
  }

  currentAccountId(): null {
    return null;
  }
  switch(): Promise<void> {
    return unavailable();
  }
  remove(): Promise<void> {
    return unavailable();
  }
  startLogin(): Promise<CodexAccountLoginStartResult> {
    return unavailable();
  }
  cancelLogin(): Promise<boolean> {
    return unavailable();
  }
  logout(): Promise<void> {
    return unavailable();
  }
  recover(): Promise<void> {
    return unavailable();
  }
  observe(): void {}
  subscribeLogin(): () => void {
    return () => undefined;
  }
}

/** Read-only projection used when native Codex owns authentication itself. */
export class SingleNativeCodexAccount implements CodexAccountControl {
  constructor(private readonly summary: () => CodexAccountListResult) {}

  snapshot(): CodexAccountListResult {
    return this.summary();
  }
  currentAccountId(): string | null {
    return this.summary().currentAccountId;
  }
  switch(): Promise<void> {
    return unavailable();
  }
  remove(): Promise<void> {
    return unavailable();
  }
  startLogin(): Promise<CodexAccountLoginStartResult> {
    return unavailable();
  }
  cancelLogin(): Promise<boolean> {
    return unavailable();
  }
  logout(): Promise<void> {
    return unavailable();
  }
  recover(): Promise<void> {
    return unavailable();
  }
  observe(): void {}
  subscribeLogin(): () => void {
    return () => undefined;
  }
}
