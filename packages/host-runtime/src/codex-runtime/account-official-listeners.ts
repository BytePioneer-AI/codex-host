import path from "node:path";

import type { CodexAccount } from "../account/account-repository.js";
import type { LoopbackOfficialAppServerListener } from "../remote-official-app-server.js";

/** Shares a listener between Desktop connections, never between Account homes. */
export class AccountOfficialListeners {
  readonly #listeners = new Map<string, LoopbackOfficialAppServerListener>();
  readonly #starting = new Map<string, Promise<string>>();
  #closed = false;

  constructor(
    readonly createListener: (
      account: Pick<CodexAccount, "codexHome">,
    ) => LoopbackOfficialAppServerListener,
  ) {}

  async endpoint(account: Pick<CodexAccount, "codexHome">): Promise<string> {
    if (this.#closed) throw new Error("Account official listeners are closed");
    const key = path.resolve(account.codexHome);
    const existing = this.#starting.get(key);
    if (existing) return existing;
    const listener = this.createListener(account);
    this.#listeners.set(key, listener);
    const starting = listener.listen().catch(async (error: unknown) => {
      // Do not retry until the failed process has been cleaned up.
      await listener.close();
      this.#listeners.delete(key);
      this.#starting.delete(key);
      throw error;
    });
    this.#starting.set(key, starting);
    return starting;
  }

  async close(): Promise<void> {
    this.#closed = true;
    await Promise.all([...this.#listeners.values()].map((listener) => listener.close()));
    this.#listeners.clear();
    this.#starting.clear();
  }
}
