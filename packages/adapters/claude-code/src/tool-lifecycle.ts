import type {
  HarnessError,
  HostCommandExecutionItem,
  HostEvent,
  HostItem,
  HostItemOutcome,
  HostToolExecutionItem,
  HostToolOutput,
} from "@codexhost/harness-adapter";
import type { HostItemId, HostTurnId, JsonValue } from "@codexhost/shared-contracts";

import { projectClaudeFileChange } from "./file-change.js";
import { claudeTranscriptItemId } from "./item-identity.js";
import { isClaudeTaskTool, type ClaudeTaskTracker } from "./task-tracker.js";
import type { ClaudeTurnEvent } from "./transport.js";

interface ActiveTool {
  item: HostCommandExecutionItem | HostToolExecutionItem;
  nativeName: string;
  nativeArguments: JsonValue;
  startedAtMs: number;
  elapsedMs: number;
}

/** A Bash Item that native Claude moved to the background; it outlives its Turn. */
export interface ClaudeDetachedCommand {
  turnId: HostTurnId;
  /** The Bash `tool_use` id; the task's `task_notification` names it. */
  callId: string;
  taskId: string;
  item: HostCommandExecutionItem;
  startedAtMs: number;
  /** Named only in the model-facing result text; used for live output. */
  outputFile?: string;
}

export interface ClaudeToolLifecycleOptions {
  cwd: string;
  outputLimit: number;
  taskTracker: ClaudeTaskTracker;
  /** The Turn's message/thinking Item key; Tool Items share it for history parity. */
  nativeTurnKey: string;
  newItemId(): HostItemId;
  emit(event: HostEvent): void;
  onDetached(command: ClaudeDetachedCommand): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown, key: string): string | undefined {
  return isRecord(value) && typeof value[key] === "string" ? value[key] : undefined;
}

function toolFailure(toolName: string): HarnessError {
  return {
    code: "nativeFailure",
    message: `Claude Code Tool '${toolName}' failed`,
    retryable: false,
  };
}

function boundedToolOutput(text: string | undefined, limit: number): HostToolOutput | undefined {
  if (!text || text.length === 0) return undefined;
  const truncated = text.length > limit;
  return {
    content: [{ type: "text", text: truncated ? text.slice(0, limit) : text }],
    ...(truncated ? { truncated: true } : {}),
  };
}

function toolOutputText(output: HostToolOutput | undefined): string {
  return (
    output?.content
      .filter(
        (content): content is Extract<(typeof output.content)[number], { type: "text" }> =>
          content.type === "text",
      )
      .map(({ text }) => text)
      .join("") ?? ""
  );
}

export class ClaudeToolLifecycle {
  readonly #cwd: string;
  readonly #emit: (event: HostEvent) => void;
  readonly #newItemId: () => HostItemId;
  readonly #onDetached: (command: ClaudeDetachedCommand) => void;
  readonly #outputLimit: number;
  readonly #taskTracker: ClaudeTaskTracker;
  readonly #nativeTurnKey: string;
  readonly #tools = new Map<string, ActiveTool>();
  #toolOrdinal = 0;

  constructor(options: ClaudeToolLifecycleOptions) {
    this.#cwd = options.cwd;
    this.#emit = options.emit;
    this.#newItemId = options.newItemId;
    this.#onDetached = options.onDetached;
    this.#outputLimit = options.outputLimit;
    this.#taskTracker = options.taskTracker;
    this.#nativeTurnKey = options.nativeTurnKey;
  }

  get size(): number {
    return this.#tools.size;
  }

  start(turnId: HostTurnId, event: Extract<ClaudeTurnEvent, { type: "tool.started" }>): void {
    if (this.#tools.has(event.callId)) throw new Error("Claude Code Tool started more than once");
    // Tool Items share the Turn's transcript identity; the ordinal counts this
    // lifecycle's Items in order of appearance so a later history projection
    // addresses the same Renderer Item.
    const itemId = claudeTranscriptItemId(this.#nativeTurnKey, "tool", (this.#toolOrdinal += 1));
    const command = event.toolName === "Bash" ? stringField(event.arguments, "command") : undefined;
    const item: HostCommandExecutionItem | HostToolExecutionItem = command
      ? {
          type: "commandExecution",
          itemId,
          command,
          cwd: this.#cwd,
        }
      : {
          type: "toolExecution",
          itemId,
          toolName: isClaudeTaskTool(event.toolName) ? "Todo" : event.toolName,
          arguments: isClaudeTaskTool(event.toolName) ? {} : event.arguments,
        };
    this.#tools.set(event.callId, {
      item,
      nativeName: event.toolName,
      nativeArguments: event.arguments,
      startedAtMs: Date.now(),
      elapsedMs: 0,
    });
    this.#emit({ type: "item.started", turnId, item });
  }

  progress(event: Extract<ClaudeTurnEvent, { type: "tool.progress" }>): void {
    const tool = this.#tools.get(event.callId);
    if (!tool) throw new Error("Claude Code Tool Progress references an unknown Tool");
    tool.elapsedMs = Math.max(tool.elapsedMs, event.elapsedMs);
  }

  complete(
    turnId: HostTurnId,
    event: Extract<ClaudeTurnEvent, { type: "tool.completed" }>,
    cancellationRequested: boolean,
  ): void {
    const tool = this.#tools.get(event.callId);
    if (!tool || tool.nativeName !== event.toolName) {
      throw new Error("Claude Code Tool completion references an unknown Tool");
    }
    this.#tools.delete(event.callId);
    if (
      tool.item.type === "commandExecution" &&
      event.backgroundTaskId &&
      !event.isError &&
      !cancellationRequested
    ) {
      this.#emit({ type: "item.detached", turnId, itemId: tool.item.itemId });
      this.#onDetached({
        turnId,
        callId: event.callId,
        taskId: event.backgroundTaskId,
        item: tool.item,
        startedAtMs: tool.startedAtMs,
        ...(event.backgroundOutputFile ? { outputFile: event.backgroundOutputFile } : {}),
      });
      return;
    }
    const output = boundedToolOutput(event.outputText, this.#outputLimit);
    const durationMs = Math.max(tool.elapsedMs, Date.now() - tool.startedAtMs, 0);
    if (tool.item.type === "commandExecution") {
      tool.item = {
        ...tool.item,
        ...(output
          ? {
              output: toolOutputText(output),
              outputTruncated: output.truncated === true,
            }
          : {}),
        durationMs,
      };
    } else {
      tool.item = { ...tool.item, ...(output ? { output } : {}), durationMs };
    }
    const outcome: HostItemOutcome = cancellationRequested
      ? { status: "cancelled", reason: "Cancelled by user" }
      : event.isError
        ? { status: "failed", error: toolFailure(event.toolName) }
        : { status: "succeeded" };
    if (
      outcome.status === "succeeded" &&
      tool.item.type === "toolExecution" &&
      isClaudeTaskTool(event.toolName)
    ) {
      const todos = this.#taskTracker.apply(
        event.toolName,
        tool.nativeArguments,
        event.structuredResult,
      );
      if (todos) tool.item = { ...tool.item, toolName: "Todo", arguments: todos };
    }
    this.#completeItem(turnId, tool.item, outcome);

    if (outcome.status === "succeeded" && event.fileChange) {
      const change = projectClaudeFileChange(event.fileChange, this.#cwd);
      if (change) {
        const fileItem: HostItem = {
          type: "fileChange",
          itemId: this.#newItemId(),
          sourceItemIds: [tool.item.itemId],
          changes: [change],
        };
        this.#emit({ type: "item.started", turnId, item: fileItem });
        this.#completeItem(turnId, fileItem, { status: "succeeded" });
      }
    }
  }

  finalize(turnId: HostTurnId, outcome: HostItemOutcome): void {
    for (const [callId, tool] of this.#tools) {
      this.#tools.delete(callId);
      const durationMs = Math.max(tool.elapsedMs, Date.now() - tool.startedAtMs, 0);
      this.#completeItem(turnId, { ...tool.item, durationMs }, outcome);
    }
  }

  #completeItem(turnId: HostTurnId, item: HostItem, outcome: HostItemOutcome): void {
    this.#emit({
      type: "item.completed",
      turnId,
      snapshot: { item, outcome },
    });
  }
}
