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
  readonly #requests = new Set<symbol>();
  readonly #listeners = new Set<() => void>();
  #change: symbol | undefined;

  get phase(): OfficialAccountPhase {
    return this.#phase;
  }
  get revision(): number {
    return this.#revision;
  }
  get busy(): boolean {
    return this.#requests.size > 0;
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
  admit(): () => void {
    if (this.#phase !== "ready") throw new OfficialAdmissionError(this.#phase);
    const request = Symbol();
    this.#requests.add(request);
    return () => {
      this.#requests.delete(request);
    };
  }
  beginChange(recovery = false): OfficialChangeLease {
    return this.#beginChange(recovery);
  }

  /** Reject new work immediately; existing native work is ended by backend retirement. */
  beginStoppingChange(): OfficialChangeLease {
    return this.#beginChange(false, true);
  }

  #beginChange(recovery: boolean, stopWork = false): OfficialChangeLease {
    if (this.#change || this.#phase === "changing") throw new OfficialAdmissionError("changing");
    if (this.#phase !== "ready" && !recovery) throw new OfficialAdmissionError("unavailable");
    // Recovery and metadata changes must not race independent Host credential writers.
    if (!stopWork && this.busy) throw new OfficialAdmissionError("busy");
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
    this.#publish("unavailable");
  }
  #publish(phase: OfficialAccountPhase): void {
    if (phase === this.#phase) return;
    this.#phase = phase;
    this.#revision++;
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch {
        /* subscriber isolation */
      }
    }
  }
}
