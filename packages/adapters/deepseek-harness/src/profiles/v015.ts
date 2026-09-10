import { isDeepStrictEqual } from "node:util";
import type { DeepSeekModernProfile } from "./profile.js";
import { parseEvent } from "./journal-format.js";
import {
  exactKeys,
  requiredOptionalKeys,
  fail,
  nonNegativeSafeInteger,
  validateBaseContent,
  validateChunk,
  ModernHistoryError,
} from "./validation.js";
import type {
  ModernJournalEvent,
  ModernJournalHeader,
  ModernJournalJson,
  ModernJournalLiveItem,
  ModernJournalOpenRequest,
} from "../modern/journal.js";

export const V015_JOURNAL_SNAPSHOT_KEYS = Object.freeze([
  "type",
  "header",
  "cursor",
  "records",
  "hasMore",
  "projections",
  "assistantStream",
]);

export class DeepSeekV015ProtocolError extends ModernHistoryError {
  constructor(message: string) {
    super("protocolError", message);
    this.name = "DeepSeekV015ProtocolError";
  }
}

export interface DeepSeekV015TimedChunk {
  readonly time: number;
  readonly chunk: Readonly<Record<string, ModernJournalJson>>;
}

export interface DeepSeekV015AssistantAttempt {
  readonly attemptId: string;
  readonly startedAfterSeq: number;
  readonly turn: number;
  readonly step: number;
  readonly nextIndex: number;
  readonly stream: readonly ModernJournalJson[];
}

export interface DeepSeekV015AssistantBaseline {
  readonly revision: number;
  readonly activeAttempt?: DeepSeekV015AssistantAttempt;
}

export type DeepSeekV015AssistantFrame =
  | {
      readonly type: "start";
      readonly attemptId: string;
      readonly revision: number;
      readonly startedAfterSeq: number;
      readonly turn: number;
      readonly step: number;
    }
  | {
      readonly type: "chunk";
      readonly attemptId: string;
      readonly revision: number;
      readonly index: number;
      readonly time: number;
      readonly chunk: Readonly<Record<string, ModernJournalJson>>;
    }
  | {
      readonly type: "end";
      readonly attemptId: string;
      readonly revision: number;
      readonly index: number;
      readonly outcome:
        | {
            readonly kind: "committed";
            readonly eventType: "assistant/message" | "assistant/attempt";
            readonly seq: number;
          }
        | { readonly kind: "abandoned" };
    };

export function parseV015JournalHeader(
  value: unknown,
  expected: ModernJournalOpenRequest,
): ModernJournalHeader {
  if (
    !isRecord(value) ||
    !onlyKeys(
      value,
      ["version", "id", "createdAt", "isSeeded"],
      ["cwd", "parentSession", "origin", "delegationDepth", "agentPreset"],
    ) ||
    value.version !== 3 ||
    value.id !== expected.sessionId ||
    !isNonNegativeSafeInteger(value.createdAt) ||
    Object.hasOwn(value, "cwd") !== (expected.cwd !== undefined) ||
    value.cwd !== expected.cwd ||
    typeof value.isSeeded !== "boolean" ||
    (Object.hasOwn(value, "parentSession") && typeof value.parentSession !== "string") ||
    (Object.hasOwn(value, "origin") && value.origin !== "subagent") ||
    (Object.hasOwn(value, "delegationDepth") && !isNonNegativeSafeInteger(value.delegationDepth)) ||
    (Object.hasOwn(value, "agentPreset") && typeof value.agentPreset !== "string")
  ) {
    throw invalid("journal snapshot header");
  }
  return value as unknown as ModernJournalHeader;
}

export function parseV015HistoryRecord(
  value: unknown,
  remainingEvents: number,
  parseEvent: (value: unknown) => ModernJournalEvent,
): ModernJournalEvent[] {
  if (remainingEvents < 1) throw invalid("journal event bound");
  if (!isRecord(value) || !onlyKeys(value, ["type", "event"]) || value.type !== "event") {
    throw invalid("journal history record");
  }
  return [parseEvent(value.event)];
}

export function parseV015LiveItem(
  value: unknown,
  parseEvent: (value: unknown) => ModernJournalEvent,
): ModernJournalLiveItem {
  if (!isRecord(value)) throw invalid("journal live frame");
  if (onlyKeys(value, ["type", "event"]) && value.type === "event") {
    return parseEvent(value.event);
  }
  if (onlyKeys(value, ["type", "frame"]) && value.type === "assistant-stream") {
    return { type: "assistant-stream", frame: parseV015AssistantFrame(value.frame) };
  }
  throw invalid("journal live frame");
}

export function parseV015AssistantBaseline(value: unknown): DeepSeekV015AssistantBaseline {
  if (!isRecord(value) || !onlyKeys(value, ["revision"], ["activeAttempt"])) {
    throw invalid("assistant stream baseline");
  }
  const revision = nonNegativeInteger(value.revision, "assistant stream baseline revision");
  if (value.activeAttempt === undefined) return { revision };
  if (revision === 0) throw invalid("assistant stream active baseline revision");
  const attempt = value.activeAttempt;
  if (
    !isRecord(attempt) ||
    !onlyKeys(attempt, ["attemptId", "startedAfterSeq", "turn", "step", "nextIndex", "stream"])
  ) {
    throw invalid("assistant stream baseline attempt");
  }
  const parsed: DeepSeekV015AssistantAttempt = {
    attemptId: identifier(attempt.attemptId, "assistant stream attemptId"),
    startedAfterSeq: cursor(attempt.startedAfterSeq, "assistant stream startedAfterSeq"),
    turn: positiveInteger(attempt.turn, "assistant stream turn"),
    step: positiveInteger(attempt.step, "assistant stream step"),
    nextIndex: nonNegativeInteger(attempt.nextIndex, "assistant stream nextIndex"),
    stream: jsonArray(attempt.stream, "assistant stream baseline stream"),
  };
  const expanded = expandV015AssistantStream(parsed.stream);
  if (expanded.length !== parsed.nextIndex) {
    throw invalid("assistant stream baseline nextIndex");
  }
  return { revision, activeAttempt: parsed };
}

export function parseV015AssistantFrame(value: unknown): DeepSeekV015AssistantFrame {
  if (!isRecord(value) || typeof value.type !== "string") throw invalid("assistant stream frame");
  const attemptId = identifier(value.attemptId, "assistant stream attemptId");
  const revision = positiveInteger(value.revision, "assistant stream revision");
  switch (value.type) {
    case "start":
      if (!onlyKeys(value, ["type", "attemptId", "revision", "startedAfterSeq", "turn", "step"])) {
        throw invalid("assistant stream start frame");
      }
      return {
        type: "start",
        attemptId,
        revision,
        startedAfterSeq: cursor(value.startedAfterSeq, "assistant stream startedAfterSeq"),
        turn: positiveInteger(value.turn, "assistant stream turn"),
        step: positiveInteger(value.step, "assistant stream step"),
      };
    case "chunk":
      if (!onlyKeys(value, ["type", "attemptId", "revision", "index", "time", "chunk"])) {
        throw invalid("assistant stream chunk frame");
      }
      if (!isRecord(value.chunk)) throw invalid("assistant stream chunk");
      assertJsonValue(value.chunk, "assistant stream chunk");
      validateV015Chunk(value.chunk);
      return {
        type: "chunk",
        attemptId,
        revision,
        index: nonNegativeInteger(value.index, "assistant stream chunk index"),
        time: safeInteger(value.time, "assistant stream chunk time"),
        chunk: value.chunk as Readonly<Record<string, ModernJournalJson>>,
      };
    case "end": {
      if (!onlyKeys(value, ["type", "attemptId", "revision", "index", "outcome"])) {
        throw invalid("assistant stream end frame");
      }
      const outcome = value.outcome;
      if (!isRecord(outcome) || typeof outcome.kind !== "string") {
        throw invalid("assistant stream outcome");
      }
      if (outcome.kind === "abandoned") {
        if (!onlyKeys(outcome, ["kind"])) throw invalid("assistant stream abandoned outcome");
        return {
          type: "end",
          attemptId,
          revision,
          index: nonNegativeInteger(value.index, "assistant stream end index"),
          outcome: { kind: "abandoned" },
        };
      }
      if (
        outcome.kind !== "committed" ||
        !onlyKeys(outcome, ["kind", "eventType", "seq"]) ||
        (outcome.eventType !== "assistant/message" && outcome.eventType !== "assistant/attempt")
      ) {
        throw invalid("assistant stream committed outcome");
      }
      return {
        type: "end",
        attemptId,
        revision,
        index: nonNegativeInteger(value.index, "assistant stream end index"),
        outcome: {
          kind: "committed",
          eventType: outcome.eventType,
          seq: nonNegativeInteger(outcome.seq, "assistant stream settlement seq"),
        },
      };
    }
    default:
      throw invalid("assistant stream frame");
  }
}

export function expandV015AssistantStream(value: unknown): readonly DeepSeekV015TimedChunk[] {
  if (!Array.isArray(value)) throw invalid("assistant stream");
  const chunks: DeepSeekV015TimedChunk[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate) || typeof candidate.type !== "string") {
      throw invalid("assistant stream record");
    }
    if (candidate.type === "chunk") {
      if (!onlyKeys(candidate, ["type", "time", "chunk"]) || !isRecord(candidate.chunk)) {
        throw invalid("assistant stream raw chunk record");
      }
      assertJsonValue(candidate.chunk, "assistant stream raw chunk");
      validateV015Chunk(candidate.chunk);
      chunks.push({
        time: safeInteger(candidate.time, "assistant stream chunk time"),
        chunk: candidate.chunk as Readonly<Record<string, ModernJournalJson>>,
      });
      continue;
    }
    const tool = candidate.type === "tool-call-chunks";
    if (!tool && candidate.type !== "text-chunks" && candidate.type !== "reasoning-chunks") {
      throw invalid("assistant stream record kind");
    }
    const withName = tool && Object.hasOwn(candidate, "name");
    const keys = tool
      ? withName
        ? ["type", "time0", "index", "dt", "id", "name", "args"]
        : ["type", "time0", "index", "dt", "id", "args"]
      : ["type", "time0", "index", "dt", "texts"];
    if (!onlyKeys(candidate, keys)) throw invalid("assistant stream compact record");
    const members = stringArray(candidate[tool ? "args" : "texts"], "assistant stream members");
    if (members.length === 0) throw invalid("assistant stream members");
    const gaps = integerArray(candidate.dt, "assistant stream dt");
    if (gaps.length !== members.length - 1) throw invalid("assistant stream dt length");
    const index = nonNegativeInteger(candidate.index, "assistant stream block index");
    const id = tool ? identifier(candidate.id, "assistant stream tool id") : undefined;
    const name = withName ? identifier(candidate.name, "assistant stream tool name") : undefined;
    let time = safeInteger(candidate.time0, "assistant stream first time");
    for (const [memberIndex, member] of members.entries()) {
      if (memberIndex > 0)
        time = safeInteger(time + (gaps[memberIndex - 1] as number), "assistant stream time");
      const chunk = tool
        ? {
            type: "tool-call-delta" as const,
            index,
            id: id as string,
            ...(withName ? { name: name as string } : {}),
            argumentsDelta: member,
          }
        : {
            type: candidate.type === "text-chunks" ? "text-delta" : "reasoning-delta",
            index,
            text: member,
          };
      chunks.push({ time, chunk });
    }
  }
  return chunks;
}

export function v015InheritedEventCount(
  isSeeded: boolean,
  events: readonly ModernJournalEvent[],
): number | undefined {
  let inherited: number | undefined;
  for (const event of events) {
    if (
      event.type === "session/end-seed" &&
      isRecord(event.data) &&
      event.data.inherited === true
    ) {
      inherited = event.seq;
    }
  }
  if (isSeeded !== (inherited !== undefined)) throw invalid("Session inherited marker");
  return inherited;
}

function jsonArray(value: unknown, label: string): readonly ModernJournalJson[] {
  if (!Array.isArray(value)) throw invalid(label);
  assertJsonValue(value, label);
  return value as readonly ModernJournalJson[];
}

function stringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.some((member) => typeof member !== "string")) {
    throw invalid(label);
  }
  return value;
}

function integerArray(value: unknown, label: string): readonly number[] {
  if (!Array.isArray(value) || value.some((member) => !Number.isSafeInteger(member))) {
    throw invalid(label);
  }
  return value as readonly number[];
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw invalid(label);
  return value;
}

function cursor(value: unknown, label: string): number {
  return value === -1 ? value : nonNegativeInteger(value, label);
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = safeInteger(value, label);
  if (parsed <= 0) throw invalid(label);
  return parsed;
}

function nonNegativeInteger(value: unknown, label: string): number {
  const parsed = safeInteger(value, label);
  if (parsed < 0 || Object.is(parsed, -0)) throw invalid(label);
  return parsed;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
  );
}

function safeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value)) throw invalid(label);
  return value as number;
}

function onlyKeys(
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Reflect.ownKeys(value).every((key) => typeof key === "string" && allowed.has(key))
  );
}

function assertJsonValue(value: unknown, label: string): void {
  const pending: Array<{ readonly value: unknown; readonly depth: number }> = [{ value, depth: 0 }];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const item = pending.pop() as { readonly value: unknown; readonly depth: number };
    const current = item.value;
    if (
      current === null ||
      typeof current === "string" ||
      typeof current === "boolean" ||
      (typeof current === "number" && Number.isFinite(current))
    ) {
      continue;
    }
    if (typeof current !== "object" || item.depth >= 100 || seen.has(current)) {
      throw invalid(label);
    }
    const prototype = Object.getPrototypeOf(current);
    if (
      Array.isArray(current)
        ? prototype !== Array.prototype
        : prototype !== Object.prototype && prototype !== null
    ) {
      throw invalid(label);
    }
    seen.add(current);
    if (Array.isArray(current)) {
      const keys = Reflect.ownKeys(current);
      if (
        keys.length !== current.length + 1 ||
        !keys.every(
          (key) =>
            key === "length" ||
            (typeof key === "string" &&
              /^(?:0|[1-9]\d*)$/u.test(key) &&
              Number(key) < current.length),
        )
      ) {
        throw invalid(label);
      }
      for (let index = 0; index < current.length; index += 1) {
        if (!Object.hasOwn(current, index)) throw invalid(label);
        pending.push({ value: current[index], depth: item.depth + 1 });
      }
      continue;
    }
    for (const key of Reflect.ownKeys(current)) {
      if (typeof key !== "string") throw invalid(label);
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) {
        throw invalid(label);
      }
      pending.push({ value: descriptor.value, depth: item.depth + 1 });
    }
  }
}

function validateV015Chunk(value: Readonly<Record<string, unknown>>): void {
  switch (value.type) {
    case "block-start":
      if (
        !onlyKeys(value, ["type", "index", "blockType"]) ||
        typeof value.blockType !== "string" ||
        value.blockType.length === 0
      ) {
        throw invalid("assistant stream block-start chunk");
      }
      nonNegativeInteger(value.index, "assistant stream block-start index");
      return;
    case "text-delta":
    case "reasoning-delta":
      if (!onlyKeys(value, ["type", "index", "text"]) || typeof value.text !== "string") {
        throw invalid("assistant stream text chunk");
      }
      nonNegativeInteger(value.index, "assistant stream text index");
      return;
    case "tool-call-delta":
      if (
        !onlyKeys(value, ["type", "index", "id", "argumentsDelta"], ["name"]) ||
        typeof value.id !== "string" ||
        typeof value.argumentsDelta !== "string" ||
        (Object.hasOwn(value, "name") && typeof value.name !== "string")
      ) {
        throw invalid("assistant stream tool-call chunk");
      }
      nonNegativeInteger(value.index, "assistant stream tool-call index");
      return;
    case "block-end":
      if (!onlyKeys(value, ["type", "index", "block"]) || !isRecord(value.block)) {
        throw invalid("assistant stream block-end chunk");
      }
      nonNegativeInteger(value.index, "assistant stream block-end index");
      validateV015ContentBlock(value.block);
      return;
    case "usage":
      if (!onlyKeys(value, ["type", "usage"]) || !isRecord(value.usage)) {
        throw invalid("assistant stream usage chunk");
      }
      return;
    case "finish":
      if (!onlyKeys(value, ["type", "reason"], ["replayState"]) || !isRecord(value.reason)) {
        throw invalid("assistant stream finish chunk");
      }
      validateChunk(value, validateV015Content);
      return;
    default:
      throw invalid("assistant stream chunk kind");
  }
}

function validateV015ContentBlock(value: Readonly<Record<string, unknown>>): void {
  if (value.type === "tool-result") {
    if (
      !onlyKeys(value, ["type", "toolCallId", "content"], ["isError"]) ||
      (value.isError !== undefined && typeof value.isError !== "boolean")
    )
      throw invalid("tool-result content");
    identifier(value.toolCallId, "tool-result toolCallId");
    validateV015Content(value.content);
    return;
  }
  if (value.type !== "file") {
    validateBaseContent([value]);
    return;
  }
  if (
    !onlyKeys(value, ["type", "attachment"]) ||
    !isRecord(value.attachment) ||
    !onlyKeys(value.attachment, ["attachmentId", "name", "bytes"]) ||
    typeof value.attachment.attachmentId !== "string" ||
    !value.attachment.attachmentId.trim() ||
    typeof value.attachment.name !== "string" ||
    !value.attachment.name.trim() ||
    !isNonNegativeSafeInteger(value.attachment.bytes)
  )
    throw invalid("file attachment");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(area: string): DeepSeekV015ProtocolError {
  return new DeepSeekV015ProtocolError(`DeepSeek Harness v0.1.5 ${area} is malformed`);
}

export const DEEPSEEK_V015_PROFILE = Object.freeze<DeepSeekModernProfile>({
  version: "0.1.5-rc.1",
  checkpointPrefix: "v3-turn-end:",
  matchesForkTail,
  sessionFormatVersion: 3,
  assistantStream: true,
  snapshotKeys: V015_JOURNAL_SNAPSHOT_KEYS,
  parseHeader: parseV015JournalHeader,
  parseHistoryRecord: (value, remaining) =>
    parseV015HistoryRecord(value, remaining, (event) => parseEvent(event, 3)),
  parseLiveItem: (value) => parseV015LiveItem(value, (event) => parseEvent(event, 3)),
  parseAssistantBaseline: parseV015AssistantBaseline,
  inheritedEventCount: (header, events) =>
    v015InheritedEventCount(header.isSeeded === true, events),
  validateContent: validateV015Content,
  validateChunk: (value) => {
    if (!isRecord(value)) throw invalid("assistant stream chunk");
    validateV015Chunk(value);
  },
  validateEvent(event) {
    const data = event.data as Record<string, unknown>;
    switch (event.type) {
      case "assistant/chunk":
      case "tool/code-dispatch":
      case "tool/code-dispatch-start":
        fail("Modern history contains an event from another DSH profile");
      case "system/message": {
        exactKeys(data, ["turn", "step", "message"]);
        if (!isRecord(data.message)) throw invalid("system/message");
        const message = data.message;
        exactKeys(message, ["id", "role", "content", "source"]);
        identifier(message.id, "system message id");
        if (
          message.role !== "system" ||
          !isRecord(message.source) ||
          message.source.kind !== "plugin"
        )
          throw invalid("system message source");
        identifier(message.source.plugin, "system message source plugin");
        validateV015Content(message.content);
        break;
      }
      case "request/header":
        if (!isRecord(data.header) || Object.hasOwn(data.header, "system"))
          throw invalid("request/header retired system field");
        break;
      case "tool/result":
        if (
          data.error !== undefined &&
          (!isRecord(data.message) ||
            !Array.isArray(data.message.content) ||
            !isRecord(data.message.content[0]) ||
            data.message.content[0].isError !== true)
        )
          throw invalid("tool/result error marker");
        break;
      case "feedback/record":
        requiredOptionalKeys(data, [], ["text", "category"]);
        if (data.text !== undefined && (typeof data.text !== "string" || !data.text.trim()))
          throw invalid("feedback text");
        validateFeedbackCategory(data.category);
        break;
      case "feedback/message-put": {
        exactKeys(data, ["sessionId", "item"]);
        identifier(data.sessionId, "feedback sessionId");
        if (!isRecord(data.item)) throw invalid("feedback item");
        const item = data.item;
        requiredOptionalKeys(
          item,
          ["messageId", "rating", "version", "createdAt", "updatedAt"],
          ["note", "category"],
        );
        identifier(item.messageId, "feedback messageId");
        identifier(item.version, "feedback version");
        if (item.rating !== "positive" && item.rating !== "negative")
          throw invalid("feedback rating");
        if (item.note !== undefined && (typeof item.note !== "string" || !item.note.trim()))
          throw invalid("feedback note");
        validateFeedbackCategory(item.category);
        nonNegativeInteger(item.createdAt, "feedback createdAt");
        nonNegativeInteger(item.updatedAt, "feedback updatedAt");
        break;
      }
      case "feedback/message-delete":
        exactKeys(data, ["sessionId", "messageId"]);
        identifier(data.sessionId, "feedback sessionId");
        identifier(data.messageId, "feedback messageId");
        break;
      case "deliverables/presented":
        exactKeys(data, ["turn", "callId", "files"]);
        positiveInteger(data.turn, "deliverables turn");
        identifier(data.callId, "deliverables callId");
        if (!Array.isArray(data.files)) throw invalid("deliverables files");
        for (const file of data.files) {
          if (!isRecord(file)) throw invalid("delivered file");
          requiredOptionalKeys(file, ["path"], ["description"]);
          identifier(file.path, "delivered file path");
          if (file.description !== undefined && typeof file.description !== "string")
            throw invalid("delivered file description");
        }
        break;
      case "subagent/catalog":
        requiredOptionalKeys(data, ["version", "childId", "childCreatedAt", "mode"], ["label"]);
        if (data.version !== 0 || (data.mode !== "one-shot" && data.mode !== "continuable"))
          throw invalid("subagent catalog");
        identifier(data.childId, "subagent catalog childId");
        nonNegativeInteger(data.childCreatedAt, "subagent catalog childCreatedAt");
        if (
          data.mode === "continuable"
            ? typeof data.label !== "string"
            : data.label !== undefined && typeof data.label !== "string"
        )
          throw invalid("subagent catalog label");
        break;
      case "team/member":
      case "team/task":
      case "team/message/queued":
        validateTeamPayload(event.type, data);
        break;
      case "assistant/message":
        if (event.sourceEventSeqs !== undefined)
          fail("DSH v0.1.5 assistant/message cannot carry sourceEventSeqs");
        requiredOptionalKeys(data, ["turn", "step", "message", "stream"], ["usage", "interrupted"]);
        expandV015AssistantStream(data.stream);
        break;
      case "assistant/attempt":
        exactKeys(data, ["turn", "step", "stream"]);
        expandV015AssistantStream(data.stream);
        break;
      case "session/end-seed":
        exactKeys(data, Object.hasOwn(data, "inherited") ? ["inherited"] : []);
        if (Object.hasOwn(data, "inherited") && data.inherited !== true)
          fail("DSH v0.1.5 inherited marker is malformed");
        break;
      case "session-log-deepseek/delivery-accepted":
        requiredOptionalKeys(data, ["sessionId", "throughSeq"], ["sessionFormatVersion"]);
        if (
          data.sessionFormatVersion !== undefined &&
          !nonNegativeSafeInteger(data.sessionFormatVersion)
        )
          fail("delivery-accepted sessionFormatVersion is malformed");
        break;
    }
  },
  settlementUsage(data) {
    if (data.usage !== undefined) return data.usage;
    let usage: unknown;
    for (const { chunk } of expandV015AssistantStream(data.stream)) {
      if (chunk.type === "usage") usage = chunk.usage;
    }
    return usage;
  },
});

function validateFeedbackCategory(value: unknown): void {
  if (
    value !== undefined &&
    ![
      "task-result",
      "instruction-following",
      "product-interaction",
      "service-stability",
      "resource-cost",
      "security-privacy-permission",
      "other",
    ].includes(value as string)
  )
    throw invalid("feedback category");
}

function validateTeamPayload(type: string, data: Record<string, unknown>): void {
  const key = type === "team/member" ? "member" : type === "team/task" ? "task" : "message";
  const value = data[key];
  if (!isRecord(value)) throw invalid("team payload");
  identifier(value.id, "team payload id");
  if (key === "member") {
    requiredOptionalKeys(
      value,
      ["id", "name", "description", "provider", "context", "phase"],
      ["error"],
    );
    for (const field of ["name", "description", "provider"])
      if (typeof value[field] !== "string") throw invalid(`team member ${field}`);
    if (
      !["fresh", "fork"].includes(value.context as string) ||
      !["provisioning", "active", "failed"].includes(value.phase as string) ||
      (value.error !== undefined && typeof value.error !== "string")
    )
      throw invalid("team member");
  } else if (key === "task") {
    requiredOptionalKeys(
      value,
      ["id", "revision", "subject", "description", "status", "blockedBy", "writeScopes"],
      ["ownerId"],
    );
    nonNegativeInteger(value.revision, "team task revision");
    if (
      typeof value.subject !== "string" ||
      typeof value.description !== "string" ||
      !["pending", "in_progress", "completed", "deleted"].includes(value.status as string)
    )
      throw invalid("team task");
    if (value.ownerId !== undefined) identifier(value.ownerId, "team task ownerId");
    stringArray(value.blockedBy, "team task blockedBy");
    stringArray(value.writeScopes, "team task writeScopes");
  } else {
    exactKeys(value, ["id", "senderId", "senderName", "targetId", "content"]);
    for (const field of ["senderId", "senderName", "targetId"])
      identifier(value[field], `team message ${field}`);
    validateV015Content(value.content);
  }
}

function validateV015Content(value: unknown): void {
  if (!Array.isArray(value)) throw invalid("message content");
  for (const block of value) {
    if (!isRecord(block)) throw invalid("content block");
    validateV015ContentBlock(block);
  }
}

function matchesForkTail(
  expectedPrefix: readonly ModernJournalEvent[],
  childEvents: readonly ModernJournalEvent[],
): boolean {
  const childOwned = [...childEvents.slice(expectedPrefix.length)];
  const marker = childOwned.shift();
  if (
    marker?.type !== "session/end-seed" ||
    marker.seq !== expectedPrefix.length ||
    !isDeepStrictEqual(marker.data, { inherited: true }) ||
    marker.ignorable !== undefined ||
    marker.sourceEventSeqs !== undefined ||
    marker.surfaceOp !== undefined
  ) {
    return false;
  }
  return childOwned.every(
    (event) => event.type !== "turn/start" && event.type !== "session/end-seed",
  );
}
