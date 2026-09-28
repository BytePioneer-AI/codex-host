import type { DeepSeekModernProfile } from "./profile.js";
import { ModernHistoryError, exactKeys, positiveInteger, requiredString } from "./validation.js";
import { isRecord, parseEvent } from "./journal-format.js";
import {
  DEEPSEEK_V015_PROFILE,
  expandV015AssistantStream,
  parseV015AssistantBaseline,
  parseV015HistoryRecord,
  parseV015LiveItem,
} from "./v015.js";
import type { ModernJournalEvent, ModernJournalHeader } from "../modern/journal.js";

function invalid(label: string): never {
  throw new ModernHistoryError("protocolError", `DSH V4 ${label} is malformed`);
}

function requiredFields(value: Record<string, unknown>, fields: readonly string[]): void {
  if (fields.some((field) => !Object.hasOwn(value, field))) invalid("required fields");
}

function validateV4Content(value: unknown): void {
  if (!Array.isArray(value)) invalid("content");
  for (const block of value) {
    if (!isRecord(block) || block.type === "tool-result") invalid("content block");
    if (block.type === "tool-addition" || block.type === "tool-removal") {
      requiredString(block.toolName, "tool change toolName");
      continue;
    }
    if (block.type === "image" && block.offloaded !== undefined && block.offloaded !== true) {
      invalid("image offloaded marker");
    }
    const ordinary = Object.fromEntries(
      Object.entries(block).filter(([key]) => key !== "offloaded"),
    );
    // V4 keeps producer extension fields on known content blocks. Validate the
    // canonical fields while leaving those extensions opaque.
    const canonical =
      block.type === "text" || block.type === "reasoning"
        ? { type: block.type, text: block.text }
        : block.type === "image" || block.type === "file"
          ? { type: block.type, attachment: block.attachment }
          : block.type === "tool-call"
            ? { type: block.type, id: block.id, name: block.name, arguments: block.arguments }
            : ordinary;
    DEEPSEEK_V015_PROFILE.validateContent([canonical]);
  }
}

function validateV4Chunk(value: unknown): void {
  DEEPSEEK_V015_PROFILE.validateChunk(value);
  if (!isRecord(value)) invalid("assistant chunk");
  const blockType =
    value.type === "block-start"
      ? value.blockType
      : value.type === "block-end" && isRecord(value.block)
        ? value.block.type
        : undefined;
  if (
    blockType === "tool-result" ||
    blockType === "tool-addition" ||
    blockType === "tool-removal"
  ) {
    invalid("assistant tool-change block");
  }
}

function validateV4Stream(value: unknown): void {
  for (const entry of expandV015AssistantStream(value)) validateV4Chunk(entry.chunk);
}

function validateDeveloperMessage(event: ModernJournalEvent): void {
  if (!isRecord(event.data)) invalid("developer/message data");
  const data = event.data;
  requiredFields(data, ["turn", "step", "message"]);
  if (Object.hasOwn(data, "headerSeq") && !Number.isSafeInteger(data.headerSeq))
    invalid("developer/message headerSeq");
  positiveInteger(data.turn, "developer/message turn");
  positiveInteger(data.step, "developer/message step");
  if (!isRecord(data.message)) invalid("developer/message message");
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
    invalid("developer/message role, source or content");
  }
  let additions = false;
  for (const block of message.content) {
    if (!isRecord(block)) invalid("developer content block");
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
    invalid("developer/message headerSeq");
  }
}

function matchesV4ForkTail(
  prefix: readonly ModernJournalEvent[],
  child: readonly ModernJournalEvent[],
): boolean {
  if (!DEEPSEEK_V015_PROFILE.matchesForkTail(prefix, child)) return false;
  const tail = child.slice(prefix.length + 1);
  const openTurn = prefix.reduce<number | null>(
    (turn, event) =>
      event.type === "turn/start"
        ? (event.data as { turn: number }).turn
        : event.type === "turn/end"
          ? null
          : turn,
    null,
  );
  const closer = tail.find((event) => event.type === "turn/end");
  if (openTurn === null)
    return closer === undefined && !tail.some((event) => event.type === "step/end");
  return (
    closer !== undefined &&
    isRecord(closer.data) &&
    closer.data.turn === openTurn &&
    isRecord(closer.data.reason) &&
    closer.data.reason.kind === "forked"
  );
}

export const DEEPSEEK_V017_PROFILE = Object.freeze<DeepSeekModernProfile>({
  ...DEEPSEEK_V015_PROFILE,
  version: "0.1.7-rc.1",
  checkpointPrefix: "v4-turn-end:",
  sessionFormatVersion: 4,
  matchesForkTail: matchesV4ForkTail,
  parseHeader(value, expected): ModernJournalHeader {
    if (!isRecord(value) || value.version !== 4) invalid("journal header");
    if (
      value.delegationDepth !== undefined &&
      (!Number.isSafeInteger(value.delegationDepth) ||
        Object.is(value.delegationDepth, -0) ||
        (value.delegationDepth as number) < 0)
    ) {
      invalid("journal header delegationDepth");
    }
    const delegationDepth = value.delegationDepth ?? 0;
    DEEPSEEK_V015_PROFILE.parseHeader({ ...value, version: 3, delegationDepth }, expected);
    return { ...value, delegationDepth } as unknown as ModernJournalHeader;
  },
  parseHistoryRecord: (value, remaining) =>
    parseV015HistoryRecord(value, remaining, (event) => parseEvent(event, 4)),
  parseLiveItem: (value) => {
    const item = parseV015LiveItem(value, (event) => parseEvent(event, 4));
    if (item.type === "assistant-stream" && "frame" in item && item.frame.type === "chunk") {
      validateV4Chunk(item.frame.chunk);
    }
    return item;
  },
  parseAssistantBaseline(value) {
    const baseline = parseV015AssistantBaseline(value);
    if (baseline.activeAttempt) validateV4Stream(baseline.activeAttempt.stream);
    return baseline;
  },
  validateContent: validateV4Content,
  validateChunk: validateV4Chunk,
  validateEvent(event): void {
    if (event.type === "developer/message") {
      validateDeveloperMessage(event);
    } else if (event.type === "system/message") {
      if (!isRecord(event.data) || !isRecord(event.data.message)) invalid("system/message");
      exactKeys(event.data, ["turn", "step", "message"]);
      const message = event.data.message;
      requiredFields(message, ["id", "role", "content", "source"]);
      requiredString(message.id, "system/message id");
      if (
        message.role !== "system" ||
        !isRecord(message.source) ||
        message.source.kind !== "system-prompt"
      ) {
        invalid("system/message source");
      }
      validateV4Content(message.content);
    } else if (event.type === "image/offload") {
      if (!isRecord(event.data)) invalid("image/offload");
      exactKeys(event.data, ["targets"]);
      if (!Array.isArray(event.data.targets) || event.data.targets.length === 0)
        invalid("image/offload targets");
    } else if (event.type === "workspace/changes") {
      if (!isRecord(event.data)) invalid("workspace/changes");
      exactKeys(event.data, ["turn"]);
      positiveInteger(event.data.turn, "workspace/changes turn");
    } else if (event.type === "tool/result") {
      if (!isRecord(event.data)) invalid("tool/result");
      const message = event.data.message;
      if (event.data.error !== undefined && (!isRecord(message) || message.isError !== true)) {
        invalid("tool/result error marker");
      }
    } else if (event.type === "request/header") {
      DEEPSEEK_V015_PROFILE.validateEvent(event);
      if (!isRecord(event.data) || !isRecord(event.data.header)) invalid("request/header");
      const tools = event.data.header.tools;
      if (
        tools !== undefined &&
        (!Array.isArray(tools) ||
          tools.some(
            (tool) =>
              !isRecord(tool) || (tool.deferLoading !== undefined && tool.deferLoading !== true),
          ))
      ) {
        invalid("request/header tools");
      }
    } else if (event.type === "assistant/message" || event.type === "assistant/attempt") {
      DEEPSEEK_V015_PROFILE.validateEvent(event);
      if (!isRecord(event.data)) invalid("assistant settlement");
      validateV4Stream(event.data.stream);
    } else {
      DEEPSEEK_V015_PROFILE.validateEvent(event);
    }
  },
});
