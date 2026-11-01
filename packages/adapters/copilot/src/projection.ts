import type { SessionEvent } from "@github/copilot-sdk";
import type {
  HistoricalTurnOutcome,
  HostEvent,
  HostItem,
  HostItemOutcome,
  HostItemSnapshot,
  HostThreadSnapshot,
} from "@codexhost/harness-adapter";
import { hostItemIdSchema, type HostTurnId } from "@codexhost/shared-contracts";
import { checkpoint, turnRef } from "./refs.js";
import { nativeFileChanges } from "./file-changes.js";
import { sessionError } from "./errors.js";
import { isRootMessage, visibleInput, hiddenInput } from "./history.js";

const OUTPUT_LIMIT = 256 * 1024;
const clip = (text: string) => text.slice(0, OUTPUT_LIMIT);
const itemId = (id: string) => hostItemIdSchema.parse(id);
const nativeFailure = {
  code: "nativeFailure" as const,
  message: "Copilot reported a native failure.",
  retryable: true,
};

/** All updates in a native tool lifecycle share the start's toolCallId. */
export function toolEventCallId(event: SessionEvent): string | undefined {
  switch (event.type) {
    case "tool.execution_start":
    case "tool.execution_partial_result":
    case "tool.shell_output":
    case "tool.execution_progress":
    case "tool.execution_complete":
      return event.data.toolCallId;
    default:
      return undefined;
  }
}

/** The same reducer supplies streaming output and read-only historical items. */
export class CopilotItems {
  private readonly order: string[] = [];
  private readonly snapshots = new Map<string, HostItemSnapshot>();
  readonly active = new Map<string, HostItem>();

  completedIds(): IterableIterator<string> {
    return this.snapshots.keys();
  }

  constructor(
    private readonly turnId: HostTurnId,
    private readonly emit: (event: HostEvent) => void,
  ) {}

  get items(): HostItemSnapshot[] {
    return this.order.flatMap((id) => {
      const item = this.snapshots.get(id);
      return item ? [item] : [];
    });
  }

  private start(item: HostItem): void {
    if (this.active.has(item.itemId) || this.snapshots.has(item.itemId)) return;
    this.active.set(item.itemId, item);
    this.order.push(item.itemId);
    this.emit({ type: "item.started", turnId: this.turnId, item: structuredClone(item) });
  }

  private finish(id: string, outcome: HostItemOutcome): void {
    const item = this.active.get(id);
    if (!item) return;
    this.active.delete(id);
    const snapshot = { item: structuredClone(item), outcome };
    this.snapshots.set(id, snapshot);
    this.emit({ type: "item.completed", turnId: this.turnId, snapshot });
  }

  finishAll(outcome: HostItemOutcome): void {
    for (const id of this.active.keys()) this.finish(id, outcome);
  }

  private text(
    id: string,
    text: string,
    type: "agentMessage" | "reasoning",
    full: boolean,
    phase?: string,
  ) {
    if (this.snapshots.has(id)) return;
    this.start({ type, itemId: itemId(id), text: "" });
    const item = this.active.get(id);
    if (!item || (item.type !== "agentMessage" && item.type !== "reasoning")) return;
    if (item.type === "agentMessage" && (phase === "commentary" || phase === "final_answer"))
      item.phase = phase;
    // A full payload must agree with prior deltas; do not silently duplicate or rewrite text.
    if (full && !text.startsWith(item.text)) throw new Error("Copilot text delta mismatch");
    if ((full ? text.length : item.text.length + text.length) > OUTPUT_LIMIT)
      throw new Error("Copilot message exceeds the output limit");
    const append = clip(full ? text.slice(item.text.length) : text).slice(
      0,
      OUTPUT_LIMIT - item.text.length,
    );
    item.text += append;
    if (append)
      this.emit({
        type: "item.updated",
        turnId: this.turnId,
        itemId: item.itemId,
        update: { type: "text.append", text: append },
      });
    if (full) this.finish(id, { status: "succeeded" });
  }

  accept(event: SessionEvent): void {
    if (event.agentId) return;
    switch (event.type) {
      case "assistant.message_delta":
        this.text(event.data.messageId, event.data.deltaContent, "agentMessage", false);
        break;
      case "assistant.message":
        this.text(event.data.messageId, event.data.content, "agentMessage", true, event.data.phase);
        break;
      case "assistant.reasoning_delta":
        this.text(event.data.reasoningId, event.data.deltaContent, "reasoning", false);
        break;
      case "assistant.reasoning":
        this.text(event.data.reasoningId, event.data.content, "reasoning", true);
        break;
      case "tool.execution_start": {
        const data = event.data;
        if (JSON.stringify(data.arguments ?? null).length > OUTPUT_LIMIT)
          throw new Error("Copilot tool arguments exceed the output limit");
        const args = data.arguments;
        const command =
          args && typeof args === "object" && !Array.isArray(args) ? args.command : undefined;
        if (
          ["bash", "powershell"].includes(data.toolName) &&
          typeof command === "string" &&
          args &&
          typeof args === "object" &&
          !Array.isArray(args) &&
          args.mode !== "async"
        ) {
          this.start({
            type: "commandExecution",
            itemId: itemId(data.toolCallId),
            command,
            output: "",
          });
        } else {
          this.start({
            type: "toolExecution",
            itemId: itemId(data.toolCallId),
            toolName: data.toolName,
            arguments: data.arguments ?? null,
            ...(data.mcpServerName ? { namespace: data.mcpServerName } : {}),
          });
        }
        break;
      }
      case "tool.execution_complete": {
        const data = event.data;
        const item = this.active.get(data.toolCallId);
        if (item?.type !== "commandExecution" && item?.type !== "toolExecution") return;
        let output =
          data.result?.detailedContent ?? data.result?.content ?? data.error?.message ?? "";
        if (!output && data.result?.structuredContent !== undefined)
          output = JSON.stringify(data.result.structuredContent);
        if (item?.type === "commandExecution") {
          item.output = clip(output);
          item.outputTruncated = output.length > OUTPUT_LIMIT;
          if (data.shellExecution) item.exitCode = data.shellExecution.exitCode;
          const exit = data.result?.contents?.find((block) => block.type === "shell_exit");
          if (exit) {
            item.exitCode = exit.exitCode;
            if (exit.cwd) item.cwd = exit.cwd;
            if (exit.outputTruncated) item.outputTruncated = true;
          }
          this.emit({
            type: "item.updated",
            turnId: this.turnId,
            itemId: item.itemId,
            update: { type: "output.append", text: item.output },
          });
        } else if (item?.type === "toolExecution") {
          item.output = {
            content: [{ type: "text", text: clip(output) }],
            truncated: output.length > OUTPUT_LIMIT,
          };
          let imageBytes = 0;
          const images = [
            ...(data.result?.contents ?? []),
            ...(data.result?.binaryResultsForLlm ?? []),
          ];
          const seen = new Set<string>();
          for (const block of images) {
            if (block.type !== "image") continue;
            if (!("data" in block)) {
              item.output.truncated = true;
              continue;
            }
            if (seen.has(block.data)) continue;
            seen.add(block.data);
            imageBytes += block.data.length;
            if (imageBytes > 8 * 1024 * 1024) {
              item.output.truncated = true;
              continue;
            }
            item.output.content.push({
              type: "image",
              mimeType: block.mimeType,
              base64Data: block.data,
            });
          }
          this.emit({
            type: "item.updated",
            turnId: this.turnId,
            itemId: item.itemId,
            update: { type: "output.replace", output: item.output },
          });
        }
        const succeeded =
          data.success &&
          (item?.type !== "commandExecution" || item.exitCode == null || item.exitCode === 0);
        this.finish(
          data.toolCallId,
          succeeded ? { status: "succeeded" } : { status: "failed", error: nativeFailure },
        );
        const changes = nativeFileChanges(data);
        if (changes.length) {
          const id = itemId(`files-${data.toolCallId}`);
          this.start({
            type: "fileChange",
            itemId: id,
            changes,
            sourceItemIds: [itemId(data.toolCallId)],
          });
          this.finish(id, { status: "succeeded" });
        }
        break;
      }
      case "session.compaction_start":
        this.start({ type: "contextCompaction", itemId: itemId(`compaction-${event.id}`) });
        break;
      case "session.compaction_complete":
        for (const item of this.active.values()) {
          if (item.type === "contextCompaction")
            this.finish(
              item.itemId,
              event.data.success
                ? { status: "succeeded" }
                : { status: "failed", error: nativeFailure },
            );
        }
        break;
    }
  }
}

export function projectHistory(sessionId: string, events: SessionEvent[]): HostThreadSnapshot {
  const turns: HostThreadSnapshot["turns"] = [];
  const reducers = new Map<HostThreadSnapshot["turns"][number], CopilotItems>();
  const toolOwners = new Map<string, CopilotItems>();
  let reducer: CopilotItems | undefined;
  let loopActive = false;
  let loopSeen = false;
  const logicalMessages = new Set<string>();
  let outcome: HistoricalTurnOutcome = {
    status: "unknown",
    reason: "Copilot does not persist session.idle.",
  };
  const finish = () => {
    const turn = turns.at(-1);
    if (!turn || !reducer) return;
    turn.outcome = outcome;
  };
  for (const event of events) {
    if (event.agentId) continue;
    if (event.type === "user.message") {
      if (!isRootMessage(event)) {
        if (event.data.messageId) logicalMessages.add(event.data.messageId);
        if (!hiddenInput(event)) {
          const current = turns.at(-1);
          if (!current) throw new Error("Copilot steering history has no root message");
          current.input.push(...visibleInput(event));
        }
        continue;
      }
      finish();
      if (!event.data.messageId) throw new Error("Copilot history has no logical message identity");
      outcome = { status: "unknown", reason: "Copilot does not persist session.idle." };
      loopActive = false;
      loopSeen = false;
      const nativeTurnRef = turnRef(sessionId, event.data.messageId);
      logicalMessages.clear();
      logicalMessages.add(event.data.messageId);
      const turn: HostThreadSnapshot["turns"][number] = {
        nativeTurnRef,
        checkpoint: checkpoint(sessionId, event.data.messageId),
        input: visibleInput(event),
        items: [],
        outcome,
        startedAtMs: Date.parse(event.timestamp),
      };
      turns.push(turn);
      reducer = new CopilotItems(event.data.messageId as HostTurnId, () => {});
      reducers.set(turn, reducer);
    } else if (event.type === "assistant.turn_start") {
      loopActive = true;
      loopSeen = true;
    } else if (event.type === "assistant.turn_end") {
      loopActive = false;
    } else if (event.type === "abort" && (loopActive || !loopSeen)) {
      outcome = { status: "cancelled" };
    } else if (
      event.type === "session.error" &&
      (event.data.originatingMessageId
        ? logicalMessages.has(event.data.originatingMessageId)
        : loopActive || !loopSeen)
    ) {
      outcome = { status: "failed", error: sessionError(event.data) };
    }
    const toolCallId = toolEventCallId(event);
    if (toolCallId !== undefined) {
      let owner = toolOwners.get(toolCallId);
      if (!owner && event.type === "tool.execution_start" && reducer) {
        owner = reducer;
        toolOwners.set(toolCallId, owner);
      }
      if (event.type !== "tool.execution_start" || owner === reducer) owner?.accept(event);
    } else reducer?.accept(event);
  }
  finish();
  for (const [turn, items] of reducers) {
    // Late durable tool results belong to their original Turn, even if cancelled.
    items.finishAll(
      turn.outcome.status === "cancelled" || turn.outcome.status === "failed"
        ? turn.outcome
        : {
            status: "failed",
            error: {
              code: "protocolError",
              message: "Copilot history has no completion evidence for this Item.",
              retryable: false,
            },
          },
    );
    turn.items = items.items;
  }
  return { turns };
}
