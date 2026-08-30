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
  type HostTurnSnapshot,
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
  hostInteractionIdSchema,
  hostItemIdSchema,
  nativeSessionRefSchema,
  type HarnessId,
  type HarnessPermissionModeId,
  type HostInteractionId,
  type NativeSessionRef,
  type NativeTurnRef,
} from "@codexhost/shared-contracts";

import {
  QwenCodeAcpTransport,
  QwenCodeTransportError,
  type QwenCodeAcpTransportOptions,
  type QwenCodeOpenResult,
  type QwenCodePermissionRequest,
  type QwenCodeTransportEvent,
} from "./acp-transport.js";
import { projectQwenCodeFileChanges } from "./qwen-file-change.js";
import {
  QWEN_CODE_DEFAULT_PERMISSION_MODE_ID,
  QWEN_CODE_PERMISSION_MODE_CATALOG,
  currentQwenCodePermissionModeId,
  decodeQwenCodePermissionModeId,
} from "./permission-modes.js";
import {
  nativeModelIdForRef,
  parseQwenCodeModelState,
  stateForQwenCodeModel,
  type QwenCodeModelState,
} from "./qwen-models.js";
import { mapQwenCodeReplay, qwenCodeTurnKey } from "./qwen-history.js";
import {
  applyQwenCodeToolProjection,
  DEFAULT_QWEN_CODE_TOOL_OUTPUT_LIMIT,
  hasQwenCodeToolProjection,
  projectQwenCodeToolOutput,
  qwenCodeToolLabel,
  startQwenCodeToolItem,
  type QwenCodeProjectedToolItem,
} from "./qwen-tool-output.js";
import {
  combineUsage,
  sessionUsageFromReplay,
  usageFromMetadata,
  usageFromUpdate,
} from "./qwen-usage.js";

export interface QwenCodeAdapterOptions {
  command?: string;
  environment?: NodeJS.ProcessEnv;
  commandTimeoutMs?: number;
  closeTimeoutMs?: number;
  toolOutputLimit?: number;
}

export interface QwenCodeAdapterDependencies {
  createTransport(options: QwenCodeAcpTransportOptions): QwenCodeAcpTransportLike;
  randomUUID(): string;
}

export interface QwenCodeAcpTransportLike {
  readonly sessionId: string;
  readonly stderrTail?: string;
  inspect(): Promise<{ initialize: QwenCodeOpenResult["initialize"]; models: unknown }>;
  open(input: { kind: "create" | "resume"; sessionId?: string }): Promise<QwenCodeOpenResult>;
  runTurn(
    text: string,
    onEvent: (event: QwenCodeTransportEvent) => void,
    onPermission: (request: QwenCodePermissionRequest) => Promise<RequestPermissionResponse>,
  ): Promise<PromptResponse>;
  setModel(nativeModelId: string): Promise<void>;
  setPermissionMode(permissionModeId: HarnessPermissionModeId): Promise<void>;
  cancel(): Promise<void>;
  close(): Promise<void>;
}

interface ActiveTool {
  item: QwenCodeProjectedToolItem;
  rawInput: unknown;
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
  reasoning: HostReasoningItem | null;
  tools: Map<string, ActiveTool>;
  completedItems: HostItemSnapshot[];
  approvals: Map<HostInteractionId, ActiveApproval>;
  cancellationRequested: boolean;
  completion: Promise<void>;
  resolveCompletion(): void;
}

type SessionPhase = "open" | "closing" | "closed" | "faulted";

const qwenCodeHarnessId = harnessIdSchema.parse("qwen-code");
const DEFAULT_CLOSE_TIMEOUT_MS = 2_000;

function invalidState(message: string): HarnessError {
  return { code: "invalidState", message, retryable: false };
}

function normalizeError(error: unknown, fallback: HarnessError["code"]): HarnessError {
  if (error instanceof QwenCodeTransportError) {
    return {
      code: error.kind,
      message: error.message,
      retryable: !["notInstalled", "protocolError"].includes(error.kind),
      ...(error.diagnostic ? { diagnostic: error.diagnostic } : {}),
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
    harnessId: qwenCodeHarnessId,
    nativeSessionId: sessionId,
    formatVersion: 1,
  });
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
      message: `Qwen Code stopped the Turn: ${response.stopReason}`,
      retryable:
        response.stopReason === "max_tokens" || response.stopReason === "max_turn_requests",
    },
  };
}

function capabilitiesForModels(modelState: QwenCodeModelState): HarnessSessionCapabilities {
  return {
    configuration: {
      selectModel: modelState.catalog.models.length > 0,
      selectThinkingOption: false,
      selectPermissionMode: true,
    },
    history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
  };
}

class QwenCodeHarnessSession implements HarnessSession {
  readonly harnessId: HarnessId = qwenCodeHarnessId;
  readonly capabilities: HarnessSessionCapabilities;
  readonly initialState: HarnessSessionState;
  readonly initialUsage: HostUsage | null;
  readonly outputs: AsyncIterable<HarnessOutput>;
  readonly #channel = new HarnessOutputChannel<HarnessOutput>();
  readonly #closeTimeoutMs: number;
  readonly #cwd: string;
  #modelState: QwenCodeModelState;
  readonly #onClosed: () => void;
  readonly #randomUUID: () => string;
  readonly #snapshot: HostThreadSnapshot;
  readonly #toolOutputLimit: number;
  readonly #transport: QwenCodeAcpTransportLike;
  #active: ActiveTurn | null = null;
  #closePromise: Promise<void> | null = null;
  #configuring = false;
  #nextTurnOrdinal: number;
  #phase: SessionPhase = "open";
  #state: HarnessSessionState;
  #usage: HostUsage | null = null;

  constructor(
    cwd: string,
    transport: QwenCodeAcpTransportLike,
    opened: QwenCodeOpenResult,
    modelState: QwenCodeModelState,
    onClosed: () => void,
    options: {
      closeTimeoutMs: number;
      history: HostTurnSnapshot[];
      turnCount: number;
      initialUsage?: HostUsage | null;
      initialPermissionModeId: HarnessPermissionModeId;
      randomUUID: () => string;
      toolOutputLimit: number;
    },
  ) {
    this.#cwd = cwd;
    this.#transport = transport;
    this.#modelState = modelState;
    this.#onClosed = onClosed;
    this.#closeTimeoutMs = options.closeTimeoutMs;
    this.#randomUUID = options.randomUUID;
    this.#toolOutputLimit = options.toolOutputLimit;
    this.#nextTurnOrdinal = options.turnCount;
    this.initialUsage = options.initialUsage ?? null;
    this.#usage = this.initialUsage;
    this.capabilities = capabilitiesForModels(modelState);
    this.#state = stateForQwenCodeModel(
      modelState,
      { nativeRef: nativeRef(opened.sessionId) },
      modelState.currentModel,
      options.initialPermissionModeId,
    );
    this.initialState = this.#state;
    this.#snapshot = { turns: options.history, state: this.#state };
    this.outputs = this.#channel.outputs;
  }

  async readSnapshot(): Promise<HarnessResult<HostThreadSnapshot>> {
    if (this.#phase !== "open") {
      return { ok: false, error: invalidState("Qwen Code Session is not open") };
    }
    if (this.#active || this.#configuring) {
      return {
        ok: false,
        error: {
          code: "sessionBusy",
          message: "Qwen Code Session cannot read history during another operation",
          retryable: true,
        },
      };
    }
    return { ok: true, value: { ...this.#snapshot, state: this.#state } };
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
    if (this.#phase !== "open") {
      return { ok: false, error: invalidState("Qwen Code Session is not open") };
    }
    if (command.type === "turn.cancel") return this.#cancel(command);
    if (command.type === "interaction.respond") return this.#respond(command);
    if (command.type === "model.select") return this.#selectModel(command);
    if (command.type === "thinking.select") {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "Qwen Code does not expose Thinking options",
          retryable: false,
        },
      };
    }
    if (command.type === "permissionMode.select") return this.#selectPermissionMode(command);
    if (this.#active || this.#configuring) {
      return {
        ok: false,
        error: {
          code: "sessionBusy",
          message: "Qwen Code Session already has an active operation",
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
          message: "Qwen Code text Turn must not be empty",
          retryable: false,
        },
      };
    }
    let resolveCompletion = (): void => undefined;
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    const active: ActiveTurn = {
      command,
      agent: null,
      reasoning: null,
      tools: new Map(),
      completedItems: [],
      approvals: new Map(),
      cancellationRequested: false,
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
        (response) => this.#finish(active, terminalOutcome(response, active.cancellationRequested)),
        (error) =>
          this.#finish(active, { status: "failed", error: normalizeError(error, "nativeFailure") }),
      );
    return { ok: true, value: { turnId: command.turnId } };
  }

  async #selectModel(command: ModelSelectCommand): Promise<HarnessResult<ModelSelectCompleted>> {
    const nativeModelId = nativeModelIdForRef(this.#modelState, command.model);
    if (!nativeModelId) {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "Qwen Code Model is unavailable",
          retryable: false,
        },
      };
    }
    if (this.#active || this.#configuring) {
      return {
        ok: false,
        error: {
          code: "sessionBusy",
          message: "Qwen Code Session cannot configure during another operation",
          retryable: true,
        },
      };
    }
    this.#configuring = true;
    try {
      await this.#transport.setModel(nativeModelId);
      this.#modelState = { ...this.#modelState, currentModel: command.model };
      this.#state = stateForQwenCodeModel(
        this.#modelState,
        { nativeRef: nativeRef(this.#transport.sessionId) },
        command.model,
        this.#state.effectivePermissionModeId,
      );
      this.#event({ type: "session.state.changed", state: this.#state });
      return { ok: true, value: { completed: true } };
    } catch (error) {
      return { ok: false, error: normalizeError(error, "nativeFailure") };
    } finally {
      this.#configuring = false;
    }
  }

  async #selectPermissionMode(
    command: PermissionModeSelectCommand,
  ): Promise<HarnessResult<PermissionModeSelectCompleted>> {
    try {
      decodeQwenCodePermissionModeId(command.permissionModeId);
    } catch {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "Qwen Code Permission Mode is unavailable",
          retryable: false,
        },
      };
    }
    if (this.#active || this.#configuring) {
      return {
        ok: false,
        error: {
          code: "sessionBusy",
          message: "Qwen Code Session cannot configure during another operation",
          retryable: true,
        },
      };
    }
    this.#configuring = true;
    try {
      await this.#transport.setPermissionMode(command.permissionModeId);
      this.#state = {
        ...this.#state,
        effectivePermissionModeId: command.permissionModeId,
      };
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
      return {
        ok: false,
        error: invalidState("Qwen Code Turn Cancel must reference the active Turn"),
      };
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
      return { ok: false, error: invalidState("Qwen Code Approval is not pending") };
    if (command.response.type !== "approval") {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "Qwen Code Approval requires an Approval Response",
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
          message: "Qwen Code Approval action is unavailable",
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
    request: QwenCodePermissionRequest,
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
      title: request.request.toolCall.title ?? "Qwen Code Tool",
      subject: { type: "nativeAction" },
      actions,
    };
    return new Promise<RequestPermissionResponse>((resolve) => {
      active.approvals.set(interactionId, { interaction, options, resolve });
      this.#channel.emit({ kind: "interaction", interaction });
    });
  }

  #handleEvent(active: ActiveTurn, event: QwenCodeTransportEvent): void {
    if (this.#active !== active || this.#phase !== "open") return;
    if (event.type === "mode.changed") {
      const permissionModeId = currentQwenCodePermissionModeId(event.modeId);
      if (permissionModeId && permissionModeId !== this.#state.effectivePermissionModeId) {
        this.#state = { ...this.#state, effectivePermissionModeId: permissionModeId };
        this.#event({ type: "session.state.changed", state: this.#state });
      }
      return;
    }
    if (event.type === "usage") {
      const contextWindowTokens = this.#state.effectiveModel
        ? this.#modelState.contextWindowTokensByModel.get(this.#state.effectiveModel.id)
        : undefined;
      const usage = usageFromUpdate(event.update, event.metadata, contextWindowTokens);
      if (usage) this.#publishUsage(usage, active.command.turnId);
      return;
    }
    if (event.type === "agent.text") this.#appendAgent(active, event.text);
    else if (event.type === "agent.thought") this.#appendReasoning(active, event.text);
    else if (event.type === "tool.call") this.#startTool(active, event);
    else if (event.type === "tool.update") this.#updateTool(active, event);
    // Usage metadata rides along on message and tool updates; the underlying
    // event still projected normally above.
    if (event.metadata && usageFromMetadata(event.metadata)) {
      const contextWindowTokens = this.#state.effectiveModel
        ? this.#modelState.contextWindowTokensByModel.get(this.#state.effectiveModel.id)
        : undefined;
      const usage = usageFromUpdate(undefined, event.metadata, contextWindowTokens);
      if (usage) this.#publishUsage(usage, active.command.turnId);
    }
  }

  #appendAgent(active: ActiveTurn, text: string): void {
    if (!active.agent) {
      this.#completeReasoning(active, { status: "succeeded" });
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

  #appendReasoning(active: ActiveTurn, text: string): void {
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

  #startTool(
    active: ActiveTurn,
    event: Extract<QwenCodeTransportEvent, { type: "tool.call" }>,
  ): void {
    this.#completeReasoning(active, { status: "succeeded" });
    this.#completeAgent(active, { status: "succeeded" });
    let item = startQwenCodeToolItem({
      itemId: hostItemIdSchema.parse(this.#randomUUID()),
      name: event.name,
      title: event.title,
      kind: event.kind,
      rawInput: event.rawInput,
      cwd: this.#cwd,
    });
    const projection = projectQwenCodeToolOutput(
      event.content,
      event.rawOutput,
      this.#toolOutputLimit,
    );
    if (hasQwenCodeToolProjection(projection)) item = applyQwenCodeToolProjection(item, projection);
    active.tools.set(event.callId, {
      item,
      rawInput: event.rawInput,
      ...(event.status ? { status: event.status } : {}),
    });
    this.#event({ type: "item.started", turnId: active.command.turnId, item });
    if (event.status === "completed" || event.status === "failed") {
      this.#completeTool(active, event.callId, event.status, event.content, event.rawOutput);
    }
  }

  #updateTool(
    active: ActiveTurn,
    event: Extract<QwenCodeTransportEvent, { type: "tool.update" }>,
  ): void {
    const tool = active.tools.get(event.callId);
    if (!tool) return;
    if (event.rawInput !== undefined) tool.rawInput = event.rawInput;
    const projection = projectQwenCodeToolOutput(
      event.content,
      event.rawOutput,
      this.#toolOutputLimit,
    );
    if (hasQwenCodeToolProjection(projection)) {
      const previous = tool.item.type === "commandExecution" ? (tool.item.output ?? "") : undefined;
      tool.item = applyQwenCodeToolProjection(tool.item, projection);
      if (tool.item.type === "commandExecution" && projection.output) {
        const next = tool.item.output ?? "";
        if (previous !== undefined && next.startsWith(previous)) {
          const delta = next.slice(previous.length);
          if (delta.length > 0) {
            this.#event({
              type: "item.updated",
              turnId: active.command.turnId,
              itemId: tool.item.itemId,
              update: { type: "output.append", text: delta },
            });
          }
        }
      } else if (tool.item.type === "toolExecution" && projection.output) {
        this.#event({
          type: "item.updated",
          turnId: active.command.turnId,
          itemId: tool.item.itemId,
          update: { type: "output.replace", output: projection.output },
        });
      }
    }
    if (event.status) tool.status = event.status;
    if (event.status === "completed" || event.status === "failed") {
      this.#completeTool(active, event.callId, event.status, event.content, event.rawOutput);
    }
  }

  #completeTool(
    active: ActiveTurn,
    callId: string,
    status: string,
    content?: unknown[] | null,
    rawOutput?: unknown,
  ): void {
    const tool = active.tools.get(callId);
    if (!tool) return;
    active.tools.delete(callId);
    const projection = projectQwenCodeToolOutput(content, rawOutput, this.#toolOutputLimit);
    if (hasQwenCodeToolProjection(projection)) {
      tool.item = applyQwenCodeToolProjection(tool.item, projection);
    }
    const outcome: HostItemOutcome =
      status === "failed"
        ? {
            status: "failed",
            error: {
              code: "nativeFailure",
              message: `Qwen Code Tool '${qwenCodeToolLabel(tool.item)}' failed`,
              retryable: false,
            },
          }
        : { status: "succeeded" };
    this.#completeItem(active, tool.item, outcome);
    if (status !== "completed") return;
    const changes = projectQwenCodeFileChanges(content, this.#cwd, tool.rawInput);
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
    if (item) this.#completeItem(active, item, outcome);
  }

  #completeReasoning(active: ActiveTurn, outcome: HostItemOutcome): void {
    const item = active.reasoning;
    active.reasoning = null;
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

  #finish(active: ActiveTurn, outcome: TurnOutcome): void {
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
    const nativeTurnRef: NativeTurnRef = {
      harnessId: this.harnessId,
      nativeSessionId: this.#transport.sessionId,
      nativeTurnKey: qwenCodeTurnKey(this.#nextTurnOrdinal),
      formatVersion: 1,
    };
    this.#nextTurnOrdinal += 1;
    const turn: HostTurnSnapshot = {
      nativeTurnRef,
      input: active.command.input,
      items: active.completedItems,
      outcome,
    };
    this.#snapshot.turns = [...this.#snapshot.turns, turn];
    this.#event({
      type: "turn.completed",
      turnId: active.command.turnId,
      nativeTurnRef,
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

  close(): Promise<void> {
    if (!this.#closePromise) this.#closePromise = this.#close().finally(this.#onClosed);
    return this.#closePromise;
  }

  handleTransportFault(error: QwenCodeTransportError): void {
    queueMicrotask(() => this.#fault(error));
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
    if (this.#active) {
      this.#finish(this.#active, {
        status: "failed",
        error: invalidState("Qwen Code Session closed during active Turn"),
      });
    }
    this.#phase = "closed";
    this.#channel.end();
  }

  #fault(error: QwenCodeTransportError): void {
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

export class QwenCodeAdapter implements HarnessAdapter {
  readonly harnessId: HarnessId = qwenCodeHarnessId;
  readonly #closeTimeoutMs: number;
  readonly #dependencies: QwenCodeAdapterDependencies;
  readonly #environment: NodeJS.ProcessEnv | undefined;
  readonly #inspectionCache = new Map<string, Extract<HarnessInspection, { status: "ready" }>>();
  readonly #sessions = new Set<QwenCodeHarnessSession>();
  readonly #toolOutputLimit: number;
  #closePromise: Promise<void> | null = null;

  constructor(options: QwenCodeAdapterOptions = {}, dependencies?: QwenCodeAdapterDependencies) {
    this.#closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
    this.#environment = options.environment;
    this.#toolOutputLimit = options.toolOutputLimit ?? DEFAULT_QWEN_CODE_TOOL_OUTPUT_LIMIT;
    this.#dependencies = dependencies ?? {
      randomUUID,
      createTransport: (transportOptions) =>
        new QwenCodeAcpTransport({ ...options, ...transportOptions }),
    };
  }

  async inspect(input: InspectHarnessInput = {}): Promise<HarnessInspection> {
    if (this.#closePromise) {
      return { status: "unavailable", error: invalidState("Qwen Code Adapter is closed") };
    }
    const cwd = path.resolve(input.cwd ?? process.cwd());
    if (!input.refresh) {
      const cached = this.#inspectionCache.get(cwd);
      if (cached) return cached;
    }
    let transport: QwenCodeAcpTransportLike | null = null;
    const startedAt = Date.now();
    let stage = "spawn";
    try {
      transport = this.#dependencies.createTransport({ cwd });
      stage = "startup";
      const inspected = await transport.inspect();
      stage = "model-catalog";
      const modelState = parseQwenCodeModelState(inspected.models);
      if (!modelState) {
        throw new QwenCodeTransportError(
          "protocolError",
          "Qwen Code returned an invalid Model catalog",
        );
      }
      await transport.close();
      const ready: Extract<HarnessInspection, { status: "ready" }> = {
        status: "ready",
        catalog: modelState.catalog,
        permissionModes: QWEN_CODE_PERMISSION_MODE_CATALOG,
        capabilities: capabilitiesForModels(modelState),
      };
      this.#inspectionCache.set(cwd, ready);
      return ready;
    } catch (error) {
      await transport?.close().catch(() => undefined);
      const normalized = normalizeError(error, "unavailable");
      return {
        status: normalized.code === "notInstalled" ? "notInstalled" : "error",
        error: {
          ...normalized,
          stage,
          durationMs: Date.now() - startedAt,
          ...(normalized.diagnostic || !transport?.stderrTail
            ? {}
            : { stderrTail: transport.stderrTail }),
        },
      };
    }
  }

  async open(input: OpenSessionInput): Promise<HarnessResult<HarnessSession>> {
    if (this.#closePromise) {
      return { ok: false, error: invalidState("Qwen Code Adapter is closed") };
    }
    if (input.cwd.length === 0) {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "Qwen Code Adapter requires cwd",
          retryable: false,
        },
      };
    }
    if (input.kind === "fork" || input.kind === "rollbackLastTurn") {
      return {
        ok: false,
        error: {
          code: "unsupported",
          message: "Qwen Code does not support history Fork or last-Turn rollback",
          retryable: false,
        },
      };
    }
    const cwd = path.resolve(input.cwd);
    let initialPermissionModeId = QWEN_CODE_DEFAULT_PERMISSION_MODE_ID;
    if (input.kind === "create") {
      const requested = input.permissionModeId ?? QWEN_CODE_DEFAULT_PERMISSION_MODE_ID;
      try {
        decodeQwenCodePermissionModeId(requested);
      } catch {
        return {
          ok: false,
          error: {
            code: "invalidRequest",
            message: "Qwen Code create Permission Mode is invalid",
            retryable: false,
          },
        };
      }
      initialPermissionModeId = requested;
    }
    let parsedRef: ReturnType<typeof nativeSessionRefSchema.safeParse> | null = null;
    if (input.kind === "resume") {
      parsedRef = nativeSessionRefSchema.safeParse(input.nativeRef);
      if (!parsedRef.success || parsedRef.data.harnessId !== this.harnessId) {
        return {
          ok: false,
          error: {
            code: "invalidRequest",
            message: "Qwen Code cannot resume another Harness's Native Session",
            retryable: false,
          },
        };
      }
    }
    let session: QwenCodeHarnessSession | null = null;
    const transport = this.#dependencies.createTransport({
      cwd,
      onFault: (error) => session?.handleTransportFault(error),
    });
    try {
      let opened: QwenCodeOpenResult;
      if (input.kind === "create") {
        opened = await transport.open({ kind: "create" });
      } else {
        const resumeRef = parsedRef;
        if (!resumeRef?.success) {
          throw new QwenCodeTransportError(
            "protocolError",
            "Qwen Code resume requires a valid Native Session identity",
          );
        }
        opened = await transport.open({
          kind: "resume",
          sessionId: resumeRef.data.nativeSessionId,
        });
      }
      const modelState = parseQwenCodeModelState(opened.models);
      if (!modelState) {
        throw new QwenCodeTransportError(
          "protocolError",
          "Qwen Code returned an invalid Model catalog",
        );
      }
      if (input.kind === "create") {
        const selectedModel = input.model ?? modelState.currentModel;
        const nativeModelId = nativeModelIdForRef(modelState, selectedModel);
        if (!nativeModelId) {
          throw new QwenCodeTransportError(
            "protocolError",
            "Requested Qwen Code Model is unavailable",
          );
        }
        if (selectedModel.id !== modelState.currentModel.id) {
          await transport.setModel(nativeModelId);
          modelState.currentModel = selectedModel;
        }
        await transport.setPermissionMode(initialPermissionModeId);
      } else {
        initialPermissionModeId =
          currentQwenCodePermissionModeId(opened.sessionModeId) ??
          QWEN_CODE_DEFAULT_PERMISSION_MODE_ID;
      }
      const mapped = mapQwenCodeReplay(
        opened.replay,
        this.harnessId,
        opened.sessionId,
        cwd,
        input.kind === "resume" ? (input.knownTurnRefs ?? []) : [],
        this.#toolOutputLimit,
      );
      const initialUsage =
        input.kind === "resume"
          ? sessionUsageFromReplay(
              opened.replay,
              modelState.contextWindowTokensByModel,
              modelState.currentModel.id,
            )
          : null;
      const openedSession = new QwenCodeHarnessSession(
        cwd,
        transport,
        opened,
        modelState,
        () => this.#sessions.delete(openedSession),
        {
          closeTimeoutMs: this.#closeTimeoutMs,
          history: mapped.turns,
          turnCount: mapped.turnCount,
          initialUsage,
          initialPermissionModeId,
          randomUUID: this.#dependencies.randomUUID,
          toolOutputLimit: this.#toolOutputLimit,
        },
      );
      session = openedSession;
      this.#sessions.add(openedSession);
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
}
