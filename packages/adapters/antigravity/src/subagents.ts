import type {
  HostEvent,
  HostItemSnapshot,
  HostSubagentState,
  HostSubagentStatus,
} from "@codexhost/harness-adapter";
import { nativeConversationSummariesDbPath } from "./fork.js";
import { nativeSubagentIdSchema, readSubagentTranscript } from "./subagent-transcript.js";

type NativeSubagentState =
  | { ownership: "matched"; status: HostSubagentStatus | null }
  | { ownership: "foreign" | "unavailable" };

/** Native ownership must be confirmed before reading a child's transcript. */
async function readNativeSubagentState(
  home: string,
  parentId: string,
  childId: string,
): Promise<NativeSubagentState> {
  const { DatabaseSync } = await import("node:sqlite");
  let db;
  try {
    db = new DatabaseSync(nativeConversationSummariesDbPath(home), { readOnly: true });
    const row = db
      .prepare(
        "SELECT status, parent_conversation_id FROM conversation_summaries WHERE conversation_id = ?",
      )
      .get(childId);
    if (!row) return { ownership: "unavailable" };
    if (row.parent_conversation_id !== parentId) return { ownership: "foreign" };
    return {
      ownership: "matched",
      status:
        row.status === "CASCADE_RUN_STATUS_RUNNING"
          ? "running"
          : row.status === "CASCADE_RUN_STATUS_IDLE"
            ? "completed"
            : null,
    };
  } catch {
    return { ownership: "unavailable" };
  } finally {
    db?.close();
  }
}

export async function readNativeSubagentStatus(
  home: string,
  parentId: string,
  childId: string,
): Promise<HostSubagentStatus | null> {
  const state = await readNativeSubagentState(home, parentId, childId);
  return state.ownership === "matched" ? state.status : null;
}

export interface AntigravitySubagentOptions {
  parentId(): string | undefined;
  home: string;
  cwd: string;
  outputLimit: number;
  pollIntervalMs?: number;
  observationTimeoutMs?: number;
  emit(event: HostEvent): void;
}

export class AntigravitySubagents {
  readonly #states = new Map<string, HostSubagentState>();
  readonly #transcripts = new Map<string, string>();
  readonly #unavailableSince = new Map<string, number>();
  #timer: ReturnType<typeof setInterval> | undefined;
  #refreshing: Promise<void> | undefined;
  #stopped = false;
  constructor(readonly options: AntigravitySubagentOptions) {}
  get running(): boolean {
    return [...this.#states.values()].some(
      (state) => state.status === "running" || state.status === "pending",
    );
  }
  state(id: string): HostSubagentState | undefined {
    return this.#states.get(id);
  }

  track(id: string, snapshot: HostItemSnapshot): void {
    if (this.#stopped || !nativeSubagentIdSchema.safeParse(id).success) return;
    const item = snapshot.item;
    const child =
      item.type === "subagentDelegation"
        ? item.subagents.find((state) => state.nativeSubagentId === id)
        : undefined;
    this.#states.set(id, {
      subagentId: id,
      nativeSubagentId: id,
      description: "Antigravity Subagent",
      background: true,
      ...this.#states.get(id),
      ...child,
      status: "running",
    });
    this.#unavailableSince.delete(id);
    if (!this.#timer) {
      this.#timer = setInterval(() => {
        void this.refresh();
      }, this.options.pollIntervalMs ?? 750);
      this.#timer.unref();
    }
    void this.refresh();
  }
  refresh(): Promise<void> {
    if (this.#stopped) return Promise.resolve();
    return (this.#refreshing ??= this.#read().finally(() => {
      this.#refreshing = undefined;
      if (!this.running) {
        clearInterval(this.#timer);
        this.#timer = undefined;
      }
    }));
  }
  #publish(id: string, state: HostSubagentState): void {
    this.#states.set(id, state);
    this.options.emit({
      type: "subagent.state.changed",
      nativeSubagentId: id,
      status: state.status,
      ...(state.resultSummary ? { resultSummary: state.resultSummary } : {}),
    });
  }
  #expireUnavailable(id: string, previous: HostSubagentState): boolean {
    const since = this.#unavailableSince.get(id) ?? Date.now();
    this.#unavailableSince.set(id, since);
    if (Date.now() - since < (this.options.observationTimeoutMs ?? 30_000)) return false;
    this.#publish(id, {
      ...previous,
      status: "interrupted",
      resultSummary: "Native Subagent status could not be confirmed",
    });
    return true;
  }
  async #read(): Promise<void> {
    const parentId = this.options.parentId();
    for (const [id, previous] of this.#states) {
      if (this.#stopped) return;
      if (previous.status !== "running" && previous.status !== "pending") continue;
      const observed = parentId
        ? await readNativeSubagentState(this.options.home, parentId, id)
        : { ownership: "unavailable" as const };
      if (this.#stopped) return;
      if (this.#states.get(id) !== previous) continue;
      if (observed.ownership === "foreign") {
        const state = { ...previous, status: "interrupted" as const };
        delete state.resultSummary;
        this.#publish(id, state);
        continue;
      }
      if (observed.ownership !== "matched" || observed.status === null) {
        const expired = this.#expireUnavailable(id, previous);
        if (observed.ownership !== "matched" || expired) continue;
      }
      if (!parentId) continue;
      const transcript = await readSubagentTranscript({
        parentId,
        childId: id,
        status: observed.status ?? previous.status,
        cwd: this.options.cwd,
        outputLimit: this.options.outputLimit,
        home: this.options.home,
      });
      if (this.#stopped) return;
      if (this.#states.get(id) !== previous) continue;
      if (observed.status === "running") this.#unavailableSince.delete(id);
      else if (!transcript.ok && this.#expireUnavailable(id, previous)) continue;
      if (transcript.ok && observed.status !== null) this.#unavailableSince.delete(id);
      // A terminal status is settled only after its final transcript is readable.
      let status = transcript.ok ? (observed.status ?? previous.status) : previous.status;
      if (
        status === "completed" &&
        transcript.ok &&
        transcript.value.turns.at(-1)?.outcome.status === "failed"
      )
        status = "failed";
      const last = transcript.ok
        ? transcript.value.turns.at(-1)?.items.findLast(({ item }) => item.type === "agentMessage")
            ?.item
        : undefined;
      const resultSummary =
        last?.type === "agentMessage" ? last.text.slice(0, 2000) : previous.resultSummary;
      if (status !== previous.status || resultSummary !== previous.resultSummary)
        this.#publish(id, { ...previous, status, ...(resultSummary ? { resultSummary } : {}) });
      if (transcript.ok) {
        const content = JSON.stringify(transcript.value);
        if (content !== this.#transcripts.get(id)) {
          this.#transcripts.set(id, content);
          this.options.emit({ type: "subagent.transcript.changed", nativeSubagentId: id });
        }
      }
    }
  }
  stop(): void {
    this.#stopped = true;
    clearInterval(this.#timer);
    this.#timer = undefined;
  }
  async close(): Promise<void> {
    this.stop();
    await this.#refreshing;
  }
}
