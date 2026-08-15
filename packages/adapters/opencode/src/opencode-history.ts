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

export interface OpenCodePart {
  type: string;
  [key: string]: unknown;
}

export interface OpenCodeMessage {
  id: string;
  role: "user" | "assistant";
  parentID?: string;
  finish?: string;
  model?: unknown;
  tokens?: unknown;
  cost?: unknown;
  parts: OpenCodePart[];
}

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
  return hostItemIdSchema.parse(`opencode-history-${kind}-${turn}-${index}`);
}

function terminalOutcome(finish: string | undefined): HistoricalTurnOutcome {
  if (!finish || finish === "stop") return { status: "succeeded" };
  if (finish === "cancel") return { status: "cancelled", reason: "Cancelled by user" };
  return {
    status: "failed",
    error: {
      code: "nativeFailure",
      message: `OpenCode stopped the Turn: ${finish}`,
      retryable: false,
    },
  };
}

function isText(value: OpenCodePart): value is OpenCodePart & { text: string } {
  return value.type === "text" && typeof value.text === "string";
}

function isReasoning(value: OpenCodePart): value is OpenCodePart & { text: string } {
  return value.type === "reasoning" && typeof value.text === "string";
}

function isTool(value: OpenCodePart): value is OpenCodePart & {
  tool: string;
  state?: { input?: unknown; output?: unknown; status?: string };
} {
  return value.type === "tool" && typeof value.tool === "string";
}

function isPatch(value: OpenCodePart): value is OpenCodePart & { title?: string; patch?: string } {
  return value.type === "patch";
}

export function mapOpenCodeMessages(
  messages: readonly OpenCodeMessage[],
  harnessId: HarnessId,
  sessionId: string,
  knownTurnRefs: readonly NativeTurnRef[] = [],
): HostThreadSnapshot {
  const turns: HostTurnSnapshot[] = [];
  let turnIndex = 0;
  let messageIndex = 0;
  let input = "";
  let items: HostItemSnapshot[] = [];
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
    const known = knownTurnRefs[turnIndex];
    if (known && (known.harnessId !== harnessId || known.nativeSessionId !== sessionId)) {
      throw new Error("Known OpenCode Turn identity does not belong to the Native Session");
    }
    const stableKey = known?.nativeTurnKey ?? terminalKey ?? nativeTurnKey;
    if (!stableKey) throw new Error("OpenCode Native history Turn has no stable identity");
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

  for (const message of messages) {
    if (message.role === "user") {
      const text = message.parts
        .map((part) => (isText(part) ? part.text : null))
        .filter((candidate): candidate is string => candidate !== null)
        .join("\n")
        .trim();
      if (text.length === 0) continue;
      if (input.length > 0) {
        completeTurn({
          status: "unknown",
          reason: "OpenCode Native history has no terminal signal",
        });
      }
      input = text;
      if (!nativeTurnKey) nativeTurnKey = message.id;
      continue;
    }
    if (input.length === 0) continue;
    for (const part of message.parts) {
      if (isText(part)) {
        if (part.text.length === 0) continue;
        if (!agent) {
          completeReasoning();
          agent = {
            type: "agentMessage",
            itemId: stableId("message", turnIndex, ++messageIndex),
            text: "",
          };
        }
        agent = { ...agent, text: agent.text + part.text };
      } else if (isReasoning(part)) {
        if (part.text.length === 0) continue;
        if (!reasoning) {
          reasoning = {
            type: "reasoning",
            itemId: stableId("reasoning", turnIndex, ++messageIndex),
            text: "",
          };
        }
        reasoning = { ...reasoning, text: reasoning.text + part.text };
      } else if (isTool(part)) {
        completeReasoning();
        completeAgent();
        const callId = part.callID ?? part.id;
        const callKey = typeof callId === "string" ? callId : `${part.tool}-${++messageIndex}`;
        const status = part.state?.status;
        const output = part.state?.output;
        tools.set(callKey, {
          type: "toolExecution",
          itemId: stableId("tool", turnIndex, ++messageIndex),
          toolName: part.tool,
          namespace: "opencode",
          arguments: jsonValue(part.state?.input ?? {}),
          ...(typeof output === "string" && output.length > 0
            ? { output: { content: [{ type: "text", text: output }] } }
            : {}),
          ...(status === "error" || status === "failed" ? { durationMs: 0 } : {}),
        });
        if (status === "completed" || status === "error") {
          const tool = tools.get(callKey);
          if (tool) {
            tools.delete(callKey);
            items.push({
              item: tool,
              outcome:
                status === "error"
                  ? {
                      status: "failed",
                      error: {
                        code: "nativeFailure",
                        message: `OpenCode Tool '${tool.toolName}' failed`,
                        retryable: false,
                      },
                    }
                  : { status: "succeeded" },
            });
          }
        }
      } else if (isPatch(part)) {
        completeReasoning();
        completeAgent();
        const text = part.patch ?? part.title ?? "";
        if (text.length > 0) {
          items.push({
            item: {
              type: "toolExecution",
              itemId: stableId("patch", turnIndex, ++messageIndex),
              toolName: "patch",
              namespace: "opencode",
              arguments: jsonValue({ title: part.title ?? "Patch", patch: text }),
            },
            outcome: { status: "succeeded" },
          });
        }
      }
    }
    completeTurn(terminalOutcome(message.finish), message.id);
  }
  if (input.length > 0) {
    completeTurn({ status: "unknown", reason: "OpenCode Native history has no terminal signal" });
  }
  if (knownTurnRefs.length > turns.length) {
    throw new Error("OpenCode Native history is missing persisted Turns");
  }
  return { turns };
}
