import type { JsonObject, RoutedHarnessId } from "@codexhost/protocol-core";

import {
  DelegationControlError,
  type DelegationMessage,
  type DelegationMessageTurn,
  type DelegationThreadSnapshot,
  type DelegationThreadStatus,
  type ThreadReadInput,
} from "./delegation-types.js";

const DEFAULT_TURN_COUNT = 10;
const MAX_TURN_COUNT = 50;

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function threadTitle(thread: JsonObject): string | null {
  if (typeof thread.name === "string" && thread.name.trim()) return thread.name;
  if (typeof thread.preview === "string" && thread.preview.trim()) return thread.preview;
  return null;
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
  if (isRecord(value) && value.type === "active") return "running";
  return "completed";
}

function turnStatus(value: unknown): DelegationThreadStatus {
  if (value === "inProgress" || value === "running") return "running";
  if (value === "failed") return "failed";
  if (value === "interrupted" || value === "cancelled") return "interrupted";
  return "completed";
}

function agentItems(turn: JsonObject): JsonObject[] {
  return Array.isArray(turn.items)
    ? turn.items.filter(
        (item): item is JsonObject => isRecord(item) && item.type === "agentMessage",
      )
    : [];
}

function messageTurn(
  turn: JsonObject,
  turnNumber: number,
  running: boolean,
): DelegationMessageTurn {
  const status = running ? "running" : turnStatus(turn.status);
  const messages: DelegationMessage[] = [];
  if (Array.isArray(turn.items)) {
    for (const item of turn.items) {
      if (!isRecord(item) || item.type !== "userMessage") continue;
      const id = stringValue(item.id);
      const text = textFromUserItem(item);
      if (id && text.trim()) messages.push({ id, role: "user", text });
    }
  }
  if (status !== "running") {
    const agents = agentItems(turn);
    const finals = agents.filter((item) => item.phase === "final");
    const final = (finals.length ? finals : agents)
      .filter((item) => typeof item.text === "string" && item.text.trim())
      .at(-1);
    const id = final ? stringValue(final.id) : null;
    if (final && id && typeof final.text === "string") {
      messages.push({ id, role: "agent", phase: "final", text: final.text });
    }
  }
  return { turnId: stringValue(turn.id), turnNumber, status, messages };
}

function latestAgentMessages(turn: JsonObject | null) {
  const turnId = turn ? stringValue(turn.id) : null;
  if (!turn || !turnId) return [];
  const agents = agentItems(turn);
  return agents.flatMap((item, index) => {
    const id = stringValue(item.id);
    if (!id || typeof item.text !== "string" || !item.text.trim()) return [];
    const phase =
      item.phase === "commentary" || item.phase === "final"
        ? item.phase
        : turn.status === "inProgress" || index < agents.length - 1
          ? "commentary"
          : "final";
    return [{ id, turnId, phase, text: item.text }];
  });
}

export function validateReadOptions(
  input: ThreadReadInput,
): Pick<ThreadReadInput, "view" | "from" | "to"> {
  if (input.view !== "result" && input.view !== "messages") {
    throw new DelegationControlError("INVALID_ARGUMENT", "View must be 'result' or 'messages'");
  }
  if (input.view === "result" && (input.from !== undefined || input.to !== undefined)) {
    throw new DelegationControlError("INVALID_ARGUMENT", "--from and --to require --view messages");
  }
  for (const name of ["from", "to"] as const) {
    const value = input[name];
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
      throw new DelegationControlError("INVALID_ARGUMENT", `${name} must be a positive integer`);
    }
  }
  if (input.from !== undefined && input.to !== undefined && input.from > input.to) {
    throw new DelegationControlError("INVALID_ARGUMENT", "from must not exceed to");
  }
  return {
    view: input.view,
    ...(input.from !== undefined ? { from: input.from } : {}),
    ...(input.to !== undefined ? { to: input.to } : {}),
  };
}

function turnRange(totalTurns: number, options: Pick<ThreadReadInput, "from" | "to">) {
  const to = Math.min(options.to ?? totalTurns, totalTurns);
  const from = options.from ?? Math.max(1, to - DEFAULT_TURN_COUNT + 1);
  if (from > to) return { from: null, to: null };
  if (to - from + 1 > MAX_TURN_COUNT) {
    throw new DelegationControlError(
      "INVALID_ARGUMENT",
      `A read may return at most ${MAX_TURN_COUNT} Turns`,
    );
  }
  return { from, to };
}

export function projectDelegationThreadSnapshot(input: {
  threadId: string;
  harnessId: RoutedHarnessId;
  thread: JsonObject;
  turns: readonly JsonObject[];
  running: boolean;
  view: "result" | "messages";
  from?: number;
  to?: number;
}): DelegationThreadSnapshot {
  const options = validateReadOptions(input);
  const latestTurn = input.turns.at(-1) ?? null;
  const latestTurnId = latestTurn ? stringValue(latestTurn.id) : null;
  const latestTurnStatus = latestTurn ? turnStatus(latestTurn.status) : null;
  const status = input.running
    ? "running"
    : latestTurnStatus === "failed" || latestTurnStatus === "interrupted"
      ? latestTurnStatus
      : threadStatus(input.thread.status, input.running);
  const latestTurnMessages = latestAgentMessages(latestTurn);
  const final = latestTurnMessages.filter((message) => message.phase === "final").at(-1);
  const progress =
    options.view === "result"
      ? latestTurnMessages
          .filter((message) => message.phase !== "final")
          .map(({ id, turnId, text }) => ({ id, turnId, text }))
      : [];
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
  const title = threadTitle(input.thread);
  const snapshot: DelegationThreadSnapshot = {
    threadId: input.threadId,
    harnessId: input.harnessId,
    ...(typeof input.thread.cwd === "string" && input.thread.cwd ? { cwd: input.thread.cwd } : {}),
    ...(title ? { title } : {}),
    status,
    turn:
      latestTurnId && latestTurnStatus ? { turnId: latestTurnId, status: latestTurnStatus } : null,
    progress,
    result,
  };
  if (options.view === "messages") {
    const totalTurns = input.turns.length;
    const range = turnRange(totalTurns, options);
    const turns: DelegationMessageTurn[] = [];
    if (range.from !== null && range.to !== null) {
      for (let number = range.to; number >= range.from; number -= 1) {
        const turn = input.turns[number - 1];
        if (turn) turns.push(messageTurn(turn, number, input.running && number === totalTurns));
      }
    }
    return { ...snapshot, totalTurns, ...range, turns };
  }
  return snapshot;
}
