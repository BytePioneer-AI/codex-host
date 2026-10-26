/** In-memory projection of the CH protocol onto the existing Web UI wire format. */
import { REASONING_TRANSCRIPT_COMMAND } from "@codexhost/shared-contracts";
import { SessionLog, type ProjectionListener } from "./session-log.ts";
import { threadListTitle } from "./ch-thread-title.ts";
import { RpcError } from "./transport.ts";
import {
  TurnProjector,
  type HostFileChange,
  type HostItem,
  type HostItemOutcome,
  type TurnOutcomeShape,
} from "./projector.ts";

export interface ChItem {
  id: string;
  type: string;
  [key: string]: unknown;
}
export interface ChTurn {
  id: string;
  status: string;
  items: ChItem[];
  /** Native Turn boundaries in Unix seconds. */
  startedAt?: number | null;
  completedAt?: number | null;
  error?: { message?: string | undefined } | null | undefined;
  /** Host snapshot fingerprint of a completed Turn; absent from paginated reads. */
  fingerprint?: string | undefined;
}
export interface ChThread {
  id: string;
  cwd: string;
  modelProvider: string;
  workspaceKind?: "projectless";
  projectId?: string | null;
  name?: string | null | undefined;
  preview?: string | undefined;
  createdAt: number;
  updatedAt: number;
  status: { type: string };
  turns: ChTurn[];
  historyMode?: "legacy" | "paginated";
  parentThreadId?: string | null;
  canAcceptDirectInput?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fileChangeKind(value: unknown): HostFileChange["kind"] {
  const type = typeof value === "string" ? value : isRecord(value) ? value.type : undefined;
  if (type === "add" || type === "create") return "add";
  if (type === "delete") return "delete";
  return "update";
}

function fileChangeDiff(value: Record<string, unknown>): string {
  if (typeof value.diff === "string") return value.diff;
  if (typeof value.unifiedDiff === "string") return value.unifiedDiff;
  return "";
}

function hostFileChanges(value: unknown): HostFileChange[] {
  if (!Array.isArray(value)) return [];
  const changes: HostFileChange[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate)) continue;
    changes.push({
      path: typeof candidate.path === "string" ? candidate.path : "",
      kind: fileChangeKind(candidate.kind),
      unifiedDiff: fileChangeDiff(candidate),
    });
  }
  return changes;
}

function hasFileChangePath(item: Extract<HostItem, { type: "fileChange" }>): boolean {
  return item.changes.some((change) => change.path.trim() !== "");
}

function itemOf(item: ChItem, reasoningPreviewIds: ReadonlySet<string>): HostItem | undefined {
  const itemId = item.id;
  switch (item.type) {
    case "agentMessage":
      return { type: "agentMessage", itemId, text: String(item.text ?? "") };
    case "reasoning":
      return {
        type: "reasoning",
        itemId,
        text: [
          ...(Array.isArray(item.summary) ? item.summary : []),
          ...(Array.isArray(item.content) ? item.content : []),
        ]
          .filter((value) => typeof value === "string")
          .join("\n"),
      };
    case "commandExecution":
      // Codex Desktop receives each Host Reasoning Item twice: a `reasoning`
      // preview and a Command Execution transcript twin. Web already renders
      // the complete preview text, so projecting the paired twin as a real
      // command can make a late arrival absorb the final answer into a tool Step.
      // Require the exact preview pair so a Harness command literally named
      // `thinking` remains a genuine command.
      if (
        item.command === REASONING_TRANSCRIPT_COMMAND &&
        reasoningPreviewIds.has(`${itemId}-summary`)
      )
        return undefined;
      return {
        type: "commandExecution",
        itemId,
        command: String(item.command ?? ""),
        cwd: String(item.cwd ?? ""),
        output: String(item.aggregatedOutput ?? ""),
        exitCode: typeof item.exitCode === "number" ? item.exitCode : null,
      };
    case "mcpToolCall":
    case "dynamicToolCall":
      return {
        type: "toolExecution",
        itemId,
        toolName: String(item.tool ?? item.name ?? item.type),
        arguments: item.arguments ?? {},
        output: {
          content: [{ type: "text", text: JSON.stringify(item.result ?? item.contentItems ?? {}) }],
        },
      };
    case "fileChange":
      return {
        type: "fileChange",
        itemId,
        changes: hostFileChanges(item.changes),
      };
    case "contextCompaction":
      return { type: "contextCompaction", itemId };
    default:
      return undefined;
  }
}
function nativeTime(seconds: number | null | undefined): number | undefined {
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0
    ? seconds * 1000
    : undefined;
}
function finished(status: string): boolean {
  return status !== "inProgress" && status !== "running";
}
function outcome(turn: ChTurn): TurnOutcomeShape {
  return turn.status === "failed"
    ? {
        status: "failed",
        error: { code: "nativeFailed", message: turn.error?.message ?? "CH turn failed" },
      }
    : turn.status === "interrupted"
      ? { status: "cancelled" }
      : { status: "succeeded" };
}

/** The journal is a disposable rendering buffer; every authoritative value remains in CH. */
export class ChThreadView {
  readonly log: SessionLog;
  private turns = new Map<
    string,
    {
      projector: TurnProjector;
      items: Map<string, HostItem>;
      started: Set<string>;
      completed: Set<string>;
      /** Last settled changes per fileChange item, to spot a summary that keeps growing. */
      fileRevisions: Map<string, { json: string; count: number }>;
      done: boolean;
    }
  >();
  private readonly liveOutput = new Map<string, string>();
  private retired = false;
  retire(): void {
    this.retired = true;
  }
  protected ensureCurrent(): void {
    if (this.retired)
      throw new RpcError("host/resync", "Host snapshot was superseded by a new generation");
  }
  constructor(
    readonly thread: ChThread,
    private readonly harnessId: string,
    onProjection: ProjectionListener,
    private turnStart = 0,
    sequenceStart = 0,
    hasEarlier: () => boolean = () => false,
    private readonly projectInput: (content: unknown[]) => unknown[] = (content) => content,
  ) {
    const published = new Map<string, string>();
    this.log = new SessionLog(
      {
        version: 4,
        id: thread.id,
        createdAt: thread.createdAt * 1000,
        cwd: thread.cwd,
        isSeeded: false,
        agentPreset: "standard",
      },
      {
        readLines: () => [],
        readJson: (_path, fallback) => fallback,
        writeLines: () => {},
        writeJson: () => {},
        appendLine: () => {},
      },
      (id, key, value, seq) => {
        const fingerprint = JSON.stringify(value) ?? "undefined";
        if (published.get(key) === fingerprint) return;
        published.set(key, fingerprint);
        onProjection(id, key, value, seq);
      },
      sequenceStart,
      hasEarlier,
    );
  }

  /** Resolve a Web turn/end coordinate to its canonical CH Turn, including prepended pages. */
  forkTurnId(atSeq?: number): string | undefined {
    this.ensureCurrent();
    const end =
      atSeq === undefined
        ? this.log.events.findLast((event) => event.type === "turn/end")
        : this.log.events.find((event) => event.seq === atSeq && event.type === "turn/end");
    if (!end) return undefined;
    const turn = (end.data as { turn: number }).turn;
    for (const [id, view] of this.turns) if (view.done && view.projector.turn === turn) return id;
    return undefined;
  }

  /** Exact user/message coordinate of the settled native tail, never a Web Turn number. */
  editableMessage(): { seq: number; turnId: string; input: unknown[] } | undefined {
    this.ensureCurrent();
    const turn = this.thread.turns.at(-1);
    if (
      this.thread.historyMode !== "paginated" ||
      !turn ||
      !finished(turn.status) ||
      this.thread.status.type === "active"
    )
      return;
    const messages = turn.items.filter((item) => item.type === "userMessage");
    if (messages.length !== 1 || !Array.isArray(messages[0]?.content)) return;
    const view = this.turns.get(turn.id);
    if (!view?.done) return;
    let currentTurn: number | undefined;
    for (const event of this.log.events) {
      if (event.type === "turn/start") currentTurn = (event.data as { turn: number }).turn;
      if (currentTurn === view.projector.turn && event.type === "user/message")
        return { seq: event.seq, turnId: turn.id, input: messages[0].content };
    }
  }

  /** Older native pages are projected separately, without changing the visible tail. */
  prepend(turns: ChTurn[]): void {
    this.ensureCurrent();
    if (!turns.length) return;
    if (turns.some((turn) => this.turns.has(turn.id) || !finished(turn.status)))
      throw new Error("Older CH history overlaps the loaded window or contains an active Turn");
    const start = this.turnStart - turns.length;
    if (start < 0) throw new Error("History rendering Turn range exhausted");
    const page = new ChThreadView(
      { ...this.thread, turns: [] },
      this.harnessId,
      () => {},
      start,
      0,
      () => false,
      this.projectInput,
    );
    page.update({ ...this.thread, turns });
    this.log.prepend(page.log.events);
    for (const [id, view] of page.turns) this.turns.set(id, view);
    this.turnStart = start;
    this.thread.turns = [...turns, ...this.thread.turns];
  }

  update(thread: ChThread): void {
    this.ensureCurrent();
    // Native history can replace live Item identities when a Turn is persisted.
    // This journal is append-only: reopen it rather than append the replacement
    // transcript after the already displayed live output.
    for (const turn of thread.turns) {
      const view = this.turns.get(turn.id);
      if (!view || view.done) continue;
      const ids = new Set(turn.items.map((item) => item.id));
      if ([...view.items.keys()].some((id) => !ids.has(id)))
        throw new RpcError("host/items-replaced", "CH replaced live Items with native history.");
    }
    Object.assign(this.thread, thread);
    this.log.setProjection("title", threadListTitle(thread));
    this.log.setProjection("sessionListMetadata", {
      blank: thread.turns.length === 0,
      lastPromptAt: thread.updatedAt * 1000,
    });
    try {
      this.projectTurns(thread);
    } finally {
      this.log.clock = undefined;
    }
    this.log.setProjection("codexhostToolOutput", Object.fromEntries(this.liveOutput));
  }

  private projectTurns(thread: ChThread): void {
    let previousEnd = thread.createdAt * 1000;
    for (const turn of thread.turns) {
      let view = this.turns.get(turn.id);
      const complete = finished(turn.status);
      const start = nativeTime(turn.startedAt) ?? (complete ? previousEnd : Date.now());
      const end = Math.max(
        start,
        nativeTime(turn.completedAt) ?? (view && !view.done ? Date.now() : start),
      );
      previousEnd = end;
      // Untimed history stays anchored to known history, never to the time it was loaded.
      this.log.clock = complete && view ? () => end : () => start;
      if (!view) {
        const projector = new TurnProjector(this.log, {
          live: !complete,
          turn: this.turnStart + this.turns.size + 1,
          cwd: thread.cwd,
          model: { provider: this.harnessId, model: "harness" },
          onToolOutput: (id, output) => {
            if (output === undefined) this.liveOutput.delete(id);
            else this.liveOutput.set(id, output.slice(-8000));
          },
        });
        const input = turn.items
          .filter((item) => item.type === "userMessage")
          .flatMap((item) => (Array.isArray(item.content) ? item.content : []));
        const clientId = turn.items.find(
          (item) => item.type === "userMessage" && typeof item.clientId === "string",
        )?.clientId;
        projector.begin(
          this.projectInput(input),
          typeof clientId === "string" ? clientId : undefined,
        );
        view = {
          projector,
          items: new Map(),
          started: new Set(),
          completed: new Set(),
          fileRevisions: new Map(),
          done: false,
        };
        this.turns.set(turn.id, view);
      }
      if (!complete) this.log.clock = undefined;
      if (view.done) continue;
      const reasoningPreviewIds = new Set(
        turn.items.filter((item) => item.type === "reasoning").map((item) => item.id),
      );
      for (const item of turn.items) {
        const projected = itemOf(item, reasoningPreviewIds);
        if (!projected) continue;
        if (view.completed.has(item.id)) {
          // The Host's per-Turn file summary keeps one id and grows as more files
          // change, even after it first reports completed. Settle each growth as
          // its own call; every one carries the cumulative changes.
          const revision = view.fileRevisions.get(item.id);
          if (projected.type === "fileChange" && revision !== undefined) {
            const json = JSON.stringify(projected.changes);
            if (json !== revision.json) {
              const count = revision.count + 1;
              const next = {
                ...projected,
                itemId: `${item.id}#${count}` as typeof projected.itemId,
              };
              view.projector.itemStarted(next);
              view.projector.itemCompleted(next, { status: "succeeded" });
              view.fileRevisions.set(item.id, { json, count });
            }
          }
          continue;
        }
        const old = view.items.get(item.id);
        if (!view.started.has(item.id)) {
          view.items.set(item.id, projected);
          // DSH diff cards read the first tool/call arguments. Start only once a
          // path exists so an empty CH fileChange does not freeze file_path: "".
          if (projected.type === "fileChange" && !hasFileChangePath(projected)) continue;
          view.projector.itemStarted(projected);
          if (projected.type === "commandExecution" && projected.output)
            view.projector.itemUpdated(item.id, { type: "output.append", text: projected.output });
          view.started.add(item.id);
        } else if (
          (projected.type === "agentMessage" || projected.type === "reasoning") &&
          old !== undefined &&
          (old.type === "agentMessage" || old.type === "reasoning") &&
          projected.text.startsWith(old.text)
        ) {
          const text = projected.text.slice(old.text.length);
          if (text) view.projector.itemUpdated(item.id, { type: "text.append", text });
        } else if (
          (projected.type === "agentMessage" || projected.type === "reasoning") &&
          old !== undefined &&
          (old.type === "agentMessage" || old.type === "reasoning")
        ) {
          throw new RpcError(
            "host/history-changed",
            "CH changed already displayed text. Reload this page to reopen its current history.",
          );
        } else if (
          projected.type === "commandExecution" &&
          old !== undefined &&
          old.type === "commandExecution"
        ) {
          const output = projected.output ?? "";
          if (output.startsWith(old.output ?? "")) {
            const text = output.slice((old.output ?? "").length);
            if (text) view.projector.itemUpdated(item.id, { type: "output.append", text });
          } else
            view.projector.itemUpdated(item.id, {
              type: "output.replace",
              output: { content: [{ type: "text", text: output }] },
            });
        } else if (
          projected.type === "fileChange" &&
          old?.type === "fileChange" &&
          JSON.stringify(old.changes) !== JSON.stringify(projected.changes)
        ) {
          view.projector.itemUpdated(item.id, {
            type: "fileChanges.replace",
            changes: projected.changes,
          });
        }
        view.items.set(item.id, projected);
        const itemOutcome: HostItemOutcome | undefined =
          item.status === "completed"
            ? { status: "succeeded" }
            : item.status === "failed"
              ? {
                  status: "failed",
                  error: { code: "nativeFailed", message: "Native tool execution failed" },
                }
              : item.status === "declined" || item.status === "interrupted"
                ? { status: "cancelled" }
                : undefined;
        if (itemOutcome) {
          if (!view.started.has(item.id)) {
            view.projector.itemStarted(projected);
            view.started.add(item.id);
          }
          view.projector.itemCompleted(projected, itemOutcome);
          view.completed.add(item.id);
          if (projected.type === "fileChange")
            view.fileRevisions.set(item.id, { json: JSON.stringify(projected.changes), count: 0 });
        }
      }
      if (complete) {
        this.log.clock = () => end;
        for (const item of view.items.values())
          if (!view.completed.has(item.itemId))
            view.projector.itemCompleted(item, { status: "succeeded" });
        view.projector.finish(outcome(turn));
        view.done = true;
      }
    }
  }
}
