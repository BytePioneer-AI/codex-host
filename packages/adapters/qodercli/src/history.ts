import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

import type {
  HostAgentMessageItem,
  HostReasoningItem,
  HostThreadSnapshot,
  HostToolExecutionItem,
  HostTurnSnapshot,
} from "@codexhost/harness-adapter";
import {
  hostItemIdSchema,
  nativeCheckpointRefSchema,
  nativeTurnRefSchema,
  type NativeSessionRef,
} from "@codexhost/shared-contracts";

import { qoderModelRef } from "./models.js";

export function qoderConfigDir(environment: NodeJS.ProcessEnv): string {
  return environment.QODER_CONFIG_DIR?.trim() || path.join(os.homedir(), ".qoder");
}

export function encodeQoderProjectKey(cwd: string): string {
  return path
    .resolve(cwd)
    .replaceAll("\\", "/")
    .replace(/^\/+/u, "/")
    .replaceAll(/[^A-Za-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "");
}

export function qoderSessionLogPath(
  cwd: string,
  sessionId: string,
  environment: NodeJS.ProcessEnv,
): string {
  return path.join(
    qoderConfigDir(environment),
    "projects",
    `-${encodeQoderProjectKey(cwd)}`,
    `${sessionId}.jsonl`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isToolResultUser(message: Record<string, unknown>): boolean {
  if (!Array.isArray(message.content)) return false;
  return (
    message.content.length > 0 &&
    message.content.every((block) => isRecord(block) && block.type === "tool_result")
  );
}

function textFromMessage(message: unknown): string {
  if (!isRecord(message)) return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .flatMap((block) => {
      if (!isRecord(block)) return [];
      if (typeof block.text === "string") return [block.text];
      if (typeof block.thinking === "string") return [];
      return [];
    })
    .join("");
}

export function mapQoderJsonlSnapshot(
  nativeRef: NativeSessionRef,
  raw: string,
): HostThreadSnapshot {
  const turns: HostTurnSnapshot[] = [];
  let current: HostTurnSnapshot | undefined;
  let itemOrdinal = 0;
  for (const line of raw.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed) || typeof parsed.type !== "string") continue;
    const message = parsed.message;
    if (parsed.type === "user" && isRecord(message) && message.role === "user") {
      if (isToolResultUser(message)) continue;
      const nativeTurnKey =
        (typeof parsed.promptId === "string" && parsed.promptId) ||
        (typeof parsed.uuid === "string" && parsed.uuid) ||
        `user-${turns.length + 1}`;
      current = {
        nativeTurnRef: nativeTurnRefSchema.parse({
          harnessId: nativeRef.harnessId,
          nativeSessionId: nativeRef.nativeSessionId,
          nativeTurnKey,
          formatVersion: 1,
        }),
        checkpoint: nativeCheckpointRefSchema.parse({
          harnessId: nativeRef.harnessId,
          nativeSessionId: nativeRef.nativeSessionId,
          checkpointId: nativeTurnKey,
          formatVersion: 1,
        }),
        input: [{ type: "text", text: textFromMessage(message) }],
        items: [],
        outcome: { status: "unknown", reason: "Qoder historical stop reason is not stored" },
      };
      turns.push(current);
      continue;
    }
    if (!current) continue;
    if (parsed.type === "assistant" && isRecord(message)) {
      const model = typeof message.model === "string" ? message.model : undefined;
      if (model) current.model = qoderModelRef(model);
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (!isRecord(block)) continue;
        itemOrdinal += 1;
        const itemId = hostItemIdSchema.parse(`qoder-history-${itemOrdinal}`);
        if (block.type === "text" && typeof block.text === "string") {
          const item: HostAgentMessageItem = { type: "agentMessage", itemId, text: block.text };
          current.items.push({ item, outcome: { status: "succeeded" } });
        } else if (block.type === "thinking" && typeof block.thinking === "string") {
          const item: HostReasoningItem = { type: "reasoning", itemId, text: block.thinking };
          current.items.push({ item, outcome: { status: "succeeded" } });
        } else if (block.type === "tool_use" && typeof block.name === "string") {
          const item: HostToolExecutionItem = {
            type: "toolExecution",
            itemId,
            toolName: block.name,
            arguments: (block.input as HostToolExecutionItem["arguments"]) ?? null,
          };
          current.items.push({ item, outcome: { status: "succeeded" } });
        }
      }
    }
  }
  return { turns };
}

export function readQoderSnapshot(
  nativeRef: NativeSessionRef,
  cwd: string,
  environment: NodeJS.ProcessEnv,
): HostThreadSnapshot {
  const file = qoderSessionLogPath(cwd, nativeRef.nativeSessionId, environment);
  if (!existsSync(file)) return { turns: [] };
  return mapQoderJsonlSnapshot(nativeRef, readFileSync(file, "utf8"));
}
