import { randomUUID } from "node:crypto";

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
  type HarnessModelRef,
  type HostUsage,
  type HostAgentMessageItem,
  type HostApprovalInteraction,
  type HostCommand,
  type HostEvent,
  type HostItemOutcome,
  type HostReasoningItem,
  type HostThreadSnapshot,
  type HostToolExecutionItem,
  type HostToolOutput,
  type InteractionRespondAccepted,
  type InteractionRespondCommand,
  type ModelSelectCommand,
  type ModelSelectCompleted,
  type OpenSessionInput,
  type PermissionModeSelectCommand,
  type PermissionModeSelectCompleted,
  type SessionStateChangedEvent,
  type SessionUsageChangedEvent,
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
  harnessModelRefSchema,
  harnessPermissionModeIdSchema,
  harnessThinkingOptionIdSchema,
  hostInteractionIdSchema,
  hostItemIdSchema,
  jsonValueSchema,
  nativeSessionRefSchema,
  type HarnessPermissionModeId,
  type HarnessId,
  type HostInteractionId,
  type NativeSessionRef,
  type NativeTurnRef,
  type JsonValue,
} from "@codexhost/shared-contracts";

import { PENGUIN_COMMAND_ENV } from "./command.js";
import {
  openPenguinConnection,
  PenguinApiError,
  PenguinConnectionError,
  type PenguinApiClient,
  type PenguinConnection,
  type PenguinConnectionOptions,
} from "./penguin-api.js";
import {
  decodePenguinModelRef,
  encodePenguinModelRef,
  normalizePenguinModelCatalog,
  type PenguinModelsResponse,
} from "./model-catalog.js";
import {
  decodePenguinPermissionModeId,
  PENGUIN_DEFAULT_PERMISSION_MODE_ID,
  PENGUIN_PERMISSION_MODE_CATALOG,
  type PenguinApprovalMode,
} from "./permission-modes.js";
import {
  modelFromPenguinSession,
  projectPenguinHistory,
  type PenguinHistoryResponse,
  type PenguinSessionInfo,
} from "./penguin-history.js";

export interface PenguinAdapterOptions {
  command?: string;
  endpoint?: string;
  root?: string;
  projectId?: string;
  agentId?: string;
  environment?: NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
  closeTimeoutMs?: number;
  autoStartServer?: boolean;
  toolOutputLimit?: number;
}

export interface PenguinAdapterDependencies {
  createConnection?(options: PenguinConnectionOptions): Promise<PenguinConnection>;
  randomUUID?(): string;
}

const penguinHarnessId = harnessIdSchema.parse("penguin");
const DEFAULT_TOOL_OUTPUT_LIMIT = 64_000;
const DEFAULT_PERMISSION_MODE: PenguinApprovalMode = "always-ask";
const TASK_COMPLETION_POLL_MS = 250;

interface PenguinContext {
  projectId: string;
  agentId: string;
  catalog: ReturnType<typeof normalizePenguinModelCatalog>;
}

interface ActiveTool {
  item: HostToolExecutionItem;
  nativeToolCallId: string;
  completed: boolean;
  rawOutput: string;
}

interface ActiveApproval {
  interaction: HostApprovalInteraction;
  nativeToolCallId: string;
}

interface ActiveTurn {
  command: TurnStartCommand;
  nativeTurnRef: NativeTurnRef;
  agentItem: HostAgentMessageItem | null;
  reasoningItem: HostReasoningItem | null;
  tools: Map<string, ActiveTool>;
  approvals: Map<HostInteractionId, ActiveApproval>;
  cancellationRequested: boolean;
  taskAccepted: boolean;
  completionProbeStarted: boolean;
  terminal: "succeeded" | "failed" | "cancelled";
  failure?: HarnessError;
}

type SessionPhase = "open" | "closing" | "closed" | "faulted";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function invalidState(message: string): HarnessError {
  return { code: "invalidState", message, retryable: false };
}

function unsupported(message: string): HarnessError {
  return { code: "unsupported", message, retryable: false };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizedError(error: unknown, fallback: HarnessError["code"]): HarnessError {
  if (error instanceof PenguinConnectionError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.code === "unavailable",
    };
  }
  if (error instanceof PenguinApiError) {
    const code: HarnessError["code"] =
      error.status === 401
        ? "authenticationRequired"
        : error.status === 404
          ? "sessionNotFound"
          : error.status === 409
            ? "sessionBusy"
            : fallback;
    return {
      code,
      message: error.message,
      retryable: error.status >= 500 || error.status === 409,
    };
  }
  if (isRecord(error) && error.code === "ENOENT") {
    return { code: "notInstalled", message: errorMessage(error), retryable: false };
  }
  return {
    code: fallback,
    message: errorMessage(error),
    retryable: fallback === "unavailable" || fallback === "nativeFailure",
  };
}

function sessionPath(sessionId: string, suffix = ""): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}${suffix}`;
}

function collection(value: unknown, key: string): unknown[] {
  if (Array.isArray(value)) return value;
  if (isRecord(value) && Array.isArray(value[key])) return value[key];
  return [];
}

function valueString(value: unknown, keys: readonly string[]): string | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of keys) {
    if (nonBlank(value[key])) return value[key].trim();
  }
  return undefined;
}

function selectedRecord(
  value: unknown,
  keys: readonly string[],
  requested?: string,
): string | undefined {
  const entries = collection(value, keys[0] ?? "");
  if (requested) {
    const match = entries.find((entry) => valueString(entry, keys.slice(1)) === requested);
    return match ? requested : undefined;
  }
  const preferred = entries.find(
    (entry) => isRecord(entry) && (entry.isDefault === true || entry.default === true),
  );
  return valueString(preferred, keys.slice(1)) ?? valueString(entries[0], keys.slice(1));
}

function sessionInfo(value: unknown): PenguinSessionInfo | null {
  const source = isRecord(value) && isRecord(value.session) ? value.session : value;
  if (!isRecord(source)) return null;
  const sessionId = valueString(source, ["sessionId", "id"]);
  const projectId = valueString(source, ["projectId", "project"]) ?? "";
  const agentId = valueString(source, ["agentId", "agent"]) ?? "";
  const provider = valueString(source, ["provider"]);
  const modelId = valueString(source, ["modelId", "model"]);
  if (!sessionId || !projectId || !agentId || !provider || !modelId) return null;
  return {
    ...source,
    sessionId,
    projectId,
    agentId,
    provider,
    modelId,
    ...(nonBlank(source.workspace) ? { workspace: source.workspace } : {}),
    ...(nonBlank(source.approvalMode) ? { approvalMode: source.approvalMode } : {}),
    ...(nonBlank(source.thinkingLevel) ? { thinkingLevel: source.thinkingLevel } : {}),
    ...(nonBlank(source.status) ? { status: source.status } : {}),
  };
}

function historyResponse(value: unknown): PenguinHistoryResponse {
  if (isRecord(value) && Array.isArray(value.messages)) {
    return { messages: value.messages, ...(value.live !== undefined ? { live: value.live } : {}) };
  }
  return { messages: Array.isArray(value) ? value : [] };
}

function usageFromRecord(value: unknown): HostUsage | null {
  if (!isRecord(value)) return null;
  if (value.type === "token_usage" && isRecord(value.session)) {
    const native = value.session;
    const usage: Record<string, number> = {};
    const fields = [
      ["cache_read", "cachedInputTokens"],
      ["cache_write", "cacheWriteInputTokens"],
      ["output", "outputTokens"],
      ["total", "totalTokens"],
    ] as const;
    for (const [nativeField, hostField] of fields) {
      const candidate = native[nativeField];
      if (typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0) {
        usage[hostField] = candidate;
      }
    }
    if (Object.keys(usage).length === 0) return null;
    try {
      return parseHostUsage(usage);
    } catch {
      return null;
    }
  }
  const source = isRecord(value.usage) ? value.usage : value;
  const fields = [
    "inputTokens",
    "cachedInputTokens",
    "cacheWriteInputTokens",
    "outputTokens",
    "outputTokensPerSecond",
    "reasoningOutputTokens",
    "totalTokens",
    "totalCostUsd",
    "cacheHitRatePercent",
    "contextWindowTokens",
    "contextUsedTokens",
  ] as const;
  const usage: Record<string, number> = {};
  for (const field of fields) {
    const candidate = source[field];
    if (
      typeof candidate === "number" &&
      Number.isFinite(candidate) &&
      candidate >= 0 &&
      (field === "outputTokensPerSecond" ||
        field === "totalCostUsd" ||
        Number.isSafeInteger(candidate))
    ) {
      usage[field] = candidate;
    }
  }
  if (Object.keys(usage).length === 0) return null;
  if (usage.contextWindowTokens !== undefined && usage.contextUsedTokens === undefined) {
    delete usage.contextWindowTokens;
  }
  if (usage.contextUsedTokens !== undefined && usage.contextWindowTokens === undefined) {
    delete usage.contextUsedTokens;
  }
  try {
    return parseHostUsage(usage);
  } catch {
    return null;
  }
}

function nativeRefForSession(session: PenguinSessionInfo): NativeSessionRef {
  return nativeSessionRefSchema.parse({
    harnessId: penguinHarnessId,
    nativeSessionId: session.sessionId,
    locator: { projectId: session.projectId, agentId: session.agentId },
    formatVersion: 1,
  }) as NativeSessionRef;
}

function modelLabel(catalog: PenguinContext["catalog"], ref: HarnessModelRef): string | undefined {
  return catalog.models.find((model) => model.ref.id === ref.id)?.resolvedModelLabel;
}

function stateForSession(
  session: PenguinSessionInfo,
  catalog: PenguinContext["catalog"],
): HarnessSessionState {
  const effectiveModel = encodePenguinModelRef(modelFromPenguinSession(session));
  const thinking = harnessThinkingOptionIdSchema.safeParse(session.thinkingLevel);
  const permission = harnessPermissionModeIdSchema.safeParse(session.approvalMode);
  const effectiveThinkingOptionId = thinking.success
    ? thinking.data
    : catalog.defaultThinkingOptionId;
  const effectivePermissionModeId = permission.success
    ? permission.data
    : PENGUIN_DEFAULT_PERMISSION_MODE_ID;
  const resolvedModelLabel = modelLabel(catalog, effectiveModel);
  return {
    nativeRef: nativeRefForSession(session),
    effectiveModel,
    ...(resolvedModelLabel ? { resolvedModelLabel } : {}),
    availableThinkingOptions: catalog.thinkingOptions,
    ...(effectiveThinkingOptionId ? { effectiveThinkingOptionId } : {}),
    effectivePermissionModeId,
  };
}

function approvalModeForInput(
  permissionModeId: HarnessPermissionModeId | undefined,
  executionPolicy: "default" | "unattended-full-access" | undefined,
): PenguinApprovalMode {
  if (executionPolicy === "unattended-full-access") return "allow-all";
  if (permissionModeId) return decodePenguinPermissionModeId(permissionModeId);
  return DEFAULT_PERMISSION_MODE;
}

function jsonPayload(value: unknown, fallback: JsonValue): JsonValue {
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      const checked = jsonValueSchema.safeParse(parsed);
      return checked.success ? checked.data : fallback;
    } catch {
      return value;
    }
  }
  const checked = jsonValueSchema.safeParse(value);
  return checked.success ? checked.data : fallback;
}

function toolOutput(value: unknown, limit: number): HostToolOutput | undefined {
  if (value === undefined || value === null) return undefined;
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = String(value);
    }
  }
  if (text.length > limit) text = text.slice(0, limit);
  return {
    content: [{ type: "text", text }],
    ...(text.length <= limit ? {} : { truncated: true }),
  };
}

function payloadOf(value: unknown): Record<string, unknown> | null {
  return isRecord(value) && isRecord(value.payload) ? value.payload : null;
}

function messageIsMain(value: unknown): boolean {
  return isRecord(value) && (!Array.isArray(value.origin) || value.origin.length === 0);
}

class PenguinHarnessSession implements HarnessSession {
  readonly harnessId: HarnessId = penguinHarnessId;
  readonly capabilities: HarnessSessionCapabilities = {
    configuration: {
      // Penguin fixes the provider/model pair when a Session is created. The
      // renderer may choose a model for a new Thread, while an existing
      // Session keeps that model and exposes a read-only selection.
      selectModel: true,
      modelSelectionScope: "atCreate",
      selectThinkingOption: true,
      selectPermissionMode: true,
      permissionModeScope: "live",
    },
    history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
  };
  get initialState(): HarnessSessionState {
    return this.#state;
  }

  readonly initialUsage: HostUsage | null;
  readonly outputs: AsyncIterable<HarnessOutput>;
  readonly #channel = new HarnessOutputChannel<HarnessOutput>();
  readonly #client: PenguinApiClient;
  readonly #catalog: PenguinContext["catalog"];
  readonly #toolOutputLimit: number;
  readonly #randomUUID: () => string;
  readonly #onClosed: () => void;
  #session: PenguinSessionInfo;
  #state: HarnessSessionState;
  #usage: HostUsage | null;
  #active: ActiveTurn | null = null;
  #streamAbort: AbortController | null = null;
  #phase: SessionPhase = "open";
  #closePromise: Promise<void> | null = null;
  #turnSequence = 0;
  #configuring = false;

  constructor(options: {
    client: PenguinApiClient;
    catalog: PenguinContext["catalog"];
    session: PenguinSessionInfo;
    toolOutputLimit: number;
    randomUUID: () => string;
    onClosed: () => void;
  }) {
    this.#client = options.client;
    this.#catalog = options.catalog;
    this.#session = options.session;
    this.#toolOutputLimit = options.toolOutputLimit;
    this.#randomUUID = options.randomUUID;
    this.#onClosed = options.onClosed;
    this.#state = stateForSession(this.#session, this.#catalog);
    this.#usage = usageFromRecord(this.#session);
    this.initialUsage = this.#usage;
    this.outputs = this.#channel.outputs;
  }

  async readSnapshot(): Promise<HarnessResult<HostThreadSnapshot>> {
    if (this.#phase !== "open")
      return { ok: false, error: invalidState("Penguin Session is not open") };
    if (this.#active || this.#configuring) {
      return {
        ok: false,
        error: {
          code: "sessionBusy",
          message: "Penguin Session has an active operation",
          retryable: true,
        },
      };
    }
    try {
      const [sessionValue, historyValue] = await Promise.all([
        this.#client.request<unknown>(sessionPath(this.#session.sessionId)),
        this.#client.request<unknown>(sessionPath(this.#session.sessionId, "/messages")),
      ]);
      const session = sessionInfo(sessionValue);
      if (!session) throw new Error("Penguin returned an invalid Session");
      this.#updateSession(session, false);
      const model = this.#state.effectiveModel;
      if (!model) throw new Error("Penguin Session did not return an effective Model");
      return {
        ok: true,
        value: {
          ...projectPenguinHistory(historyResponse(historyValue), session, model),
          state: this.#state,
        },
      };
    } catch (error) {
      return { ok: false, error: normalizedError(error, "nativeFailure") };
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
  async execute(command: HostCommand): Promise<HarnessResult<unknown>> {
    if (this.#phase !== "open")
      return { ok: false, error: invalidState("Penguin Session is not open") };
    if (command.type === "turn.cancel") return this.#cancel(command);
    if (command.type === "interaction.respond") return this.#respond(command);
    if (command.type === "model.select") {
      return {
        ok: false,
        error: unsupported(
          "Penguin fixes the Model when a Session is created; choose a Model on a new Thread",
        ),
      };
    }
    if (command.type === "thinking.select") return this.#selectThinking(command);
    if (command.type === "permissionMode.select") return this.#selectPermission(command);
    if (this.#active || this.#configuring) {
      return {
        ok: false,
        error: { code: "sessionBusy", message: "Penguin Session is busy", retryable: true },
      };
    }
    const text = command.input.map((input) => input.text).join("\n");
    if (text.trim().length === 0) {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "Penguin text Turn must not be empty",
          retryable: false,
        },
      };
    }
    const active: ActiveTurn = {
      command,
      nativeTurnRef: {
        harnessId: penguinHarnessId,
        nativeSessionId: this.#session.sessionId,
        nativeTurnKey: `turn-${++this.#turnSequence}`,
        formatVersion: 1,
      },
      agentItem: null,
      reasoningItem: null,
      tools: new Map(),
      approvals: new Map(),
      cancellationRequested: false,
      taskAccepted: false,
      completionProbeStarted: false,
      terminal: "succeeded",
    };
    this.#active = active;
    this.#event({ type: "turn.started", turnId: command.turnId });
    void this.#runTurn(active, text);
    return { ok: true, value: { turnId: command.turnId } };
  }

  async refreshUsage(): Promise<void> {
    if (this.#phase !== "open") return;
    try {
      const value = await this.#client.request<unknown>(sessionPath(this.#session.sessionId));
      const session = sessionInfo(value);
      if (session) this.#updateSession(session, true);
    } catch {
      // Usage is auxiliary and must not fault the active Session.
    }
  }

  close(): Promise<void> {
    if (!this.#closePromise) this.#closePromise = this.#close();
    return this.#closePromise;
  }

  #event(event: HostEvent): void {
    this.#channel.emit({ kind: "event", event: structuredClone(event) });
  }

  #updateSession(session: PenguinSessionInfo, publishUsage: boolean): void {
    this.#session = session;
    this.#state = stateForSession(session, this.#catalog);
    this.#event({
      type: "session.state.changed",
      state: this.#state,
    } satisfies SessionStateChangedEvent);
    const usage = usageFromRecord(session);
    if (usage || this.#usage) {
      this.#usage = usage;
      if (publishUsage) {
        this.#event({ type: "session.usage.changed", usage } satisfies SessionUsageChangedEvent);
      }
    }
  }

  async #runTurn(active: ActiveTurn, text: string): Promise<void> {
    try {
      await this.#client.request<unknown>(sessionPath(this.#session.sessionId, "/tasks"), {
        method: "POST",
        body: {
          input: [{ type: "text", text }],
          ...(this.#state.effectiveThinkingOptionId
            ? { thinkingLevel: this.#state.effectiveThinkingOptionId }
            : {}),
        },
      });
      if (this.#active !== active) return;
      active.taskAccepted = true;
      this.#startCompletionProbe(active);
      const abort = new AbortController();
      this.#streamAbort = abort;
      await this.#consumeStream(active, abort.signal);
      if (this.#active === active) {
        if (active.cancellationRequested || active.terminal === "cancelled") {
          this.#finishTurn(active, "cancelled");
        } else if (active.terminal === "failed") {
          this.#finishTurn(active, "failed", active.failure);
        } else {
          this.#finishTurn(active, "failed", {
            code: "protocolError",
            message: "Penguin session stream closed before the Task became idle",
            retryable: true,
          });
        }
      }
    } catch (error) {
      if (this.#active === active) {
        const normalized = normalizedError(error, "nativeFailure");
        this.#finishTurn(active, "failed", normalized);
      }
    } finally {
      if (this.#active === active) this.#streamAbort = null;
    }
  }

  async #consumeStream(active: ActiveTurn, signal: AbortSignal): Promise<void> {
    for await (const frame of this.#client.stream(this.#session.sessionId, signal)) {
      if (this.#active !== active) return;
      let value: unknown;
      try {
        value = JSON.parse(frame.data);
      } catch {
        continue;
      }
      if (frame.event === "server_event") {
        this.#handleServerEvent(active, value);
      } else {
        this.#handleMessage(active, value);
      }
      if (this.#active !== active) return;
    }
  }

  #startCompletionProbe(active: ActiveTurn): void {
    if (active.completionProbeStarted) return;
    active.completionProbeStarted = true;
    void this.#finishWhenPenguinBecomesIdle(active);
  }

  async #finishWhenPenguinBecomesIdle(active: ActiveTurn): Promise<void> {
    while (this.#phase === "open" && this.#active === active) {
      try {
        const value = await this.#client.request<unknown>(sessionPath(this.#session.sessionId));
        const session = sessionInfo(value);
        if (session?.status === "idle") {
          try {
            const historyValue = await this.#client.request<unknown>(
              sessionPath(this.#session.sessionId, "/messages"),
            );
            const model = this.#state.effectiveModel;
            const outcome = model
              ? projectPenguinHistory(historyResponse(historyValue), session, model).turns.at(-1)
                  ?.outcome
              : undefined;
            if (outcome?.status === "failed") {
              active.terminal = "failed";
              active.failure = outcome.error;
            } else if (outcome?.status === "cancelled") {
              active.terminal = "cancelled";
            }
          } catch {
            // Confirmed idle is sufficient to end the Turn when history is temporarily unavailable.
          }
          this.#finishTurn(
            active,
            active.cancellationRequested ? "cancelled" : active.terminal,
            active.failure,
          );
          return;
        }
      } catch {
        // The live stream remains authoritative while this missed-idle fallback retries.
      }
      await new Promise<void>((resolve) => setTimeout(resolve, TASK_COMPLETION_POLL_MS));
    }
  }

  #handleServerEvent(active: ActiveTurn, value: unknown): void {
    if (!isRecord(value) || typeof value.type !== "string") return;
    if (value.type === "task_state") {
      if (value.state === "idle" && active.taskAccepted) {
        this.#finishTurn(active, active.cancellationRequested ? "cancelled" : active.terminal);
      }
      return;
    }
    if (value.type === "resync_required") {
      this.#finishTurn(active, "failed", {
        code: "protocolError",
        message: "Penguin requested a session stream resynchronization",
        retryable: true,
      });
      return;
    }
    if (value.type !== "approval_request" || !isRecord(value.toolCall)) return;
    const toolCall = value.toolCall;
    const payload = payloadOf(toolCall);
    const nativeToolCallId =
      payload && typeof payload.tool_call_id === "string" ? payload.tool_call_id : null;
    if (!nativeToolCallId) return;
    const interactionId = hostInteractionIdSchema.parse(`penguin-approval-${this.#randomUUID()}`);
    const toolName = payload && typeof payload.name === "string" ? payload.name : "Penguin tool";
    const interaction: HostApprovalInteraction = {
      type: "approval",
      interactionId,
      turnId: active.command.turnId,
      title: `Allow Penguin tool: ${toolName}`,
      description: "Penguin Harness is requesting permission to run a tool.",
      subject: { type: "nativeAction" },
      actions: [
        { id: "allow-once", label: "Allow once", effect: "allowOnce" },
        { id: "allow-session", label: "Allow for session", effect: "allowForSession" },
        { id: "deny", label: "Deny", effect: "deny" },
      ],
    };
    active.approvals.set(interactionId, { interaction, nativeToolCallId });
    this.#channel.emit({ kind: "interaction", interaction });
  }

  #handleMessage(active: ActiveTurn, value: unknown): void {
    if (!messageIsMain(value) || !isRecord(value)) return;
    const payload = payloadOf(value);
    if (!payload || typeof value.type !== "string") return;
    if (value.type === "model_msg") {
      if (payload.role !== "assistant") {
        if (payload.type === "tool_call_output") this.#handleToolOutput(active, payload);
        else if (payload.type === "partial_tool_call_output") {
          this.#handlePartialToolOutput(active, payload);
        }
        return;
      }
      if (payload.type === "partial_text") {
        if (payload.event_type !== "stop") this.#appendText(active, payload.text, false);
      } else if (payload.type === "text") {
        // A complete Assistant message is the replay record. Live streams normally emit
        // partial_text first, so use the complete value only when no live fragment arrived.
        if (!active.agentItem) this.#appendText(active, payload.text, false);
      } else if (payload.type === "partial_thinking") {
        if (payload.event_type !== "stop") this.#appendText(active, payload.thinking, true);
      } else if (payload.type === "thinking") {
        if (!active.reasoningItem) this.#appendText(active, payload.thinking, true);
      } else if (payload.type === "tool_call") {
        this.#startTool(active, payload);
      }
      return;
    }
    if (value.type !== "event_msg") return;
    if (payload.type === "abort") {
      active.terminal = "cancelled";
      return;
    }
    if (payload.type === "request_end") {
      const status = payload.status;
      if (status !== "completed") {
        active.terminal = "failed";
        active.failure = {
          code: "nativeFailure",
          message:
            typeof payload.error_message === "string"
              ? payload.error_message
              : typeof payload.message === "string"
                ? payload.message
                : "Penguin Task failed",
          retryable: status === "retryable",
        };
      }
      this.#startCompletionProbe(active);
      return;
    }
    if (payload.type === "token_usage") {
      const usage = usageFromRecord(payload);
      if (usage) {
        this.#usage = usage;
        this.#event({
          type: "session.usage.changed",
          usage,
          observedForTurnId: active.command.turnId,
        });
      }
    }
  }

  #appendText(active: ActiveTurn, value: unknown, reasoning: boolean): void {
    if (typeof value !== "string" || value.length === 0) return;
    if (reasoning) {
      if (!active.reasoningItem) {
        active.reasoningItem = { type: "reasoning", itemId: this.#newItemId(), text: "" };
        this.#event({
          type: "item.started",
          turnId: active.command.turnId,
          item: active.reasoningItem,
        });
      }
      active.reasoningItem.text += value;
      this.#event({
        type: "item.updated",
        turnId: active.command.turnId,
        itemId: active.reasoningItem.itemId,
        update: { type: "text.append", text: value },
      });
      return;
    }
    if (!active.agentItem) {
      active.agentItem = { type: "agentMessage", itemId: this.#newItemId(), text: "" };
      this.#event({ type: "item.started", turnId: active.command.turnId, item: active.agentItem });
    }
    active.agentItem.text += value;
    this.#event({
      type: "item.updated",
      turnId: active.command.turnId,
      itemId: active.agentItem.itemId,
      update: { type: "text.append", text: value },
    });
  }

  #startTool(active: ActiveTurn, payload: Record<string, unknown>): void {
    const nativeToolCallId = typeof payload.tool_call_id === "string" ? payload.tool_call_id : null;
    if (!nativeToolCallId || active.tools.has(nativeToolCallId)) return;
    const item: HostToolExecutionItem = {
      type: "toolExecution",
      itemId: this.#newItemId(),
      toolName: typeof payload.name === "string" ? payload.name : "Penguin tool",
      arguments: jsonPayload(payload.arguments, {}),
    };
    active.tools.set(nativeToolCallId, {
      item,
      nativeToolCallId,
      completed: false,
      rawOutput: "",
    });
    this.#event({ type: "item.started", turnId: active.command.turnId, item });
  }

  #handlePartialToolOutput(active: ActiveTurn, payload: Record<string, unknown>): void {
    const nativeToolCallId = typeof payload.tool_call_id === "string" ? payload.tool_call_id : null;
    if (!nativeToolCallId) return;
    const tool = active.tools.get(nativeToolCallId);
    if (!tool || tool.completed || payload.event_type === "stop") return;
    const chunk = typeof payload.output === "string" ? payload.output : "";
    if (chunk.length === 0) return;
    tool.rawOutput += chunk;
    const output = toolOutput(tool.rawOutput, this.#toolOutputLimit);
    if (!output) return;
    tool.item.output = output;
    this.#event({
      type: "item.updated",
      turnId: active.command.turnId,
      itemId: tool.item.itemId,
      update: { type: "output.replace", output },
    });
  }

  #handleToolOutput(active: ActiveTurn, payload: Record<string, unknown>): void {
    const nativeToolCallId = typeof payload.tool_call_id === "string" ? payload.tool_call_id : null;
    if (!nativeToolCallId) return;
    const tool = active.tools.get(nativeToolCallId);
    if (!tool || tool.completed) return;
    const raw = payload.output ?? payload.content;
    if (typeof raw === "string") tool.rawOutput = raw;
    const output = toolOutput(raw, this.#toolOutputLimit);
    if (output) {
      tool.item.output = output;
      this.#event({
        type: "item.updated",
        turnId: active.command.turnId,
        itemId: tool.item.itemId,
        update: { type: "output.replace", output },
      });
    }
    const failed = payload.is_error === true || payload.isError === true;
    tool.completed = true;
    this.#event({
      type: "item.completed",
      turnId: active.command.turnId,
      snapshot: {
        item: tool.item,
        outcome: failed
          ? {
              status: "failed",
              error: {
                code: "nativeFailure",
                message: "Penguin tool execution failed",
                retryable: false,
              },
            }
          : { status: "succeeded" },
      },
    });
  }

  #finishTurn(active: ActiveTurn, terminal: ActiveTurn["terminal"], error?: HarnessError): void {
    if (this.#active !== active) return;
    active.terminal = terminal;
    if (error) active.failure = error;
    this.#streamAbort?.abort();
    this.#streamAbort = null;
    const itemOutcome: HostItemOutcome =
      terminal === "failed"
        ? {
            status: "failed",
            error: active.failure ?? {
              code: "nativeFailure",
              message: "Penguin Task failed",
              retryable: false,
            },
          }
        : terminal === "cancelled"
          ? { status: "cancelled", reason: "Cancelled by user" }
          : { status: "succeeded" };
    if (active.agentItem) {
      this.#event({
        type: "item.completed",
        turnId: active.command.turnId,
        snapshot: { item: active.agentItem, outcome: itemOutcome },
      });
    }
    if (active.reasoningItem) {
      this.#event({
        type: "item.completed",
        turnId: active.command.turnId,
        snapshot: { item: active.reasoningItem, outcome: itemOutcome },
      });
    }
    for (const tool of active.tools.values()) {
      if (tool.completed) continue;
      this.#event({
        type: "item.completed",
        turnId: active.command.turnId,
        snapshot: { item: tool.item, outcome: itemOutcome },
      });
    }
    for (const interactionId of active.approvals.keys()) {
      this.#event({
        type: "interaction.closed",
        interactionId,
        turnId: active.command.turnId,
        reason: "superseded",
      });
    }
    const outcome: TurnOutcome =
      terminal === "failed"
        ? {
            status: "failed",
            error: active.failure ?? {
              code: "nativeFailure",
              message: "Penguin Task failed",
              retryable: false,
            },
          }
        : terminal === "cancelled"
          ? { status: "cancelled", reason: "Cancelled by user" }
          : { status: "succeeded" };
    this.#event({
      type: "turn.completed",
      turnId: active.command.turnId,
      nativeTurnRef: active.nativeTurnRef,
      outcome,
    });
    this.#active = null;
  }

  async #cancel(command: TurnCancelCommand): Promise<HarnessResult<TurnCancelAccepted>> {
    const active = this.#active;
    if (!active || active.command.turnId !== command.turnId) {
      return {
        ok: false,
        error: invalidState("Penguin Turn Cancel must reference the active Turn"),
      };
    }
    if (active.cancellationRequested) return { ok: true, value: { cancellationRequested: true } };
    active.cancellationRequested = true;
    try {
      await this.#client.request<unknown>(sessionPath(this.#session.sessionId, "/abort"), {
        method: "POST",
        body: {},
      });
      active.terminal = "cancelled";
      return { ok: true, value: { cancellationRequested: true } };
    } catch (error) {
      return { ok: false, error: normalizedError(error, "nativeFailure") };
    }
  }

  async #respond(
    command: InteractionRespondCommand,
  ): Promise<HarnessResult<InteractionRespondAccepted>> {
    const active = this.#active;
    const pending = active?.approvals.get(command.interactionId);
    if (!active || !pending)
      return { ok: false, error: invalidState("Penguin Approval is not pending") };
    if (command.response.type !== "approval") {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "Penguin Approval requires an Approval Response",
          retryable: false,
        },
      };
    }
    const response = command.response;
    const validation = validateHostApprovalResponse(pending.interaction, response);
    if (validation) return { ok: false, error: validation };
    if (response.type !== "approval") {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "Penguin Approval requires an Approval Response",
          retryable: false,
        },
      };
    }
    const selected = pending.interaction.actions.find((action) => action.id === response.actionId);
    if (!selected)
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "Penguin Approval action is unavailable",
          retryable: false,
        },
      };
    try {
      if (selected.effect === "allowForSession" || selected.effect === "allowAlways") {
        await this.#client.request<unknown>(sessionPath(this.#session.sessionId), {
          method: "PATCH",
          body: { approvalMode: "allow-all" },
        });
      }
      await this.#client.request<unknown>(
        sessionPath(
          this.#session.sessionId,
          `/approvals/${encodeURIComponent(pending.nativeToolCallId)}`,
        ),
        { method: "POST", body: { decision: selected.effect === "deny" ? "deny" : "allow" } },
      );
      active.approvals.delete(command.interactionId);
      this.#event({
        type: "interaction.closed",
        interactionId: command.interactionId,
        turnId: active.command.turnId,
        reason: "responded",
      });
      return { ok: true, value: { accepted: true } };
    } catch (error) {
      return { ok: false, error: normalizedError(error, "nativeFailure") };
    }
  }

  async #selectThinking(
    command: ThinkingSelectCommand,
  ): Promise<HarnessResult<ThinkingSelectCompleted>> {
    if (this.#active || this.#configuring)
      return {
        ok: false,
        error: {
          code: "sessionBusy",
          message: "Penguin Thinking cannot change during a Task",
          retryable: true,
        },
      };
    const parsed = harnessThinkingOptionIdSchema.safeParse(command.thinkingOptionId);
    if (
      !parsed.success ||
      !this.#catalog.thinkingOptions.some((option) => option.id === parsed.data)
    ) {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "Penguin Thinking option is unavailable",
          retryable: false,
        },
      };
    }
    this.#configuring = true;
    try {
      await this.#client.request<unknown>(sessionPath(this.#session.sessionId), {
        method: "PATCH",
        body: { thinkingLevel: parsed.data },
      });
      const value = await this.#client.request<unknown>(sessionPath(this.#session.sessionId));
      const session = sessionInfo(value);
      if (!session) throw new Error("Penguin returned an invalid Session after Thinking selection");
      this.#updateSession(session, false);
      return { ok: true, value: { completed: true } };
    } catch (error) {
      return { ok: false, error: normalizedError(error, "nativeFailure") };
    } finally {
      this.#configuring = false;
    }
  }

  async #selectPermission(
    command: PermissionModeSelectCommand,
  ): Promise<HarnessResult<PermissionModeSelectCompleted>> {
    if (this.#active || this.#configuring)
      return {
        ok: false,
        error: {
          code: "sessionBusy",
          message: "Penguin Permission Mode cannot change during a Task",
          retryable: true,
        },
      };
    let mode: PenguinApprovalMode;
    try {
      mode = decodePenguinPermissionModeId(command.permissionModeId);
    } catch (error) {
      return { ok: false, error: normalizedError(error, "invalidRequest") };
    }
    this.#configuring = true;
    try {
      await this.#client.request<unknown>(sessionPath(this.#session.sessionId), {
        method: "PATCH",
        body: { approvalMode: mode },
      });
      const value = await this.#client.request<unknown>(sessionPath(this.#session.sessionId));
      const session = sessionInfo(value);
      if (!session)
        throw new Error("Penguin returned an invalid Session after Permission selection");
      this.#updateSession(session, false);
      return { ok: true, value: { completed: true } };
    } catch (error) {
      return { ok: false, error: normalizedError(error, "nativeFailure") };
    } finally {
      this.#configuring = false;
    }
  }

  #newItemId(): ReturnType<typeof hostItemIdSchema.parse> {
    return hostItemIdSchema.parse(`penguin-item-${this.#randomUUID()}`);
  }

  async #close(): Promise<void> {
    this.#phase = "closing";
    this.#streamAbort?.abort();
    const active = this.#active;
    if (active) {
      await this.#client
        .request<unknown>(sessionPath(this.#session.sessionId, "/abort"), {
          method: "POST",
          body: {},
        })
        .catch(() => undefined);
    }
    this.#active = null;
    this.#phase = "closed";
    this.#channel.end();
    this.#onClosed();
  }
}

export class PenguinAdapter implements HarnessAdapter {
  readonly harnessId: HarnessId = penguinHarnessId;
  readonly #options: PenguinAdapterOptions;
  readonly #dependencies: Required<Pick<PenguinAdapterDependencies, "randomUUID">> &
    Pick<PenguinAdapterDependencies, "createConnection">;
  readonly #sessions = new Set<PenguinHarnessSession>();
  #connection: PenguinConnection | null = null;
  #connectionPromise: Promise<PenguinConnection> | null = null;
  #context: PenguinContext | null = null;
  #closePromise: Promise<void> | null = null;

  constructor(options: PenguinAdapterOptions = {}, dependencies: PenguinAdapterDependencies = {}) {
    this.#options = options;
    this.#dependencies = {
      randomUUID: dependencies.randomUUID ?? randomUUID,
      ...(dependencies.createConnection ? { createConnection: dependencies.createConnection } : {}),
    };
  }

  async inspect(input: { cwd?: string; refresh?: boolean } = {}): Promise<HarnessInspection> {
    const startedAt = Date.now();
    try {
      const context = await this.#loadContext(input.refresh === true);
      return {
        status: "ready",
        catalog: context.catalog,
        permissionModes: PENGUIN_PERMISSION_MODE_CATALOG,
        capabilities: {
          configuration: {
            selectModel: true,
            modelSelectionScope: "atCreate",
            selectThinkingOption: context.catalog.thinkingOptions.length > 0,
            selectPermissionMode: true,
            permissionModeScope: "live",
          },
          history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
        },
      };
    } catch (error) {
      const normalized = normalizedError(error, "unavailable");
      return {
        status:
          normalized.code === "notInstalled"
            ? "notInstalled"
            : normalized.code === "unavailable"
              ? "unavailable"
              : "error",
        error: {
          ...normalized,
          stage: "inspect",
          durationMs: Date.now() - startedAt,
        },
      };
    }
  }

  async open(input: OpenSessionInput): Promise<HarnessResult<HarnessSession>> {
    if (this.#closePromise) return { ok: false, error: invalidState("Penguin Adapter is closed") };
    if (!input.cwd.trim())
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "Penguin Adapter requires cwd",
          retryable: false,
        },
      };
    try {
      const connection = await this.#ensureConnection();
      if (input.kind === "create") {
        const context = await this.#loadContext(false);
        const model = input.model ?? context.catalog.defaultModel ?? context.catalog.models[0]?.ref;
        if (!model)
          return {
            ok: false,
            error: {
              code: "unavailable",
              message: "Penguin returned no usable Models",
              retryable: true,
            },
          };
        const nativeModel = decodePenguinModelRef(harnessModelRefSchema.parse(model));
        if (!context.catalog.models.some((entry) => entry.ref.id === model.id)) {
          return {
            ok: false,
            error: {
              code: "invalidRequest",
              message: "Penguin Model is absent from the current catalog",
              retryable: false,
            },
          };
        }
        const approvalMode = approvalModeForInput(input.permissionModeId, input.executionPolicy);
        const created = await connection.client.request<unknown>(
          `/api/projects/${encodeURIComponent(context.projectId)}/agents/${encodeURIComponent(context.agentId)}/sessions`,
          {
            method: "POST",
            body: {
              workspace: input.cwd,
              provider: nativeModel.provider,
              modelId: nativeModel.modelId,
              approvalMode,
              client: "web",
            },
          },
        );
        const session = sessionInfo(created);
        if (!session) throw new Error("Penguin returned an invalid created Session");
        if (input.thinkingOptionId) {
          const thinking = harnessThinkingOptionIdSchema.parse(input.thinkingOptionId);
          if (!context.catalog.thinkingOptions.some((option) => option.id === thinking)) {
            return {
              ok: false,
              error: {
                code: "invalidRequest",
                message: "Penguin Thinking option is unavailable",
                retryable: false,
              },
            };
          }
        }
        const value = this.#trackSession({
          client: connection.client,
          catalog: context.catalog,
          session,
        });
        if (input.thinkingOptionId) {
          await value.execute({
            type: "thinking.select",
            thinkingOptionId: input.thinkingOptionId,
          });
        }
        return { ok: true, value };
      }
      const sourceRef = nativeSessionRefSchema.parse(
        input.kind === "resume" ? input.nativeRef : input.sourceRef,
      ) as NativeSessionRef;
      if (sourceRef.harnessId !== this.harnessId) {
        return {
          ok: false,
          error: {
            code: "invalidRequest",
            message: "Penguin Adapter cannot open another Harness's Session",
            retryable: false,
          },
        };
      }
      const raw = await connection.client.request<unknown>(sessionPath(sourceRef.nativeSessionId));
      const session = sessionInfo(raw);
      if (!session) throw new Error("Penguin returned an invalid resumed Session");
      const context = await this.#loadContext(false);
      const value = this.#trackSession({
        client: connection.client,
        catalog: context.catalog,
        session,
      });
      return { ok: true, value };
    } catch (error) {
      return { ok: false, error: normalizedError(error, "nativeFailure") };
    }
  }

  close(): Promise<void> {
    if (!this.#closePromise) this.#closePromise = this.#close();
    return this.#closePromise;
  }

  async #ensureConnection(): Promise<PenguinConnection> {
    if (this.#connection) return this.#connection;
    if (!this.#connectionPromise) {
      const environment = this.#options.environment ?? process.env;
      const command = this.#options.command ?? environment[PENGUIN_COMMAND_ENV];
      const connectionOptions: PenguinConnectionOptions = {
        ...(command ? { command } : {}),
        ...(this.#options.endpoint ? { endpoint: this.#options.endpoint } : {}),
        ...(this.#options.environment ? { environment: this.#options.environment } : {}),
        ...(this.#options.root ? { root: this.#options.root } : {}),
        ...(this.#options.startupTimeoutMs
          ? { startupTimeoutMs: this.#options.startupTimeoutMs }
          : {}),
        ...(this.#options.closeTimeoutMs ? { closeTimeoutMs: this.#options.closeTimeoutMs } : {}),
        ...(this.#options.autoStartServer !== undefined
          ? { autoStartServer: this.#options.autoStartServer }
          : {}),
      };
      this.#connectionPromise = (this.#dependencies.createConnection ?? openPenguinConnection)(
        connectionOptions,
      ).then((connection) => {
        this.#connection = connection;
        return connection;
      });
    }
    try {
      return await this.#connectionPromise;
    } catch (error) {
      this.#connectionPromise = null;
      throw error;
    }
  }

  async #loadContext(refresh: boolean): Promise<PenguinContext> {
    if (this.#context && !refresh) return this.#context;
    const connection = await this.#ensureConnection();
    const environment = this.#options.environment ?? process.env;
    const projects = await connection.client.request<unknown>("/api/projects");
    const projectId =
      this.#options.projectId ??
      environment.CODEXHOST_PENGUIN_PROJECT_ID ??
      environment.PENGUIN_PROJECT_ID ??
      selectedRecord(projects, ["projects", "projectId", "id"], undefined);
    if (!nonBlank(projectId)) throw new Error("Penguin returned no Project");
    const agents = await connection.client.request<unknown>(
      `/api/projects/${encodeURIComponent(projectId)}/agents`,
    );
    const agentId =
      this.#options.agentId ??
      environment.CODEXHOST_PENGUIN_AGENT_ID ??
      environment.PENGUIN_AGENT_ID ??
      selectedRecord(agents, ["agents", "agentId", "id"], undefined);
    if (!nonBlank(agentId)) throw new Error("Penguin returned no Agent");
    const models = await connection.client.request<PenguinModelsResponse | unknown>(
      `/api/projects/${encodeURIComponent(projectId)}/models`,
    );
    const catalog = normalizePenguinModelCatalog(models);
    if (catalog.models.length === 0) throw new Error("Penguin returned no usable Models");
    this.#context = { projectId, agentId, catalog };
    return this.#context;
  }

  #trackSession(options: {
    client: PenguinApiClient;
    catalog: PenguinContext["catalog"];
    session: PenguinSessionInfo;
  }): PenguinHarnessSession {
    const tracked = new PenguinHarnessSession({
      client: options.client,
      catalog: options.catalog,
      session: options.session,
      toolOutputLimit: this.#options.toolOutputLimit ?? DEFAULT_TOOL_OUTPUT_LIMIT,
      randomUUID: this.#dependencies.randomUUID,
      onClosed: () => this.#sessions.delete(tracked),
    });
    this.#sessions.add(tracked);
    return tracked;
  }

  async #close(): Promise<void> {
    await Promise.all([...this.#sessions].map((session) => session.close().catch(() => undefined)));
    this.#sessions.clear();
    await this.#connection?.close().catch(() => undefined);
    this.#connection = null;
    this.#connectionPromise = null;
    this.#context = null;
  }
}
