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

const TOOL_OUTPUT_LIMIT = 100_000;
const DEVIN_TURN_KEY = "cognition.ai/clientMessageId";
const DEVIN_TURN_RESULT_KEY = "cognition.ai/userMessageId";

function meta(notification: SessionNotification): Record<string, unknown> {
  const value = (notification.update as { _meta?: unknown })._meta;
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Stable native User Turn key carried by session/load replay, when present. */
export function devinReplayTurnKey(notification: SessionNotification): string | undefined {
  const value = meta(notification)[DEVIN_TURN_KEY];
  return typeof value === "string" && value ? value : undefined;
}

/** Stable native User Turn key returned by a settled session/prompt call. */
export function devinPromptTurnKey(result: unknown): string | undefined {
  const value =
    typeof result === "object" && result !== null
      ? (result as { _meta?: Record<string, unknown> })._meta?.[DEVIN_TURN_RESULT_KEY]
      : undefined;
  return typeof value === "string" && value ? value : undefined;
}

function devinToolName(update: {
  title?: string | null;
  kind?: string | null;
  _meta?: unknown;
}): string {
  const metaValue =
    typeof update._meta === "object" && update._meta !== null
      ? (update._meta as Record<string, unknown>)["cognition.ai/inferenceToolName"]
      : undefined;
  if (typeof metaValue === "string" && metaValue.trim()) return metaValue;
  return update.title ?? update.kind ?? "Devin tool";
}

function devinFileChanges(content: ToolCallContent[]): HostFileChange[] {
  const changes: HostFileChange[] = [];
  let remaining = TOOL_OUTPUT_LIMIT;
  for (const entry of content) {
    if (entry.type !== "diff" || entry.oldText === entry.newText) continue;
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
    if (unifiedDiff === undefined || unifiedDiff.length > remaining) continue;
    changes.push({ path: entry.path, kind, unifiedDiff });
    remaining -= unifiedDiff.length;
  }
  return changes;
}

export class DevinTurnOutput {
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
  ) {}

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
          itemId: hostItemIdSchema.parse(`devin-${this.turnId}-${++this.#index}`),
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
          itemId: hostItemIdSchema.parse(`devin-${this.turnId}-${++this.#index}`),
          toolName: devinToolName(update),
          arguments: args.success ? args.data : {},
        };
        tool = { item, changes: [] };
        this.#tools.set(update.toolCallId, tool);
        this.emit({ type: "item.started", turnId: this.turnId, item: { ...item } });
      }
      const { item } = tool;
      if (update.content != null) {
        // ACP content replaces the collection; status-only updates retain it.
        tool.changes = devinFileChanges(update.content);
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
                      message: "Devin tool failed",
                      retryable: false,
                    },
                  },
          },
        });
        if (update.status === "completed" && tool.changes.length) {
          const change: HostItem = {
            type: "fileChange",
            itemId: hostItemIdSchema.parse(`devin-${this.turnId}-${++this.#index}`),
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
                    message: "Devin did not report tool completion",
                    retryable: false,
                  },
                }
              : outcome,
        },
      });
    this.#tools.clear();
  }
}

/**
 * Map a session/load replay into Host Turns. Devin tags every replayed
 * user_message_chunk with the same `cognition.ai/clientMessageId` returned as
 * `cognition.ai/userMessageId` by the live prompt response, so both paths agree
 * on Native Turn identity without touching Devin's local session store.
 */
export function devinSnapshot(
  sessionId: string,
  replay: SessionNotification[],
): HostThreadSnapshot {
  const groups: Array<{ key: string; text: string; events: SessionNotification[] }> = [];
  for (const notification of replay) {
    if (notification.sessionId !== sessionId) throw new Error("Devin replay session mismatch");
    if (notification.update.sessionUpdate === "user_message_chunk") {
      if (notification.update.content.type !== "text")
        throw new Error("Devin replay contains unsupported non-text user input");
      const key = devinReplayTurnKey(notification);
      if (!key) throw new Error("Devin replay user message has no stable native identity");
      const last = groups.at(-1);
      if (last && last.key === key) last.text += notification.update.content.text;
      else groups.push({ key, text: notification.update.content.text, events: [] });
    } else groups.at(-1)?.events.push(notification);
  }
  const turns: HostTurnSnapshot[] = groups.map((group) => {
    const items: HostItemSnapshot[] = [];
    const output = new DevinTurnOutput(hostTurnIdSchema.parse(`history-${group.key}`), (event) => {
      if (event.type === "item.completed") items.push(event.snapshot);
    });
    for (const event of group.events) output.update(event);
    output.finish({ status: "succeeded" });
    return {
      nativeTurnRef: nativeTurnRefSchema.parse({
        harnessId: "devin",
        nativeSessionId: sessionId,
        nativeTurnKey: group.key,
        formatVersion: 1,
      }),
      input: [{ type: "text", text: group.text }],
      items,
      outcome: {
        status: "unknown",
        reason: "Devin ACP history does not expose the terminal stop reason",
      },
    };
  });
  return { turns };
}
