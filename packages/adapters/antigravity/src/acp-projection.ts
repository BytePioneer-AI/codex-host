import { createHash } from "node:crypto";

import type {
  AvailableCommand,
  CreateElicitationRequest,
  CreateElicitationResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import {
  mergeLiveHarnessCommands,
  subagentConfiguration,
  type HostApprovalAction,
  type HostApprovalInteraction,
  type HostEvent,
  type HostFileChange,
  type HostItem,
  type HostItemOutcome,
  type HostItemSnapshot,
  type HostQuestion,
  type HostQuestionInteraction,
  type HostQuestionResponse,
  type HostTurnSnapshot,
  type SubagentConfiguration,
} from "@codexhost/harness-adapter";
import {
  hostItemIdSchema,
  hostTurnIdSchema,
  nativeCheckpointRefSchema,
  nativeTurnRefSchema,
  type HarnessCommandCatalog,
  type HostInteractionId,
  type HostItemId,
  type HostTurnId,
  type JsonValue,
} from "@codexhost/shared-contracts";
import { createTwoFilesPatch } from "diff";

import type { AntigravityAcpConfigOption, AntigravityAcpEvent } from "./acp-types.js";
import type { NativeCompactionEvent, NativeReplayEvent } from "./native-replay.js";
import { ANTIGRAVITY_COMMAND_CATALOG } from "./slash-commands.js";
import {
  compactToolName,
  displayPath,
  isAntigravityFileMutatingTool,
  synthesizeAntigravityCommand,
} from "./tool-projection.js";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function bodyText(content: unknown): string {
  return (Array.isArray(content) ? content : [])
    .map((part) => {
      const block = record(part);
      return text((block.type === "content" ? record(block.content) : block).text);
    })
    .filter(Boolean)
    .join("\n");
}

export interface AntigravityElicitationQuestionMapping {
  questionId: string;
  selectKey: string;
  otherKey?: string;
  multiSelect: boolean;
  optionValueToConst: ReadonlyMap<string, string>;
}
export interface AntigravityElicitationFieldMap {
  questions: readonly AntigravityElicitationQuestionMapping[];
}

export function projectAcpSessionUpdate(
  rawUpdate: Record<string, unknown>,
): AntigravityAcpEvent | null {
  switch (rawUpdate.sessionUpdate) {
    case "user_message_chunk":
    case "agent_message_chunk":
    case "agent_thought_chunk": {
      const content = record(rawUpdate.content);
      if (content.type !== "text") return null;
      const type =
        rawUpdate.sessionUpdate === "user_message_chunk"
          ? "user.text"
          : rawUpdate.sessionUpdate === "agent_message_chunk"
            ? "agent.text"
            : "agent.thought";
      return { type, text: text(content.text) };
    }
    case "tool_call":
    case "tool_call_update": {
      const tool = { ...rawUpdate };
      delete tool.sessionUpdate;
      return {
        ...tool,
        type: rawUpdate.sessionUpdate === "tool_call" ? "tool.call" : "tool.update",
        toolCallId: text(rawUpdate.toolCallId),
        ...(rawUpdate.sessionUpdate === "tool_call"
          ? { name: text(rawUpdate.name) || text(rawUpdate.title) || "Tool" }
          : {}),
        ...(rawUpdate.args !== undefined || rawUpdate.rawInput !== undefined
          ? { args: rawUpdate.args ?? rawUpdate.rawInput }
          : {}),
      } as Extract<AntigravityAcpEvent, { type: "tool.call" | "tool.update" }>;
    }
    case "usage_update":
      return {
        type: "usage.context",
        used: rawUpdate.used as number,
        size: rawUpdate.size as number,
      };
    case "config_option_update":
      return {
        type: "config.update",
        configOptions: rawUpdate.configOptions as AntigravityAcpConfigOption[],
      };
    case "current_mode_update":
      return { type: "mode.update", currentModeId: text(rawUpdate.currentModeId) };
    case "available_commands_update":
      return {
        type: "commands.update",
        commands: rawUpdate.availableCommands as AvailableCommand[],
      };
    case "session_info_update":
      return {
        type: "session.info",
        ...(typeof rawUpdate.title === "string" ? { title: rawUpdate.title } : {}),
      };
    default:
      return null;
  }
}

export function projectAcpApprovalInteraction(params: {
  interactionId: HostInteractionId;
  sessionId: string;
  turnId: HostTurnId;
  cwd: string;
  request: RequestPermissionRequest;
}): { interaction: HostApprovalInteraction; actionToOptionId: ReadonlyMap<string, string> } {
  const { toolCall, options } = params.request;
  const name = toolCall.name ?? toolCall.title ?? "Tool";
  const effects: Record<string, HostApprovalAction["effect"]> = {
    allow_once: "allowOnce",
    allow_always: "allowAlways",
    allow_session: "allowForSession",
    reject_once: "deny",
    reject_always: "deny",
  };
  const actionToOptionId = new Map<string, string>();
  const actions = options.flatMap((option) => {
    const effect = effects[option.kind];
    if (!effect) return [];
    actionToOptionId.set(option.optionId, option.optionId);
    return [{ id: option.optionId, label: option.name, effect }];
  });
  const input = record(toolCall).args ?? toolCall.rawInput;
  const command = synthesizeAntigravityCommand(
    toolCall.kind === "execute" ? "run_command" : name,
    input,
    params.cwd,
  );
  const category =
    toolCall.kind === "execute" || command
      ? "Command execution"
      : toolCall.kind === "edit" ||
          toolCall.kind === "delete" ||
          isAntigravityFileMutatingTool(name)
        ? "File modification"
        : "Tool execution";
  const description =
    command?.command ??
    (bodyText(toolCall.content) || (input === undefined ? "" : JSON.stringify(input)));
  return {
    interaction: {
      type: "approval",
      interactionId: params.interactionId,
      turnId: params.turnId,
      title: `${category}: ${toolCall.title || name}`,
      ...(description ? { description: description.slice(0, 16_000) } : {}),
      subject: { type: "nativeAction" },
      actions,
    },
    actionToOptionId,
  };
}

export function buildAcpPermissionResponse(params: {
  actionId: string;
  actionToOptionId: ReadonlyMap<string, string>;
}): RequestPermissionResponse {
  const optionId = params.actionToOptionId.get(params.actionId);
  return optionId
    ? { outcome: { outcome: "selected", optionId } }
    : { outcome: { outcome: "cancelled" } };
}

export function projectAcpQuestionInteraction(params: {
  interactionId: HostInteractionId;
  sessionId: string;
  turnId: HostTurnId;
  itemId?: HostItemId;
  request: CreateElicitationRequest;
  rawQuestions?: unknown;
}): { interaction: HostQuestionInteraction; fieldMap: AntigravityElicitationFieldMap } {
  const request = record(params.request);
  if (request.mode !== "form") throw new Error("Antigravity elicitation requires form mode");
  const schema = record(request.requestedSchema);
  const properties = record(schema.properties);
  const required = Array.isArray(schema.required)
    ? new Set(schema.required as string[])
    : undefined;
  const rawQuestions = Array.isArray(params.rawQuestions) ? params.rawQuestions : [];
  const mappings: AntigravityElicitationQuestionMapping[] = [];
  const questions: HostQuestion[] = [];
  for (const [key, value] of Object.entries(properties)) {
    if (key.endsWith("_other") && properties[key.slice(0, -6)]) continue;
    const prop = record(value);
    const raw = record(rawQuestions[questions.length]);
    const multiple = prop.type === "array";
    const choices = multiple ? record(prop.items) : prop;
    const variants = choices.oneOf ?? choices.anyOf ?? choices.enum;
    const rawOptions = Array.isArray(raw.options) ? raw.options : [];
    const optionValueToConst = new Map<string, string>();
    const options = (Array.isArray(variants) ? variants : []).map((variant, index) => {
      const entry = record(variant);
      const native = typeof variant === "string" ? variant : text(entry.const);
      const detail = record(rawOptions[index]);
      optionValueToConst.set(native, native);
      const description = text(entry.description) || text(detail.description);
      return {
        value: native,
        label: text(entry.title) || text(detail.label) || native,
        ...(description ? { description } : {}),
      };
    });
    const prompt =
      text(prop.title) ||
      text(raw.question) ||
      text(prop.description) ||
      text(request.message) ||
      key;
    const otherKey = properties[`${key}_other`] ? `${key}_other` : undefined;
    const optional = required ? !required.has(key) : true;
    mappings.push({
      questionId: key,
      selectKey: key,
      ...(otherKey ? { otherKey } : {}),
      multiSelect: multiple,
      optionValueToConst,
    });
    questions.push(
      options.length
        ? {
            id: key,
            type: "choice",
            prompt,
            options,
            multiple,
            allowOther: !!otherKey,
            optional,
          }
        : {
            id: key,
            type: "text",
            prompt,
            multiline: false,
            secret: prop.format === "password",
            optional,
          },
    );
  }
  return {
    interaction: {
      type: "question",
      interactionId: params.interactionId,
      turnId: params.turnId,
      ...(params.itemId ? { itemId: params.itemId } : {}),
      title: text(schema.title) || text(request.message) || "Question",
      questions,
    },
    fieldMap: { questions: mappings },
  };
}

export function buildAcpElicitationResponse(params: {
  response: HostQuestionResponse;
  fieldMap: AntigravityElicitationFieldMap;
}): CreateElicitationResponse {
  if (params.response.cancelled) return { action: "cancel" };
  const content: Record<string, unknown> = {};
  for (const field of params.fieldMap.questions) {
    const answers = params.response.answers[field.questionId] ?? [];
    const values = answers.flatMap((answer) => {
      const native = field.optionValueToConst.get(answer);
      return native === undefined ? [] : [native];
    });
    if (field.optionValueToConst.size === 0) content[field.selectKey] = answers[0] ?? "";
    else if (field.multiSelect) content[field.selectKey] = values;
    else if (values[0] !== undefined) content[field.selectKey] = values[0];
    if (field.otherKey)
      content[field.otherKey] = answers
        .filter((answer) => !field.optionValueToConst.has(answer))
        .join("\n");
  }
  return { action: "accept", content };
}

export interface AntigravityToolTrackerOptions {
  turnId: HostTurnId;
  cwd: string;
  outputLimit?: number;
  parentConfiguration?: SubagentConfiguration;
  emit: (event: HostEvent) => void;
  onSubagentSpawned?: (subagentId: string, item: HostItemSnapshot) => void;
}
type ToolEvent = Extract<AntigravityAcpEvent, { type: "tool.call" | "tool.update" }>;
interface ToolState {
  event: ToolEvent;
  item: HostItem | null;
  snapshot?: HostItemSnapshot;
  diffItem?: Extract<HostItem, { type: "fileChange" }>;
  diffSnapshot?: HostItemSnapshot;
}
const uuidPattern = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/iu;
const succeeded: HostItemOutcome = { status: "succeeded" };

export class AntigravityToolTracker {
  #tools = new Map<string, ToolState>();
  #spawned = new Set<string>();
  constructor(private readonly options: AntigravityToolTrackerOptions) {}

  rawToolInput(toolCallId: string): unknown {
    const event = this.#tools.get(toolCallId)?.event;
    return event?.args ?? event?.rawInput;
  }

  activeToolItemId(toolCallId: string): HostItemId | undefined {
    const state = this.#tools.get(toolCallId);
    return state && !state.snapshot && state.item?.type === "toolExecution"
      ? state.item.itemId
      : undefined;
  }

  handleToolEvent(event: ToolEvent): void {
    let state = this.#tools.get(event.toolCallId);
    if (state?.snapshot) return;
    const previous = state?.item;
    if (!state) {
      state = { event, item: null };
      this.#tools.set(event.toolCallId, state);
    } else
      state.event = {
        ...state.event,
        ...Object.fromEntries(Object.entries(event).filter(([, value]) => value !== undefined)),
        ...(event.args !== undefined || event.rawInput !== undefined
          ? { args: event.args ?? event.rawInput }
          : {}),
      } as ToolEvent;
    const tool = state.event;
    const name = tool.name ?? tool.title ?? "Tool";
    const itemId = hostItemIdSchema.parse(
      `tool-${this.options.turnId}-${createHash("sha256").update(event.toolCallId).digest("hex").slice(0, 20)}`,
    );
    const args = tool.args ?? tool.rawInput;
    const input = record(args);
    const fullOutput =
      tool.rawOutput === undefined
        ? bodyText(tool.content)
        : typeof tool.rawOutput === "string"
          ? tool.rawOutput
          : JSON.stringify(tool.rawOutput);
    const limit = this.options.outputLimit ?? 64_000;
    const output = fullOutput.slice(0, limit);
    const terminal = tool.status === "completed" || tool.status === "failed";
    const failed = tool.status === "failed";
    const outcome: HostItemOutcome = failed
      ? {
          status: "failed",
          error: { code: "nativeFailure", message: output || `${name} failed`, retryable: false },
        }
      : succeeded;
    const command = synthesizeAntigravityCommand(
      tool.kind === "execute" ? "run_command" : name,
      args,
      this.options.cwd,
    );
    if (command || tool.kind === "execute" || compactToolName(name) === "runcommand") {
      state.item = {
        type: "commandExecution",
        itemId,
        command: command?.command ?? tool.title ?? name,
        cwd: command?.cwd ?? this.options.cwd,
        ...(fullOutput
          ? { output, ...(fullOutput.length > limit ? { outputTruncated: true } : {}) }
          : {}),
        ...(terminal ? { exitCode: failed ? 1 : 0 } : {}),
      };
    } else if (["invokesubagent", "sendmessage"].includes(compactToolName(name))) {
      const result = record(tool.rawOutput);
      const nativeId =
        uuidPattern.exec(
          text(result.subagent_id) ||
            text(result.agent_id) ||
            text(result.session_id) ||
            text(result.cascade_id),
        )?.[0] ??
        uuidPattern.exec(fullOutput)?.[0] ??
        uuidPattern.exec(
          text(input.subagent_id) || text(input.agent_id) || text(input.session_id),
        )?.[0];
      const nativeConfiguration = subagentConfiguration(input);
      state.item = {
        type: "subagentDelegation",
        itemId,
        operation: compactToolName(name) === "sendmessage" ? "send" : "spawn",
        ...(text(input.prompt) || text(input.message)
          ? { prompt: text(input.prompt) || text(input.message) }
          : {}),
        subagents: [
          {
            subagentId: nativeId ?? event.toolCallId,
            ...(nativeId ? { nativeSubagentId: nativeId } : {}),
            description: text(input.description) || tool.title || name,
            ...this.options.parentConfiguration,
            ...nativeConfiguration,
            background: input.run_in_background === true,
            status: terminal ? (failed ? "failed" : "completed") : "running",
            ...(output ? { resultSummary: output } : {}),
          },
        ],
      };
      const observationKey = `${event.toolCallId}:${nativeId}`;
      if (nativeId && !this.#spawned.has(observationKey)) {
        this.#spawned.add(observationKey);
        this.options.onSubagentSpawned?.(nativeId, { item: state.item, outcome });
      }
    } else {
      state.item = {
        type: "toolExecution",
        itemId,
        toolName: name,
        arguments: (args ?? null) as JsonValue,
        ...(fullOutput
          ? {
              output: {
                content: [{ type: "text", text: output }],
                ...(fullOutput.length > limit ? { truncated: true } : {}),
              },
            }
          : {}),
      };
    }
    if (!previous)
      this.#emit({ type: "item.started", turnId: this.options.turnId, item: state.item });
    else if (
      state.item.type === "commandExecution" &&
      state.item.output &&
      previous.type === "commandExecution"
    ) {
      const delta = state.item.output.startsWith(previous.output ?? "")
        ? state.item.output.slice(previous.output?.length ?? 0)
        : state.item.output;
      if (delta)
        this.#emit({
          type: "item.updated",
          turnId: this.options.turnId,
          itemId,
          update: { type: "output.append", text: delta },
        });
    } else if (state.item.type === "toolExecution" && state.item.output)
      this.#emit({
        type: "item.updated",
        turnId: this.options.turnId,
        itemId,
        update: { type: "output.replace", output: state.item.output },
      });
    else if (state.item.type === "subagentDelegation")
      this.#emit({
        type: "item.updated",
        turnId: this.options.turnId,
        itemId,
        update: { type: "subagents.replace", subagents: state.item.subagents },
      });
    this.#diff(state, tool.content, limit);
    if (terminal) this.#complete(state, outcome);
  }

  #diff(state: ToolState, content: unknown, limit: number): void {
    if (!Array.isArray(content) || !state.item) return;
    const changes: HostFileChange[] = content.flatMap((value) => {
      const diff = record(value);
      if (diff.type !== "diff") return [];
      const path = displayPath(text(diff.path), this.options.cwd)?.path;
      if (!path) return [];
      const oldText = text(diff.oldText);
      const newText = text(diff.newText);
      const kind = diff.oldText == null ? "add" : diff.newText == null ? "delete" : "update";
      const patch = createTwoFilesPatch(
        kind === "add" ? "/dev/null" : path,
        kind === "delete" ? "/dev/null" : path,
        oldText,
        newText,
        undefined,
        undefined,
        { context: 3 },
      );
      return [
        {
          path,
          kind,
          unifiedDiff:
            patch.length > limit ? `${patch.slice(0, limit)}\n[diff truncated]\n` : patch,
        },
      ];
    });
    if (!changes.length) return;
    const previous = state.diffItem;
    const byPath = new Map(previous?.changes.map((change) => [change.path, change]));
    for (const change of changes) byPath.set(change.path, change);
    state.diffItem = {
      type: "fileChange",
      itemId: hostItemIdSchema.parse(`${state.item.itemId}-diff`),
      sourceItemIds: [state.item.itemId],
      changes: [...byPath.values()],
    };
    if (!previous)
      this.#emit({ type: "item.started", turnId: this.options.turnId, item: state.diffItem });
    else
      this.#emit({
        type: "item.updated",
        turnId: this.options.turnId,
        itemId: state.diffItem.itemId,
        update: { type: "fileChanges.replace", changes: state.diffItem.changes },
      });
  }

  #emit(event: HostEvent): void {
    this.options.emit(event);
  }
  #complete(state: ToolState, outcome: HostItemOutcome): void {
    if (state.item && !state.snapshot) {
      state.snapshot = { item: state.item, outcome };
      this.#emit({ type: "item.completed", turnId: this.options.turnId, snapshot: state.snapshot });
    }
    if (state.diffItem && !state.diffSnapshot) {
      state.diffSnapshot = { item: state.diffItem, outcome };
      this.#emit({
        type: "item.completed",
        turnId: this.options.turnId,
        snapshot: state.diffSnapshot,
      });
    }
  }

  finishPending(outcome: HostItemOutcome): void {
    for (const state of this.#tools.values()) {
      if (state.snapshot) continue;
      if (state.item?.type === "subagentDelegation")
        state.item = {
          ...state.item,
          subagents: state.item.subagents.map((child) => ({
            ...child,
            status:
              outcome.status === "succeeded"
                ? "completed"
                : outcome.status === "failed"
                  ? "failed"
                  : "interrupted",
          })),
        };
      this.#complete(state, outcome);
    }
  }
  completedSnapshots(): HostItemSnapshot[] {
    return [...this.#tools.values()].flatMap((state) => [
      ...(state.snapshot ? [state.snapshot] : []),
      ...(state.diffSnapshot ? [state.diffSnapshot] : []),
    ]);
  }
}

export function compactionItemId(stepIndex: number): HostItemId {
  return hostItemIdSchema.parse(`checkpoint-${stepIndex}`);
}

export function compactionOutcome(event: NativeCompactionEvent): HostItemOutcome {
  if (event.status === "succeeded") return succeeded;
  return {
    status: "failed",
    error: {
      code: "nativeFailure",
      message: event.error ?? "Antigravity context compaction failed",
      retryable: false,
    },
  };
}

export function projectReplayedEventsToTurns(params: {
  nativeSessionId: string;
  cwd: string;
  events: readonly NativeReplayEvent[];
  outputLimit?: number;
}): HostTurnSnapshot[] {
  const turns: HostTurnSnapshot[] = [];
  const sessionRef = {
    harnessId: "antigravity",
    nativeSessionId: params.nativeSessionId,
    formatVersion: 1,
  };
  const turnRef = (nativeTurnKey: string) =>
    nativeTurnRefSchema.parse({ ...sessionRef, nativeTurnKey });
  const checkpoint = (checkpointId: string) =>
    nativeCheckpointRefSchema.parse({ ...sessionRef, checkpointId });
  let active:
    { turnId: HostTurnId; turn: HostTurnSnapshot; tracker: AntigravityToolTracker } | undefined;
  let userRun = false;
  let textItem: HostItemSnapshot | undefined;
  let sequence = 0;
  let nativeTurnIndex: number | undefined;
  const begin = (boundary?: number, wakeStep?: number) => {
    active?.tracker.finishPending({
      status: "cancelled",
      reason: "No terminal tool status in native history",
    });
    const checkpointId =
      wakeStep !== undefined
        ? `wake-${wakeStep}`
        : boundary === undefined
          ? undefined
          : `turn-${boundary}`;
    // Unanchored history has neither a live Turn identity nor a fork boundary.
    const nativeTurnKey = checkpointId ?? `replay-${turns.length}`;
    const turnId = hostTurnIdSchema.parse(nativeTurnKey);
    const turn: HostTurnSnapshot = {
      nativeTurnRef: turnRef(nativeTurnKey),
      ...(checkpointId !== undefined ? { checkpoint: checkpoint(checkpointId) } : {}),
      input: [],
      items: [],
      outcome: { status: "unknown", reason: "Native history does not include prompt stop reasons" },
    };
    turns.push(turn);
    sequence = 0;
    const positions = new Map<string, number>();
    const tracker = new AntigravityToolTracker({
      turnId,
      cwd: params.cwd,
      ...(params.outputLimit !== undefined ? { outputLimit: params.outputLimit } : {}),
      emit(event) {
        if (event.type === "item.started") {
          positions.set(event.item.itemId, turn.items.length);
          turn.items.push({ item: event.item, outcome: succeeded });
        } else if (event.type === "item.completed") {
          const position = positions.get(event.snapshot.item.itemId);
          if (position !== undefined) turn.items[position] = event.snapshot;
        }
      },
    });
    textItem = undefined;
    nativeTurnIndex = boundary;
    active = { turnId, turn, tracker };
    return active;
  };
  for (const event of params.events) {
    if (event.type === "history.autonomous") {
      begin(undefined, event.stepIndex);
      userRun = false;
    } else if (event.type === "user.text") {
      const { turn } = !active || !userRun ? begin(event.nativeTurnIndex) : active;
      if (event.nativeTurnIndex !== undefined && event.nativeTurnIndex !== nativeTurnIndex) {
        // Consecutive unanswered inputs form one Turn at the last native boundary.
        nativeTurnIndex = event.nativeTurnIndex;
        const key = `turn-${nativeTurnIndex}`;
        turn.nativeTurnRef = turnRef(key);
        turn.checkpoint = checkpoint(key);
      }
      const previous = turn.input[0];
      if (previous) previous.text += event.text;
      else turn.input.push({ type: "text", text: event.text });
      userRun = true;
      textItem = undefined;
    } else if (event.type === "agent.text" || event.type === "agent.thought") {
      const { turn, turnId } = active ?? begin();
      userRun = false;
      const type = event.type === "agent.text" ? "agentMessage" : "reasoning";
      if (textItem?.item.type === type) textItem.item.text += event.text;
      else {
        textItem = {
          item: {
            type,
            itemId: hostItemIdSchema.parse(`${turnId}-item-${sequence++}`),
            text: event.text,
          },
          outcome: succeeded,
        };
        turn.items.push(textItem);
      }
    } else if (event.type === "tool.call" || event.type === "tool.update") {
      const { tracker } = active ?? begin();
      userRun = false;
      textItem = undefined;
      tracker.handleToolEvent(event);
    } else if (event.type === "history.compaction") {
      const { turn } = active ?? begin();
      userRun = false;
      textItem = undefined;
      turn.items.push({
        item: { type: "contextCompaction", itemId: compactionItemId(event.stepIndex) },
        outcome: compactionOutcome(event),
      });
    }
  }
  active?.tracker.finishPending({
    status: "cancelled",
    reason: "No terminal tool status in native history",
  });
  return turns;
}

export function buildLiveCommandCatalog(
  commands: readonly AvailableCommand[],
): HarnessCommandCatalog {
  return mergeLiveHarnessCommands(ANTIGRAVITY_COMMAND_CATALOG, "antigravity.", commands);
}
