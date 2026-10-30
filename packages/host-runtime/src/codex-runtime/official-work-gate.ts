export type OfficialAccountPhase = "ready" | "unavailable";
export type OfficialAdmissionCode = "busy" | "unavailable";

export class OfficialAdmissionError extends Error {
  constructor(
    readonly code: OfficialAdmissionCode,
    cause?: unknown,
  ) {
    super(`Codex is ${code}`, cause === undefined ? undefined : { cause });
    this.name = "OfficialAdmissionError";
  }
}

/** One synchronous admission boundary shared by every client and Codex delegation. */
export class OfficialWorkGate {
  #phase: OfficialAccountPhase = "unavailable";
  #revision = 0;
  readonly #requests = new Set<symbol>();
  readonly #listeners = new Set<() => void>();

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
    if (this.busy) throw new OfficialAdmissionError("busy");
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
