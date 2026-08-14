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

export function mapGrokReplay(
  replay: readonly GrokTransportEvent[],
  harnessId: HarnessId,
  sessionId: string,
): HostThreadSnapshot {
  const turns: HostTurnSnapshot[] = [];
  let input = "";
  let items: HostItemSnapshot[] = [];
  let turnIndex = 0;
  let messageIndex = 0;
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
  const completeTurn = (outcome: HistoricalTurnOutcome = { status: "succeeded" }): void => {
    if (input.length === 0) return;
    completeReasoning();
    completeAgent();
    completeTools();
    turns.push({
      nativeTurnRef: nativeTurnRefSchema.parse({
        harnessId,
        nativeSessionId: sessionId,
        nativeTurnKey: `replay-${turnIndex + 1}`,
        formatVersion: 1,
      }),
      input: [{ type: "text", text: input }],
      items,
      outcome,
    });
    turnIndex += 1;
    messageIndex = 0;
    input = "";
    items = [];
  };

  for (const event of replay) {
    if (event.type === "user.text") {
      if (input.length > 0 && (items.length > 0 || agent || reasoning || tools.size > 0)) {
        completeTurn();
      }
      input += event.text;
      continue;
    }
    if (input.length === 0) continue;
    if (event.type === "agent.text") {
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
  completeTurn({ status: "unknown", reason: "Grok ACP replay has no historical terminal signal" });
  return { turns };
}
