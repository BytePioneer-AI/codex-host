import type {
  HarnessError,
  HostCommandExecutionItem,
  HostEvent,
  HostItem,
  HostItemOutcome,
  HostToolExecutionItem,
  HostToolOutput,
} from "@codexhost/harness-adapter";
import type { HostItemId, HostTurnId } from "@codexhost/shared-contracts";

import { projectClaudeFileChange } from "./file-change.js";
import type { ClaudeTurnEvent } from "./transport.js";

interface ActiveTool {
  item: HostCommandExecutionItem | HostToolExecutionItem;
  nativeName: string;
  startedAtMs: number;
  elapsedMs: number;
}

export interface ClaudeToolLifecycleOptions {
  cwd: string;
  outputLimit: number;
  newItemId(): HostItemId;
  emit(event: HostEvent): void;
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
  readonly #outputLimit: number;
  readonly #tools = new Map<string, ActiveTool>();

  constructor(options: ClaudeToolLifecycleOptions) {
    this.#cwd = options.cwd;
    this.#emit = options.emit;
    this.#newItemId = options.newItemId;
    this.#outputLimit = options.outputLimit;
  }

  get size(): number {
    return this.#tools.size;
  }

  start(turnId: HostTurnId, event: Extract<ClaudeTurnEvent, { type: "tool.started" }>): void {
    if (this.#tools.has(event.callId)) throw new Error("Claude Code Tool started more than once");
    const command = event.toolName === "Bash" ? stringField(event.arguments, "command") : undefined;
    const item: HostCommandExecutionItem | HostToolExecutionItem = command
      ? {
          type: "commandExecution",
          itemId: this.#newItemId(),
          command,
          cwd: this.#cwd,
        }
      : {
          type: "toolExecution",
          itemId: this.#newItemId(),
          toolName: event.toolName,
          arguments: event.arguments,
        };
    this.#tools.set(event.callId, {
      item,
      nativeName: event.toolName,
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
    this.#completeItem(turnId, tool.item, outcome);

    if (outcome.status === "succeeded" && event.fileChange) {
      const change = projectClaudeFileChange(event.fileChange, this.#cwd);
      if (change) {
        const fileItem: HostItem = {
          type: "fileChange",
          itemId: this.#newItemId(),
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
