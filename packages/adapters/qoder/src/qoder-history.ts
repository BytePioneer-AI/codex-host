import type {
  HistoricalTurnOutcome,
  HostContextCompactionItem,
  HostItemOutcome,
  HostThreadSnapshot,
  HostTurnSnapshot,
} from "@codexhost/harness-adapter";
import {
  harnessIdSchema,
  hostItemIdSchema,
  nativeCheckpointRefSchema,
  nativeTurnRefSchema,
  type HarnessId,
  type JsonValue,
} from "@codexhost/shared-contracts";

import type { SessionMessage } from "./qoder-sdk-types.js";
import { isQoderCompactionCommand } from "./qoder-slash-commands.js";

const qoderHarnessId: HarnessId = harnessIdSchema.parse("qoder");

interface ToolResultInfo {
  content: string;
  isError: boolean;
}

export function extractUserText(message: SessionMessage): string {
  const raw = (message.message as Record<string, unknown> | undefined)?.content;
  let text = "";
  if (typeof raw === "string") {
    text = raw;
  } else if (Array.isArray(raw)) {
    const parts: string[] = [];
    for (const block of raw) {
      if (typeof block === "object" && block !== null) {
        const b = block as Record<string, unknown>;
        if (b.type === "text" && typeof b.text === "string") {
          parts.push(b.text);
        }
      }
    }
    text = parts.join("\n");
  }

  // Strip local command caveats
  text = text.replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/gu, "").trim();

  // If message contains command envelopes, extract command name or text
  const cmdNameMatch = /<command-name>\s*(\/[^\s<]+)\s*<\/command-name>/u.exec(text);
  if (cmdNameMatch?.[1]) {
    return cmdNameMatch[1];
  }
  const cmdMsgMatch = /<command-message>([\s\S]*?)<\/command-message>/u.exec(text);
  if (cmdMsgMatch?.[1]) {
    return cmdMsgMatch[1].trim();
  }
  return text;
}

export function isHumanUser(message: SessionMessage): boolean {
  if (message.type !== "user") return false;
  if (message.parent_tool_use_id !== null && message.parent_tool_use_id !== undefined) return false;
  if (message.tool_use_result !== null && message.tool_use_result !== undefined) return false;

  const raw = (message.message as Record<string, unknown> | undefined)?.content;
  if (Array.isArray(raw)) {
    if (
      raw.length > 0 &&
      raw.every(
        (b) =>
          typeof b === "object" &&
          b !== null &&
          (b as Record<string, unknown>).type === "tool_result",
      )
    ) {
      return false;
    }
  }

  const text = extractUserText(message);
  return text.trim().length > 0;
}

function collectToolResults(messages: readonly SessionMessage[]): Map<string, ToolResultInfo> {
  const results = new Map<string, ToolResultInfo>();
  for (const message of messages) {
    if (message.type !== "user") continue;
    const raw = (message.message as Record<string, unknown> | undefined)?.content;
    if (Array.isArray(raw)) {
      for (const block of raw) {
        if (typeof block === "object" && block !== null) {
          const b = block as Record<string, unknown>;
          if (b.type === "tool_result" && typeof b.tool_use_id === "string") {
            const isError = b.is_error === true;
            let content = "";
            if (typeof b.content === "string") {
              content = b.content;
            } else if (Array.isArray(b.content)) {
              content = b.content
                .map((part) =>
                  typeof part === "object" &&
                  part !== null &&
                  (part as Record<string, unknown>).type === "text"
                    ? String((part as Record<string, unknown>).text)
                    : JSON.stringify(part),
                )
                .join("\n");
            } else if (b.content !== undefined && b.content !== null) {
              content = JSON.stringify(b.content);
            }
            results.set(b.tool_use_id, { content, isError });
          }
        }
      }
    }
  }
  return results;
}

export function mapQoderSnapshot(
  messages: readonly SessionMessage[],
  sessionId: string,
): HostThreadSnapshot {
  const turns: HostTurnSnapshot[] = [];

  for (let index = 0; index < messages.length;) {
    const user = messages[index];
    if (!user || !isHumanUser(user)) {
      index += 1;
      continue;
    }

    let end = index + 1;
    while (end < messages.length) {
      const nextMsg = messages[end];
      if (!nextMsg || isHumanUser(nextMsg)) {
        break;
      }
      end += 1;
    }

    const turnMessages = messages.slice(index, end);
    const toolResults = collectToolResults(turnMessages);

    const checkpointMessage = turnMessages.findLast((m) => m.type === "assistant");
    const checkpoint = checkpointMessage
      ? nativeCheckpointRefSchema.parse({
          harnessId: qoderHarnessId,
          nativeSessionId: sessionId,
          checkpointId: checkpointMessage.uuid,
          formatVersion: 1,
        })
      : undefined;

    const nativeTurnRef = nativeTurnRefSchema.parse({
      harnessId: qoderHarnessId,
      nativeSessionId: sessionId,
      nativeTurnKey: user.uuid,
      formatVersion: 1,
    });

    const userText = extractUserText(user);
    const input = userText.length > 0 ? [{ type: "text" as const, text: userText }] : [];

    const hasError = turnMessages.some(
      (m) =>
        m.type === "assistant" &&
        (m.isApiErrorMessage ||
          (typeof m.message === "object" &&
            m.message !== null &&
            Boolean((m.message as Record<string, unknown>).error))),
    );

    const outcome: HistoricalTurnOutcome = hasError
      ? {
          status: "failed",
          error: {
            code: "nativeFailure",
            message: "Qoder Turn failed",
            retryable: false,
          },
        }
      : { status: "succeeded" };

    const firstWord = userText.trim().split(/\s+/)[0] ?? "";
    const isCompactionTurn = isQoderCompactionCommand(firstWord);

    const items: HostTurnSnapshot["items"] = [];

    if (isCompactionTurn) {
      const compactionItem: HostContextCompactionItem = {
        type: "contextCompaction",
        itemId: hostItemIdSchema.parse(`qoder-compact-${user.uuid}`),
      };
      items.push({
        item: compactionItem,
        outcome: { status: "succeeded" },
      });
    } else {
      const hasCompactBoundary = turnMessages.some(
        (m) => m.type === "system" && (m as Record<string, unknown>).subtype === "compact_boundary",
      );
      if (hasCompactBoundary) {
        const compactionItem: HostContextCompactionItem = {
          type: "contextCompaction",
          itemId: hostItemIdSchema.parse(`qoder-compact-boundary-${user.uuid}`),
        };
        items.push({
          item: compactionItem,
          outcome: { status: "succeeded" },
        });
      }

      const lastAssistantIdx = turnMessages.findLastIndex((m) => m.type === "assistant");

      for (let msgIdx = 0; msgIdx < turnMessages.length; msgIdx += 1) {
        const message = turnMessages[msgIdx];
        if (!message || message.type !== "assistant") continue;

        const isLastAssistant = msgIdx === lastAssistantIdx;
        const content = (message.message as Record<string, unknown> | undefined)?.content;

        if (typeof content === "string" && content.length > 0) {
          items.push({
            item: {
              type: "agentMessage",
              itemId: hostItemIdSchema.parse(`qoder-item-${message.uuid}-0`),
              text: content,
              phase: isLastAssistant ? "final_answer" : "commentary",
            },
            outcome: { status: "succeeded" },
          });
          continue;
        }

        if (Array.isArray(content)) {
          const hasSubsequentToolUse = content.some(
            (b) =>
              typeof b === "object" &&
              b !== null &&
              (b as Record<string, unknown>).type === "tool_use",
          );

          for (let blockIndex = 0; blockIndex < content.length; blockIndex += 1) {
            const block = content[blockIndex];
            if (typeof block !== "object" || block === null) continue;
            const rawBlock = block as Record<string, unknown>;

            if (rawBlock.type === "thinking" && typeof rawBlock.thinking === "string") {
              items.push({
                item: {
                  type: "reasoning",
                  itemId: hostItemIdSchema.parse(
                    `qoder-item-${message.uuid}-thinking-${blockIndex}`,
                  ),
                  text: rawBlock.thinking,
                },
                outcome: { status: "succeeded" },
              });
              continue;
            }

            if (rawBlock.type === "text" && typeof rawBlock.text === "string") {
              const isFinalAnswer = isLastAssistant && !hasSubsequentToolUse;
              items.push({
                item: {
                  type: "agentMessage",
                  itemId: hostItemIdSchema.parse(`qoder-item-${message.uuid}-text-${blockIndex}`),
                  text: rawBlock.text,
                  phase: isFinalAnswer ? "final_answer" : "commentary",
                },
                outcome: { status: "succeeded" },
              });
              continue;
            }

            if (
              rawBlock.type === "tool_use" &&
              typeof rawBlock.id === "string" &&
              typeof rawBlock.name === "string"
            ) {
              const res = toolResults.get(rawBlock.id);
              const isError = res?.isError === true;
              const output = res?.content;
              const toolOutcome: HostItemOutcome = isError
                ? {
                    status: "failed",
                    error: {
                      code: "nativeFailure",
                      message: output || `Tool '${rawBlock.name}' failed`,
                      retryable: false,
                    },
                  }
                : { status: "succeeded" };

              const itemId = hostItemIdSchema.parse(`qoder-item-${rawBlock.id}`);

              if (
                rawBlock.name === "Bash" &&
                typeof rawBlock.input === "object" &&
                rawBlock.input !== null &&
                typeof (rawBlock.input as Record<string, unknown>).command === "string"
              ) {
                items.push({
                  item: {
                    type: "commandExecution",
                    itemId,
                    command: (rawBlock.input as Record<string, unknown>).command as string,
                    ...(output ? { output } : {}),
                    exitCode: isError ? 1 : 0,
                  },
                  outcome: toolOutcome,
                });
                continue;
              }

              items.push({
                item: {
                  type: "toolExecution",
                  itemId,
                  toolName: rawBlock.name,
                  arguments: rawBlock.input as JsonValue,
                  ...(output ? { output: { content: [{ type: "text", text: output }] } } : {}),
                },
                outcome: toolOutcome,
              });
            }
          }
        }
      }
    }

    turns.push({
      nativeTurnRef,
      ...(checkpoint ? { checkpoint } : {}),
      input,
      items,
      outcome,
    });

    index = end;
  }

  return { turns };
}
