import type {
  HistoricalTurnOutcome,
  HostItemOutcome,
  HostThreadSnapshot,
} from "@codexhost/harness-adapter";
import {
  harnessIdSchema,
  hostItemIdSchema,
  nativeCheckpointRefSchema,
  nativeTurnRefSchema,
  type HarnessId,
} from "@codexhost/shared-contracts";

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
                    itemId: hostItemIdSchema.parse(`claude-item-v1-${message.uuid}`),
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
                itemId: hostItemIdSchema.parse(`claude-item-v1-${message.uuid}-reasoning`),
                text: reasoning,
              },
              outcome: itemOutcome(outcome),
            });
            projectedReasoning = true;
          } else if (block.type === "text" && !projectedText && text.length > 0) {
            items.push({
              item: {
                type: "agentMessage" as const,
                itemId: hostItemIdSchema.parse(`claude-item-v1-${message.uuid}`),
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

export function mapClaudeSubagentSnapshot(
  values: unknown[],
  parentSessionId: string,
  nativeSubagentId: string,
): HostThreadSnapshot {
  const messages = conversationMessages(
    values.map((value) => (isRecord(value) ? { ...value, session_id: parentSessionId } : value)),
    parentSessionId,
  );
  const turns: HostThreadSnapshot["turns"] = [];
  let pendingInput: HostThreadSnapshot["turns"][number]["input"] = [];
  let ordinal = 0;
  for (let index = 0; index < messages.length;) {
    const message = messages[index];
    if (!message) break;
    if (message.type === "user") {
      pendingInput = visibleUserTextParts(message).map((text) => ({ type: "text", text }));
      index += 1;
      continue;
    }
    const assistantId =
      isRecord(message.message) && typeof message.message.id === "string"
        ? message.message.id
        : message.uuid;
    let end = index + 1;
    while (
      end < messages.length &&
      messages[end]?.type === "assistant" &&
      ((isRecord(messages[end]?.message) && messages[end]?.message.id === assistantId) ||
        messages[end]?.uuid === message.uuid)
    ) {
      end += 1;
    }
    const group = messages.slice(index, end);
    const content = group.flatMap((entry) =>
      Array.isArray(entry.message.content) ? entry.message.content : [],
    );
    const text = textParts(content).join("");
    const reasoning = thinkingParts(content).join("");
    if (text.length > 0 || reasoning.length > 0) {
      ordinal += 1;
      const outcome: HistoricalTurnOutcome = {
        status: "unknown",
        reason: "Claude Subagent history does not include complete Result terminal evidence",
      };
      const items = [];
      if (reasoning.length > 0) {
        items.push({
          item: {
            type: "reasoning" as const,
            itemId: hostItemIdSchema.parse(
              `claude-subagent-item-v1-${nativeSubagentId}-${ordinal}-reasoning`,
            ),
            text: reasoning,
          },
          outcome: itemOutcome(outcome),
        });
      }
      if (text.length > 0) {
        items.push({
          item: {
            type: "agentMessage" as const,
            itemId: hostItemIdSchema.parse(
              `claude-subagent-item-v1-${nativeSubagentId}-${ordinal}`,
            ),
            text,
          },
          outcome: itemOutcome(outcome),
        });
      }
      turns.push({
        nativeTurnRef: nativeTurnRefSchema.parse({
          harnessId: claudeCodeHarnessId,
          nativeSessionId: parentSessionId,
          nativeTurnKey: `subagent-turn-${ordinal}-${assistantId}`,
          formatVersion: 1,
        }),
        checkpoint: nativeCheckpointRefSchema.parse({
          harnessId: claudeCodeHarnessId,
          nativeSessionId: parentSessionId,
          checkpointId: group.at(-1)?.uuid ?? message.uuid,
          formatVersion: 1,
        }),
        input: pendingInput,
        items,
        outcome,
      });
      pendingInput = [];
    }
    index = end;
  }
  return { turns };
}
