import { randomUUID } from "node:crypto";
import path from "node:path";

import {
  HarnessOutputChannel,
  validateHostApprovalResponse,
  validateHostQuestionResponse,
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
  type HostEvent,
  type HostCommand,
  type HostQuestionInteraction,
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
  harnessPermissionModeIdSchema,
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
  QwenCodeSdkTransport,
  QwenCodeTransportError,
  type QwenCodeOpenResult,
  type QwenCodePermissionRequest,
  type QwenCodePermissionResponse,
  type QwenCodeSdkTransportOptions,
  type QwenCodeTransportEvent,
} from "./sdk-transport.js";
import {
  QWEN_CODE_DEFAULT_PERMISSION_MODE_ID,
  QWEN_CODE_PERMISSION_MODE_CATALOG,
  decodeQwenCodePermissionModeId,
} from "./permission-modes.js";
import {
  nativeModelIdForRef,
  parseQwenCodeModelState,
  stateForQwenCodeModel,
  type QwenCodeModelState,
} from "./qwen-models.js";
import { qwenCodeTurnKey, readQwenCodeHistory } from "./qwen-history.js";
import {
  applyQwenCodeToolProjection,
  DEFAULT_QWEN_CODE_TOOL_OUTPUT_LIMIT,
  hasQwenCodeToolProjection,
  projectQwenCodeToolOutput,
  qwenCodeToolLabel,
  startQwenCodeToolItem,
  type QwenCodeProjectedToolItem,
} from "./qwen-tool-output.js";
import { combineUsage, usageFromMetadata } from "./qwen-usage.js";

export interface QwenCodeAdapterOptions {
  command?: string;
  environment?: NodeJS.ProcessEnv;
  commandTimeoutMs?: number;
  closeTimeoutMs?: number;
  toolOutputLimit?: number;
}

export interface QwenCodeAdapterDependencies {
  createTransport(options: QwenCodeSdkTransportOptions): QwenCodeSdkTransportLike;
  randomUUID(): string;
}

export interface QwenCodeSdkTransportLike {
  readonly sessionId: string;
  inspect(): Promise<{ models: unknown }>;
  open(input: {
    kind: "create" | "resume";
    sessionId?: string;
    model?: string;
    permissionMode: HarnessPermissionModeId;
  }): Promise<QwenCodeOpenResult>;
  runTurn(
    text: string,
    onEvent: (event: QwenCodeTransportEvent) => void,
    onPermission: (request: QwenCodePermissionRequest) => Promise<QwenCodePermissionResponse>,
  ): Promise<{
    status: "succeeded" | "failed" | "cancelled";
    error?: QwenCodeTransportError;
  }>;
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

interface ActiveInteraction {
  interaction: HostApprovalInteraction | HostQuestionInteraction;
  request: QwenCodePermissionRequest;
  resolve(response: QwenCodePermissionResponse): void;
}

interface ActiveTurn {
  command: TurnStartCommand;
  agent: HostAgentMessageItem | null;
  reasoning: HostReasoningItem | null;
  tools: Map<string, ActiveTool>;
  completedItems: HostItemSnapshot[];
  approvals: Map<HostInteractionId, ActiveInteraction>;
  cancellationRequested: boolean;
  completion: Promise<void>;
  resolveCompletion(): void;
}

type SessionPhase = "open" | "closing" | "closed" | "faulted";

const qwenCodeHarnessId = harnessIdSchema.parse("qwen-code");
const qwenCodeUnattendedPermissionModeId = harnessPermissionModeIdSchema.parse("yolo");
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
function qwenQuestions(input: Record<string, unknown>): Array<{
  header?: string;
  question: string;
  options: Array<{ label: string; description?: string }>;
  multiple: boolean;
}> | null {
  const questions = input.questions;
  if (!Array.isArray(questions)) return null;
  const parsed = questions.flatMap((candidate) => {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return [];
    const value = candidate as Record<string, unknown>;
    if (typeof value.question !== "string" || !Array.isArray(value.options)) return [];
    const options = value.options.flatMap((option) => {
      if (typeof option !== "object" || option === null || Array.isArray(option)) return [];
      const entry = option as Record<string, unknown>;
      return typeof entry.label === "string"
        ? [
            {
              label: entry.label,
              ...(typeof entry.description === "string" ? { description: entry.description } : {}),
            },
          ]
        : [];
    });
    return options.length > 0
      ? [
          {
            question: value.question,
            ...(typeof value.header === "string" ? { header: value.header } : {}),
            options,
            multiple: value.multiSelect === true,
          },
        ]
      : [];
  });
  return parsed.length === questions.length && parsed.length > 0 ? parsed : null;
}

function nativeRef(sessionId: string): NativeSessionRef {
  return nativeSessionRefSchema.parse({
    harnessId: qwenCodeHarnessId,
    nativeSessionId: sessionId,
    formatVersion: 1,
  });
}

function terminalOutcome(
  response: {
    status: "succeeded" | "failed" | "cancelled";
    error?: QwenCodeTransportError;
  },
  cancelled: boolean,
): TurnOutcome {
  if (response.status === "cancelled" || cancelled) {
    return { status: "cancelled", reason: "Cancelled by user" };
  }
  if (response.status === "succeeded") return { status: "succeeded" };
  return {
    status: "failed",
    error: response.error
      ? normalizeError(response.error, "nativeFailure")
      : {
          code: "nativeFailure",
          message: "Qwen Code SDK failed the Turn",
          retryable: false,
        },
  };
}

function capabilitiesForModels(modelState: QwenCodeModelState): HarnessSessionCapabilities {
  return {
    configuration: {
      permissionModeScope: "live",
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
  readonly #transport: QwenCodeSdkTransportLike;
  #active: ActiveTurn | null = null;
  #closePromise: Promise<void> | null = null;
  #configuring = false;
  #nextTurnOrdinal: number;
  #phase: SessionPhase = "open";
  #state: HarnessSessionState;
  #usage: HostUsage | null = null;

  constructor(
    cwd: string,
    transport: QwenCodeSdkTransportLike,
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
      approval.resolve({ behavior: "deny" });
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
      return { ok: false, error: invalidState("Qwen Code interaction is not pending") };
    if (pending.interaction.type === "question") {
      if (command.response.type !== "question")
        return {
          ok: false,
          error: invalidState("Qwen Code Question requires a Question Response"),
        };
      const validation = validateHostQuestionResponse(pending.interaction, command.response);
      if (validation) return { ok: false, error: validation };
      active.approvals.delete(command.interactionId);
      if (command.response.cancelled) pending.resolve({ behavior: "deny" });
      else {
        const answers: Record<string, string> = {};
        for (const [index, question] of pending.interaction.questions.entries())
          answers[String(index)] = command.response.answers[question.id]?.join(", ") ?? "";
        pending.resolve({ behavior: "allow", updatedInput: { ...pending.request.input, answers } });
      }
    } else {
      if (command.response.type !== "approval")
        return {
          ok: false,
          error: invalidState("Qwen Code Approval requires an Approval Response"),
        };
      const validation = validateHostApprovalResponse(pending.interaction, command.response);
      if (validation) return { ok: false, error: validation };
      if (command.response.actionId !== "allow" && command.response.actionId !== "deny")
        return { ok: false, error: invalidState("Qwen Code Approval action is unavailable") };
      active.approvals.delete(command.interactionId);
      const behavior = command.response.actionId;
      pending.resolve({
        behavior,
        ...(behavior === "allow" ? { updatedInput: pending.request.input } : {}),
      });
    }
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
  ): Promise<QwenCodePermissionResponse> {
    if (this.#active !== active || active.cancellationRequested)
      return Promise.resolve({ behavior: "deny" });
    const interactionId = hostInteractionIdSchema.parse(this.#randomUUID());
    const questions =
      request.toolName === "ask_user_question" ? qwenQuestions(request.input) : null;
    const interaction: HostApprovalInteraction | HostQuestionInteraction = questions
      ? {
          type: "question" as const,
          interactionId,
          turnId: active.command.turnId,
          ...(questions.length === 1 && questions[0]?.header
            ? { title: questions[0].header }
            : { title: "Qwen Code" }),
          questions: questions.map((question, index) => ({
            id: `question-${index}`,
            type: "choice" as const,
            prompt: question.question,
            options: question.options.map((option) => ({
              value: option.label,
              label: option.label,
              ...(option.description ? { description: option.description } : {}),
            })),
            multiple: question.multiple,
            allowOther: true,
            optional: false,
          })),
        }
      : {
          type: "approval",
          interactionId,
          turnId: active.command.turnId,
          title: request.toolName,
          subject: { type: "nativeAction" },
          actions: [
            { id: "allow", label: "Allow", effect: "allowOnce" },
            { id: "deny", label: "Deny", effect: "deny" },
          ],
        };
    return new Promise<QwenCodePermissionResponse>((resolve) => {
      active.approvals.set(interactionId, { interaction, request, resolve });
      this.#channel.emit({ kind: "interaction", interaction });
    });
  }

  #handleEvent(active: ActiveTurn, event: QwenCodeTransportEvent): void {
    if (this.#active !== active || this.#phase !== "open") return;
    if (event.type === "usage") {
      const usage = usageFromMetadata(event.metadata);
      if (usage) this.#publishUsage(usage, active.command.turnId);
      return;
    }
    if (event.type === "agent.text") this.#appendAgent(active, event.text);
    else if (event.type === "agent.thought") this.#appendReasoning(active, event.text);
    else if (event.type === "tool.call") this.#startTool(active, event);
    else if (event.type === "tool.update") this.#updateTool(active, event);
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
      pending.resolve({ behavior: "deny" });
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
      for (const approval of active.approvals.values()) approval.resolve({ behavior: "deny" });
      const { promise: deadline, resolve } = Promise.withResolvers<undefined>();
      const timeout = setTimeout(() => resolve(undefined), this.#closeTimeoutMs);
      try {
        await Promise.race([
          (async () => {
            await this.#transport.cancel().catch(() => undefined);
            await active.completion;
          })(),
          deadline,
        ]);
      } finally {
        clearTimeout(timeout);
      }
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
        new QwenCodeSdkTransport({ ...options, ...transportOptions }),
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
    let transport: QwenCodeSdkTransportLike | null = null;
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
      const requested =
        input.permissionModeId ??
        (input.executionPolicy === "unattended-full-access"
          ? qwenCodeUnattendedPermissionModeId
          : QWEN_CODE_DEFAULT_PERMISSION_MODE_ID);
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
      ...(input.environment ? { environment: input.environment } : {}),
    });
    try {
      let opened: QwenCodeOpenResult;
      if (input.kind === "create") {
        opened = await transport.open({ kind: "create", permissionMode: initialPermissionModeId });
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
          permissionMode: initialPermissionModeId,
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
      }
      const history: HostTurnSnapshot[] =
        input.kind === "resume"
          ? (
              await readQwenCodeHistory(
                cwd,
                this.harnessId,
                opened.sessionId,
                input.knownTurnRefs,
                this.#toolOutputLimit,
              )
            ).turns
          : [];
      const initialUsage = null;
      const openedSession = new QwenCodeHarnessSession(
        cwd,
        transport,
        opened,
        modelState,
        () => this.#sessions.delete(openedSession),
        {
          closeTimeoutMs: this.#closeTimeoutMs,
          history,
          turnCount: input.kind === "resume" ? (input.knownTurnRefs?.length ?? 0) : 0,
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
