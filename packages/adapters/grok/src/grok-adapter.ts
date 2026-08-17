import { randomUUID } from "node:crypto";
import path from "node:path";

import type {
  PermissionOption,
  PromptResponse,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import {
  HarnessOutputChannel,
  validateHostApprovalResponse,
  type HarnessAdapter,
  type HarnessError,
  type HarnessInspection,
  type HarnessModelRef,
  type HarnessOutput,
  type HarnessResult,
  type HarnessSession,
  type HarnessSessionCapabilities,
  type HarnessSessionState,
  type HostAgentMessageItem,
  type HostApprovalInteraction,
  type HostCommand,
  type HostEvent,
  type HostFileChangeItem,
  type HostItem,
  type HostItemOutcome,
  type HostItemSnapshot,
  type HostReasoningItem,
  type HostThreadSnapshot,
  type HostToolExecutionItem,
  type HostToolOutput,
  type HostUsage,
  type InspectHarnessInput,
  type InteractionRespondAccepted,
  type InteractionRespondCommand,
  type ModelSelectCommand,
  type ModelSelectCompleted,
  type OpenSessionInput,
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
  harnessThinkingOptionIdSchema,
  hostInteractionIdSchema,
  hostItemIdSchema,
  jsonValueSchema,
  nativeSessionRefSchema,
  type HarnessId,
  type HarnessThinkingOptionId,
  type HostInteractionId,
  type JsonValue,
  type NativeCheckpointRef,
  type NativeSessionRef,
  type NativeTurnRef,
} from "@codexhost/shared-contracts";

import {
  GrokAcpTransport,
  GrokTransportError,
  type GrokAcpTransportOptions,
  type GrokOpenInput,
  type GrokOpenResult,
  type GrokPermissionRequest,
  type GrokTransportEvent,
} from "./acp-transport.js";
import { projectGrokFileChanges } from "./grok-file-change.js";
import { forkGrokSession } from "./grok-fork.js";
import { mapGrokReplay } from "./grok-history.js";
import {
  modelStateFromInitialize,
  modelStateFromSessionResponse,
  stateForGrokModel,
  type GrokModelState,
} from "./grok-models.js";
import { fetchGrokCredits, type GrokCreditsSnapshot } from "./grok-credits.js";
import {
  combineUsage,
  sessionUsageFromHistory,
  usageFromPrompt,
  usageFromSignals,
  usageFromUpdate,
} from "./grok-usage.js";

export interface GrokAdapterOptions {
  command?: string;
  environment?: NodeJS.ProcessEnv;
  commandTimeoutMs?: number;
  closeTimeoutMs?: number;
  toolOutputLimit?: number;
}

export interface GrokAdapterDependencies {
  createTransport(options: GrokAcpTransportOptions): GrokAcpTransportLike;
  randomUUID(): string;
  fetchCredits?(input: { environment?: NodeJS.ProcessEnv }): Promise<GrokCreditsSnapshot | null>;
}

export interface GrokAcpTransportLike {
  readonly sessionId: string;
  inspect(): Promise<GrokOpenResult["initialize"]>;
  open(input: GrokOpenInput): Promise<GrokOpenResult>;
  getHistory(): Promise<GrokTransportEvent[]>;
  readHistory(sessionId: string): Promise<GrokTransportEvent[]>;
  deleteSession(sessionId: string): Promise<void>;
  runTurn(
    text: string,
    onEvent: (event: GrokTransportEvent) => void,
    onPermission: (request: GrokPermissionRequest) => Promise<RequestPermissionResponse>,
  ): Promise<PromptResponse>;
  setModel(modelId: string, reasoningEffort?: string): Promise<void>;
  cancel(): Promise<void>;
  close(): Promise<void>;
}

interface ActiveTool {
  item: HostToolExecutionItem;
  status?: string;
}

interface ActiveApproval {
  interaction: HostApprovalInteraction;
  options: Map<string, PermissionOption>;
  resolve(response: RequestPermissionResponse): void;
}

interface ActiveTurn {
  command: TurnStartCommand;
  agent: HostAgentMessageItem | null;
  agentMessageId: string | null;
  reasoning: HostReasoningItem | null;
  reasoningMessageId: string | null;
  tools: Map<string, ActiveTool>;
  completedItems: HostItemSnapshot[];
  approvals: Map<HostInteractionId, ActiveApproval>;
  cancellationRequested: boolean;
  beforeNativeTurnKeys: Set<string>;
  completion: Promise<void>;
  resolveCompletion(): void;
}

type SessionPhase = "open" | "closing" | "closed" | "faulted";

const grokHarnessId = harnessIdSchema.parse("grok");
function capabilitiesForModels(modelState: GrokModelState): HarnessSessionCapabilities {
  return {
    configuration: {
      selectModel: modelState.catalog.models.length > 1,
      selectThinkingOption: modelState.catalog.thinkingOptions.length > 0,
      selectPermissionMode: false,
    },
    history: { fork: true, forkAcrossCwd: false, rollbackLastTurn: false },
  };
}
const DEFAULT_CLOSE_TIMEOUT_MS = 2_000;
const DEFAULT_TOOL_OUTPUT_LIMIT = 64_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidState(message: string): HarnessError {
  return { code: "invalidState", message, retryable: false };
}

function normalizeError(error: unknown, fallback: HarnessError["code"]): HarnessError {
  if (error instanceof GrokTransportError) {
    return {
      code: error.kind,
      message: error.message,
      retryable: !["notInstalled", "protocolError"].includes(error.kind),
    };
  }
  return {
    code: fallback,
    message: error instanceof Error ? error.message : String(error),
    retryable: fallback === "unavailable" || fallback === "nativeFailure",
  };
}

function nativeRef(sessionId: string): NativeSessionRef {
  return nativeSessionRefSchema.parse({
    harnessId: grokHarnessId,
    nativeSessionId: sessionId,
    formatVersion: 1,
  });
}

function jsonValue(value: unknown): JsonValue {
  const parsed = jsonValueSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((entry) => {
      if (!isRecord(entry) || entry.type !== "content" || !isRecord(entry.content)) return [];
      return entry.content.type === "text" && typeof entry.content.text === "string"
        ? [entry.content.text]
        : [];
    })
    .join("\n");
}

function outputText(value: unknown, limit: number): HostToolOutput | undefined {
  let text: string;
  if (typeof value === "string") text = value;
  else if (value === undefined || value === null) return undefined;
  else {
    try {
      text = JSON.stringify(value, null, 2);
    } catch {
      return undefined;
    }
  }
  if (text.length === 0) return undefined;
  return {
    content: [{ type: "text", text: text.slice(0, limit) }],
    ...(text.length > limit ? { truncated: true } : {}),
  };
}

function effectForOption(option: PermissionOption): "allowOnce" | "allowAlways" | "deny" {
  return option.kind === "allow_always"
    ? "allowAlways"
    : option.kind === "allow_once"
      ? "allowOnce"
      : "deny";
}

function terminalOutcome(response: PromptResponse, cancelled: boolean): TurnOutcome {
  if (response.stopReason === "cancelled" || cancelled) {
    return { status: "cancelled", reason: "Cancelled by user" };
  }
  if (response.stopReason === "end_turn") return { status: "succeeded" };
  return {
    status: "failed",
    error: {
      code: "nativeFailure",
      message: `Grok stopped the Turn: ${response.stopReason}`,
      retryable:
        response.stopReason === "max_tokens" || response.stopReason === "max_turn_requests",
    },
  };
}

class GrokHarnessSession implements HarnessSession {
  readonly harnessId: HarnessId = grokHarnessId;
  readonly capabilities: HarnessSessionCapabilities;
  readonly initialState: HarnessSessionState;
  readonly initialUsage: HostUsage | null;
  readonly outputs: AsyncIterable<HarnessOutput>;
  readonly #channel = new HarnessOutputChannel<HarnessOutput>();
  readonly #closeTimeoutMs: number;
  readonly #cwd: string;
  readonly #modelState: GrokModelState;
  readonly #onClosed: () => void;
  readonly #refreshCredits: () => Promise<unknown>;
  readonly #randomUUID: () => string;
  readonly #snapshot: HostThreadSnapshot;
  readonly #toolOutputLimit: number;
  readonly #transport: GrokAcpTransportLike;
  #active: ActiveTurn | null = null;
  #closePromise: Promise<void> | null = null;
  #configuring = false;
  #phase: SessionPhase = "open";
  #state: HarnessSessionState;
  #usage: HostUsage | null = null;

  constructor(
    cwd: string,
    transport: GrokAcpTransportLike,
    opened: GrokOpenResult,
    modelState: GrokModelState,
    onClosed: () => void,
    options: {
      closeTimeoutMs: number;
      history: GrokTransportEvent[];
      initialUsage?: HostUsage | null;
      knownTurnRefs?: NativeTurnRef[];
      randomUUID: () => string;
      refreshCredits: () => Promise<unknown>;
      toolOutputLimit: number;
    },
  ) {
    this.#cwd = cwd;
    this.#transport = transport;
    this.#modelState = modelState;
    this.#onClosed = onClosed;
    this.#refreshCredits = options.refreshCredits;
    this.#closeTimeoutMs = options.closeTimeoutMs;
    this.#randomUUID = options.randomUUID;
    this.#toolOutputLimit = options.toolOutputLimit;
    this.initialUsage = options.initialUsage ?? null;
    this.#usage = this.initialUsage;
    this.capabilities = capabilitiesForModels(modelState);
    this.#state = stateForGrokModel(modelState, { nativeRef: nativeRef(opened.sessionId) });
    this.initialState = this.#state;
    this.#snapshot = {
      ...mapGrokReplay(
        options.history,
        this.harnessId,
        opened.sessionId,
        cwd,
        options.knownTurnRefs,
      ),
      state: this.#state,
    };
    this.outputs = this.#channel.outputs;
  }

  async readSnapshot(): Promise<HarnessResult<HostThreadSnapshot>> {
    if (this.#phase !== "open") {
      return { ok: false, error: invalidState("Grok Session is not open") };
    }
    if (this.#active || this.#configuring) {
      return {
        ok: false,
        error: {
          code: "sessionBusy",
          message: "Grok Session cannot read history during another operation",
          retryable: true,
        },
      };
    }
    try {
      await this.#refreshSnapshot();
      return { ok: true, value: { ...this.#snapshot, state: this.#state } };
    } catch (error) {
      return { ok: false, error: normalizeError(error, "nativeFailure") };
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
    if (this.#phase !== "open")
      return { ok: false, error: invalidState("Grok Session is not open") };
    if (command.type === "turn.cancel") return this.#cancel(command);
    if (command.type === "interaction.respond") return this.#respond(command);
    if (command.type === "model.select") return this.#selectModel(command);
    if (command.type === "thinking.select") return this.#selectThinking(command);
    if (command.type === "permissionMode.select") {
      return {
        ok: false,
        error: {
          code: "unsupported",
          message: "Grok Permission Mode selection is unavailable",
          retryable: false,
        },
      };
    }
    if (this.#active || this.#configuring) {
      return {
        ok: false,
        error: {
          code: "sessionBusy",
          message: "Grok Session already has an active operation",
          retryable: true,
        },
      };
    }
    const text = command.input.map(({ text }) => text).join("\n");
    if (text.length === 0) {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "Grok text Turn must not be empty",
          retryable: false,
        },
      };
    }
    try {
      await this.#refreshSnapshot();
    } catch (error) {
      return { ok: false, error: normalizeError(error, "nativeFailure") };
    }
    let resolveCompletion = (): void => undefined;
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    const active: ActiveTurn = {
      command,
      agent: null,
      agentMessageId: null,
      reasoning: null,
      reasoningMessageId: null,
      tools: new Map(),
      completedItems: [],
      approvals: new Map(),
      cancellationRequested: false,
      beforeNativeTurnKeys: new Set(
        this.#snapshot.turns.map((turn) => turn.nativeTurnRef.nativeTurnKey),
      ),
      completion,
      resolveCompletion,
    };
    this.#active = active;
    this.#event({ type: "turn.started", turnId: command.turnId });
    void this.#transport
      .runTurn(
        text,
        (event) => this.#handleEvent(active, event),
        (request) => this.#requestPermission(active, request),
      )
      .then(
        (response) =>
          this.#settleFromHistory(
            active,
            terminalOutcome(response, active.cancellationRequested),
            response,
          ),
        (error) =>
          this.#settleFromHistory(active, {
            status: "failed",
            error: normalizeError(error, "nativeFailure"),
          }),
      );
    return { ok: true, value: { turnId: command.turnId } };
  }

  close(): Promise<void> {
    if (!this.#closePromise) this.#closePromise = this.#close().finally(this.#onClosed);
    return this.#closePromise;
  }

  handleTransportFault(error: GrokTransportError): void {
    queueMicrotask(() => this.#fault(error));
  }

  async #refreshSnapshot(): Promise<GrokTransportEvent[]> {
    const history = await this.#transport.getHistory();
    const knownTurnRefs = this.#snapshot.turns.map((turn) => turn.nativeTurnRef);
    const refreshed = mapGrokReplay(
      history,
      this.harnessId,
      this.#transport.sessionId,
      this.#cwd,
      knownTurnRefs,
    );
    this.#snapshot.turns = refreshed.turns;
    return history;
  }

  async #selectModel(command: ModelSelectCommand): Promise<HarnessResult<ModelSelectCompleted>> {
    const available = this.#modelState.catalog.models.find(
      ({ ref }) => ref.id === command.model.id,
    );
    if (!available) {
      return {
        ok: false,
        error: { code: "invalidRequest", message: "Grok Model is unavailable", retryable: false },
      };
    }
    return this.#configure(command.model, this.#state.effectiveThinkingOptionId);
  }

  async #selectThinking(
    command: ThinkingSelectCommand,
  ): Promise<HarnessResult<ThinkingSelectCompleted>> {
    const parsed = harnessThinkingOptionIdSchema.safeParse(command.thinkingOptionId);
    const model = this.#state.effectiveModel;
    const available = this.#modelState.catalog.models.find(({ ref }) => ref.id === model?.id);
    if (
      !parsed.success ||
      !model ||
      !available?.supportedThinkingOptionIds?.includes(parsed.data)
    ) {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "Grok Thinking option is unavailable",
          retryable: false,
        },
      };
    }
    return this.#configure(model, parsed.data);
  }

  async #configure(
    model: HarnessModelRef,
    thinkingOptionId?: HarnessThinkingOptionId,
  ): Promise<HarnessResult<ModelSelectCompleted | ThinkingSelectCompleted>> {
    if (this.#active || this.#configuring) {
      return {
        ok: false,
        error: {
          code: "sessionBusy",
          message: "Grok Session cannot configure during another operation",
          retryable: true,
        },
      };
    }
    this.#configuring = true;
    try {
      await this.#transport.setModel(model.id, thinkingOptionId);
      this.#state = stateForGrokModel(
        this.#modelState,
        { nativeRef: nativeRef(this.#transport.sessionId) },
        model,
        thinkingOptionId,
      );
      this.#event({ type: "session.state.changed", state: this.#state });
      return { ok: true, value: { completed: true } };
    } catch (error) {
      return { ok: false, error: normalizeError(error, "nativeFailure") };
    } finally {
      this.#configuring = false;
    }
  }

  async #cancel(command: TurnCancelCommand): Promise<HarnessResult<TurnCancelAccepted>> {
    const active = this.#active;
    if (!active || active.command.turnId !== command.turnId) {
      return { ok: false, error: invalidState("Grok Turn Cancel must reference the active Turn") };
    }
    if (active.cancellationRequested) return { ok: true, value: { cancellationRequested: true } };
    active.cancellationRequested = true;
    for (const approval of active.approvals.values()) {
      approval.resolve({ outcome: { outcome: "cancelled" } });
    }
    try {
      await this.#transport.cancel();
      return { ok: true, value: { cancellationRequested: true } };
    } catch (error) {
      return { ok: false, error: normalizeError(error, "nativeFailure") };
    }
  }

  async #respond(
    command: InteractionRespondCommand,
  ): Promise<HarnessResult<InteractionRespondAccepted>> {
    const active = this.#active;
    const pending = active?.approvals.get(command.interactionId);
    if (!active || !pending)
      return { ok: false, error: invalidState("Grok Approval is not pending") };
    if (command.response.type !== "approval") {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "Grok Approval requires an Approval Response",
          retryable: false,
        },
      };
    }
    const validation = validateHostApprovalResponse(pending.interaction, command.response);
    if (validation) return { ok: false, error: validation };
    const option = pending.options.get(command.response.actionId);
    if (!option)
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "Grok Approval action is unavailable",
          retryable: false,
        },
      };
    active.approvals.delete(command.interactionId);
    pending.resolve({ outcome: { outcome: "selected", optionId: option.optionId } });
    this.#event({
      type: "interaction.closed",
      interactionId: command.interactionId,
      turnId: active.command.turnId,
      reason: "responded",
    });
    return { ok: true, value: { accepted: true } };
  }

  #requestPermission(
    active: ActiveTurn,
    request: GrokPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    if (this.#active !== active || active.cancellationRequested) {
      return Promise.resolve({ outcome: { outcome: "cancelled" } });
    }
    const interactionId = hostInteractionIdSchema.parse(this.#randomUUID());
    const options = new Map<string, PermissionOption>();
    const actions = request.options.map((option, index) => {
      const id = `native-${index + 1}`;
      options.set(id, option);
      return { id, label: option.name, effect: effectForOption(option) };
    });
    const interaction: HostApprovalInteraction = {
      type: "approval",
      interactionId,
      turnId: active.command.turnId,
      title: request.request.toolCall.title ?? "Grok Tool",
      subject: { type: "nativeAction" },
      actions,
    };
    return new Promise<RequestPermissionResponse>((resolve) => {
      active.approvals.set(interactionId, { interaction, options, resolve });
      this.#channel.emit({ kind: "interaction", interaction });
    });
  }

  #handleEvent(active: ActiveTurn, event: GrokTransportEvent): void {
    if (this.#active !== active || this.#phase !== "open") return;
    const contextUsage = usageFromUpdate(
      event.type === "usage" ? event.update : undefined,
      event.metadata,
      this.#state.effectiveModel
        ? this.#modelState.contextWindowTokensByModel.get(this.#state.effectiveModel.id)
        : undefined,
    );
    if (contextUsage) this.#publishUsage(contextUsage, active.command.turnId);
    if (event.type === "agent.text") this.#appendAgent(active, event.text, event.messageId);
    else if (event.type === "agent.thought")
      this.#appendReasoning(active, event.text, event.messageId);
    else if (event.type === "tool.call") this.#startTool(active, event);
    else if (event.type === "tool.update") this.#updateTool(active, event);
    else if (event.type === "usage" || event.type === "turn.completed") return;
  }

  #appendAgent(active: ActiveTurn, text: string, messageId?: string): void {
    const identity = messageId ?? "agent";
    if (active.agentMessageId !== identity) {
      this.#completeReasoning(active, { status: "succeeded" });
      this.#completeAgent(active, { status: "succeeded" });
      active.agentMessageId = identity;
    }
    if (!active.agent) {
      active.agent = {
        type: "agentMessage",
        itemId: hostItemIdSchema.parse(this.#randomUUID()),
        text: "",
      };
      this.#event({ type: "item.started", turnId: active.command.turnId, item: active.agent });
    }
    active.agent = { ...active.agent, text: active.agent.text + text };
    this.#event({
      type: "item.updated",
      turnId: active.command.turnId,
      itemId: active.agent.itemId,
      update: { type: "text.append", text },
    });
  }

  #appendReasoning(active: ActiveTurn, text: string, messageId?: string): void {
    const identity = messageId ?? "thought";
    if (active.reasoningMessageId !== identity) {
      this.#completeReasoning(active, { status: "succeeded" });
      active.reasoningMessageId = identity;
    }
    if (!active.reasoning) {
      active.reasoning = {
        type: "reasoning",
        itemId: hostItemIdSchema.parse(this.#randomUUID()),
        text: "",
      };
      this.#event({ type: "item.started", turnId: active.command.turnId, item: active.reasoning });
    }
    active.reasoning = { ...active.reasoning, text: active.reasoning.text + text };
    this.#event({
      type: "item.updated",
      turnId: active.command.turnId,
      itemId: active.reasoning.itemId,
      update: { type: "text.append", text },
    });
  }

  #startTool(active: ActiveTurn, event: Extract<GrokTransportEvent, { type: "tool.call" }>): void {
    this.#completeReasoning(active, { status: "succeeded" });
    this.#completeAgent(active, { status: "succeeded" });
    const output = outputText(contentText(event.content) || event.rawOutput, this.#toolOutputLimit);
    const item: HostToolExecutionItem = {
      type: "toolExecution",
      itemId: hostItemIdSchema.parse(this.#randomUUID()),
      toolName: event.name ?? event.title,
      namespace: "grok",
      arguments: jsonValue(event.rawInput),
      ...(output ? { output } : {}),
    };
    active.tools.set(event.callId, { item, ...(event.status ? { status: event.status } : {}) });
    this.#event({ type: "item.started", turnId: active.command.turnId, item });
    if (event.status === "completed" || event.status === "failed") {
      this.#completeTool(active, event.callId, event.status, event.content);
    }
  }

  #updateTool(
    active: ActiveTurn,
    event: Extract<GrokTransportEvent, { type: "tool.update" }>,
  ): void {
    const tool = active.tools.get(event.callId);
    if (!tool) return;
    const output = outputText(contentText(event.content) || event.rawOutput, this.#toolOutputLimit);
    if (output) {
      tool.item = { ...tool.item, output };
      this.#event({
        type: "item.updated",
        turnId: active.command.turnId,
        itemId: tool.item.itemId,
        update: { type: "output.replace", output },
      });
    }
    if (event.status) tool.status = event.status;
    if (event.status === "completed" || event.status === "failed") {
      this.#completeTool(active, event.callId, event.status, event.content);
    }
  }

  #completeTool(
    active: ActiveTurn,
    callId: string,
    status: string,
    content?: unknown[] | null,
  ): void {
    const tool = active.tools.get(callId);
    if (!tool) return;
    active.tools.delete(callId);
    const outcome: HostItemOutcome =
      status === "failed"
        ? {
            status: "failed",
            error: {
              code: "nativeFailure",
              message: `Grok Tool '${tool.item.toolName}' failed`,
              retryable: false,
            },
          }
        : { status: "succeeded" };
    this.#completeItem(active, tool.item, outcome);
    if (status !== "completed") return;
    const changes = projectGrokFileChanges(content, this.#cwd);
    if (!changes) return;
    const fileItem: HostFileChangeItem = {
      type: "fileChange",
      itemId: hostItemIdSchema.parse(this.#randomUUID()),
      changes,
    };
    this.#event({ type: "item.started", turnId: active.command.turnId, item: fileItem });
    this.#completeItem(active, fileItem, { status: "succeeded" });
  }

  #completeAgent(active: ActiveTurn, outcome: HostItemOutcome): void {
    const item = active.agent;
    active.agent = null;
    active.agentMessageId = null;
    if (item) this.#completeItem(active, item, outcome);
  }

  #completeReasoning(active: ActiveTurn, outcome: HostItemOutcome): void {
    const item = active.reasoning;
    active.reasoning = null;
    active.reasoningMessageId = null;
    if (item) this.#completeItem(active, item, outcome);
  }

  #completeItem(active: ActiveTurn, item: HostItem, outcome: HostItemOutcome): void {
    const snapshot = { item, outcome };
    active.completedItems.push(snapshot);
    this.#event({
      type: "item.completed",
      turnId: active.command.turnId,
      snapshot,
    });
  }

  async #settleFromHistory(
    active: ActiveTurn,
    outcome: TurnOutcome,
    response?: PromptResponse,
  ): Promise<void> {
    let history: GrokTransportEvent[] = [];
    let nativeTurnRef: NativeTurnRef | undefined;
    let checkpoint: NativeCheckpointRef | undefined;
    try {
      history = await this.#refreshSnapshot();
      const created = this.#snapshot.turns.filter(
        (turn) => !active.beforeNativeTurnKeys.has(turn.nativeTurnRef.nativeTurnKey),
      );
      if (created.length !== 1) {
        throw new Error(
          `Grok Turn persisted ${created.length} new Native Turns; exactly one is required`,
        );
      }
      nativeTurnRef = created[0]?.nativeTurnRef;
      checkpoint = created[0]?.checkpoint;
    } catch (error) {
      if (outcome.status === "succeeded") {
        outcome = { status: "failed", error: normalizeError(error, "protocolError") };
      }
    }
    await this.#refreshCredits().catch(() => undefined);
    this.#finish(
      active,
      checkpoint ? { ...outcome, checkpoint } : outcome,
      sessionUsageFromHistory(history) ?? (response ? usageFromPrompt(response) : null),
      nativeTurnRef,
    );
  }

  #finish(
    active: ActiveTurn,
    outcome: TurnOutcome,
    usage: HostUsage | null = null,
    nativeTurnRef?: NativeTurnRef,
  ): void {
    if (this.#active !== active) return;
    const itemOutcome: HostItemOutcome = outcome;
    this.#completeReasoning(active, itemOutcome);
    this.#completeAgent(active, itemOutcome);
    for (const tool of active.tools.values()) this.#completeItem(active, tool.item, itemOutcome);
    active.tools.clear();
    for (const [interactionId, pending] of active.approvals) {
      active.approvals.delete(interactionId);
      pending.resolve({ outcome: { outcome: "cancelled" } });
      this.#event({
        type: "interaction.closed",
        interactionId,
        turnId: active.command.turnId,
        reason: "cancelled",
      });
    }
    this.#active = null;
    if (usage) this.#publishUsage(usage, active.command.turnId);
    this.#event({
      type: "turn.completed",
      turnId: active.command.turnId,
      ...(nativeTurnRef ? { nativeTurnRef } : {}),
      outcome,
    });
    active.resolveCompletion();
  }

  #publishUsage(usage: HostUsage, observedForTurnId?: TurnStartCommand["turnId"]): void {
    const merged = combineUsage(this.#usage, usage);
    if (merged === null || JSON.stringify(merged) === JSON.stringify(this.#usage)) return;
    this.#usage = merged;
    this.#event({
      type: "session.usage.changed",
      usage: merged,
      ...(observedForTurnId ? { observedForTurnId } : {}),
    });
  }

  async #close(): Promise<void> {
    if (this.#phase === "closed") return;
    this.#phase = "closing";
    const active = this.#active;
    if (active) {
      active.cancellationRequested = true;
      for (const approval of active.approvals.values())
        approval.resolve({ outcome: { outcome: "cancelled" } });
      await this.#transport.cancel().catch(() => undefined);
      await Promise.race([
        active.completion,
        new Promise((resolve) => setTimeout(resolve, this.#closeTimeoutMs)),
      ]);
    }
    await this.#transport.close();
    if (this.#active)
      this.#finish(this.#active, {
        status: "failed",
        error: invalidState("Grok Session closed during active Turn"),
      });
    this.#phase = "closed";
    this.#channel.end();
  }

  #fault(error: GrokTransportError): void {
    if (this.#phase !== "open") return;
    const normalized = normalizeError(error, "processExited");
    if (this.#active) this.#finish(this.#active, { status: "failed", error: normalized });
    this.#phase = "faulted";
    this.#event({ type: "session.faulted", error: normalized });
    this.#channel.end();
    void this.#transport.close().catch(() => undefined);
    this.#onClosed();
  }

  #event(event: HostEvent): void {
    this.#channel.emit({ kind: "event", event });
  }
}

export class GrokAdapter implements HarnessAdapter {
  readonly harnessId: HarnessId = grokHarnessId;
  readonly #closeTimeoutMs: number;
  readonly #dependencies: GrokAdapterDependencies;
  readonly #environment: NodeJS.ProcessEnv | undefined;
  readonly #fetchCredits: (input: {
    environment?: NodeJS.ProcessEnv;
  }) => Promise<GrokCreditsSnapshot | null>;
  readonly #inspectionCache = new Map<string, Extract<HarnessInspection, { status: "ready" }>>();
  readonly #sessions = new Set<GrokHarnessSession>();
  readonly #toolOutputLimit: number;
  #closePromise: Promise<void> | null = null;
  #credits: GrokCreditsSnapshot | null = null;
  #creditsRefresh: Promise<GrokCreditsSnapshot | null> | null = null;

  constructor(options: GrokAdapterOptions = {}, dependencies?: GrokAdapterDependencies) {
    this.#closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
    this.#environment = options.environment;
    this.#toolOutputLimit = options.toolOutputLimit ?? DEFAULT_TOOL_OUTPUT_LIMIT;
    this.#dependencies = dependencies ?? {
      randomUUID,
      createTransport: (transportOptions) =>
        new GrokAcpTransport({ ...options, ...transportOptions }),
    };
    this.#fetchCredits =
      this.#dependencies.fetchCredits ??
      ((input) =>
        fetchGrokCredits(
          input.environment
            ? { environment: input.environment }
            : this.#environment
              ? { environment: this.#environment }
              : {},
        ));
  }

  credits(): GrokCreditsSnapshot | null {
    return this.#credits;
  }

  refreshCredits(): Promise<GrokCreditsSnapshot | null> {
    if (this.#closePromise) return Promise.resolve(this.#credits);
    if (this.#creditsRefresh) return this.#creditsRefresh;
    this.#creditsRefresh = this.#loadCredits().finally(() => {
      this.#creditsRefresh = null;
    });
    return this.#creditsRefresh;
  }

  #scheduleCreditsRefresh(): void {
    void this.refreshCredits();
  }

  async #loadCredits(): Promise<GrokCreditsSnapshot | null> {
    try {
      const snapshot = await this.#fetchCredits(
        this.#environment ? { environment: this.#environment } : {},
      );
      if (snapshot) this.#credits = snapshot;
    } catch {
      // Credits are optional account telemetry; keep the last good snapshot.
    }
    return this.#credits;
  }

  async inspect(input: InspectHarnessInput = {}): Promise<HarnessInspection> {
    if (this.#closePromise)
      return { status: "unavailable", error: invalidState("Grok Adapter is closed") };
    const cwd = path.resolve(input.cwd ?? process.cwd());
    if (!input.refresh) {
      const cached = this.#inspectionCache.get(cwd);
      if (cached) return cached;
    }
    let transport: GrokAcpTransportLike | null = null;
    try {
      transport = this.#createTransport(cwd, () => undefined);
      const initialize = await transport.inspect();
      const modelState = modelStateFromInitialize(initialize);
      if (!modelState)
        throw new GrokTransportError("protocolError", "Grok returned an invalid Model catalog");
      await transport.close();
      const ready: Extract<HarnessInspection, { status: "ready" }> = {
        status: "ready",
        catalog: modelState.catalog,
        capabilities: capabilitiesForModels(modelState),
      };
      this.#inspectionCache.set(cwd, ready);
      this.#scheduleCreditsRefresh();
      return ready;
    } catch (error) {
      await transport?.close().catch(() => undefined);
      const normalized = normalizeError(error, "unavailable");
      return {
        status: normalized.code === "notInstalled" ? "notInstalled" : "error",
        error: normalized,
      };
    }
  }

  async open(input: OpenSessionInput): Promise<HarnessResult<HarnessSession>> {
    if (this.#closePromise) return { ok: false, error: invalidState("Grok Adapter is closed") };
    if (input.cwd.length === 0)
      return {
        ok: false,
        error: { code: "invalidRequest", message: "Grok Adapter requires cwd", retryable: false },
      };
    if (input.kind === "rollbackLastTurn") {
      return {
        ok: false,
        error: {
          code: "unsupported",
          message: "Grok does not support last-turn Rollback",
          retryable: false,
        },
      };
    }
    if (input.kind === "create" && input.permissionModeId) {
      return {
        ok: false,
        error: {
          code: "unsupported",
          message: "Grok Permission Mode selection is unavailable",
          retryable: false,
        },
      };
    }
    const cwd = path.resolve(input.cwd);
    const parsedRef =
      input.kind === "resume" ? nativeSessionRefSchema.safeParse(input.nativeRef) : null;
    if (parsedRef && (!parsedRef.success || parsedRef.data.harnessId !== this.harnessId)) {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "Grok cannot resume another Harness's Native Session",
          retryable: false,
        },
      };
    }
    let session: GrokHarnessSession | null = null;
    const transport = this.#createTransport(cwd, (error) => session?.handleTransportFault(error));
    try {
      let opened: GrokOpenResult | undefined;
      if (input.kind === "fork") {
        const forked = await forkGrokSession({
          checkpoint: input.checkpoint,
          cwd,
          harnessId: this.harnessId,
          sourceRef: input.sourceRef,
          readHistory: (_historyCwd, sessionId) => transport.readHistory(sessionId),
          forkAndLoad: async (params) => {
            opened = await transport.open({
              kind: "fork",
              sourceSessionId: params.sourceSessionId,
              sourceCwd: params.sourceCwd,
              targetPromptIndex: params.targetPromptIndex,
            });
            return { sessionId: opened.sessionId };
          },
          deleteSession: async (_historyCwd, sessionId) => transport.deleteSession(sessionId),
        });
        if (!forked.ok) {
          await transport.close().catch(() => undefined);
          return forked;
        }
      } else {
        opened = await transport.open(
          parsedRef?.success
            ? { kind: "resume", sessionId: parsedRef.data.nativeSessionId }
            : { kind: "create" },
        );
      }
      if (!opened) {
        await transport.close().catch(() => undefined);
        return {
          ok: false,
          error: {
            code: "nativeFailure",
            message: "Grok Native Fork did not open a Session",
            retryable: true,
          },
        };
      }
      const modelState =
        modelStateFromSessionResponse(opened.session) ??
        modelStateFromInitialize(opened.initialize);
      if (!modelState)
        throw new GrokTransportError("protocolError", "Grok returned an invalid Model catalog");
      if (input.kind === "create") {
        const selectedModel = input.model ?? modelState.currentModel;
        const selectedThinking = input.thinkingOptionId ?? modelState.currentThinkingOptionId;
        const catalogModel = modelState.catalog.models.find(
          ({ ref }) => ref.id === selectedModel.id,
        );
        if (!catalogModel)
          throw new GrokTransportError("protocolError", "Requested Grok Model is unavailable");
        if (
          selectedThinking &&
          !catalogModel.supportedThinkingOptionIds?.includes(selectedThinking)
        ) {
          throw new GrokTransportError(
            "protocolError",
            "Requested Grok Thinking option is unavailable",
          );
        }
        if (
          selectedModel.id !== modelState.currentModel.id ||
          selectedThinking !== modelState.currentThinkingOptionId
        ) {
          await transport.setModel(selectedModel.id, selectedThinking);
          modelState.currentModel = selectedModel;
          if (selectedThinking) modelState.currentThinkingOptionId = selectedThinking;
          else delete modelState.currentThinkingOptionId;
        }
      }
      const history = await transport.getHistory();
      const initialUsage =
        input.kind === "resume" || input.kind === "fork"
          ? combineUsage(sessionUsageFromHistory(history), usageFromSignals(opened.signals))
          : null;
      const openedSession = new GrokHarnessSession(
        cwd,
        transport,
        opened,
        modelState,
        () => this.#sessions.delete(openedSession),
        {
          closeTimeoutMs: this.#closeTimeoutMs,
          history,
          initialUsage,
          ...(input.kind === "resume" && input.knownTurnRefs
            ? { knownTurnRefs: input.knownTurnRefs }
            : {}),
          randomUUID: this.#dependencies.randomUUID,
          refreshCredits: () => this.refreshCredits(),
          toolOutputLimit: this.#toolOutputLimit,
        },
      );
      session = openedSession;
      this.#sessions.add(openedSession);
      this.#scheduleCreditsRefresh();
      return { ok: true, value: openedSession };
    } catch (error) {
      await transport.close().catch(() => undefined);
      return { ok: false, error: normalizeError(error, "unavailable") };
    }
  }

  close(): Promise<void> {
    if (!this.#closePromise) {
      this.#inspectionCache.clear();
      this.#closePromise = Promise.all([...this.#sessions].map((session) => session.close())).then(
        () => undefined,
      );
    }
    return this.#closePromise;
  }

  #createTransport(
    cwd: string,
    onFault: (error: GrokTransportError) => void,
  ): GrokAcpTransportLike {
    return this.#dependencies.createTransport({ cwd, onFault });
  }
}
