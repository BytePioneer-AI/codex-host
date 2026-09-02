import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  HistoricalTurnOutcome,
  HostAgentMessageItem,
  HostItemSnapshot,
  HostReasoningItem,
  HostThreadSnapshot,
  HostTurnSnapshot,
} from "@codexhost/harness-adapter";
import {
  hostItemIdSchema,
  nativeTurnRefSchema,
  type HarnessId,
  type NativeTurnRef,
} from "@codexhost/shared-contracts";

import {
  applyQwenCodeToolProjection,
  projectQwenCodeToolOutput,
  startQwenCodeToolItem,
  type QwenCodeProjectedToolItem,
} from "./qwen-tool-output.js";

const QWEN_CODE_TURN_KEY_PREFIX = "qwen-turn-";

export function qwenCodeTurnKey(ordinal: number): string {
  return `${QWEN_CODE_TURN_KEY_PREFIX}${ordinal}`;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textFrom(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .flatMap((part) => {
      if (!isRecord(part)) return [];
      if (typeof part.text === "string") return [part.text];
      if (isRecord(part.content) && typeof part.content.text === "string")
        return [part.content.text];
      return [];
    })
    .join("");
}

function messageParts(record: JsonRecord): unknown[] {
  const message = record.message;
  if (!isRecord(message)) return [];
  if (Array.isArray(message.parts)) return message.parts;
  if (Array.isArray(message.content)) return message.content;
  return typeof message.content === "string" ? [{ text: message.content }] : [];
}

function messageText(record: JsonRecord): string {
  return textFrom(
    isRecord(record.message) ? (record.message.content ?? record.message.parts) : undefined,
  );
}

function toolCall(part: JsonRecord): { id: string; name: string; input: unknown } | null {
  const call = isRecord(part.functionCall) ? part.functionCall : part.tool_use;
  if (!isRecord(call)) return null;
  const id =
    typeof call.id === "string" ? call.id : typeof call.callId === "string" ? call.callId : null;
  const name = typeof call.name === "string" ? call.name : null;
  if (!id || !name) return null;
  return { id, name, input: call.args ?? call.input ?? {} };
}

function toolResult(record: JsonRecord): { id: string; output: unknown; failed: boolean } | null {
  const result = isRecord(record.toolCallResult) ? record.toolCallResult : null;
  const part = messageParts(record).find(
    (candidate) => isRecord(candidate) && (candidate.functionResponse || candidate.tool_result),
  );
  const response =
    part && isRecord(part)
      ? isRecord(part.functionResponse)
        ? part.functionResponse
        : part.tool_result
      : null;
  const source = result ?? (isRecord(response) ? response : null);
  if (!source) return null;
  const id =
    typeof source.callId === "string"
      ? source.callId
      : typeof source.id === "string"
        ? source.id
        : typeof source.tool_use_id === "string"
          ? source.tool_use_id
          : null;
  if (!id) return null;
  return {
    id,
    output: source.resultDisplay ?? source.response ?? source.result ?? source.content ?? "",
    failed: source.error === true || source.is_error === true,
  };
}

function stableItemId(kind: string, turn: number, index: number) {
  return hostItemIdSchema.parse(`qwen-history-${kind}-${turn}-${index}`);
}

function projectHistory(
  records: readonly JsonRecord[],
  harnessId: HarnessId,
  sessionId: string,
  cwd: string,
  knownTurnRefs: readonly NativeTurnRef[],
  toolOutputLimit: number,
): HostThreadSnapshot {
  const turns: HostTurnSnapshot[] = [];
  let input = "";
  let items: HostItemSnapshot[] = [];
  let agent: HostAgentMessageItem | null = null;
  let reasoning: HostReasoningItem | null = null;
  const tools = new Map<string, QwenCodeProjectedToolItem>();
  let itemIndex = 0;
  const finishItem = (
    item: HostAgentMessageItem | HostReasoningItem | QwenCodeProjectedToolItem,
    outcome: HostItemSnapshot["outcome"],
  ): void => {
    items.push({ item, outcome });
  };
  const finishTurn = (outcome: HistoricalTurnOutcome): void => {
    if (input.length === 0) return;
    if (agent && agent.text.length > 0) finishItem(agent, { status: "succeeded" });
    if (reasoning && reasoning.text.length > 0) finishItem(reasoning, { status: "succeeded" });
    for (const tool of tools.values()) finishItem(tool, { status: "succeeded" });
    const ordinal = turns.length;
    turns.push({
      nativeTurnRef: nativeTurnRefSchema.parse({
        harnessId,
        nativeSessionId: sessionId,
        nativeTurnKey: qwenCodeTurnKey(ordinal),
        formatVersion: 1,
      }),
      input: [{ type: "text", text: input }],
      items,
      outcome,
    });
    input = "";
    items = [];
    agent = null;
    reasoning = null;
    tools.clear();
    itemIndex = 0;
  };
  for (const record of records) {
    if (record.type === "system") continue;
    if (record.type === "user") {
      const subtype = record.subtype;
      const result = toolResult(record);
      if (result) {
        const tool = tools.get(result.id);
        if (tool) {
          tools.delete(result.id);
          const projection = projectQwenCodeToolOutput(undefined, result.output, toolOutputLimit);
          finishItem(
            Object.keys(projection).length > 0
              ? applyQwenCodeToolProjection(tool, projection)
              : tool,
            result.failed
              ? {
                  status: "failed",
                  error: {
                    code: "nativeFailure",
                    message: "Qwen Code Tool failed",
                    retryable: false,
                  },
                }
              : { status: "succeeded" },
          );
        }
        continue;
      }
      if (subtype === "notification" || subtype === "cron" || subtype === "mid_turn_user_message")
        continue;
      finishTurn({ status: "unknown", reason: "Qwen Code history Turn was superseded" });
      input = messageText(record);
      continue;
    }
    if (record.type === "tool_result") {
      const result = toolResult(record);
      const tool = result ? tools.get(result.id) : undefined;
      if (result && tool) {
        tools.delete(result.id);
        const projection = projectQwenCodeToolOutput(undefined, result.output, toolOutputLimit);
        finishItem(
          Object.keys(projection).length > 0 ? applyQwenCodeToolProjection(tool, projection) : tool,
          result.failed
            ? {
                status: "failed",
                error: {
                  code: "nativeFailure",
                  message: "Qwen Code Tool failed",
                  retryable: false,
                },
              }
            : { status: "succeeded" },
        );
      }
      continue;
    }
    if (record.type !== "assistant" || input.length === 0) continue;
    for (const candidate of messageParts(record)) {
      if (!isRecord(candidate)) continue;
      const call = toolCall(candidate);
      if (call) {
        if (agent) {
          finishItem(agent, { status: "succeeded" });
          agent = null;
        }
        tools.set(
          call.id,
          startQwenCodeToolItem({
            itemId: stableItemId("tool", turns.length, ++itemIndex),
            name: call.name,
            title: call.name,
            rawInput: call.input,
            cwd,
          }),
        );
      } else if (typeof candidate.text === "string" && candidate.text.length > 0) {
        if (!agent)
          agent = {
            type: "agentMessage",
            itemId: stableItemId("message", turns.length, ++itemIndex),
            text: "",
          };
        agent = { ...agent, text: agent.text + candidate.text };
      } else if (typeof candidate.thinking === "string" && candidate.thinking.length > 0) {
        if (!reasoning)
          reasoning = {
            type: "reasoning",
            itemId: stableItemId("reasoning", turns.length, ++itemIndex),
            text: "",
          };
        reasoning = { ...reasoning, text: reasoning.text + candidate.thinking };
      }
    }
  }
  finishTurn({ status: "succeeded" });
  const selected =
    knownTurnRefs.length > 0 && turns.length > knownTurnRefs.length
      ? turns.slice(-knownTurnRefs.length)
      : turns;
  return {
    turns: selected.map((turn, index) => ({
      ...turn,
      nativeTurnRef: knownTurnRefs[index] ?? turn.nativeTurnRef,
    })),
  };
}

export function mapQwenCodeHistory(
  records: readonly unknown[],
  harnessId: HarnessId,
  sessionId: string,
  cwd: string,
  knownTurnRefs: readonly NativeTurnRef[] = [],
  toolOutputLimit = 64_000,
): HostThreadSnapshot {
  return projectHistory(
    records.filter(isRecord),
    harnessId,
    sessionId,
    cwd,
    knownTurnRefs,
    toolOutputLimit,
  );
}

function sanitizeCwd(cwd: string): string {
  return (process.platform === "win32" ? cwd.toLowerCase() : cwd).replace(/[^a-zA-Z0-9]/g, "-");
}

export async function readQwenCodeHistory(
  cwd: string,
  harnessId: HarnessId,
  sessionId: string,
  knownTurnRefs: readonly NativeTurnRef[] = [],
  toolOutputLimit = 64_000,
): Promise<HostThreadSnapshot> {
  const runtimeBase = process.env.QWEN_RUNTIME_DIR || path.join(os.homedir(), ".qwen");
  const projectDir = path.join(runtimeBase, "projects", sanitizeCwd(cwd), "chats");
  const paths = [
    path.join(projectDir, `${sessionId}.jsonl`),
    path.join(projectDir, "archive", `${sessionId}.jsonl`),
  ];
  for (const filePath of paths) {
    try {
      const content = await readFile(filePath, "utf8");
      return mapQwenCodeHistory(
        content.split(/\r?\n/u).flatMap((line) => {
          try {
            return line ? [JSON.parse(line)] : [];
          } catch {
            return [];
          }
        }),
        harnessId,
        sessionId,
        cwd,
        knownTurnRefs,
        toolOutputLimit,
      );
    } catch {
      // A missing or concurrently rotated transcript is equivalent to empty history.
    }
  }
  return { turns: [] };
}
