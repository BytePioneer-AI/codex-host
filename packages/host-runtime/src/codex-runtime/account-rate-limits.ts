import { parseHostUsage, type HostUsage } from "@codexhost/harness-adapter";
import { observeCodexRateLimits, type JsonObject } from "@codexhost/protocol-core";

interface AccountSnapshot {
  usage: HostUsage | null;
  freshUntil: number;
  refresh?: Promise<void>;
}

/** Quota and in-flight reads belong to one Account, never the Desktop default. */
export class AccountRateLimits {
  readonly #accounts = new Map<string, AccountSnapshot>();

  get(accountId: string): HostUsage | null {
    return this.#accounts.get(accountId)?.usage ?? null;
  }

  reset(accountId: string): void {
    this.#accounts.delete(accountId);
  }

  #state(accountId: string): AccountSnapshot {
    let state = this.#accounts.get(accountId);
    if (!state) {
      state = { usage: null, freshUntil: 0 };
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
    } catch {
      // Preserve the previous snapshot when the native update is malformed.
    }
  }

  refresh(accountId: string, request: () => Promise<JsonObject>): Promise<void> {
    const state = this.#state(accountId);
    if (state.usage && Date.now() < state.freshUntil) return Promise.resolve();
    if (state.refresh) return state.refresh;
    state.refresh = request()
      .then((response) => {
        if (this.#accounts.get(accountId) !== state) return;
        const usage = observeCodexRateLimits(response);
        if (!usage) return;
        state.usage = parseHostUsage(usage);
        state.freshUntil = Date.now() + 15_000;
      })
      .catch(() => undefined)
      .finally(() => {
        delete state.refresh;
      });
    return state.refresh;
  }
}
