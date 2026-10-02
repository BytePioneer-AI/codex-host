import { isDeepStrictEqual } from "node:util";
import type { DeepSeekModernProfile } from "./profile.js";
import { isRecord, parseEvent } from "./journal-format.js";
import {
  ModernHistoryError,
  exactKeys,
  fail,
  nonNegativeSafeInteger,
  requiredOptionalKeys,
  requiredString,
  validateBaseContent,
  validateFinishReason,
} from "./validation.js";
import type {
  ModernJournalEvent,
  ModernJournalHeader,
  ModernJournalJson,
  ModernJournalLiveItem,
  ModernJournalOpenRequest,
} from "../modern/journal.js";

/** First DSH release that writes Session Format V4. */
export const DEEPSEEK_V4_FIRST_VERSION = "0.1.7-rc.1";

export const V4_JOURNAL_SNAPSHOT_KEYS = Object.freeze([
  "type",
  "header",
  "cursor",
  "records",
  "hasMore",
  "projections",
  "assistantStream",
]);

export interface DeepSeekTimedChunk {
  readonly time: number;
  readonly chunk: Readonly<Record<string, ModernJournalJson>>;
}

export interface DeepSeekAssistantAttempt {
  readonly attemptId: string;
  readonly startedAfterSeq: number;
  readonly turn: number;
  readonly step: number;
  readonly nextIndex: number;
  readonly stream: readonly ModernJournalJson[];
}

export interface DeepSeekAssistantBaseline {
  readonly revision: number;
  readonly activeAttempt?: DeepSeekAssistantAttempt;
}

export type DeepSeekAssistantFrame =
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

export function parseV4JournalHeader(
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
    value.version !== 4 ||
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
    throw invalid("journal header");
  }
  // DSH omits the depth of a top-level Session.
  return {
    ...value,
    delegationDepth: value.delegationDepth ?? 0,
  } as unknown as ModernJournalHeader;
}

export function parseV4HistoryRecord(
  value: unknown,
  remainingEvents: number,
): ModernJournalEvent[] {
  if (remainingEvents < 1) throw invalid("journal event bound");
  if (!isRecord(value) || !onlyKeys(value, ["type", "event"]) || value.type !== "event") {
    throw invalid("journal history record");
  }
  return [parseEvent(value.event)];
}

export function parseV4LiveItem(value: unknown): ModernJournalLiveItem {
  if (!isRecord(value)) throw invalid("journal live frame");
  if (onlyKeys(value, ["type", "event"]) && value.type === "event") {
    return parseEvent(value.event);
  }
  if (onlyKeys(value, ["type", "frame"]) && value.type === "assistant-stream") {
    return { type: "assistant-stream", frame: parseAssistantFrame(value.frame) };
  }
  throw invalid("journal live frame");
}

export function parseAssistantBaseline(value: unknown): DeepSeekAssistantBaseline {
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
  const parsed: DeepSeekAssistantAttempt = {
    attemptId: identifier(attempt.attemptId, "assistant stream attemptId"),
    startedAfterSeq: cursor(attempt.startedAfterSeq, "assistant stream startedAfterSeq"),
    turn: positiveInteger(attempt.turn, "assistant stream turn"),
    step: positiveInteger(attempt.step, "assistant stream step"),
    nextIndex: nonNegativeInteger(attempt.nextIndex, "assistant stream nextIndex"),
    stream: jsonArray(attempt.stream, "assistant stream baseline stream"),
  };
  const expanded = expandAssistantStream(parsed.stream);
  if (expanded.length !== parsed.nextIndex) {
    throw invalid("assistant stream baseline nextIndex");
  }
  return { revision, activeAttempt: parsed };
}

export function parseAssistantFrame(value: unknown): DeepSeekAssistantFrame {
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
      validateStreamChunk(value.chunk);
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

/** Expand DSH's compact stream records into the chunks they encode, validating each one. */
export function expandAssistantStream(value: unknown): readonly DeepSeekTimedChunk[] {
  if (!Array.isArray(value)) throw invalid("assistant stream");
  const chunks: DeepSeekTimedChunk[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate) || typeof candidate.type !== "string") {
      throw invalid("assistant stream record");
    }
    if (candidate.type === "chunk") {
      if (!onlyKeys(candidate, ["type", "time", "chunk"]) || !isRecord(candidate.chunk)) {
        throw invalid("assistant stream raw chunk record");
      }
      assertJsonValue(candidate.chunk, "assistant stream raw chunk");
      validateStreamChunk(candidate.chunk);
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

/** The seq of the one `session/end-seed` marker a seeded Session carries, if any. */
export function inheritedEventCount(
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

function requiredFields(value: Record<string, unknown>, fields: readonly string[]): void {
  if (fields.some((field) => !Object.hasOwn(value, field))) throw invalid("required fields");
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

function validateStreamChunk(value: unknown): void {
  if (!isRecord(value)) throw invalid("assistant stream chunk");
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
      break;
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
      validateBlock(value.block);
      break;
    case "usage":
      if (!onlyKeys(value, ["type", "usage"]) || !isRecord(value.usage)) {
        throw invalid("assistant stream usage chunk");
      }
      return;
    case "finish":
      if (!onlyKeys(value, ["type", "reason"], ["replayState"]) || !isRecord(value.reason)) {
        throw invalid("assistant stream finish chunk");
      }
      validateFinishReason(value.reason);
      return;
    default:
      throw invalid("assistant stream chunk kind");
  }
  // Tool changes and results are never streamed as assistant blocks.
  const blockType =
    value.type === "block-start" ? value.blockType : (value.block as { type?: unknown }).type;
  if (
    blockType === "tool-result" ||
    blockType === "tool-addition" ||
    blockType === "tool-removal"
  ) {
    throw invalid("assistant tool-change block");
  }
}

function validateBlock(value: Readonly<Record<string, unknown>>): void {
  if (value.type === "tool-result") {
    if (
      !onlyKeys(value, ["type", "toolCallId", "content"], ["isError"]) ||
      (value.isError !== undefined && typeof value.isError !== "boolean")
    )
      throw invalid("tool-result content");
    identifier(value.toolCallId, "tool-result toolCallId");
    validateBlocks(value.content);
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

function validateBlocks(value: unknown): void {
  if (!Array.isArray(value)) throw invalid("message content");
  for (const block of value) {
    if (!isRecord(block)) throw invalid("content block");
    validateBlock(block);
  }
}

/** Validate message content; V4 keeps producer extension fields on known blocks opaque. */
function validateV4Content(value: unknown): void {
  if (!Array.isArray(value)) throw invalid("content");
  for (const block of value) {
    if (!isRecord(block) || block.type === "tool-result") throw invalid("content block");
    if (block.type === "tool-addition" || block.type === "tool-removal") {
      requiredString(block.toolName, "tool change toolName");
      continue;
    }
    if (block.type === "image" && block.offloaded !== undefined && block.offloaded !== true) {
      throw invalid("image offloaded marker");
    }
    const ordinary = Object.fromEntries(
      Object.entries(block).filter(([key]) => key !== "offloaded"),
    );
    const canonical =
      block.type === "text" || block.type === "reasoning"
        ? { type: block.type, text: block.text }
        : block.type === "image" || block.type === "file"
          ? { type: block.type, attachment: block.attachment }
          : block.type === "tool-call"
            ? { type: block.type, id: block.id, name: block.name, arguments: block.arguments }
            : ordinary;
    validateBlock(canonical);
  }
}

function validateDeveloperMessage(event: ModernJournalEvent): void {
  if (!isRecord(event.data)) throw invalid("developer/message data");
  const data = event.data;
  requiredFields(data, ["turn", "step", "message"]);
  if (Object.hasOwn(data, "headerSeq") && !Number.isSafeInteger(data.headerSeq))
    throw invalid("developer/message headerSeq");
  positiveInteger(data.turn, "developer/message turn");
  positiveInteger(data.step, "developer/message step");
  if (!isRecord(data.message)) throw invalid("developer/message message");
  const message = data.message;
  requiredFields(message, ["id", "role", "content", "source"]);
  requiredString(message.id, "developer/message id");
  if (
    message.role !== "developer" ||
    !isRecord(message.source) ||
    typeof message.source.kind !== "string" ||
    !message.source.kind ||
    message.source.kind === "plugin" ||
    !Array.isArray(message.content)
  ) {
    throw invalid("developer/message role, source or content");
  }
  let additions = false;
  for (const block of message.content) {
    if (!isRecord(block)) throw invalid("developer content block");
    if (block.type === "tool-addition" || block.type === "tool-removal") {
      requiredString(block.toolName, "developer toolName");
      additions ||= block.type === "tool-addition";
    } else {
      validateV4Content([block]);
    }
  }
  if (
    additions !== Object.hasOwn(data, "headerSeq") ||
    (additions &&
      (!Number.isSafeInteger(data.headerSeq) ||
        Object.is(data.headerSeq, -0) ||
        (data.headerSeq as number) < 0 ||
        (data.headerSeq as number) >= event.seq))
  ) {
    throw invalid("developer/message headerSeq");
  }
}

function validateV4Event(event: ModernJournalEvent): void {
  const data = event.data as Record<string, unknown>;
  switch (event.type) {
    case "developer/message":
      validateDeveloperMessage(event);
      break;
    case "system/message": {
      if (!isRecord(data) || !isRecord(data.message)) throw invalid("system/message");
      exactKeys(data, ["turn", "step", "message"]);
      const message = data.message;
      requiredFields(message, ["id", "role", "content", "source"]);
      requiredString(message.id, "system/message id");
      if (
        message.role !== "system" ||
        !isRecord(message.source) ||
        message.source.kind !== "system-prompt"
      ) {
        throw invalid("system/message source");
      }
      validateV4Content(message.content);
      break;
    }
    case "image/offload":
      if (!isRecord(data)) throw invalid("image/offload");
      exactKeys(data, ["targets"]);
      if (!Array.isArray(data.targets) || data.targets.length === 0)
        throw invalid("image/offload targets");
      break;
    case "workspace/changes":
      if (!isRecord(data)) throw invalid("workspace/changes");
      exactKeys(data, ["turn"]);
      positiveInteger(data.turn, "workspace/changes turn");
      break;
    case "tool/result":
      if (!isRecord(data)) throw invalid("tool/result");
      if (data.error !== undefined && (!isRecord(data.message) || data.message.isError !== true)) {
        throw invalid("tool/result error marker");
      }
      break;
    case "request/header": {
      if (!isRecord(data.header) || Object.hasOwn(data.header, "system"))
        throw invalid("request/header retired system field");
      const tools = data.header.tools;
      if (
        tools !== undefined &&
        (!Array.isArray(tools) ||
          tools.some(
            (tool) =>
              !isRecord(tool) || (tool.deferLoading !== undefined && tool.deferLoading !== true),
          ))
      ) {
        throw invalid("request/header tools");
      }
      break;
    }
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
        fail("DSH V4 assistant/message cannot carry sourceEventSeqs");
      requiredOptionalKeys(data, ["turn", "step", "message", "stream"], ["usage", "interrupted"]);
      expandAssistantStream(data.stream);
      break;
    case "assistant/attempt":
      exactKeys(data, ["turn", "step", "stream"]);
      expandAssistantStream(data.stream);
      break;
    case "session/end-seed":
      exactKeys(data, Object.hasOwn(data, "inherited") ? ["inherited"] : []);
      if (Object.hasOwn(data, "inherited") && data.inherited !== true)
        fail("DSH V4 inherited marker is malformed");
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
}

function settlementUsage(data: Record<string, unknown>): unknown {
  if (data.usage !== undefined) return data.usage;
  let usage: unknown;
  for (const { chunk } of expandAssistantStream(data.stream)) {
    if (chunk.type === "usage") usage = chunk.usage;
  }
  return usage;
}

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
    validateBlocks(value.content);
  }
}

/** A child owns one inherited marker and, for a source Turn still open at the cut, a forked closer. */
function matchesV4ForkTail(
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
    marker.surfaceOp !== undefined ||
    childOwned.some((event) => event.type === "turn/start" || event.type === "session/end-seed")
  ) {
    return false;
  }
  const openTurn = expectedPrefix.reduce<number | null>(
    (turn, event) =>
      event.type === "turn/start"
        ? (event.data as { turn: number }).turn
        : event.type === "turn/end"
          ? null
          : turn,
    null,
  );
  const closer = childOwned.find((event) => event.type === "turn/end");
  if (openTurn === null)
    return closer === undefined && !childOwned.some((event) => event.type === "step/end");
  return (
    closer !== undefined &&
    isRecord(closer.data) &&
    closer.data.turn === openTurn &&
    isRecord(closer.data.reason) &&
    closer.data.reason.kind === "forked"
  );
}

function invalid(label: string): ModernHistoryError {
  return new ModernHistoryError("protocolError", `DSH V4 ${label} is malformed`);
}

export const DEEPSEEK_V4_PROFILE = Object.freeze<DeepSeekModernProfile>({
  version: DEEPSEEK_V4_FIRST_VERSION,
  checkpointPrefix: "v4-turn-end:",
  matchesForkTail: matchesV4ForkTail,
  snapshotKeys: V4_JOURNAL_SNAPSHOT_KEYS,
  parseHeader: parseV4JournalHeader,
  parseHistoryRecord: parseV4HistoryRecord,
  parseLiveItem: parseV4LiveItem,
  parseAssistantBaseline,
  inheritedEventCount: (header, events) => inheritedEventCount(header.isSeeded === true, events),
  validateEvent: validateV4Event,
  validateContent: validateV4Content,
  validateChunk: validateStreamChunk,
  settlementUsage,
});
