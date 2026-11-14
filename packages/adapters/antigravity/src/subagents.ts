import type {
  HostEvent,
  HostItemSnapshot,
  HostSubagentState,
  HostSubagentStatus,
} from "@codexhost/harness-adapter";
import { nativeConversationSummariesDbPath } from "./fork.js";
import { nativeSubagentIdSchema, readSubagentTranscript } from "./subagent-transcript.js";

/** Read-only native status observation; missing data is not evidence of completion. */
export async function readNativeSubagentStatus(
  home: string,
  parentId: string,
  childId: string,
): Promise<HostSubagentStatus | null> {
  const { DatabaseSync } = await import("node:sqlite");
  let db;
  try {
    db = new DatabaseSync(nativeConversationSummariesDbPath(home), { readOnly: true });
    const row = db
      .prepare(
        "SELECT status, parent_conversation_id FROM conversation_summaries WHERE conversation_id = ?",
      )
      .get(childId);
    if (row?.parent_conversation_id !== parentId) return null;
    if (row.status === "CASCADE_RUN_STATUS_RUNNING") return "running";
    if (row.status === "CASCADE_RUN_STATUS_IDLE") return "completed";
    return null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

export interface AntigravitySubagentOptions {
  parentId(): string | undefined;
  home: string;
  cwd: string;
  outputLimit: number;
  pollIntervalMs?: number;
  emit(event: HostEvent): void;
}

export class AntigravitySubagents {
  readonly #states = new Map<string, HostSubagentState>();
  readonly #transcripts = new Map<string, string>();
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
    if (!this.#states.has(id))
      this.#states.set(
        id,
        child ?? {
          subagentId: id,
          nativeSubagentId: id,
          description: "Antigravity Subagent",
          status: "running",
          background: true,
        },
      );
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
    }));
  }
  async #read(): Promise<void> {
    const parentId = this.options.parentId();
    if (!parentId) return;
    for (const [id, previous] of this.#states) {
      const observed = await readNativeSubagentStatus(this.options.home, parentId, id);
      let status =
        observed === "completed" && previous.status === "failed"
          ? "failed"
          : (observed ?? previous.status);
      const transcript = await readSubagentTranscript({
        parentId,
        childId: id,
        status,
        cwd: this.options.cwd,
        outputLimit: this.options.outputLimit,
        home: this.options.home,
      });
      if (this.#stopped) return;
      if (
        observed === "completed" &&
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
      if (status !== previous.status || resultSummary !== previous.resultSummary) {
        this.#states.set(id, { ...previous, status, ...(resultSummary ? { resultSummary } : {}) });
        this.options.emit({
          type: "subagent.state.changed",
          nativeSubagentId: id,
          status,
          ...(resultSummary ? { resultSummary } : {}),
        });
      }
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
  }
  async close(): Promise<void> {
    this.stop();
    await this.#refreshing;
  }
}
