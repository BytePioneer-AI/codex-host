import type {
  HistoricalTurnOutcome,
  HostItemOutcome,
  HostThreadSnapshot,
} from "@codexhost/harness-adapter";
import {
  harnessIdSchema,
  nativeCheckpointRefSchema,
  nativeTurnRefSchema,
  type HarnessId,
} from "@codexhost/shared-contracts";

import { claudeTranscriptItemId } from "./item-identity.js";

interface ClaudeHistoryMessage {
  type: "user" | "assistant";
  uuid: string;
  message: Record<string, unknown>;
  syntheticUser: boolean;
}

const claudeCodeHarnessId: HarnessId = harnessIdSchema.parse("claude-code");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textParts(value: unknown): string[] {
  if (typeof value === "string") return value.length > 0 ? [value] : [];
  if (!Array.isArray(value)) return [];
  return value.flatMap((part) =>
    isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : [],
  );
}

function thinkingParts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((part) =>
    isRecord(part) && part.type === "thinking" && typeof part.thinking === "string"
      ? [part.thinking]
      : [],
  );
}

const localCommandRecordPattern = /^\s*<(local-command-(?:stdout|caveat))>[\s\S]*<\/\1>\s*$/u;
const commandEnvelopePattern = /^\s*(?:<(command-(?:message|name|args))>[\s\S]*?<\/\1>\s*)+$/u;
const modelCommandNamePattern = /<command-name>\s*\/model\s*<\/command-name>/u;

function isLocalCommandRecord(text: string): boolean {
  return localCommandRecordPattern.test(text);
}

function isModelCommandEnvelope(text: string): boolean {
  return commandEnvelopePattern.test(text) && modelCommandNamePattern.test(text);
}

function visibleUserTextParts(message: ClaudeHistoryMessage): string[] {
  if (message.type !== "user" || message.syntheticUser) return [];
  const parts = textParts(message.message.content);
  if (parts.some(isModelCommandEnvelope)) return [];
  return parts.filter((part) => !isLocalCommandRecord(part));
}

function conversationMessages(values: unknown[], sessionId: string): ClaudeHistoryMessage[] {
  const messages: ClaudeHistoryMessage[] = [];
  const ids = new Set<string>();
  for (const value of values) {
    if (!isRecord(value)) throw new Error("Claude history contains a malformed message");
    if (value.type === "system") continue;
    if (
      (value.type !== "user" && value.type !== "assistant") ||
      typeof value.uuid !== "string" ||
      value.uuid.length === 0 ||
      value.session_id !== sessionId ||
      !isRecord(value.message) ||
      value.message.role !== value.type
    ) {
      throw new Error("Claude history contains an invalid message identity");
    }
    if (ids.has(value.uuid)) throw new Error("Claude history contains duplicate message IDs");
    ids.add(value.uuid);
    messages.push({
      type: value.type,
      uuid: value.uuid,
      message: value.message,
      syntheticUser:
        value.type === "user" &&
        (value.isSynthetic === true ||
          value.isMeta === true ||
          (value.toolUseResult !== undefined && value.toolUseResult !== null)),
    });
  }
  return messages;
}

function isHumanUser(message: ClaudeHistoryMessage): boolean {
  return visibleUserTextParts(message).length > 0;
}

function turnOutcome(messages: ClaudeHistoryMessage[]): HistoricalTurnOutcome {
  const assistants = messages.filter(({ type }) => type === "assistant");
  const failed = assistants.some(({ message }) => typeof message.error === "string");
  if (failed) {
    return {
      status: "failed",
      error: {
        code: "nativeFailure",
        message: "Claude Assistant failed",
        retryable: false,
      },
    };
  }
  const final = assistants.at(-1);
  if (!final) return { status: "unknown", reason: "Claude history has no Assistant terminal" };
  return {
    status: "unknown",
    reason: "Claude history does not include complete Result terminal evidence",
  };
}

function itemOutcome(outcome: HistoricalTurnOutcome): HostItemOutcome {
  if (outcome.status === "failed") return { status: "failed", error: outcome.error };
  if (outcome.status === "cancelled") {
    return {
      status: "cancelled",
      ...(outcome.reason ? { reason: outcome.reason } : {}),
    };
  }
  return { status: "succeeded" };
}

export function mapClaudeSnapshot(values: unknown[], sessionId: string): HostThreadSnapshot {
  const messages = conversationMessages(values, sessionId);
  const turns: HostThreadSnapshot["turns"] = [];
  for (let index = 0; index < messages.length;) {
    const user = messages[index];
    if (!user || !isHumanUser(user)) {
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < messages.length && !isHumanUser(messages[end] as ClaudeHistoryMessage)) end += 1;
    const turnMessages = messages.slice(index, end);
    const outcome = turnOutcome(turnMessages);
    const checkpointMessage = turnMessages.findLast(({ type }) => type === "assistant");
    let agentMessageOrdinal = 0;
    let reasoningOrdinal = 0;
    turns.push({
      nativeTurnRef: nativeTurnRefSchema.parse({
        harnessId: claudeCodeHarnessId,
        nativeSessionId: sessionId,
        nativeTurnKey: user.uuid,
        formatVersion: 1,
      }),
      ...(checkpointMessage
        ? {
            checkpoint: nativeCheckpointRefSchema.parse({
              harnessId: claudeCodeHarnessId,
              nativeSessionId: sessionId,
              checkpointId: checkpointMessage.uuid,
              formatVersion: 1,
            }),
          }
        : {}),
      input: visibleUserTextParts(user).map((text) => ({ type: "text", text })),
      items: turnMessages.flatMap((message) => {
        if (message.type !== "assistant") return [];
        const content = message.message.content;
        const text = textParts(content).join("");
        const reasoning = thinkingParts(content).join("");
        if (!Array.isArray(content)) {
          return text.length > 0
            ? [
                {
                  item: {
                    type: "agentMessage" as const,
                    itemId: claudeTranscriptItemId(
                      user.uuid,
                      "agentMessage",
                      (agentMessageOrdinal += 1),
                    ),
                    text,
                  },
                  outcome: itemOutcome(outcome),
                },
              ]
            : [];
        }
        const items = [];
        let projectedReasoning = false;
        let projectedText = false;
        for (const block of content) {
          if (!isRecord(block)) continue;
          if (block.type === "thinking" && !projectedReasoning && reasoning.length > 0) {
            items.push({
              item: {
                type: "reasoning" as const,
                itemId: claudeTranscriptItemId(user.uuid, "reasoning", (reasoningOrdinal += 1)),
                text: reasoning,
              },
              outcome: itemOutcome(outcome),
            });
            projectedReasoning = true;
          } else if (block.type === "text" && !projectedText && text.length > 0) {
            items.push({
              item: {
                type: "agentMessage" as const,
                itemId: claudeTranscriptItemId(
                  user.uuid,
                  "agentMessage",
                  (agentMessageOrdinal += 1),
                ),
                text,
              },
              outcome: itemOutcome(outcome),
            });
            projectedText = true;
          }
        }
        return items;
      }),
      outcome,
    });
    index = end;
  }
  return { turns };
}
