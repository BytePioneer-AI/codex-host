import { randomUUID as nodeRandomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  HarnessOutputChannel,
  validateHostInteractionResponse,
  type HarnessCommandAccepted,
  type HarnessCommandCapability,
  type HarnessCommandInvocation,
  type HarnessError,
  type HarnessOutput,
  type HarnessResult,
  type HarnessSession,
  type HarnessSessionCapabilities,
  type HarnessSessionState,
  type HostAgentMessageItem,
  type HostCommand,
  type HostCommandExecutionItem,
  type HostContextCompactionItem,
  type HostFileChangeItem,
  type HostItem,
  type HostItemOutcome,
  type HostInteraction,
  type HostReasoningItem,
  type HostTextInput,
  type HostThreadSnapshot,
  type HostToolExecutionItem,
  type HostUsage,
  type InteractionRespondAccepted,
  type InteractionRespondCommand,
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
  hostInteractionIdSchema,
  hostTurnIdSchema,
  type HarnessId,
  type HarnessModelRef,
  type HarnessPermissionModeCatalog,
  type HarnessThinkingOptionId,
  type HostInteractionId,
  type HostTurnId,
  type NativeSessionRef,
} from "@codexhost/shared-contracts";

import { deepSeekHarnessCommandCatalog, parseDeepSeekHarnessCommand } from "../harness-commands.js";
import { isRecord, parseArguments, projectToolResult, structuredDiffs } from "../projection.js";
import type { ModernModelCatalogSnapshot } from "./catalog.js";
import { executeModernCommand, ModernCommandError } from "./commands.js";
import {
  modernConfigurationHarnessError,
  modernSelectionForModel,
  ModernConfigurationError,
  readModernConfigurationSnapshot,
  selectModernModel,
  selectModernPermissionMode,
  MODERN_MODEL_SELECTION_PROJECTION_KEY,
  MODERN_PERMISSION_PROJECTION_KEY,
  type ModernConfigurationControl,
  type ModernConfigurationRemote,
} from "./configuration.js";
import {
  ModernControlStoreError,
  type ModernProjectionRow,
  type ModernProjectionSeed,
} from "./control-store.js";
import {
  ModernEventGatewayError,
  type ModernEventGateway,
  type ModernEventDelivery,
  type ModernEventSink,
  type ModernQuestionDelivery,
} from "./event-gateway.js";
import {
  MODERN_HISTORY_MAX_EVENTS,
  MODERN_TOOL_OUTPUT_LIMIT,
  ModernEventValidator,
  ModernHistoryError,
  modernCheckpointRef,
  modernItemId,
  modernNativeTurnRef,
  projectModernHistory,
} from "./history.js";
import {
  MODERN_JOURNAL_MAX_BUFFERED_LIVE_BYTES,
  MODERN_JOURNAL_MAX_HISTORY_BYTES,
  MODERN_JOURNAL_RECOVERY_OPEN_TIMEOUT_MS,
  ModernJournalError,
  openModernJournal,
  type ModernJournal,
  type ModernJournalEvent,
  type ModernJournalOptions,
  type ModernJournalRemote,
} from "./journal.js";
import { ModernRemoteConnectionError } from "./remote-connection.js";
import {
  redactModernCredential,
  sanitizeModernRemoteFailure,
  type ModernRemoteFailure,
} from "./wire.js";

const DEEPSEEK_HARNESS_ID = harnessIdSchema.parse("deepseek-harness");
export const MODERN_PROMPT_CORRELATION_GRACE_MS = 5_000;
export const MODERN_ACCEPTED_CORRELATION_TIMEOUT_MS = 300_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const DSH_COMPACT_BUSY =
  "Compaction is unavailable because this process has an active compaction, or the agent is not idle.";
const DSH_COMPACT_CANCELLED = "Compaction cancelled.";

export function modernSessionCapabilities(
  permissionModes: HarnessPermissionModeCatalog | null,
): HarnessSessionCapabilities {
  return {
    configuration: {
      selectModel: true,
      selectThinkingOption: true,
      selectPermissionMode: permissionModes !== null,
      permissionModeScope: "live",
    },
    history: { fork: true, forkAcrossCwd: false, rollbackLastTurn: false },
    autonomousTurns: { observe: true },
  };
}

const CORRELATION_BOUNDARIES = new Set([
  "request/header",
  "request/context",
  "assistant/chunk",
  "assistant/message",
  "tool/call",
  "tool/result",
  "step/end",
  "turn/end",
]);

interface PendingPrompt {
  readonly command: TurnStartCommand;
  readonly requestId: string;
  readonly abort: AbortController;
  admissionObserved: boolean;
  observed: boolean;
  admitted: boolean;
  terminal: boolean;
  publishScheduled: boolean;
  grace: PromptCorrelationGrace | undefined;
  correlationTimer: ReturnType<typeof setTimeout> | undefined;
  buffer?: NativeTurnBuffer;
}

type PromptGraceResolution =
  | { readonly kind: "accepted" }
  | { readonly kind: "closed" }
  | { readonly kind: "fault"; readonly error: HarnessError }
  | { readonly kind: "timeout"; readonly error: HarnessError };

interface PromptCorrelationGrace {
  readonly promise: Promise<PromptGraceResolution>;
  readonly resolve: (resolution: PromptGraceResolution) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
  settled: boolean;
}

interface NativeTurnBuffer {
  readonly nativeTurn: number;
  readonly events: ModernJournalEvent[];
  readonly input: HostTextInput[];
  readonly initialResume: boolean;
  pending?: PendingPrompt;
  active?: ActiveHostTurn;
  replayed: number;
  sawUserMessage: boolean;
  reachedCorrelationBoundary: boolean;
}

interface LiveTextItem<T extends HostAgentMessageItem | HostReasoningItem> {
  item: T;
  text: string;
}

interface LiveTool {
  item: HostToolExecutionItem;
  readonly toolName: string;
  readonly startedAtMs: number;
}

interface ActiveHostTurn {
  readonly turnId: HostTurnId;
  readonly nativeTurn: number;
  readonly input: HostTextInput[];
  readonly autonomous: boolean;
  agent?: LiveTextItem<HostAgentMessageItem>;
  reasoning?: LiveTextItem<HostReasoningItem>;
  readonly tools: Map<string, LiveTool>;
  readonly interactions: Set<HostInteractionId>;
  terminal: boolean;
  cancelAcknowledged: boolean;
  cancelPromise?: Promise<HarnessResult<TurnCancelAccepted>>;
}

interface ActiveInteraction {
  readonly delivery: ModernEventDelivery;
  readonly interaction: HostInteraction;
  responding: boolean;
}

interface ActiveCommand {
  readonly command: HarnessCommandInvocation;
  readonly line: string;
  readonly abort: AbortController;
  readonly item: HostContextCompactionItem | HostCommandExecutionItem;
  cancellationRequested: boolean;
}

interface CommandAdmission {
  readonly turnId: HostTurnId;
  readonly abort: AbortController;
  readonly configurationRevision: number;
  cancellationRequested: boolean;
}

export interface ModernHarnessSessionOptions {
  readonly remote: ModernJournalRemote & ModernConfigurationRemote;
  readonly journal: ModernJournal;
  readonly control: ModernSessionControl;
  readonly modelCatalog: ModernModelCatalogSnapshot;
  readonly permissionModes: HarnessPermissionModeCatalog | null;
  readonly eventGateway: ModernEventGateway;
  readonly sessionId: string;
  readonly harnessId?: HarnessId;
  readonly randomUUID?: () => string;
  readonly now?: () => number;
  readonly toolOutputLimit?: number;
  readonly maxEvents?: number;
  readonly maxHistoryBytes?: number;
  readonly maxBufferedLiveBytes?: number;
  readonly recoveryOpenTimeoutMs?: number;
  readonly promptCorrelationGraceMs?: number;
  readonly acceptedCorrelationTimeoutMs?: number;
  readonly onClosed?: () => void;
}

export interface ModernSessionControl extends ModernConfigurationControl {
  seed(sessionId: string, seed: ModernProjectionSeed): void;
  subscribe(
    sessionId: string,
    key: string,
    listener: (row: ModernProjectionRow | undefined) => void,
  ): () => void;
}

/** Directly constructible Modern Session core; Adapter lifecycle wiring stays outside this module. */
export class ModernHarnessSession implements HarnessSession, ModernEventSink {
  readonly harnessId: HarnessId;
  readonly capabilities: HarnessSessionCapabilities;
  readonly initialState: HarnessSessionState;
  readonly initialUsage: HostUsage | null;
  readonly outputs: AsyncIterable<HarnessOutput>;
  readonly commands: HarnessCommandCapability;

  readonly #remote: ModernJournalRemote & ModernConfigurationRemote;
  #journal: ModernJournal;
  readonly #control: ModernSessionControl;
  readonly #modelCatalog: ModernModelCatalogSnapshot;
  readonly #permissionModes: HarnessPermissionModeCatalog | null;
  readonly #detachEvents: () => Promise<void>;
  readonly #sessionId: string;
  readonly #nativeRef: NativeSessionRef;
  readonly #randomUUID: () => string;
  readonly #now: () => number;
  readonly #toolOutputLimit: number;
  readonly #maxEvents: number;
  readonly #maxHistoryBytes: number;
  readonly #maxBufferedLiveBytes: number;
  readonly #recoveryOpenTimeoutMs: number;
  readonly #promptCorrelationGraceMs: number;
  readonly #acceptedCorrelationTimeoutMs: number;
  readonly #onClosed: () => void;
  readonly #fallbackModel: HarnessModelRef;
  readonly #fallbackThinkingOptionId: HarnessThinkingOptionId | undefined;
  readonly #channel = new HarnessOutputChannel<HarnessOutput>();
  readonly #validator: ModernEventValidator;
  readonly #events: ModernJournalEvent[];
  readonly #journalLifetime = new AbortController();
  readonly #pendingByRequestId = new Map<string, PendingPrompt>();
  readonly #boundRequestIds = new Set<string>();
  readonly #operationControllers = new Set<AbortController>();
  readonly #removeControlSubscriptions: (() => void)[];
  readonly #acceptedTurnIds = new Set<HostTurnId>();
  readonly #interactions = new Map<HostInteractionId, ActiveInteraction>();
  readonly #interactionByEventId = new Map<string, HostInteractionId>();
  readonly #usedInteractionIds = new Set<HostInteractionId>();
  readonly #queuedDeliveries = new Map<string, ModernEventDelivery>();
  #buffer: NativeTurnBuffer | undefined;
  #active: ActiveHostTurn | undefined;
  #activeCommand: ActiveCommand | undefined;
  #commandAdmission: CommandAdmission | undefined;
  #configuring = false;
  #configurationDirty = false;
  #configurationRevision = 0;
  #reading = false;
  #state: HarnessSessionState;
  #usage: HostUsage | null;
  #historyBytes: number;
  #closed = false;
  #closedNotified = false;
  #faulted?: HarnessError;
  #closePromise?: Promise<void>;
  readonly #pumpPromise: Promise<void>;

  constructor(options: ModernHarnessSessionOptions) {
    if (!options.sessionId || options.sessionId.trim() === "") {
      throw new TypeError("sessionId must be a non-empty string");
    }
    if (options.journal.header.id !== options.sessionId) {
      throw new ModernHistoryError("protocolError", "Modern journal Session identity mismatch");
    }
    if (options.journal.cursor !== options.journal.events.length - 1) {
      throw new ModernHistoryError("protocolError", "Modern journal cursor does not match history");
    }
    this.harnessId = options.harnessId ?? DEEPSEEK_HARNESS_ID;
    this.#remote = options.remote;
    this.#journal = options.journal;
    this.#control = options.control;
    this.#modelCatalog = options.modelCatalog;
    this.#permissionModes = options.permissionModes;
    this.#sessionId = options.sessionId;
    this.#randomUUID = options.randomUUID ?? nodeRandomUUID;
    this.#now = options.now ?? Date.now;
    this.#toolOutputLimit = safeLimit(
      options.toolOutputLimit ?? MODERN_TOOL_OUTPUT_LIMIT,
      "toolOutputLimit",
      0,
    );
    this.#maxEvents = safeLimit(options.maxEvents ?? MODERN_HISTORY_MAX_EVENTS, "maxEvents", 1);
    this.#maxHistoryBytes = safeLimit(
      options.maxHistoryBytes ?? MODERN_JOURNAL_MAX_HISTORY_BYTES,
      "maxHistoryBytes",
      1,
    );
    this.#maxBufferedLiveBytes = safeLimit(
      options.maxBufferedLiveBytes ?? MODERN_JOURNAL_MAX_BUFFERED_LIVE_BYTES,
      "maxBufferedLiveBytes",
      1,
    );
    this.#recoveryOpenTimeoutMs = safeTimerDelay(
      options.recoveryOpenTimeoutMs ?? MODERN_JOURNAL_RECOVERY_OPEN_TIMEOUT_MS,
      "recoveryOpenTimeoutMs",
    );
    this.#promptCorrelationGraceMs = safeTimerDelay(
      options.promptCorrelationGraceMs ?? MODERN_PROMPT_CORRELATION_GRACE_MS,
      "promptCorrelationGraceMs",
    );
    this.#acceptedCorrelationTimeoutMs = safeTimerDelay(
      options.acceptedCorrelationTimeoutMs ?? MODERN_ACCEPTED_CORRELATION_TIMEOUT_MS,
      "acceptedCorrelationTimeoutMs",
    );
    this.#onClosed = options.onClosed ?? (() => undefined);
    this.#events = [...options.journal.events];
    this.#historyBytes = journalHistoryBytes(this.#events, this.#maxHistoryBytes);
    this.#validator = new ModernEventValidator(this.#maxEvents);
    for (const event of this.#events) this.#validator.accept(event);

    const projection = projectModernHistory({
      harnessId: this.harnessId,
      sessionId: this.#sessionId,
      events: this.#events,
      toolOutputLimit: this.#toolOutputLimit,
      maxEvents: this.#maxEvents,
    });
    const configuration = readModernConfigurationSnapshot({
      control: this.#control,
      sessionId: this.#sessionId,
      nativeRef: projection.nativeRef,
      modelCatalog: this.#modelCatalog,
      permissionModes: this.#permissionModes,
    });
    this.#nativeRef = projection.nativeRef;
    this.initialState = configuration.state;
    this.initialUsage = projection.usage;
    this.#state = this.initialState;
    this.#usage = this.initialUsage;
    this.#fallbackModel = configuration.state.effectiveModel as HarnessModelRef;
    this.#fallbackThinkingOptionId = configuration.state.effectiveThinkingOptionId;
    this.capabilities = modernSessionCapabilities(this.#permissionModes);
    this.outputs = this.#channel.outputs;
    this.commands = {
      list: () => this.#listHarnessCommands(),
      execute: (command) => this.#executeHarnessCommand(command),
    };
    let resumedAutonomousBuffer: NativeTurnBuffer | undefined;
    if (projection.incompleteTurn) {
      const buffer: NativeTurnBuffer = {
        nativeTurn: projection.incompleteTurn.turn,
        events: [...projection.incompleteTurn.events],
        input: [],
        initialResume: true,
        replayed: 0,
        sawUserMessage: false,
        reachedCorrelationBoundary: false,
      };
      for (const event of buffer.events) this.#observeBufferedCorrelation(buffer, event, false);
      this.#buffer = buffer;
      if (this.#resumeNeedsAutonomousTurn(buffer)) resumedAutonomousBuffer = buffer;
    }
    const removeControlSubscriptions: (() => void)[] = [];
    try {
      removeControlSubscriptions.push(
        this.#control.subscribe(this.#sessionId, MODERN_MODEL_SELECTION_PROJECTION_KEY, () =>
          this.#onConfigurationProjection(),
        ),
      );
      removeControlSubscriptions.push(
        this.#control.subscribe(this.#sessionId, MODERN_PERMISSION_PROJECTION_KEY, () =>
          this.#onConfigurationProjection(),
        ),
      );
      this.#detachEvents = options.eventGateway.attach(this.#sessionId, this);
    } catch (error) {
      for (const unsubscribe of removeControlSubscriptions.reverse()) unsubscribe();
      throw error;
    }
    this.#removeControlSubscriptions = removeControlSubscriptions;
    this.#pumpPromise = this.#pump();
    if (resumedAutonomousBuffer) {
      queueMicrotask(() => {
        if (!this.#closed && this.#buffer === resumedAutonomousBuffer) {
          this.#activateBufferedAutonomous(true);
        }
      });
    }
  }

  readSnapshot(): Promise<HarnessResult<HostThreadSnapshot>> {
    if (this.#closed) return Promise.resolve({ ok: false, error: closedError() });
    if (this.#reading) return Promise.resolve({ ok: false, error: busyError("read history") });
    this.#reading = true;
    try {
      const projection = this.#project();
      const configuration = this.#readConfiguration();
      return Promise.resolve({
        ok: true,
        value: { ...projection.snapshot, state: configuration.state },
      });
    } catch (error) {
      const failure = configurationOrProtocolError(
        error,
        "DeepSeek Harness history projection failed",
      );
      this.#fault(failure);
      return Promise.resolve({ ok: false, error: failure });
    } finally {
      this.#reading = false;
      this.#activateBufferedAutonomous();
    }
  }

  execute(command: TurnStartCommand): Promise<HarnessResult<TurnStartAccepted>>;
  execute(command: TurnCancelCommand): Promise<HarnessResult<TurnCancelAccepted>>;
  execute(command: InteractionRespondCommand): Promise<HarnessResult<InteractionRespondAccepted>>;
  execute(command: ModelSelectCommand): Promise<HarnessResult<ModelSelectCompleted>>;
  execute(command: ThinkingSelectCommand): Promise<HarnessResult<ThinkingSelectCompleted>>;
  execute(
    command: PermissionModeSelectCommand,
  ): Promise<HarnessResult<PermissionModeSelectCompleted>>;
  execute(
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
    if (this.#closed) return Promise.resolve({ ok: false, error: closedError() });
    switch (command.type) {
      case "turn.start":
        return this.#start(command);
      case "turn.cancel":
        return this.#cancel(command);
      case "interaction.respond":
        return this.#respond(command);
      case "model.select":
        return this.#selectModel(command);
      case "thinking.select":
        return this.#selectThinking(command);
      case "permissionMode.select":
        return this.#selectPermissionMode(command);
    }
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#performClose();
    return this.#closePromise;
  }

  /** Adapter-owned transport/control fault convergence. */
  fault(error: HarnessError): void {
    this.#fault(error);
  }

  onDelivery(delivery: ModernEventDelivery): void {
    if (delivery.sessionId !== this.#sessionId) {
      throw new ModernEventGatewayError(
        "protocolError",
        "DeepSeek Harness event delivery targeted the wrong Session",
      );
    }
    if (
      this.#queuedDeliveries.has(delivery.eventId) ||
      this.#interactionByEventId.has(delivery.eventId)
    ) {
      throw new ModernEventGatewayError(
        "protocolError",
        "DeepSeek Harness event delivery was duplicated",
      );
    }
    if (this.#closed) {
      this.#queuedDeliveries.set(delivery.eventId, delivery);
      return;
    }
    const active = this.#active;
    if (active && !active.terminal) {
      this.#publishInteraction(delivery, active);
      return;
    }
    this.#queuedDeliveries.set(delivery.eventId, delivery);
  }

  onCancel(eventId: string): void {
    if (this.#queuedDeliveries.delete(eventId)) return;
    const interactionId = this.#interactionByEventId.get(eventId);
    if (interactionId) this.#closeInteraction(interactionId, "cancelled");
  }

  async cancelNative(): Promise<void> {
    const active = this.#active;
    if (active?.cancelAcknowledged) return;
    const operation = active?.cancelPromise ?? this.#requestNativeCancel(active);
    if (active && !active.cancelPromise) active.cancelPromise = operation;
    await operation;
  }

  onFault(error: ModernEventGatewayError): void {
    this.#fault(eventGatewayHarnessError(error));
  }

  async #respond(
    command: InteractionRespondCommand,
  ): Promise<HarnessResult<InteractionRespondAccepted>> {
    const pending = this.#interactions.get(command.interactionId);
    const validationError = validateHostInteractionResponse(pending?.interaction, command.response);
    if (validationError) return { ok: false, error: validationError };
    if (
      pending?.delivery.type === "question" &&
      command.response.type === "question" &&
      !command.response.cancelled
    ) {
      const answerError = validateModernQuestionAnswer(pending.delivery, command.response.answers);
      if (answerError) return { ok: false, error: answerError };
    }
    if (!pending || pending.responding) {
      return {
        ok: false,
        error: invalidState("DeepSeek Harness Interaction response is already in progress"),
      };
    }
    pending.responding = true;
    try {
      if (pending.delivery.type === "approval") {
        if (command.response.type !== "approval") throw new Error("unreachable response type");
        await pending.delivery.respond(
          command.response.actionId === "allow-once" ? "allowed-once" : "rejected",
        );
      } else {
        if (command.response.type !== "question") throw new Error("unreachable response type");
        if (command.response.cancelled) await pending.delivery.reject();
        else
          await pending.delivery.respond(
            questionAnswer(pending.delivery, command.response.answers),
          );
      }
      if (this.#interactions.get(command.interactionId) !== pending || this.#closed) {
        return {
          ok: false,
          error: invalidState("DeepSeek Harness Interaction is no longer active"),
        };
      }
      this.#closeInteraction(
        command.interactionId,
        command.response.type === "question" && command.response.cancelled
          ? "cancelled"
          : "responded",
      );
      return { ok: true, value: { accepted: true } };
    } catch (error) {
      if (this.#faulted) return { ok: false, error: this.#faulted };
      if (this.#interactions.get(command.interactionId) !== pending || this.#closed) {
        return {
          ok: false,
          error: invalidState("DeepSeek Harness Interaction is no longer active"),
        };
      }
      pending.responding = false;
      const failure = eventGatewayHarnessError(error);
      if (eventGatewayFailureRequiresSessionFault(error)) this.#fault(failure);
      return { ok: false, error: failure };
    }
  }

  #publishInteraction(delivery: ModernEventDelivery, active: ActiveHostTurn): void {
    const interactionId = hostInteractionIdSchema.parse(this.#randomUUID());
    if (this.#usedInteractionIds.has(interactionId)) {
      throw new ModernEventGatewayError(
        "protocolError",
        "DeepSeek Harness Host interaction identity was duplicated",
      );
    }
    let interaction: HostInteraction;
    if (delivery.type === "approval") {
      interaction = {
        type: "approval",
        interactionId,
        turnId: active.turnId,
        title: delivery.request.reason ?? `Allow ${delivery.request.toolName}?`,
        description: delivery.request.callId
          ? `${delivery.request.toolName} (${delivery.request.callId})`
          : delivery.request.toolName,
        subject: { type: "nativeAction" },
        actions: [
          { id: "allow-once", label: "Allow once", effect: "allowOnce" },
          { id: "reject", label: "Reject", effect: "deny" },
        ],
      };
    } else {
      const first = delivery.request.questions[0];
      if (!first) {
        throw new ModernEventGatewayError(
          "protocolError",
          "DeepSeek Harness Question request is empty",
        );
      }
      interaction = {
        type: "question",
        interactionId,
        turnId: active.turnId,
        title: first.header ?? "DeepSeek Harness question",
        questions: delivery.request.questions.map((question) => {
          const prompt = question.detail
            ? `${question.question}\n\n${question.detail}`
            : question.question;
          return question.options && question.options.length > 0
            ? {
                id: question.id,
                type: "choice" as const,
                prompt,
                options: question.options.map((option) => ({
                  value: option.label,
                  label: option.label,
                  ...(option.description ? { description: option.description } : {}),
                })),
                multiple: question.multiSelect === true,
                allowOther: question.intent?.kind !== "plan-review",
                optional: false,
              }
            : {
                id: question.id,
                type: "text" as const,
                prompt,
                multiline: true,
                secret: false,
                optional: false,
              };
        }),
      };
    }
    this.#queuedDeliveries.delete(delivery.eventId);
    this.#usedInteractionIds.add(interactionId);
    this.#interactions.set(interactionId, { delivery, interaction, responding: false });
    this.#interactionByEventId.set(delivery.eventId, interactionId);
    active.interactions.add(interactionId);
    this.#channel.emit({ kind: "interaction", interaction });
  }

  #publishQueuedInteractions(active: ActiveHostTurn): void {
    for (const delivery of [...this.#queuedDeliveries.values()]) {
      this.#publishInteraction(delivery, active);
    }
  }

  #closeInteraction(interactionId: HostInteractionId, reason: "responded" | "cancelled"): void {
    const pending = this.#interactions.get(interactionId);
    if (!pending) return;
    this.#interactions.delete(interactionId);
    this.#interactionByEventId.delete(pending.delivery.eventId);
    this.#active?.interactions.delete(interactionId);
    this.#emit({
      type: "interaction.closed",
      interactionId,
      turnId: pending.interaction.turnId,
      reason,
    });
  }

  #closeActiveInteractions(active: ActiveHostTurn): void {
    for (const interactionId of [...active.interactions]) {
      const pending = this.#interactions.get(interactionId);
      if (pending) void settleCancelledInteraction(pending.delivery).catch(() => undefined);
      this.#closeInteraction(interactionId, "cancelled");
    }
  }

  #closeAllInteractions(): void {
    for (const interactionId of [...this.#interactions.keys()]) {
      this.#closeInteraction(interactionId, "cancelled");
    }
    this.#queuedDeliveries.clear();
  }

  #readConfiguration(): ReturnType<typeof readModernConfigurationSnapshot> {
    return readModernConfigurationSnapshot({
      control: this.#control,
      sessionId: this.#sessionId,
      nativeRef: this.#nativeRef,
      modelCatalog: this.#modelCatalog,
      permissionModes: this.#permissionModes,
    });
  }

  #onConfigurationProjection(): void {
    if (this.#closed) return;
    this.#configurationRevision += 1;
    if (this.#configuring) {
      this.#configurationDirty = true;
      return;
    }
    try {
      this.#publishConfiguration(false);
    } catch (error) {
      this.#fault(configurationOrProtocolError(error, "DeepSeek Harness configuration changed"));
    }
  }

  #publishConfiguration(force: boolean): void {
    const next = this.#readConfiguration().state;
    const changed = JSON.stringify(next) !== JSON.stringify(this.#state);
    this.#state = next;
    this.#configurationDirty = false;
    if (force || changed) this.#emit({ type: "session.state.changed", state: next });
  }

  #configurationBusy(area: string): HarnessError | undefined {
    if (
      this.#active ||
      this.#buffer ||
      this.#pendingByRequestId.size > 0 ||
      this.#activeCommand ||
      this.#commandAdmission ||
      this.#queuedDeliveries.size > 0 ||
      this.#configuring ||
      this.#reading
    ) {
      return busyError(`select ${area}`);
    }
    return undefined;
  }

  async #selectModel(command: ModelSelectCommand): Promise<HarnessResult<ModelSelectCompleted>> {
    const busy = this.#configurationBusy("a Model");
    if (busy) return { ok: false, error: busy };
    let requested;
    try {
      requested = modernSelectionForModel(this.#modelCatalog, command.model);
    } catch (error) {
      return { ok: false, error: configurationOrProtocolError(error, "Model selection failed") };
    }
    return this.#runConfiguration(async (signal) => {
      const selected = await selectModernModel(
        this.#remote,
        this.#control,
        this.#sessionId,
        this.#modelCatalog,
        requested,
        signal,
      );
      return { value: { completed: true } as const, changed: selected.changed };
    });
  }

  async #selectThinking(
    command: ThinkingSelectCommand,
  ): Promise<HarnessResult<ThinkingSelectCompleted>> {
    const busy = this.#configurationBusy("Thinking");
    if (busy) return { ok: false, error: busy };
    let requested;
    try {
      const current = this.#readConfiguration();
      requested = modernSelectionForModel(
        this.#modelCatalog,
        current.state.effectiveModel as HarnessModelRef,
        command.thinkingOptionId,
      );
    } catch (error) {
      return {
        ok: false,
        error: configurationOrProtocolError(error, "Thinking selection failed"),
      };
    }
    return this.#runConfiguration(async (signal) => {
      const selected = await selectModernModel(
        this.#remote,
        this.#control,
        this.#sessionId,
        this.#modelCatalog,
        requested,
        signal,
      );
      return { value: { completed: true } as const, changed: selected.changed };
    });
  }

  async #selectPermissionMode(
    command: PermissionModeSelectCommand,
  ): Promise<HarnessResult<PermissionModeSelectCompleted>> {
    if (!this.#permissionModes) {
      return { ok: false, error: unsupportedError(command.type) };
    }
    const busy = this.#configurationBusy("a Permission Mode");
    if (busy) return { ok: false, error: busy };
    return this.#runConfiguration(async (signal) => {
      const selected = await selectModernPermissionMode(
        this.#remote,
        this.#control,
        this.#sessionId,
        this.#permissionModes,
        command.permissionModeId,
        signal,
      );
      return { value: { completed: true } as const, changed: selected.changed };
    });
  }

  async #runConfiguration<T extends { readonly completed: true }>(
    operation: (signal: AbortSignal) => Promise<{ readonly value: T; readonly changed: boolean }>,
  ): Promise<HarnessResult<T>> {
    const abort = new AbortController();
    this.#configuring = true;
    this.#operationControllers.add(abort);
    try {
      const result = await operation(abort.signal);
      if (this.#closed) return { ok: false, error: closedError() };
      this.#publishConfiguration(true);
      return { ok: true, value: result.value };
    } catch (error) {
      if (this.#faulted) return { ok: false, error: this.#faulted };
      if (this.#closed) return { ok: false, error: closedError() };
      const failure = configurationOrProtocolError(error, "DeepSeek Harness configuration failed");
      if (configurationFailureRequiresSessionFault(error)) this.#fault(failure);
      return { ok: false, error: failure };
    } finally {
      this.#operationControllers.delete(abort);
      this.#configuring = false;
      if (!this.#closed && this.#configurationDirty) {
        try {
          this.#publishConfiguration(false);
        } catch (error) {
          this.#fault(
            configurationOrProtocolError(error, "DeepSeek Harness configuration changed"),
          );
        }
      }
      this.#activateBufferedAutonomous();
    }
  }

  async #start(command: TurnStartCommand): Promise<HarnessResult<TurnStartAccepted>> {
    if (
      !Array.isArray(command.input) ||
      command.input.length === 0 ||
      command.input.some((part) => part.type !== "text" || typeof part.text !== "string") ||
      !command.input.some(({ text }) => text.length > 0)
    ) {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "DeepSeek Harness Turn input must contain text",
          retryable: false,
        },
      };
    }
    if (
      this.#pendingByRequestId.size > 0 ||
      this.#buffer !== undefined ||
      this.#active !== undefined ||
      this.#activeCommand !== undefined ||
      this.#commandAdmission !== undefined ||
      this.#queuedDeliveries.size > 0 ||
      this.#configuring ||
      this.#reading ||
      this.#acceptedTurnIds.has(command.turnId)
    ) {
      return {
        ok: false,
        error: {
          code: "sessionBusy",
          message: "DeepSeek Harness Session already has a pending Host Turn",
          retryable: true,
        },
      };
    }

    const requestId = this.#randomUUID();
    if (
      !requestId ||
      this.#pendingByRequestId.has(requestId) ||
      this.#boundRequestIds.has(requestId)
    ) {
      return {
        ok: false,
        error: {
          code: "internalError",
          message: "DeepSeek Harness request identity generation failed",
          retryable: false,
        },
      };
    }
    const abort = new AbortController();
    const pending: PendingPrompt = {
      command,
      requestId,
      abort,
      admissionObserved: false,
      observed: false,
      admitted: false,
      terminal: false,
      publishScheduled: false,
      grace: undefined,
      correlationTimer: undefined,
    };
    this.#pendingByRequestId.set(requestId, pending);
    this.#operationControllers.add(abort);
    try {
      const response = await callAbortable(
        this.#remote.call<unknown>(
          "session/prompt",
          {
            request: {
              requestId,
              sessionId: this.#sessionId,
              mode: "queue",
              content: command.input.map(({ text }) => ({ type: "text", text })),
            },
          },
          abort.signal,
        ),
        abort.signal,
      );
      if (!response.ok) {
        if (pending.admissionObserved) {
          pending.admitted = true;
          this.#acceptedTurnIds.add(command.turnId);
          const error: HarnessError = {
            code: "protocolError",
            message: "DeepSeek Harness session/prompt rejected an already durable prompt requestId",
            retryable: false,
          };
          this.#fault(error);
          return { ok: false, error };
        }
        this.#rejectPending(pending);
        return { ok: false, error: remoteFailure("session/prompt", response.error) };
      }
      if (!acceptedValue(response.value)) {
        if (pending.admissionObserved) {
          pending.admitted = true;
          this.#acceptedTurnIds.add(command.turnId);
        } else this.#rejectPending(pending);
        const error: HarnessError = {
          code: "protocolError",
          message: "DeepSeek Harness session/prompt returned an invalid receipt",
          retryable: false,
        };
        this.#fault(error);
        return { ok: false, error };
      }
      return this.#acceptPrompt(pending);
    } catch (error) {
      if (this.#faulted) return { ok: false, error: this.#faulted };
      if (this.#closed) return { ok: false, error: closedError() };
      if (pending.admissionObserved) return this.#acceptPrompt(pending);

      // The Modern protocol has no requestId idempotency guarantee. Do not resend an uncertain prompt:
      // wait briefly for its durable requestId echo, then fail the Session closed.
      const resolution = await this.#beginPromptCorrelationGrace(
        pending,
        unavailableError(
          error,
          "session/prompt outcome remained uncertain after correlation grace",
          false,
        ),
      );
      if (resolution.kind === "accepted") {
        if (this.#faulted) return { ok: false, error: this.#faulted };
        if (this.#closed) return { ok: false, error: closedError() };
        return this.#acceptPrompt(pending);
      }
      if (resolution.kind === "closed") return { ok: false, error: closedError() };
      return { ok: false, error: resolution.error };
    } finally {
      this.#operationControllers.delete(abort);
    }
  }

  #acceptPrompt(pending: PendingPrompt): HarnessResult<TurnStartAccepted> {
    pending.admitted = true;
    this.#acceptedTurnIds.add(pending.command.turnId);
    this.#scheduleBoundTurn(pending);
    if (!pending.buffer && !pending.correlationTimer) {
      const timer = setTimeout(() => {
        if (pending.correlationTimer !== timer) return;
        pending.correlationTimer = undefined;
        this.#fault({
          code: "protocolError",
          message:
            "DeepSeek Harness accepted session/prompt but did not produce a correlatable durable user message within the correlation grace",
          retryable: false,
        });
      }, this.#acceptedCorrelationTimeoutMs);
      pending.correlationTimer = timer;
    }
    return { ok: true, value: { turnId: pending.command.turnId } };
  }

  #beginPromptCorrelationGrace(
    pending: PendingPrompt,
    timeoutFailure: HarnessError,
  ): Promise<PromptGraceResolution> {
    if (pending.grace) return pending.grace.promise;
    let resolve!: (resolution: PromptGraceResolution) => void;
    const promise = new Promise<PromptGraceResolution>((settle) => {
      resolve = settle;
    });
    const grace: PromptCorrelationGrace = {
      promise,
      resolve,
      timer: undefined,
      settled: false,
    };
    pending.grace = grace;
    grace.timer = setTimeout(() => {
      if (
        !this.#settlePromptCorrelationGrace(pending, {
          kind: "timeout",
          error: timeoutFailure,
        })
      ) {
        return;
      }
      this.#fault(timeoutFailure);
    }, this.#promptCorrelationGraceMs);
    return promise;
  }

  #settlePromptCorrelationGrace(
    pending: PendingPrompt,
    resolution: PromptGraceResolution,
  ): boolean {
    const grace = pending.grace;
    if (!grace || grace.settled) return false;
    grace.settled = true;
    if (grace.timer) clearTimeout(grace.timer);
    grace.timer = undefined;
    pending.grace = undefined;
    grace.resolve(resolution);
    return true;
  }

  async #listHarnessCommands(): Promise<
    HarnessResult<ReturnType<typeof deepSeekHarnessCommandCatalog>>
  > {
    if (this.#closed) return { ok: false, error: closedError() };
    return { ok: true, value: deepSeekHarnessCommandCatalog() };
  }

  async #executeHarnessCommand(
    command: HarnessCommandInvocation,
  ): Promise<HarnessResult<HarnessCommandAccepted>> {
    if (this.#closed) return { ok: false, error: closedError() };
    const parsed = parseDeepSeekHarnessCommand(command);
    if (!parsed.ok) return parsed;
    if (this.#hasCommandConflict() || this.#acceptedTurnIds.has(command.turnId)) {
      return { ok: false, error: busyError("execute a command") };
    }

    const admission: CommandAdmission = {
      turnId: command.turnId,
      abort: new AbortController(),
      configurationRevision: this.#configurationRevision,
      cancellationRequested: false,
    };
    this.#commandAdmission = admission;
    this.#operationControllers.add(admission.abort);
    try {
      const catalog = await this.#listHarnessCommands();
      if (!catalog.ok) return catalog;
      if (this.#closed) return { ok: false, error: closedError() };
      if (admission.cancellationRequested) {
        return { ok: false, error: invalidState("DeepSeek Harness command was cancelled") };
      }
      if (!catalog.value.commands.some(({ id }) => id === parsed.value.commandId)) {
        return {
          ok: false,
          error: {
            code: "unsupported",
            message: `DeepSeek Harness does not currently expose command '${command.commandId}'`,
            retryable: false,
          },
        };
      }
      if (
        this.#hasCommandConflict(true) ||
        this.#configurationRevision !== admission.configurationRevision
      ) {
        return { ok: false, error: busyError("execute a command") };
      }

      const itemId = modernItemId(this.#sessionId, `host-command:${command.turnId}`);
      const item: ActiveCommand["item"] =
        parsed.value.commandId === "dsh.compact"
          ? { type: "contextCompaction", itemId }
          : { type: "commandExecution", itemId, command: parsed.value.line };
      const active: ActiveCommand = {
        command,
        line: parsed.value.line,
        abort: new AbortController(),
        item,
        cancellationRequested: false,
      };
      this.#activeCommand = active;
      this.#acceptedTurnIds.add(command.turnId);
      this.#operationControllers.add(active.abort);
      this.#emit({ type: "turn.started", turnId: command.turnId });
      this.#emit({ type: "item.started", turnId: command.turnId, item });
      void this.#runHarnessCommand(active);
      return { ok: true, value: { turnId: command.turnId } };
    } finally {
      this.#operationControllers.delete(admission.abort);
      if (this.#commandAdmission === admission) this.#commandAdmission = undefined;
      this.#activateBufferedAutonomous();
    }
  }

  #hasCommandConflict(ignoreOwnOperation = false): boolean {
    return Boolean(
      this.#active ||
      this.#buffer ||
      this.#pendingByRequestId.size > 0 ||
      this.#activeCommand ||
      (!ignoreOwnOperation && this.#commandAdmission) ||
      this.#queuedDeliveries.size > 0 ||
      this.#configuring ||
      this.#reading,
    );
  }

  async #runHarnessCommand(active: ActiveCommand): Promise<void> {
    try {
      const execution = await executeModernCommand(
        this.#remote,
        this.#sessionId,
        active.line,
        active.abort.signal,
      );
      if (this.#activeCommand !== active) return;
      if (!execution) {
        this.#finishCommand(active, {
          status: "failed",
          error: {
            code: "nativeFailure",
            message: `DeepSeek Harness did not resolve registered command '${active.command.commandId}'`,
            retryable: false,
          },
        });
        return;
      }
      if (execution.result.kind === "success") {
        this.#finishCommand(active, { status: "succeeded" }, execution.result.text);
      } else if (
        active.cancellationRequested ||
        (active.command.commandId === "dsh.compact" &&
          execution.result.text === DSH_COMPACT_CANCELLED)
      ) {
        this.#finishCommand(
          active,
          { status: "cancelled", reason: execution.result.text },
          execution.result.text,
        );
      } else {
        this.#finishCommand(
          active,
          {
            status: "failed",
            error: {
              code:
                active.command.commandId === "dsh.compact" &&
                execution.result.text === DSH_COMPACT_BUSY
                  ? "sessionBusy"
                  : "nativeFailure",
              message: execution.result.text,
              retryable: true,
            },
          },
          execution.result.text,
        );
      }
    } catch (error) {
      if (this.#activeCommand !== active) return;
      if (active.cancellationRequested || active.abort.signal.aborted) {
        this.#finishCommand(active, {
          status: "cancelled",
          reason:
            active.command.commandId === "dsh.compact"
              ? "DeepSeek Harness context compaction was cancelled"
              : "DeepSeek Harness command was cancelled",
        });
      } else {
        const failure = commandHarnessError(error);
        if (commandFailureRequiresSessionFault(error)) this.#fault(failure);
        else this.#finishCommand(active, { status: "failed", error: failure });
      }
    } finally {
      this.#operationControllers.delete(active.abort);
    }
  }

  #finishCommand(active: ActiveCommand, outcome: HostItemOutcome, output?: string): void {
    if (this.#activeCommand !== active) return;
    this.#activeCommand = undefined;
    const item =
      active.item.type === "commandExecution" && output !== undefined
        ? { ...active.item, output }
        : active.item;
    this.#emit({
      type: "item.completed",
      turnId: active.command.turnId,
      snapshot: { item, outcome },
    });
    this.#emit({ type: "turn.completed", turnId: active.command.turnId, outcome });
    this.#activateBufferedAutonomous();
  }

  #cancel(command: TurnCancelCommand): Promise<HarnessResult<TurnCancelAccepted>> {
    const admission = this.#commandAdmission;
    if (admission?.turnId === command.turnId) {
      if (!admission.cancellationRequested) {
        admission.cancellationRequested = true;
        admission.abort.abort(new OperationAborted());
      }
      return Promise.resolve({ ok: true, value: { cancellationRequested: true } });
    }
    const activeCommand = this.#activeCommand;
    if (activeCommand?.command.turnId === command.turnId) {
      if (!activeCommand.cancellationRequested) {
        activeCommand.cancellationRequested = true;
        activeCommand.abort.abort(new OperationAborted());
      }
      return Promise.resolve({ ok: true, value: { cancellationRequested: true } });
    }
    const active = this.#active;
    if (!active || active.terminal || active.turnId !== command.turnId) {
      return Promise.resolve({
        ok: false,
        error: invalidState("DeepSeek Harness cancel requires the active Turn"),
      });
    }
    if (active.cancelAcknowledged) {
      return Promise.resolve({ ok: true, value: { cancellationRequested: true } });
    }
    if (active.cancelPromise) return active.cancelPromise;
    const operation = this.#requestNativeCancel(active);
    active.cancelPromise = operation;
    return operation;
  }

  #requestNativeCancel(
    active: ActiveHostTurn | undefined,
  ): Promise<HarnessResult<TurnCancelAccepted>> {
    const abort = new AbortController();
    this.#operationControllers.add(abort);
    const operation = (async (): Promise<HarnessResult<TurnCancelAccepted>> => {
      try {
        const response = await callAbortable(
          this.#remote.call<unknown>(
            "session/cancel",
            { request: { sessionId: this.#sessionId } },
            abort.signal,
          ),
          abort.signal,
        );
        if (!response.ok) {
          return { ok: false, error: remoteFailure("session/cancel", response.error) };
        }
        if (!acceptedValue(response.value)) {
          const error: HarnessError = {
            code: "protocolError",
            message: "DeepSeek Harness session/cancel returned an invalid receipt",
            retryable: false,
          };
          this.#fault(error);
          return { ok: false, error };
        }
        if (active) active.cancelAcknowledged = true;
        return { ok: true, value: { cancellationRequested: true } };
      } catch (error) {
        return {
          ok: false,
          error: this.#closed ? closedError() : unavailableError(error, "session/cancel failed"),
        };
      } finally {
        this.#operationControllers.delete(abort);
        if (active && !active.cancelAcknowledged) delete active.cancelPromise;
      }
    })();
    return operation;
  }

  async #pump(): Promise<void> {
    let replacementUsed = false;
    while (!this.#closed) {
      const journal = this.#journal;
      try {
        for await (const event of journal.live) {
          if (this.#closed) return;
          this.#appendJournalEvent(event);
        }
        if (this.#closed) return;
        throw new ModernJournalError("unavailable", "DeepSeek Harness journal ended unexpectedly");
      } catch (error) {
        if (this.#closed) return;
        if (!replacementUsed && isUnavailableJournalFailure(error)) {
          replacementUsed = true;
          try {
            await this.#replaceJournal(journal);
            continue;
          } catch (replacementError) {
            if (!this.#closed) this.#fault(journalFailure(replacementError));
            return;
          }
        }
        this.#fault(journalFailure(error));
        return;
      }
    }
  }

  #appendJournalEvent(event: ModernJournalEvent): void {
    const bytes = journalEventBytes(event);
    if (bytes > this.#maxHistoryBytes - this.#historyBytes) {
      throw new ModernJournalError(
        "limitExceeded",
        "DeepSeek Harness journal exceeded maxHistoryBytes",
      );
    }
    this.#validator.accept(event);
    this.#events.push(event);
    this.#historyBytes += bytes;
    this.#receive(event);
  }

  async #replaceJournal(previous: ModernJournal): Promise<void> {
    let replacement: ModernJournal | undefined;
    let adopted = false;
    try {
      const options: ModernJournalOptions = {
        maxEvents: this.#maxEvents,
        maxHistoryBytes: this.#maxHistoryBytes,
        maxBufferedLiveBytes: this.#maxBufferedLiveBytes,
        openingTimeoutMs: this.#recoveryOpenTimeoutMs,
        signal: this.#journalLifetime.signal,
      };
      replacement = await openModernJournal(
        this.#remote,
        {
          sessionId: this.#sessionId,
          ...(previous.header.cwd === undefined ? {} : { cwd: previous.header.cwd }),
        },
        options,
      );
      if (this.#closed) return;
      if (!isDeepStrictEqual(replacement.header, previous.header)) {
        throw new ModernJournalError(
          "protocolError",
          "DeepSeek Harness replacement journal changed immutable Session metadata",
        );
      }
      if (replacement.events.length < this.#events.length) {
        throw new ModernJournalError(
          "protocolError",
          "DeepSeek Harness replacement journal is behind the committed history",
        );
      }
      for (let index = 0; index < this.#events.length; index += 1) {
        if (!isDeepStrictEqual(replacement.events[index], this.#events[index])) {
          throw new ModernJournalError(
            "protocolError",
            "DeepSeek Harness replacement journal conflicts with committed history",
          );
        }
      }

      const validator = new ModernEventValidator(this.#maxEvents);
      for (const event of replacement.events) validator.accept(event);
      journalHistoryBytes(replacement.events, this.#maxHistoryBytes);
      const suffix = replacement.events.slice(this.#events.length);

      this.#journal = replacement;
      adopted = true;
      this.#control.seed(this.#sessionId, replacement.projections);
      if (this.#closed) return;
      for (const event of suffix) {
        if (this.#closed) return;
        this.#appendJournalEvent(event);
      }
    } finally {
      const closing: Promise<void>[] = [previous.close()];
      if (replacement && !adopted) closing.push(replacement.close());
      await Promise.allSettled(closing);
    }
  }

  #receive(event: ModernJournalEvent): void {
    this.#observePromptAdmission(event);
    if (event.type === "turn/start") {
      if (this.#buffer) throw new ModernHistoryError("protocolError", "Modern Turns overlap");
      const data = event.data as Record<string, unknown>;
      this.#buffer = {
        nativeTurn: data.turn as number,
        events: [event],
        input: [],
        initialResume: false,
        replayed: 0,
        sawUserMessage: false,
        reachedCorrelationBoundary: false,
      };
      return;
    }

    const buffer = this.#buffer;
    if (!buffer) return;
    buffer.events.push(event);
    this.#observeBufferedCorrelation(buffer, event, true);

    if (buffer.active) {
      this.#flush(buffer, false);
    } else if (buffer.pending?.admitted) {
      this.#scheduleBoundTurn(buffer.pending);
    } else if (
      !buffer.pending &&
      (buffer.reachedCorrelationBoundary || event.type === "turn/end") &&
      !this.#deferAutonomousTurn()
    ) {
      this.#materializeAutonomous(buffer, false);
    }
  }

  #observeBufferedCorrelation(
    buffer: NativeTurnBuffer,
    event: ModernJournalEvent,
    allowBinding: boolean,
  ): void {
    if (!isRecord(event.data)) return;
    if (event.type === "user/message" && event.surfaceOp === "append") {
      buffer.sawUserMessage = true;
      const source = isRecord(event.data.source) ? event.data.source : undefined;
      if (source?.kind === "user") {
        buffer.input.push(...textInputs(event.data.content));
        if (allowBinding && typeof source.rpcId === "string") {
          if (this.#boundRequestIds.has(source.rpcId)) {
            throw new ModernHistoryError(
              "protocolError",
              "Modern journal reused a bound prompt requestId",
            );
          }
          const pending = this.#pendingByRequestId.get(source.rpcId);
          if (pending) this.#bind(buffer, pending);
        }
      }
      return;
    }
    const replacementSurfaceBoundary =
      (event.type === "assistant/message" || event.type === "tool/result") &&
      event.surfaceOp !== "append";
    if (
      buffer.sawUserMessage &&
      CORRELATION_BOUNDARIES.has(event.type) &&
      !replacementSurfaceBoundary
    ) {
      buffer.reachedCorrelationBoundary = true;
    }
  }

  #bind(buffer: NativeTurnBuffer, pending: PendingPrompt): void {
    if (buffer.active) {
      throw new ModernHistoryError(
        "protocolError",
        "Modern prompt requestId appeared after Turn correlation was finalized",
      );
    }
    if (buffer.pending && buffer.pending !== pending) {
      throw new ModernHistoryError("protocolError", "Modern Turn matched multiple Host prompts");
    }
    if (pending.buffer && pending.buffer !== buffer) {
      throw new ModernHistoryError("protocolError", "Modern prompt matched multiple native Turns");
    }
    buffer.pending = pending;
    pending.buffer = buffer;
    pending.admissionObserved = true;
    pending.observed = true;
    this.#pendingByRequestId.delete(pending.requestId);
    this.#boundRequestIds.add(pending.requestId);
    this.#clearPromptCorrelationTimer(pending);
    this.#settlePromptCorrelationGrace(pending, { kind: "accepted" });
  }

  #observePromptAdmission(event: ModernJournalEvent): void {
    if (event.type !== "agent/inbox/spliced" || !isRecord(event.data)) return;
    const inserted = event.data.inserted;
    if (!Array.isArray(inserted)) return;
    for (const message of inserted) {
      if (!isRecord(message) || !isRecord(message.source) || message.source.kind !== "user") {
        continue;
      }
      const rpcId = message.source.rpcId;
      if (typeof rpcId !== "string") continue;
      const pending = this.#pendingByRequestId.get(rpcId);
      if (!pending) continue;
      pending.admissionObserved = true;
      if (!pending.admitted) {
        this.#settlePromptCorrelationGrace(pending, { kind: "accepted" });
      }
    }
  }

  #scheduleBoundTurn(pending: PendingPrompt): void {
    const buffer = pending.buffer;
    if (!buffer || !pending.admitted || pending.publishScheduled || buffer.active || this.#closed) {
      return;
    }
    pending.publishScheduled = true;
    // The second microtask puts output after the execute() promise reaction even when
    // durable events arrived before the unary receipt.
    queueMicrotask(() =>
      queueMicrotask(() => {
        pending.publishScheduled = false;
        if (
          !this.#closed &&
          pending.admitted &&
          pending.buffer === buffer &&
          this.#buffer === buffer &&
          !buffer.active
        ) {
          this.#materialize(buffer, pending.command.turnId, pending.command.input, false, false);
        }
      }),
    );
  }

  #rejectPending(pending: PendingPrompt): void {
    this.#clearPromptCorrelationTimer(pending);
    if (this.#pendingByRequestId.get(pending.requestId) === pending) {
      this.#pendingByRequestId.delete(pending.requestId);
    }
    const buffer = pending.buffer;
    if (buffer?.pending === pending) {
      delete buffer.pending;
      delete pending.buffer;
      if (buffer.reachedCorrelationBoundary || buffer.events.at(-1)?.type === "turn/end") {
        queueMicrotask(() => {
          if (!this.#closed && this.#buffer === buffer && !buffer.active && !buffer.pending) {
            this.#materializeAutonomous(buffer, false);
          }
        });
      }
    }
  }

  #resumeNeedsAutonomousTurn(buffer: NativeTurnBuffer): boolean {
    return buffer.sawUserMessage || buffer.events.some((event) => isVisibleWork(event));
  }

  #deferAutonomousTurn(): boolean {
    return Boolean(
      this.#active ||
      this.#activeCommand ||
      this.#commandAdmission ||
      this.#configuring ||
      this.#reading,
    );
  }

  #activateBufferedAutonomous(initialReplay = false): void {
    const buffer = this.#buffer;
    if (
      this.#closed ||
      !buffer ||
      buffer.active ||
      buffer.pending ||
      this.#deferAutonomousTurn() ||
      (!this.#resumeNeedsAutonomousTurn(buffer) &&
        !buffer.reachedCorrelationBoundary &&
        buffer.events.at(-1)?.type !== "turn/end")
    ) {
      return;
    }
    this.#materializeAutonomous(buffer, initialReplay || buffer.initialResume);
  }

  #materializeAutonomous(buffer: NativeTurnBuffer, initialReplay: boolean): void {
    const turnId = hostTurnIdSchema.parse(this.#randomUUID());
    this.#emit({
      type: "turn.autonomous.started",
      turnId,
      input: [...buffer.input],
    });
    this.#materialize(buffer, turnId, buffer.input, true, initialReplay);
  }

  #materialize(
    buffer: NativeTurnBuffer,
    turnId: HostTurnId,
    input: readonly HostTextInput[],
    autonomous: boolean,
    initialReplay: boolean,
  ): void {
    if (buffer.active || this.#active) {
      throw new ModernHistoryError("protocolError", "Modern Host Turns overlap");
    }
    const active: ActiveHostTurn = {
      turnId,
      nativeTurn: buffer.nativeTurn,
      input: [...input],
      autonomous,
      tools: new Map(),
      interactions: new Set(),
      terminal: false,
      cancelAcknowledged: false,
    };
    buffer.active = active;
    this.#active = active;
    this.#flush(buffer, initialReplay);
  }

  #flush(buffer: NativeTurnBuffer, initialReplay: boolean): void {
    while (!this.#closed && buffer.replayed < buffer.events.length) {
      const event = buffer.events[buffer.replayed] as ModernJournalEvent;
      buffer.replayed += 1;
      this.#projectLiveEvent(buffer, event, initialReplay);
    }
  }

  #projectLiveEvent(
    buffer: NativeTurnBuffer,
    event: ModernJournalEvent,
    initialReplay: boolean,
  ): void {
    const active = buffer.active;
    if (!active || !isRecord(event.data)) return;
    const data = event.data;
    switch (event.type) {
      case "turn/start":
        this.#emit({ type: "turn.started", turnId: active.turnId });
        this.#publishQueuedInteractions(active);
        return;
      case "request/header":
      case "request/context":
      case "model/selection":
        return;
      case "assistant/chunk":
        if (!isRecord(data.chunk)) return;
        if (data.chunk.type === "text-delta") {
          this.#appendAgent(active, data.chunk.text as string, data.step as number);
        } else if (data.chunk.type === "reasoning-delta") {
          // DSH may revise this provisional text in block-end; assistant/message is authoritative.
        } else if (data.chunk.type === "usage" && !initialReplay) {
          this.#publishUsageChanges(active.turnId);
        }
        return;
      case "assistant/message":
        if (event.surfaceOp === "append") this.#completeAssistant(active, data);
        if (event.surfaceOp === "append" && data.usage !== undefined && !initialReplay) {
          this.#publishUsageChanges(active.turnId);
        }
        return;
      case "tool/call":
        this.#startTool(active, data, event.seq);
        return;
      case "tool/result":
        if (event.surfaceOp === "append") this.#completeTool(active, data, event.seq);
        return;
      case "turn/end":
        this.#finishTurn(buffer, active, data.reason, event.seq);
        return;
      default:
        return;
    }
  }

  #appendAgent(active: ActiveHostTurn, text: string, step: number): void {
    if (!text) return;
    if (!active.agent) {
      const item: HostAgentMessageItem = {
        type: "agentMessage",
        itemId: modernItemId(this.#sessionId, `turn:${active.nativeTurn}:step:${step}:assistant`),
        text: "",
      };
      active.agent = { item, text: "" };
      this.#emit({ type: "item.started", turnId: active.turnId, item });
    }
    active.agent.text += text;
    active.agent.item = { ...active.agent.item, text: active.agent.text };
    this.#emit({
      type: "item.updated",
      turnId: active.turnId,
      itemId: active.agent.item.itemId,
      update: { type: "text.append", text },
    });
  }

  #startReasoning(active: ActiveHostTurn, step: number): LiveTextItem<HostReasoningItem> {
    if (!active.reasoning) {
      const item: HostReasoningItem = {
        type: "reasoning",
        itemId: modernItemId(this.#sessionId, `turn:${active.nativeTurn}:step:${step}:reasoning`),
        text: "",
      };
      active.reasoning = { item, text: "" };
      this.#emit({ type: "item.started", turnId: active.turnId, item });
    }
    return active.reasoning;
  }

  #appendReasoning(active: ActiveHostTurn, text: string, step: number): void {
    if (!text) return;
    const reasoning = this.#startReasoning(active, step);
    reasoning.text += text;
    reasoning.item = { ...reasoning.item, text: reasoning.text };
    this.#emit({
      type: "item.updated",
      turnId: active.turnId,
      itemId: reasoning.item.itemId,
      update: { type: "text.append", text },
    });
  }

  #completeAssistant(active: ActiveHostTurn, data: Record<string, unknown>): void {
    const message = data.message as Record<string, unknown>;
    const step = data.step as number;
    const reasoning = contentText(message.content, "reasoning");
    const text = contentText(message.content, "text");
    this.#assertAgentPrefix(active, text);
    this.#completeReasoning(active, reasoning, step);
    this.#completeAgentPrefix(active, text, step);
  }

  #assertAgentPrefix(active: ActiveHostTurn, finalText: string): void {
    const streamedText = active.agent?.text ?? "";
    if (streamedText && !finalText.startsWith(streamedText)) {
      throw new ModernHistoryError(
        "protocolError",
        "Modern assistant message does not match its streamed prefix",
      );
    }
  }

  #completeReasoning(active: ActiveHostTurn, finalText: string, step: number): void {
    if (finalText) this.#appendReasoning(active, finalText, step);
    const current = active.reasoning;
    if (!current) return;
    delete active.reasoning;
    this.#completeItem(active, current.item, { status: "succeeded" });
  }

  #completeAgentPrefix(active: ActiveHostTurn, finalText: string, step: number): void {
    let current = active.agent;
    if (!current && finalText) {
      this.#appendAgent(active, finalText, step);
      current = active.agent;
    } else if (current && finalText !== current.text) {
      if (!finalText.startsWith(current.text)) {
        throw new ModernHistoryError(
          "protocolError",
          "Modern assistant message does not match its streamed prefix",
        );
      }
      const suffix = finalText.slice(current.text.length);
      this.#appendAgent(active, suffix, step);
      current = active.agent;
    }
    if (!current) return;
    delete active.agent;
    this.#completeItem(active, current.item, { status: "succeeded" });
  }

  #startTool(active: ActiveHostTurn, data: Record<string, unknown>, seq: number): void {
    const callId = data.callId as string;
    if (active.tools.has(callId)) {
      throw new ModernHistoryError("protocolError", "Modern tool/call is duplicated");
    }
    const item: HostToolExecutionItem = {
      type: "toolExecution",
      itemId: modernItemId(this.#sessionId, `event:${seq}:tool`),
      toolName: data.name as string,
      arguments: parseArguments(data.arguments),
    };
    active.tools.set(callId, {
      item,
      toolName: item.toolName,
      startedAtMs: this.#now(),
    });
    this.#emit({ type: "item.started", turnId: active.turnId, item });
  }

  #completeTool(active: ActiveHostTurn, data: Record<string, unknown>, seq: number): void {
    const result = projectToolResult(data.message, this.#toolOutputLimit);
    if (!result) throw new ModernHistoryError("protocolError", "Modern tool/result is malformed");
    const tool = active.tools.get(result.callId);
    if (!tool) throw new ModernHistoryError("protocolError", "Modern tool/result is unmatched");
    active.tools.delete(result.callId);
    const item: HostToolExecutionItem = {
      ...tool.item,
      ...(result.output ? { output: result.output } : {}),
      durationMs: Math.max(0, this.#now() - tool.startedAtMs),
    };
    const failed = result.failed || data.error !== undefined;
    this.#completeItem(
      active,
      item,
      failed
        ? {
            status: "failed",
            error: {
              code: "nativeFailure",
              message: redactModernCredential(`DeepSeek Harness Tool '${tool.toolName}' failed`),
              retryable: false,
            },
          }
        : { status: "succeeded" },
    );
    if (!failed) {
      const changes = structuredDiffs(data.meta);
      if (changes) {
        const fileItem: HostFileChangeItem = {
          type: "fileChange",
          itemId: modernItemId(this.#sessionId, `event:${seq}:file-change`),
          changes,
        };
        this.#emit({ type: "item.started", turnId: active.turnId, item: fileItem });
        this.#completeItem(active, fileItem, { status: "succeeded" });
      }
    }
  }

  #finishTurn(
    buffer: NativeTurnBuffer,
    active: ActiveHostTurn,
    reason: unknown,
    seq: number,
  ): void {
    if (active.terminal) return;
    const projected = turnOutcome(reason);
    const itemOutcome = toItemOutcome(projected);
    this.#closeActiveInteractions(active);
    this.#completeOpenItems(active, itemOutcome);
    active.terminal = true;
    if (buffer.pending) buffer.pending.terminal = true;
    const checkpoint = modernCheckpointRef(this.harnessId, this.#sessionId, seq);
    this.#emit({
      type: "turn.completed",
      turnId: active.turnId,
      nativeTurnRef: modernNativeTurnRef(this.harnessId, this.#sessionId, active.nativeTurn),
      outcome: { ...projected, checkpoint },
    });
    if (this.#active === active) this.#active = undefined;
    if (this.#buffer === buffer) this.#buffer = undefined;
  }

  #completeOpenItems(active: ActiveHostTurn, outcome: HostItemOutcome): void {
    if (active.reasoning) {
      const item = active.reasoning.item;
      delete active.reasoning;
      this.#completeItem(active, item, outcome);
    }
    if (active.agent) {
      const item = active.agent.item;
      delete active.agent;
      this.#completeItem(active, item, outcome);
    }
    for (const tool of active.tools.values()) this.#completeItem(active, tool.item, outcome);
    active.tools.clear();
  }

  #completeItem(active: ActiveHostTurn, item: HostItem, outcome: HostItemOutcome): void {
    this.#emit({
      type: "item.completed",
      turnId: active.turnId,
      snapshot: { item, outcome },
    });
  }

  #publishUsageChanges(observedForTurnId?: HostTurnId): void {
    const projection = this.#project();
    if (JSON.stringify(projection.usage) !== JSON.stringify(this.#usage)) {
      this.#usage = projection.usage;
      this.#emit({
        type: "session.usage.changed",
        usage: projection.usage,
        ...(observedForTurnId ? { observedForTurnId } : {}),
      });
    }
  }

  #project(): ReturnType<typeof projectModernHistory> {
    return projectModernHistory({
      harnessId: this.harnessId,
      sessionId: this.#sessionId,
      events: this.#events,
      ...(this.#fallbackModel ? { fallbackModel: this.#fallbackModel } : {}),
      ...(this.#fallbackThinkingOptionId
        ? { fallbackThinkingOptionId: this.#fallbackThinkingOptionId }
        : {}),
      toolOutputLimit: this.#toolOutputLimit,
      maxEvents: this.#maxEvents,
    });
  }

  #fault(error: HarnessError): void {
    if (this.#closed) return;
    const failure = sanitizedHarnessError(error);
    const acceptedPending = this.#acceptedPending();
    this.#faulted = failure;
    this.#closed = true;
    this.#journalLifetime.abort(new Error("DeepSeek Harness Session faulted"));
    this.#unsubscribeControl();
    const admission = this.#commandAdmission;
    if (admission) {
      admission.cancellationRequested = true;
      admission.abort.abort(new OperationAborted());
      this.#commandAdmission = undefined;
    }
    const activeCommand = this.#activeCommand;
    if (activeCommand) {
      activeCommand.cancellationRequested = true;
      activeCommand.abort.abort(new OperationAborted());
      this.#finishCommand(activeCommand, { status: "failed", error: failure });
    }
    this.#settleAllPromptCorrelationGraces({ kind: "fault", error: failure });
    this.#abortOperations();
    this.#closePromise ??= this.#performFault(failure, acceptedPending);
  }

  async #performFault(failure: HarnessError, acceptedPending: PendingPrompt[]): Promise<void> {
    await this.#detachEvents().catch(() => undefined);
    this.#closeAllInteractions();
    let active = this.#active;
    const buffer = this.#buffer;
    if (!active && buffer) {
      const pending = buffer.pending;
      const hostBound =
        pending !== undefined &&
        (pending.admissionObserved || pending.observed || pending.admitted);
      const turnId = hostBound
        ? pending.command.turnId
        : hostTurnIdSchema.parse(this.#randomUUID());
      if (!hostBound) {
        this.#emit({
          type: "turn.autonomous.started",
          turnId,
          input: [...buffer.input],
        });
      }
      active = {
        turnId,
        nativeTurn: buffer.nativeTurn,
        input: hostBound ? [...pending.command.input] : [...buffer.input],
        autonomous: !hostBound,
        tools: new Map(),
        interactions: new Set(),
        terminal: false,
        cancelAcknowledged: false,
      };
      buffer.active = active;
      this.#active = active;
      this.#emit({ type: "turn.started", turnId });
    }
    if (active && !active.terminal) {
      this.#completeOpenItems(active, { status: "failed", error: failure });
      active.terminal = true;
      if (buffer?.pending?.command.turnId === active.turnId) buffer.pending.terminal = true;
      this.#emit({
        type: "turn.completed",
        turnId: active.turnId,
        nativeTurnRef: modernNativeTurnRef(this.harnessId, this.#sessionId, active.nativeTurn),
        outcome: { status: "failed", error: failure },
      });
    }
    for (const pending of acceptedPending) {
      this.#settlePending(pending, { status: "failed", error: failure });
    }
    this.#active = undefined;
    this.#buffer = undefined;
    this.#emit({ type: "session.faulted", error: failure });
    this.#channel.end();
    await Promise.allSettled([this.#journal.close(), this.#pumpPromise]);
    this.#notifyClosed();
  }

  async #performClose(): Promise<void> {
    if (!this.#closed) {
      const acceptedPending = this.#acceptedPending();
      this.#closed = true;
      this.#journalLifetime.abort(new Error("DeepSeek Harness Session closed"));
      this.#unsubscribeControl();
      const admission = this.#commandAdmission;
      if (admission) {
        admission.cancellationRequested = true;
        admission.abort.abort(new OperationAborted());
        this.#commandAdmission = undefined;
      }
      const activeCommand = this.#activeCommand;
      if (activeCommand) {
        activeCommand.cancellationRequested = true;
        activeCommand.abort.abort(new OperationAborted());
        this.#finishCommand(activeCommand, {
          status: "cancelled",
          reason: "DeepSeek Harness command was cancelled because the Session closed",
        });
      }
      this.#settleAllPromptCorrelationGraces({ kind: "closed" });
      this.#abortOperations();
      await this.#detachEvents().catch(() => undefined);
      this.#closeAllInteractions();
      const active = this.#active;
      if (active && !active.terminal) {
        const outcome: HostItemOutcome = {
          status: "cancelled",
          reason: "DeepSeek Harness Session closed",
        };
        this.#completeOpenItems(active, outcome);
        active.terminal = true;
        if (this.#buffer?.pending?.command.turnId === active.turnId) {
          this.#buffer.pending.terminal = true;
        }
        this.#emit({
          type: "turn.completed",
          turnId: active.turnId,
          nativeTurnRef: modernNativeTurnRef(this.harnessId, this.#sessionId, active.nativeTurn),
          outcome,
        });
      }
      for (const pending of acceptedPending) {
        this.#settlePending(pending, {
          status: "cancelled",
          reason: "DeepSeek Harness Session closed",
        });
      }
      this.#active = undefined;
      this.#buffer = undefined;
      this.#channel.end();
    }
    await Promise.allSettled([this.#journal.close(), this.#pumpPromise]);
    this.#notifyClosed();
  }

  #abortOperations(): void {
    for (const controller of this.#operationControllers) {
      controller.abort(new OperationAborted());
    }
    this.#operationControllers.clear();
    this.#pendingByRequestId.clear();
  }

  #unsubscribeControl(): void {
    for (const unsubscribe of this.#removeControlSubscriptions.splice(0)) unsubscribe();
  }

  #acceptedPending(): PendingPrompt[] {
    const values = new Set(this.#pendingByRequestId.values());
    if (this.#buffer?.pending) values.add(this.#buffer.pending);
    return [...values].filter(
      (pending) =>
        (pending.admitted || pending.admissionObserved || pending.observed) && !pending.terminal,
    );
  }

  #settleAllPromptCorrelationGraces(resolution: PromptGraceResolution): void {
    const values = new Set(this.#pendingByRequestId.values());
    if (this.#buffer?.pending) values.add(this.#buffer.pending);
    for (const pending of values) {
      this.#clearPromptCorrelationTimer(pending);
      this.#settlePromptCorrelationGrace(pending, resolution);
    }
  }

  #settlePending(pending: PendingPrompt, outcome: TurnOutcome): void {
    if (pending.terminal) return;
    this.#clearPromptCorrelationTimer(pending);
    pending.terminal = true;
    this.#emit({
      type: "turn.completed",
      turnId: pending.command.turnId,
      outcome,
    });
  }

  #clearPromptCorrelationTimer(pending: PendingPrompt): void {
    if (pending.correlationTimer) clearTimeout(pending.correlationTimer);
    pending.correlationTimer = undefined;
  }

  #notifyClosed(): void {
    if (this.#closedNotified) return;
    this.#closedNotified = true;
    try {
      this.#onClosed();
    } catch {
      // Adapter bookkeeping cannot break Session terminal convergence.
    }
  }

  #emit(event: Extract<HarnessOutput, { kind: "event" }>["event"]): void {
    this.#channel.emit({ kind: "event", event });
  }
}

class OperationAborted extends Error {
  constructor() {
    super("Modern Session operation aborted");
    this.name = "OperationAborted";
  }
}

async function callAbortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new OperationAborted();
  let rejectAbort: ((reason: OperationAborted) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = (): void => rejectAbort?.(new OperationAborted());
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function acceptedValue(value: unknown): boolean {
  return isRecord(value) && Reflect.ownKeys(value).length === 1 && value.accepted === true;
}

function remoteFailure(endpoint: string, failure: ModernRemoteFailure): HarnessError {
  const safe = sanitizeModernRemoteFailure(failure);
  return nativeFailure(safe.code, `DeepSeek Harness ${endpoint} failed: ${safe.message}`);
}

function nativeFailure(nativeCode: string, message: string): HarnessError {
  const code =
    nativeCode === "session/not-found"
      ? "sessionNotFound"
      : nativeCode === "session/agent-busy"
        ? "sessionBusy"
        : nativeCode.includes("auth")
          ? "authenticationRequired"
          : "nativeFailure";
  return {
    code,
    message: redactModernCredential(message),
    retryable: code === "sessionBusy",
    diagnostic: redactModernCredential(nativeCode),
  };
}

function journalFailure(error: unknown): HarnessError {
  if (error instanceof ModernRemoteConnectionError) {
    const code = error.code === "cancelled" ? "unavailable" : error.code;
    return sanitizedHarnessError({
      code,
      message: error.message,
      retryable: code === "unavailable" || code === "processExited",
      diagnostic: error.nativeCode ?? error.code,
    });
  }
  if (error instanceof ModernJournalError) {
    if (error.code === "remoteError" && error.nativeCode) {
      return nativeFailure(error.nativeCode, error.message);
    }
    const code =
      error.code === "authenticationRequired" ||
      error.code === "notInstalled" ||
      error.code === "processExited"
        ? error.code
        : error.code === "protocolError" || error.code === "limitExceeded"
          ? "protocolError"
          : error.code === "remoteError"
            ? "nativeFailure"
            : "unavailable";
    return sanitizedHarnessError({
      code,
      message: error.message,
      retryable: code === "unavailable" || code === "processExited",
      diagnostic: error.code,
    });
  }
  return protocolError(error, "DeepSeek Harness journal failed");
}

function isUnavailableJournalFailure(error: unknown): boolean {
  return error instanceof ModernJournalError && error.code === "unavailable";
}

function journalHistoryBytes(events: readonly ModernJournalEvent[], maximum: number): number {
  let bytes = 0;
  for (const event of events) {
    const eventBytes = journalEventBytes(event);
    if (eventBytes > maximum - bytes) {
      throw new ModernJournalError(
        "limitExceeded",
        "DeepSeek Harness journal exceeded maxHistoryBytes",
      );
    }
    bytes += eventBytes;
  }
  return bytes;
}

function journalEventBytes(event: ModernJournalEvent): number {
  return Buffer.byteLength(JSON.stringify(event), "utf8");
}

function unavailableError(error: unknown, message: string, retryable = true): HarnessError {
  const detail = error instanceof Error ? error.message : String(error);
  return {
    code: "unavailable",
    message: redactModernCredential(`${message}: ${detail}`),
    retryable,
  };
}

function protocolError(error: unknown, message: string): HarnessError {
  if (error instanceof ModernHistoryError) {
    return {
      code: "protocolError",
      message: redactModernCredential(error.message),
      retryable: false,
    };
  }
  return {
    code: "protocolError",
    message: redactModernCredential(
      `${message}: ${error instanceof Error ? error.message : String(error)}`,
    ),
    retryable: false,
  };
}

function sanitizedHarnessError(error: HarnessError): HarnessError {
  return {
    ...error,
    message: redactModernCredential(error.message),
    ...(error.diagnostic ? { diagnostic: redactModernCredential(error.diagnostic) } : {}),
    ...(error.stderrTail ? { stderrTail: redactModernCredential(error.stderrTail) } : {}),
  };
}

function closedError(): HarnessError {
  return {
    code: "invalidState",
    message: "DeepSeek Harness Session is closed",
    retryable: false,
  };
}

function invalidState(message: string): HarnessError {
  return { code: "invalidState", message, retryable: false };
}

function busyError(operation: string): HarnessError {
  return {
    code: "sessionBusy",
    message: `DeepSeek Harness Session cannot ${operation} while another operation is active`,
    retryable: true,
  };
}

function configurationOrProtocolError(error: unknown, message: string): HarnessError {
  if (error instanceof ModernConfigurationError) {
    return sanitizedHarnessError(modernConfigurationHarnessError(error));
  }
  if (error instanceof ModernControlStoreError) {
    const code =
      error.code === "protocolError" || error.code === "resourceLimit"
        ? "protocolError"
        : error.code === "closed" || error.code === "detached"
          ? "invalidState"
          : "unavailable";
    return sanitizedHarnessError({
      code,
      message: error.message,
      retryable: code === "unavailable",
      diagnostic: error.code,
    });
  }
  return protocolError(error, message);
}

function configurationFailureRequiresSessionFault(error: unknown): boolean {
  if (error instanceof ModernConfigurationError) {
    return ![
      "invalidRequest",
      "remoteError",
      "unsupported",
      "authenticationRequired",
      "notInstalled",
      "cancelled",
    ].includes(error.code);
  }
  return !(error instanceof ModernControlStoreError && error.code === "cancelled");
}

function commandHarnessError(error: unknown): HarnessError {
  if (!(error instanceof ModernCommandError)) {
    return {
      code: "unavailable",
      message: "DeepSeek Harness command request failed",
      retryable: true,
    };
  }
  if (error.code === "remoteError" && error.nativeCode) {
    return nativeFailure(error.nativeCode, error.message);
  }
  const code =
    error.code === "authenticationRequired" ||
    error.code === "notInstalled" ||
    error.code === "processExited" ||
    error.code === "protocolError" ||
    error.code === "unavailable"
      ? error.code
      : error.code === "limitExceeded"
        ? "protocolError"
        : error.code === "cancelled"
          ? "unavailable"
          : "nativeFailure";
  return sanitizedHarnessError({
    code,
    message: error.message,
    retryable: code === "unavailable" || code === "processExited",
    ...(error.nativeCode ? { diagnostic: error.nativeCode } : {}),
  });
}

function commandFailureRequiresSessionFault(error: unknown): boolean {
  return (
    error instanceof ModernCommandError &&
    ["limitExceeded", "processExited", "protocolError", "unavailable"].includes(error.code)
  );
}

function eventGatewayHarnessError(error: unknown): HarnessError {
  if (error instanceof TypeError) {
    return {
      code: "invalidRequest",
      message: redactModernCredential(error.message),
      retryable: false,
    };
  }
  if (!(error instanceof ModernEventGatewayError)) {
    return unavailableError(error, "DeepSeek Harness Interaction failed");
  }
  const code =
    error.code === "closed"
      ? "invalidState"
      : error.code === "protocolError" || error.code === "resourceLimit"
        ? "protocolError"
        : error.code === "remoteError"
          ? "nativeFailure"
          : "unavailable";
  return sanitizedHarnessError({
    code,
    message: error.message,
    retryable: code === "unavailable",
    ...(error.nativeCode ? { diagnostic: error.nativeCode } : {}),
  });
}

function eventGatewayFailureRequiresSessionFault(error: unknown): boolean {
  return (
    error instanceof ModernEventGatewayError &&
    ["protocolError", "resourceLimit"].includes(error.code)
  );
}

function questionAnswer(
  delivery: ModernQuestionDelivery,
  answers: Readonly<Record<string, string[]>>,
): {
  readonly answers: readonly {
    readonly id: string;
    readonly selected: readonly string[];
    readonly custom?: string;
  }[];
} {
  return {
    answers: delivery.request.questions.map((question) => {
      const values = answers[question.id] ?? [];
      const labels = new Set(question.options?.map((option) => option.label) ?? []);
      const selected = values.filter((value) => labels.has(value));
      const custom = values.find((value) => !labels.has(value));
      return { id: question.id, selected, ...(custom === undefined ? {} : { custom }) };
    }),
  };
}

function settleCancelledInteraction(delivery: ModernEventDelivery): Promise<void> {
  return delivery.type === "approval" ? delivery.respond("cancelled") : delivery.reject();
}

function validateModernQuestionAnswer(
  delivery: ModernQuestionDelivery,
  answers: Readonly<Record<string, string[]>>,
): HarnessError | undefined {
  for (const question of delivery.request.questions) {
    if (!question.options) continue;
    const labels = new Set(question.options.map(({ label }) => label));
    const customCount = (answers[question.id] ?? []).filter((value) => !labels.has(value)).length;
    if (customCount > 1) {
      return {
        code: "invalidRequest",
        message: "Question Response contains more than one custom answer",
        retryable: false,
      };
    }
  }
  return undefined;
}

function unsupportedError(command: HostCommand["type"]): HarnessError {
  return {
    code: "unsupported",
    message: `DeepSeek Harness Modern protocol does not yet support '${command}'`,
    retryable: false,
  };
}

function turnOutcome(reason: unknown): TurnOutcome {
  if (!isRecord(reason) || typeof reason.kind !== "string") {
    return {
      status: "failed",
      error: {
        code: "protocolError",
        message: "DeepSeek Harness returned an invalid Turn outcome",
        retryable: false,
      },
    };
  }
  if (reason.kind === "completed" || reason.kind === "max-tokens") return { status: "succeeded" };
  if (reason.kind === "aborted") {
    return { status: "cancelled", reason: "Cancelled by user" };
  }
  return {
    status: "failed",
    error: {
      code: "nativeFailure",
      message: redactModernCredential(
        reason.kind === "error" &&
          isRecord(reason.error) &&
          typeof reason.error.message === "string"
          ? reason.error.message
          : `DeepSeek Harness Turn ended with '${reason.kind}'`,
      ),
      retryable: false,
    },
  };
}

function toItemOutcome(outcome: TurnOutcome): HostItemOutcome {
  if (outcome.status === "succeeded") return { status: "succeeded" };
  if (outcome.status === "cancelled") {
    return { status: "cancelled", ...(outcome.reason ? { reason: outcome.reason } : {}) };
  }
  return { status: "failed", error: outcome.error };
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

function contentText(value: unknown, type: "text" | "reasoning"): string {
  return Array.isArray(value)
    ? value
        .filter((block) => isRecord(block) && block.type === type && typeof block.text === "string")
        .map((block) => (block as { text: string }).text)
        .join("")
    : "";
}

function isVisibleWork(event: ModernJournalEvent): boolean {
  if (event.type === "assistant/message" || event.type === "tool/result") {
    return event.surfaceOp === "append";
  }
  return event.type === "assistant/chunk" || event.type === "tool/call";
}

function safeLimit(value: number, name: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${name} must be a safe integer greater than or equal to ${minimum}`);
  }
  return value;
}

function safeTimerDelay(value: number, name: string): number {
  const delay = safeLimit(value, name, 1);
  if (delay > MAX_TIMER_DELAY_MS) {
    throw new TypeError(`${name} must not exceed ${MAX_TIMER_DELAY_MS}`);
  }
  return delay;
}
