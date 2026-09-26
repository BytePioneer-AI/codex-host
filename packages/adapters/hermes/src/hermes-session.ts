import { randomUUID } from "node:crypto";
import { HermesQuestions } from "./hermes-questions.js";

import type {
  PromptResponse,
  RequestPermissionResponse,
  ToolCallUpdate,
} from "@agentclientprotocol/sdk";
import {
  HarnessOutputChannel,
  validateHostApprovalResponse,
  type HostQuestionResponse,
  type HarnessCommandCapability,
  type HostFileChange,
  type HostFileChangeItem,
  type HostContextCompactionItem,
  type HarnessError,
  type HarnessOutput,
  type HarnessResult,
  type HarnessSession,
  type HarnessSessionCapabilities,
  type HarnessSessionState,
  type HostAgentMessageItem,
  type HostApprovalInteraction,
  type HostCommand,
  type HostEvent,
  type InteractionRespondCommand,
  type HostItemOutcome,
  type HostItemSnapshot,
  type HostReasoningItem,
  type HostThreadSnapshot,
  type HostToolExecutionItem,
  type HostToolOutput,
  type HostTurnSnapshot,
  type HostUsage,
  type InteractionRespondAccepted,
  type ModelSelectCommand,
  type ModelSelectCompleted,
  type PermissionModeSelectCommand,
  type PermissionModeSelectCompleted,
  type ThinkingSelectCommand,
  type ThinkingSelectCompleted,
  type TurnCancelAccepted,
  type TurnCancelCommand,
  type TurnOutcome,
  type TurnStartAccepted,
  type TurnStartCommand,
  type TurnSteerAccepted,
  type TurnSteerCommand,
} from "@codexhost/harness-adapter";
import {
  harnessIdSchema,
  harnessPermissionModeIdSchema,
  harnessThinkingOptionIdSchema,
  hostInteractionIdSchema,
  hostItemIdSchema,
  hostTurnIdSchema,
  nativeTurnRefSchema,
  type HarnessId,
  type NativeSessionRef,
  type NativeTurnRef,
} from "@codexhost/shared-contracts";

import {
  HermesTransportError,
  type HermesSessionTransport,
  type HermesQuestionRequest,
  type HermesPromptResponse,
  type HermesOpenResult,
  type HermesPermissionRequest,
  type HermesTransportEvent,
} from "./acp-transport.js";
import {
  catalogAlignedModelLabel,
  decodeHermesModelRefId,
  isHermesModeId,
  projectHermesModelState,
} from "./hermes-models.js";

import {
  hermesFileChanges,
  hermesToolOutput as toolOutputFromUpdate,
} from "./hermes-file-changes.js";
import { hermesCommandCatalog, hermesCommandText } from "./hermes-commands.js";
import { hermesCompactionOutcome } from "./hermes-compaction.js";

const HOST_ERROR_CODES: Record<string, HarnessError["code"]> = {
  notInstalled: "notInstalled",
  authenticationRequired: "authenticationRequired",
  unavailable: "unavailable",
  protocolError: "protocolError",
  processExited: "processExited",
};

function transportErrorToHarness(error: HermesTransportError): HarnessError {
  return {
    code: HOST_ERROR_CODES[error.kind] ?? "nativeFailure",
    message: error.message,
    retryable: error.kind === "unavailable",
  };
}

function harnessError(
  code: HarnessError["code"],
  message: string,
  retryable = false,
): HarnessError {
  return { code, message, retryable };
}

function err<T>(code: HarnessError["code"], message: string, retryable = false): HarnessResult<T> {
  return { ok: false, error: harnessError(code, message, retryable) };
}

function ok<T>(value: T): HarnessResult<T> {
  return { ok: true, value };
}

function nativeTurnsOpenedAfter(
  previousKey: string | undefined,
  turns: readonly HostTurnSnapshot[],
): HostTurnSnapshot[] | "missing-anchor" {
  if (previousKey === undefined) return [...turns];
  const index = turns.findIndex((turn) => turn.nativeTurnRef.nativeTurnKey === previousKey);
  if (index < 0) return "missing-anchor";
  return turns.slice(index + 1);
}

function hermesOpenedTurnCountMatches(
  opened: readonly HostTurnSnapshot[],
  acceptedSteers: number,
): boolean {
  if (opened.length === 0 && acceptedSteers === 0) return true;
  return opened.length === 1 + acceptedSteers;
}

function usageFromPromptResponse(usage: PromptResponse["usage"]): HostUsage | null {
  if (!usage) return null;
  return {
    ...(typeof usage.inputTokens === "number" ? { inputTokens: usage.inputTokens } : {}),
    ...(typeof usage.outputTokens === "number" ? { outputTokens: usage.outputTokens } : {}),
    ...(typeof usage.cachedReadTokens === "number"
      ? { cachedInputTokens: usage.cachedReadTokens }
      : {}),
    ...(typeof usage.thoughtTokens === "number"
      ? { reasoningOutputTokens: usage.thoughtTokens }
      : {}),
    ...(typeof usage.totalTokens === "number" ? { totalTokens: usage.totalTokens } : {}),
  };
}

function usageFromContext(used: number | undefined, size: number | undefined): HostUsage | null {
  if (used === undefined && size === undefined) return null;
  return {
    ...(size !== undefined ? { contextWindowTokens: size } : {}),
    ...(used !== undefined ? { contextUsedTokens: used } : {}),
  };
}

interface ApprovalWaiter {
  interaction: HostApprovalInteraction;
  turnId: ReturnType<typeof hostTurnIdSchema.parse>;
  optionIdByAction: ReadonlyMap<string, string>;
  resolve: (response: RequestPermissionResponse) => void;
}

/**
 * Map ACP permission options to Host approval actions. Action ids equal the
 * native optionIds (already transport-safe), so the Host echoes them back.
 */
function projectPermissionOptions(
  options: HermesPermissionRequest["options"],
  effects?: HermesPermissionRequest["effects"],
): {
  actions: HostApprovalInteraction["actions"];
  optionIdByAction: ReadonlyMap<string, string>;
} {
  const actionEffects: Record<string, HostApprovalInteraction["actions"][number]["effect"]> = {
    allow_once: "allowOnce",
    allow_always: "allowAlways",
    reject_once: "deny",
    reject_always: "deny",
  };
  const fallbackLabels: Record<string, string> = {
    allow_once: "允许一次",
    allow_always: "总是允许",
    reject_once: "拒绝",
    reject_always: "总是拒绝",
  };
  const actions: HostApprovalInteraction["actions"] = [];
  const optionIdByAction = new Map<string, string>();
  for (const option of options) {
    const effect = effects?.[option.optionId] ?? actionEffects[option.kind];
    if (!effect) continue;
    actions.push({
      id: option.optionId,
      label: option.name?.trim() || fallbackLabels[option.kind] || option.optionId,
      effect,
    });
    optionIdByAction.set(option.optionId, option.optionId);
  }
  return { actions, optionIdByAction };
}

class ActiveTurn {
  readonly turnId: ReturnType<typeof hostTurnIdSchema.parse>;
  readonly turnKey: string;
  readonly input: TurnStartCommand["input"];
  readonly persistsHistory: boolean;
  readonly compactionItem: HostContextCompactionItem | null;
  compactionText = "";
  nativeCompactionOutcome: HostItemOutcome | undefined;
  nativeTurnSnapshot: HostTurnSnapshot | undefined;
  acceptedSteers = 0;
  #currentText: {
    kind: "reasoning" | "agentMessage";
    item: HostReasoningItem | HostAgentMessageItem;
  } | null = null;
  #toolItems = new Map<
    string,
    { item: HostToolExecutionItem; startedAt: number; output?: HostToolOutput }
  >();
  #finishedItems: HostItemSnapshot[] = [];
  #toolChanges = new Map<string, HostFileChange[]>();
  #emittedTerminalItemIds = new Set<string>();

  rememberFileChanges(toolCallId: string, update: ToolCallUpdate): void {
    const changes = hermesFileChanges(update);
    if (update.content?.some((block) => block.type === "diff"))
      this.#toolChanges.set(toolCallId, changes);
  }

  completeFileChanges(
    toolCallId: string,
    sourceItemId: HostToolExecutionItem["itemId"],
  ): HostItemSnapshot | null {
    const changes = this.#toolChanges.get(toolCallId);
    this.#toolChanges.delete(toolCallId);
    if (!changes?.length) return null;
    const item: HostFileChangeItem = {
      type: "fileChange",
      itemId: hostItemIdSchema.parse(randomUUID()),
      changes,
      sourceItemIds: [sourceItemId],
    };
    const snapshot: HostItemSnapshot = { item, outcome: { status: "succeeded" } };
    this.#finishedItems.push(snapshot);
    this.#emittedTerminalItemIds.add(item.itemId);
    return snapshot;
  }

  constructor(
    turnId: string,
    turnKey: string,
    input: TurnStartCommand["input"],
    persistsHistory: boolean,
    compaction: boolean,
  ) {
    this.turnId = hostTurnIdSchema.parse(turnId);
    this.turnKey = turnKey;
    this.input = input;
    this.persistsHistory = persistsHistory;
    this.compactionItem = compaction
      ? { type: "contextCompaction", itemId: hostItemIdSchema.parse(randomUUID()) }
      : null;
  }

  appendText(
    kind: "reasoning" | "agentMessage",
    text: string,
  ): {
    startedItem: HostReasoningItem | HostAgentMessageItem | null;
    item: HostReasoningItem | HostAgentMessageItem;
  } | null {
    if (this.#currentText && this.#currentText.kind === kind) {
      const item = { ...this.#currentText.item, text: this.#currentText.item.text + text };
      this.#currentText = { kind, item };
      return { startedItem: null, item };
    }
    // Switching text kind consolidates the previous stream into finished items
    // so the Turn snapshot keeps both reasoning and agentMessage content.
    if (this.#currentText) {
      this.#finishedItems.push({
        item: this.#currentText.item,
        outcome: { status: "succeeded" },
      });
    }
    const item: HostReasoningItem | HostAgentMessageItem =
      kind === "reasoning"
        ? { type: "reasoning", itemId: hostItemIdSchema.parse(randomUUID()), text: "" }
        : { type: "agentMessage", itemId: hostItemIdSchema.parse(randomUUID()), text: "" };
    const appended = { ...item, text };
    this.#currentText = { kind, item: appended };
    return { startedItem: item, item: appended };
  }

  completeCurrentText(): HostItemSnapshot | null {
    if (!this.#currentText) return null;
    const snapshot: HostItemSnapshot = {
      item: this.#currentText.item,
      outcome: { status: "succeeded" },
    };
    this.#currentText = null;
    this.#finishedItems.push(snapshot);
    this.#emittedTerminalItemIds.add(snapshot.item.itemId);
    return snapshot;
  }

  addToolItem(toolCallId: string, entry: { item: HostToolExecutionItem; startedAt: number }): void {
    this.#toolItems.set(toolCallId, entry);
  }

  getToolItem(toolCallId: string): { item: HostToolExecutionItem; startedAt: number } | undefined {
    return this.#toolItems.get(toolCallId);
  }

  updateToolOutput(toolCallId: string, output: HostToolOutput): void {
    const entry = this.#toolItems.get(toolCallId);
    if (entry) entry.output = output;
  }

  completeToolItem(
    toolCallId: string,
    output: HostToolOutput | null,
    failed: boolean,
  ): HostItemSnapshot | null {
    const entry = this.#toolItems.get(toolCallId);
    if (!entry) return null;
    this.#toolItems.delete(toolCallId);
    const outcome: HostItemOutcome = failed
      ? { status: "failed", error: harnessError("nativeFailure", "Tool execution failed") }
      : { status: "succeeded" };
    const finalOutput = output ?? entry.output;
    const snapshot: HostItemSnapshot = {
      item: { ...entry.item, ...(finalOutput ? { output: finalOutput } : {}) },
      outcome,
    };
    this.#finishedItems.push(snapshot);
    this.#emittedTerminalItemIds.add(snapshot.item.itemId);
    return snapshot;
  }

  finish(): void {
    if (this.#currentText) {
      this.#finishedItems.push({
        item: this.#currentText.item,
        outcome: { status: "succeeded" },
      });
      this.#currentText = null;
    }
    for (const [, entry] of this.#toolItems) {
      this.#finishedItems.push({
        item: { ...entry.item, ...(entry.output ? { output: entry.output } : {}) },
        outcome: { status: "cancelled", reason: "Turn ended" },
      });
    }
    this.#toolItems.clear();
  }

  finishCompaction(outcome: TurnOutcome): HostItemOutcome | null {
    if (!this.compactionItem) return null;
    const itemOutcome =
      outcome.status === "succeeded" && this.nativeCompactionOutcome
        ? this.nativeCompactionOutcome
        : hermesCompactionOutcome(outcome, this.compactionText);
    this.#finishedItems.push({ item: this.compactionItem, outcome: itemOutcome });
    return itemOutcome;
  }

  drainPendingItems(): HostItemSnapshot[] {
    const pending = this.#finishedItems.filter(
      (snapshot) => !this.#emittedTerminalItemIds.has(snapshot.item.itemId),
    );
    this.#finishedItems = [];
    this.#emittedTerminalItemIds.clear();
    return pending;
  }

  toSnapshot(
    nativeTurnRef: NativeTurnRef,
    outcome: TurnOutcome,
    includeItems: boolean,
  ): HostTurnSnapshot {
    return {
      nativeTurnRef,
      input: this.input,
      items: includeItems ? [...this.#finishedItems] : [],
      outcome,
    };
  }
}

function isPlainObjectOrArray(value: unknown): boolean {
  return typeof value === "object" && value !== null;
}

function historyTurnsFromReplay(
  replay: HermesTransportEvent[],
  nativeRef: NativeSessionRef,
  knownTurnRefs: readonly NativeTurnRef[] = [],
): HostTurnSnapshot[] {
  const turns: HostTurnSnapshot[] = [];
  let current: {
    inputText: string;
    items: HostItemSnapshot[];
    turnKey: string;
  } | null = null;
  let toolItemIndexes = new Map<string, number>();
  const toolChanges = new Map<string, HostFileChange[]>();
  const appendFileChanges = (
    toolCallId: string,
    update: ToolCallUpdate,
    sourceItemId: HostToolExecutionItem["itemId"],
  ) => {
    const changes = hermesFileChanges(update);
    if (update.content?.some((block) => block.type === "diff"))
      toolChanges.set(toolCallId, changes);
    const confirmedChanges = toolChanges.get(toolCallId);
    if (current && update.status === "completed" && confirmedChanges?.length) {
      current.items.push({
        item: {
          type: "fileChange",
          itemId: hostItemIdSchema.parse(randomUUID()),
          changes: confirmedChanges,
          sourceItemIds: [sourceItemId],
        },
        outcome: { status: "succeeded" },
      });
    }
    if (update.status === "completed" || update.status === "failed") toolChanges.delete(toolCallId);
  };

  const closeTurn = () => {
    if (!current || current.items.length === 0) {
      current = null;
      return;
    }
    const known = knownTurnRefs[turns.length];
    const nativeTurnRef =
      known?.harnessId === nativeRef.harnessId &&
      known.nativeSessionId === nativeRef.nativeSessionId
        ? known
        : nativeTurnRefSchema.parse({
            harnessId: nativeRef.harnessId,
            nativeSessionId: nativeRef.nativeSessionId,
            nativeTurnKey: current.turnKey,
            formatVersion: 1,
          });
    turns.push({
      nativeTurnRef,
      input: [{ type: "text", text: current.inputText }],
      items: current.items,
      outcome: {
        status: "unknown",
        reason: "Hermes replay does not include terminal Turn outcome metadata",
      },
    });
    current = null;
    toolItemIndexes = new Map();
    toolChanges.clear();
  };

  const pushText = (kind: "reasoning" | "agentMessage", text: string) => {
    if (!current)
      current = { inputText: "(resumed)", items: [], turnKey: `history-${turns.length + 1}` };
    const last = current.items.at(-1);
    if (last && last.item.type === kind) {
      if (kind === "reasoning") {
        (last.item as HostReasoningItem).text += text;
      } else {
        (last.item as HostAgentMessageItem).text += text;
      }
      return;
    }
    current.items.push({
      item:
        kind === "reasoning"
          ? { type: "reasoning", itemId: hostItemIdSchema.parse(randomUUID()), text }
          : { type: "agentMessage", itemId: hostItemIdSchema.parse(randomUUID()), text },
      outcome: { status: "succeeded" },
    });
  };

  for (const event of replay) {
    switch (event.type) {
      case "user.text": {
        if (current && current.items.length === 0) {
          current.inputText += event.text;
        } else {
          closeTurn();
          current = { inputText: event.text, items: [], turnKey: `history-${turns.length + 1}` };
        }
        break;
      }
      case "agent.thought":
        pushText("reasoning", event.text);
        break;
      case "agent.text":
        pushText("agentMessage", event.text);
        break;
      case "tool.call": {
        if (!current)
          current = { inputText: "(resumed)", items: [], turnKey: `history-${turns.length + 1}` };
        const update = event.update as ToolCallUpdate;
        const output = toolOutputFromUpdate(update);
        const toolName =
          (typeof update.title === "string" && update.title.trim()) ||
          (typeof update.name === "string" && update.name.trim()) ||
          event.toolCallId;
        current.items.push({
          item: {
            type: "toolExecution",
            itemId: hostItemIdSchema.parse(randomUUID()),
            toolName,
            arguments: isPlainObjectOrArray(update.rawInput)
              ? (update.rawInput as HostToolExecutionItem["arguments"])
              : null,
            ...(output ? { output } : {}),
          },
          outcome:
            update.status === "completed"
              ? { status: "succeeded" }
              : update.status === "failed"
                ? {
                    status: "failed",
                    error: harnessError("nativeFailure", "Tool execution failed"),
                  }
                : { status: "cancelled", reason: "Turn ended before terminal tool update" },
        });
        toolItemIndexes.set(event.toolCallId, current.items.length - 1);
        const sourceItemId = current.items.at(-1)?.item.itemId;
        if (sourceItemId) appendFileChanges(event.toolCallId, update, sourceItemId);
        break;
      }
      case "tool.update": {
        if (!current) break;
        const itemIndex = toolItemIndexes.get(event.toolCallId);
        if (itemIndex === undefined) break;
        const prior = current.items[itemIndex];
        if (!prior || prior.item.type !== "toolExecution") break;
        const update = event.update as ToolCallUpdate;
        const output = toolOutputFromUpdate(update);
        current.items[itemIndex] = {
          item: { ...prior.item, ...(output ? { output } : {}) },
          outcome:
            update.status === "completed"
              ? { status: "succeeded" }
              : update.status === "failed"
                ? {
                    status: "failed",
                    error: harnessError("nativeFailure", "Tool execution failed"),
                  }
                : prior.outcome,
        };
        appendFileChanges(event.toolCallId, update, prior.item.itemId);
        break;
      }
      default:
        break;
    }
  }
  closeTurn();
  return turns;
}

function lastUsageFromReplay(replay: HermesTransportEvent[]): HostUsage | null {
  for (let index = replay.length - 1; index >= 0; index -= 1) {
    const event = replay[index];
    if (!event || event.type !== "usage") continue;
    const usage = usageFromContext(event.used, event.size);
    if (usage) return usage;
  }
  return null;
}

export interface HermesSessionOptions {
  nativeRef: NativeSessionRef;
  transport: HermesSessionTransport;
  open: HermesOpenResult;
  knownTurnRefs?: readonly NativeTurnRef[];
  supportsDerivation?: boolean;
  onSettle: (session: HermesSession) => void;
}

export class HermesSession implements HarnessSession {
  readonly harnessId: HarnessId = harnessIdSchema.parse("hermes");

  readonly capabilities: HarnessSessionCapabilities = {
    configuration: {
      selectModel: true,
      selectThinkingOption: false,
      selectPermissionMode: true,
      permissionModeScope: "live",
    },
    history: {
      fork: false,
      forkAcrossCwd: false,
      rollbackLastTurn: false,
    },
  };

  readonly initialState: HarnessSessionState;

  readonly initialUsage: HostUsage | null;

  readonly outputs: AsyncIterable<HarnessOutput>;
  readonly commands: HarnessCommandCapability;

  #channel = new HarnessOutputChannel<HarnessOutput>();
  #transport: HermesSessionTransport;
  #nativeRef: NativeSessionRef;
  #onSettle: (session: HermesSession) => void;

  #state: HarnessSessionState;
  #faulted: HarnessError | null = null;
  #closed = false;
  #availableModels: { modelId: string; name: string }[] = [];

  #activeTurn: ActiveTurn | null = null;
  #activeTurnId: ReturnType<typeof hostTurnIdSchema.parse> | null = null;
  #completedTurns: HostTurnSnapshot[] = [];
  #historyTurns: HostTurnSnapshot[];
  #latestUsage: HostUsage | null;
  #questions = new HermesQuestions((output) => this.#channel.emit(output));
  #approvalWaiters = new Map<ReturnType<typeof hostInteractionIdSchema.parse>, ApprovalWaiter>();

  constructor(options: HermesSessionOptions) {
    this.#transport = options.transport;
    this.capabilities.history.fork = options.supportsDerivation === true;
    this.capabilities.history.rollbackLastTurn = options.supportsDerivation === true;
    this.commands = {
      list: async () =>
        this.#closed || this.#faulted
          ? err("invalidState", "Hermes Session is unavailable")
          : ok(hermesCommandCatalog(this.#transport.availableCommands ?? [])),
      execute: async (command) => {
        const text = hermesCommandText(
          command,
          hermesCommandCatalog(this.#transport.availableCommands ?? []),
        );
        if (!text.ok) return text;
        return this.execute({
          type: "turn.start",
          turnId: command.turnId,
          input: [{ type: "text", text: text.value }],
        });
      },
    };
    this.#nativeRef = options.nativeRef;
    this.#onSettle = options.onSettle;
    const projected = projectHermesModelState(options.open.session.models);
    const modes = options.open.session.modes;
    // Kept for set_model: ACP returns no state after a switch, so the label is
    // re-projected from the same SessionState inventory that seeded this
    // session.
    this.#availableModels = options.open.session.models?.availableModels ?? [];
    this.capabilities.configuration.selectThinkingOption = !!this.#transport.setThinking;
    if (this.#transport.steer) this.capabilities.steer = true;
    this.#state = {
      nativeRef: this.#nativeRef,
      ...(options.open.session.thinkingOptions
        ? { availableThinkingOptions: options.open.session.thinkingOptions }
        : {}),
      ...(options.open.session.currentThinkingOptionId
        ? {
            effectiveThinkingOptionId: harnessThinkingOptionIdSchema.parse(
              options.open.session.currentThinkingOptionId,
            ),
          }
        : {}),
      ...(projected.effectiveModel ? { effectiveModel: projected.effectiveModel } : {}),
      ...(projected.resolvedModelLabel ? { resolvedModelLabel: projected.resolvedModelLabel } : {}),
      ...(modes
        ? { effectivePermissionModeId: harnessPermissionModeIdSchema.parse(modes.currentModeId) }
        : {}),
    };
    this.initialState = { ...this.#state };
    this.#historyTurns = historyTurnsFromReplay(
      options.open.replay,
      this.#nativeRef,
      options.knownTurnRefs,
    );
    this.initialUsage = lastUsageFromReplay(options.open.replay);
    this.#latestUsage = this.initialUsage;
    this.outputs = this.#channel.outputs;
    this.#transport.onFault = (error) => this.#fault(transportErrorToHarness(error));
  }

  get busy(): boolean {
    return this.#activeTurn !== null;
  }

  async readSnapshot(): Promise<HarnessResult<HostThreadSnapshot>> {
    if (this.#closed) return err("invalidState", "Hermes Session is closed");
    if (this.#transport.readNativeSnapshot) {
      try {
        return ok({ ...(await this.#transport.readNativeSnapshot()), state: { ...this.#state } });
      } catch (error) {
        return err("nativeFailure", error instanceof Error ? error.message : String(error));
      }
    }
    return ok({
      turns: [...this.#historyTurns, ...this.#completedTurns],
      state: { ...this.#state },
    });
  }

  execute(command: TurnStartCommand): Promise<HarnessResult<TurnStartAccepted>>;
  execute(command: TurnSteerCommand): Promise<HarnessResult<TurnSteerAccepted>>;
  execute(command: TurnCancelCommand): Promise<HarnessResult<TurnCancelAccepted>>;
  execute(command: InteractionRespondCommand): Promise<HarnessResult<InteractionRespondAccepted>>;
  execute(command: ModelSelectCommand): Promise<HarnessResult<ModelSelectCompleted>>;
  execute(command: ThinkingSelectCommand): Promise<HarnessResult<ThinkingSelectCompleted>>;
  execute(
    command: PermissionModeSelectCommand,
  ): Promise<HarnessResult<PermissionModeSelectCompleted>>;
  async execute(
    command: HostCommand,
  ): Promise<
    HarnessResult<
      | TurnStartAccepted
      | TurnSteerAccepted
      | TurnCancelAccepted
      | InteractionRespondAccepted
      | ModelSelectCompleted
      | ThinkingSelectCompleted
      | PermissionModeSelectCompleted
    >
  > {
    if (this.#closed || this.#faulted) {
      return err(
        "invalidState",
        this.#closed ? "Hermes Session is closed" : "Hermes Session has faulted",
      );
    }
    switch (command.type) {
      case "turn.start":
        return this.#startTurn(command);
      case "turn.steer":
        return this.#steer(command);
      case "turn.cancel":
        return this.#cancelTurn(command);
      case "interaction.respond":
        return Promise.resolve(
          command.response.type === "question"
            ? this.#questions.respond(command)
            : this.#respondToApproval(command),
        );
      case "model.select":
        return this.#selectModel(command);
      case "thinking.select":
        return this.#selectThinking(command);
      case "permissionMode.select":
        return this.#selectPermissionMode(command);
      default: {
        const exhaustive: never = command;
        return err("invalidRequest", `Unsupported command ${(exhaustive as HostCommand).type}`);
      }
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#cancelApprovalWaiters();
    if (this.#activeTurn)
      this.#completeActiveTurn(this.#activeTurn, { status: "cancelled", reason: "Session closed" });
    await this.#transport.close().catch(() => undefined);
    this.#channel.end();
    this.#onSettle(this);
  }

  #cancelApprovalWaiters(): void {
    this.#questions.cancel();
    for (const [interactionId, waiter] of this.#approvalWaiters) {
      waiter.resolve({ outcome: { outcome: "cancelled" } });
      this.#emit({
        type: "interaction.closed",
        interactionId,
        turnId: waiter.turnId,
        reason: "cancelled",
      });
    }
    this.#approvalWaiters.clear();
  }

  #fault(error: HarnessError): void {
    if (this.#closed || this.#faulted) return;
    this.#faulted = error;
    this.#cancelApprovalWaiters();
    if (this.#activeTurn) {
      this.#completeActiveTurn(this.#activeTurn, { status: "failed", error });
    }
    this.#emit({ type: "session.faulted", error });
    this.#channel.end();
    this.#onSettle(this);
  }

  #emit(event: HostEvent): void {
    this.#channel.emit({ kind: "event", event });
  }

  #emitInteraction(interaction: HostApprovalInteraction): void {
    this.#channel.emit({ kind: "interaction", interaction });
  }

  #startTurn(command: TurnStartCommand): HarnessResult<TurnStartAccepted> {
    if (this.#activeTurn) {
      return err("sessionBusy", "Hermes Session already has an active Turn", true);
    }
    const text = command.input.map((chunk) => chunk.text).join("\n");
    if (text.trim().length === 0) {
      return err("invalidRequest", "turn.start requires non-empty text input");
    }
    const turnKey = randomUUID();
    const firstToken = text.trim().split(/\s/u)[0]?.replace(/^\/+/u, "").toLowerCase();
    // ACP strips repeated slashes and dispatches advertised names with trailing
    // arguments. Other transports must classify with the same parser they dispatch.
    const nativeCommand = this.#transport.nativeCommandName
      ? this.#transport.nativeCommandName(text)
      : text.trimStart().startsWith("/") &&
          (this.#transport.availableCommands ?? []).some((entry) => entry.name === firstToken)
        ? firstToken
        : null;
    const isNativeCommand = nativeCommand != null;
    const active = new ActiveTurn(
      command.turnId,
      turnKey,
      command.input,
      !isNativeCommand,
      isNativeCommand && nativeCommand === "compress",
    );
    this.#activeTurn = active;
    this.#activeTurnId = active.turnId;
    void this.#runTurn(active, text);
    return ok({ turnId: active.turnId });
  }

  async #steer(command: TurnSteerCommand): Promise<HarnessResult<TurnSteerAccepted>> {
    if (!this.#transport.steer) return err("unsupported", "Hermes Session cannot steer");
    const active = this.#activeTurn;
    if (!active || active.turnId !== command.turnId) {
      return err("invalidState", "Hermes Turn is not active");
    }
    const text = command.input.map((chunk) => chunk.text).join("\n");
    if (text.trim().length === 0) {
      return err("invalidRequest", "turn.steer requires non-empty text input");
    }
    let status: "queued" | "rejected";
    try {
      status = await this.#transport.steer(text);
    } catch (error) {
      if (this.#closed || this.#faulted) {
        return err(
          "invalidState",
          this.#closed ? "Hermes Session is closed" : "Hermes Session has faulted",
        );
      }
      if (error instanceof HermesTransportError) {
        return { ok: false, error: transportErrorToHarness(error) };
      }
      return err("nativeFailure", error instanceof Error ? error.message : String(error));
    }
    if (this.#closed || this.#faulted) {
      return err(
        "invalidState",
        this.#closed ? "Hermes Session is closed" : "Hermes Session has faulted",
      );
    }
    if (this.#activeTurn !== active || active.turnId !== command.turnId) {
      return err("invalidState", "Hermes Turn is not active");
    }
    if (status === "rejected") return err("invalidState", "Hermes rejected the steered input");
    active.acceptedSteers += 1;
    return ok({ accepted: true });
  }

  async #runTurn(active: ActiveTurn, text: string): Promise<void> {
    this.#emit({ type: "turn.started", turnId: active.turnId });
    if (active.compactionItem)
      this.#emit({ type: "item.started", turnId: active.turnId, item: active.compactionItem });
    let promptResponse: HermesPromptResponse | null = null;
    let failure: HarnessError | null = null;
    let previousNativeTurnKey: string | undefined;
    try {
      if (active.persistsHistory && this.#transport.readNativeSnapshot)
        previousNativeTurnKey = (await this.#transport.readNativeSnapshot()).turns.at(-1)
          ?.nativeTurnRef.nativeTurnKey;
      promptResponse = await this.#transport.runTurn(
        text,
        (event) => this.#handleTransportEvent(active, event),
        (request) => this.#handlePermissionRequest(active, request),
        (request) => this.#handleQuestionRequest(active, request),
      );
    } catch (error) {
      failure =
        error instanceof HermesTransportError
          ? transportErrorToHarness(error)
          : harnessError("nativeFailure", error instanceof Error ? error.message : String(error));
    }
    if (this.#activeTurn !== active) {
      // Session closed or faulted mid-turn; events were already finalized.
      return;
    }
    let outcome: TurnOutcome;
    if (failure) {
      outcome = { status: "failed", error: failure };
    } else if (promptResponse?.stopReason === "cancelled") {
      outcome = { status: "cancelled", reason: "Cancellation requested" };
    } else if (promptResponse && promptResponse.stopReason !== "end_turn") {
      outcome = {
        status: "failed",
        error: harnessError(
          "nativeFailure",
          `Hermes Turn ended with stopReason ${String(promptResponse.stopReason)}`,
        ),
      };
    } else {
      outcome = { status: "succeeded" };
    }

    active.nativeCompactionOutcome = promptResponse?.compactionOutcome;
    if (active.persistsHistory && this.#transport.readNativeSnapshot) {
      try {
        const opened = nativeTurnsOpenedAfter(
          previousNativeTurnKey,
          (await this.#transport.readNativeSnapshot()).turns,
        );
        const expected = 1 + active.acceptedSteers;
        if (
          opened === "missing-anchor" ||
          !hermesOpenedTurnCountMatches(opened, active.acceptedSteers)
        ) {
          if (outcome.status === "succeeded") {
            outcome = {
              status: "failed",
              error: harnessError(
                "protocolError",
                opened === "missing-anchor"
                  ? "Hermes history no longer contains the Turn that was current when this Turn started"
                  : `Hermes Turn persisted ${opened.length} new Native Turns; ${expected} are required`,
              ),
            };
          }
        } else if (opened.length > 0) {
          active.nativeTurnSnapshot = opened[0];
        }
      } catch (error) {
        outcome = {
          status: "failed",
          error: harnessError(
            "nativeFailure",
            error instanceof Error ? error.message : String(error),
          ),
        };
      }
    }
    const terminalUsage = promptResponse ? usageFromPromptResponse(promptResponse.usage) : null;
    const usage = terminalUsage ? this.#mergeUsage(terminalUsage) : null;
    this.#completeActiveTurn(active, outcome, usage);
  }

  #completeActiveTurn(
    active: ActiveTurn,
    outcome: TurnOutcome,
    usage: HostUsage | null = null,
  ): void {
    if (this.#activeTurn !== active) return;
    this.#cancelApprovalWaiters();
    this.#activeTurn = null;
    this.#activeTurnId = null;
    active.finish();
    const compactionOutcome = active.finishCompaction(outcome);
    if (outcome.status === "succeeded" && compactionOutcome?.status === "failed") {
      outcome = { status: "failed", error: compactionOutcome.error };
    }
    if (active.nativeTurnSnapshot?.checkpoint)
      outcome = { ...outcome, checkpoint: active.nativeTurnSnapshot.checkpoint };
    const nativeTurnRef =
      active.nativeTurnSnapshot?.nativeTurnRef ??
      nativeTurnRefSchema.parse({
        harnessId: this.#nativeRef.harnessId,
        nativeSessionId: this.#nativeRef.nativeSessionId,
        nativeTurnKey: active.turnKey,
        formatVersion: 1,
      });
    const turnSnapshot = active.toSnapshot(nativeTurnRef, outcome, true);
    for (const pending of active.drainPendingItems()) {
      this.#emit({ type: "item.completed", turnId: active.turnId, snapshot: pending });
    }
    if (usage) {
      this.#emit({ type: "session.usage.changed", usage, observedForTurnId: active.turnId });
    }
    this.#emit({
      type: "turn.completed",
      turnId: active.turnId,
      ...(active.persistsHistory &&
      (!this.#transport.readNativeSnapshot || active.nativeTurnSnapshot)
        ? { nativeTurnRef }
        : {}),
      outcome,
    });
    if (active.persistsHistory) this.#completedTurns.push(turnSnapshot);
  }

  #handleTransportEvent(active: ActiveTurn, event: HermesTransportEvent): void {
    if (this.#activeTurn !== active) return;
    switch (event.type) {
      case "usage": {
        const usage = usageFromContext(event.used, event.size);
        if (!usage) return;
        const mergedUsage = this.#mergeUsage(usage);
        this.#emit({
          type: "session.usage.changed",
          usage: mergedUsage,
          observedForTurnId: active.turnId,
        });
        return;
      }
      case "agent.thought":
        this.#appendTextItem(active, "reasoning", event.text);
        return;
      case "agent.text":
        if (active.compactionItem) active.compactionText += event.text;
        this.#appendTextItem(active, "agentMessage", event.text);
        return;
      case "tool.call": {
        const update = event.update as ToolCallUpdate;
        this.#startToolItem(
          active,
          event.toolCallId,
          typeof update.title === "string" ? update.title : null,
          typeof update.name === "string" ? update.name : null,
          update.rawInput,
        );
        this.#updateToolItem(active, update);
        return;
      }
      case "tool.update":
        this.#updateToolItem(active, event.update as ToolCallUpdate);
        return;
      default:
        return;
    }
  }

  #appendTextItem(active: ActiveTurn, kind: "reasoning" | "agentMessage", text: string): void {
    const appended = active.appendText(kind, text);
    if (!appended) return;
    if (appended.startedItem) {
      this.#emit({ type: "item.started", turnId: active.turnId, item: appended.startedItem });
    }
    this.#emit({
      type: "item.updated",
      turnId: active.turnId,
      itemId: appended.item.itemId,
      update: { type: "text.append", text },
    });
  }

  #startToolItem(
    active: ActiveTurn,
    toolCallId: string,
    title: string | null,
    name: string | null,
    rawInput: unknown,
  ): void {
    const completedText = active.completeCurrentText();
    if (completedText) {
      this.#emit({ type: "item.completed", turnId: active.turnId, snapshot: completedText });
    }
    const item: HostToolExecutionItem = {
      type: "toolExecution",
      itemId: hostItemIdSchema.parse(randomUUID()),
      toolName: (name ?? title ?? "").trim() || toolCallId,
      arguments: isPlainObjectOrArray(rawInput)
        ? (rawInput as HostToolExecutionItem["arguments"])
        : null,
    };
    active.addToolItem(toolCallId, { item, startedAt: Date.now() });
    this.#emit({ type: "item.started", turnId: active.turnId, item });
  }

  #mergeUsage(usage: HostUsage): HostUsage {
    const merged = { ...(this.#latestUsage ?? {}), ...usage };
    this.#latestUsage = merged;
    return merged;
  }

  #updateToolItem(active: ActiveTurn, update: ToolCallUpdate): void {
    const entry = active.getToolItem(update.toolCallId);
    if (!entry) return;
    active.rememberFileChanges(update.toolCallId, update);
    const output = toolOutputFromUpdate(update);
    if (output && output.content.length > 0) {
      active.updateToolOutput(update.toolCallId, output);
      this.#emit({
        type: "item.updated",
        turnId: active.turnId,
        itemId: entry.item.itemId,
        update: { type: "output.replace", output },
      });
    }
    if (update.status === "completed" || update.status === "failed") {
      const completed = active.completeToolItem(
        update.toolCallId,
        output,
        update.status === "failed",
      );
      if (completed) {
        this.#emit({ type: "item.completed", turnId: active.turnId, snapshot: completed });
        if (update.status === "completed") {
          const fileChange = active.completeFileChanges(update.toolCallId, completed.item.itemId);
          if (fileChange) {
            this.#emit({ type: "item.started", turnId: active.turnId, item: fileChange.item });
            this.#emit({ type: "item.completed", turnId: active.turnId, snapshot: fileChange });
          }
        }
      }
    }
  }

  #handlePermissionRequest(
    active: ActiveTurn,
    request: HermesPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    const projected = projectPermissionOptions(request.options, request.effects);
    if (projected.actions.length === 0) {
      return Promise.resolve({ outcome: { outcome: "cancelled" } });
    }
    const interactionId = hostInteractionIdSchema.parse(randomUUID());
    const interaction: HostApprovalInteraction = {
      type: "approval",
      interactionId,
      turnId: active.turnId,
      title: request.request.toolCall.title?.slice(0, 200) ?? "Hermes 请求批准",
      ...(request.description ? { description: request.description } : {}),
      subject: { type: "nativeAction" },
      actions: projected.actions,
    };
    this.#emitInteraction(interaction);
    let abort = () => {};
    const pending = new Promise<RequestPermissionResponse>((resolve) => {
      this.#approvalWaiters.set(interactionId, {
        interaction,
        turnId: active.turnId,
        optionIdByAction: projected.optionIdByAction,
        resolve,
      });
      abort = () => {
        if (!this.#approvalWaiters.delete(interactionId)) return;
        resolve({ outcome: { outcome: "cancelled" } });
        this.#emit({
          type: "interaction.closed",
          interactionId,
          turnId: active.turnId,
          reason: request.signal?.reason === "expired" ? "expired" : "cancelled",
        });
      };
      request.signal?.addEventListener("abort", abort, { once: true });
      if (request.signal?.aborted) abort();
    });
    return pending.finally(() => request.signal?.removeEventListener("abort", abort));
  }

  #respondToApproval(
    command: InteractionRespondCommand,
  ): HarnessResult<InteractionRespondAccepted> {
    if (this.#faulted) {
      return err("invalidState", "Hermes Session has faulted");
    }
    if (this.#closed) {
      return err("invalidState", "Hermes Session is closed");
    }
    if (command.response.type !== "approval") {
      return err("invalidRequest", "Hermes approvals only accept approval responses");
    }
    const waiter = this.#approvalWaiters.get(command.interactionId);
    if (!waiter) {
      return err("sessionNotFound", `No pending approval ${command.interactionId}`);
    }
    const validation = validateHostApprovalResponse(waiter.interaction, command.response);
    if (validation) {
      return err(validation.code, validation.message);
    }
    this.#approvalWaiters.delete(command.interactionId);
    const optionId = waiter.optionIdByAction.get(command.response.actionId);
    if (optionId) {
      waiter.resolve({ outcome: { outcome: "selected", optionId } });
    } else {
      waiter.resolve({ outcome: { outcome: "cancelled" } });
    }
    this.#emit({
      type: "interaction.closed",
      interactionId: command.interactionId,
      turnId: waiter.turnId,
      reason: optionId ? "responded" : "cancelled",
    });
    return ok({ accepted: true });
  }

  async #cancelTurn(command: TurnCancelCommand): Promise<HarnessResult<TurnCancelAccepted>> {
    if (!this.#activeTurn || this.#activeTurnId !== command.turnId) {
      return err("invalidRequest", `No active Turn ${command.turnId}`);
    }
    try {
      await this.#transport.cancel();
      this.#questions.cancel(command.turnId);
      for (const [interactionId, waiter] of this.#approvalWaiters) {
        if (waiter.turnId !== command.turnId) continue;
        this.#approvalWaiters.delete(interactionId);
        waiter.resolve({ outcome: { outcome: "cancelled" } });
        this.#emit({
          type: "interaction.closed",
          interactionId,
          turnId: waiter.turnId,
          reason: "cancelled",
        });
      }
      return ok({ cancellationRequested: true });
    } catch (error) {
      const failure =
        error instanceof HermesTransportError
          ? transportErrorToHarness(error)
          : harnessError("nativeFailure", error instanceof Error ? error.message : String(error));
      return { ok: false, error: failure };
    }
  }

  #handleQuestionRequest(
    active: ActiveTurn,
    request: HermesQuestionRequest,
  ): Promise<HostQuestionResponse> {
    if (this.#activeTurn !== active)
      return Promise.resolve({ type: "question", answers: {}, cancelled: true });
    return this.#questions.open(active.turnId, request);
  }

  async #selectThinking(
    command: ThinkingSelectCommand,
  ): Promise<HarnessResult<ThinkingSelectCompleted>> {
    if (!this.#transport.setThinking)
      return err("unsupported", "Hermes does not expose Thinking options");
    if (!this.#state.availableThinkingOptions?.some(({ id }) => id === command.thinkingOptionId))
      return err("invalidRequest", "Unknown Hermes Thinking option");
    try {
      const selected = await this.#transport.setThinking(command.thinkingOptionId);
      this.#state = {
        ...this.#state,
        effectiveThinkingOptionId: harnessThinkingOptionIdSchema.parse(selected),
      };
      this.#emit({ type: "session.state.changed", state: { ...this.#state } });
      return ok({ completed: true });
    } catch (error) {
      return err("nativeFailure", error instanceof Error ? error.message : String(error));
    }
  }

  async #selectModel(command: ModelSelectCommand): Promise<HarnessResult<ModelSelectCompleted>> {
    const native = decodeHermesModelRefId(command.model.id);
    if (!native) {
      return err("invalidRequest", "Model Ref does not belong to Hermes");
    }
    try {
      await this.#transport.setModel(native);
    } catch (error) {
      if (error instanceof HermesTransportError) {
        return { ok: false, error: transportErrorToHarness(error) };
      }
      return err(
        "nativeFailure",
        error instanceof Error ? error.message : "Hermes rejected Model selection",
      );
    }
    // The ACP set_model call returns no state, so resolve the label from the
    // same SessionState the initial projection used. Falling back to the
    // native id would surface a bogus "resolved route" chip in the picker.
    const projectedAfterSelect = projectHermesModelState({
      availableModels: this.#availableModels,
      currentModelId: native,
    });
    this.#state = {
      ...this.#state,
      effectiveModel: command.model,
      resolvedModelLabel:
        projectedAfterSelect.resolvedModelLabel ?? catalogAlignedModelLabel(native),
    };
    this.#emit({ type: "session.state.changed", state: { ...this.#state } });
    return ok({ completed: true });
  }

  async #selectPermissionMode(
    command: PermissionModeSelectCommand,
  ): Promise<HarnessResult<PermissionModeSelectCompleted>> {
    if (this.#activeTurn) {
      return err("sessionBusy", "Permission Mode selection conflicts with an active Turn", true);
    }
    if (!isHermesModeId(command.permissionModeId)) {
      return err("invalidRequest", "Permission Mode does not belong to Hermes");
    }
    try {
      await this.#transport.setPermissionMode(command.permissionModeId);
    } catch (error) {
      if (error instanceof HermesTransportError) {
        return { ok: false, error: transportErrorToHarness(error) };
      }
      return err(
        "nativeFailure",
        error instanceof Error ? error.message : "Hermes rejected Permission Mode selection",
      );
    }
    const locator = this.#nativeRef.locator;
    if (
      locator &&
      typeof locator === "object" &&
      !Array.isArray(locator) &&
      locator.transport === "gateway"
    ) {
      this.#nativeRef = {
        ...this.#nativeRef,
        locator: { ...locator, permissionModeId: command.permissionModeId },
      };
    }
    this.#state = {
      ...this.#state,
      nativeRef: this.#nativeRef,
      effectivePermissionModeId: harnessPermissionModeIdSchema.parse(command.permissionModeId),
    };
    this.#emit({ type: "session.state.changed", state: { ...this.#state } });
    return ok({ completed: true });
  }
}
