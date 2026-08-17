import type {
  HistoricalTurnOutcome,
  HostAgentMessageItem,
  HostFileChangeItem,
  HostItemSnapshot,
  HostReasoningItem,
  HostThreadSnapshot,
  HostTurnSnapshot,
} from "@codexhost/harness-adapter";
import {
  hostItemIdSchema,
  nativeCheckpointRefSchema,
  nativeTurnRefSchema,
  type HarnessId,
  type NativeTurnRef,
} from "@codexhost/shared-contracts";

import type { GrokTransportEvent } from "./acp-transport.js";
import { projectGrokFileChanges } from "./grok-file-change.js";
import {
  applyGrokToolProjection,
  DEFAULT_GROK_TOOL_OUTPUT_LIMIT,
  grokToolLabel,
  hasGrokToolProjection,
  projectGrokToolOutput,
  startGrokToolItem,
  type GrokProjectedToolItem,
} from "./grok-tool-output.js";

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

function isHostTurnEvent(event: GrokTransportEvent): boolean {
  return event.metadata?.hostTurn === true || event.metadata?.host_turn === true;
}

function userEventIdentity(
  event: Extract<GrokTransportEvent, { type: "user.text" }>,
): string | null {
  const eventId = event.metadata?.eventId;
  if (typeof eventId === "string" && eventId.length > 0) return eventId;
  return event.messageId && event.messageId.length > 0 ? event.messageId : null;
}

function explicitPromptIndex(event: GrokTransportEvent): number | null {
  const value = event.metadata?.promptIndex ?? event.metadata?.prompt_index;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

export function grokCheckpointId(promptIndex: number): string {
  return String(promptIndex);
}

export function parseGrokPromptIndex(checkpointId: string): number | null {
  if (!/^\d+$/u.test(checkpointId)) return null;
  const index = Number(checkpointId);
  return Number.isInteger(index) ? index : null;
}

export function mapGrokReplay(
  replay: readonly GrokTransportEvent[],
  harnessId: HarnessId,
  sessionId: string,
  cwd: string,
  knownTurnRefs: readonly NativeTurnRef[] = [],
  toolOutputLimit = DEFAULT_GROK_TOOL_OUTPUT_LIMIT,
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
  let nativePromptIndex = 0;
  let currentPromptIndex: number | null = null;
  let agent: HostAgentMessageItem | null = null;
  let reasoning: HostReasoningItem | null = null;
  const tools = new Map<string, GrokProjectedToolItem>();

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
  const applyToolProjection = (
    callId: string,
    content?: readonly unknown[] | null,
    rawOutput?: unknown,
  ): void => {
    const tool = tools.get(callId);
    if (!tool) return;
    const projection = projectGrokToolOutput(content, rawOutput, toolOutputLimit);
    if (hasGrokToolProjection(projection)) {
      tools.set(callId, applyGrokToolProjection(tool, projection));
    }
  };
  const completeTool = (
    callId: string,
    status: string,
    content?: readonly unknown[] | null,
    rawOutput?: unknown,
  ): void => {
    applyToolProjection(callId, content, rawOutput);
    const tool = tools.get(callId);
    if (!tool) return;
    tools.delete(callId);
    const outcome: HostItemSnapshot["outcome"] =
      status === "failed"
        ? {
            status: "failed",
            error: {
              code: "nativeFailure",
              message: `Grok Tool '${grokToolLabel(tool)}' failed`,
              retryable: false,
            },
          }
        : { status: "succeeded" };
    items.push({ item: tool, outcome });
    if (status !== "completed") return;
    const changes = projectGrokFileChanges(content, cwd);
    if (!changes) return;
    const fileItem: HostFileChangeItem = {
      type: "fileChange",
      itemId: stableId("file-change", turnIndex, ++messageIndex),
      changes,
    };
    items.push({ item: fileItem, outcome: { status: "succeeded" } });
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
    if (currentPromptIndex === null) {
      throw new Error("Grok Native history Turn has no Prompt Index");
    }
    turns.push({
      nativeTurnRef: nativeTurnRefSchema.parse({
        harnessId,
        nativeSessionId: sessionId,
        nativeTurnKey: stableKey,
        formatVersion: 1,
      }),
      checkpoint: nativeCheckpointRefSchema.parse({
        harnessId,
        nativeSessionId: sessionId,
        checkpointId: grokCheckpointId(currentPromptIndex),
        formatVersion: 1,
      }),
      input: [{ type: "text", text: input }],
      items,
      outcome,
    });
    turnIndex += 1;
    messageIndex = 0;
    nativeTurnKey = null;
    currentPromptIndex = null;
    input = "";
    items = [];
  };

  for (const event of replay) {
    if (event.type === "user.text") {
      if (isHostTurnEvent(event)) continue;
      if (isSyntheticGrokUserText(event.text)) {
        if (input.length > 0) {
          completeTurn({
            status: "unknown",
            reason: "Grok Native history has no terminal signal",
          });
        }
        nativePromptIndex = (explicitPromptIndex(event) ?? nativePromptIndex) + 1;
        continue;
      }
      if (input.length > 0) {
        input += event.text;
        continue;
      }
      currentPromptIndex = explicitPromptIndex(event) ?? nativePromptIndex;
      nativePromptIndex = currentPromptIndex + 1;
      input = event.text;
      nativeTurnKey = userEventIdentity(event);
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
      tools.set(
        event.callId,
        startGrokToolItem({
          itemId: stableId("tool", turnIndex, ++messageIndex),
          name: event.name,
          title: event.title,
          kind: event.kind,
          rawInput: event.rawInput,
          cwd,
        }),
      );
      applyToolProjection(event.callId, event.content, event.rawOutput);
      if (event.status === "completed" || event.status === "failed") {
        completeTool(event.callId, event.status, event.content, event.rawOutput);
      }
    } else if (event.type === "tool.update") {
      applyToolProjection(event.callId, event.content, event.rawOutput);
      if (event.status === "completed" || event.status === "failed") {
        completeTool(event.callId, event.status, event.content, event.rawOutput);
      }
    }
  }
  completeTurn({ status: "unknown", reason: "Grok Native history has no terminal signal" });
  return { turns };
}

export function resolveGrokTargetPromptIndex(
  snapshot: HostThreadSnapshot,
  checkpointId: string,
): number | null {
  const turn = snapshot.turns.find((entry) => entry.checkpoint?.checkpointId === checkpointId);
  if (!turn?.checkpoint) return null;
  return parseGrokPromptIndex(turn.checkpoint.checkpointId);
}
