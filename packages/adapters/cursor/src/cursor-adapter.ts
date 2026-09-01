import { randomUUID } from "node:crypto";
import path from "node:path";

import type {
  PermissionOption,
  PromptResponse,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import {
  HarnessOutputChannel,
  parseHostUsage,
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
  type HostCommandExecutionItem,
  type HostEvent,
  type HostItem,
  type HostItemOutcome,
  type HostItemSnapshot,
  type HostReasoningItem,
  type HostThreadSnapshot,
  type HostToolExecutionItem,
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
  harnessModelCatalogSchema,
  hostInteractionIdSchema,
  hostItemIdSchema,
  jsonValueSchema,
  nativeSessionRefSchema,
  type HarnessId,
  type HostInteractionId,
  type NativeSessionRef,
  type NativeTurnRef,
} from "@codexhost/shared-contracts";

import {
  CursorAcpTransport,
  CursorTransportError,
  type CursorAcpTransportLike,
  type CursorAcpTransportOptions,
  type CursorOpenInput,
  type CursorOpenResult,
  type CursorPermissionRequest,
  type CursorTransportEvent,
} from "./acp-transport.js";
import { CursorExecutableError } from "./command.js";
import { mapCursorReplay, nativeTurnRefFor, usageFromCursorEvent } from "./cursor-history.js";

export const CURSOR_HARNESS_ID = "cursor";
const cursorHarnessId = harnessIdSchema.parse(CURSOR_HARNESS_ID);
const EMPTY_CATALOG = harnessModelCatalogSchema.parse({ models: [], thinkingOptions: [] });
const DEFAULT_CLOSE_TIMEOUT_MS = 2_000;
const DEFAULT_TOOL_OUTPUT_LIMIT = 64_000;

export const CURSOR_SESSION_CAPABILITIES: HarnessSessionCapabilities = {
  configuration: {
    selectModel: false,
    selectThinkingOption: false,
    selectPermissionMode: false,
  },
  history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
};

export interface CursorAdapterOptions {
  command?: string;
  environment?: NodeJS.ProcessEnv;
  commandTimeoutMs?: number;
  closeTimeoutMs?: number;
  toolOutputLimit?: number;
}

export interface CursorAdapterDependencies {
  createTransport(options: CursorAcpTransportOptions): CursorAcpTransportLike;
  randomUUID(): string;
}

interface ActiveTool {
  item: HostCommandExecutionItem | HostToolExecutionItem;
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

function invalidState(message: string): HarnessError {
  return { code: "invalidState", message, retryable: false };
}

function unsupported(message: string): HarnessError {
  return { code: "unsupported", message, retryable: false };
}

function normalizeError(error: unknown, fallback: HarnessError["code"]): HarnessError {
  if (error instanceof CursorTransportError) {
    const code: HarnessError["code"] =
      error.kind === "notExecutable" || error.kind === "wrongIdentity" ? "unavailable" : error.kind;
    return {
      code,
      message: error.message,
      retryable: !["notInstalled", "protocolError", "wrongIdentity"].includes(error.kind),
      ...(error.diagnostic ? { diagnostic: error.diagnostic } : {}),
      ...(error.kind === "notExecutable" || error.kind === "wrongIdentity"
        ? { stage: error.kind }
        : {}),
    };
  }
  if (error instanceof CursorExecutableError) {
    return {
      code: error.kind === "notInstalled" ? "notInstalled" : "unavailable",
      message: error.message,
      retryable: false,
      ...(error.diagnostic ? { diagnostic: error.diagnostic } : {}),
      stage: error.kind,
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
    harnessId: cursorHarnessId,
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
      message: `Cursor stopped the Turn: ${response.stopReason}`,
      retryable:
        response.stopReason === "max_tokens" || response.stopReason === "max_turn_requests",
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toolArguments(rawInput: unknown) {
  const parsed = jsonValueSchema.safeParse(rawInput);
  return parsed.success ? parsed.data : {};
}

function toolOutputText(value: unknown, limit: number): string | undefined {
  if (typeof value === "string" && value.length > 0) return value.slice(0, limit);
  if (isRecord(value) && typeof value.text === "string") return value.text.slice(0, limit);
  if (Array.isArray(value)) {
    const text = value
      .map((entry) => (isRecord(entry) && typeof entry.text === "string" ? entry.text : ""))
      .join("");
    return text.length > 0 ? text.slice(0, limit) : undefined;
  }
  return undefined;
}

function isExecuteTool(
  event: Extract<CursorTransportEvent, { type: "tool.call" | "tool.update" }>,
): boolean {
  if (event.kind === "execute") return true;
  return typeof event.name === "string" && /^(bash|shell|run_terminal_command)$/iu.test(event.name);
}

class CursorHarnessSession implements HarnessSession {
  readonly harnessId: HarnessId = cursorHarnessId;
  readonly capabilities: HarnessSessionCapabilities = CURSOR_SESSION_CAPABILITIES;
  readonly initialState: HarnessSessionState;
  readonly initialUsage: HostUsage | null = null;
  readonly outputs: AsyncIterable<HarnessOutput>;
  readonly #channel = new HarnessOutputChannel<HarnessOutput>();
  readonly #closeTimeoutMs: number;
  readonly #onClosed: () => void;
  readonly #randomUUID: () => string;
  readonly #toolOutputLimit: number;
  readonly #transport: CursorAcpTransportLike;
  #active: ActiveTurn | null = null;
  #closePromise: Promise<void> | null = null;
  #phase: SessionPhase = "open";
  #snapshot: HostThreadSnapshot;
  #state: HarnessSessionState;
  #usage: HostUsage | null = null;

  constructor(
    transport: CursorAcpTransportLike,
    opened: CursorOpenResult,
    onClosed: () => void,
    options: {
      closeTimeoutMs: number;
      knownTurnRefs?: NativeTurnRef[];
      randomUUID: () => string;
      toolOutputLimit: number;
    },
  ) {
    this.#transport = transport;
    this.#onClosed = onClosed;
    this.#closeTimeoutMs = options.closeTimeoutMs;
    this.#randomUUID = options.randomUUID;
    this.#toolOutputLimit = options.toolOutputLimit;
    this.#state = { nativeRef: nativeRef(opened.sessionId) };
    this.initialState = this.#state;
    this.#snapshot = {
      ...mapCursorReplay(
        opened.replay,
        cursorHarnessId,
        opened.sessionId,
        options.knownTurnRefs ?? [],
        options.toolOutputLimit,
      ),
      state: this.#state,
    };
    this.outputs = this.#channel.outputs;
  }

  async readSnapshot(): Promise<HarnessResult<HostThreadSnapshot>> {
    if (this.#phase !== "open")
      return { ok: false, error: invalidState("Cursor Session is not open") };
    if (this.#active) {
      return {
        ok: false,
        error: {
          code: "sessionBusy",
          message: "Cursor Session cannot read history during another operation",
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
    if (this.#phase !== "open")
      return { ok: false, error: invalidState("Cursor Session is not open") };
    if (command.type === "turn.cancel") return this.#cancel(command);
    if (command.type === "interaction.respond") return this.#respond(command);
    if (command.type === "model.select") {
      return { ok: false, error: unsupported("Cursor does not expose Model selection over ACP") };
    }
    if (command.type === "thinking.select") {
      return {
        ok: false,
        error: unsupported("Cursor does not expose Thinking selection over ACP"),
      };
    }
    if (command.type === "permissionMode.select") {
      return {
        ok: false,
        error: unsupported("Cursor does not expose Permission Mode selection over ACP"),
      };
    }
    if (this.#active) {
      return {
        ok: false,
        error: {
          code: "sessionBusy",
          message: "Cursor Session already has an active operation",
          retryable: true,
        },
      };
    }
    const text = command.input.map(({ text: value }) => value).join("\n");
    if (text.length === 0) {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "Cursor text Turn must not be empty",
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
        (response) =>
          this.#finishTurn(active, terminalOutcome(response, active.cancellationRequested)),
        (error) =>
          this.#finishTurn(active, {
            status: "failed",
            error: normalizeError(error, "nativeFailure"),
          }),
      );
    return { ok: true, value: { turnId: command.turnId } };
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#close().finally(this.#onClosed);
    return this.#closePromise;
  }

  async #cancel(command: TurnCancelCommand): Promise<HarnessResult<TurnCancelAccepted>> {
    const active = this.#active;
    if (!active || active.command.turnId !== command.turnId) {
      return {
        ok: false,
        error: invalidState("Cursor Turn Cancel must reference the active Turn"),
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
      return { ok: false, error: invalidState("Cursor Approval is not pending") };
    if (command.response.type !== "approval") {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "Cursor Approval requires an Approval Response",
          retryable: false,
        },
      };
    }
    const validation = validateHostApprovalResponse(pending.interaction, command.response);
    if (validation) return { ok: false, error: validation };
    const option = pending.options.get(command.response.actionId);
    if (!option) {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "Cursor Approval action is unavailable",
          retryable: false,
        },
      };
    }
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
    request: CursorPermissionRequest,
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
      title: request.request.toolCall.title ?? "Cursor Tool",
      subject: { type: "nativeAction" },
      actions,
    };
    return new Promise((resolve) => {
      active.approvals.set(interactionId, { interaction, options, resolve });
      this.#channel.emit({ kind: "interaction", interaction });
    });
  }

  #handleEvent(active: ActiveTurn, event: CursorTransportEvent): void {
    if (this.#active !== active || this.#phase !== "open") return;
    const usage = usageFromCursorEvent(event);
    if (usage) {
      try {
        this.#publishUsage(parseHostUsage(usage), active.command.turnId);
      } catch {
        // Usage is optional telemetry and must not fail an otherwise valid Turn.
      }
    }
    if (event.type === "agent.text") this.#appendAgent(active, event.text);
    else if (event.type === "agent.thought") this.#appendReasoning(active, event.text);
    else if (event.type === "tool.call") this.#startTool(active, event);
    else if (event.type === "tool.update") this.#updateTool(active, event);
  }

  #appendAgent(active: ActiveTurn, text: string): void {
    if (text.length === 0) return;
    if (!active.agent) {
      active.agent = {
        type: "agentMessage",
        itemId: hostItemIdSchema.parse(this.#randomUUID()),
        text: "",
      };
      this.#event({
        type: "item.started",
        turnId: active.command.turnId,
        item: { ...active.agent },
      });
    }
    active.agent = { ...active.agent, text: `${active.agent.text}${text}` };
    this.#event({
      type: "item.updated",
      turnId: active.command.turnId,
      itemId: active.agent.itemId,
      update: { type: "text.append", text },
    });
  }

  #appendReasoning(active: ActiveTurn, text: string): void {
    if (text.length === 0) return;
    if (!active.reasoning) {
      active.reasoning = {
        type: "reasoning",
        itemId: hostItemIdSchema.parse(this.#randomUUID()),
        text: "",
      };
      this.#event({
        type: "item.started",
        turnId: active.command.turnId,
        item: { ...active.reasoning },
      });
    }
    active.reasoning = { ...active.reasoning, text: `${active.reasoning.text}${text}` };
    this.#event({
      type: "item.updated",
      turnId: active.command.turnId,
      itemId: active.reasoning.itemId,
      update: { type: "text.append", text },
    });
  }

  #startTool(
    active: ActiveTurn,
    event: Extract<CursorTransportEvent, { type: "tool.call" }>,
  ): void {
    const execute = isExecuteTool(event);
    const output = toolOutputText(event.rawOutput ?? event.content, this.#toolOutputLimit);
    const item: HostCommandExecutionItem | HostToolExecutionItem = execute
      ? {
          type: "commandExecution",
          itemId: hostItemIdSchema.parse(this.#randomUUID()),
          command:
            isRecord(event.rawInput) && typeof event.rawInput.command === "string"
              ? event.rawInput.command
              : event.title,
          ...(output ? { output } : {}),
        }
      : {
          type: "toolExecution",
          itemId: hostItemIdSchema.parse(this.#randomUUID()),
          toolName: event.name ?? event.title,
          arguments: toolArguments(event.rawInput),
          ...(output ? { output: { content: [{ type: "text", text: output }] } } : {}),
        };
    active.tools.set(event.callId, { item });
    this.#event({ type: "item.started", turnId: active.command.turnId, item });
    if (event.status === "completed" || event.status === "failed") {
      this.#completeTool(active, event.callId, event.status);
    }
  }

  #updateTool(
    active: ActiveTurn,
    event: Extract<CursorTransportEvent, { type: "tool.update" }>,
  ): void {
    const tool = active.tools.get(event.callId);
    if (!tool) return;
    const output = toolOutputText(event.rawOutput ?? event.content, this.#toolOutputLimit);
    if (tool.item.type === "commandExecution" && output) {
      const previous = tool.item.output ?? "";
      const next = { ...tool.item, output };
      tool.item = next;
      if (output.startsWith(previous)) {
        const delta = output.slice(previous.length);
        if (delta.length > 0) {
          this.#event({
            type: "item.updated",
            turnId: active.command.turnId,
            itemId: next.itemId,
            update: { type: "output.append", text: delta },
          });
        }
      }
    } else if (tool.item.type === "toolExecution" && output) {
      const toolOutput = { content: [{ type: "text" as const, text: output }] };
      const next = { ...tool.item, output: toolOutput };
      tool.item = next;
      this.#event({
        type: "item.updated",
        turnId: active.command.turnId,
        itemId: next.itemId,
        update: { type: "output.replace", output: toolOutput },
      });
    }
    if (event.status === "completed" || event.status === "failed") {
      this.#completeTool(active, event.callId, event.status);
    }
  }

  #completeTool(active: ActiveTurn, callId: string, status: "completed" | "failed"): void {
    const tool = active.tools.get(callId);
    if (!tool) return;
    active.tools.delete(callId);
    const outcome: HostItemOutcome =
      status === "failed"
        ? {
            status: "failed",
            error: { code: "nativeFailure", message: "Cursor tool failed", retryable: false },
          }
        : { status: "succeeded" };
    this.#completeItem(active, tool.item, outcome);
  }

  #completeItem(active: ActiveTurn, item: HostItem, outcome: HostItemOutcome): void {
    const snapshot = { item, outcome };
    active.completedItems.push(snapshot);
    this.#event({ type: "item.completed", turnId: active.command.turnId, snapshot });
  }

  #finishTurn(active: ActiveTurn, outcome: TurnOutcome): void {
    if (this.#active !== active) return;
    const itemOutcome: HostItemOutcome = outcome;
    if (active.reasoning) {
      this.#completeItem(active, active.reasoning, itemOutcome);
      active.reasoning = null;
    }
    if (active.agent) {
      this.#completeItem(active, active.agent, itemOutcome);
      active.agent = null;
    }
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
    const ordinal = this.#snapshot.turns.length + 1;
    const nativeTurnRef = nativeTurnRefFor(cursorHarnessId, this.#transport.sessionId, ordinal);
    this.#snapshot = {
      turns: [
        ...this.#snapshot.turns,
        {
          nativeTurnRef,
          input: active.command.input,
          items: [...active.completedItems],
          outcome:
            outcome.status === "succeeded"
              ? { status: "succeeded" }
              : outcome.status === "cancelled"
                ? {
                    status: "cancelled",
                    ...(outcome.reason ? { reason: outcome.reason } : {}),
                  }
                : { status: "failed", error: outcome.error },
        },
      ],
      state: this.#state,
    };
    this.#active = null;
    this.#event({
      type: "turn.completed",
      turnId: active.command.turnId,
      nativeTurnRef,
      outcome,
    });
    active.resolveCompletion();
  }

  #publishUsage(usage: HostUsage, observedForTurnId: TurnStartCommand["turnId"]): void {
    this.#usage = usage;
    this.#event({ type: "session.usage.changed", usage, observedForTurnId });
  }

  async #close(): Promise<void> {
    if (this.#phase === "closed") return;
    this.#phase = "closing";
    const active = this.#active;
    if (active) {
      active.cancellationRequested = true;
      for (const approval of active.approvals.values()) {
        approval.resolve({ outcome: { outcome: "cancelled" } });
      }
      await this.#transport.cancel().catch(() => undefined);
      await Promise.race([
        active.completion,
        new Promise((resolve) => setTimeout(resolve, this.#closeTimeoutMs)),
      ]);
    }
    await this.#transport.close();
    if (this.#active) {
      this.#finishTurn(this.#active, {
        status: "failed",
        error: invalidState("Cursor Session closed during active Turn"),
      });
    }
    this.#phase = "closed";
    this.#channel.end();
  }

  fault(error: CursorTransportError): void {
    if (this.#phase !== "open") return;
    const normalized = normalizeError(error, "processExited");
    if (this.#active) this.#finishTurn(this.#active, { status: "failed", error: normalized });
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

export class CursorAdapter implements HarnessAdapter {
  readonly harnessId: HarnessId = cursorHarnessId;
  readonly #closeTimeoutMs: number;
  readonly #command: string | undefined;
  readonly #commandTimeoutMs: number | undefined;
  readonly #dependencies: CursorAdapterDependencies;
  readonly #environment: NodeJS.ProcessEnv | undefined;
  readonly #inspectionCache = new Map<string, Extract<HarnessInspection, { status: "ready" }>>();
  readonly #sessions = new Set<CursorHarnessSession>();
  readonly #toolOutputLimit: number;
  #closePromise: Promise<void> | null = null;

  constructor(options: CursorAdapterOptions = {}, dependencies?: CursorAdapterDependencies) {
    this.#closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
    this.#command = options.command;
    this.#commandTimeoutMs = options.commandTimeoutMs;
    this.#environment = options.environment;
    this.#toolOutputLimit = options.toolOutputLimit ?? DEFAULT_TOOL_OUTPUT_LIMIT;
    this.#dependencies = dependencies ?? {
      randomUUID,
      createTransport: (transportOptions) =>
        new CursorAcpTransport({
          ...transportOptions,
          ...(options.command ? { command: options.command } : {}),
          ...(options.commandTimeoutMs ? { commandTimeoutMs: options.commandTimeoutMs } : {}),
          ...(options.closeTimeoutMs ? { closeTimeoutMs: options.closeTimeoutMs } : {}),
        }),
    };
  }

  async inspect(input: InspectHarnessInput = {}): Promise<HarnessInspection> {
    if (this.#closePromise) {
      return { status: "unavailable", error: invalidState("Cursor Adapter is closed") };
    }
    const cwd = path.resolve(input.cwd ?? process.cwd());
    if (!input.refresh) {
      const cached = this.#inspectionCache.get(cwd);
      if (cached) return cached;
    }
    let transport: CursorAcpTransportLike | null = null;
    const startedAt = Date.now();
    let stage = "discover";
    try {
      transport = this.#createTransport(cwd, () => undefined);
      stage = "initialize";
      const initialize = await transport.inspect();
      stage = "capabilities";
      if (typeof initialize.protocolVersion !== "number") {
        throw new CursorTransportError("protocolError", "Cursor ACP returned no protocol version");
      }
      await transport.close();
      const ready: Extract<HarnessInspection, { status: "ready" }> = {
        status: "ready",
        catalog: EMPTY_CATALOG,
        capabilities: CURSOR_SESSION_CAPABILITIES,
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
          stage: normalized.stage ?? stage,
          durationMs: Date.now() - startedAt,
          ...(normalized.diagnostic || !transport?.stderrTail
            ? {}
            : { stderrTail: transport.stderrTail }),
        },
      };
    }
  }

  async open(input: OpenSessionInput): Promise<HarnessResult<HarnessSession>> {
    if (this.#closePromise) return { ok: false, error: invalidState("Cursor Adapter is closed") };
    if (input.cwd.length === 0) {
      return {
        ok: false,
        error: { code: "invalidRequest", message: "Cursor Adapter requires cwd", retryable: false },
      };
    }
    if (input.kind === "fork") {
      return { ok: false, error: unsupported("Cursor ACP does not advertise session/fork") };
    }
    if (input.kind === "rollbackLastTurn") {
      return { ok: false, error: unsupported("Cursor ACP does not support last-Turn rollback") };
    }
    if (input.kind === "create") {
      if (input.model) {
        return { ok: false, error: unsupported("Cursor does not expose Model selection over ACP") };
      }
      if (input.thinkingOptionId) {
        return {
          ok: false,
          error: unsupported("Cursor does not expose Thinking selection over ACP"),
        };
      }
      if (input.permissionModeId) {
        return {
          ok: false,
          error: unsupported("Cursor does not expose Permission Mode selection over ACP"),
        };
      }
      if (input.executionPolicy === "unattended-full-access") {
        return {
          ok: false,
          error: unsupported("Cursor ACP still requests runtime permission for tool execution"),
        };
      }
    }
    if (input.kind === "resume" && input.nativeRef.harnessId !== cursorHarnessId) {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "Native Session does not belong to Cursor",
          retryable: false,
        },
      };
    }

    let transport: CursorAcpTransportLike | null = null;
    let session: CursorHarnessSession | undefined;
    try {
      transport = this.#createTransport(
        path.resolve(input.cwd),
        (error) => session?.fault(error),
        input.environment,
      );
      const openInput: CursorOpenInput =
        input.kind === "resume"
          ? { kind: "resume", sessionId: input.nativeRef.nativeSessionId }
          : { kind: "create" };
      if (openInput.kind === "resume") {
        const initialize = await transport.inspect();
        if (initialize.agentCapabilities?.loadSession !== true) {
          await transport.close().catch(() => undefined);
          return { ok: false, error: unsupported("Cursor ACP does not advertise session/load") };
        }
      }
      const opened = await transport.open(openInput);
      if (input.kind === "resume" && opened.sessionId !== input.nativeRef.nativeSessionId) {
        await transport.close().catch(() => undefined);
        return {
          ok: false,
          error: {
            code: "sessionNotFound",
            message: "Cursor ACP resumed a different Native Session identity",
            retryable: false,
          },
        };
      }
      session = new CursorHarnessSession(
        transport,
        opened,
        () => {
          if (session) this.#sessions.delete(session);
        },
        {
          closeTimeoutMs: this.#closeTimeoutMs,
          ...(input.kind === "resume" ? { knownTurnRefs: input.knownTurnRefs } : {}),
          randomUUID: this.#dependencies.randomUUID,
          toolOutputLimit: this.#toolOutputLimit,
        },
      );
      this.#sessions.add(session);
      return { ok: true, value: session };
    } catch (error) {
      await transport?.close().catch(() => undefined);
      return { ok: false, error: normalizeError(error, "unavailable") };
    }
  }

  close(): Promise<void> {
    this.#closePromise ??= Promise.all([...this.#sessions].map((session) => session.close())).then(
      () => undefined,
    );
    return this.#closePromise;
  }

  #createTransport(
    cwd: string,
    onFault: (error: CursorTransportError) => void,
    environment?: NodeJS.ProcessEnv,
  ): CursorAcpTransportLike {
    const spawnEnvironment = environment ?? this.#environment;
    return this.#dependencies.createTransport({
      cwd,
      ...(this.#command ? { command: this.#command } : {}),
      ...(spawnEnvironment ? { environment: spawnEnvironment } : {}),
      ...(this.#commandTimeoutMs ? { commandTimeoutMs: this.#commandTimeoutMs } : {}),
      closeTimeoutMs: this.#closeTimeoutMs,
      onFault,
    });
  }
}
