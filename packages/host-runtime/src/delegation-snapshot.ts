import { createHash } from "node:crypto";

import type { JsonObject } from "@codexhost/protocol-core";
import type { RoutedHarnessId } from "@codexhost/protocol-core";

import {
  DelegationControlError,
  type DelegationMessage,
  type DelegationThreadSnapshot,
  type DelegationThreadStatus,
  type ThreadReadInput,
} from "./delegation-types.js";

const CURSOR_PREFIX = "codexhost:thread-messages:v1:";
const DEFAULT_MESSAGE_LIMIT = 25;
const MAX_MESSAGE_LIMIT = 100;

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function textFromUserItem(item: JsonObject): string {
  if (!Array.isArray(item.content)) return "";
  return item.content
    .flatMap((part) =>
      isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : [],
    )
    .join("\n");
}

function threadStatus(value: unknown, running: boolean): DelegationThreadStatus {
  if (running) return "running";
  if (isRecord(value)) {
    if (value.type === "active") return "running";
  }
  return "completed";
}

function turnStatus(value: unknown): DelegationThreadStatus {
  if (value === "inProgress" || value === "running") return "running";
  if (value === "failed") return "failed";
  if (value === "interrupted" || value === "cancelled") return "interrupted";
  return "completed";
}

function allVisibleMessages(turns: readonly JsonObject[]): DelegationMessage[] {
  const messages: DelegationMessage[] = [];
  for (const turn of turns) {
    const turnId = stringValue(turn.id);
    if (!turnId || !Array.isArray(turn.items)) continue;
    const agentItems = turn.items.filter(
      (item): item is JsonObject => isRecord(item) && item.type === "agentMessage",
    );
    for (const item of turn.items) {
      if (!isRecord(item)) continue;
      const id = stringValue(item.id);
      if (!id) continue;
      if (item.type === "userMessage") {
        const text = textFromUserItem(item);
        if (text) messages.push({ id, turnId, role: "user", text });
      } else if (item.type === "agentMessage" && typeof item.text === "string" && item.text) {
        const itemIndex = agentItems.indexOf(item);
        const phase =
          item.phase === "commentary" || item.phase === "final"
            ? item.phase
            : turn.status === "inProgress" || itemIndex < agentItems.length - 1
              ? "commentary"
              : "final";
        messages.push({ id, turnId, role: "agent", phase, text: item.text });
      }
    }
  }
  return messages;
}

function cursorFingerprint(threadId: string): string {
  return createHash("sha256").update(threadId).digest("hex");
}

function encodeCursor(threadId: string, offset: number): string {
  const payload = JSON.stringify({ version: 1, fingerprint: cursorFingerprint(threadId), offset });
  return `${CURSOR_PREFIX}${Buffer.from(payload).toString("base64url")}`;
}

function decodeCursor(threadId: string, cursor: string | undefined): number {
  if (!cursor) return 0;
  if (!cursor.startsWith(CURSOR_PREFIX)) {
    throw new DelegationControlError("INVALID_ARGUMENT", "Message cursor is invalid");
  }
  try {
    const value = JSON.parse(
      Buffer.from(cursor.slice(CURSOR_PREFIX.length), "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    if (
      value.version !== 1 ||
      value.fingerprint !== cursorFingerprint(threadId) ||
      !Number.isSafeInteger(value.offset) ||
      (value.offset as number) < 0
    ) {
      throw new Error("invalid cursor");
    }
    return value.offset as number;
  } catch {
    throw new DelegationControlError("INVALID_ARGUMENT", "Message cursor is invalid");
  }
}

export function validateReadOptions(input: ThreadReadInput): Required<
  Pick<ThreadReadInput, "view">
> & {
  cursor?: string;
  limit: number;
} {
  if (input.view !== "result" && input.view !== "messages") {
    throw new DelegationControlError("INVALID_ARGUMENT", "View must be 'result' or 'messages'");
  }
  if (input.view === "result" && (input.cursor !== undefined || input.limit !== undefined)) {
    throw new DelegationControlError(
      "INVALID_ARGUMENT",
      "--cursor and --limit require --view messages",
    );
  }
  const limit = input.limit ?? DEFAULT_MESSAGE_LIMIT;
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_MESSAGE_LIMIT) {
    throw new DelegationControlError(
      "INVALID_ARGUMENT",
      `Message limit must be between 1 and ${MAX_MESSAGE_LIMIT}`,
    );
  }
  return { view: input.view, ...(input.cursor ? { cursor: input.cursor } : {}), limit };
}

export function projectDelegationThreadSnapshot(input: {
  threadId: string;
  harnessId: RoutedHarnessId;
  thread: JsonObject;
  turns: readonly JsonObject[];
  running: boolean;
  view: "result" | "messages";
  cursor?: string;
  limit?: number;
}): DelegationThreadSnapshot {
  const options = validateReadOptions({
    threadId: input.threadId,
    view: input.view,
    ...(input.cursor ? { cursor: input.cursor } : {}),
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
  });
  const visible = allVisibleMessages(input.turns);
  const latestTurn = input.turns.at(-1) ?? null;
  const latestTurnId = latestTurn ? stringValue(latestTurn.id) : null;
  const latestTurnStatus = latestTurn ? turnStatus(latestTurn.status) : null;
  const status = input.running
    ? "running"
    : latestTurnStatus === "failed" || latestTurnStatus === "interrupted"
      ? latestTurnStatus
      : threadStatus(input.thread.status, input.running);
  const latestTurnMessages = latestTurnId
    ? visible.filter((message) => message.turnId === latestTurnId && message.role === "agent")
    : [];
  const final = latestTurnMessages.filter((message) => message.phase === "final").at(-1);
  const progress = latestTurnMessages
    .filter((message) => message.phase !== "final")
    .map(({ id, turnId, text }) => ({ id, turnId, text }));
  const result = input.running
    ? ({ availability: "pending" } as const)
    : final
      ? ({ availability: "available", text: final.text } as const)
      : ({
          availability: "unavailable",
          ...(isRecord(latestTurn?.error) && typeof latestTurn.error.message === "string"
            ? { message: latestTurn.error.message }
            : {}),
        } as const);

  const offset =
    options.view === "messages" ? decodeCursor(input.threadId, options.cursor) : visible.length;
  const page =
    options.view === "messages" ? visible.slice(offset, offset + options.limit) : undefined;
  const nextOffset = options.view === "messages" ? offset + (page?.length ?? 0) : visible.length;
  return {
    threadId: input.threadId,
    harnessId: input.harnessId,
    status,
    turn:
      latestTurnId && latestTurnStatus ? { turnId: latestTurnId, status: latestTurnStatus } : null,
    progress,
    result,
    ...(page ? { messages: page } : {}),
    nextCursor: encodeCursor(input.threadId, nextOffset),
  };
}
