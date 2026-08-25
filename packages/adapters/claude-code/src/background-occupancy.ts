/**
 * Session occupancy for background Claude Subagents belonging to one user task.
 *
 * Claude settles a background Subagent and answers for it in two separate native
 * Segments: the task notification only reports that the Subagent stopped, while
 * the Root continuation it triggers arrives in a later Segment. A notified
 * Subagent therefore still owes Root output, and the count of Segments Claude
 * spends on the queued notifications is not observable from the native stream.
 */

interface OccupiedSubagent {
  state: "running" | "notified";
  callId?: string;
  nativeSubagentId?: string;
}

export class ClaudeBackgroundOccupancy {
  readonly #tasks = new Map<string, OccupiedSubagent>();
  readonly #keyByCall = new Map<string, string>();
  readonly #keyByAgent = new Map<string, string>();

  /** True while this user task can still produce Root output. */
  get unsettled(): boolean {
    return this.#tasks.size > 0;
  }

  /** True while a settled Subagent still owes its Root continuation. */
  get awaitingContinuation(): boolean {
    for (const task of this.#tasks.values()) {
      if (task.state === "notified") return true;
    }
    return false;
  }

  occupySpawn(callId: string, nativeSubagentId?: string): void {
    const key = this.#lookup(callId, nativeSubagentId);
    if (key !== undefined) {
      if (nativeSubagentId) this.bind(callId, nativeSubagentId);
      return;
    }
    this.#tasks.set(callId, {
      state: "running",
      callId,
      ...(nativeSubagentId ? { nativeSubagentId } : {}),
    });
    this.#keyByCall.set(callId, callId);
    if (nativeSubagentId) this.#keyByAgent.set(nativeSubagentId, callId);
  }

  occupyAgent(nativeSubagentId: string): void {
    const key = this.#lookup(undefined, nativeSubagentId);
    const existing = key === undefined ? undefined : this.#tasks.get(key);
    if (existing) {
      existing.state = "running";
      return;
    }
    this.#tasks.set(nativeSubagentId, { state: "running", nativeSubagentId });
    this.#keyByAgent.set(nativeSubagentId, nativeSubagentId);
  }

  bind(callId: string, nativeSubagentId: string): void {
    const key = this.#lookup(callId, nativeSubagentId);
    if (key === undefined) return;
    const task = this.#tasks.get(key);
    if (!task) return;
    task.callId = callId;
    task.nativeSubagentId = nativeSubagentId;
    this.#keyByCall.set(callId, key);
    this.#keyByAgent.set(nativeSubagentId, key);
  }

  /** Records that a Subagent stopped and now owes one Root continuation. */
  notify(callId?: string, nativeSubagentId?: string): void {
    const key = this.#lookup(callId, nativeSubagentId);
    if (key === undefined) return;
    if (callId && nativeSubagentId) this.bind(callId, nativeSubagentId);
    const task = this.#tasks.get(key);
    if (task) task.state = "notified";
  }

  /** Drops a Subagent that owes no Root continuation, such as a foreground delegation. */
  release(callId?: string, nativeSubagentId?: string): void {
    const key = this.#lookup(callId, nativeSubagentId);
    if (key !== undefined) this.#remove(key);
  }

  /**
   * Applies Claude's live background task level. Membership replaces the running
   * set, so a tracked Subagent missing from the payload owes its continuation
   * even when its task notification never arrived.
   */
  observeLive(nativeSubagentIds: readonly string[]): void {
    const live = new Set(nativeSubagentIds);
    for (const task of this.#tasks.values()) {
      if (task.state !== "running" || !task.nativeSubagentId) continue;
      if (!live.has(task.nativeSubagentId)) task.state = "notified";
    }
  }

  /** Settles every notified Subagent once the native Session stops continuing. */
  releaseContinuations(): void {
    for (const [key, task] of [...this.#tasks]) {
      if (task.state === "notified") this.#remove(key);
    }
  }

  interruptAll(): string[] {
    const ids = [...this.#tasks.values()].flatMap((task) =>
      task.nativeSubagentId ? [task.nativeSubagentId] : [],
    );
    this.clear();
    return ids;
  }

  clear(): void {
    this.#tasks.clear();
    this.#keyByCall.clear();
    this.#keyByAgent.clear();
  }

  #lookup(callId?: string, nativeSubagentId?: string): string | undefined {
    const byAgent = nativeSubagentId ? this.#keyByAgent.get(nativeSubagentId) : undefined;
    if (byAgent !== undefined) return byAgent;
    return callId ? this.#keyByCall.get(callId) : undefined;
  }

  #remove(key: string): void {
    const task = this.#tasks.get(key);
    if (!task) return;
    this.#tasks.delete(key);
    if (task.callId) this.#keyByCall.delete(task.callId);
    if (task.nativeSubagentId) this.#keyByAgent.delete(task.nativeSubagentId);
  }
}
