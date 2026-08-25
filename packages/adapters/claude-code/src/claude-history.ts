import type {
  HistoricalTurnOutcome,
  HostItemOutcome,
  HostThreadSnapshot,
} from "@codexhost/harness-adapter";
import {
  harnessIdSchema,
  hostItemIdSchema,
  jsonValueSchema,
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
const taskNotificationRecordPattern = /^\s*<task-notification>[\s\S]*<\/task-notification>\s*$/u;
const commandEnvelopePattern = /^\s*(?:<(command-(?:message|name|args))>[\s\S]*?<\/\1>\s*)+$/u;
const controlCommandNamePattern = /<command-name>\s*\/(?:model|compact)\s*<\/command-name>/u;

function isLocalCommandRecord(text: string): boolean {
  return localCommandRecordPattern.test(text);
}

function isTaskNotificationRecord(text: string): boolean {
  return taskNotificationRecordPattern.test(text);
}

function isControlCommandEnvelope(text: string): boolean {
  return commandEnvelopePattern.test(text) && controlCommandNamePattern.test(text);
}

function isTaskNotificationOrigin(value: Record<string, unknown>): boolean {
  return isRecord(value.origin) && value.origin.kind === "task-notification";
}

function visibleUserTextParts(message: ClaudeHistoryMessage): string[] {
  if (message.type !== "user" || message.syntheticUser) return [];
  const parts = textParts(message.message.content);
  if (parts.some(isControlCommandEnvelope)) return [];
  return parts.filter((part) => !isLocalCommandRecord(part) && !isTaskNotificationRecord(part));
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
          isTaskNotificationOrigin(value) ||
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
    const results = toolResultBlocks(turnMessages);
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
        const items: HostThreadSnapshot["turns"][number]["items"] = [];
        let projectedReasoning = false;
        let projectedText = false;
        for (const [blockIndex, block] of content.entries()) {
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
            continue;
          }
          if (block.type === "text" && !projectedText && text.length > 0) {
            items.push({
              item: {
                type: "agentMessage" as const,
                itemId: hostItemIdSchema.parse(`claude-item-v1-${message.uuid}`),
                text,
              },
              outcome: itemOutcome(outcome),
            });
            projectedText = true;
            continue;
          }
          if (
            block.type !== "tool_use" ||
            typeof block.id !== "string" ||
            typeof block.name !== "string"
          ) {
            continue;
          }
          const result = results.get(block.id);
          if (!result) continue;
          const output = toolResultOutput(result);
          const failed = result.is_error === true;
          const toolOutcome: HostItemOutcome = failed
            ? {
                status: "failed",
                error: {
                  code: "nativeFailure",
                  message: `${block.name} failed`,
                  retryable: false,
                },
              }
            : { status: "succeeded" };
          const itemId = hostItemIdSchema.parse(
            `claude-item-v1-${message.uuid}-tool-${blockIndex}`,
          );
          if (
            block.name === "Bash" &&
            isRecord(block.input) &&
            typeof block.input.command === "string"
          ) {
            items.push({
              item: {
                type: "commandExecution",
                itemId,
                command: block.input.command,
                ...(output ? { output } : {}),
              },
              outcome: toolOutcome,
            });
            continue;
          }
          const argumentsResult = jsonValueSchema.safeParse(block.input);
          items.push({
            item: {
              type: "toolExecution",
              itemId,
              toolName: block.name,
              arguments: argumentsResult.success ? argumentsResult.data : null,
              ...(output ? { output: { content: [{ type: "text" as const, text: output }] } } : {}),
            },
            outcome: toolOutcome,
          });
        }
        return items;
      }),
      outcome,
    });
    index = end;
  }
  return { turns };
}

function toolResultBlocks(messages: ClaudeHistoryMessage[]): Map<string, Record<string, unknown>> {
  const results = new Map<string, Record<string, unknown>>();
  for (const message of messages) {
    if (message.type !== "user" || !Array.isArray(message.message.content)) continue;
    for (const block of message.message.content) {
      if (
        isRecord(block) &&
        block.type === "tool_result" &&
        typeof block.tool_use_id === "string"
      ) {
        results.set(block.tool_use_id, block);
      }
    }
  }
  return results;
}

function toolResultOutput(block: Record<string, unknown> | undefined): string | undefined {
  if (!block) return undefined;
  const text = textParts(block.content).join("");
  return text.length > 0 ? text : undefined;
}

function resultSubagentId(
  value: Record<string, unknown>,
  block: Record<string, unknown>,
): string | undefined {
  const nativeResult = value.tool_use_result;
  if (isRecord(nativeResult)) {
    const structured = nativeResult.agentId ?? nativeResult.agent_id ?? nativeResult.task_id;
    if (typeof structured === "string" && structured.length > 0) return structured;
  }
  const match = /agentId:\s*([A-Za-z0-9_-]+)/u.exec(textParts(block.content).join(""));
  return match?.[1];
}

function subagentPrompt(values: unknown[], nativeSubagentId: string): string | undefined {
  const toolUses = new Map<string, string>();
  for (const value of values) {
    if (!isRecord(value) || !isRecord(value.message) || !Array.isArray(value.message.content)) {
      continue;
    }
    for (const block of value.message.content) {
      if (!isRecord(block)) continue;
      if (
        block.type === "tool_use" &&
        typeof block.id === "string" &&
        (block.name === "Agent" || block.name === "Task") &&
        isRecord(block.input) &&
        typeof block.input.prompt === "string" &&
        block.input.prompt.length > 0
      ) {
        toolUses.set(block.id, block.input.prompt);
        continue;
      }
      if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
      if (resultSubagentId(value, block) === nativeSubagentId) {
        return toolUses.get(block.tool_use_id);
      }
    }
  }
  return undefined;
}

export function mapClaudeSubagentSnapshot(
  values: unknown[],
  parentSessionId: string,
  nativeSubagentId: string,
  parentValues: unknown[] = [],
): HostThreadSnapshot {
  const messages = conversationMessages(
    values.map((value) => (isRecord(value) ? { ...value, session_id: parentSessionId } : value)),
    parentSessionId,
  );
  const turns: HostThreadSnapshot["turns"] = [];
  for (let index = 0; index < messages.length;) {
    const first = messages[index];
    if (!first) break;
    const user = isHumanUser(first) ? first : null;
    if (!user && turns.length > 0) {
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < messages.length && !isHumanUser(messages[end] as ClaudeHistoryMessage)) end += 1;
    const turnMessages = messages.slice(index, end);
    const results = toolResultBlocks(turnMessages);
    const outcome: HistoricalTurnOutcome = {
      status: "unknown",
      reason: "Claude Subagent history does not include complete Result terminal evidence",
    };
    const items: HostThreadSnapshot["turns"][number]["items"] = [];
    for (const message of turnMessages) {
      if (message.type !== "assistant") continue;
      const content = Array.isArray(message.message.content)
        ? message.message.content
        : [{ type: "text", text: message.message.content }];
      for (let blockIndex = 0; blockIndex < content.length; blockIndex += 1) {
        const block = content[blockIndex];
        if (!isRecord(block)) continue;
        const itemId = hostItemIdSchema.parse(
          `claude-subagent-item-v2-${nativeSubagentId}-${message.uuid}-${blockIndex}`,
        );
        if (block.type === "thinking" && typeof block.thinking === "string") {
          if (block.thinking.length > 0) {
            items.push({
              item: { type: "reasoning", itemId, text: block.thinking },
              outcome: itemOutcome(outcome),
            });
          }
          continue;
        }
        if (block.type === "text" && typeof block.text === "string") {
          if (block.text.length > 0) {
            items.push({
              item: { type: "agentMessage", itemId, text: block.text },
              outcome: itemOutcome(outcome),
            });
          }
          continue;
        }
        if (
          block.type !== "tool_use" ||
          typeof block.id !== "string" ||
          typeof block.name !== "string"
        ) {
          continue;
        }
        const result = results.get(block.id);
        if (!result) continue;
        const output = toolResultOutput(result);
        const failed = result.is_error === true;
        const toolOutcome: HostItemOutcome = failed
          ? {
              status: "failed",
              error: {
                code: "nativeFailure",
                message: `${block.name} failed`,
                retryable: false,
              },
            }
          : { status: "succeeded" };
        if (
          block.name === "Bash" &&
          isRecord(block.input) &&
          typeof block.input.command === "string"
        ) {
          items.push({
            item: {
              type: "commandExecution",
              itemId,
              command: block.input.command,
              ...(output ? { output } : {}),
              exitCode: result ? (failed ? 1 : 0) : null,
            },
            outcome: toolOutcome,
          });
          continue;
        }
        const argumentsResult = jsonValueSchema.safeParse(block.input);
        items.push({
          item: {
            type: "toolExecution",
            itemId,
            toolName: block.name,
            arguments: argumentsResult.success ? argumentsResult.data : null,
            ...(output ? { output: { content: [{ type: "text" as const, text: output }] } } : {}),
          },
          outcome: toolOutcome,
        });
      }
    }
    const checkpointMessage = turnMessages.findLast(({ type }) => type === "assistant");
    turns.push({
      nativeTurnRef: nativeTurnRefSchema.parse({
        harnessId: claudeCodeHarnessId,
        nativeSessionId: parentSessionId,
        nativeTurnKey:
          turns.length === 0
            ? `subagent-${nativeSubagentId}-initial`
            : `subagent-turn-${user?.uuid ?? index}`,
        formatVersion: 1,
      }),
      ...(checkpointMessage
        ? {
            checkpoint: nativeCheckpointRefSchema.parse({
              harnessId: claudeCodeHarnessId,
              nativeSessionId: parentSessionId,
              checkpointId: checkpointMessage.uuid,
              formatVersion: 1,
            }),
          }
        : {}),
      input: user
        ? visibleUserTextParts(user).map((text) => ({ type: "text", text }))
        : turns.length === 0
          ? [subagentPrompt(parentValues, nativeSubagentId)]
              .filter((text): text is string => text !== undefined)
              .map((text) => ({ type: "text", text }))
          : [],
      items,
      outcome,
    });
    index = end;
  }
  return { turns };
}
