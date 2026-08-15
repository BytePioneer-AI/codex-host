import type {
  HistoricalTurnOutcome,
  HostAgentMessageItem,
  HostItemSnapshot,
  HostReasoningItem,
  HostThreadSnapshot,
  HostToolExecutionItem,
  HostTurnSnapshot,
} from "@codexhost/harness-adapter";
import {
  hostItemIdSchema,
  nativeTurnRefSchema,
  type HarnessId,
  type JsonValue,
  type NativeTurnRef,
} from "@codexhost/shared-contracts";

import type { GrokTransportEvent } from "./acp-transport.js";

function jsonValue(value: unknown): JsonValue {
  try {
    return JSON.parse(JSON.stringify(value ?? {})) as JsonValue;
  } catch {
    return {};
  }
}

function stableId(
  kind: string,
  turn: number,
  index: number,
): ReturnType<typeof hostItemIdSchema.parse> {
  return hostItemIdSchema.parse(`grok-history-${kind}-${turn}-${index}`);
}

function terminalOutcome(stopReason: string): HistoricalTurnOutcome {
  if (stopReason === "end_turn") return { status: "succeeded" };
  if (stopReason === "cancelled") return { status: "cancelled", reason: "Cancelled by user" };
  return {
    status: "failed",
    error: {
      code: "nativeFailure",
      message: `Grok stopped the Turn: ${stopReason}`,
      retryable: stopReason === "max_tokens" || stopReason === "max_turn_requests",
    },
  };
}

const systemReminderPattern = /^\s*<system-reminder>[\s\S]*$/u;
const taskCompletedTurnKeyPattern = /^task-completed-/u;

function isSyntheticGrokUserText(text: string): boolean {
  return systemReminderPattern.test(text);
}

function isSyntheticGrokTurnKey(nativeTurnKey: string): boolean {
  return taskCompletedTurnKeyPattern.test(nativeTurnKey);
}

export function mapGrokReplay(
  replay: readonly GrokTransportEvent[],
  harnessId: HarnessId,
  sessionId: string,
  knownTurnRefs: readonly NativeTurnRef[] = [],
): HostThreadSnapshot {
  const knownByNativeKey = new Map(
    knownTurnRefs
      .filter((ref) => ref.harnessId === harnessId && ref.nativeSessionId === sessionId)
      .map((ref) => [ref.nativeTurnKey, ref] as const),
  );
  const turns: HostTurnSnapshot[] = [];
  let input = "";
  let items: HostItemSnapshot[] = [];
  let turnIndex = 0;
  let messageIndex = 0;
  let nativeTurnKey: string | null = null;
  let agent: HostAgentMessageItem | null = null;
  let reasoning: HostReasoningItem | null = null;
  const tools = new Map<string, HostToolExecutionItem>();

  const completeAgent = (): void => {
    if (!agent || agent.text.length === 0) return;
    items.push({ item: agent, outcome: { status: "succeeded" } });
    agent = null;
  };
  const completeReasoning = (): void => {
    if (!reasoning || reasoning.text.length === 0) return;
    items.push({ item: reasoning, outcome: { status: "succeeded" } });
    reasoning = null;
  };
  const completeTools = (): void => {
    for (const tool of tools.values()) {
      items.push({ item: tool, outcome: { status: "succeeded" } });
    }
    tools.clear();
  };
  const completeTurn = (outcome: HistoricalTurnOutcome, terminalKey?: string): void => {
    if (input.length === 0) return;
    const reconstructedKey = terminalKey ?? nativeTurnKey;
    if (!reconstructedKey) throw new Error("Grok Native history Turn has no stable identity");
    const known = knownByNativeKey.get(reconstructedKey);
    const stableKey = known?.nativeTurnKey ?? reconstructedKey;
    completeReasoning();
    completeAgent();
    completeTools();
    turns.push({
      nativeTurnRef: nativeTurnRefSchema.parse({
        harnessId,
        nativeSessionId: sessionId,
        nativeTurnKey: stableKey,
        formatVersion: 1,
      }),
      input: [{ type: "text", text: input }],
      items,
      outcome,
    });
    turnIndex += 1;
    messageIndex = 0;
    nativeTurnKey = null;
    input = "";
    items = [];
  };

  for (const event of replay) {
    if (event.type === "user.text") {
      if (isSyntheticGrokUserText(event.text)) continue;
      if (input.length > 0) {
        completeTurn({
          status: "unknown",
          reason: "Grok Native history has no terminal signal",
        });
      }
      input += event.text;
      const eventId = event.metadata?.eventId;
      if (!nativeTurnKey && typeof eventId === "string" && eventId.length > 0) {
        nativeTurnKey = eventId;
      } else if (!nativeTurnKey && event.messageId) {
        nativeTurnKey = event.messageId;
      }
      continue;
    }
    if (input.length === 0) continue;
    if (event.type === "turn.completed") {
      if (isSyntheticGrokTurnKey(event.nativeTurnKey)) continue;
      completeTurn(terminalOutcome(event.stopReason), event.nativeTurnKey);
    } else if (event.type === "agent.text") {
      if (!agent) {
        completeReasoning();
        agent = {
          type: "agentMessage",
          itemId: stableId("message", turnIndex, ++messageIndex),
          text: "",
        };
      }
      agent = { ...agent, text: agent.text + event.text };
    } else if (event.type === "agent.thought") {
      if (!reasoning) {
        reasoning = {
          type: "reasoning",
          itemId: stableId("reasoning", turnIndex, ++messageIndex),
          text: "",
        };
      }
      reasoning = { ...reasoning, text: reasoning.text + event.text };
    } else if (event.type === "tool.call") {
      completeReasoning();
      completeAgent();
      tools.set(event.callId, {
        type: "toolExecution",
        itemId: stableId("tool", turnIndex, ++messageIndex),
        toolName: event.name ?? event.title,
        namespace: "grok",
        arguments: jsonValue(event.rawInput),
      });
    } else if (event.type === "tool.update") {
      const tool = tools.get(event.callId);
      if (tool && event.rawOutput !== undefined) {
        tools.set(event.callId, {
          ...tool,
          output: { content: [{ type: "text", text: String(event.rawOutput) }] },
        });
      }
    }
  }
  completeTurn({ status: "unknown", reason: "Grok Native history has no terminal signal" });
  return { turns };
}
