import type { SessionNotification, ToolCallContent } from "@agentclientprotocol/sdk";
import { createTwoFilesPatch } from "diff";
import type {
  HostEvent,
  HostFileChange,
  HostItem,
  HostItemOutcome,
  HostItemSnapshot,
  HostThreadSnapshot,
  HostTurnSnapshot,
} from "@codexhost/harness-adapter";
import {
  hostItemIdSchema,
  hostTurnIdSchema,
  jsonValueSchema,
  nativeTurnRefSchema,
  type HostTurnId,
} from "@codexhost/shared-contracts";
import type { CursorNativeTurn } from "./native-history.js";
import { CursorSubagents, cursorTaskAddress } from "./subagents.js";

const TOOL_OUTPUT_LIMIT = 100_000;

function cursorFileChanges(content: ToolCallContent[]): HostFileChange[] {
  const changes: HostFileChange[] = [];
  let remaining = TOOL_OUTPUT_LIMIT;
  for (const entry of content) {
    if (entry.type !== "diff" || entry.oldText === entry.newText) continue;
    // Cursor 2026.09.10's new-file diffString fallback includes patch headers
    // as content and loses newline information. Do not fabricate a repaired file.
    const leakedHeader = `++ b/${entry.path}`;
    if (
      entry.oldText === "-- /dev/null" &&
      (entry.newText === leakedHeader || entry.newText.startsWith(`${leakedHeader}\n`))
    )
      continue;
    const kind = entry.oldText == null ? "add" : "update";
    const unifiedDiff = createTwoFilesPatch(
      kind === "add" ? "/dev/null" : entry.path,
      entry.path,
      entry.oldText ?? "",
      entry.newText,
      undefined,
      undefined,
      { timeout: 100 },
    );
    // A fileChange has no truncation marker. Keep whole patches or only tool output.
    if (unifiedDiff === undefined || unifiedDiff.length > remaining) continue;
    changes.push({ path: entry.path, kind, unifiedDiff });
    remaining -= unifiedDiff.length;
  }
  return changes;
}

export class CursorTurnOutput {
  readonly subagents: CursorSubagents;
  #index = 0;
  #text: Extract<HostItem, { type: "agentMessage" | "reasoning" }> | undefined;
  readonly #tools = new Map<
    string,
    { item: Extract<HostItem, { type: "toolExecution" }>; changes: HostFileChange[] }
  >();
  readonly #finishedTools = new Set<string>();
  constructor(
    readonly turnId: HostTurnId,
    readonly emit: (event: HostEvent) => void,
    nativeTurnIndex = 0,
  ) {
    this.subagents = new CursorSubagents(turnId, emit, nativeTurnIndex);
  }

  #finishText(outcome: HostItemOutcome = { status: "succeeded" }) {
    if (this.#text)
      this.emit({
        type: "item.completed",
        turnId: this.turnId,
        snapshot: { item: this.#text, outcome },
      });
    this.#text = undefined;
  }
  update(notification: SessionNotification) {
    if (this.subagents.update(notification)) {
      this.#finishText();
      return;
    }
    const { update } = notification;
    if (
      update.sessionUpdate === "agent_message_chunk" ||
      update.sessionUpdate === "agent_thought_chunk"
    ) {
      if (update.content.type !== "text") return;
      const type = update.sessionUpdate === "agent_message_chunk" ? "agentMessage" : "reasoning";
      if (this.#text?.type !== type) {
        this.#finishText();
        const item: Extract<HostItem, { type: "agentMessage" | "reasoning" }> = {
          type,
          itemId: hostItemIdSchema.parse(`cursor-${this.turnId}-${++this.#index}`),
          text: "",
        };
        this.#text = item;
        this.emit({ type: "item.started", turnId: this.turnId, item: { ...item } });
      }
      if (!this.#text) return;
      this.#text.text += update.content.text;
      this.emit({
        type: "item.updated",
        turnId: this.turnId,
        itemId: this.#text.itemId,
        update: { type: "text.append", text: update.content.text },
      });
    } else if (
      update.sessionUpdate === "tool_call" ||
      update.sessionUpdate === "tool_call_update"
    ) {
      this.#finishText();
      if (this.#finishedTools.has(update.toolCallId)) return;
      let tool = this.#tools.get(update.toolCallId);
      if (!tool) {
        const args = jsonValueSchema.safeParse(update.rawInput ?? {});
        const item: Extract<HostItem, { type: "toolExecution" }> = {
          type: "toolExecution",
          itemId: hostItemIdSchema.parse(`cursor-${this.turnId}-${++this.#index}`),
          toolName: update.title ?? "Cursor tool",
          arguments: args.success ? args.data : {},
        };
        tool = { item, changes: [] };
        this.#tools.set(update.toolCallId, tool);
        this.emit({ type: "item.started", turnId: this.turnId, item: { ...item } });
      }
      const { item } = tool;
      if (update.content != null) {
        // ACP content replaces the collection; status-only updates retain it.
        tool.changes = cursorFileChanges(update.content);
        const text = update.content
          .flatMap((content) =>
            content.type === "content" && content.content.type === "text"
              ? [content.content.text]
              : content.type === "diff"
                ? [`${content.path}\n${content.newText}`]
                : [],
          )
          .join("\n");
        item.output = {
          content: [{ type: "text", text: text.slice(0, TOOL_OUTPUT_LIMIT) }],
          truncated: text.length > TOOL_OUTPUT_LIMIT,
        };
        this.emit({
          type: "item.updated",
          turnId: this.turnId,
          itemId: item.itemId,
          update: { type: "output.replace", output: item.output },
        });
      }
      if (update.status === "completed" || update.status === "failed") {
        this.emit({
          type: "item.completed",
          turnId: this.turnId,
          snapshot: {
            item,
            outcome:
              update.status === "completed"
                ? { status: "succeeded" }
                : {
                    status: "failed",
                    error: {
                      code: "nativeFailure",
                      message: "Cursor tool failed",
                      retryable: false,
                    },
                  },
          },
        });
        if (update.status === "completed" && tool.changes.length) {
          const change: HostItem = {
            type: "fileChange",
            itemId: hostItemIdSchema.parse(`cursor-${this.turnId}-${++this.#index}`),
            changes: tool.changes,
          };
          this.emit({ type: "item.started", turnId: this.turnId, item: change });
          this.emit({
            type: "item.completed",
            turnId: this.turnId,
            snapshot: { item: change, outcome: { status: "succeeded" } },
          });
        }
        this.#tools.delete(update.toolCallId);
        this.#finishedTools.add(update.toolCallId);
      }
    }
  }
  finish(outcome: HostItemOutcome) {
    this.subagents.finish(outcome);
    this.#finishText(outcome);
    for (const { item } of this.#tools.values())
      this.emit({
        type: "item.completed",
        turnId: this.turnId,
        snapshot: {
          item,
          outcome:
            outcome.status === "succeeded"
              ? {
                  status: "failed",
                  error: {
                    code: "protocolError",
                    message: "Cursor did not report tool completion",
                    retryable: false,
                  },
                }
              : outcome,
        },
      });
    this.#tools.clear();
  }
}

export function cursorSnapshot(
  sessionId: string,
  native: CursorNativeTurn[],
  replay: SessionNotification[],
  nativeSubagentId?: string,
): HostThreadSnapshot {
  const address = nativeSubagentId === undefined ? undefined : cursorTaskAddress(nativeSubagentId);
  let childSnapshot: HostThreadSnapshot | undefined;
  const groups: Array<{ text: string; events: SessionNotification[] }> = [];
  for (const notification of replay) {
    if (notification.sessionId !== sessionId) throw new Error("Cursor replay session mismatch");
    if (notification.update.sessionUpdate === "user_message_chunk") {
      if (notification.update.content.type !== "text")
        throw new Error("Cursor replay contains unsupported non-text user input");
      groups.push({ text: notification.update.content.text, events: [] });
    } else groups.at(-1)?.events.push(notification);
  }
  if (groups.length !== native.length) throw new Error("Cursor replay/native turn count mismatch");
  const turns: HostTurnSnapshot[] = groups.map((group, index) => {
    const identity = native[index];
    if (!identity || identity.text !== group.text)
      throw new Error("Cursor replay/native prompt mismatch");
    const items: HostItemSnapshot[] = [];
    const output = new CursorTurnOutput(
      hostTurnIdSchema.parse(identity.id),
      (event) => {
        if (event.type === "item.completed") items.push(event.snapshot);
      },
      index,
    );
    for (const event of group.events) output.update(event);
    output.finish({ status: "succeeded" });
    if (address?.turnIndex === index && nativeSubagentId !== undefined) {
      // Reuse the replayed Task's full output, not its abbreviated card summary.
      childSnapshot = output.subagents.snapshot(sessionId, nativeSubagentId);
    }
    return {
      nativeTurnRef: nativeTurnRefSchema.parse({
        harnessId: "cursor-cli",
        nativeSessionId: sessionId,
        nativeTurnKey: identity.id,
        formatVersion: 1,
      }),
      input: [{ type: "text", text: group.text }],
      items,
      outcome: {
        status: "unknown",
        reason: "Cursor ACP history does not expose the terminal stop reason",
      },
    };
  });
  if (nativeSubagentId !== undefined) {
    if (!childSnapshot) throw new Error("Native Cursor Task not found in this parent");
    return childSnapshot;
  }
  return { turns };
}
