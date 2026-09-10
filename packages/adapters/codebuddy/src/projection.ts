import type {
  HarnessError,
  HostEvent,
  HostItem,
  HostItemOutcome,
  HostItemSnapshot,
  HostToolOutput,
} from "@codexhost/harness-adapter";
import { hostItemIdSchema, jsonValueSchema, type HostTurnId } from "@codexhost/shared-contracts";
import { createTwoFilesPatch } from "diff";
import { CodeBuddyError, nativeError, OUTPUT_LIMIT, record, rows, text } from "./common.js";

export function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(contentText).join("");
  const item = record(value);
  return text(item.text) || (item.type === "content" ? contentText(item.content) : "");
}

export function toolItem(callId: string, name: string, input: unknown, cwd: string): HostItem {
  const itemId = hostItemIdSchema.parse(`tool-${callId}`);
  if (["Bash", "PowerShell"].includes(name))
    return {
      type: "commandExecution",
      itemId,
      command: text(record(input).command) || name,
      cwd,
    };
  return {
    type: "toolExecution",
    itemId,
    toolName: name,
    arguments: jsonValueSchema.parse(input ?? {}),
  };
}

export function toolOutput(value: unknown): HostToolOutput {
  const output = contentText(value);
  return {
    content: [{ type: "text", text: output.slice(0, OUTPUT_LIMIT) }],
    ...(output.length > OUTPUT_LIMIT ? { truncated: true } : {}),
  };
}

export function toolOutcome(status: unknown): HostItemOutcome {
  if (status === "completed") return { status: "succeeded" };
  if (status === "cancelled" || status === "interrupted") return { status: "cancelled" };
  return {
    status: "failed",
    error: nativeError(
      new CodeBuddyError(
        "nativeFailure",
        status === "failed" ? "Tool execution failed" : "Tool completion was not recorded",
      ),
    ),
  };
}

/** Native call IDs identify one Tool even when CodeBuddy sends tool_call twice. */
export class CodeBuddyTurnOutput {
  readonly #items = new Map<string, HostItemSnapshot>();
  readonly #finished = new Set<string>();
  readonly #tools = new Map<string, Record<string, unknown>>();
  readonly #diffs = new Set<string>();
  constructor(
    readonly turnId: HostTurnId,
    readonly cwd: string,
    readonly emit: (event: HostEvent) => void,
  ) {}

  #start(item: HostItem) {
    this.#items.set(item.itemId, { item, outcome: { status: "succeeded" } });
    this.emit({ type: "item.started", turnId: this.turnId, item: structuredClone(item) });
  }

  #finish(item: HostItem, outcome: HostItemOutcome) {
    if (this.#finished.has(item.itemId)) return;
    this.#finished.add(item.itemId);
    this.#items.set(item.itemId, { item, outcome });
    this.emit({
      type: "item.completed",
      turnId: this.turnId,
      snapshot: structuredClone({ item, outcome }),
    });
  }

  update(value: unknown) {
    const update = record(value),
      meta = record(update._meta);
    // Team-member output must never masquerade as the parent response.
    if (meta["codebuddy.ai/memberEvent"]) return;
    const kind = update.sessionUpdate;
    if (kind === "agent_message_chunk" || kind === "agent_thought_chunk") {
      const delta = contentText(update.content);
      if (!delta) return;
      const type = kind === "agent_message_chunk" ? "agentMessage" : "reasoning";
      const id = hostItemIdSchema.parse(`${type}-${text(update.messageId) || type}`);
      let item = this.#items.get(id)?.item;
      if (!item) {
        item =
          type === "agentMessage"
            ? { type: "agentMessage", itemId: id, text: "" }
            : { type: "reasoning", itemId: id, text: "" };
        this.#start(item);
      }
      if ((item.type !== "agentMessage" && item.type !== "reasoning") || this.#finished.has(id))
        throw new CodeBuddyError("protocolError", "Text arrived after Item completion");
      if (item.text.length + delta.length > 2_000_000)
        throw new CodeBuddyError("protocolError", "Agent output exceeded the supported Item size");
      item.text += delta;
      this.emit({
        type: "item.updated",
        turnId: this.turnId,
        itemId: id,
        update: { type: "text.append", text: delta },
      });
      return;
    }
    if (kind !== "tool_call" && kind !== "tool_call_update") return;
    const callId = text(update.toolCallId);
    if (!callId || this.#finished.has(`tool-${callId}`)) return;
    const previous = this.#tools.get(callId) ?? {};
    const merged: Record<string, unknown> = {
      ...previous,
      ...update,
      _meta: { ...record(previous._meta), ...meta },
    };
    this.#tools.set(callId, merged);
    const terminal = update.status === "completed" || update.status === "failed";
    // Early content chunks contain partial *arguments*, not command output.
    if (!terminal && !record(merged._meta)["codebuddy.ai/toolArgumentsComplete"]) return;
    const name =
      text(record(merged._meta)["codebuddy.ai/toolName"]) || text(merged.title) || "CodeBuddy tool";
    const id = `tool-${callId}`;
    let item = this.#items.get(id)?.item;
    if (!item) {
      item = toolItem(callId, name, merged.rawInput, this.cwd);
      this.#start(item);
    }
    if (!terminal) return;
    const output = toolOutput(merged.rawOutput ?? merged.content);
    if (item.type === "commandExecution") {
      item.output = contentText(output.content);
      item.outputTruncated = Boolean(output.truncated);
      const exitCode = record(merged.rawOutput).exitCode;
      if (typeof exitCode === "number") item.exitCode = exitCode;
      this.emit({
        type: "item.updated",
        turnId: this.turnId,
        itemId: item.itemId,
        update: { type: "output.append", text: item.output },
      });
    } else if (item.type === "toolExecution") {
      item.output = output;
      this.emit({
        type: "item.updated",
        turnId: this.turnId,
        itemId: item.itemId,
        update: { type: "output.replace", output },
      });
    }
    this.#finish(item, toolOutcome(update.status));
    if (update.status === "completed" && !this.#diffs.has(callId)) {
      const changes: Extract<HostItem, { type: "fileChange" }>["changes"] = [];
      for (const diff of rows(merged.content)) {
        if (
          diff.type !== "diff" ||
          typeof diff.path !== "string" ||
          typeof diff.newText !== "string"
        )
          continue;
        const unifiedDiff = createTwoFilesPatch(
          diff.path,
          diff.path,
          text(diff.oldText),
          diff.newText,
        );
        // HostFileChange has no truncation marker; never publish a silently cut patch.
        if (unifiedDiff.length > OUTPUT_LIMIT) continue;
        changes.push({
          path: diff.path,
          kind: diff.oldText === null ? "add" : "update",
          unifiedDiff,
        });
      }
      if (changes.length) {
        this.#diffs.add(callId);
        const change: HostItem = {
          type: "fileChange",
          itemId: hostItemIdSchema.parse(`diff-${callId}`),
          changes,
        };
        this.#start(change);
        this.#finish(change, { status: "succeeded" });
      }
    }
  }

  finish(status: "succeeded" | "failed" | "cancelled", error?: HarnessError) {
    for (const { item } of this.#items.values()) {
      const outcome: HostItemOutcome =
        status === "failed"
          ? {
              status,
              error: error ?? nativeError(new CodeBuddyError("nativeFailure", "Turn failed")),
            }
          : { status };
      this.#finish(item, outcome);
    }
    return [...this.#items.values()];
  }
}
