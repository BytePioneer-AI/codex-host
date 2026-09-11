import { parseHostUsage, type HostUsage } from "@codexhost/harness-adapter";
import {
  observeCodexRateLimitResetCredits,
  observeCodexRateLimits,
  type CodexRateLimitResetCredits,
  type JsonObject,
} from "@codexhost/protocol-core";

interface AccountSnapshot {
  usage: HostUsage | null;
  resetCredits: CodexRateLimitResetCredits | null;
  observedAt: string | null;
  freshUntil: number;
  refresh?: Promise<AccountRateLimitRefresh>;
}

export interface AccountRateLimitRefresh {
  status: "live" | "cached" | "failed";
  observedAt: string | null;
}

/** Quota and in-flight reads belong to one Account, never the Desktop default. */
export class AccountRateLimits {
  readonly #accounts = new Map<string, AccountSnapshot>();

  get(accountId: string): HostUsage | null {
    return this.#accounts.get(accountId)?.usage ?? null;
  }

  getResetCredits(accountId: string): CodexRateLimitResetCredits | null {
    return this.#accounts.get(accountId)?.resetCredits ?? null;
  }

  getObservedAt(accountId: string): string | null {
    return this.#accounts.get(accountId)?.observedAt ?? null;
  }

  reset(accountId: string): void {
    this.#accounts.delete(accountId);
  }

  #state(accountId: string): AccountSnapshot {
    let state = this.#accounts.get(accountId);
    if (!state) {
      state = { usage: null, resetCredits: null, observedAt: null, freshUntil: 0 };
      this.#accounts.set(accountId, state);
    }
    return state;
  }

  observe(accountId: string, usage: Partial<HostUsage>): void {
    const state = this.#state(accountId);
    state.freshUntil = 0;
    if (state.usage) return;
    try {
      state.usage = parseHostUsage(usage);
      state.observedAt = new Date().toISOString();
    } catch {
      // Preserve the previous snapshot when the native update is malformed.
    }
  }

  refresh(
    accountId: string,
    request: () => Promise<JsonObject>,
    force = false,
  ): Promise<AccountRateLimitRefresh> {
    const state = this.#state(accountId);
    if (!force && state.usage && Date.now() < state.freshUntil) {
      return Promise.resolve({ status: "cached", observedAt: state.observedAt });
    }
    if (state.refresh) return state.refresh;
    state.refresh = request()
      .then((response): AccountRateLimitRefresh => {
        if (this.#accounts.get(accountId) !== state) {
          return { status: "failed", observedAt: null };
        }
        const usage = observeCodexRateLimits(response);
        state.resetCredits = observeCodexRateLimitResetCredits(response);
        if (!usage) return { status: "failed", observedAt: state.observedAt };
        state.usage = parseHostUsage({ ...(state.usage ?? {}), ...usage });
        state.observedAt = new Date().toISOString();
        state.freshUntil = Date.now() + 15_000;
        return { status: "live", observedAt: state.observedAt };
      })
      .catch((): AccountRateLimitRefresh => ({ status: "failed", observedAt: state.observedAt }))
      .finally(() => {
        delete state.refresh;
      });
    return state.refresh;
  }
}
