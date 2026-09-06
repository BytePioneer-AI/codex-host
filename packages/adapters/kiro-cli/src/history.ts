import { access, readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  HarnessModelRef,
  HostItemSnapshot,
  HostThreadSnapshot,
  HostTurnSnapshot,
} from "@codexhost/harness-adapter";
import {
  harnessIdSchema,
  harnessModelRefSchema,
  hostItemIdSchema,
  nativeCheckpointRefSchema,
  nativeSessionRefSchema,
  nativeTurnRefSchema,
  type NativeCheckpointRef,
  type NativeSessionRef,
  type NativeTurnRef,
} from "@codexhost/shared-contracts";

import { projectKiroFileChanges } from "./file-diff.js";
import { encodeKiroPermissionMode } from "./permission-modes.js";
import { projectKiroToolCall } from "./projection.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface KiroSessionMeta {
  id: string;
  workspacePaths: string[];
  modelId?: string | undefined;
  autopilot?: boolean | string | undefined;
  schemaVersion?: string | undefined;
  dataModelVersion?: number | undefined;
}

export interface KiroNativeSessionLocation {
  sessionDirectory: string;
  sessionMeta: KiroSessionMeta;
  cwd: string;
}

export function kiroHomeDir(environment: NodeJS.ProcessEnv = process.env): string {
  const home = environment.HOME ?? environment.USERPROFILE ?? os.homedir();
  return environment.KIRO_HOME ?? path.join(home, ".kiro");
}

export async function locateKiroNativeSession(
  input: {
    environment?: NodeJS.ProcessEnv | undefined;
    homeDirectory?: string | undefined;
  },
  sessionId: string,
): Promise<KiroNativeSessionLocation | null> {
  if (!sessionId || sessionId.trim().length === 0) return null;

  const root = path.join(kiroHomeDir(input.environment), "sessions");
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "cli") continue;
    const sessionDir = path.join(root, entry.name, sessionId);
    const metaFile = path.join(sessionDir, "session.json");
    try {
      await access(metaFile);
      const content = await readFile(metaFile, "utf8");
      const meta = JSON.parse(content) as KiroSessionMeta;
      if (meta && meta.id === sessionId) {
        const cwd =
          Array.isArray(meta.workspacePaths) && meta.workspacePaths.length > 0
            ? path.resolve(meta.workspacePaths[0] as string)
            : process.cwd();
        return {
          sessionDirectory: sessionDir,
          sessionMeta: meta,
          cwd,
        };
      }
    } catch {
      continue;
    }
  }

  return null;
}

export interface KiroHistoryRow {
  id: string;
  timestamp?: string;
  payload: {
    type: string;
    text?: string | undefined;
    toolCallId?: string | undefined;
    name?: string | undefined;
    command?: string | undefined;
    rawInput?: unknown;
    rawOutput?: unknown;
    content?: unknown;
    status?: string | undefined;
    kind?: string | undefined;
    [key: string]: unknown;
  };
}

export async function readKiroNativeMessages(sessionDirectory: string): Promise<KiroHistoryRow[]> {
  const messagesFile = path.join(sessionDirectory, "messages.jsonl");
  const raw = await readFile(messagesFile, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const row: unknown = JSON.parse(line);
      if (
        !isRecord(row) ||
        typeof row.id !== "string" ||
        !isRecord(row.payload) ||
        typeof row.payload.type !== "string"
      )
        throw new Error("Invalid Kiro history row");
      return row as unknown as KiroHistoryRow;
    });
}

function historyText(payload: KiroHistoryRow["payload"]): string {
  return typeof payload.content === "string" ? payload.content : (payload.text ?? "");
}

export interface KiroTurnBoundary {
  turnIndex: number;
  userMessageId: string;
  userPromptText: string;
  turnEndMessageId?: string | undefined;
  rows: KiroHistoryRow[];
}

export interface KiroHistorySummary {
  turns: KiroTurnBoundary[];
  bootstrapMessageId?: string | undefined;
}

export function parseKiroHistory(rows: KiroHistoryRow[]): KiroHistorySummary {
  let bootstrapMessageId: string | undefined;
  const turns: KiroTurnBoundary[] = [];
  let currentTurn: KiroTurnBoundary | null = null;

  for (const row of rows) {
    const type = row.payload?.type;

    if (!currentTurn && turns.length === 0 && type !== "user") {
      // Row before first user turn
      bootstrapMessageId = row.id;
      continue;
    }

    if (type === "user") {
      if (currentTurn) {
        turns.push(currentTurn);
      }
      currentTurn = {
        turnIndex: turns.length,
        userMessageId: row.id,
        userPromptText: historyText(row.payload),
        rows: [row],
      };
      continue;
    }

    if (currentTurn) {
      if (currentTurn.turnEndMessageId && type !== "tombstone") continue;
      currentTurn.rows.push(row);
      if (type === "turn_end") {
        currentTurn.turnEndMessageId = row.id;
      }
    }
  }

  if (currentTurn) {
    turns.push(currentTurn);
  }

  return { turns, ...(bootstrapMessageId ? { bootstrapMessageId } : {}) };
}

export function findForkBoundary(
  summary: KiroHistorySummary,
  targetCheckpointId?: string,
): string | null {
  if (summary.turns.length === 0) {
    return summary.bootstrapMessageId ?? null;
  }

  if (!targetCheckpointId) {
    const last = summary.turns[summary.turns.length - 1];
    return last?.turnEndMessageId ?? last?.userMessageId ?? null;
  }

  if (targetCheckpointId === summary.bootstrapMessageId) {
    return summary.bootstrapMessageId;
  }

  for (const turn of summary.turns) {
    if (turn.turnEndMessageId === targetCheckpointId || turn.userMessageId === targetCheckpointId) {
      return turn.turnEndMessageId ?? turn.userMessageId;
    }
    // Also check inside turn rows
    if (turn.rows.some((r) => r.id === targetCheckpointId)) {
      return targetCheckpointId;
    }
  }

  return null;
}

export function findRollbackBoundary(summary: KiroHistorySummary): string | null {
  if (summary.turns.length >= 2) {
    // Drop the last turn, fork at the end of the previous turn
    const prevTurn = summary.turns[summary.turns.length - 2];
    return prevTurn?.turnEndMessageId ?? prevTurn?.userMessageId ?? null;
  }

  if (summary.turns.length === 1) {
    // Drop the only turn; requires a bootstrap boundary before user turn 0
    return summary.bootstrapMessageId ?? null;
  }

  return null;
}

export async function readKiroSnapshot(
  location: KiroNativeSessionLocation,
): Promise<HostThreadSnapshot> {
  const rows = await readKiroNativeMessages(location.sessionDirectory);
  const summary = parseKiroHistory(rows);
  const turns: HostTurnSnapshot[] = [];

  const harnessId = harnessIdSchema.parse("kiro-cli");
  const nativeSessionId = location.sessionMeta.id;

  for (const turn of summary.turns) {
    const nativeTurnRef: NativeTurnRef = nativeTurnRefSchema.parse({
      harnessId,
      nativeSessionId,
      nativeTurnKey: turn.userMessageId,
      formatVersion: 1,
    });

    const checkpoint: NativeCheckpointRef | undefined = turn.turnEndMessageId
      ? nativeCheckpointRefSchema.parse({
          harnessId,
          nativeSessionId,
          checkpointId: turn.turnEndMessageId,
          formatVersion: 1,
        })
      : undefined;

    const items: HostItemSnapshot[] = [];
    const results = new Map(
      turn.rows
        .filter(
          (row) => row.payload.type === "tool_result" && typeof row.payload.toolCallId === "string",
        )
        .map((row) => [row.payload.toolCallId, row]),
    );
    const end = turn.rows.findLast((row) => row.payload.type === "turn_end");
    const stopReason = end?.payload.stopReason;
    const outcome: HostTurnSnapshot["outcome"] =
      stopReason === "cancelled"
        ? { status: "cancelled" }
        : stopReason === "end_turn"
          ? { status: "succeeded" }
          : stopReason === "error" || stopReason === "failed"
            ? {
                status: "failed",
                error: { code: "nativeFailure", message: "Kiro turn failed", retryable: false },
              }
            : { status: "unknown", reason: "Kiro history has no recognized terminal stopReason" };
    const start = turn.rows.find((row) => row.payload.type === "turn_start") ?? turn.rows[0];
    const startedAtMs = Date.parse(start?.timestamp ?? "");
    const completedAtMs = Date.parse(end?.timestamp ?? "");
    const hasTiming =
      Number.isFinite(startedAtMs) &&
      Number.isFinite(completedAtMs) &&
      startedAtMs >= 0 &&
      completedAtMs >= startedAtMs;
    // A trailing assistant row is the final response; pre-tool messages remain progress.
    const lastContent = turn.rows.findLast((row) =>
      ["assistant", "tool_call"].includes(row.payload.type),
    );

    for (const [index, row] of turn.rows.entries()) {
      const type = row.payload?.type;
      const itemId = hostItemIdSchema.parse(`item-${turn.turnIndex}-${index}`);

      if (type === "assistant") {
        items.push({
          item: {
            type: "agentMessage",
            itemId,
            text: historyText(row.payload),
            phase:
              row === lastContent && outcome.status === "succeeded" ? "final_answer" : "commentary",
          },
          outcome: { status: "succeeded" },
        });
      } else if (type === "tool_call") {
        const result = results.get(row.payload.toolCallId);
        const succeeded = result?.payload.success === true;
        const toolOutcome: HostItemSnapshot["outcome"] = succeeded
          ? { status: "succeeded" }
          : result?.payload.success === false
            ? {
                status: "failed",
                error: { code: "nativeFailure", message: "Kiro tool failed", retryable: false },
              }
            : { status: "cancelled", reason: "No confirmed tool result" };
        items.push({
          item: projectKiroToolCall(itemId, {
            toolCallId: row.payload.toolCallId ?? row.id,
            name:
              typeof row.payload.toolName === "string" ? row.payload.toolName : row.payload.name,
            kind: row.payload.kind,
            rawInput: row.payload.args ?? row.payload.rawInput,
            rawOutput: result?.payload.content ?? result?.payload.rawOutput,
            ...(isRecord(row.payload._meta) ? { metadata: row.payload._meta } : {}),
            status: succeeded ? "completed" : "failed",
          }),
          outcome: toolOutcome,
        });
      } else if (type === "tool_result") {
        const changes =
          row.payload.success === true
            ? projectKiroFileChanges(row.payload.content, location.cwd)
            : null;
        if (changes) {
          items.push({
            item: {
              type: "fileChange",
              itemId,
              changes,
            },
            outcome: { status: "succeeded" },
          });
        }
      } else if (type === "tombstone" && row.payload.kind === "summarization") {
        items.push({
          item: {
            type: "contextCompaction",
            itemId,
          },
          outcome: { status: "succeeded" },
        });
      }
    }

    let modelRef: HarnessModelRef | undefined;
    if (location.sessionMeta.modelId) {
      const parsedModel = harnessModelRefSchema.safeParse({ id: location.sessionMeta.modelId });
      if (parsedModel.success) modelRef = parsedModel.data;
    }

    turns.push({
      nativeTurnRef,
      ...(checkpoint ? { checkpoint } : {}),
      input: [{ type: "text", text: turn.userPromptText }],
      items,
      outcome,
      ...(hasTiming ? { startedAtMs, completedAtMs } : {}),
      ...(modelRef ? { model: modelRef } : {}),
    });
  }

  const nativeRef: NativeSessionRef = nativeSessionRefSchema.parse({
    harnessId,
    nativeSessionId,
    formatVersion: 1,
    locator: {
      engine: "v3",
      kind: "local-session-directory",
      sessionDirectory: location.sessionDirectory,
    },
  });

  return {
    turns,
    state: {
      nativeRef,
      ...(location.sessionMeta.modelId
        ? { effectiveModel: harnessModelRefSchema.parse({ id: location.sessionMeta.modelId }) }
        : {}),
      effectivePermissionModeId: encodeKiroPermissionMode(location.sessionMeta.autopilot),
    },
  };
}
