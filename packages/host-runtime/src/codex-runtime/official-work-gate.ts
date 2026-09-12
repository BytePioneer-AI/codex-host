export type OfficialAccountPhase = "ready" | "changing" | "unavailable";
export type OfficialAdmissionCode = "busy" | "changing" | "unavailable";

export class OfficialAdmissionError extends Error {
  constructor(
    readonly code: OfficialAdmissionCode,
    cause?: unknown,
  ) {
    super(`Codex is ${code}`, cause === undefined ? undefined : { cause });
    this.name = "OfficialAdmissionError";
  }
}

export interface OfficialChangeLease {
  assertIdle(): void;
  finish(phase: "ready" | "unavailable"): void;
}

/** One synchronous admission boundary shared by every client and Codex delegation. */
export class OfficialWorkGate {
  #phase: OfficialAccountPhase = "unavailable";
  #revision = 0;
  readonly #requests = new Map<symbol, "work" | "quota-read">();
  readonly #nativeWork = new Set<string>();
  readonly #listeners = new Set<() => void>();
  #change: symbol | undefined;

  get phase(): OfficialAccountPhase {
    return this.#phase;
  }
  get revision(): number {
    return this.#revision;
  }
  get busy(): boolean {
    return this.#requests.size > 0 || this.#nativeWork.size > 0;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  initialized(): void {
    if (this.#change || this.busy) throw new OfficialAdmissionError("busy");
    this.#publish("ready");
  }

  admit(kind: "work" | "quota-read" = "work"): () => void {
    if (this.#phase !== "ready") throw new OfficialAdmissionError(this.#phase);
    const request = Symbol();
    this.#requests.set(request, kind);
    return () => {
      this.#requests.delete(request);
    };
  }

  /** Called only for the current connection generation by the official owner. */
  nativeWork(key: string, active: boolean): boolean {
    const previous = this.#nativeWork.has(key);
    if (active) this.#nativeWork.add(key);
    else this.#nativeWork.delete(key);
    return previous;
  }

  beginChange(recovery = false): OfficialChangeLease {
    return this.#beginChange(recovery, false);
  }

  /** Adapted from OpenCodex native-profile-api.ts withMainRequestDrain at
   * 2d4d7a22381a2e497c2442902104619e25f937c7 (MIT; third-party/opencodex.LICENSE).
   * Fence first, then drain only quota reads. No change lease escapes before idle;
   * on timeout, leave the read running and restore admission without touching auth.
   */
  async beginChangeAfterQuotaReads(timeoutMs = 10_000): Promise<OfficialChangeLease> {
    const change = this.#beginChange(false, true);
    const token = this.#change;
    try {
      const deadline = Date.now() + timeoutMs;
      while (this.#requests.size > 0) {
        if (this.#phase === "unavailable") throw new OfficialAdmissionError("unavailable");
        if (this.#nativeWork.size > 0 || Date.now() >= deadline)
          throw new OfficialAdmissionError("busy");
        await new Promise<void>((resolve) =>
          setTimeout(resolve, Math.min(50, deadline - Date.now())),
        );
      }
      change.assertIdle();
      return change;
    } catch (error) {
      if (this.#change === token) {
        this.#change = undefined;
        if (this.#phase === "changing") this.#publish("ready");
      }
      throw error;
    }
  }

  #beginChange(recovery: boolean, drainQuotaReads: boolean): OfficialChangeLease {
    if (this.#change || this.#phase === "changing") throw new OfficialAdmissionError("changing");
    if (this.#phase !== "ready" && !recovery) throw new OfficialAdmissionError("unavailable");
    // A failed stop can leave native markers after transport loss. Explicit
    // recovery must be able to retry that same owner's exit proof, without
    // clearing those markers or interrupting a healthy busy runtime. Pending
    // Host requests (including credential refresh) still prevent recovery.
    const retryExit = recovery && this.#phase === "unavailable";
    if (
      [...this.#requests.values()].some((kind) => !drainQuotaReads || kind !== "quota-read") ||
      (this.#nativeWork.size > 0 && !retryExit)
    )
      throw new OfficialAdmissionError("busy");
    const token = Symbol();
    this.#change = token;
    this.#publish("changing");
    return {
      assertIdle: () => {
        if (this.#phase === "unavailable") throw new OfficialAdmissionError("unavailable");
        if (this.#change !== token || this.busy) throw new OfficialAdmissionError("busy");
      },
      finish: (phase) => {
        if (this.#change !== token) return;
        if (phase === "ready" && this.#phase === "unavailable")
          throw new OfficialAdmissionError("unavailable");
        if (phase === "ready" && this.busy) throw new OfficialAdmissionError("busy");
        this.#change = undefined;
        this.#publish(phase);
      },
    };
  }

  unavailable(): void {
    // Do not release an in-progress transaction's exclusive lease on a native error.
    this.#publish("unavailable");
  }

  retired(): void {
    // Only confirmed process exit proves native work cannot continue.
    this.#nativeWork.clear();
  }

  #publish(phase: OfficialAccountPhase): void {
    if (phase === this.#phase) return;
    this.#phase = phase;
    this.#revision++;
    for (const listener of this.#listeners) {
      // A dead renderer must not roll back an already committed identity.
      try {
        listener();
      } catch {
        /* subscriber isolation */
      }
    }
  }
}
