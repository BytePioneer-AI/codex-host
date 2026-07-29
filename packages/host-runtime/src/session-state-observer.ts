import type { HarnessSessionState } from "@codexhost/harness-adapter";

interface StateWaiter {
  afterRevision: number;
  resolve(state: HarnessSessionState): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
}

export class SessionStateObserver {
  readonly #waiters = new Set<StateWaiter>();
  #revision = 0;
  #state: HarnessSessionState;

  constructor(initialState: HarnessSessionState) {
    this.#state = initialState;
  }

  get revision(): number {
    return this.#revision;
  }

  get state(): HarnessSessionState {
    return this.#state;
  }

  update(state: HarnessSessionState): void {
    this.#state = state;
    this.#revision += 1;
    for (const waiter of [...this.#waiters]) {
      if (this.#revision <= waiter.afterRevision) continue;
      clearTimeout(waiter.timeout);
      this.#waiters.delete(waiter);
      waiter.resolve(state);
    }
  }

  waitForChange(afterRevision: number, timeoutMs = 2_000): Promise<HarnessSessionState> {
    if (this.#revision > afterRevision) return Promise.resolve(this.#state);
    return new Promise<HarnessSessionState>((resolve, reject) => {
      const waiter: StateWaiter = {
        afterRevision,
        resolve,
        reject,
        timeout: setTimeout(() => {
          this.#waiters.delete(waiter);
          reject(new Error("Timed out waiting for Harness Session state"));
        }, timeoutMs),
      };
      this.#waiters.add(waiter);
    });
  }

  fault(error: Error): void {
    for (const waiter of this.#waiters) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
    this.#waiters.clear();
  }
}
