import type { HistoryEntry } from "@deepseek-ai/dsh-host-apiproxy/api";
import type { SessionEvent } from "@deepseek-ai/dsh-session/types";

import type {
  HostAgentMessageItem,
  HostFileChangeItem,
  HostItemOutcome,
  HostItemSnapshot,
  HostReasoningItem,
  HostThreadSnapshot,
  HostToolExecutionItem,
  HostTurnSnapshot,
  HostUsage,
} from "@codexhost/harness-adapter";
import {
  hostItemIdSchema,
  nativeSessionRefSchema,
  nativeTurnRefSchema,
  type HarnessId,
  type HarnessModelRef,
  type HostItemId,
  type NativeSessionRef,
  type NativeTurnRef,
} from "@codexhost/shared-contracts";

import { encodeDeepSeekHarnessModelRef, type DeepSeekNativeModelRef } from "./model-catalog.js";
import {
  contentText,
  isRecord,
  nonBlankString,
  parseArguments,
  parseDeepSeekContextWindow,
  parseDeepSeekUsage,
  projectToolResult,
  projectTurnReason,
  structuredDiffs,
} from "./projection.js";

interface HistoryTool {
  itemIndex: number;
  item: HostToolExecutionItem;
  toolName: string;
}

interface HistoryTurn {
  turn: number;
  input: HostTurnSnapshot["input"];
  items: HostItemSnapshot[];
  tools: Map<string, HistoryTool>;
  model: HarnessModelRef | undefined;
}

export interface DeepSeekHistoryProjection {
  snapshot: HostThreadSnapshot;
  lastSeq: number;
  effectiveModel: HarnessModelRef | undefined;
  contextWindowTokens: number | undefined;
  usage: HostUsage | null;
}

function itemId(sessionId: string, seq: number, suffix: string): HostItemId {
  return hostItemIdSchema.parse(`dsh:${sessionId}:${seq}:${suffix}`);
}

function nativeTurnRef(harnessId: HarnessId, sessionId: string, turn: number): NativeTurnRef {
  return nativeTurnRefSchema.parse({
    harnessId,
    nativeSessionId: sessionId,
    nativeTurnKey: `turn:${turn}`,
    formatVersion: 1,
  });
}

function contentByType(value: unknown, type: "text" | "reasoning"): string {
  if (!isRecord(value) || !Array.isArray(value.content)) return "";
  return value.content
    .filter((block) => isRecord(block) && block.type === type && typeof block.text === "string")
    .map((block) => (block as { text: string }).text)
    .join("");
}

function modelFromHeader(data: Record<string, unknown>): HarnessModelRef | undefined {
  const header = isRecord(data.header) ? data.header : null;
  const config = header && isRecord(header.config) ? header.config : null;
  if (!config || !nonBlankString(config.provider) || !nonBlankString(config.model))
    return undefined;
  return encodeDeepSeekHarnessModelRef({ provider: config.provider, model: config.model });
}

function itemOutcomeForTurn(value: unknown): HostItemOutcome {
  const terminal = projectTurnReason(value).outcome;
  if (terminal.status === "succeeded") return { status: "succeeded" };
  if (terminal.status === "cancelled") {
    return { status: "cancelled", ...(terminal.reason ? { reason: terminal.reason } : {}) };
  }
  return { status: "failed", error: terminal.error };
}

function finishIncompleteItems(turn: HistoryTurn, outcome: HostItemOutcome): void {
  for (const tool of turn.tools.values()) {
    turn.items[tool.itemIndex] = { item: tool.item, outcome };
  }
  turn.tools.clear();
}

export function projectDeepSeekHistory(input: {
  harnessId: HarnessId;
  sessionId: string;
  entries: readonly HistoryEntry[];
  fallbackModel?: HarnessModelRef;
  toolOutputLimit: number;
}): DeepSeekHistoryProjection {
  const turns: HostTurnSnapshot[] = [];
  let active: HistoryTurn | null = null;
  let effectiveModel = input.fallbackModel;
  let lastSeq = -1;
  let contextWindowTokens: number | undefined;
  let latestUsageValue: unknown;
  let usage: HostUsage | null = null;

  const refreshUsage = (): void => {
    const nextUsage = parseDeepSeekUsage(latestUsageValue, contextWindowTokens);
    if (nextUsage) usage = nextUsage;
  };

  for (const entry of input.entries) {
    const event = entry.event as SessionEvent;
    lastSeq = Math.max(lastSeq, event.seq);
    if (!isRecord(event.data)) continue;
    const data: Record<string, unknown> = event.data;
    if (event.type === "turn/start") {
      if (!Number.isSafeInteger(data.turn) || active) continue;
      active = {
        turn: data.turn as number,
        input: [],
        items: [],
        tools: new Map(),
        model: effectiveModel,
      };
      continue;
    }
    if (event.type === "request/header") {
      const model = modelFromHeader(data);
      if (model) {
        effectiveModel = model;
        if (active) active.model = model;
      }
      continue;
    }
    if (event.type === "request/context") {
      const nextContextWindowTokens = parseDeepSeekContextWindow(data.contextWindow);
      if (nextContextWindowTokens !== undefined) {
        contextWindowTokens = nextContextWindowTokens;
        refreshUsage();
      }
      continue;
    }
    if (!active) continue;

    if (event.type === "user/message") {
      if (!isRecord(data.source) || data.source.kind !== "user") continue;
      const text = contentText(data);
      if (text) active.input.push({ type: "text", text });
      continue;
    }
    if (event.type === "assistant/chunk") {
      const chunk = isRecord(data.chunk) ? data.chunk : null;
      if (chunk?.type === "usage") {
        latestUsageValue = chunk.usage;
        refreshUsage();
      }
      continue;
    }
    if (event.type === "assistant/message") {
      latestUsageValue = data.usage;
      refreshUsage();
      const message = isRecord(data.message) ? data.message : null;
      if (!message) continue;
      const reasoning = contentByType(message, "reasoning");
      if (reasoning) {
        const item: HostReasoningItem = {
          type: "reasoning",
          itemId: itemId(input.sessionId, event.seq, "reasoning"),
          text: reasoning,
        };
        active.items.push({ item, outcome: { status: "succeeded" } });
      }
      const text = contentByType(message, "text");
      if (text) {
        const item: HostAgentMessageItem = {
          type: "agentMessage",
          itemId: itemId(input.sessionId, event.seq, "assistant"),
          text,
        };
        active.items.push({ item, outcome: { status: "succeeded" } });
      }
      continue;
    }
    if (event.type === "tool/call") {
      if (!nonBlankString(data.callId) || !nonBlankString(data.name)) continue;
      const item: HostToolExecutionItem = {
        type: "toolExecution",
        itemId: itemId(input.sessionId, event.seq, "tool"),
        toolName: data.name,
        arguments: parseArguments(data.arguments),
      };
      const itemIndex = active.items.length;
      active.items.push({
        item,
        outcome: {
          status: "failed",
          error: {
            code: "nativeFailure",
            message: `DeepSeek Harness Tool '${data.name}' did not complete`,
            retryable: false,
          },
        },
      });
      active.tools.set(data.callId, { itemIndex, item, toolName: data.name });
      continue;
    }
    if (event.type === "tool/result") {
      const result = projectToolResult(data.message, input.toolOutputLimit);
      if (!result) continue;
      const tool = active.tools.get(result.callId);
      if (!tool) continue;
      active.tools.delete(result.callId);
      const item = { ...tool.item, ...(result.output ? { output: result.output } : {}) };
      active.items[tool.itemIndex] = {
        item,
        outcome:
          result.failed || data.error !== undefined
            ? {
                status: "failed",
                error: {
                  code: "nativeFailure",
                  message: `DeepSeek Harness Tool '${tool.toolName}' failed`,
                  retryable: false,
                },
              }
            : { status: "succeeded" },
      };
      if (!result.failed && data.error === undefined) {
        const changes = structuredDiffs(data.meta);
        if (changes) {
          const fileItem: HostFileChangeItem = {
            type: "fileChange",
            itemId: itemId(input.sessionId, event.seq, "file-change"),
            changes,
          };
          active.items.push({ item: fileItem, outcome: { status: "succeeded" } });
        }
      }
      continue;
    }
    if (event.type === "turn/end" && data.turn === active.turn) {
      const projected = projectTurnReason(data.reason);
      finishIncompleteItems(active, itemOutcomeForTurn(data.reason));
      turns.push({
        nativeTurnRef: nativeTurnRef(input.harnessId, input.sessionId, active.turn),
        input: active.input,
        items: active.items,
        outcome: projected.history,
        ...(active.model ? { model: active.model } : {}),
      });
      active = null;
    }
  }

  const nativeRef = nativeSessionRefSchema.parse({
    harnessId: input.harnessId,
    nativeSessionId: input.sessionId,
    formatVersion: 1,
  }) as NativeSessionRef;
  return {
    snapshot: {
      turns,
      state: {
        nativeRef,
        ...(effectiveModel ? { effectiveModel } : {}),
      },
    },
    lastSeq,
    effectiveModel,
    contextWindowTokens,
    usage,
  };
}

export function selectionToModel(selection: DeepSeekNativeModelRef): HarnessModelRef {
  return encodeDeepSeekHarnessModelRef(selection);
}
