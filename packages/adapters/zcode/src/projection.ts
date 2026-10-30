import { createPatch } from "diff";
import type {
  HarnessError,
  HostEvent,
  HostFileChange,
  HostItem,
  HostItemOutcome,
  HostItemSnapshot,
  HostSubagentState,
  HostToolOutput,
} from "@codexhost/harness-adapter";
import { hostItemIdSchema, jsonValueSchema, type HostTurnId } from "@codexhost/shared-contracts";
import { record, text, type NativeEvent, type NativePart } from "./protocol.js";

const OUTPUT_LIMIT = 256_000;
export function toolOutput(value: unknown): HostToolOutput {
  const result = record(value);
  const content: HostToolOutput["content"] = [];
  const raw =
    typeof value === "string"
      ? value
      : text(result.output) ||
        text(result.content) ||
        text(result.message) ||
        JSON.stringify(value ?? null);
  content.push({ type: "text", text: raw.slice(0, OUTPUT_LIMIT) });
  const images = record(result.display).images;
  if (Array.isArray(images))
    for (const value of images.slice(0, 8)) {
      const image = record(value);
      if (
        typeof image.base64Data === "string" &&
        image.base64Data.length <= 8_000_000 &&
        typeof image.mimeType === "string"
      )
        content.push({ type: "image", mimeType: image.mimeType, base64Data: image.base64Data });
    }
  return { content, ...(raw.length > OUTPUT_LIMIT ? { truncated: true } : {}) };
}
export function fileChanges(value: unknown): HostFileChange[] {
  const result = record(value),
    nested = record(result.data);
  const data = typeof result.filePath === "string" ? result : nested;
  const filePath = text(data.filePath);
  if (!filePath) return [];
  if (
    (typeof data.originalFile === "string" || data.originalFile === null) &&
    typeof data.content === "string"
  ) {
    const diff = createPatch(filePath, data.originalFile ?? "", data.content);
    if (diff.length > OUTPUT_LIMIT) return [];
    return [
      { path: filePath, kind: data.originalFile === null ? "add" : "update", unifiedDiff: diff },
    ];
  }
  if (Array.isArray(data.structuredPatch)) {
    const hunks = data.structuredPatch.map(record);
    if (
      !hunks.every(
        (hunk) =>
          typeof hunk.oldStart === "number" &&
          typeof hunk.oldLines === "number" &&
          typeof hunk.newStart === "number" &&
          typeof hunk.newLines === "number" &&
          Array.isArray(hunk.lines) &&
          hunk.lines.every((line) => typeof line === "string"),
      )
    )
      return [];
    const diff =
      [
        `--- a/${filePath}`,
        `+++ b/${filePath}`,
        ...hunks.flatMap((hunk) => [
          `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
          ...(hunk.lines as string[]),
        ]),
      ].join("\n") + "\n";
    return diff.length <= OUTPUT_LIMIT
      ? [{ path: filePath, kind: data.originalFile === null ? "add" : "update", unifiedDiff: diff }]
      : [];
  }
  return [];
}
export function subagent(
  value: unknown,
  input: unknown,
  fallback: string,
): HostSubagentState | undefined {
  const result = record(value),
    data = record(result.data),
    args = record(input);
  const id =
    text(result.childSessionId) ||
    text(data.childSessionId) ||
    text(result.agentId) ||
    text(data.agentId);
  if (!id) return;
  const status = text(result.status) || text(data.status);
  return {
    subagentId: id,
    nativeSubagentId: id,
    description: text(args.description) || text(args.prompt) || fallback,
    ...(text(args.subagent_type) || text(args.agentType)
      ? { role: text(args.subagent_type) || text(args.agentType) }
      : {}),
    background:
      args.run_in_background === true || result.background === true || data.background === true,
    status: ["running", "waiting", "blocked"].includes(status)
      ? "running"
      : status === "cancelled"
        ? "interrupted"
        : ["failed", "lost"].includes(status) || result.success === false
          ? "failed"
          : "completed",
    ...(text(result.output) ? { resultSummary: text(result.output).slice(0, OUTPUT_LIMIT) } : {}),
  };
}
export function makeTool(id: string, name: string, input: unknown, cwd: string): HostItem {
  const itemId = hostItemIdSchema.parse(id),
    args = record(input);
  if (name.toLowerCase() === "bash")
    return { type: "commandExecution", itemId, command: text(args.command), cwd };
  return {
    type: "toolExecution",
    itemId,
    toolName: name,
    arguments: jsonValueSchema.parse(input ?? {}),
  };
}
export function projectPart(part: NativePart, cwd: string): HostItemSnapshot[] {
  const itemId = hostItemIdSchema.parse(
    part.type === "tool" ? text(part.callId) || part.partId : part.partId,
  );
  const succeeded: HostItemOutcome = { status: "succeeded" };
  if (
    (part.type === "text" || part.type === "reasoning") &&
    typeof part.text === "string" &&
    part.ignored !== true
  )
    return [
      {
        item: {
          type: part.type === "text" ? "agentMessage" : "reasoning",
          itemId,
          text: part.text,
        },
        outcome: succeeded,
      },
    ];
  if (part.type === "timeline" && part.timelineType === "context_compaction")
    return [
      {
        item: { type: "contextCompaction", itemId },
        outcome:
          part.status === "failed"
            ? {
                status: "failed",
                error: {
                  code: "nativeFailure",
                  message: "ZCode compaction failed",
                  retryable: false,
                },
              }
            : succeeded,
      },
    ];
  if (part.type !== "tool") return [];
  const state = record(part.state),
    input = state.input ?? {},
    name = text(part.tool);
  const item = makeTool(itemId, name, input, cwd);
  const output = toolOutput(state.output ?? state.error ?? "");
  const outcome: HostItemOutcome =
    state.status === "completed"
      ? succeeded
      : state.status === "error"
        ? {
            status: "failed",
            error: { code: "nativeFailure", message: "ZCode tool failed", retryable: false },
          }
        : { status: "cancelled", reason: "Tool did not complete" };
  if (item.type === "commandExecution") {
    item.output = output.content
      .filter((value) => value.type === "text")
      .map((value) => value.text)
      .join("\n");
    if (output.truncated !== undefined) item.outputTruncated = output.truncated;
    const code = record(state.metadata).exitCode;
    if (typeof code === "number") item.exitCode = code;
  }
  if (item.type === "toolExecution") item.output = output;
  if (
    (item.type === "toolExecution" || item.type === "commandExecution") &&
    typeof state.startedAt === "number" &&
    typeof state.completedAt === "number"
  )
    item.durationMs = Math.max(0, state.completedAt - state.startedAt);
  const snapshots: HostItemSnapshot[] = [{ item, outcome }];
  const changes = fileChanges(record(state.metadata).data ?? state.metadata);
  if (changes.length && outcome.status === "succeeded")
    snapshots.push({
      item: {
        type: "fileChange",
        itemId: hostItemIdSchema.parse(`${itemId}:files`),
        changes,
        sourceItemIds: [itemId],
      },
      outcome: succeeded,
    });
  const child = subagent(record(state.metadata), input, name);
  if (child)
    snapshots.push({
      item: {
        type: "subagentDelegation",
        itemId: hostItemIdSchema.parse(`${itemId}:agent`),
        operation: name === "SendMessage" ? "send" : "spawn",
        prompt: text(record(input).prompt),
        subagents: [child],
      },
      outcome,
    });
  return snapshots;
}

/** Live text and tools use one native feed each; mirrored part events cannot duplicate them. */
export class TurnProjection {
  readonly items = new Map<string, HostItem>();
  readonly completed = new Set<string>();
  #streamNumber = 0;
  #textId = "";
  #reasoningId = "";
  constructor(
    readonly turnId: HostTurnId,
    readonly cwd: string,
    readonly emit: (event: HostEvent) => void,
  ) {}
  start(item: HostItem) {
    if (this.items.has(item.itemId)) return;
    this.items.set(item.itemId, item);
    this.emit({ type: "item.started", turnId: this.turnId, item: structuredClone(item) });
  }
  complete(snapshot: HostItemSnapshot) {
    if (this.completed.has(snapshot.item.itemId)) return;
    this.start(snapshot.item);
    this.items.set(snapshot.item.itemId, snapshot.item);
    this.completed.add(snapshot.item.itemId);
    this.emit({ type: "item.completed", turnId: this.turnId, snapshot: structuredClone(snapshot) });
  }
  event(event: NativeEvent) {
    const p = event.payload ?? {};
    if (event.type === "model.streaming") {
      const kind = text(p.kind),
        reasoning = kind.startsWith("reasoning_");
      if (kind === "tool_call" && text(p.toolCallId)) {
        this.start(makeTool(text(p.toolCallId), text(p.toolName), p.input, this.cwd));
        return;
      }
      if (!kind.startsWith("text_") && !reasoning) return;
      let id =
        text(p.partId) ||
        (text(p.assistantMessageId)
          ? `stream:${text(p.assistantMessageId)}:${reasoning ? "reasoning" : "text"}`
          : reasoning
            ? this.#reasoningId
            : this.#textId);
      if (kind.endsWith("_start") || !id || !this.items.has(id)) {
        id ||= `stream:${this.turnId}:${++this.#streamNumber}`;
        if (reasoning) this.#reasoningId = id;
        else this.#textId = id;
        this.start({
          type: reasoning ? "reasoning" : "agentMessage",
          itemId: hostItemIdSchema.parse(id),
          text: "",
        });
      }
      const item = this.items.get(id);
      if (
        !item ||
        this.completed.has(id) ||
        (item.type !== "agentMessage" && item.type !== "reasoning")
      )
        return;
      if (typeof p.delta === "string" && p.delta) {
        item.text += p.delta;
        this.emit({
          type: "item.updated",
          turnId: this.turnId,
          itemId: item.itemId,
          update: { type: "text.append", text: p.delta },
        });
      }
      if (kind.endsWith("_end")) {
        this.complete({ item, outcome: { status: "succeeded" } });
        if (reasoning) this.#reasoningId = "";
        else this.#textId = "";
      }
      return;
    }
    if (event.type === "session.updated" && text(p.childSessionId) && text(p.parentToolCallId)) {
      const id = `${text(p.parentToolCallId)}:agent`,
        existing = this.items.get(id);
      const child = subagent(p, p, text(p.agentType));
      if (!child) return;
      if (existing?.type === "subagentDelegation") {
        existing.subagents = [
          {
            ...existing.subagents[0],
            ...child,
            description:
              text(p.description) || existing.subagents[0]?.description || child.description,
            background: existing.subagents[0]?.background ?? child.background,
          },
        ];
        this.emit({
          type: "item.updated",
          turnId: this.turnId,
          itemId: existing.itemId,
          update: { type: "subagents.replace", subagents: existing.subagents },
        });
        if (child.status !== "running")
          this.complete({ item: existing, outcome: { status: "succeeded" } });
      } else
        this.start({
          type: "subagentDelegation",
          itemId: hostItemIdSchema.parse(id),
          operation: "spawn",
          prompt: text(p.prompt),
          subagents: [child],
        });
      return;
    }
    if (event.type === "session.updated" && text(p.compactReason) && text(p.operationId)) {
      const item: HostItem = {
        type: "contextCompaction",
        itemId: hostItemIdSchema.parse(text(p.operationId)),
      };
      if (p.status === "started") this.start(item);
      else if (p.status === "completed") this.complete({ item, outcome: { status: "succeeded" } });
      return;
    }
    if (event.type !== "tool.updated" || p.source === "subagent") return;
    const id = text(p.toolCallId);
    if (!id) return;
    if (p.kind === "scheduled") {
      this.start(makeTool(id, text(p.toolName), p.input, this.cwd));
      return;
    }
    const item = this.items.get(id);
    if (!item || this.completed.has(id)) return;
    if (p.kind === "progress" && item.type === "commandExecution") {
      const next = (text(p.stdoutTail) + text(p.stderrTail)).slice(-OUTPUT_LIMIT);
      // Tails are replacement windows, not deltas. Only append a verified extension.
      if (next.startsWith(item.output ?? "")) {
        const delta = next.slice(item.output?.length ?? 0);
        item.output = next;
        if (delta)
          this.emit({
            type: "item.updated",
            turnId: this.turnId,
            itemId: item.itemId,
            update: { type: "output.append", text: delta },
          });
      }
    }
    if (p.kind !== "result" && p.kind !== "error") return;
    const result = p.result ?? p.error,
      data = record(result);
    const outcome: HostItemOutcome =
      p.kind === "error" || data.success === false || data.isError === true
        ? {
            status: "failed",
            error: { code: "nativeFailure", message: "ZCode tool failed", retryable: false },
          }
        : { status: "succeeded" };
    const output = toolOutput(result);
    if (item.type === "toolExecution") {
      item.output = output;
      this.emit({
        type: "item.updated",
        turnId: this.turnId,
        itemId: item.itemId,
        update: { type: "output.replace", output },
      });
    }
    if (item.type === "commandExecution") {
      item.output = output.content
        .filter((v) => v.type === "text")
        .map((v) => v.text)
        .join("\n");
      if (output.truncated !== undefined) item.outputTruncated = output.truncated;
      const code = data.exitCode ?? record(data.data).exitCode;
      if (typeof code === "number") item.exitCode = code;
    }
    if (
      (item.type === "toolExecution" || item.type === "commandExecution") &&
      typeof p.duration === "number"
    )
      item.durationMs = p.duration;
    this.complete({ item, outcome });
    const changes = fileChanges(result);
    if (outcome.status === "succeeded" && changes.length)
      this.complete({
        item: {
          type: "fileChange",
          itemId: hostItemIdSchema.parse(`${id}:files`),
          changes,
          sourceItemIds: [item.itemId],
        },
        outcome,
      });
    const child = subagent(
      result,
      item.type === "toolExecution" ? item.arguments : {},
      text(p.toolName),
    );
    if (child)
      this.complete({
        item: {
          type: "subagentDelegation",
          itemId: hostItemIdSchema.parse(`${id}:agent`),
          operation: "spawn",
          subagents: [child],
        },
        outcome,
      });
  }
  reconcile(snapshots: readonly HostItemSnapshot[]) {
    const textItems = [...this.items.values()].filter(
      (item) => item.type === "agentMessage" || item.type === "reasoning",
    );
    for (const snapshot of snapshots) {
      if (this.items.has(snapshot.item.itemId)) {
        this.complete(snapshot);
        continue;
      }
      // Native text IDs can be assigned only when the streamed message is persisted.
      if (
        (snapshot.item.type === "agentMessage" || snapshot.item.type === "reasoning") &&
        textItems.some(
          (item) =>
            item.type === snapshot.item.type &&
            "text" in item &&
            item.text === (snapshot.item as { text: string }).text,
        )
      )
        continue;
      this.complete(snapshot);
    }
  }
  finish(outcome: HostItemOutcome) {
    for (const item of this.items.values())
      if (!this.completed.has(item.itemId)) this.complete({ item, outcome });
  }
  fault(error: HarnessError) {
    this.finish({ status: "failed", error });
  }
}
