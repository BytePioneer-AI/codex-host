import type { HostItemSnapshot, HostThreadSnapshot, HostUsage } from "@codexhost/harness-adapter";
import {
  hostItemIdSchema,
  jsonValueSchema,
  nativeTurnRefSchema,
  type HarnessId,
  type NativeTurnRef,
} from "@codexhost/shared-contracts";

import type { CursorTransportEvent } from "./acp-transport.js";

const DEFAULT_TOOL_OUTPUT_LIMIT = 64_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textFromUnknown(value: unknown, limit: number): string | undefined {
  if (typeof value === "string" && value.length > 0) return value.slice(0, limit);
  if (isRecord(value)) {
    if (typeof value.text === "string" && value.text.length > 0) return value.text.slice(0, limit);
    if (typeof value.content === "string" && value.content.length > 0) {
      return value.content.slice(0, limit);
    }
  }
  if (Array.isArray(value)) {
    const parts = value
      .map((entry) => (isRecord(entry) && typeof entry.text === "string" ? entry.text : ""))
      .filter((part) => part.length > 0);
    if (parts.length > 0) return parts.join("").slice(0, limit);
  }
  return undefined;
}

function commandFromInput(rawInput: unknown, title: string): string {
  if (isRecord(rawInput)) {
    if (typeof rawInput.command === "string" && rawInput.command.length > 0)
      return rawInput.command;
    if (typeof rawInput.cmd === "string" && rawInput.cmd.length > 0) return rawInput.cmd;
  }
  return title;
}

function isExecuteTool(
  event: Extract<CursorTransportEvent, { type: "tool.call" | "tool.update" }>,
): boolean {
  const kind = event.kind ?? undefined;
  const name = event.name ?? undefined;
  if (kind === "execute") return true;
  if (typeof name === "string" && /^(bash|shell|run_terminal_command)$/iu.test(name)) return true;
  return false;
}

export function nativeTurnRefFor(
  harnessId: HarnessId,
  sessionId: string,
  ordinal: number,
): NativeTurnRef {
  return nativeTurnRefSchema.parse({
    harnessId,
    nativeSessionId: sessionId,
    nativeTurnKey: `${sessionId}:${ordinal}`,
    formatVersion: 1,
  });
}

export function usageFromCursorEvent(event: CursorTransportEvent): HostUsage | null {
  if (event.type !== "usage") return null;
  const usage: HostUsage = {};
  if (typeof event.used === "number") usage.contextUsedTokens = event.used;
  if (typeof event.size === "number") usage.contextWindowTokens = event.size;
  return Object.keys(usage).length > 0 ? usage : null;
}

export function mapCursorReplay(
  events: readonly CursorTransportEvent[],
  harnessId: HarnessId,
  sessionId: string,
  knownTurnRefs: NativeTurnRef[] = [],
  toolOutputLimit = DEFAULT_TOOL_OUTPUT_LIMIT,
): HostThreadSnapshot {
  const turns: HostThreadSnapshot["turns"] = [];
  let input = "";
  let agentText = "";
  let reasoningText = "";
  const items: HostItemSnapshot[] = [];
  const tools = new Map<string, HostItemSnapshot>();
  let userMessageId: string | undefined;
  let itemSequence = 0;

  const nextItemId = (): string => `${sessionId}-item-${++itemSequence}`;

  const flushAgent = (): void => {
    if (agentText.length === 0) return;
    items.push({
      item: {
        type: "agentMessage",
        itemId: hostItemIdSchema.parse(nextItemId()),
        text: agentText,
      },
      outcome: { status: "succeeded" },
    });
    agentText = "";
  };

  const flushReasoning = (): void => {
    if (reasoningText.length === 0) return;
    items.push({
      item: {
        type: "reasoning",
        itemId: hostItemIdSchema.parse(nextItemId()),
        text: reasoningText,
      },
      outcome: { status: "succeeded" },
    });
    reasoningText = "";
  };

  const finishTurn = (): void => {
    flushReasoning();
    flushAgent();
    tools.clear();
    if (input.length === 0 && items.length === 0) return;
    const ordinal = turns.length + 1;
    turns.push({
      nativeTurnRef: knownTurnRefs[turns.length] ?? nativeTurnRefFor(harnessId, sessionId, ordinal),
      input: input.length > 0 ? [{ type: "text", text: input }] : [],
      items: [...items],
      outcome: { status: "succeeded" },
    });
    input = "";
    userMessageId = undefined;
    items.length = 0;
  };

  for (const event of events) {
    if (event.type === "user.text") {
      const responseStarted =
        items.length > 0 || tools.size > 0 || agentText.length > 0 || reasoningText.length > 0;
      const differentChunkedMessage =
        input.length > 0 &&
        event.messageId !== undefined &&
        userMessageId !== undefined &&
        event.messageId !== userMessageId;
      if (responseStarted || differentChunkedMessage) {
        finishTurn();
      }
      input += event.text;
      userMessageId ??= event.messageId;
      continue;
    }
    if (event.type === "agent.text") {
      agentText += event.text;
      continue;
    }
    if (event.type === "agent.thought") {
      reasoningText += event.text;
      continue;
    }
    if (event.type === "tool.call") {
      flushReasoning();
      flushAgent();
      const outputText = textFromUnknown(event.rawOutput ?? event.content, toolOutputLimit);
      const outcome: HostItemSnapshot["outcome"] =
        event.status === "failed"
          ? {
              status: "failed",
              error: {
                code: "nativeFailure",
                message: "Cursor tool failed",
                retryable: false,
              },
            }
          : { status: "succeeded" };
      const snapshot: HostItemSnapshot = isExecuteTool(event)
        ? {
            item: {
              type: "commandExecution",
              itemId: hostItemIdSchema.parse(nextItemId()),
              command: commandFromInput(event.rawInput, event.title),
              ...(outputText ? { output: outputText } : {}),
            },
            outcome,
          }
        : {
            item: {
              type: "toolExecution",
              itemId: hostItemIdSchema.parse(nextItemId()),
              toolName: event.name ?? event.title,
              arguments: (() => {
                const parsed = jsonValueSchema.safeParse(event.rawInput);
                return parsed.success ? parsed.data : {};
              })(),
              ...(outputText ? { output: { content: [{ type: "text", text: outputText }] } } : {}),
            },
            outcome,
          };
      tools.set(event.callId, snapshot);
      items.push(snapshot);
      continue;
    }
    if (event.type === "tool.update") {
      const existing = tools.get(event.callId);
      if (!existing) continue;
      const outputText = textFromUnknown(event.rawOutput ?? event.content, toolOutputLimit);
      if (existing.item.type === "commandExecution" && outputText) {
        existing.item.output = outputText;
      } else if (existing.item.type === "toolExecution" && outputText) {
        existing.item.output = { content: [{ type: "text", text: outputText }] };
      }
      if (event.status === "failed")
        existing.outcome = {
          status: "failed",
          error: {
            code: "nativeFailure",
            message: "Cursor tool failed",
            retryable: false,
          },
        };
      continue;
    }
  }
  finishTurn();
  return { turns };
}
