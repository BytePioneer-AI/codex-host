import { createHash } from "node:crypto";
import { createTwoFilesPatch } from "diff";
import type { SessionNotification, ToolCallContent } from "@agentclientprotocol/sdk";
import type {
  HostEvent,
  HostItem,
  HostItemOutcome,
  HostItemSnapshot,
  HostTurnSnapshot,
} from "@codexhost/harness-adapter";
import {
  hostItemIdSchema,
  hostTurnIdSchema,
  jsonValueSchema,
  nativeTurnRefSchema,
  type HostTurnId,
} from "@codexhost/shared-contracts";
import { TRAE_CLI_ID, TraeCliError } from "./common.js";

export const turnKey = (index: number, text: string) =>
  `${index}-${createHash("sha256").update(text).digest("hex")}`;
export class TurnProjection {
  #index = 0;
  #text: Extract<HostItem, { type: "agentMessage" | "reasoning" }> | undefined;
  #tools = new Map<
    string,
    { item: Extract<HostItem, { type: "toolExecution" }>; content: ToolCallContent[] }
  >();
  #completed = new Set<string>();
  readonly items: HostItemSnapshot[] = [];
  constructor(
    readonly turnId: HostTurnId,
    readonly key: string,
    readonly emit: (event: HostEvent) => void,
  ) {}
  #id() {
    return hostItemIdSchema.parse(`trae-${this.key}-${++this.#index}`);
  }
  #complete(item: HostItem, outcome: HostItemOutcome) {
    const snapshot = { item: structuredClone(item), outcome };
    this.items.push(snapshot);
    this.emit({ type: "item.completed", turnId: this.turnId, snapshot });
  }
  #finishText(outcome: HostItemOutcome = { status: "succeeded" }) {
    if (this.#text) this.#complete(this.#text, outcome);
    this.#text = undefined;
  }
  update(notification: SessionNotification) {
    const update = notification.update;
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
          itemId: this.#id(),
          text: "",
        };
        this.#text = item;
        this.emit({ type: "item.started", turnId: this.turnId, item });
      }
      const item = this.#text;
      if (!item) throw new TraeCliError("protocolError", "Missing TRAE CLI text Item");
      item.text += update.content.text;
      this.emit({
        type: "item.updated",
        turnId: this.turnId,
        itemId: item.itemId,
        update: { type: "text.append", text: update.content.text },
      });
    } else if (
      update.sessionUpdate === "tool_call" ||
      update.sessionUpdate === "tool_call_update"
    ) {
      this.#finishText();
      if (this.#completed.has(update.toolCallId)) return;
      let tool = this.#tools.get(update.toolCallId);
      if (!tool) {
        const parsed = jsonValueSchema.safeParse(update.rawInput ?? {});
        tool = {
          item: {
            type: "toolExecution",
            itemId: this.#id(),
            toolName: update.title ?? update.kind ?? "TRAE CLI tool",
            arguments: parsed.success ? parsed.data : {},
          },
          content: [],
        };
        this.#tools.set(update.toolCallId, tool);
        this.emit({ type: "item.started", turnId: this.turnId, item: structuredClone(tool.item) });
      }
      if (update.content != null) {
        tool.content = update.content;
        const text = update.content
          .flatMap((content) =>
            content.type === "content" && content.content.type === "text"
              ? [content.content.text]
              : [],
          )
          .join("\n");
        tool.item.output = {
          content: [{ type: "text", text: text.slice(0, 100_000) }],
          ...(text.length > 100_000 ? { truncated: true } : {}),
        };
        this.emit({
          type: "item.updated",
          turnId: this.turnId,
          itemId: tool.item.itemId,
          update: { type: "output.replace", output: tool.item.output },
        });
      }
      if (update.status === "completed" || update.status === "failed") {
        const outcome: HostItemOutcome =
          update.status === "completed"
            ? { status: "succeeded" }
            : {
                status: "failed",
                error: { code: "nativeFailure", message: "TRAE CLI tool failed", retryable: false },
              };
        this.#complete(tool.item, outcome);
        if (update.status === "completed") {
          const changes = tool.content.flatMap((content) =>
            content.type === "diff"
              ? [
                  {
                    path: content.path,
                    kind: content.oldText === null ? ("add" as const) : ("update" as const),
                    unifiedDiff: createTwoFilesPatch(
                      content.path,
                      content.path,
                      content.oldText ?? "",
                      content.newText,
                    ),
                  },
                ]
              : [],
          );
          if (changes.length) {
            const item: HostItem = {
              type: "fileChange",
              itemId: this.#id(),
              changes,
              sourceItemIds: [tool.item.itemId],
            };
            this.emit({ type: "item.started", turnId: this.turnId, item });
            this.#complete(item, { status: "succeeded" });
          }
        }
        this.#tools.delete(update.toolCallId);
        this.#completed.add(update.toolCallId);
      }
    }
  }
  finish(outcome: HostItemOutcome) {
    this.#finishText(outcome);
    for (const { item } of this.#tools.values())
      this.#complete(
        item,
        outcome.status === "succeeded"
          ? {
              status: "failed",
              error: {
                code: "protocolError",
                message: "TRAE CLI did not confirm tool completion",
                retryable: false,
              },
            }
          : outcome,
      );
    this.#tools.clear();
  }
}

/** ACP replay does not guarantee native message IDs or historical stop reasons.
 * Keys use the persisted user boundary and input digest; known refs detect prefix changes.
 * Adjacent user chunks are one boundary. Ambiguous/native-truncated histories fail alignment.
 */
export function history(sessionId: string, replay: SessionNotification[]): HostTurnSnapshot[] {
  const groups: { text: string; events: SessionNotification[] }[] = [];
  let user = false;
  for (const event of replay) {
    if (event.sessionId !== sessionId)
      throw new TraeCliError("protocolError", "TRAE CLI replay Session mismatch");
    if (event.update.sessionUpdate === "user_message_chunk") {
      if (event.update.content.type !== "text")
        throw new TraeCliError("unsupported", "TRAE CLI non-text historical input is unsupported");
      const last = groups.at(-1);
      if (user && last) last.text += event.update.content.text;
      else groups.push({ text: event.update.content.text, events: [] });
      user = true;
    } else if (
      ["agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update"].includes(
        event.update.sessionUpdate,
      )
    ) {
      const last = groups.at(-1);
      if (!last) throw new TraeCliError("protocolError", "TRAE CLI replay omits a user boundary");
      last.events.push(event);
      user = false;
    }
  }
  return groups.map((group, index) => {
    const key = turnKey(index, group.text);
    const projection = new TurnProjection(hostTurnIdSchema.parse(`history-${key}`), key, () => {});
    for (const event of group.events) projection.update(event);
    projection.finish({ status: "succeeded" });
    return {
      nativeTurnRef: nativeTurnRefSchema.parse({
        harnessId: TRAE_CLI_ID,
        nativeSessionId: sessionId,
        nativeTurnKey: key,
        formatVersion: 1,
      }),
      input: [{ type: "text", text: group.text }],
      items: projection.items,
      outcome: {
        status: "unknown",
        reason: "ACP replay does not expose the historical stop reason",
      },
    };
  });
}
