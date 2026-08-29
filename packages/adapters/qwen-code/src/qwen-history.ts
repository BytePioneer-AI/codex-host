import type {
  HostAgentMessageItem,
  HostFileChangeItem,
  HostItemSnapshot,
  HostReasoningItem,
  HostTurnSnapshot,
  HistoricalTurnOutcome,
} from "@codexhost/harness-adapter";
import {
  hostItemIdSchema,
  nativeTurnRefSchema,
  type HarnessId,
  type NativeTurnRef,
} from "@codexhost/shared-contracts";

import type { QwenCodeTransportEvent } from "./acp-transport.js";
import { projectQwenCodeFileChanges } from "./qwen-file-change.js";
import {
  applyQwenCodeToolProjection,
  DEFAULT_QWEN_CODE_TOOL_OUTPUT_LIMIT,
  hasQwenCodeToolProjection,
  projectQwenCodeToolOutput,
  qwenCodeToolLabel,
  startQwenCodeToolItem,
  type QwenCodeProjectedToolItem,
} from "./qwen-tool-output.js";

const QWEN_CODE_TURN_KEY_PREFIX = "qwen-turn-";

function stableId(
  kind: string,
  turn: number,
  index: number,
): ReturnType<typeof hostItemIdSchema.parse> {
  return hostItemIdSchema.parse(`qwen-code-history-${kind}-${turn}-${index}`);
}

export function qwenCodeTurnKey(ordinal: number): string {
  return `${QWEN_CODE_TURN_KEY_PREFIX}${ordinal}`;
}

/**
 * Qwen Code replays history as a flat stream of Session Updates without
 * terminal markers, so Turns are bounded by their leading user text and get a
 * stable ordinal identity that survives resume.
 */
export function mapQwenCodeReplay(
  replay: readonly QwenCodeTransportEvent[],
  harnessId: HarnessId,
  sessionId: string,
  cwd: string,
  knownTurnRefs: readonly NativeTurnRef[] = [],
  toolOutputLimit = DEFAULT_QWEN_CODE_TOOL_OUTPUT_LIMIT,
): { turns: HostTurnSnapshot[]; turnCount: number } {
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
  let agent: HostAgentMessageItem | null = null;
  let reasoning: HostReasoningItem | null = null;
  const tools = new Map<string, QwenCodeProjectedToolItem>();

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
  const applyToolProjection = (
    callId: string,
    content?: readonly unknown[] | null,
    rawOutput?: unknown,
  ): void => {
    const tool = tools.get(callId);
    if (!tool) return;
    const projection = projectQwenCodeToolOutput(content, rawOutput, toolOutputLimit);
    if (hasQwenCodeToolProjection(projection)) {
      tools.set(callId, applyQwenCodeToolProjection(tool, projection));
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
              message: `Qwen Code Tool '${qwenCodeToolLabel(tool)}' failed`,
              retryable: false,
            },
          }
        : { status: "succeeded" };
    items.push({ item: tool, outcome });
    if (status !== "completed") return;
    const changes = projectQwenCodeFileChanges(content, cwd);
    if (!changes) return;
    const fileItem: HostFileChangeItem = {
      type: "fileChange",
      itemId: stableId("file-change", turnIndex, ++messageIndex),
      changes,
    };
    items.push({ item: fileItem, outcome: { status: "succeeded" } });
  };
  const completeTurn = (): void => {
    if (input.length === 0) return;
    const reconstructedKey = qwenCodeTurnKey(turnIndex);
    const known = knownByNativeKey.get(reconstructedKey);
    const nativeTurnKey = known?.nativeTurnKey ?? reconstructedKey;
    completeReasoning();
    completeAgent();
    for (const tool of tools.values()) items.push({ item: tool, outcome: { status: "succeeded" } });
    tools.clear();
    const outcome: HistoricalTurnOutcome = {
      status: "unknown",
      reason: "Qwen Code history has no terminal signal",
    };
    turns.push({
      nativeTurnRef: nativeTurnRefSchema.parse({
        harnessId,
        nativeSessionId: sessionId,
        nativeTurnKey,
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
      if (input.length > 0) completeTurn();
      input = event.text;
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
      tools.set(
        event.callId,
        startQwenCodeToolItem({
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
  completeTurn();
  return { turns, turnCount: turnIndex };
}
