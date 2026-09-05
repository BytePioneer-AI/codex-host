import {
  harnessIdSchema,
  harnessModelCatalogSchema,
  hostInteractionIdSchema,
  hostItemIdSchema,
} from "@codexhost/shared-contracts";
import type {
  HarnessId,
  HarnessInspection,
  HarnessModelCatalog,
  HarnessModelRef,
  HarnessPermissionModeCatalog,
  HarnessPermissionModeId,
  HarnessPermissionModeScope,
  HarnessThinkingOption,
  HarnessThinkingOptionId,
  HostInteractionId,
  HostItemId,
  HostTurnId,
  JsonValue,
  NativeCheckpointRef,
  NativeSessionRef,
  NativeTurnRef,
} from "@codexhost/shared-contracts";

import { validateHostInteractionResponse } from "./interaction.js";
import { HarnessOutputChannel } from "./output-channel.js";
import { parseHostUsage, type HostUsage } from "./usage.js";
import type {
  HarnessAdapter,
  HarnessCommandCapability,
  HarnessError,
  HarnessOutput,
  HarnessResult,
  HarnessSession,
  HarnessSessionCapabilities,
  HarnessSessionState,
  InspectHarnessInput,
  HostAgentMessageItem,
  HostApprovalInteraction,
  HostCommand,
  HostCommandExecutionItem,
  HostEvent,
  HostFileChange,
  HostItem,
  HostItemOutcome,
  HostItemSnapshot,
  HostInteraction,
  HostItemUpdate,
  HostQuestion,
  HostQuestionInteraction,
  HostReasoningItem,
  HostSubagentState,
  HostThreadSnapshot,
  HostToolExecutionItem,
  HostToolOutput,
  HostTurnSnapshot,
  InteractionRespondAccepted,
  InteractionRespondCommand,
  ModelSelectCommand,
  ModelSelectCompleted,
  OpenSessionInput,
  PermissionModeSelectCommand,
  PermissionModeSelectCompleted,
  ThinkingSelectCommand,
  ThinkingSelectCompleted,
  TurnCancelAccepted,
  TurnCancelCommand,
  TurnStartAccepted,
  TurnStartCommand,
} from "./text-session.js";

interface ActiveFakeTurn {
  command: TurnStartCommand;
  items: Map<HostItemId, HostItem>;
  completedItems: HostItemSnapshot[];
  interactions: Map<HostInteractionId, HostInteraction>;
  cancellationRequested: boolean;
}

const invalidStateError: HarnessError = {
  code: "invalidState",
  message: "Fake Harness Session is closed",
  retryable: false,
};

const defaultFakeCatalog = harnessModelCatalogSchema.parse({
  models: [
    {
      ref: { id: "fake-model-v1.primary" },
      label: "Fake Primary",
      resolvedModelLabel: "fake-runtime-primary",
      supportedThinkingOptionIds: ["off", "high"],
    },
    {
      ref: { id: "fake-model-v1.secondary" },
      label: "Fake Secondary",
      supportedThinkingOptionIds: ["off", "low"],
    },
  ],
  defaultModel: { id: "fake-model-v1.primary" },
  thinkingOptions: [
    { id: "off", label: "Off" },
    { id: "low", label: "Low" },
    { id: "high", label: "High" },
  ],
  defaultThinkingOptionId: "high",
});

function catalogHasModel(catalog: HarnessModelCatalog, model: HarnessModelRef): boolean {
  return catalog.models.some((candidate) => candidate.ref.id === model.id);
}

function resolvedLabelForModel(
  catalog: HarnessModelCatalog,
  model: HarnessModelRef | undefined,
): string | undefined {
  return catalog.models.find((candidate) => candidate.ref.id === model?.id)?.resolvedModelLabel;
}

function thinkingOptionsForModel(
  catalog: HarnessModelCatalog,
  model: HarnessModelRef | undefined,
): HarnessThinkingOption[] {
  const supported = catalog.models.find(
    (candidate) => candidate.ref.id === model?.id,
  )?.supportedThinkingOptionIds;
  return supported ? catalog.thinkingOptions.filter((option) => supported.includes(option.id)) : [];
}

function catalogHasThinkingOption(
  catalog: HarnessModelCatalog,
  thinkingOptionId: HarnessThinkingOptionId,
): boolean {
  return catalog.thinkingOptions.some(({ id }) => id === thinkingOptionId);
}

function catalogHasPermissionMode(
  catalog: HarnessPermissionModeCatalog | undefined,
  permissionModeId: HarnessPermissionModeId,
): boolean {
  return catalog?.modes.some(({ id }) => id === permissionModeId) ?? false;
}

function invalidState(message: string): HarnessError {
  return { code: "invalidState", message, retryable: false };
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class FakeHarnessSession implements HarnessSession {
  readonly harnessId: HarnessId;
  readonly capabilities: HarnessSessionCapabilities;
  readonly cwd: string;
  readonly initialState: HarnessSessionState;
  readonly initialUsage: HostUsage | null;
  commands?: HarnessCommandCapability;
  readonly interactionResponses: InteractionRespondCommand[] = [];
  readonly outputs: AsyncIterable<HarnessOutput>;
  snapshotReads = 0;
  usageRefreshes = 0;
  usageFailures = 0;
  readonly #catalog: HarnessModelCatalog;
  readonly #permissionModes: HarnessPermissionModeCatalog | undefined;
  readonly #channel = new HarnessOutputChannel<HarnessOutput>();
  #active: ActiveFakeTurn | null = null;
  #closed = false;
  #completeCancellationDuringRequest = false;
  #interactionOrdinal = 0;
  #itemOrdinal = 0;
  #nextModelRejection: HarnessError | null = null;
  #nextThinkingRejection: HarnessError | null = null;
  #nextPermissionModeRejection: HarnessError | null = null;
  #nextTurnUsage: HostUsage | null | undefined;
  #nextApproval: { title: string; description?: string } | null = null;
  #nextQuestion: {
    question: HostQuestion;
    options: { itemId?: HostItemId; title?: string; expiresAt?: string };
  } | null = null;
  #nextRejection: HarnessError | null = null;
  #state: HarnessSessionState;
  #snapshot: HostThreadSnapshot;
  #turnOrdinal = 0;

  constructor(
    harnessId: HarnessId,
    catalog: HarnessModelCatalog = defaultFakeCatalog,
    initialModel: HarnessModelRef | undefined = catalog.defaultModel,
    nativeRef: NativeSessionRef = {
      harnessId,
      nativeSessionId: `fake-session-${Math.random().toString(36).slice(2)}`,
      formatVersion: 1,
    },
    snapshot: HostThreadSnapshot = { turns: [] },
    supportsFork = true,
    cwd = "/synthetic",
    supportsForkAcrossCwd = supportsFork,
    initialThinkingOptionId: HarnessThinkingOptionId | undefined = catalog.defaultThinkingOptionId,
    initialUsage: HostUsage | null = null,
    permissionModes?: HarnessPermissionModeCatalog,
    initialPermissionModeId: HarnessPermissionModeId | undefined = permissionModes?.defaultModeId,
    supportsRollbackLastTurn = false,
    permissionModeScope: HarnessPermissionModeScope = "live",
    supportsReplacementFence = true,
  ) {
    this.harnessId = harnessId;
    const availableThinkingOptions = thinkingOptionsForModel(catalog, initialModel);
    const effectiveThinkingOptionId = availableThinkingOptions.some(
      ({ id }) => id === initialThinkingOptionId,
    )
      ? initialThinkingOptionId
      : availableThinkingOptions[0]?.id;
    this.capabilities = {
      configuration: {
        selectModel: true,
        selectThinkingOption: catalog.thinkingOptions.length > 0,
        selectPermissionMode: permissionModes !== undefined,
        permissionModeScope,
      },
      history: {
        fork: supportsFork,
        forkAcrossCwd: supportsForkAcrossCwd,
        rollbackLastTurn: supportsRollbackLastTurn,
        replacementFence: supportsReplacementFence,
      },
      subagents: { observe: false, readTranscript: false },
    };
    this.cwd = cwd;
    this.#catalog = catalog;
    this.#permissionModes = permissionModes;
    const resolvedModelLabel = resolvedLabelForModel(catalog, initialModel);
    this.initialState = {
      nativeRef,
      ...(initialModel ? { effectiveModel: initialModel } : {}),
      ...(resolvedModelLabel ? { resolvedModelLabel } : {}),
      ...(effectiveThinkingOptionId ? { effectiveThinkingOptionId } : {}),
      ...(availableThinkingOptions.length > 0 ? { availableThinkingOptions } : {}),
      ...(initialPermissionModeId ? { effectivePermissionModeId: initialPermissionModeId } : {}),
    };
    this.#state = this.initialState;
    this.initialUsage = initialUsage === null ? null : parseHostUsage(initialUsage);
    this.#snapshot = cloneJson(snapshot);
    this.#turnOrdinal = snapshot.turns.length;
    this.outputs = this.#channel.outputs;
  }

  get state(): HarnessSessionState {
    return this.#state;
  }

  get closed(): boolean {
    return this.#closed;
  }

  setStateForSnapshot(state: HarnessSessionState): void {
    if (this.#closed) throw new Error("Fake Harness Session is closed");
    this.#state = cloneJson(state);
  }

  publishEphemeralCommand(turnId: HostTurnId, item: HostItem): void {
    if (this.#closed) throw new Error("Fake Harness Session is closed");
    this.#event({ type: "turn.started", turnId });
    this.#event({ type: "item.started", turnId, item });
    this.#event({
      type: "item.completed",
      turnId,
      snapshot: { item, outcome: { status: "succeeded" } },
    });
    this.#event({ type: "turn.completed", turnId, outcome: { status: "succeeded" } });
  }

  publishAutonomousTurn(turnId: HostTurnId, input: TurnStartCommand["input"]): void {
    if (this.#closed) throw new Error("Fake Harness Session is closed");
    if (this.#active) throw new Error("Fake Harness Session already has an active Turn");
    this.#active = {
      command: { type: "turn.start", turnId, input },
      items: new Map(),
      completedItems: [],
      interactions: new Map(),
      cancellationRequested: false,
    };
    this.#event({ type: "turn.autonomous.started", turnId, input });
    this.#event({ type: "turn.started", turnId });
    this.succeedTurn();
  }

  startAutonomousTurn(turnId: HostTurnId, input: TurnStartCommand["input"]): void {
    if (this.#closed) throw new Error("Fake Harness Session is closed");
    if (this.#active) throw new Error("Fake Harness Session already has an active Turn");
    const item: HostAgentMessageItem = {
      type: "agentMessage",
      itemId: this.#nextItemId(),
      text: "",
    };
    this.#active = {
      command: { type: "turn.start", turnId, input: cloneJson(input) },
      items: new Map([[item.itemId, item]]),
      completedItems: [],
      interactions: new Map(),
      cancellationRequested: false,
    };
    this.#event({ type: "turn.autonomous.started", turnId, input: cloneJson(input) });
    this.#event({ type: "turn.started", turnId });
    this.#event({ type: "item.started", turnId, item });
  }

  publishUsage(usage: HostUsage | null, observedForTurnId?: HostTurnId): void {
    if (this.#closed) throw new Error("Fake Harness Session is closed");
    this.#event({
      type: "session.usage.changed",
      usage: usage === null ? null : parseHostUsage(usage),
      ...(observedForTurnId ? { observedForTurnId } : {}),
    });
  }

  failUsageTelemetry(): void {
    if (this.#closed) throw new Error("Fake Harness Session is closed");
    this.usageFailures += 1;
  }

  publishUsageOnNextTurn(usage: HostUsage | null): void {
    this.#nextTurnUsage = usage === null ? null : parseHostUsage(usage);
  }

  async refreshUsage(): Promise<void> {
    if (this.#closed) throw new Error("Fake Harness Session is closed");
    this.usageRefreshes += 1;
  }

  async readSnapshot(): Promise<HarnessResult<HostThreadSnapshot>> {
    this.snapshotReads += 1;
    if (this.#closed) return { ok: false, error: invalidStateError };
    if (this.#active) {
      return {
        ok: false,
        error: {
          code: "sessionBusy",
          message: "Fake Harness Session cannot read history during an active Turn",
          retryable: true,
        },
      };
    }
    return {
      ok: true,
      value: { ...cloneJson(this.#snapshot), state: cloneJson(this.#state) },
    };
  }

  persistedSnapshot(): HostThreadSnapshot {
    return cloneJson(this.#snapshot);
  }

  rejectNextTurn(error: HarnessError): void {
    this.#nextRejection = error;
  }

  rejectNextModelSelection(error: HarnessError): void {
    this.#nextModelRejection = error;
  }

  rejectNextThinkingSelection(error: HarnessError): void {
    this.#nextThinkingRejection = error;
  }

  rejectNextPermissionModeSelection(error: HarnessError): void {
    this.#nextPermissionModeRejection = error;
  }

  completeCancellationOnRequest(): void {
    this.#completeCancellationDuringRequest = true;
  }

  requestApprovalOnNextTurn(title: string, description?: string): void {
    this.#nextApproval = { title, ...(description ? { description } : {}) };
  }

  askQuestionOnNextTurn(
    question: HostQuestion,
    options: { itemId?: HostItemId; title?: string; expiresAt?: string } = {},
  ): void {
    this.#nextQuestion = { question, options };
  }

  execute(command: TurnStartCommand): Promise<HarnessResult<TurnStartAccepted>>;
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
      | TurnCancelAccepted
      | InteractionRespondAccepted
      | ModelSelectCompleted
      | ThinkingSelectCompleted
      | PermissionModeSelectCompleted
    >
  > {
    if (this.#closed) return { ok: false, error: invalidStateError };
    if (command.type === "turn.cancel") return this.#cancel(command);
    if (command.type === "interaction.respond") return this.#respond(command);
    if (command.type === "model.select") return this.#selectModel(command);
    if (command.type === "thinking.select") return this.#selectThinking(command);
    if (command.type === "permissionMode.select") return this.#selectPermissionMode(command);
    if (this.#nextRejection) {
      const error = this.#nextRejection;
      this.#nextRejection = null;
      return { ok: false, error };
    }
    if (this.#active) {
      return {
        ok: false,
        error: {
          code: "sessionBusy",
          message: "Fake Harness Session already has an active Turn",
          retryable: true,
        },
      };
    }
    const text = command.input.map((input) => input.text).join("\n");
    if (text.length === 0) {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "Text Turn input must not be empty",
          retryable: false,
        },
      };
    }
    const item: HostAgentMessageItem = {
      type: "agentMessage",
      itemId: this.#nextItemId(),
      text: "",
    };
    this.#active = {
      command,
      items: new Map([[item.itemId, item]]),
      completedItems: [],
      interactions: new Map(),
      cancellationRequested: false,
    };
    this.#event({ type: "turn.started", turnId: command.turnId });
    this.#event({ type: "item.started", turnId: command.turnId, item });
    if (this.#nextTurnUsage !== undefined) {
      const usage = this.#nextTurnUsage;
      this.#nextTurnUsage = undefined;
      this.publishUsage(usage, command.turnId);
    }
    if (this.#nextQuestion) {
      const pending = this.#nextQuestion;
      this.#nextQuestion = null;
      this.askQuestion(pending.question, pending.options);
    }
    if (this.#nextApproval) {
      const pending = this.#nextApproval;
      this.#nextApproval = null;
      this.requestApproval(pending.title, pending.description);
    }
    return { ok: true, value: { turnId: command.turnId } };
  }

  appendText(text: string): void {
    const active = this.#requireActive();
    const item = [...active.items.values()].find(
      (candidate): candidate is HostAgentMessageItem => candidate.type === "agentMessage",
    );
    if (!item) throw new Error("Fake Harness Session has no Agent Message Item");
    const updated = { ...item, text: item.text + text };
    active.items.set(item.itemId, updated);
    this.#updateItem(item.itemId, { type: "text.append", text });
  }

  startReasoning(text: string): HostItemId {
    if (text.length === 0) throw new Error("Fake Reasoning must start with non-empty text");
    const item: HostReasoningItem = {
      type: "reasoning",
      itemId: this.#nextItemId(),
      text: "",
    };
    this.#startItem(item);
    this.appendReasoning(item.itemId, text);
    return item.itemId;
  }

  appendReasoning(itemId: HostItemId, text: string): void {
    const active = this.#requireActive();
    const item = active.items.get(itemId);
    if (item?.type !== "reasoning") throw new Error("Fake Harness Item is not Reasoning");
    active.items.set(itemId, { ...item, text: item.text + text });
    this.#updateItem(itemId, { type: "text.append", text });
  }

  startCommandExecution(command: string, cwd?: string): HostItemId {
    const item: HostCommandExecutionItem = {
      type: "commandExecution",
      itemId: this.#nextItemId(),
      command,
      ...(cwd ? { cwd } : {}),
    };
    this.#startItem(item);
    return item.itemId;
  }

  appendCommandOutput(itemId: HostItemId, text: string): void {
    const active = this.#requireActive();
    const item = active.items.get(itemId);
    if (item?.type !== "commandExecution") {
      throw new Error("Fake Harness Item is not a Command Execution");
    }
    active.items.set(itemId, { ...item, output: (item.output ?? "") + text });
    this.#updateItem(itemId, { type: "output.append", text });
  }

  startToolExecution(toolName: string, arguments_: JsonValue, namespace?: string): HostItemId {
    const item: HostToolExecutionItem = {
      type: "toolExecution",
      itemId: this.#nextItemId(),
      toolName,
      arguments: arguments_,
      ...(namespace ? { namespace } : {}),
    };
    this.#startItem(item);
    return item.itemId;
  }

  startSubagentDelegation(subagent: HostSubagentState): HostItemId {
    const item = {
      type: "subagentDelegation" as const,
      itemId: this.#nextItemId(),
      operation: "spawn" as const,
      subagents: [subagent],
    };
    this.#startItem(item);
    return item.itemId;
  }

  replaceSubagents(itemId: HostItemId, subagents: HostSubagentState[]): void {
    const active = this.#requireActive();
    const item = active.items.get(itemId);
    if (item?.type !== "subagentDelegation") {
      throw new Error("Fake Harness Item is not a Subagent delegation");
    }
    active.items.set(itemId, { ...item, subagents });
    this.#updateItem(itemId, { type: "subagents.replace", subagents });
  }

  emitSubagentTranscriptChanged(nativeSubagentId: string): void {
    this.#channel.emit({
      kind: "event",
      event: { type: "subagent.transcript.changed", nativeSubagentId },
    });
  }

  emitSubagentState(
    nativeSubagentId: string,
    status: HostSubagentState["status"],
    resultSummary?: string,
  ): void {
    this.#channel.emit({
      kind: "event",
      event: {
        type: "subagent.state.changed",
        nativeSubagentId,
        status,
        ...(resultSummary ? { resultSummary } : {}),
      },
    });
  }

  replaceToolOutput(itemId: HostItemId, output: HostToolOutput): void {
    const active = this.#requireActive();
    const item = active.items.get(itemId);
    if (item?.type !== "toolExecution") {
      throw new Error("Fake Harness Item is not a Generic Tool");
    }
    active.items.set(itemId, { ...item, output });
    this.#updateItem(itemId, { type: "output.replace", output });
  }

  completeItem(itemId: HostItemId, outcome: HostItemOutcome): void {
    const active = this.#requireActive();
    const item = active.items.get(itemId);
    if (!item) throw new Error("Fake Harness Item is not active");
    active.items.delete(itemId);
    const snapshot = { item, outcome };
    active.completedItems.push(snapshot);
    this.#event({
      type: "item.completed",
      turnId: active.command.turnId,
      snapshot,
    });
  }

  emitFileChange(changes: HostFileChange[]): HostItemId {
    const itemId = this.#nextItemId();
    this.#startItem({ type: "fileChange", itemId, changes });
    this.completeItem(itemId, { status: "succeeded" });
    return itemId;
  }

  askQuestion(
    question: HostQuestion,
    options: { itemId?: HostItemId; title?: string; expiresAt?: string } = {},
  ): HostInteractionId {
    const active = this.#requireActive();
    const interactionId = this.#nextInteractionId();
    const interaction: HostQuestionInteraction = {
      type: "question",
      interactionId,
      turnId: active.command.turnId,
      questions: [question],
      ...(options.itemId ? { itemId: options.itemId } : {}),
      ...(options.title ? { title: options.title } : {}),
      ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}),
    };
    active.interactions.set(interactionId, interaction);
    this.#channel.emit({ kind: "interaction", interaction });
    return interactionId;
  }

  requestApproval(
    title: string,
    description?: string,
    suggestedScope?: "session" | "always",
  ): HostInteractionId {
    const active = this.#requireActive();
    const interactionId = this.#nextInteractionId();
    const interaction: HostApprovalInteraction = {
      type: "approval",
      interactionId,
      turnId: active.command.turnId,
      title,
      ...(description ? { description } : {}),
      subject: { type: "nativeAction" },
      actions: [
        { id: "allowOnce", label: "Allow once", effect: "allowOnce" },
        ...(suggestedScope === "session"
          ? [
              {
                id: "allowForSession",
                label: "Allow this conversation",
                effect: "allowForSession" as const,
              },
            ]
          : suggestedScope === "always"
            ? [
                {
                  id: "allowAlways",
                  label: "Always allow",
                  effect: "allowAlways" as const,
                },
              ]
            : []),
        { id: "deny", label: "Deny", effect: "deny" },
      ],
    };
    active.interactions.set(interactionId, interaction);
    this.#channel.emit({ kind: "interaction", interaction });
    return interactionId;
  }

  expireQuestion(interactionId: HostInteractionId): void {
    const active = this.#requireActive();
    if (active.interactions.get(interactionId)?.type !== "question") {
      throw new Error("Fake Harness Question is not pending");
    }
    active.interactions.delete(interactionId);
    this.#event({
      type: "interaction.closed",
      interactionId,
      turnId: active.command.turnId,
      reason: "expired",
    });
  }

  succeedTurn(): void {
    const active = this.#requireActive();
    const unfinishedTools = [...active.items.values()].filter(
      (item) => item.type !== "agentMessage" && item.type !== "reasoning",
    );
    if (unfinishedTools.length > 0) {
      throw new Error("Fake Harness Session cannot succeed with active Tool Items");
    }
    if (active.interactions.size > 0) {
      throw new Error("Fake Harness Session cannot succeed with pending Interactions");
    }
    this.#completeItems(active, { status: "succeeded" });
    this.#finishTurn(active, { status: "succeeded" });
  }

  completeCancellation(reason = "Cancelled by user"): void {
    const active = this.#requireActive();
    if (!active.cancellationRequested) {
      throw new Error("Fake Harness Turn has no cancellation request");
    }
    const outcome = { status: "cancelled" as const, reason };
    this.#closeInteractions(active, "cancelled");
    this.#completeItems(active, outcome);
    this.#finishTurn(active, outcome);
  }

  failTurn(error: HarnessError): void {
    const active = this.#requireActive();
    const outcome = { status: "failed" as const, error };
    this.#closeInteractions(active, "cancelled");
    this.#completeItems(active, outcome);
    this.#finishTurn(active, outcome);
  }

  fault(error: HarnessError): void {
    if (this.#active) this.failTurn(error);
    this.#closed = true;
    this.#event({ type: "session.faulted", error });
    this.#channel.end();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    if (this.#active) this.failTurn(invalidStateError);
    this.#closed = true;
    this.#channel.end();
  }

  #respond(command: InteractionRespondCommand): HarnessResult<InteractionRespondAccepted> {
    const active = this.#active;
    const interaction = active?.interactions.get(command.interactionId);
    if (!active || !interaction) {
      return {
        ok: false,
        error: invalidState("Interaction Response must reference a pending Interaction"),
      };
    }
    const error = validateHostInteractionResponse(interaction, command.response);
    if (error) return { ok: false, error };
    active.interactions.delete(command.interactionId);
    this.interactionResponses.push(command);
    this.#event({
      type: "interaction.closed",
      interactionId: command.interactionId,
      turnId: active.command.turnId,
      reason:
        command.response.type === "question" && command.response.cancelled
          ? "cancelled"
          : "responded",
    });
    return { ok: true, value: { accepted: true } };
  }

  #selectModel(command: ModelSelectCommand): HarnessResult<ModelSelectCompleted> {
    if (this.#active) {
      return {
        ok: false,
        error: {
          code: "sessionBusy",
          message: "Fake Harness Session cannot select a Model during an active Turn",
          retryable: true,
        },
      };
    }
    if (this.#nextModelRejection) {
      const error = this.#nextModelRejection;
      this.#nextModelRejection = null;
      return { ok: false, error };
    }
    if (!catalogHasModel(this.#catalog, command.model)) {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "Fake Harness Model Ref is not in the current catalog",
          retryable: false,
        },
      };
    }
    const availableThinkingOptions = thinkingOptionsForModel(this.#catalog, command.model);
    const effectiveThinkingOptionId = availableThinkingOptions.some(
      ({ id }) => id === this.#state.effectiveThinkingOptionId,
    )
      ? this.#state.effectiveThinkingOptionId
      : availableThinkingOptions[0]?.id;
    const resolvedModelLabel = resolvedLabelForModel(this.#catalog, command.model);
    const nextState: HarnessSessionState = {
      ...this.#state,
      effectiveModel: command.model,
      ...(resolvedModelLabel ? { resolvedModelLabel } : {}),
      ...(effectiveThinkingOptionId ? { effectiveThinkingOptionId } : {}),
      availableThinkingOptions,
    };
    if (!resolvedModelLabel) delete nextState.resolvedModelLabel;
    if (!effectiveThinkingOptionId) delete nextState.effectiveThinkingOptionId;
    this.#state = nextState;
    this.#event({ type: "session.state.changed", state: this.#state });
    return { ok: true, value: { completed: true } };
  }

  #selectThinking(command: ThinkingSelectCommand): HarnessResult<ThinkingSelectCompleted> {
    if (this.#active) {
      return {
        ok: false,
        error: {
          code: "sessionBusy",
          message: "Fake Harness Session cannot select Thinking during an active Turn",
          retryable: true,
        },
      };
    }
    if (!this.capabilities.configuration.selectThinkingOption) {
      return {
        ok: false,
        error: {
          code: "unsupported",
          message: "Fake Harness does not support Thinking selection",
          retryable: false,
        },
      };
    }
    if (this.#nextThinkingRejection) {
      const error = this.#nextThinkingRejection;
      this.#nextThinkingRejection = null;
      return { ok: false, error };
    }
    const available = this.#state.availableThinkingOptions ?? [];
    if (!available.some(({ id }) => id === command.thinkingOptionId)) {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "Fake Harness Thinking option is not currently available",
          retryable: false,
        },
      };
    }
    this.#state = { ...this.#state, effectiveThinkingOptionId: command.thinkingOptionId };
    this.#event({ type: "session.state.changed", state: this.#state });
    return { ok: true, value: { completed: true } };
  }

  #selectPermissionMode(
    command: PermissionModeSelectCommand,
  ): HarnessResult<PermissionModeSelectCompleted> {
    if (this.#active) {
      return {
        ok: false,
        error: {
          code: "sessionBusy",
          message: "Fake Harness Session cannot select Permission Mode during an active Turn",
          retryable: true,
        },
      };
    }
    if (!this.capabilities.configuration.selectPermissionMode || !this.#permissionModes) {
      return {
        ok: false,
        error: {
          code: "unsupported",
          message: "Fake Harness does not support Permission Mode selection",
          retryable: false,
        },
      };
    }
    if (this.capabilities.configuration.permissionModeScope === "atCreate") {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "Permission Mode is fixed at Session creation",
          retryable: false,
        },
      };
    }
    if (this.#nextPermissionModeRejection) {
      const error = this.#nextPermissionModeRejection;
      this.#nextPermissionModeRejection = null;
      return { ok: false, error };
    }
    if (!catalogHasPermissionMode(this.#permissionModes, command.permissionModeId)) {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "Fake Harness Permission Mode is not in the current catalog",
          retryable: false,
        },
      };
    }
    this.#state = { ...this.#state, effectivePermissionModeId: command.permissionModeId };
    this.#event({ type: "session.state.changed", state: this.#state });
    return { ok: true, value: { completed: true } };
  }

  #cancel(command: TurnCancelCommand): HarnessResult<TurnCancelAccepted> {
    const active = this.#active;
    if (!active || active.command.turnId !== command.turnId) {
      return { ok: false, error: invalidState("Turn Cancel must reference the active Turn") };
    }
    active.cancellationRequested = true;
    if (this.#completeCancellationDuringRequest) {
      this.#completeCancellationDuringRequest = false;
      this.completeCancellation();
    }
    return { ok: true, value: { cancellationRequested: true } };
  }

  #startItem(item: HostItem): void {
    const active = this.#requireActive();
    active.items.set(item.itemId, item);
    this.#event({ type: "item.started", turnId: active.command.turnId, item });
  }

  #updateItem(itemId: HostItemId, update: HostItemUpdate): void {
    const active = this.#requireActive();
    this.#event({ type: "item.updated", turnId: active.command.turnId, itemId, update });
  }

  #closeInteractions(active: ActiveFakeTurn, reason: "cancelled" | "expired" | "superseded"): void {
    for (const interaction of active.interactions.values()) {
      this.#event({
        type: "interaction.closed",
        interactionId: interaction.interactionId,
        turnId: active.command.turnId,
        reason,
      });
    }
    active.interactions.clear();
  }

  #completeItems(active: ActiveFakeTurn, outcome: HostItemOutcome): void {
    for (const item of [...active.items.values()].reverse()) {
      active.items.delete(item.itemId);
      const snapshot = { item, outcome };
      active.completedItems.push(snapshot);
      this.#event({
        type: "item.completed",
        turnId: active.command.turnId,
        snapshot,
      });
    }
  }

  #finishTurn(active: ActiveFakeTurn, outcome: HostItemOutcome): void {
    if (this.#active !== active) return;
    this.#active = null;
    this.#turnOrdinal += 1;
    const nativeRef = this.#state.nativeRef;
    if (!nativeRef) throw new Error("Fake Harness Session has no Native Session identity");
    const nativeTurnRef: NativeTurnRef = {
      harnessId: this.harnessId,
      nativeSessionId: nativeRef.nativeSessionId,
      nativeTurnKey: `fake-turn-${this.#turnOrdinal}`,
      formatVersion: 1,
    };
    const checkpoint: NativeCheckpointRef | undefined = this.capabilities.history.fork
      ? {
          harnessId: this.harnessId,
          nativeSessionId: nativeRef.nativeSessionId,
          checkpointId: `fake-checkpoint-${this.#turnOrdinal}`,
          formatVersion: 1,
        }
      : undefined;
    const historicalOutcome =
      outcome.status === "succeeded"
        ? ({ status: "succeeded" } as const)
        : outcome.status === "cancelled"
          ? {
              status: "cancelled" as const,
              ...(outcome.reason ? { reason: outcome.reason } : {}),
            }
          : { status: "failed" as const, error: outcome.error };
    const turn: HostTurnSnapshot = {
      nativeTurnRef,
      ...(checkpoint ? { checkpoint } : {}),
      input: cloneJson(active.command.input),
      items: cloneJson(active.completedItems),
      outcome: historicalOutcome,
      ...(this.#state.effectiveModel ? { model: this.#state.effectiveModel } : {}),
    };
    this.#snapshot.turns.push(turn);
    this.#event({
      type: "turn.completed",
      turnId: active.command.turnId,
      nativeTurnRef,
      outcome: { ...outcome, ...(checkpoint ? { checkpoint } : {}) },
    });
  }

  #event(event: HostEvent): void {
    this.#channel.emit({ kind: "event", event });
  }

  #nextInteractionId(): HostInteractionId {
    this.#interactionOrdinal += 1;
    return hostInteractionIdSchema.parse(`fake-interaction-${this.#interactionOrdinal}`);
  }

  #nextItemId(): HostItemId {
    this.#itemOrdinal += 1;
    return hostItemIdSchema.parse(`fake-item-${this.#itemOrdinal}`);
  }

  #requireActive(): ActiveFakeTurn {
    if (!this.#active) throw new Error("Fake Harness Session has no active Turn");
    return this.#active;
  }
}

export class FakeHarnessAdapter implements HarnessAdapter {
  readonly harnessId: HarnessId;
  readonly catalog: HarnessModelCatalog;
  readonly permissionModes: HarnessPermissionModeCatalog | undefined;
  readonly sessions: FakeHarnessSession[] = [];
  readonly initialUsage: HostUsage | null;
  readonly supportsFork: boolean;
  readonly supportsForkAcrossCwd: boolean;
  readonly supportsRollbackLastTurn: boolean;
  readonly supportsReplacementFence: boolean;
  readonly permissionModeScope: HarnessPermissionModeScope;
  inspectionCalls = 0;
  #closePromise: Promise<void> | null = null;
  #sessionOrdinal = 0;
  #sessionsByNativeId = new Map<string, FakeHarnessSession>();

  constructor(
    harnessId: HarnessId = harnessIdSchema.parse("fake"),
    catalog: HarnessModelCatalog = defaultFakeCatalog,
    supportsFork = true,
    supportsForkAcrossCwd = supportsFork,
    initialUsage: HostUsage | null = null,
    permissionModes?: HarnessPermissionModeCatalog,
    supportsRollbackLastTurn = false,
    permissionModeScope: HarnessPermissionModeScope = "live",
    supportsReplacementFence = true,
  ) {
    this.harnessId = harnessId;
    this.catalog = catalog;
    this.permissionModes = permissionModes;
    this.initialUsage = initialUsage === null ? null : parseHostUsage(initialUsage);
    this.supportsFork = supportsFork;
    this.supportsForkAcrossCwd = supportsForkAcrossCwd;
    this.supportsRollbackLastTurn = supportsRollbackLastTurn;
    this.supportsReplacementFence = supportsReplacementFence;
    this.permissionModeScope = permissionModeScope;
  }

  async inspect(input: InspectHarnessInput = {}): Promise<HarnessInspection> {
    void input;
    this.inspectionCalls += 1;
    if (this.#closePromise) {
      return {
        status: "unavailable",
        error: {
          code: "invalidState",
          message: "Fake Harness Adapter is closed",
          retryable: false,
        },
      };
    }
    return {
      status: "ready",
      catalog: this.catalog,
      ...(this.permissionModes ? { permissionModes: this.permissionModes } : {}),
      capabilities: {
        configuration: {
          selectModel: true,
          selectThinkingOption: this.catalog.thinkingOptions.length > 0,
          selectPermissionMode: this.permissionModes !== undefined,
          permissionModeScope: this.permissionModeScope,
        },
        history: {
          fork: this.supportsFork,
          forkAcrossCwd: this.supportsForkAcrossCwd,
          rollbackLastTurn: this.supportsRollbackLastTurn,
          replacementFence: this.supportsReplacementFence,
        },
        subagents: { observe: false, readTranscript: false },
      },
    };
  }

  async open(input: OpenSessionInput): Promise<HarnessResult<HarnessSession>> {
    if (this.#closePromise) return { ok: false, error: invalidStateError };
    if (input.cwd.length === 0) {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "Fake Adapter requires a non-empty cwd",
          retryable: false,
        },
      };
    }
    if (input.kind === "rollbackLastTurn" && !this.supportsRollbackLastTurn) {
      return {
        ok: false,
        error: {
          code: "unsupported",
          message: "Fake Adapter does not support last-Turn rollback",
          retryable: false,
        },
      };
    }
    if (input.kind === "create") {
      if (input.model && !catalogHasModel(this.catalog, input.model)) {
        return {
          ok: false,
          error: {
            code: "invalidRequest",
            message: "Fake Adapter create Model is not in the current catalog",
            retryable: false,
          },
        };
      }
      if (
        input.thinkingOptionId &&
        !catalogHasThinkingOption(this.catalog, input.thinkingOptionId)
      ) {
        return {
          ok: false,
          error: {
            code: "invalidRequest",
            message: "Fake Adapter create Thinking option is not in the current catalog",
            retryable: false,
          },
        };
      }
      if (
        input.permissionModeId &&
        !catalogHasPermissionMode(this.permissionModes, input.permissionModeId)
      ) {
        return {
          ok: false,
          error: {
            code: "invalidRequest",
            message: "Fake Adapter create Permission Mode is not in the current catalog",
            retryable: false,
          },
        };
      }
      return {
        ok: true,
        value: this.#createSession(
          input.cwd,
          input.model,
          [],
          input.thinkingOptionId,
          input.permissionModeId,
        ),
      };
    }
    const sourceRef = input.kind === "resume" ? input.nativeRef : input.sourceRef;
    if (sourceRef.harnessId !== this.harnessId) {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "Fake Native Session belongs to another Harness",
          retryable: false,
        },
      };
    }
    const source = this.#sessionsByNativeId.get(sourceRef.nativeSessionId);
    if (!source) {
      return {
        ok: false,
        error: {
          code: "sessionNotFound",
          message: "Fake Native Session was not found",
          retryable: false,
        },
      };
    }
    if (input.kind === "resume") {
      if (!source.closed) return { ok: true, value: source };
      return { ok: true, value: this.#resumeSession(input.cwd, input.nativeRef, source) };
    }
    if (input.kind === "rollbackLastTurn") {
      const current = await source.readSnapshot();
      if (!current.ok) return current;
      if (current.value.turns.length === 0) {
        return {
          ok: false,
          error: invalidState("Fake Native Session has no Turn to roll back"),
        };
      }
      return {
        ok: true,
        value: this.#createSession(
          input.cwd,
          source.state.effectiveModel,
          current.value.turns.slice(0, -1),
          source.state.effectiveThinkingOptionId,
          source.state.effectivePermissionModeId,
        ),
      };
    }
    const snapshot = source.persistedSnapshot();
    if (!this.supportsFork || (!this.supportsForkAcrossCwd && input.cwd !== source.cwd)) {
      return {
        ok: false,
        error: {
          code: "unsupported",
          message: "Fake Adapter does not support the requested Fork cwd",
          retryable: false,
        },
      };
    }
    if (
      input.checkpoint.harnessId !== this.harnessId ||
      input.checkpoint.nativeSessionId !== sourceRef.nativeSessionId
    ) {
      return {
        ok: false,
        error: {
          code: "checkpointNotFound",
          message: "Fake Checkpoint does not belong to the source Session",
          retryable: false,
        },
      };
    }
    const checkpointIndex = snapshot.turns.findIndex(
      (turn) => turn.checkpoint?.checkpointId === input.checkpoint.checkpointId,
    );
    if (checkpointIndex < 0) {
      return {
        ok: false,
        error: {
          code: "checkpointNotFound",
          message: "Fake Checkpoint was not found",
          retryable: false,
        },
      };
    }
    return {
      ok: true,
      value: this.#createSession(
        input.cwd,
        source.state.effectiveModel,
        snapshot.turns.slice(0, checkpointIndex + 1),
        source.state.effectiveThinkingOptionId,
        source.state.effectivePermissionModeId,
      ),
    };
  }

  #createSession(
    cwd: string,
    model: HarnessModelRef | undefined,
    sourceTurns: HostTurnSnapshot[] = [],
    thinkingOptionId?: HarnessThinkingOptionId,
    permissionModeId?: HarnessPermissionModeId,
  ): FakeHarnessSession {
    this.#sessionOrdinal += 1;
    const nativeRef: NativeSessionRef = {
      harnessId: this.harnessId,
      nativeSessionId: `fake-session-${this.#sessionOrdinal}`,
      formatVersion: 1,
    };
    const turns = sourceTurns.map((turn, index): HostTurnSnapshot => ({
      ...cloneJson(turn),
      items: turn.items.map((snapshot, itemIndex) => ({
        ...cloneJson(snapshot),
        item: {
          ...cloneJson(snapshot.item),
          itemId: hostItemIdSchema.parse(
            `fake-derived-item-${this.#sessionOrdinal}-${index + 1}-${itemIndex + 1}`,
          ),
        },
      })),
      nativeTurnRef: {
        ...turn.nativeTurnRef,
        nativeSessionId: nativeRef.nativeSessionId,
        nativeTurnKey: `fake-derived-turn-${index + 1}`,
      },
      ...(turn.checkpoint
        ? {
            checkpoint: {
              ...turn.checkpoint,
              nativeSessionId: nativeRef.nativeSessionId,
              checkpointId: `fake-checkpoint-${index + 1}`,
            },
          }
        : {}),
    }));
    const session = new FakeHarnessSession(
      this.harnessId,
      this.catalog,
      model,
      nativeRef,
      { turns },
      this.supportsFork,
      cwd,
      this.supportsForkAcrossCwd,
      thinkingOptionId,
      this.initialUsage,
      this.permissionModes,
      permissionModeId,
      this.supportsRollbackLastTurn,
      this.permissionModeScope,
      this.supportsReplacementFence,
    );
    this.sessions.push(session);
    this.#sessionsByNativeId.set(nativeRef.nativeSessionId, session);
    return session;
  }

  #resumeSession(
    cwd: string,
    nativeRef: NativeSessionRef,
    source: FakeHarnessSession,
  ): FakeHarnessSession {
    const state = source.state;
    const session = new FakeHarnessSession(
      this.harnessId,
      this.catalog,
      state.effectiveModel,
      cloneJson(nativeRef),
      source.persistedSnapshot(),
      this.supportsFork,
      cwd,
      this.supportsForkAcrossCwd,
      state.effectiveThinkingOptionId,
      this.initialUsage,
      this.permissionModes,
      state.effectivePermissionModeId,
      this.supportsRollbackLastTurn,
      this.permissionModeScope,
      this.supportsReplacementFence,
    );
    session.setStateForSnapshot({ ...cloneJson(state), nativeRef: cloneJson(nativeRef) });
    this.sessions.push(session);
    this.#sessionsByNativeId.set(nativeRef.nativeSessionId, session);
    return session;
  }

  close(): Promise<void> {
    if (!this.#closePromise) {
      this.#closePromise = Promise.all(this.sessions.map((session) => session.close())).then(
        () => undefined,
      );
    }
    return this.#closePromise;
  }
}
