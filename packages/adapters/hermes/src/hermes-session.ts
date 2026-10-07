import { randomUUID } from "node:crypto";
import { HermesQuestions } from "./hermes-questions.js";
import { HermesUsage } from "./hermes-usage.js";
import { HermesCompactionActivity } from "./hermes-compaction-activity.js";

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
  type HermesToolUpdate,
} from "./hermes-transport.js";
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
import {
  hermesCommandCatalog,
  hermesCommandText,
  isExcludedHermesCommand,
} from "./hermes-commands.js";

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

interface ApprovalWaiter {
  interaction: HostApprovalInteraction;
  turnId: ReturnType<typeof hostTurnIdSchema.parse>;
  resolve: (choice: string | null) => void;
}

class ActiveTurn {
  readonly turnId: ReturnType<typeof hostTurnIdSchema.parse>;
  readonly turnKey: string;
  readonly input: TurnStartCommand["input"];
  readonly persistsHistory: boolean;
  readonly compactionItem: HostContextCompactionItem | null;
  readonly compactionActivity = new HermesCompactionActivity();
  rememberActivity(snapshot: HostItemSnapshot): void {
    this.#finishedItems.push(snapshot);
    this.#emittedTerminalItemIds.add(snapshot.item.itemId);
  }
  nativeCompactionOutcome: HostItemOutcome | undefined;
  nativeTurnSnapshot: HostTurnSnapshot | undefined;
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

  rememberFileChanges(toolCallId: string, update: HermesToolUpdate): void {
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

  finish(finalAnswerText?: string): void {
    if (this.#currentText) {
      this.#finishedItems.push({
        item: this.#currentText.item,
        outcome: { status: "succeeded" },
      });
      this.#currentText = null;
    }
    // Terminal reasoning can follow the answer in the live stream. Use the
    // native final text to mark the matching pending message before completion.
    const final = this.#finishedItems.findLast(({ item }) => item.type === "agentMessage");
    if (
      final?.item.type === "agentMessage" &&
      finalAnswerText &&
      final.item.text === finalAnswerText &&
      final.item.phase === undefined &&
      !this.#emittedTerminalItemIds.has(final.item.itemId)
    ) {
      final.item = { ...final.item, phase: "final_answer" };
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
    const itemOutcome: HostItemOutcome =
      outcome.status !== "succeeded"
        ? outcome
        : (this.nativeCompactionOutcome ?? {
            status: "failed",
            error: harnessError(
              "protocolError",
              "Hermes Gateway did not return a compression outcome",
            ),
          });
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

export interface HermesSessionOptions {
  nativeRef: NativeSessionRef;
  transport: HermesSessionTransport;
  open: HermesOpenResult;
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
      fork: true,
      forkAcrossCwd: false,
      rollbackLastTurn: true,
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
  #usage: HermesUsage;
  #startingTurn = false;
  #questions = new HermesQuestions((output) => this.#channel.emit(output));
  #approvalWaiters = new Map<ReturnType<typeof hostInteractionIdSchema.parse>, ApprovalWaiter>();

  constructor(options: HermesSessionOptions) {
    this.#transport = options.transport;
    this.commands = {
      list: async () => {
        if (this.#closed || this.#faulted)
          return err("invalidState", "Hermes Session is unavailable");
        try {
          const commands =
            (await this.#transport.getCommands?.()) ?? this.#transport.availableCommands;
          if (this.#closed || this.#faulted)
            return err("invalidState", "Hermes Session is unavailable");
          return ok(hermesCommandCatalog(commands));
        } catch (error) {
          return err("nativeFailure", error instanceof Error ? error.message : String(error));
        }
      },
      execute: async (command) => {
        const catalog = await this.commands.list();
        if (!catalog.ok) return catalog;
        const text = hermesCommandText(command, catalog.value);
        if (!text.ok) return text;
        return this.#startTurn(
          {
            type: "turn.start",
            turnId: command.turnId,
            input: [{ type: "text", text: text.value }],
          },
          true,
        );
      },
    };
    this.#nativeRef = options.nativeRef;
    this.#onSettle = options.onSettle;
    const projected = projectHermesModelState(options.open.session.models);
    const modes = options.open.session.modes;
    // Re-project the confirmed Model selection against the native catalog.
    this.#availableModels = options.open.session.models?.availableModels ?? [];
    this.capabilities.configuration.selectThinkingOption = !!this.#transport.setThinking;
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
    this.initialUsage = null;
    this.outputs = this.#channel.outputs;
    this.#usage = new HermesUsage(
      this.#transport.readUsage?.bind(this.#transport),
      () => !this.#closed && !this.#faulted,
      (usage) =>
        this.#emit({
          type: "session.usage.changed",
          usage,
          ...(this.#activeTurn ? { observedForTurnId: this.#activeTurn.turnId } : {}),
        }),
    );
    this.#transport.onFault = (error) => this.#fault(transportErrorToHarness(error));
    this.#transport.onUsage = (usage) => this.#usage.observe(usage);
    void this.refreshUsage();
  }

  get busy(): boolean {
    return this.#activeTurn !== null || this.#startingTurn;
  }

  refreshUsage(): Promise<void> {
    return this.#usage.refresh();
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
      turns: [...this.#completedTurns],
      state: { ...this.#state },
    });
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
    if (this.#closed || this.#faulted) {
      return err(
        "invalidState",
        this.#closed ? "Hermes Session is closed" : "Hermes Session has faulted",
      );
    }
    switch (command.type) {
      case "turn.start":
        return this.#startTurn(command);
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
      waiter.resolve(null);
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

  async #startTurn(
    command: TurnStartCommand,
    requireNativeCommand = false,
  ): Promise<HarnessResult<TurnStartAccepted>> {
    if (this.busy) {
      return err("sessionBusy", "Hermes Session already has an active Turn", true);
    }
    const text = command.input.map((chunk) => chunk.text).join("\n");
    if (text.trim().length === 0) {
      return err("invalidRequest", "turn.start requires non-empty text input");
    }
    this.#startingTurn = true;
    try {
      if (text.trim().startsWith("/")) {
        const catalog = await this.commands.list();
        if (!catalog.ok) return catalog;
        const name = /^\/([\w-]+)(?:\s|$)/u.exec(text.trim())?.[1]?.toLowerCase();
        if ((name && isExcludedHermesCommand(name)) || this.#transport.rejectsCommand?.(text))
          return err(
            "unsupported",
            "This Hermes command or its arguments are not supported in a Host Thread",
          );
      }
      if (this.#closed || this.#faulted)
        return err("invalidState", "Hermes Session is unavailable");
      return this.#acceptTurn(command, text, requireNativeCommand);
    } finally {
      this.#startingTurn = false;
    }
  }

  #acceptTurn(
    command: TurnStartCommand,
    text: string,
    requireNativeCommand: boolean,
  ): HarnessResult<TurnStartAccepted> {
    const turnKey = randomUUID();
    const nativeCommand = this.#transport.nativeCommandName?.(text) ?? null;
    if (requireNativeCommand && !nativeCommand)
      return err("unsupported", "Hermes no longer advertises this command");
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
        const latest = (await this.#transport.readNativeSnapshot()).turns.at(-1);
        if (latest?.nativeTurnRef.nativeTurnKey !== previousNativeTurnKey)
          active.nativeTurnSnapshot = latest;
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
    const terminalUsage = promptResponse?.usage ?? null;
    const usage = terminalUsage ? this.#usage.merge(terminalUsage) : null;
    this.#completeActiveTurn(active, outcome, usage, promptResponse?.finalAnswerText);
  }

  #completeActiveTurn(
    active: ActiveTurn,
    outcome: TurnOutcome,
    usage: HostUsage | null = null,
    finalAnswerText?: string,
  ): void {
    if (this.#activeTurn !== active) return;
    this.#cancelApprovalWaiters();
    this.#activeTurn = null;
    this.#activeTurnId = null;
    this.#finishCompactionActivity(
      active,
      "当前 Turn 已结束；原生未确认自动压缩终态，提交结果未知。",
    );
    active.finish(outcome.status === "succeeded" ? finalAnswerText : undefined);
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
    void this.#usage.refresh(true);
  }

  #handleTransportEvent(active: ActiveTurn, event: HermesTransportEvent): void {
    if (this.#activeTurn !== active) return;
    switch (event.type) {
      case "usage":
        this.#usage.observe(event.usage);
        return;
      case "status.warning": {
        const notice = active.compactionActivity.appendNotice(event.text);
        if (notice)
          this.#emit({
            type: "item.updated",
            turnId: active.turnId,
            itemId: notice.itemId,
            update: { type: "text.append", text: notice.text },
          });
        return;
      }
      case "compaction.started": {
        if (active.compactionItem) return; // manual compression already owns its Item
        const item = active.compactionActivity.start(event.text);
        if (item) {
          this.#emit({ type: "item.started", turnId: active.turnId, item: { ...item, text: "" } });
          this.#emit({
            type: "item.updated",
            turnId: active.turnId,
            itemId: item.itemId,
            update: { type: "text.append", text: item.text },
          });
        }
        return;
      }
      case "compaction.finished": {
        if (this.#finishCompactionActivity(active, "原生自动压缩阶段已结束；未提供压缩提交结果。"))
          void this.#usage.refresh(true);
        return;
      }
      case "agent.thought":
        this.#appendTextItem(active, "reasoning", event.text);
        return;
      case "agent.text":
        this.#appendTextItem(active, "agentMessage", event.text);
        return;
      case "tool.call": {
        const update = event.update;
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
        this.#updateToolItem(active, event.update);
        return;
      default:
        return;
    }
  }

  #finishCompactionActivity(active: ActiveTurn, reason: string): boolean {
    const snapshot = active.compactionActivity.finish(reason);
    if (!snapshot) return false;
    active.rememberActivity(snapshot);
    this.#emit({
      type: "item.updated",
      turnId: active.turnId,
      itemId: snapshot.item.itemId,
      update: { type: "text.append", text: `\n${reason}` },
    });
    this.#emit({ type: "item.completed", turnId: active.turnId, snapshot });
    return true;
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

  #updateToolItem(active: ActiveTurn, update: HermesToolUpdate): void {
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
  ): Promise<string | null> {
    if (request.options.length === 0) {
      return Promise.resolve(null);
    }
    const interactionId = hostInteractionIdSchema.parse(randomUUID());
    const interaction: HostApprovalInteraction = {
      type: "approval",
      interactionId,
      turnId: active.turnId,
      title: request.title?.slice(0, 200) || "Hermes 请求批准",
      ...(request.description ? { description: request.description } : {}),
      subject: { type: "nativeAction" },
      actions: request.options,
    };
    this.#emitInteraction(interaction);
    let abort = () => {};
    const pending = new Promise<string | null>((resolve) => {
      this.#approvalWaiters.set(interactionId, {
        interaction,
        turnId: active.turnId,
        resolve,
      });
      abort = () => {
        if (!this.#approvalWaiters.delete(interactionId)) return;
        resolve(null);
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
    waiter.resolve(command.response.actionId);
    this.#emit({
      type: "interaction.closed",
      interactionId: command.interactionId,
      turnId: waiter.turnId,
      reason: "responded",
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
        waiter.resolve(null);
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
    void this.#usage.refresh(true);
    // After native confirmation, keep the catalog-aligned label when available.
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
