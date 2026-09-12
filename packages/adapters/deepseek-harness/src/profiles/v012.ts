import { isDeepStrictEqual } from "node:util";
import type { DeepSeekModernProfile } from "./profile.js";
import type {
  ModernJournalEvent,
  ModernJournalJson,
  ModernJournalHeader,
  ModernJournalOpenRequest,
} from "../modern/journal.js";
import {
  hasExactKeys,
  hasRequiredOptionalKeys,
  isRecord,
  isSeq,
  isFiniteNumber,
  isNonNegativeSafeInteger,
  limitError,
  protocolError,
  parseEvent,
} from "./journal-format.js";
import {
  exactKeys,
  requiredOptionalKeys,
  fail,
  requiredString,
  validateBaseContent,
  validateChunk,
} from "./validation.js";

export const DEEPSEEK_V012_PROFILE = Object.freeze<DeepSeekModernProfile>({
  version: "0.1.2-rc.1",
  checkpointPrefix: "turn-end:",
  matchesForkTail,
  sessionFormatVersion: 0,
  assistantStream: false,
  snapshotKeys: ["type", "header", "cursor", "records", "hasMore", "projections"],
  parseHeader: parseV012Header,
  parseHistoryRecord,
  parseLiveItem(value: unknown) {
    if (!isRecord(value) || !hasExactKeys(value, ["type", "event"]) || value.type !== "event") {
      throw protocolError("journal live follow emitted a non-event frame");
    }
    return parseEvent(value.event);
  },
  inheritedEventCount: (header) => header.seedLength,
  validateContent: validateBaseContent,
  validateChunk: (value) => validateChunk(value, validateBaseContent),
  validateEvent(event) {
    const data = event.data as Record<string, unknown>;
    switch (event.type) {
      case "assistant/attempt":
      case "feedback/message-put":
      case "feedback/message-delete":
      case "system/message":
      case "deliverables/presented":
      case "subagent/catalog":
      case "tool/ptc-dispatch":
      case "tool/ptc-dispatch-start":
        fail("Modern history contains an event from another DSH profile");
      case "feedback/record":
        exactKeys(data, ["text"]);
        requiredString(data.text, "feedback/record text");
        break;
      case "assistant/message":
        requiredOptionalKeys(data, ["turn", "step", "message"], ["usage", "interrupted"]);
        break;
      case "session/end-seed":
        exactKeys(data, []);
        break;
      case "session-log-deepseek/delivery-accepted":
        exactKeys(data, ["sessionId", "throughSeq"]);
        break;
    }
  },
});

function parseHistoryRecord(value: unknown, remainingEvents: number): ModernJournalEvent[] {
  if (remainingEvents < 1) throw limitError("journal history exceeded its logical event bound");
  if (!isRecord(value) || !hasExactKeys(value, ["type", "event"])) {
    throw protocolError("journal history record has an invalid envelope");
  }
  if (value.type === "event") return [parseEvent(value.event)];
  if (value.type === "chunks") return expandChunkRow(value.event, remainingEvents);
  throw protocolError("journal history record has an unknown kind");
}

function expandChunkRow(value: unknown, remainingEvents: number): ModernJournalEvent[] {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["type", "seq", "time", "data"]) ||
    typeof value.type !== "string" ||
    !["chunkrow/text-chunks", "chunkrow/reasoning-chunks", "chunkrow/tool-call-chunks"].includes(
      value.type,
    ) ||
    !isSeq(value.seq) ||
    !Number.isSafeInteger(value.time) ||
    !isRecord(value.data)
  ) {
    throw protocolError("journal chunk row has an invalid envelope");
  }
  const data = value.data;
  const tool = value.type === "chunkrow/tool-call-chunks";
  const withName = tool && Object.hasOwn(data, "name");
  const expectedDataKeys = tool
    ? withName
      ? ["turn", "step", "index", "id", "name", "dt", "args"]
      : ["turn", "step", "index", "id", "dt", "args"]
    : ["turn", "step", "index", "dt", "texts"];
  if (
    !hasExactKeys(data, expectedDataKeys) ||
    !isFiniteNumber(data.turn) ||
    !isFiniteNumber(data.step) ||
    !isFiniteNumber(data.index) ||
    (tool && (typeof data.id !== "string" || (withName && typeof data.name !== "string")))
  ) {
    throw protocolError("journal chunk row has invalid data fields");
  }
  const payload = data[tool ? "args" : "texts"];
  const dt = data.dt;
  if (
    !Array.isArray(payload) ||
    payload.length === 0 ||
    payload.some((entry) => typeof entry !== "string") ||
    !Array.isArray(dt) ||
    dt.some((gap) => !Number.isSafeInteger(gap)) ||
    dt.length !== payload.length - 1
  ) {
    throw protocolError("journal chunk row has invalid member arrays");
  }
  const seq = value.seq as number;
  if (payload.length > remainingEvents) throw limitError("journal chunk row exceeded maxEvents");
  if (payload.length - 1 > Number.MAX_SAFE_INTEGER - seq) {
    throw protocolError("journal chunk row member sequences overflow");
  }
  const events: ModernJournalEvent[] = [];
  let time = value.time as number;
  for (let index = 0; index < payload.length; index += 1) {
    if (index > 0) time += dt[index - 1] as number;
    if (!Number.isSafeInteger(time)) throw protocolError("journal chunk row member times overflow");
    const chunk = tool
      ? {
          type: "tool-call-delta",
          index: data.index,
          id: data.id,
          ...(withName ? { name: data.name } : {}),
          argumentsDelta: payload[index],
        }
      : {
          type: value.type === "chunkrow/text-chunks" ? "text-delta" : "reasoning-delta",
          index: data.index,
          text: payload[index],
        };
    events.push({
      type: "assistant/chunk",
      seq: seq + index,
      time,
      data: { turn: data.turn, step: data.step, chunk } as ModernJournalJson,
    });
  }
  return events;
}

function parseV012Header(value: unknown, expected: ModernJournalOpenRequest): ModernJournalHeader {
  if (
    !isRecord(value) ||
    !hasRequiredOptionalKeys(
      value,
      ["version", "id", "createdAt"],
      ["cwd", "parentSession", "seedLength", "origin", "delegationDepth", "agentPreset"],
    )
  ) {
    throw protocolError("journal snapshot has an invalid header");
  }
  if (
    value.version !== 0 ||
    value.id !== expected.sessionId ||
    !isNonNegativeSafeInteger(value.createdAt) ||
    Object.hasOwn(value, "cwd") !== (expected.cwd !== undefined) ||
    value.cwd !== expected.cwd ||
    (Object.hasOwn(value, "parentSession") && typeof value.parentSession !== "string") ||
    (Object.hasOwn(value, "seedLength") && !isNonNegativeSafeInteger(value.seedLength)) ||
    (Object.hasOwn(value, "origin") && value.origin !== "subagent") ||
    (Object.hasOwn(value, "delegationDepth") && !isNonNegativeSafeInteger(value.delegationDepth)) ||
    (Object.hasOwn(value, "agentPreset") && typeof value.agentPreset !== "string")
  ) {
    throw protocolError("journal snapshot header does not match the requested Session");
  }
  return value as unknown as ModernJournalHeader;
}

function matchesForkTail(
  expectedPrefix: readonly ModernJournalEvent[],
  childEvents: readonly ModernJournalEvent[],
): boolean {
  const childOwned = [...childEvents.slice(expectedPrefix.length)];
  if (expectedPrefix.at(-1)?.type !== "session/end-seed") {
    const marker = childOwned.shift();
    if (
      marker?.type !== "session/end-seed" ||
      marker.seq !== expectedPrefix.length ||
      !isDeepStrictEqual(marker.data, {}) ||
      marker.ignorable !== undefined ||
      marker.sourceEventSeqs !== undefined ||
      marker.surfaceOp !== undefined
    ) {
      return false;
    }
  }
  return childOwned.every(
    (event) => event.type !== "turn/start" && event.type !== "session/end-seed",
  );
}
