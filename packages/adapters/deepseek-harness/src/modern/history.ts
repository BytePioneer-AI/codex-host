import { isDeepStrictEqual } from "node:util";

import type {
  HarnessError,
  HarnessSessionState,
  HistoricalTurnOutcome,
  HostAgentMessageItem,
  HostFileChangeItem,
  HostItemOutcome,
  HostItemSnapshot,
  HostReasoningItem,
  HostTextInput,
  HostThreadSnapshot,
  HostToolExecutionItem,
  HostTurnSnapshot,
  HostUsage,
  TurnOutcome,
} from "@codexhost/harness-adapter";
import {
  harnessIdSchema,
  hostItemIdSchema,
  nativeCheckpointRefSchema,
  nativeSessionRefSchema,
  nativeTurnRefSchema,
  type HarnessId,
  type HarnessModelRef,
  type HarnessThinkingOptionId,
  type HostItemId,
  type NativeCheckpointRef,
  type NativeSessionRef,
  type NativeTurnRef,
} from "@codexhost/shared-contracts";

import { encodeDeepSeekHarnessModelRef, parseDeepSeekThinkingOptionId } from "../model-catalog.js";
import {
  deepSeekUsageKey,
  isRecord,
  mergeDeepSeekUsage,
  nonBlankString,
  parseArguments,
  parseDeepSeekContextWindow,
  parseDeepSeekUsage,
  projectToolResult,
  projectTurnReason,
  structuredDiffs,
} from "../projection.js";
import type { ModernJournalEvent } from "./journal.js";
import { redactModernCredential } from "./wire.js";

export const MODERN_HISTORY_MAX_EVENTS = 1_000_000;
export const MODERN_TOOL_OUTPUT_LIMIT = 64_000;

const DEEPSEEK_HARNESS_ID = harnessIdSchema.parse("deepseek-harness");

const KNOWN_EVENT_TYPES = new Set([
  "agent-preset/selected",
  "agent/inbox/spliced",
  "approval/asked",
  "approval/decided",
  "approval/policy",
  "assistant/chunk",
  "assistant/message",
  "command/done",
  "command/run",
  "compaction/end",
  "compaction/prune",
  "compaction/start",
  "compaction/summary",
  "feedback/record",
  "goal/change",
  "hook/invoked",
  "hook/result",
  "llm/retry",
  "llm/retry-started",
  "model/selection",
  "permission/preset",
  "plan/mode",
  "request/context",
  "request/header",
  "sandbox/mode",
  "schedule/change",
  "session-log-deepseek/delivery-accepted",
  "session/end-seed",
  "session/title",
  "session/title-llm-request",
  "step/end",
  "step/start",
  "subagent/descriptor",
  "subagent/model-selection-policy",
  "team/member",
  "team/message/delivered",
  "team/message/queued",
  "team/task",
  "todo/write",
  "tool-workflow/agent-end",
  "tool-workflow/agent-start",
  "tool-workflow/run-end",
  "tool-workflow/run-start",
  "tool/call",
  "tool/code-dispatch",
  "tool/code-dispatch-start",
  "tool/result",
  "turn/end",
  "turn/start",
  "user/message",
  "web/deepseek-search-llm-request",
]);

const SURFACE_EVENT_TYPES = new Set(["user/message", "assistant/message", "tool/result"]);

export type ModernHistoryErrorCode = "limitExceeded" | "protocolError";

export class ModernHistoryError extends Error {
  constructor(
    readonly code: ModernHistoryErrorCode,
    message: string,
  ) {
    super(redactModernCredential(message));
    this.name = "ModernHistoryError";
  }
}

interface ValidatorTrace {
  count: number;
  openTurn: number | null;
  openStep: number | null;
  nextTurn: number;
  nextStep: number;
  surface: ModernJournalEvent[];
  pendingCalls: Set<string>;
  commandStates: Map<string, "running" | "done">;
  commandEventSeqs: Set<number>;
}

/** Incremental validator shared by the initial history projector and live Session pump. */
export class ModernEventValidator {
  readonly #maxEvents: number;
  readonly #trace: ValidatorTrace = {
    count: 0,
    openTurn: null,
    openStep: null,
    nextTurn: 1,
    nextStep: 1,
    surface: [],
    pendingCalls: new Set(),
    commandStates: new Map(),
    commandEventSeqs: new Set(),
  };

  constructor(maxEvents = MODERN_HISTORY_MAX_EVENTS) {
    this.#maxEvents = boundedInteger(maxEvents, "maxEvents", 1);
  }

  accept(event: ModernJournalEvent): void {
    const trace = this.#trace;
    if (trace.count >= this.#maxEvents) fail("Modern history exceeded maxEvents", "limitExceeded");
    if (event.seq !== trace.count) fail("Modern history is not a contiguous zero-based prefix");
    trace.count += 1;

    if (!SURFACE_EVENT_TYPES.has(event.type)) {
      if (event.surfaceOp !== undefined || event.sourceEventSeqs !== undefined) {
        fail("Modern history has surface metadata on a log-only event");
      }
    } else if (event.surfaceOp === undefined) {
      fail("Modern history surface event omitted surfaceOp");
    }
    if (!KNOWN_EVENT_TYPES.has(event.type)) {
      if (event.ignorable === true) return;
      fail("Modern history contains an unknown required event");
    }
    if (!isRecord(event.data)) fail("Modern history contains malformed known event data");
    acceptSurfaceEvent(trace, event);

    const data = event.data;
    switch (event.type) {
      case "turn/start": {
        exactKeys(data, ["turn"]);
        const turn = positiveInteger(data.turn, "turn/start turn");
        if (trace.openTurn !== null || turn !== trace.nextTurn) {
          fail("Modern history has an invalid turn/start boundary");
        }
        trace.openTurn = turn;
        trace.nextStep = 1;
        return;
      }
      case "turn/end": {
        exactKeys(data, ["turn", "reason"]);
        const turn = positiveInteger(data.turn, "turn/end turn");
        validateTurnReason(data.reason);
        if (trace.openTurn !== turn || trace.openStep !== null) {
          fail("Modern history has an invalid turn/end boundary");
        }
        trace.openTurn = null;
        trace.nextTurn += 1;
        return;
      }
      case "step/start": {
        exactKeys(data, ["turn", "step"]);
        const { turn, step } = stepPosition(data, "step/start");
        if (trace.openTurn !== turn || trace.openStep !== null || trace.nextStep !== step) {
          fail("Modern history has an invalid step/start boundary");
        }
        trace.openStep = step;
        return;
      }
      case "step/end": {
        exactKeys(data, ["turn", "step"]);
        requireOpenStep(trace, data, "step/end");
        trace.openStep = null;
        trace.nextStep += 1;
        trace.pendingCalls.clear();
        return;
      }
      case "user/message":
        validateUserMessage(data);
        return;
      case "assistant/chunk":
        exactKeys(data, ["turn", "step", "chunk"]);
        requireOpenStep(trace, data, "assistant/chunk");
        validateChunk(data.chunk);
        return;
      case "assistant/message":
        requiredOptionalKeys(data, ["turn", "step", "message"], ["usage", "interrupted"]);
        requireOpenStep(trace, data, "assistant/message");
        validateAssistantMessage(data.message);
        if (data.interrupted !== undefined && data.interrupted !== true) {
          fail("Modern history assistant/message has invalid interrupted marker");
        }
        return;
      case "tool/call": {
        exactKeys(data, ["turn", "step", "callId", "name", "arguments"]);
        requireOpenStep(trace, data, "tool/call");
        const callId = requiredString(data.callId, "tool/call callId");
        requiredString(data.name, "tool/call name");
        if (typeof data.arguments !== "string" || trace.pendingCalls.has(callId)) {
          fail("Modern history contains an invalid tool/call");
        }
        trace.pendingCalls.add(callId);
        return;
      }
      case "tool/result": {
        requiredOptionalKeys(data, ["turn", "step", "message"], ["error", "meta"]);
        const callId = validateToolResultMessage(data.message);
        if (data.error !== undefined) validateToolError(data.error);
        if (event.surfaceOp === "append") {
          requireOpenStep(trace, data, "tool/result");
          if (!trace.pendingCalls.delete(callId)) {
            fail("Modern history contains an unmatched tool/result");
          }
        } else if (trace.openTurn === null) {
          fail("Modern history contains a tool/result replacement outside a Turn");
        }
        return;
      }
      case "request/header":
        validateRequestHeader(data);
        if (trace.openTurn === null) fail("Modern history request/header is outside a Turn");
        return;
      case "request/context":
        validateRequestContext(data);
        if (trace.openTurn === null) fail("Modern history request/context is outside a Turn");
        return;
      case "model/selection":
        validateModelSelection(data);
        return;
      case "session/end-seed":
        exactKeys(data, []);
        return;
      case "agent-preset/selected":
        exactKeys(data, ["agentPreset"]);
        requiredString(data.agentPreset, "agent-preset/selected agentPreset");
        return;
      case "agent/inbox/spliced":
        validateInboxSplice(data);
        return;
      case "approval/asked":
        validateApprovalAsked(data);
        return;
      case "approval/decided":
        validateApprovalDecided(data);
        return;
      case "permission/preset":
        exactKeys(data, ["preset"]);
        requiredString(data.preset, "permission/preset preset");
        return;
      case "plan/mode":
        exactKeys(data, ["active"]);
        if (typeof data.active !== "boolean") fail("Modern history plan/mode is malformed");
        return;
      case "sandbox/mode":
        requiredOptionalKeys(data, ["mode"], ["source"]);
        enumValue(
          data.mode,
          ["read-only", "workspace-write", "danger-full-access"],
          "sandbox/mode mode",
        );
        optionalDelegationSource(data.source, "sandbox/mode source");
        return;
      case "approval/policy":
        requiredOptionalKeys(data, ["policy"], ["source"]);
        enumValue(data.policy, ["ask", "never"], "approval/policy policy");
        optionalDelegationSource(data.source, "approval/policy source");
        return;
      case "command/run": {
        const commandId = validateCommandRun(data);
        if (trace.commandStates.has(commandId)) {
          fail("Modern history command/run repeats a commandId");
        }
        trace.commandStates.set(commandId, "running");
        trace.commandEventSeqs.add(event.seq);
        return;
      }
      case "command/done": {
        const command = validateCommandDone(data);
        if (trace.commandStates.get(command.commandId) !== "running") {
          fail("Modern history command/done has no unmatched command/run");
        }
        if (
          command.sourceEventSeq !== undefined &&
          (command.kind !== "success" ||
            command.sourceEventSeq >= event.seq ||
            trace.commandEventSeqs.has(command.sourceEventSeq))
        ) {
          fail("Modern history command/done has an invalid sourceEventSeq");
        }
        trace.commandStates.set(command.commandId, "done");
        trace.commandEventSeqs.add(event.seq);
        return;
      }
      case "hook/invoked":
        validateHookInvoked(data);
        return;
      case "hook/result":
        validateHookResult(data);
        return;
      case "llm/retry":
        validateRetry(data);
        return;
      case "llm/retry-started":
        validateRetryStarted(data);
        return;
      case "session/title":
        validateSessionTitle(data);
        return;
      case "session/title-llm-request":
        validateSessionTitleRequest(data);
        return;
      case "todo/write":
        validateTodoWrite(data);
        return;
      case "tool-workflow/run-start":
      case "tool-workflow/agent-start":
      case "tool-workflow/agent-end":
      case "tool-workflow/run-end":
        validateWorkflow(event.type, data);
        return;
      case "tool/code-dispatch-start":
      case "tool/code-dispatch":
        validateCodeDispatch(event.type, data);
        return;
      case "compaction/start":
      case "compaction/summary":
      case "compaction/end":
      case "compaction/prune":
        validateCompaction(event.type, data);
        return;
      case "feedback/record":
        exactKeys(data, ["text"]);
        requiredString(data.text, "feedback/record text");
        return;
      case "goal/change":
        validateGoalChange(data);
        return;
      case "schedule/change":
        validateScheduleChange(data);
        return;
      case "session-log-deepseek/delivery-accepted":
        exactKeys(data, ["sessionId", "throughSeq"]);
        requiredString(data.sessionId, "delivery-accepted sessionId");
        nonNegativeInteger(data.throughSeq, "delivery-accepted throughSeq");
        return;
      case "subagent/descriptor":
        validateSubagentDescriptor(data);
        return;
      case "subagent/model-selection-policy":
        validateSubagentModelPolicy(data);
        return;
      case "team/member":
      case "team/task":
      case "team/message/queued":
      case "team/message/delivered":
        validateTeamEvent(event.type, data);
        return;
      case "web/deepseek-search-llm-request":
        validateSearchRequest(data);
        return;
      default:
        fail("Modern history omitted validation for a known event");
    }
  }
}

function acceptSurfaceEvent(trace: ValidatorTrace, event: ModernJournalEvent): void {
  if (!SURFACE_EVENT_TYPES.has(event.type)) return;
  const sources = event.sourceEventSeqs;
  if (
    sources !== undefined &&
    (!Array.isArray(sources) ||
      sources.some(
        (seq) => !nonNegativeSafeInteger(seq) || Object.is(seq, -0) || seq >= event.seq,
      ) ||
      new Set(sources).size !== sources.length ||
      (sources.length === 0 && event.type !== "assistant/message"))
  ) {
    fail("Modern history surface event has invalid sourceEventSeqs");
  }

  const op = event.surfaceOp;
  if (op === "append") {
    trace.surface.push(event);
    return;
  }
  if (
    !isRecord(op) ||
    Reflect.ownKeys(op).length !== 3 ||
    !Object.hasOwn(op, "op") ||
    !Object.hasOwn(op, "start") ||
    !Object.hasOwn(op, "end") ||
    op.op !== "replace" ||
    !nonNegativeSafeInteger(op.start) ||
    Object.is(op.start, -0) ||
    !nonNegativeSafeInteger(op.end) ||
    Object.is(op.end, -0)
  ) {
    fail("Modern history surface event has an invalid replacement operation");
  }

  const startIndex = trace.surface.findIndex(({ seq }) => seq === op.start);
  const endIndex = trace.surface.findIndex(({ seq }) => seq === op.end);
  if (startIndex === -1 || endIndex === -1 || startIndex > endIndex) {
    fail("Modern history surface replacement has an invalid current range");
  }
  const shadowed = trace.surface.slice(startIndex, endIndex + 1);
  const sourceSet = new Set(sources ?? []);
  if (shadowed.some(({ seq }) => !sourceSet.has(seq))) {
    fail("Modern history surface replacement omitted a shadowed source event");
  }
  if (event.type === "tool/result") {
    if (
      shadowed.length !== 1 ||
      shadowed[0]?.type !== "tool/result" ||
      !isDeepStrictEqual(comparableToolResultData(shadowed[0]), comparableToolResultData(event))
    ) {
      fail("Modern history tool/result replacement changed more than result content");
    }
  }
  trace.surface.splice(startIndex, endIndex - startIndex + 1, event);
}

function comparableToolResultData(event: ModernJournalEvent): Record<string, unknown> {
  const data = event.data;
  if (
    !isRecord(data) ||
    !isRecord(data.message) ||
    !Array.isArray(data.message.content) ||
    !isRecord(data.message.content[0])
  ) {
    fail("Modern history tool/result replacement is malformed");
  }
  return {
    ...data,
    message: {
      ...data.message,
      content: [{ ...data.message.content[0], content: null }],
    },
  };
}

export interface ModernIncompleteTurn {
  readonly turn: number;
  readonly events: readonly ModernJournalEvent[];
}

export interface ModernHistoryProjection {
  readonly snapshot: HostThreadSnapshot;
  readonly nativeRef: NativeSessionRef;
  readonly lastSeq: number;
  readonly effectiveModel: HarnessModelRef | undefined;
  readonly effectiveThinkingOptionId: HarnessThinkingOptionId | undefined;
  readonly contextWindowTokens: number | undefined;
  readonly usage: HostUsage | null;
  readonly incompleteTurn: ModernIncompleteTurn | undefined;
}

export interface ModernForkBoundary {
  readonly atSeq: number;
  readonly events: readonly ModernJournalEvent[];
}

export function parseModernCheckpointSeq(checkpointId: string): number | null {
  const match = /^turn-end:(0|[1-9]\d*)$/u.exec(checkpointId);
  if (!match) return null;
  const seq = Number(match[1]);
  return Number.isSafeInteger(seq) ? seq : null;
}

/** Resolve the exact prefix selected by Modern `session/fork`. */
export function resolveModernForkBoundary(
  events: readonly ModernJournalEvent[],
  checkpointId: string,
): ModernForkBoundary | null {
  const atSeq = parseModernCheckpointSeq(checkpointId);
  if (atSeq === null || events[atSeq]?.seq !== atSeq || events[atSeq]?.type !== "turn/end") {
    return null;
  }
  let cut = atSeq + 1;
  while (cut < events.length && events[cut]?.type !== "turn/start") cut += 1;
  return { atSeq, events: events.slice(0, cut) };
}

/** Verify the inherited raw prefix and the child's one legal seed marker. */
export function matchesModernForkHistory(
  expectedPrefix: readonly ModernJournalEvent[],
  childEvents: readonly ModernJournalEvent[],
): boolean {
  if (!expectedPrefix.every((event, index) => isDeepStrictEqual(event, childEvents[index]))) {
    return false;
  }
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

interface HistoryTool {
  itemIndex: number;
  item: HostToolExecutionItem;
  toolName: string;
}

interface HistoryTurn {
  turn: number;
  startIndex: number;
  input: HostTextInput[];
  items: HostItemSnapshot[];
  tools: Map<string, HistoryTool>;
  model: HarnessModelRef | undefined;
}

export interface ProjectModernHistoryInput {
  readonly sessionId: string;
  readonly events: readonly ModernJournalEvent[];
  readonly harnessId?: HarnessId;
  readonly fallbackModel?: HarnessModelRef;
  readonly fallbackThinkingOptionId?: HarnessThinkingOptionId;
  readonly toolOutputLimit?: number;
  readonly maxEvents?: number;
}

/** Strictly validate and project one complete authoritative Modern journal prefix. */
export function projectModernHistory(input: ProjectModernHistoryInput): ModernHistoryProjection {
  if (!nonBlankString(input.sessionId)) throw new TypeError("sessionId must be a non-empty string");
  const harnessId = input.harnessId ?? DEEPSEEK_HARNESS_ID;
  const toolOutputLimit = boundedInteger(
    input.toolOutputLimit ?? MODERN_TOOL_OUTPUT_LIMIT,
    "toolOutputLimit",
    0,
  );
  const validator = new ModernEventValidator(input.maxEvents);
  const turns: HostTurnSnapshot[] = [];
  let active: HistoryTurn | null = null;
  let effectiveModel = input.fallbackModel;
  let effectiveThinkingOptionId = input.fallbackThinkingOptionId;
  let contextWindowTokens: number | undefined;
  let usage: HostUsage | null = null;
  const rawUsageByStep = new Map<string, unknown>();

  const rebuildUsage = (): void => {
    usage = null;
    for (const raw of rawUsageByStep.values()) {
      const parsed = parseDeepSeekUsage(raw, contextWindowTokens);
      if (parsed) usage = mergeDeepSeekUsage(usage, parsed);
    }
  };
  const recordUsage = (data: Record<string, unknown>, raw: unknown, fallback: string): void => {
    if (!validUsage(raw) || !parseDeepSeekUsage(raw, contextWindowTokens)) return;
    rawUsageByStep.set(deepSeekUsageKey(data, fallback), raw);
    rebuildUsage();
  };

  for (const [index, event] of input.events.entries()) {
    validator.accept(event);
    if (!KNOWN_EVENT_TYPES.has(event.type) || !isRecord(event.data)) continue;
    const data = event.data;
    switch (event.type) {
      case "turn/start":
        active = {
          turn: data.turn as number,
          startIndex: index,
          input: [],
          items: [],
          tools: new Map(),
          model: effectiveModel,
        };
        break;
      case "model/selection": {
        const selection = selectionFrom(data);
        effectiveModel = selection.model;
        effectiveThinkingOptionId = selection.thinking;
        if (active) active.model = selection.model;
        break;
      }
      case "request/header": {
        const selection = selectionFromHeader(data);
        effectiveModel = selection.model;
        effectiveThinkingOptionId = selection.thinking;
        if (active) active.model = selection.model;
        break;
      }
      case "request/context":
        contextWindowTokens = parseDeepSeekContextWindow(data.contextWindow);
        rebuildUsage();
        break;
      case "user/message":
        if (
          active &&
          event.surfaceOp === "append" &&
          isRecord(data.source) &&
          data.source.kind === "user"
        ) {
          active.input.push(...textInputs(data.content));
        }
        break;
      case "assistant/chunk":
        if (isRecord(data.chunk) && data.chunk.type === "usage") {
          recordUsage(data, data.chunk.usage, `event:${event.seq}`);
        }
        break;
      case "assistant/message":
        if (event.surfaceOp === "append" && data.usage !== undefined) {
          recordUsage(data, data.usage, `event:${event.seq}`);
        }
        if (active && event.surfaceOp === "append") {
          projectAssistantMessage(active, input.sessionId, data);
        }
        break;
      case "tool/call":
        if (active) projectToolCall(active, input.sessionId, data, event.seq);
        break;
      case "tool/result":
        if (active && event.surfaceOp === "append") {
          projectToolResultEvent(active, input.sessionId, data, event.seq, toolOutputLimit);
        }
        break;
      case "turn/end":
        if (active) {
          const terminal = safeTurnReason(data.reason);
          finishIncompleteTools(active, itemOutcome(terminal.outcome));
          turns.push({
            nativeTurnRef: modernNativeTurnRef(harnessId, input.sessionId, active.turn),
            checkpoint: modernCheckpointRef(harnessId, input.sessionId, event.seq),
            input: active.input,
            items: active.items,
            outcome: terminal.history,
            ...(active.model ? { model: active.model } : {}),
          });
          active = null;
        }
        break;
      default:
        break;
    }
  }

  const nativeRef = nativeSessionRefSchema.parse({
    harnessId,
    nativeSessionId: input.sessionId,
    formatVersion: 1,
  });
  const state: HarnessSessionState = {
    nativeRef,
    ...(effectiveModel ? { effectiveModel } : {}),
    ...(effectiveThinkingOptionId ? { effectiveThinkingOptionId } : {}),
  };
  return {
    snapshot: { turns, state },
    nativeRef,
    lastSeq: input.events.length - 1,
    effectiveModel,
    effectiveThinkingOptionId,
    contextWindowTokens,
    usage,
    incompleteTurn: active
      ? { turn: active.turn, events: input.events.slice(active.startIndex) }
      : undefined,
  };
}

export function modernNativeTurnRef(
  harnessId: HarnessId,
  sessionId: string,
  turn: number,
): NativeTurnRef {
  return nativeTurnRefSchema.parse({
    harnessId,
    nativeSessionId: sessionId,
    nativeTurnKey: `turn:${turn}`,
    formatVersion: 1,
  });
}

export function modernCheckpointRef(
  harnessId: HarnessId,
  sessionId: string,
  seq: number,
): NativeCheckpointRef {
  return nativeCheckpointRefSchema.parse({
    harnessId,
    nativeSessionId: sessionId,
    checkpointId: `turn-end:${seq}`,
    formatVersion: 1,
  });
}

export function modernItemId(sessionId: string, key: string): HostItemId {
  return hostItemIdSchema.parse(`dsh-modern:${sessionId}:${key}`);
}

function projectAssistantMessage(
  turn: HistoryTurn,
  sessionId: string,
  data: Record<string, unknown>,
): void {
  const message = data.message as Record<string, unknown>;
  const reasoning = contentByType(message.content, "reasoning");
  if (reasoning) {
    const item: HostReasoningItem = {
      type: "reasoning",
      itemId: modernItemId(sessionId, `turn:${turn.turn}:step:${String(data.step)}:reasoning`),
      text: reasoning,
    };
    turn.items.push({ item, outcome: { status: "succeeded" } });
  }
  const text = contentByType(message.content, "text");
  if (text) {
    const item: HostAgentMessageItem = {
      type: "agentMessage",
      itemId: modernItemId(sessionId, `turn:${turn.turn}:step:${String(data.step)}:assistant`),
      text,
    };
    turn.items.push({ item, outcome: { status: "succeeded" } });
  }
}

function projectToolCall(
  turn: HistoryTurn,
  sessionId: string,
  data: Record<string, unknown>,
  seq: number,
): void {
  if (turn.tools.has(data.callId as string)) {
    fail("Modern history reused an unfinished Tool callId");
  }
  const item: HostToolExecutionItem = {
    type: "toolExecution",
    itemId: modernItemId(sessionId, `event:${seq}:tool`),
    toolName: data.name as string,
    arguments: parseArguments(data.arguments),
  };
  const itemIndex = turn.items.length;
  turn.items.push({ item, outcome: incompleteToolOutcome(item.toolName) });
  turn.tools.set(data.callId as string, { itemIndex, item, toolName: item.toolName });
}

function projectToolResultEvent(
  turn: HistoryTurn,
  sessionId: string,
  data: Record<string, unknown>,
  seq: number,
  limit: number,
): void {
  const result = projectToolResult(data.message, limit);
  if (!result) fail("Modern history contains an unprojectable tool/result");
  const tool = turn.tools.get(result.callId);
  if (!tool) fail("Modern history contains an unmatched projected tool/result");
  turn.tools.delete(result.callId);
  const item = { ...tool.item, ...(result.output ? { output: result.output } : {}) };
  turn.items[tool.itemIndex] = {
    item,
    outcome:
      result.failed || data.error !== undefined
        ? {
            status: "failed",
            error: safeError({
              code: "nativeFailure",
              message: `DeepSeek Harness Tool '${tool.toolName}' failed`,
              retryable: false,
            }),
          }
        : { status: "succeeded" },
  };
  if (!result.failed && data.error === undefined) {
    const changes = structuredDiffs(data.meta);
    if (changes) {
      const fileItem: HostFileChangeItem = {
        type: "fileChange",
        itemId: modernItemId(sessionId, `event:${seq}:file-change`),
        changes,
      };
      turn.items.push({ item: fileItem, outcome: { status: "succeeded" } });
    }
  }
}

function finishIncompleteTools(turn: HistoryTurn, outcome: HostItemOutcome): void {
  for (const tool of turn.tools.values()) turn.items[tool.itemIndex] = { item: tool.item, outcome };
  turn.tools.clear();
}

function incompleteToolOutcome(toolName: string): HostItemOutcome {
  return {
    status: "failed",
    error: safeError({
      code: "nativeFailure",
      message: `DeepSeek Harness Tool '${toolName}' did not complete`,
      retryable: false,
    }),
  };
}

function selectionFrom(data: Record<string, unknown>): {
  model: HarnessModelRef;
  thinking: HarnessThinkingOptionId | undefined;
} {
  return {
    model: encodeDeepSeekHarnessModelRef({
      provider: data.provider as string,
      model: data.model as string,
    }),
    thinking: parseDeepSeekThinkingOptionId(data.reasoningEffort as string | undefined),
  };
}

function selectionFromHeader(data: Record<string, unknown>): {
  model: HarnessModelRef;
  thinking: HarnessThinkingOptionId | undefined;
} {
  const header = data.header as Record<string, unknown>;
  return selectionFrom(header.config as Record<string, unknown>);
}

function textInputs(value: unknown): HostTextInput[] {
  return Array.isArray(value)
    ? value.flatMap((block) =>
        isRecord(block) && block.type === "text" && typeof block.text === "string"
          ? [{ type: "text" as const, text: block.text }]
          : [],
      )
    : [];
}

function contentByType(value: unknown, type: "text" | "reasoning"): string {
  return Array.isArray(value)
    ? value
        .filter((block) => isRecord(block) && block.type === type && typeof block.text === "string")
        .map((block) => (block as { text: string }).text)
        .join("")
    : "";
}

function safeTurnReason(value: unknown): {
  outcome: TurnOutcome;
  history: HistoricalTurnOutcome;
} {
  const projected = projectTurnReason(value);
  return {
    outcome:
      projected.outcome.status === "failed"
        ? { ...projected.outcome, error: safeError(projected.outcome.error) }
        : projected.outcome,
    history:
      projected.history.status === "failed"
        ? { ...projected.history, error: safeError(projected.history.error) }
        : projected.history,
  };
}

function itemOutcome(outcome: TurnOutcome): HostItemOutcome {
  if (outcome.status === "succeeded") return { status: "succeeded" };
  if (outcome.status === "cancelled") {
    return { status: "cancelled", ...(outcome.reason ? { reason: outcome.reason } : {}) };
  }
  return { status: "failed", error: outcome.error };
}

function safeError(error: HarnessError): HarnessError {
  return {
    ...error,
    message: redactModernCredential(error.message),
    ...(error.diagnostic ? { diagnostic: redactModernCredential(error.diagnostic) } : {}),
    ...(error.stderrTail ? { stderrTail: redactModernCredential(error.stderrTail) } : {}),
  };
}

function requireOpenStep(
  trace: ValidatorTrace,
  data: Record<string, unknown>,
  label: string,
): void {
  const { turn, step } = stepPosition(data, label);
  if (trace.openTurn !== turn || trace.openStep !== step) {
    fail(`Modern history ${label} is outside its open step`);
  }
}

function stepPosition(
  data: Record<string, unknown>,
  label: string,
): { turn: number; step: number } {
  return {
    turn: positiveInteger(data.turn, `${label} turn`),
    step: positiveInteger(data.step, `${label} step`),
  };
}

function validateUserMessage(data: Record<string, unknown>): void {
  exactKeys(data, ["id", "role", "content", "source"]);
  requiredString(data.id, "user/message id");
  if (data.role !== "user") fail("Modern history user/message has an invalid role");
  validateContent(data.content);
  if (!isRecord(data.source) || !requiredString(data.source.kind, "user/message source kind")) {
    fail("Modern history user/message has an invalid source");
  }
  if (data.source.kind === "user" && data.source.rpcId !== undefined) {
    requiredString(data.source.rpcId, "user/message source rpcId");
  }
}

function validateAssistantMessage(value: unknown): void {
  if (!isRecord(value)) fail("Modern history assistant/message is malformed");
  exactKeys(value, ["id", "role", "content", "source"]);
  requiredString(value.id, "assistant/message id");
  if (value.role !== "assistant") fail("Modern history assistant/message has an invalid role");
  validateContent(value.content);
  if (
    !isRecord(value.source) ||
    value.source.kind !== "model" ||
    !nonBlankString(value.source.provider) ||
    !nonBlankString(value.source.model)
  ) {
    fail("Modern history assistant/message has an invalid source");
  }
}

function validateToolResultMessage(value: unknown): string {
  if (!isRecord(value)) fail("Modern history tool/result message is malformed");
  exactKeys(value, ["id", "role", "content", "source"]);
  requiredString(value.id, "tool/result message id");
  if (value.role !== "user" || !isRecord(value.source) || value.source.kind !== "tool") {
    fail("Modern history tool/result message has an invalid role or source");
  }
  const callId = requiredString(value.source.callId, "tool/result source callId");
  if (!Array.isArray(value.content) || value.content.length !== 1 || !isRecord(value.content[0])) {
    fail("Modern history tool/result message has invalid content");
  }
  const block = value.content[0];
  requiredOptionalKeys(block, ["type", "toolCallId", "content"], ["isError"]);
  if (
    block.type !== "tool-result" ||
    block.toolCallId !== callId ||
    !Array.isArray(block.content)
  ) {
    fail("Modern history tool/result block is malformed");
  }
  validateContent(block.content);
  if (block.isError !== undefined && typeof block.isError !== "boolean") {
    fail("Modern history tool/result block has invalid isError");
  }
  return callId;
}

function validateContent(value: unknown): void {
  if (!Array.isArray(value)) fail("Modern history message content must be an array");
  for (const block of value) {
    if (!isRecord(block) || typeof block.type !== "string") {
      fail("Modern history message contains a malformed content block");
    }
    switch (block.type) {
      case "text":
      case "reasoning":
        exactKeys(block, ["type", "text"]);
        if (typeof block.text !== "string") fail("Modern history text content is malformed");
        break;
      case "image":
        exactKeys(block, ["type", "attachment"]);
        if (!isRecord(block.attachment)) fail("Modern history image content is malformed");
        break;
      case "tool-call":
        exactKeys(block, ["type", "id", "name", "arguments"]);
        requiredString(block.id, "tool-call content id");
        requiredString(block.name, "tool-call content name");
        if (typeof block.arguments !== "string")
          fail("Modern history tool-call content is malformed");
        break;
      default:
        fail("Modern history contains an unknown required content block");
    }
  }
}

function validateChunk(value: unknown): void {
  if (!isRecord(value) || typeof value.type !== "string") {
    fail("Modern history assistant/chunk is malformed");
  }
  switch (value.type) {
    case "block-start":
      exactKeys(value, ["type", "index", "blockType"]);
      nonNegativeInteger(value.index, "block-start index");
      requiredString(value.blockType, "block-start blockType");
      return;
    case "text-delta":
    case "reasoning-delta":
      exactKeys(value, ["type", "index", "text"]);
      nonNegativeInteger(value.index, "delta index");
      if (typeof value.text !== "string") fail("Modern history text delta is malformed");
      return;
    case "tool-call-delta":
      requiredOptionalKeys(value, ["type", "index", "id", "argumentsDelta"], ["name"]);
      nonNegativeInteger(value.index, "tool-call-delta index");
      requiredString(value.id, "tool-call-delta id");
      if (value.name !== undefined) requiredString(value.name, "tool-call-delta name");
      if (typeof value.argumentsDelta !== "string") {
        fail("Modern history tool-call delta is malformed");
      }
      return;
    case "block-end":
      exactKeys(value, ["type", "index", "block"]);
      nonNegativeInteger(value.index, "block-end index");
      validateContent([value.block]);
      return;
    case "usage":
      exactKeys(value, ["type", "usage"]);
      return;
    case "finish":
      requiredOptionalKeys(value, ["type", "reason"], ["replayState"]);
      if (!isRecord(value.reason) || !requiredString(value.reason.kind, "finish reason kind")) {
        fail("Modern history finish chunk is malformed");
      }
      enumValue(
        value.reason.kind,
        ["stop", "tool-calls", "max-tokens", "aborted", "error"],
        "finish reason kind",
      );
      if (["aborted", "error"].includes(value.reason.kind as string)) {
        validateLlmFailure(value.reason.failure, "finish failure");
      }
      return;
    default:
      fail("Modern history contains an unknown required chunk type");
  }
}

function validateUsage(value: unknown): void {
  if (!validUsage(value)) fail("Modern history usage is malformed");
}

function validUsage(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const fields = [
    "inputTokens",
    "outputTokens",
    "totalTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "reasoningTokens",
  ] as const;
  if (
    Reflect.ownKeys(value).some((key) => typeof key !== "string" || !fields.includes(key as never))
  ) {
    return false;
  }
  if (!nonNegativeSafeInteger(value.inputTokens) || !nonNegativeSafeInteger(value.outputTokens)) {
    return false;
  }
  return fields
    .slice(2)
    .every((field) => value[field] === undefined || nonNegativeSafeInteger(value[field]));
}

function validateTurnReason(value: unknown): void {
  if (!isRecord(value) || typeof value.kind !== "string") {
    fail("Modern history turn/end reason is malformed");
  }
  switch (value.kind) {
    case "completed":
    case "max-tokens":
    case "blocked":
    case "interrupted":
      exactKeys(value, ["kind"]);
      return;
    case "aborted":
      exactKeys(value, ["kind", "reason"]);
      if (!isRecord(value.reason) || typeof value.reason.kind !== "string") {
        fail("Modern history aborted reason is malformed");
      }
      if (value.reason.kind === "hook") {
        exactKeys(value.reason, ["kind", "reason"]);
        requiredString(value.reason.reason, "aborted hook reason");
      } else {
        exactKeys(value.reason, ["kind"]);
        if (!["user", "parent", "disposed", "legacy"].includes(value.reason.kind)) {
          fail("Modern history contains an unknown abort cause");
        }
      }
      return;
    case "error":
      exactKeys(value, ["kind", "error"]);
      if (!isRecord(value.error)) fail("Modern history Turn error is malformed");
      requiredOptionalKeys(
        value.error,
        ["message", "code"],
        ["status", "providerRetryAfterMs", "requestId"],
      );
      if (typeof value.error.message !== "string" || typeof value.error.code !== "string") {
        fail("Modern history Turn error is malformed");
      }
      if (value.error.status !== undefined) {
        nonNegativeInteger(value.error.status, "Turn error status");
      }
      if (value.error.providerRetryAfterMs !== undefined) {
        nonNegativeInteger(value.error.providerRetryAfterMs, "Turn error providerRetryAfterMs");
      }
      if (value.error.requestId !== undefined) {
        requiredString(value.error.requestId, "Turn error requestId");
      }
      return;
    default:
      fail("Modern history contains an unknown required Turn outcome");
  }
}

function validateRequestHeader(data: Record<string, unknown>): void {
  requiredOptionalKeys(data, ["header", "reason"], ["startsSeries"]);
  if (
    !isRecord(data.header) ||
    !isRecord(data.header.config) ||
    !["initial", "resume", "change", "series"].includes(String(data.reason))
  ) {
    fail("Modern history request/header is malformed");
  }
  const config = data.header.config;
  if (!nonBlankString(config.provider) || !nonBlankString(config.model)) {
    fail("Modern history request/header has an invalid Model route");
  }
  if (config.reasoningEffort !== undefined && !nonBlankString(config.reasoningEffort)) {
    fail("Modern history request/header has invalid reasoningEffort");
  }
  if (data.startsSeries !== undefined && data.startsSeries !== true) {
    fail("Modern history request/header has invalid startsSeries");
  }
}

function validateRequestContext(data: Record<string, unknown>): void {
  requiredOptionalKeys(data, ["provider", "model"], ["contextWindow"]);
  if (!nonBlankString(data.provider) || !nonBlankString(data.model)) {
    fail("Modern history request/context has an invalid Model route");
  }
  if (data.contextWindow !== undefined) positiveInteger(data.contextWindow, "contextWindow");
}

function validateModelSelection(data: Record<string, unknown>): void {
  requiredOptionalKeys(data, ["provider", "model"], ["reasoningEffort"]);
  if (!nonBlankString(data.provider) || !nonBlankString(data.model)) {
    fail("Modern history model/selection has an invalid route");
  }
  if (data.reasoningEffort !== undefined && !nonBlankString(data.reasoningEffort)) {
    fail("Modern history model/selection has invalid reasoningEffort");
  }
}

function validateToolError(value: unknown): void {
  if (!isRecord(value)) fail("Modern history tool/result error is malformed");
  exactKeys(value, ["name", "code"]);
  requiredString(value.name, "tool/result error name");
  requiredString(value.code, "tool/result error code");
}

function validateInboxSplice(data: Record<string, unknown>): void {
  requiredOptionalKeys(data, ["target", "start", "inserted"], ["removedCount", "outcome"]);
  enumValue(data.target, ["next-turn", "next-step"], "agent/inbox target");
  nonNegativeInteger(data.start, "agent/inbox start");
  if (data.removedCount !== undefined) {
    nonNegativeInteger(data.removedCount, "agent/inbox removedCount");
  }
  if (!Array.isArray(data.inserted)) fail("Modern history agent/inbox inserted is malformed");
  for (const message of data.inserted) {
    if (!isRecord(message)) fail("Modern history agent/inbox message is malformed");
    validateUserMessage(message);
  }
  if (data.outcome !== undefined && data.outcome !== "canceled") {
    fail("Modern history agent/inbox outcome is malformed");
  }
}

function validateApprovalAsked(data: Record<string, unknown>): void {
  requiredOptionalKeys(data, ["id", "toolName"], ["callId", "reason"]);
  requiredString(data.id, "approval/asked id");
  requiredString(data.toolName, "approval/asked toolName");
  if (data.callId !== undefined) requiredString(data.callId, "approval/asked callId");
  if (data.reason !== undefined && typeof data.reason !== "string") {
    fail("Modern history approval/asked reason is malformed");
  }
}

function validateApprovalDecided(data: Record<string, unknown>): void {
  exactKeys(data, ["id", "outcome"]);
  requiredString(data.id, "approval/decided id");
  enumValue(
    data.outcome,
    ["allowed-once", "rejected", "cancelled", "unavailable"],
    "approval/decided outcome",
  );
}

function validateCommandRun(data: Record<string, unknown>): string {
  requiredOptionalKeys(data, ["commandId", "name", "source"], ["args"]);
  const commandId = requiredString(data.commandId, "command/run commandId");
  requiredString(data.name, "command/run name");
  if (data.args !== undefined && typeof data.args !== "string") {
    fail("Modern history command/run args is malformed");
  }
  if (!isRecord(data.source)) {
    fail("Modern history command/run source is malformed");
  }
  exactKeys(data.source, ["kind"]);
  if (data.source.kind !== "user") {
    fail("Modern history command/run source is malformed");
  }
  return commandId;
}

function validateCommandDone(data: Record<string, unknown>): {
  readonly commandId: string;
  readonly kind: "success" | "error";
  readonly sourceEventSeq: number | undefined;
} {
  requiredOptionalKeys(data, ["commandId", "kind"], ["text", "sourceEventSeq"]);
  const commandId = requiredString(data.commandId, "command/done commandId");
  const kind = enumValue(data.kind, ["success", "error"], "command/done kind");
  if (
    (data.text !== undefined && typeof data.text !== "string") ||
    (kind === "error" && (typeof data.text !== "string" || data.text.trim().length === 0))
  ) {
    fail("Modern history command/done text is malformed");
  }
  let sourceEventSeq: number | undefined;
  if (data.sourceEventSeq !== undefined) {
    sourceEventSeq = nonNegativeInteger(data.sourceEventSeq, "command/done sourceEventSeq");
  }
  return { commandId, kind, sourceEventSeq };
}

function validateHookInvoked(data: Record<string, unknown>): void {
  requiredOptionalKeys(data, ["turn", "point", "dialect", "handlerId"], ["matcher"]);
  positiveInteger(data.turn, "hook/invoked turn");
  requiredString(data.point, "hook/invoked point");
  enumValue(data.dialect, ["claude-code", "codex"], "hook/invoked dialect");
  requiredString(data.handlerId, "hook/invoked handlerId");
  if (data.matcher !== undefined && typeof data.matcher !== "string") {
    fail("Modern history hook/invoked matcher is malformed");
  }
}

function validateHookResult(data: Record<string, unknown>): void {
  requiredOptionalKeys(
    data,
    ["turn", "point", "handlerId", "decision", "durationMs"],
    ["exitCode", "stderrSummary"],
  );
  positiveInteger(data.turn, "hook/result turn");
  requiredString(data.point, "hook/result point");
  requiredString(data.handlerId, "hook/result handlerId");
  requiredString(data.decision, "hook/result decision");
  nonNegativeInteger(data.durationMs, "hook/result durationMs");
  if (data.exitCode !== undefined && !Number.isSafeInteger(data.exitCode)) {
    fail("Modern history hook/result exitCode is malformed");
  }
  if (data.stderrSummary !== undefined && typeof data.stderrSummary !== "string") {
    fail("Modern history hook/result stderrSummary is malformed");
  }
}

function validateRetry(data: Record<string, unknown>): void {
  const mode = enumValue(data.mode, ["normal", "always"], "llm/retry mode");
  requiredOptionalKeys(
    data,
    [
      "retryId",
      "turn",
      "step",
      "provider",
      "mode",
      "policyKey",
      "retry",
      ...(mode === "normal" ? ["maxRetries"] : []),
      "delayMs",
      "failure",
    ],
    [],
  );
  requiredString(data.retryId, "llm/retry retryId");
  positiveInteger(data.turn, "llm/retry turn");
  positiveInteger(data.step, "llm/retry step");
  requiredString(data.provider, "llm/retry provider");
  requiredString(data.policyKey, "llm/retry policyKey");
  positiveInteger(data.retry, "llm/retry retry");
  nonNegativeInteger(data.delayMs, "llm/retry delayMs");
  if (mode === "normal") positiveInteger(data.maxRetries, "llm/retry maxRetries");
  validateLlmFailure(data.failure, "llm/retry failure");
}

function validateRetryStarted(data: Record<string, unknown>): void {
  exactKeys(data, ["retryId", "turn", "step", "retry"]);
  requiredString(data.retryId, "llm/retry-started retryId");
  positiveInteger(data.turn, "llm/retry-started turn");
  positiveInteger(data.step, "llm/retry-started step");
  positiveInteger(data.retry, "llm/retry-started retry");
}

function validateLlmFailure(value: unknown, label: string): void {
  if (!isRecord(value)) fail(`Modern history ${label} is malformed`);
  requiredOptionalKeys(value, ["message", "code"], ["status", "providerRetryAfterMs", "requestId"]);
  if (typeof value.message !== "string" || typeof value.code !== "string") {
    fail(`Modern history ${label} is malformed`);
  }
  if (value.status !== undefined) nonNegativeInteger(value.status, `${label} status`);
  if (value.providerRetryAfterMs !== undefined) {
    nonNegativeInteger(value.providerRetryAfterMs, `${label} providerRetryAfterMs`);
  }
  if (value.requestId !== undefined) requiredString(value.requestId, `${label} requestId`);
}

function validateSessionTitle(data: Record<string, unknown>): void {
  exactKeys(data, ["title", "messageSeqs", "source"]);
  requiredString(data.title, "session/title title");
  validateSeqArray(data.messageSeqs, "session/title messageSeqs");
  if (
    !isRecord(data.source) ||
    !["fallback", "provider", "user"].includes(String(data.source.kind))
  ) {
    fail("Modern history session/title source is malformed");
  }
  if (data.source.kind === "provider") {
    requiredString(data.source.provider, "session/title source provider");
    if (data.source.model !== undefined)
      validateModelRoute(data.source.model, "session/title model");
  }
}

function validateSessionTitleRequest(data: Record<string, unknown>): void {
  exactKeys(data, ["titleProvider", "messageSeqs", "route", "system", "messages", "maxTokens"]);
  requiredString(data.titleProvider, "session/title request provider");
  validateSeqArray(data.messageSeqs, "session/title request messageSeqs");
  validateModelRoute(data.route, "session/title request route");
  if (typeof data.system !== "string")
    fail("Modern history session/title request system is malformed");
  if (!Array.isArray(data.messages))
    fail("Modern history session/title request messages is malformed");
  for (const message of data.messages) {
    if (!isRecord(message) || typeof message.role !== "string" || !Array.isArray(message.content)) {
      fail("Modern history session/title request message is malformed");
    }
  }
  positiveInteger(data.maxTokens, "session/title request maxTokens");
}

function validateTodoWrite(data: Record<string, unknown>): void {
  exactKeys(data, ["todos"]);
  if (!Array.isArray(data.todos)) fail("Modern history todo/write todos is malformed");
  for (const todo of data.todos) {
    if (!isRecord(todo)) fail("Modern history todo/write item is malformed");
    exactKeys(todo, ["content", "status"]);
    requiredString(todo.content, "todo/write content");
    enumValue(todo.status, ["pending", "in_progress", "completed"], "todo/write status");
  }
}

function validateWorkflow(type: string, data: Record<string, unknown>): void {
  if (type === "tool-workflow/run-start") {
    exactKeys(data, ["runId", "name"]);
    requiredString(data.runId, "workflow runId");
    requiredString(data.name, "workflow name");
    return;
  }
  if (type === "tool-workflow/agent-start") {
    requiredOptionalKeys(data, ["runId", "seq", "label", "childId"], ["phase"]);
    requiredString(data.runId, "workflow runId");
    positiveInteger(data.seq, "workflow agent seq");
    if (typeof data.label !== "string") fail("Modern history workflow agent label is invalid");
    requiredString(data.childId, "workflow childId");
    if (data.phase !== undefined && typeof data.phase !== "string") {
      fail("Modern history workflow phase is invalid");
    }
    return;
  }
  if (type === "tool-workflow/agent-end") {
    exactKeys(data, ["runId", "seq", "outcome"]);
    requiredString(data.runId, "workflow runId");
    positiveInteger(data.seq, "workflow agent seq");
    enumValue(data.outcome, ["completed", "failed", "cancelled"], "workflow agent outcome");
    return;
  }
  exactKeys(data, ["runId", "stopReason"]);
  requiredString(data.runId, "workflow runId");
  enumValue(data.stopReason, ["completed", "cancelled", "error"], "workflow stopReason");
}

function validateCodeDispatch(type: string, data: Record<string, unknown>): void {
  const required = ["rootCallId", "parentCallId", "subCallId", "name", "arguments"];
  if (type === "tool/code-dispatch") required.push("isError", "content");
  exactKeys(data, required);
  for (const key of ["rootCallId", "parentCallId", "subCallId", "name"]) {
    requiredString(data[key], `tool/code-dispatch ${key}`);
  }
  if (type === "tool/code-dispatch") {
    if (typeof data.isError !== "boolean" || !Array.isArray(data.content)) {
      fail("Modern history tool/code-dispatch result is malformed");
    }
    validateContent(data.content);
  }
}

function validateCompaction(type: string, data: Record<string, unknown>): void {
  if (type === "compaction/start" || type === "compaction/end") {
    requiredOptionalKeys(
      data,
      ["compactionId", "turn"],
      type === "compaction/start" ? ["sourceCommandId"] : ["sourceCommandId", "error"],
    );
    requiredString(data.compactionId, "compaction id");
    if (data.turn !== null) positiveInteger(data.turn, "compaction turn");
    if (data.sourceCommandId !== undefined)
      requiredString(data.sourceCommandId, "compaction commandId");
    if (data.error !== undefined && typeof data.error !== "string") {
      fail("Modern history compaction error is malformed");
    }
    return;
  }
  if (type === "compaction/prune") {
    exactKeys(data, ["shadowedRange", "shadowedSeqs", "shadowedTokenCount"]);
    validateShadow(data);
    return;
  }
  requiredOptionalKeys(
    data,
    [
      "compactionId",
      "summary",
      "shadowedRange",
      "shadowedSeqs",
      "shadowedTokenCount",
      "provider",
      "model",
    ],
    ["sourceCommandId", "maxTokens", "usage", "rawOutput", "llmStreamCall"],
  );
  requiredString(data.compactionId, "compaction summary id");
  requiredString(data.provider, "compaction summary provider");
  requiredString(data.model, "compaction summary model");
  if (!Array.isArray(data.summary)) fail("Modern history compaction summary is malformed");
  validateShadow(data);
  if (data.maxTokens !== undefined) positiveInteger(data.maxTokens, "compaction maxTokens");
  if (data.usage !== undefined) validateUsage(data.usage);
  if (data.rawOutput !== undefined && !Array.isArray(data.rawOutput)) {
    fail("Modern history compaction rawOutput is malformed");
  }
  if (data.llmStreamCall !== undefined && data.llmStreamCall !== true) {
    fail("Modern history compaction llmStreamCall is malformed");
  }
}

function validateShadow(data: Record<string, unknown>): void {
  if (!isRecord(data.shadowedRange)) fail("Modern history compaction shadowedRange is malformed");
  exactKeys(data.shadowedRange, ["start", "end"]);
  nonNegativeInteger(data.shadowedRange.start, "compaction shadow start");
  nonNegativeInteger(data.shadowedRange.end, "compaction shadow end");
  validateSeqArray(data.shadowedSeqs, "compaction shadowedSeqs");
  nonNegativeInteger(data.shadowedTokenCount, "compaction shadowedTokenCount");
}

function validateGoalChange(data: Record<string, unknown>): void {
  if (data.kind !== "goal/change" || data.version !== 1) {
    fail("Modern history goal/change tag is malformed");
  }
  const operation = enumValue(
    data.operation,
    ["create", "edit", "pause", "resume", "complete", "block", "clear"],
    "goal/change operation",
  );
  if (operation === "clear") {
    exactKeys(data, ["kind", "version", "operation", "cleared", "clearedAt"]);
    if (!isRecord(data.cleared)) fail("Modern history goal/change tombstone is malformed");
    nonNegativeInteger(data.clearedAt, "goal/change clearedAt");
    return;
  }
  exactKeys(data, [
    "kind",
    "version",
    "operation",
    "goal",
    "roundsStarted",
    "createdAt",
    "updatedAt",
  ]);
  if (!isRecord(data.goal)) fail("Modern history goal/change goal is malformed");
  nonNegativeInteger(data.roundsStarted, "goal/change roundsStarted");
  nonNegativeInteger(data.createdAt, "goal/change createdAt");
  nonNegativeInteger(data.updatedAt, "goal/change updatedAt");
}

function validateScheduleChange(data: Record<string, unknown>): void {
  if (data.version !== 1) fail("Modern history schedule/change version is malformed");
  const operation = enumValue(
    data.operation,
    ["create", "delete", "dispatch"],
    "schedule operation",
  );
  if (operation === "create") {
    exactKeys(data, ["version", "operation", "schedule"]);
    if (!isRecord(data.schedule) || !nonBlankString(data.schedule.id)) {
      fail("Modern history schedule/create is malformed");
    }
    return;
  }
  requiredOptionalKeys(
    data,
    ["version", "operation", "id"],
    operation === "dispatch" ? ["acceptedAt"] : [],
  );
  requiredString(data.id, "schedule id");
  if (data.acceptedAt !== undefined) requiredString(data.acceptedAt, "schedule acceptedAt");
}

function validateSubagentDescriptor(data: Record<string, unknown>): void {
  if (data.version !== 3) fail("Modern history subagent descriptor version is malformed");
  const mode = enumValue(data.mode, ["one-shot", "continuable"], "subagent descriptor mode");
  requiredString(data.provider, "subagent descriptor provider");
  if (mode === "continuable") requiredString(data.label, "subagent descriptor label");
  else if (data.label !== undefined && typeof data.label !== "string") {
    fail("Modern history subagent descriptor label is malformed");
  }
}

function validateSubagentModelPolicy(data: Record<string, unknown>): void {
  exactKeys(data, ["allowedModels"]);
  if (!Array.isArray(data.allowedModels) || data.allowedModels.length === 0) {
    fail("Modern history subagent Model policy is malformed");
  }
  for (const route of data.allowedModels) validateModelRoute(route, "subagent Model policy route");
}

function validateTeamEvent(type: string, data: Record<string, unknown>): void {
  if (data.version !== 1) fail("Modern history team event version is malformed");
  requiredString(data.teamId, "team event teamId");
  if (type === "team/message/delivered") {
    exactKeys(data, ["version", "teamId", "messageId", "targetId"]);
    requiredString(data.messageId, "team messageId");
    requiredString(data.targetId, "team targetId");
    return;
  }
  const key = type === "team/member" ? "member" : type === "team/task" ? "task" : "message";
  exactKeys(data, ["version", "teamId", key]);
  if (!isRecord(data[key])) fail("Modern history team payload is malformed");
}

function validateSearchRequest(data: Record<string, unknown>): void {
  exactKeys(data, ["endpoint", "apiVersion", "body"]);
  requiredString(data.endpoint, "search request endpoint");
  requiredString(data.apiVersion, "search request apiVersion");
  if (!isRecord(data.body)) fail("Modern history search request body is malformed");
  requiredOptionalKeys(data.body, ["model", "max_tokens", "messages", "tools"], []);
  requiredString(data.body.model, "search request model");
  positiveInteger(data.body.max_tokens, "search request max_tokens");
  if (!Array.isArray(data.body.messages) || !Array.isArray(data.body.tools)) {
    fail("Modern history search request arrays are malformed");
  }
}

function validateModelRoute(value: unknown, label: string): void {
  if (!isRecord(value)) fail(`Modern history ${label} is malformed`);
  if (!nonBlankString(value.provider) || !nonBlankString(value.model)) {
    fail(`Modern history ${label} is malformed`);
  }
}

function validateSeqArray(value: unknown, label: string): void {
  if (!Array.isArray(value) || value.some((seq) => !Number.isSafeInteger(seq) || seq < 0)) {
    fail(`Modern history ${label} is malformed`);
  }
}

function optionalDelegationSource(value: unknown, label: string): void {
  if (value !== undefined && value !== "delegation") fail(`Modern history ${label} is malformed`);
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    fail(`Modern history ${label} is invalid`);
  }
  return value as T;
}

function exactKeys(value: Record<string, unknown>, required: readonly string[]): void {
  requiredOptionalKeys(value, required, []);
}

function requiredOptionalKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string" || !allowed.has(key))
  ) {
    fail("Modern history known event has an incompatible schema");
  }
}

function requiredString(value: unknown, label: string): string {
  if (!nonBlankString(value)) fail(`Modern history ${label} is invalid`);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  return boundedInteger(value, label, 1);
}

function nonNegativeInteger(value: unknown, label: string): number {
  return boundedInteger(value, label, 0);
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function boundedInteger(value: unknown, label: string, minimum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${label} must be a safe integer greater than or equal to ${minimum}`);
  }
  return value;
}

function fail(message: string, code: ModernHistoryErrorCode = "protocolError"): never {
  throw new ModernHistoryError(code, message);
}
