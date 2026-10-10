/** In-memory projection of the CH protocol onto the existing Web UI wire format. */
import { SessionLog, type ProjectionListener } from "./session-log.ts";
import { RpcError } from "./transport.ts";
import {
  TurnProjector,
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
  error?: { message?: string | undefined } | null | undefined;
}
export interface ChThread {
  id: string;
  cwd: string;
  modelProvider: string;
  name?: string | null | undefined;
  preview?: string | undefined;
  createdAt: number;
  updatedAt: number;
  status: { type: string };
  turns: ChTurn[];
  parentThreadId?: string | null;
  canAcceptDirectInput?: boolean;
}

function itemOf(item: ChItem): HostItem | undefined {
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
        changes: (Array.isArray(item.changes) ? item.changes : []).map(
          (value: { path?: string; diff?: string; kind?: unknown }) => ({
            path: String(value.path ?? ""),
            kind: typeof value.kind === "string" && value.kind === "delete" ? "delete" : "update",
            unifiedDiff: String(value.diff ?? ""),
          }),
        ),
      };
    case "contextCompaction":
      return { type: "contextCompaction", itemId };
    default:
      return undefined;
  }
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
      completed: Set<string>;
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
    Object.assign(this.thread, thread);
    this.log.setProjection("title", thread.name ?? thread.preview ?? null);
    this.log.setProjection("sessionListMetadata", {
      blank: thread.turns.length === 0,
      lastPromptAt: thread.updatedAt * 1000,
    });
    for (const turn of thread.turns) {
      let view = this.turns.get(turn.id);
      if (!view) {
        const projector = new TurnProjector(this.log, {
          live: !finished(turn.status),
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
        view = { projector, items: new Map(), completed: new Set(), done: false };
        this.turns.set(turn.id, view);
      }
      if (view.done) continue;
      for (const item of turn.items) {
        const projected = itemOf(item);
        if (!projected || view.completed.has(item.id)) continue;
        const old = view.items.get(item.id);
        if (!old) {
          view.projector.itemStarted(projected);
          if (projected.type === "commandExecution" && projected.output)
            view.projector.itemUpdated(item.id, { type: "output.append", text: projected.output });
        } else if (
          (projected.type === "agentMessage" || projected.type === "reasoning") &&
          (old.type === "agentMessage" || old.type === "reasoning") &&
          projected.text.startsWith(old.text)
        ) {
          const text = projected.text.slice(old.text.length);
          if (text) view.projector.itemUpdated(item.id, { type: "text.append", text });
        } else if (
          (projected.type === "agentMessage" || projected.type === "reasoning") &&
          (old.type === "agentMessage" || old.type === "reasoning")
        ) {
          throw new RpcError(
            "host/history-changed",
            "CH changed already displayed text. Reload this page to reopen its current history.",
          );
        } else if (projected.type === "commandExecution" && old.type === "commandExecution") {
          const output = projected.output ?? "";
          if (output.startsWith(old.output ?? "")) {
            const text = output.slice((old.output ?? "").length);
            if (text) view.projector.itemUpdated(item.id, { type: "output.append", text });
          } else
            view.projector.itemUpdated(item.id, {
              type: "output.replace",
              output: { content: [{ type: "text", text: output }] },
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
          view.projector.itemCompleted(projected, itemOutcome);
          view.completed.add(item.id);
        }
      }
      if (finished(turn.status)) {
        for (const item of view.items.values())
          if (!view.completed.has(item.itemId))
            view.projector.itemCompleted(item, { status: "succeeded" });
        view.projector.finish(outcome(turn));
        view.done = true;
      }
    }
    this.log.setProjection("codexhostToolOutput", Object.fromEntries(this.liveOutput));
  }
}
