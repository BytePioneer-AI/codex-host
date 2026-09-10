import type { SessionNotification } from "@agentclientprotocol/sdk";
import type {
  HostEvent,
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
import { CursorSubagents } from "./subagents.js";

export class CursorTurnOutput {
  readonly subagents: CursorSubagents;
  #index = 0;
  #text: Extract<HostItem, { type: "agentMessage" | "reasoning" }> | undefined;
  readonly #tools = new Map<string, Extract<HostItem, { type: "toolExecution" }>>();
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
      let item = this.#tools.get(update.toolCallId);
      if (!item) {
        const args = jsonValueSchema.safeParse(update.rawInput ?? {});
        item = {
          type: "toolExecution",
          itemId: hostItemIdSchema.parse(`cursor-${this.turnId}-${++this.#index}`),
          toolName: update.title ?? "Cursor tool",
          arguments: args.success ? args.data : {},
        };
        this.#tools.set(update.toolCallId, item);
        this.emit({ type: "item.started", turnId: this.turnId, item: { ...item } });
      }
      if (update.content?.length) {
        const text = update.content
          .flatMap((content) =>
            content.type === "content" && content.content.type === "text"
              ? [content.content.text]
              : content.type === "diff"
                ? [`${content.path}\n${content.newText}`]
                : [],
          )
          .join("\n");
        if (text) {
          item.output = {
            content: [{ type: "text", text: text.slice(0, 100_000) }],
            truncated: text.length > 100_000,
          };
          this.emit({
            type: "item.updated",
            turnId: this.turnId,
            itemId: item.itemId,
            update: { type: "output.replace", output: item.output },
          });
        }
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
        this.#tools.delete(update.toolCallId);
        this.#finishedTools.add(update.toolCallId);
      }
    }
  }
  finish(outcome: HostItemOutcome) {
    this.subagents.finish(outcome);
    this.#finishText(outcome);
    for (const item of this.#tools.values())
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
): HostThreadSnapshot {
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
  return { turns };
}
