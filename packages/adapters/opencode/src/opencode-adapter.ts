import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type {
  AssistantMessage,
  Command as NativeCommand,
  Event,
  Part,
  PermissionRequest,
  QuestionRequest,
  Session,
  SnapshotFileDiff,
  ToolPart,
} from "@opencode-ai/sdk/v2";

import {
  HarnessOutputChannel,
  validateHostApprovalResponse,
  validateHostQuestionResponse,
  type HarnessAdapter,
  type HarnessCommandAccepted,
  type HarnessCommandCapability,
  type HarnessCommandInvocation,
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
  type HostContextCompactionItem,
  type HostEvent,
  type HostFileChangeItem,
  type HostItem,
  type HostItemOutcome,
  type HostQuestionInteraction,
  type HostReasoningItem,
  type HostThreadSnapshot,
  type HostToolExecutionItem,
  type HostToolOutput,
  type HostUsage,
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
  harnessCommandCatalogSchema,
  harnessIdSchema,
  harnessPermissionModeIdSchema,
  hostInteractionIdSchema,
  hostItemIdSchema,
  jsonValueSchema,
  nativeCheckpointRefSchema,
  type HarnessCommandCatalog,
  type HarnessPermissionModeId,
  type HarnessId,
  type HostInteractionId,
  type HostItemId,
  type NativeCheckpointRef,
  type NativeTurnRef,
} from "@codexhost/shared-contracts";

import {
  openCodeAssistantMessages,
  openCodeNativeSessionRef,
  parseOpenCodeSessionRef,
  projectOpenCodeHistory,
  reliableOpenCodeFileChanges,
  resolveOpenCodeForkBoundary,
  resolveOpenCodeLastTurnBoundary,
  type OpenCodeExecutionPolicy,
  type OpenCodeMessageWithParts,
} from "./history.js";
import {
  decodeOpenCodeModelRef,
  decodeOpenCodeVariant,
  encodeOpenCodeModelRef,
  encodeOpenCodeVariant,
  normalizeOpenCodeModelCatalog,
  openCodeContextWindow,
  type OpenCodeNativeModelRef,
  type OpenCodeProviderCatalog,
} from "./model-catalog.js";
import {
  decodeOpenCodePermissionModeId,
  OPENCODE_DEFAULT_PERMISSION_MODE_ID,
  OPENCODE_PERMISSION_MODE_CATALOG,
  permissionModeFromSession,
  requestedPermissionRules,
  type OpenCodePermissionMode,
} from "./permission-modes.js";
import {
  OpenCodeTransportError,
  type OpenCodeTransport,
  type OpenCodeTransportListener,
} from "./protocol.js";
import {
  OpenCodeServerConnection,
  managedOpenCodeEnvironment,
  SdkOpenCodeTransport,
  type OpenCodeServerConnectionLike,
  type OpenCodeServerOptions,
} from "./sdk-transport.js";
import { projectOpenCodeUsage } from "./usage.js";

export interface OpenCodeAdapterOptions extends OpenCodeServerOptions {
  toolOutputLimit?: number;
}

export interface OpenCodeAdapterDependencies {
  createConnection(options: OpenCodeServerOptions): OpenCodeServerConnectionLike;
  createTransport(
    connection: OpenCodeServerConnectionLike,
    cwd: string,
    options: OpenCodeServerOptions,
  ): OpenCodeTransport;
  randomUUID(): string;
}

type SessionPhase = "open" | "closing" | "closed" | "faulted";
type ActiveKind = "prompt" | "command" | "compact";

interface LiveItem {
  item: HostItem;
  content?: string;
  completed: boolean;
}

type ActiveInteraction =
  | {
      type: "question";
      nativeId: string;
      interaction: HostQuestionInteraction;
    }
  | {
      type: "approval";
      nativeId: string;
      interaction: HostApprovalInteraction;
    };

interface BufferedOutput {
  output: HarnessOutput;
  sequence: number;
}

interface ActiveTurn {
  kind: ActiveKind;
  turnId: TurnStartCommand["turnId"];
  userMessageID: string | null;
  preexistingUserMessageIds: Set<string>;
  assistantMessageIds: Set<string>;
  cancellationRequested: boolean;
  admissionCompleted: boolean;
  admissionFailure: HarnessError | null;
  admissionFailurePromise: Promise<void>;
  resolveAdmissionFailure(error: HarnessError): void;
  nativeCompleted: boolean;
  sawBusy: boolean;
  reconciledAfterReconnect: boolean;
  finishing: boolean;
  reconcilePending: boolean;
  terminalAssistant: AssistantMessage | null;
  items: Map<string, LiveItem>;
  toolItemByCallId: Map<string, HostItemId>;
  interactions: Map<HostInteractionId, ActiveInteraction>;
  completion: Promise<void>;
  resolveCompletion(): void;
  finished: boolean;
  admissionBuffer: BufferedOutput[];
  admissionSequence: number;
}

interface OpenCodeSnapshotProjection {
  session: Session;
  messages: OpenCodeMessageWithParts[];
  snapshot: HostThreadSnapshot;
  usage: HostUsage | null;
  model?: OpenCodeNativeModelRef;
  variant?: string;
}

const openCodeHarnessId = harnessIdSchema.parse("opencode");
const DEFAULT_TOOL_OUTPUT_LIMIT = 64_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 3_000;
// OpenCode persists session.diff in a background summary after emitting the
// terminal Patch Part. Reconcile briefly so FileChange precedes Turn completion.
const DIFF_RECONCILIATION_DELAYS_MS = [25, 50, 100, 200, 400, 800] as const;
const COMPACT_COMMAND_ID = "opencode.compact";
const NATIVE_COMMAND_PREFIX = "opencode.command.";
const SELECTION_METADATA_KEY = "codexhost.selection.v1";

function invalidState(message: string): HarnessError {
  return { code: "invalidState", message, retryable: false };
}

function unsupported(message: string): HarnessError {
  return { code: "unsupported", message, retryable: false };
}

function normalizeError(error: unknown, fallback: HarnessError["code"]): HarnessError {
  if (error instanceof OpenCodeTransportError) {
    return {
      code: error.code,
      message: error.message,
      retryable:
        error.code === "unavailable" ||
        error.code === "processExited" ||
        error.code === "authenticationRequired",
    };
  }
  const text = error instanceof Error ? error.message : String(error);
  const lower = text.toLowerCase();
  if (lower.includes("sessionbusy") || lower.includes("session busy")) {
    return { code: "sessionBusy", message: text, retryable: true };
  }
  if (lower.includes("not found")) {
    return { code: "sessionNotFound", message: text, retryable: false };
  }
  return {
    code: fallback,
    message: text,
    retryable: fallback === "unavailable" || fallback === "nativeFailure",
  };
}

function sameCwd(left: string, right: string): boolean {
  const canonical = (value: string): string => {
    try {
      return fs.realpathSync.native(value);
    } catch {
      return path.resolve(value);
    }
  };
  return canonical(left) === canonical(right);
}

function storedSelection(
  session: Session,
): (OpenCodeNativeModelRef & { variant?: string }) | undefined {
  const value = session.metadata?.[SELECTION_METADATA_KEY];
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const providerID = Reflect.get(value, "providerID");
  const modelID = Reflect.get(value, "modelID");
  const variant = Reflect.get(value, "variant");
  if (
    typeof providerID !== "string" ||
    !providerID ||
    typeof modelID !== "string" ||
    !modelID ||
    (variant !== undefined && (typeof variant !== "string" || !variant))
  ) {
    return undefined;
  }
  return { providerID, modelID, ...(typeof variant === "string" ? { variant } : {}) };
}

function selectionMetadata(
  session: Session,
  model: OpenCodeNativeModelRef,
  variant: string | undefined,
): Record<string, unknown> {
  return {
    ...session.metadata,
    [SELECTION_METADATA_KEY]: {
      providerID: model.providerID,
      modelID: model.modelID,
      ...(variant ? { variant } : {}),
    },
  };
}

function nativeModelFromSession(
  session: Session,
  messages: readonly OpenCodeMessageWithParts[],
): OpenCodeNativeModelRef | undefined {
  const stored = storedSelection(session);
  if (stored) return { providerID: stored.providerID, modelID: stored.modelID };
  if (session.model) {
    return { providerID: session.model.providerID, modelID: session.model.id };
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const info = messages[index]?.info;
    if (info?.role === "user") return info.model;
  }
  return undefined;
}

function nativeVariantFromSession(
  session: Session,
  messages: readonly OpenCodeMessageWithParts[],
): string | undefined {
  const stored = storedSelection(session);
  if (stored) return stored.variant;
  if (session.model?.variant) return session.model.variant;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const info = messages[index]?.info;
    if (info?.role === "user") return info.model.variant;
  }
  return undefined;
}

function turnHasNativePatch(
  messages: readonly OpenCodeMessageWithParts[],
  userMessageID: string,
): boolean {
  const start = messages.findIndex(({ info }) => info.id === userMessageID);
  if (start < 0) return false;
  let end = start + 1;
  while (end < messages.length && messages[end]?.info.role !== "user") end += 1;
  return messages
    .slice(start + 1, end)
    .some(({ parts }) => parts.some((part) => part.type === "patch" && part.files.length > 0));
}

async function readTurnDiff(
  transport: OpenCodeTransport,
  sessionID: string,
  userMessageID: string,
  nativePatchObserved: boolean,
): Promise<SnapshotFileDiff[]> {
  for (let attempt = 0; ; attempt += 1) {
    const diffs = await transport.getDiff(sessionID, userMessageID).catch(() => []);
    if (
      reliableOpenCodeFileChanges(diffs).length > 0 ||
      !nativePatchObserved ||
      attempt >= DIFF_RECONCILIATION_DELAYS_MS.length
    ) {
      return diffs;
    }
    await new Promise<void>((resolve) =>
      setTimeout(resolve, DIFF_RECONCILIATION_DELAYS_MS[attempt]),
    );
  }
}

async function readProjection(
  transport: OpenCodeTransport,
  sessionID: string,
  providerCatalog: OpenCodeProviderCatalog,
  toolOutputLimit: number,
): Promise<OpenCodeSnapshotProjection> {
  const [session, messages] = await Promise.all([
    transport.getSession(sessionID),
    transport.getMessages(sessionID),
  ]);
  const userMessageIds = messages
    .filter(({ info }) => info.role === "user")
    .map(({ info }) => info.id);
  const diffEntries = await Promise.all(
    userMessageIds.map(async (messageID) => {
      const diffs = await readTurnDiff(
        transport,
        sessionID,
        messageID,
        turnHasNativePatch(messages, messageID),
      );
      return [messageID, diffs] as const;
    }),
  );
  const snapshot = projectOpenCodeHistory({
    session,
    messages,
    diffsByUserMessageId: new Map(diffEntries),
    toolOutputLimit,
  });
  const model = nativeModelFromSession(session, messages);
  const variant = nativeVariantFromSession(session, messages);
  const usage = projectOpenCodeUsage(
    openCodeAssistantMessages(session, messages),
    model ? openCodeContextWindow(providerCatalog, model) : undefined,
  );
  return {
    session,
    messages,
    snapshot,
    usage,
    ...(model ? { model } : {}),
    ...(variant ? { variant } : {}),
  };
}

function sessionState(
  session: Session,
  modelCatalog: ReturnType<typeof normalizeOpenCodeModelCatalog>,
  model?: OpenCodeNativeModelRef,
  variant?: string,
  executionPolicy: OpenCodeExecutionPolicy = "default",
  permissionModeId: HarnessPermissionModeId = OPENCODE_DEFAULT_PERMISSION_MODE_ID,
): HarnessSessionState {
  const effectiveModel = model ? encodeOpenCodeModelRef(model) : undefined;
  const modelEntry = effectiveModel
    ? modelCatalog.models.find(({ ref }) => ref.id === effectiveModel.id)
    : undefined;
  const availableThinkingOptions = modelEntry?.supportedThinkingOptionIds
    ?.map((id) => modelCatalog.thinkingOptions.find((option) => option.id === id))
    .filter((option): option is (typeof modelCatalog.thinkingOptions)[number] => Boolean(option));
  const effectiveThinkingOptionId = encodeOpenCodeVariant(variant);
  return {
    nativeRef: openCodeNativeSessionRef(session, executionPolicy),
    ...(effectiveModel ? { effectiveModel } : {}),
    ...(modelEntry?.resolvedModelLabel
      ? { resolvedModelLabel: modelEntry.resolvedModelLabel }
      : {}),
    ...(availableThinkingOptions?.length
      ? { availableThinkingOptions, effectiveThinkingOptionId }
      : {}),
    effectivePermissionModeId: permissionModeId,
  };
}

function nativeCommandId(name: string): string {
  return `${NATIVE_COMMAND_PREFIX}${Buffer.from(name, "utf8").toString("base64url")}`;
}

function boundedCommandDescription(description: string | undefined): string | undefined {
  if (!description) return undefined;
  const trimmed = description.trim();
  if (!trimmed) return undefined;
  return trimmed.length <= 512 ? trimmed : `${trimmed.slice(0, 509)}...`;
}

function nativeCommandCatalog(commands: readonly NativeCommand[]): HarnessCommandCatalog {
  return harnessCommandCatalogSchema.parse({
    commands: [
      {
        id: COMPACT_COMMAND_ID,
        invocation: "/compact",
        label: "Compact context",
        description: "Compact the current OpenCode Session context",
        argumentMode: "none",
      },
      ...commands.map((command) => ({
        id: nativeCommandId(command.name),
        invocation: `/${command.name}`,
        label: command.name,
        ...(boundedCommandDescription(command.description)
          ? { description: boundedCommandDescription(command.description) }
          : {}),
        argumentMode:
          command.hints.length > 0 || command.template.includes("$ARGUMENTS") ? "text" : "none",
      })),
    ],
  });
}

function boundedOutput(text: string, limit: number): HostToolOutput | undefined {
  if (!text) return undefined;
  const truncated = text.length > limit;
  return {
    content: [{ type: "text", text: truncated ? text.slice(0, limit) : text }],
    ...(truncated ? { truncated: true } : {}),
  };
}

function itemOutcomeForTurn(outcome: TurnOutcome): HostItemOutcome {
  if (outcome.status === "failed") return { status: "failed", error: outcome.error };
  if (outcome.status === "cancelled") {
    return { status: "cancelled", ...(outcome.reason ? { reason: outcome.reason } : {}) };
  }
  return { status: "succeeded" };
}

class OpenCodeHarnessSession implements HarnessSession, OpenCodeTransportListener {
  readonly harnessId: HarnessId = openCodeHarnessId;
  readonly capabilities: HarnessSessionCapabilities;
  readonly commands: HarnessCommandCapability;
  readonly initialState: HarnessSessionState;
  readonly initialUsage: HostUsage | null;
  readonly outputs: AsyncIterable<HarnessOutput>;
  readonly #channel = new HarnessOutputChannel<HarnessOutput>();
  readonly #closeTimeoutMs: number;
  readonly #modelCatalog: ReturnType<typeof normalizeOpenCodeModelCatalog>;
  readonly #onClosed: () => void;
  readonly #providerCatalog: OpenCodeProviderCatalog;
  readonly #toolOutputLimit: number;
  readonly #transport: OpenCodeTransport;
  readonly #connection: OpenCodeServerConnectionLike;
  readonly #executionPolicy: OpenCodeExecutionPolicy;
  readonly #uuid: () => string;
  readonly #knownUserMessageIds = new Set<string>();
  #active: ActiveTurn | null = null;
  #closePromise: Promise<void> | null = null;
  #configuring = false;
  #connectedCount = 0;
  #model: OpenCodeNativeModelRef | undefined;
  #permissionMode: OpenCodePermissionMode;
  #phase: SessionPhase = "open";
  #session: Session;
  #snapshot: HostThreadSnapshot;
  #state: HarnessSessionState;
  #usage: HostUsage | null;
  #variant: string | undefined;

  constructor(input: {
    transport: OpenCodeTransport;
    connection: OpenCodeServerConnectionLike;
    projection: OpenCodeSnapshotProjection;
    providerCatalog: OpenCodeProviderCatalog;
    modelCatalog: ReturnType<typeof normalizeOpenCodeModelCatalog>;
    toolOutputLimit: number;
    closeTimeoutMs: number;
    randomUUID(): string;
    executionPolicy: OpenCodeExecutionPolicy;
    permissionMode: OpenCodePermissionMode;
    onClosed(): void;
  }) {
    this.#transport = input.transport;
    this.#session = input.projection.session;
    this.#snapshot = input.projection.snapshot;
    this.#providerCatalog = input.providerCatalog;
    this.#modelCatalog = input.modelCatalog;
    this.#model = input.projection.model;
    this.#variant = input.projection.variant;
    this.#toolOutputLimit = input.toolOutputLimit;
    this.#closeTimeoutMs = input.closeTimeoutMs;
    this.#uuid = input.randomUUID;
    this.#onClosed = input.onClosed;
    this.#connection = input.connection;
    this.#executionPolicy = input.executionPolicy;
    this.#permissionMode = input.permissionMode;
    for (const { info } of input.projection.messages) {
      if (info.role === "user") this.#knownUserMessageIds.add(info.id);
    }
    this.#state = sessionState(
      this.#session,
      this.#modelCatalog,
      this.#model,
      this.#variant,
      this.#executionPolicy,
      harnessPermissionModeIdSchema.parse(this.#permissionMode),
    );
    this.initialState = this.#state;
    this.#usage = input.projection.usage;
    this.initialUsage = this.#usage;
    const thinkingSelectable = this.#modelCatalog.thinkingOptions.length > 1;
    this.capabilities = {
      configuration: {
        selectModel: this.#modelCatalog.models.length > 0,
        selectThinkingOption: thinkingSelectable,
        selectPermissionMode: true,
        permissionModeScope: "live",
      },
      history: { fork: true, forkAcrossCwd: false, rollbackLastTurn: true },
    };
    this.commands = {
      list: async () => {
        try {
          return { ok: true, value: nativeCommandCatalog(await this.#transport.commands()) };
        } catch (error) {
          return { ok: false, error: normalizeError(error, "nativeFailure") };
        }
      },
      execute: (command) => this.#executeHarnessCommand(command),
    };
    this.outputs = this.#channel.outputs;
  }

  async start(): Promise<void> {
    await this.#transport.subscribe(this);
    const status = await this.#transport.getStatus(this.#session.id);
    if (status.type !== "idle") {
      throw new OpenCodeTransportError(
        "unavailable",
        "OpenCode Session is already busy and cannot be attached safely",
      );
    }
  }

  async readSnapshot(): Promise<HarnessResult<HostThreadSnapshot>> {
    if (this.#phase !== "open") {
      return { ok: false, error: invalidState("OpenCode Session is not open") };
    }
    if (this.#active || this.#configuring) {
      return {
        ok: false,
        error: {
          code: "sessionBusy",
          message: "OpenCode Session cannot read history while another operation is active",
          retryable: true,
        },
      };
    }
    try {
      const projection = await readProjection(
        this.#transport,
        this.#session.id,
        this.#providerCatalog,
        this.#toolOutputLimit,
      );
      this.#applyProjection(projection);
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
    if (this.#phase !== "open") {
      return { ok: false, error: invalidState("OpenCode Session is not open") };
    }
    if (command.type === "turn.cancel") return this.#cancel(command);
    if (command.type === "interaction.respond") return this.#respond(command);
    if (command.type === "model.select") return this.#selectModel(command);
    if (command.type === "thinking.select") return this.#selectThinking(command);
    if (command.type === "permissionMode.select") return this.#selectPermissionMode(command);
    if (this.#active || this.#configuring) {
      return {
        ok: false,
        error: {
          code: "sessionBusy",
          message: "OpenCode Session already has an active operation",
          retryable: true,
        },
      };
    }
    const text = command.input.map(({ text: part }) => part).join("\n");
    if (!text) {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "OpenCode text Turn must not be empty",
          retryable: false,
        },
      };
    }
    const active = this.#createActive("prompt", command.turnId, null);
    this.#active = active;
    active.admissionBuffer.push({
      output: { kind: "event", event: { type: "turn.started", turnId: command.turnId } },
      sequence: active.admissionSequence++,
    });
    try {
      const prompt = this.#transport.promptAsync({
        sessionID: this.#session.id,
        text,
        ...(this.#model ? { model: this.#model } : {}),
        ...(this.#variant ? { variant: this.#variant } : {}),
      });
      void prompt.catch(() => undefined);
      await Promise.race([prompt, active.admissionFailurePromise]);
      if (active.admissionFailure) return { ok: false, error: active.admissionFailure };
      active.admissionCompleted = true;
      this.#flushAdmission(active);
      void this.#reconcileAndFinish(active);
      return { ok: true, value: { turnId: command.turnId } };
    } catch (error) {
      const normalized = normalizeError(error, "nativeFailure");
      active.admissionBuffer.length = 0;
      active.finished = true;
      active.resolveCompletion();
      if (this.#active === active) this.#active = null;
      return { ok: false, error: normalized };
    }
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#close().finally(this.#onClosed);
    return this.#closePromise;
  }

  onEvent(event: Event): void {
    queueMicrotask(() => {
      try {
        this.#handleEvent(event);
      } catch (error) {
        this.#fault(error);
      }
    });
  }

  onFault(error: OpenCodeTransportError): void {
    queueMicrotask(() => this.#fault(error));
  }

  async #executeHarnessCommand(
    command: HarnessCommandInvocation,
  ): Promise<HarnessResult<HarnessCommandAccepted>> {
    if (this.#phase !== "open") {
      return { ok: false, error: invalidState("OpenCode Session is not open") };
    }
    if (this.#active || this.#configuring) {
      return {
        ok: false,
        error: {
          code: "sessionBusy",
          message: "OpenCode Session already has an active operation",
          retryable: true,
        },
      };
    }
    if (command.commandId === COMPACT_COMMAND_ID) {
      if (command.arguments && Object.keys(command.arguments).length > 0) {
        return {
          ok: false,
          error: {
            code: "invalidRequest",
            message: "OpenCode compact command does not accept arguments",
            retryable: false,
          },
        };
      }
      const active = this.#createActive("compact", command.turnId, null);
      this.#active = active;
      active.admissionBuffer.push({
        output: { kind: "event", event: { type: "turn.started", turnId: command.turnId } },
        sequence: active.admissionSequence++,
      });
      const item: HostContextCompactionItem = {
        type: "contextCompaction",
        itemId: hostItemIdSchema.parse(`opencode-compact:${this.#uuid()}`),
      };
      active.items.set(item.itemId, { item, completed: false });
      this.#event({ type: "item.started", turnId: command.turnId, item });
      try {
        await this.#transport.summarize(this.#session.id, this.#model);
      } catch (error) {
        const normalized = normalizeError(error, "nativeFailure");
        this.#failAdmission(active, normalized);
        return { ok: false, error: normalized };
      }
      if (active.admissionFailure) return { ok: false, error: active.admissionFailure };
      active.admissionCompleted = true;
      active.nativeCompleted = true;
      this.#flushAdmission(active);
      this.#completeTurn(active, { status: "succeeded" });
      void this.#refreshProjection(command.turnId);
      return { ok: true, value: { turnId: command.turnId } };
    }
    const commands = await this.#transport.commands().catch(() => []);
    const native = commands.find(
      (candidate) => nativeCommandId(candidate.name) === command.commandId,
    );
    if (!native) {
      return {
        ok: false,
        error: unsupported(`OpenCode does not expose Harness command '${command.commandId}'`),
      };
    }
    const arguments_ = command.arguments;
    const text = arguments_?.text;
    if (text !== undefined && typeof text !== "string") {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "OpenCode command argument 'text' must be a string",
          retryable: false,
        },
      };
    }
    if (arguments_ && Object.keys(arguments_).some((key) => key !== "text")) {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "OpenCode command has an unknown argument",
          retryable: false,
        },
      };
    }
    const active = this.#createActive("command", command.turnId, null);
    active.admissionCompleted = true;
    this.#active = active;
    this.#event({ type: "turn.started", turnId: command.turnId });
    void this.#transport
      .executeCommand({
        sessionID: this.#session.id,
        command: native.name,
        arguments: typeof text === "string" ? text : "",
        ...(this.#model ? { model: this.#model } : {}),
        ...(this.#variant ? { variant: this.#variant } : {}),
      })
      .then((result) => {
        this.#bindUserMessage(active, result.info.parentID);
        active.nativeCompleted = true;
        void this.#reconcileAndFinish(active);
      })
      .catch((error) =>
        this.#completeTurn(active, {
          status: "failed",
          error: normalizeError(error, "nativeFailure"),
        }),
      );
    return { ok: true, value: { turnId: command.turnId } };
  }

  async #cancel(command: TurnCancelCommand): Promise<HarnessResult<TurnCancelAccepted>> {
    const active = this.#active;
    if (!active || active.turnId !== command.turnId) {
      return {
        ok: false,
        error: invalidState("OpenCode cancellation must reference the active Turn"),
      };
    }
    active.cancellationRequested = true;
    try {
      await this.#transport.abort(this.#session.id);
      return { ok: true, value: { cancellationRequested: true } };
    } catch (error) {
      return { ok: false, error: normalizeError(error, "nativeFailure") };
    }
  }

  async #respond(
    command: InteractionRespondCommand,
  ): Promise<HarnessResult<InteractionRespondAccepted>> {
    const active = this.#active;
    const pending = active?.interactions.get(command.interactionId);
    if (!active || !pending) {
      return {
        ok: false,
        error: invalidState("OpenCode Interaction Response must reference a pending Interaction"),
      };
    }
    try {
      if (pending.type === "question") {
        if (command.response.type !== "question") {
          return {
            ok: false,
            error: {
              code: "invalidRequest",
              message: "OpenCode Question requires a Question Response",
              retryable: false,
            },
          };
        }
        const response = command.response;
        const validation = validateHostQuestionResponse(pending.interaction, response);
        if (validation) return { ok: false, error: validation };
        if (response.cancelled) {
          await this.#transport.rejectQuestion(pending.nativeId);
        } else {
          await this.#transport.replyQuestion(
            pending.nativeId,
            pending.interaction.questions.map((question) => response.answers[question.id] ?? []),
          );
        }
      } else {
        if (command.response.type !== "approval") {
          return {
            ok: false,
            error: {
              code: "invalidRequest",
              message: "OpenCode Approval requires an Approval Response",
              retryable: false,
            },
          };
        }
        const validation = validateHostApprovalResponse(pending.interaction, command.response);
        if (validation) return { ok: false, error: validation };
        await this.#transport.replyPermission(
          pending.nativeId,
          command.response.actionId === "allow-once" ? "once" : "reject",
        );
      }
      this.#closeInteraction(active, command.interactionId, "responded");
      return { ok: true, value: { accepted: true } };
    } catch (error) {
      return { ok: false, error: normalizeError(error, "nativeFailure") };
    }
  }

  async #selectModel(command: ModelSelectCommand): Promise<HarnessResult<ModelSelectCompleted>> {
    if (this.#active || this.#configuring) {
      return {
        ok: false,
        error: {
          code: "sessionBusy",
          message: "OpenCode Model cannot change during another operation",
          retryable: true,
        },
      };
    }
    let native: OpenCodeNativeModelRef;
    try {
      native = decodeOpenCodeModelRef(command.model);
    } catch (error) {
      return { ok: false, error: normalizeError(error, "invalidRequest") };
    }
    const entry = this.#modelCatalog.models.find(({ ref }) => ref.id === command.model.id);
    if (!entry) {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "OpenCode Model is absent from the current catalog",
          retryable: false,
        },
      };
    }
    this.#configuring = true;
    try {
      this.#session = await this.#transport.updateSessionMetadata(
        this.#session.id,
        selectionMetadata(this.#session, native, undefined),
      );
      this.#model = native;
      this.#variant = undefined;
      this.#publishState();
      return { ok: true, value: { completed: true } };
    } catch (error) {
      return { ok: false, error: normalizeError(error, "nativeFailure") };
    } finally {
      this.#configuring = false;
    }
  }

  async #selectThinking(
    command: ThinkingSelectCommand,
  ): Promise<HarnessResult<ThinkingSelectCompleted>> {
    if (!this.capabilities.configuration.selectThinkingOption) {
      return { ok: false, error: unsupported("OpenCode Model variants are unavailable") };
    }
    if (this.#active || this.#configuring) {
      return {
        ok: false,
        error: {
          code: "sessionBusy",
          message: "OpenCode Thinking cannot change during another operation",
          retryable: true,
        },
      };
    }
    const modelRef = this.#model ? encodeOpenCodeModelRef(this.#model) : undefined;
    const model = modelRef
      ? this.#modelCatalog.models.find(({ ref }) => ref.id === modelRef.id)
      : undefined;
    if (!model?.supportedThinkingOptionIds?.includes(command.thinkingOptionId)) {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "OpenCode Thinking option is unavailable for the selected Model",
          retryable: false,
        },
      };
    }
    let variant: string | undefined;
    try {
      variant = decodeOpenCodeVariant(command.thinkingOptionId);
    } catch (error) {
      return { ok: false, error: normalizeError(error, "invalidRequest") };
    }
    if (!this.#model) {
      return { ok: false, error: invalidState("OpenCode Thinking selection requires a Model") };
    }
    this.#configuring = true;
    try {
      this.#session = await this.#transport.updateSessionMetadata(
        this.#session.id,
        selectionMetadata(this.#session, this.#model, variant),
      );
      this.#variant = variant;
      this.#publishState();
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
    if (this.#active || this.#configuring) {
      return {
        ok: false,
        error: {
          code: "sessionBusy",
          message: "OpenCode Permission Mode cannot change during another operation",
          retryable: true,
        },
      };
    }
    let permissionMode: OpenCodePermissionMode;
    try {
      permissionMode = decodeOpenCodePermissionModeId(command.permissionModeId);
    } catch {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "OpenCode Permission Mode is invalid",
          retryable: false,
        },
      };
    }
    if (permissionMode === this.#permissionMode) {
      return { ok: true, value: { completed: true } };
    }
    const permission = requestedPermissionRules(this.#session.permission, permissionMode);
    this.#configuring = true;
    try {
      this.#session = await this.#transport.updateSessionPermission(this.#session.id, permission);
      const effective = permissionModeFromSession(this.#session.permission);
      if (effective !== permissionMode) {
        throw new OpenCodeTransportError(
          "protocolError",
          "OpenCode did not confirm the requested Permission Mode",
        );
      }
      this.#permissionMode = effective;
      this.#publishState();
      return { ok: true, value: { completed: true } };
    } catch (error) {
      return { ok: false, error: normalizeError(error, "nativeFailure") };
    } finally {
      this.#configuring = false;
    }
  }

  #handleEvent(event: Event): void {
    if (this.#phase !== "open") return;
    if (event.type === "server.connected") {
      this.#connectedCount += 1;
      const active = this.#active;
      if (this.#connectedCount > 1 && active) void this.#reconcileAfterReconnect(active);
      return;
    }
    const active = this.#active;
    if (event.type === "session.status" && event.properties.sessionID === this.#session.id) {
      if (!active) return;
      if (event.properties.status.type === "busy") active.sawBusy = true;
      if (event.properties.status.type === "idle") void this.#reconcileAndFinish(active);
      return;
    }
    if (event.type === "session.idle" && event.properties.sessionID === this.#session.id) {
      if (active) void this.#reconcileAndFinish(active);
      return;
    }
    if (event.type === "message.updated" && event.properties.sessionID === this.#session.id) {
      const info = event.properties.info;
      if (info.role === "user") {
        // Do not bind solely from a User event: another native client could
        // write to the same Session while this Turn is active. The Assistant
        // parent relation, Command result, or idle transcript reconciliation
        // provides the ownership proof.
        this.#knownUserMessageIds.add(info.id);
        return;
      }
      if (!active || !this.#bindUserMessage(active, info.parentID)) return;
      active.assistantMessageIds.add(info.id);
      active.terminalAssistant = info;
      if (info.time.completed !== undefined || info.finish || info.error) {
        void this.#reconcileAndFinish(active);
      }
      return;
    }
    if (event.type === "message.part.updated") {
      const part = event.properties.part;
      // A Session stream can contain user input and unrelated native Messages.
      // Only Parts whose Assistant Message has been linked to this Turn's
      // native User Message may become Host output.
      if (
        active &&
        part.sessionID === this.#session.id &&
        active.assistantMessageIds.has(part.messageID)
      ) {
        this.#projectPart(active, part);
      }
      return;
    }
    if (event.type === "message.part.delta") {
      const properties = event.properties;
      if (
        active &&
        properties.sessionID === this.#session.id &&
        active.assistantMessageIds.has(properties.messageID)
      ) {
        this.#appendPartDelta(active, properties.partID, properties.field, properties.delta);
      }
      return;
    }
    if (event.type === "question.asked" && event.properties.sessionID === this.#session.id) {
      if (active) this.#openQuestion(active, event.properties);
      return;
    }
    if (event.type === "question.replied" || event.type === "question.rejected") {
      if (event.properties.sessionID !== this.#session.id || !active) return;
      const id = hostInteractionIdSchema.parse(event.properties.requestID);
      if (active.interactions.has(id)) this.#closeInteraction(active, id, "superseded");
      return;
    }
    if (event.type === "permission.asked" && event.properties.sessionID === this.#session.id) {
      if (active) this.#openApproval(active, event.properties);
      return;
    }
    if (event.type === "permission.replied") {
      if (event.properties.sessionID !== this.#session.id || !active) return;
      const id = hostInteractionIdSchema.parse(event.properties.requestID);
      if (active.interactions.has(id)) this.#closeInteraction(active, id, "superseded");
      return;
    }
    if (
      event.type === "session.error" &&
      event.properties.sessionID === this.#session.id &&
      active
    ) {
      const error = event.properties.error;
      this.#completeTurn(active, {
        status: active.cancellationRequested ? "cancelled" : "failed",
        ...(active.cancellationRequested
          ? { reason: "Cancelled by user" }
          : {
              error: {
                code:
                  error?.name === "ProviderAuthError" ? "authenticationRequired" : "nativeFailure",
                message:
                  error && "message" in error.data && typeof error.data.message === "string"
                    ? error.data.message
                    : "OpenCode Session failed",
                retryable: error?.name === "ProviderAuthError",
              },
            }),
      } as TurnOutcome);
    }
  }

  #projectPart(active: ActiveTurn, part: Part): void {
    if (part.type === "text" || part.type === "reasoning") {
      if ((part.type === "text" && part.ignored) || !part.text) return;
      const existing = active.items.get(part.id);
      if (!existing) {
        const item: HostAgentMessageItem | HostReasoningItem =
          part.type === "text"
            ? { type: "agentMessage", itemId: hostItemIdSchema.parse(part.id), text: part.text }
            : { type: "reasoning", itemId: hostItemIdSchema.parse(part.id), text: part.text };
        active.items.set(part.id, { item, content: part.text, completed: false });
        this.#event({ type: "item.started", turnId: active.turnId, item });
      } else if (typeof existing.content === "string" && part.text.startsWith(existing.content)) {
        const suffix = part.text.slice(existing.content.length);
        if (suffix) this.#appendText(active, part.id, suffix);
      } else if (typeof existing.content === "string" && existing.content !== part.text) {
        throw new OpenCodeTransportError(
          "protocolError",
          `OpenCode Part '${part.id}' returned inconsistent streamed text`,
        );
      }
      if (part.time?.end !== undefined)
        this.#completeLiveItem(active, part.id, { status: "succeeded" });
      return;
    }
    if (part.type === "tool") {
      this.#projectTool(active, part);
      return;
    }
    if (part.type === "compaction" && !active.items.has(part.id)) {
      const item: HostContextCompactionItem = {
        type: "contextCompaction",
        itemId: hostItemIdSchema.parse(part.id),
      };
      active.items.set(part.id, { item, completed: false });
      this.#event({ type: "item.started", turnId: active.turnId, item });
    }
  }

  #appendPartDelta(active: ActiveTurn, partID: string, field: string, delta: string): void {
    if (field !== "text" || !delta) return;
    const existing = active.items.get(partID);
    // A delta does not identify whether its Part is text or reasoning. Wait for
    // message.part.updated to establish that type instead of mis-projecting it.
    // Terminal reconciliation reads the complete Part if the initial update was
    // missed entirely.
    if (!existing) return;
    this.#appendText(active, partID, delta);
  }

  #appendText(active: ActiveTurn, partID: string, delta: string): void {
    const live = active.items.get(partID);
    if (!live || live.completed || typeof live.content !== "string") return;
    live.content += delta;
    if (live.item.type === "agentMessage" || live.item.type === "reasoning") {
      live.item = { ...live.item, text: live.content };
    }
    this.#event({
      type: "item.updated",
      turnId: active.turnId,
      itemId: live.item.itemId,
      update: { type: "text.append", text: delta },
    });
  }

  #projectTool(active: ActiveTurn, part: ToolPart): void {
    if (part.state.status === "pending") return;
    const arguments_ = jsonValueSchema.safeParse(part.state.input);
    if (!arguments_.success) {
      throw new OpenCodeTransportError(
        "protocolError",
        `OpenCode Tool '${part.tool}' emitted invalid arguments`,
      );
    }
    let live = active.items.get(part.id);
    if (!live) {
      const item: HostToolExecutionItem = {
        type: "toolExecution",
        itemId: hostItemIdSchema.parse(part.id),
        toolName: part.tool,
        arguments: arguments_.data,
      };
      live = { item, completed: false };
      active.items.set(part.id, live);
      active.toolItemByCallId.set(part.callID, item.itemId);
      this.#event({ type: "item.started", turnId: active.turnId, item });
    }
    if (live.item.type !== "toolExecution" || live.completed) return;
    if (part.state.status === "completed") {
      const output = boundedOutput(part.state.output, this.#toolOutputLimit);
      live.item = {
        ...live.item,
        ...(output ? { output } : {}),
        durationMs: Math.max(0, part.state.time.end - part.state.time.start),
      };
      if (output) {
        this.#event({
          type: "item.updated",
          turnId: active.turnId,
          itemId: live.item.itemId,
          update: { type: "output.replace", output },
        });
      }
      this.#completeLiveItem(active, part.id, { status: "succeeded" });
    } else if (part.state.status === "error") {
      live.item = {
        ...live.item,
        durationMs: Math.max(0, part.state.time.end - part.state.time.start),
      };
      this.#completeLiveItem(active, part.id, {
        status: "failed",
        error: {
          code: "nativeFailure",
          message: part.state.error || `OpenCode Tool '${part.tool}' failed`,
          retryable: false,
        },
      });
    }
  }

  #openQuestion(active: ActiveTurn, request: QuestionRequest): void {
    const interactionId = hostInteractionIdSchema.parse(request.id);
    if (active.interactions.has(interactionId)) return;
    const questions = request.questions.map((question, index) => ({
      id: `question-${index}`,
      type: "choice" as const,
      prompt: question.question,
      options: question.options.map((option) => ({
        value: option.label,
        label: option.label,
        ...(option.description ? { description: option.description } : {}),
      })),
      multiple: question.multiple ?? false,
      allowOther: question.custom ?? false,
      optional: false,
    }));
    const itemId = request.tool ? active.toolItemByCallId.get(request.tool.callID) : undefined;
    const interaction: HostQuestionInteraction = {
      type: "question",
      interactionId,
      turnId: active.turnId,
      ...(itemId ? { itemId } : {}),
      title:
        request.questions
          .map(({ header }) => header)
          .filter(Boolean)
          .join(" / ") || "OpenCode",
      questions,
    };
    active.interactions.set(interactionId, {
      type: "question",
      nativeId: request.id,
      interaction,
    });
    this.#output({ kind: "interaction", interaction });
  }

  #openApproval(active: ActiveTurn, request: PermissionRequest): void {
    const interactionId = hostInteractionIdSchema.parse(request.id);
    if (active.interactions.has(interactionId)) return;
    const itemId = request.tool ? active.toolItemByCallId.get(request.tool.callID) : undefined;
    const interaction: HostApprovalInteraction = {
      type: "approval",
      interactionId,
      turnId: active.turnId,
      ...(itemId ? { itemId } : {}),
      title: `Allow OpenCode ${request.permission}?`,
      ...(request.patterns.length > 0 ? { description: request.patterns.join("\n") } : {}),
      subject: { type: "nativeAction" },
      actions: [
        { id: "allow-once", label: "Allow once", effect: "allowOnce" },
        { id: "deny", label: "Deny", effect: "deny" },
      ],
    };
    active.interactions.set(interactionId, {
      type: "approval",
      nativeId: request.id,
      interaction,
    });
    this.#output({ kind: "interaction", interaction });
  }

  #closeInteraction(
    active: ActiveTurn,
    interactionId: HostInteractionId,
    reason: "responded" | "cancelled" | "expired" | "superseded",
  ): void {
    if (!active.interactions.delete(interactionId)) return;
    this.#event({
      type: "interaction.closed",
      interactionId,
      turnId: active.turnId,
      reason,
    });
  }

  async #reconcileAfterReconnect(active: ActiveTurn): Promise<void> {
    try {
      const [status, questions, permissions] = await Promise.all([
        this.#transport.getStatus(this.#session.id),
        this.#transport.listQuestions(),
        this.#transport.listPermissions(),
      ]);
      if (this.#active !== active) return;
      for (const question of questions) {
        if (question.sessionID === this.#session.id) this.#openQuestion(active, question);
      }
      for (const permission of permissions) {
        if (permission.sessionID === this.#session.id) this.#openApproval(active, permission);
      }
      const pending = new Set([
        ...questions.filter(({ sessionID }) => sessionID === this.#session.id).map(({ id }) => id),
        ...permissions
          .filter(({ sessionID }) => sessionID === this.#session.id)
          .map(({ id }) => id),
      ]);
      for (const [interactionId, interaction] of active.interactions) {
        if (!pending.has(interaction.nativeId))
          this.#closeInteraction(active, interactionId, "superseded");
      }
      active.reconciledAfterReconnect = true;
      if (status.type === "idle") await this.#reconcileAndFinish(active);
    } catch (error) {
      this.#fault(error);
    }
  }

  async #reconcileAndFinish(active: ActiveTurn): Promise<void> {
    if (this.#active !== active || active.kind === "compact") return;
    if (active.finishing) {
      active.reconcilePending = true;
      return;
    }
    active.finishing = true;
    try {
      const [status, messages] = await Promise.all([
        this.#transport.getStatus(this.#session.id),
        this.#transport.getMessages(this.#session.id),
      ]);
      if (this.#active !== active || status.type !== "idle") return;
      this.#resolveUserMessage(active, messages);
      const lifecycleObserved =
        active.sawBusy ||
        active.reconciledAfterReconnect ||
        (active.kind === "command" && active.nativeCompleted) ||
        active.cancellationRequested;
      if (!lifecycleObserved) return;
      const userIndex = messages.findIndex(({ info }) => info.id === active.userMessageID);
      if (userIndex < 0) {
        if (active.cancellationRequested) {
          this.#completeTurn(active, { status: "cancelled", reason: "Cancelled by user" });
        }
        return;
      }
      let end = userIndex + 1;
      while (end < messages.length && messages[end]?.info.role !== "user") end += 1;
      const assistants = messages
        .slice(userIndex + 1, end)
        .filter(
          (entry): entry is OpenCodeMessageWithParts & { info: AssistantMessage } =>
            entry.info.role === "assistant",
        );
      const terminal = assistants.at(-1)?.info ?? active.terminalAssistant;
      if (
        !terminal ||
        (terminal.time.completed === undefined &&
          !terminal.finish &&
          !terminal.error &&
          !active.nativeCompleted)
      ) {
        return;
      }
      for (const entry of assistants) {
        for (const part of entry.parts) this.#projectPart(active, part);
      }
      active.terminalAssistant = terminal;
      const userMessageID = active.userMessageID as string;
      const changes = reliableOpenCodeFileChanges(
        await readTurnDiff(
          this.#transport,
          this.#session.id,
          userMessageID,
          turnHasNativePatch(messages, userMessageID),
        ),
      );
      if (changes.length > 0) {
        const id = `opencode-live-diff:${active.userMessageID}`;
        if (!active.items.has(id)) {
          const item: HostFileChangeItem = {
            type: "fileChange",
            itemId: hostItemIdSchema.parse(id),
            changes,
          };
          active.items.set(id, { item, completed: false });
          this.#event({ type: "item.started", turnId: active.turnId, item });
        }
      }
      const checkpoint = nativeCheckpointRefSchema.parse({
        harnessId: this.harnessId,
        nativeSessionId: this.#session.id,
        checkpointId: terminal.id,
        formatVersion: 1,
      }) as NativeCheckpointRef;
      const nativeTurnRef: NativeTurnRef = {
        harnessId: this.harnessId,
        nativeSessionId: this.#session.id,
        nativeTurnKey: active.userMessageID as string,
        formatVersion: 1,
      };
      const outcome: TurnOutcome =
        active.cancellationRequested || terminal.error?.name === "MessageAbortedError"
          ? { status: "cancelled", reason: "Cancelled by user", checkpoint }
          : terminal.error
            ? {
                status: "failed",
                error: {
                  code:
                    terminal.error.name === "ProviderAuthError"
                      ? "authenticationRequired"
                      : "nativeFailure",
                  message:
                    "message" in terminal.error.data &&
                    typeof terminal.error.data.message === "string"
                      ? terminal.error.data.message
                      : "OpenCode Assistant failed",
                  retryable:
                    terminal.error.name === "ProviderAuthError" ||
                    (terminal.error.name === "APIError" && terminal.error.data.isRetryable),
                },
                checkpoint,
              }
            : { status: "succeeded", checkpoint };
      this.#completeTurn(active, outcome, nativeTurnRef);
      void this.#refreshProjection(active.turnId);
    } catch (error) {
      if (this.#active === active) {
        this.#completeTurn(active, {
          status: "failed",
          error: normalizeError(error, "protocolError"),
        });
      }
    } finally {
      active.finishing = false;
      if (active.reconcilePending && this.#active === active && !active.finished) {
        active.reconcilePending = false;
        void this.#reconcileAndFinish(active);
      }
    }
  }

  #completeLiveItem(active: ActiveTurn, key: string, outcome: HostItemOutcome): void {
    const live = active.items.get(key);
    if (!live || live.completed) return;
    live.completed = true;
    this.#event({
      type: "item.completed",
      turnId: active.turnId,
      snapshot: { item: live.item, outcome },
    });
  }

  #completeTurn(active: ActiveTurn, outcome: TurnOutcome, nativeTurnRef?: NativeTurnRef): void {
    if (this.#active !== active || active.finished || !active.admissionCompleted) return;
    active.finished = true;
    this.#active = null;
    for (const interactionId of [...active.interactions.keys()]) {
      this.#closeInteraction(
        active,
        interactionId,
        outcome.status === "succeeded" ? "superseded" : "cancelled",
      );
    }
    const itemOutcome = itemOutcomeForTurn(outcome);
    for (const [key, live] of active.items) {
      if (!live.completed) this.#completeLiveItem(active, key, itemOutcome);
    }
    this.#event({
      type: "turn.completed",
      turnId: active.turnId,
      outcome,
      ...(nativeTurnRef ? { nativeTurnRef } : {}),
    });
    active.resolveCompletion();
  }

  #createActive(
    kind: ActiveKind,
    turnId: ActiveTurn["turnId"],
    userMessageID: string | null,
  ): ActiveTurn {
    let resolveCompletion = (): void => undefined;
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    let resolveAdmissionFailure: (error: HarnessError) => void = () => undefined;
    const admissionFailurePromise = new Promise<void>((resolve) => {
      resolveAdmissionFailure = () => resolve();
    });
    return {
      kind,
      turnId,
      userMessageID,
      preexistingUserMessageIds: new Set(this.#knownUserMessageIds),
      assistantMessageIds: new Set(),
      admissionBuffer: [],
      admissionSequence: 0,
      cancellationRequested: false,
      admissionCompleted: false,
      admissionFailure: null,
      admissionFailurePromise,
      resolveAdmissionFailure,
      finished: false,
      nativeCompleted: false,
      sawBusy: false,
      reconciledAfterReconnect: false,
      finishing: false,
      reconcilePending: false,
      terminalAssistant: null,
      items: new Map(),
      toolItemByCallId: new Map(),
      interactions: new Map(),
      completion,
      resolveCompletion,
    };
  }

  #flushAdmission(active: ActiveTurn): void {
    if (!active.admissionCompleted || this.#active !== active) return;
    active.admissionBuffer.sort((left, right) => left.sequence - right.sequence);
    for (const { output } of active.admissionBuffer.splice(0)) this.#channel.emit(output);
  }

  #failAdmission(active: ActiveTurn, error: HarnessError): void {
    if (this.#active !== active || active.admissionCompleted || active.finished) return;
    active.admissionBuffer.length = 0;
    active.admissionFailure = error;
    active.finished = true;
    this.#active = null;
    active.resolveAdmissionFailure(error);
    active.resolveCompletion();
  }

  async #refreshProjection(observedForTurnId?: ActiveTurn["turnId"]): Promise<void> {
    try {
      const projection = await readProjection(
        this.#transport,
        this.#session.id,
        this.#providerCatalog,
        this.#toolOutputLimit,
      );
      this.#applyProjection(projection, observedForTurnId);
    } catch {
      // A completed Turn remains valid even when the optional Usage refresh fails.
    }
  }

  #applyProjection(
    projection: OpenCodeSnapshotProjection,
    observedForTurnId?: ActiveTurn["turnId"],
  ): void {
    const previousState = this.#state;
    this.#session = projection.session;
    this.#snapshot = projection.snapshot;
    for (const { info } of projection.messages) {
      if (info.role === "user") this.#knownUserMessageIds.add(info.id);
    }
    this.#model = projection.model ?? this.#model;
    this.#variant = projection.variant;
    this.#permissionMode = permissionModeFromSession(this.#session.permission);
    this.#state = sessionState(
      this.#session,
      this.#modelCatalog,
      this.#model,
      this.#variant,
      this.#executionPolicy,
      harnessPermissionModeIdSchema.parse(this.#permissionMode),
    );
    if (JSON.stringify(this.#state) !== JSON.stringify(previousState)) {
      this.#event({ type: "session.state.changed", state: this.#state });
    }
    if (JSON.stringify(projection.usage) !== JSON.stringify(this.#usage)) {
      this.#usage = projection.usage;
      this.#event({
        type: "session.usage.changed",
        usage: projection.usage,
        ...(observedForTurnId ? { observedForTurnId } : {}),
      });
    }
  }

  #publishState(): void {
    this.#state = sessionState(
      this.#session,
      this.#modelCatalog,
      this.#model,
      this.#variant,
      this.#executionPolicy,
      harnessPermissionModeIdSchema.parse(this.#permissionMode),
    );
    this.#event({ type: "session.state.changed", state: this.#state });
  }

  #fault(error: unknown): void {
    if (this.#phase === "faulted" || this.#phase === "closed") return;
    const normalized = normalizeError(error, "internalError");
    if (this.#active && !this.#active.admissionCompleted) {
      const active = this.#active;
      active.admissionBuffer.length = 0;
      active.admissionFailure = normalized;
      active.resolveAdmissionFailure(normalized);
      active.finished = true;
      active.resolveCompletion();
      this.#active = null;
    } else if (this.#active) {
      this.#completeTurn(this.#active, { status: "failed", error: normalized });
    }
    this.#phase = "faulted";
    this.#event({ type: "session.faulted", error: normalized });
    this.#channel.end();
  }

  async #close(): Promise<void> {
    if (this.#phase === "closed") return;
    const faulted = this.#phase === "faulted";
    if (!faulted) this.#phase = "closing";
    const active = this.#active;
    if (active) {
      active.cancellationRequested = true;
      await this.#transport.abort(this.#session.id).catch(() => undefined);
      await Promise.race([
        active.completion,
        new Promise<void>((resolve) => setTimeout(resolve, this.#closeTimeoutMs)),
      ]);
    }
    await this.#transport.close();
    await this.#connection.close();
    if (this.#active) {
      this.#completeTurn(this.#active, {
        status: "failed",
        error: invalidState("OpenCode Session closed before active Turn cancellation settled"),
      });
    }
    if (!faulted) {
      this.#phase = "closed";
      this.#channel.end();
    }
  }

  #output(output: HarnessOutput): void {
    const active = this.#active;
    if (active && !active.admissionCompleted) {
      active.admissionBuffer.push({ output, sequence: active.admissionSequence++ });
      return;
    }
    this.#channel.emit(output);
  }

  #event(event: HostEvent): void {
    this.#output({ kind: "event", event });
  }

  #bindUserMessage(active: ActiveTurn, messageID: string): boolean {
    if (active.userMessageID) return active.userMessageID === messageID;
    if (active.preexistingUserMessageIds.has(messageID)) return false;
    active.userMessageID = messageID;
    this.#knownUserMessageIds.add(messageID);
    return true;
  }

  #resolveUserMessage(active: ActiveTurn, messages: OpenCodeMessageWithParts[]): void {
    if (active.userMessageID) return;
    const candidates = messages.filter(
      ({ info }) => info.role === "user" && !active.preexistingUserMessageIds.has(info.id),
    );
    const [candidate] = candidates;
    if (candidates.length === 1 && candidate) {
      this.#bindUserMessage(active, candidate.info.id);
      return;
    }
    const parents = new Set(
      messages
        .filter(({ info }) => info.role === "assistant")
        .map(({ info }) => (info as AssistantMessage).parentID),
    );
    const linked = candidates.filter(({ info }) => parents.has(info.id));
    const [linkedCandidate] = linked;
    if (linked.length === 1 && linkedCandidate) {
      this.#bindUserMessage(active, linkedCandidate.info.id);
      return;
    }
    if (candidates.length > 1) {
      throw new OpenCodeTransportError(
        "protocolError",
        "OpenCode admitted multiple native User Messages for one Host Turn",
      );
    }
  }
}

export class OpenCodeAdapter implements HarnessAdapter {
  readonly harnessId: HarnessId = openCodeHarnessId;
  readonly #closeTimeoutMs: number;
  readonly #createConnection: OpenCodeAdapterDependencies["createConnection"];
  readonly #createTransport: OpenCodeAdapterDependencies["createTransport"];
  readonly #inspectionCache = new Map<string, Extract<HarnessInspection, { status: "ready" }>>();
  readonly #inspectionInFlight = new Map<string, Promise<HarnessInspection>>();
  readonly #options: OpenCodeServerOptions;
  readonly #sessions = new Set<OpenCodeHarnessSession>();
  readonly #toolOutputLimit: number;
  readonly #uuid: () => string;
  #closePromise: Promise<void> | null = null;

  constructor(options: OpenCodeAdapterOptions = {}, dependencies?: OpenCodeAdapterDependencies) {
    this.#options = options;
    this.#createConnection =
      dependencies?.createConnection ??
      ((serverOptions) => new OpenCodeServerConnection(serverOptions));
    this.#createTransport =
      dependencies?.createTransport ??
      ((connection, cwd, serverOptions) =>
        new SdkOpenCodeTransport(connection, cwd, serverOptions));
    this.#uuid = dependencies?.randomUUID ?? randomUUID;
    this.#toolOutputLimit = options.toolOutputLimit ?? DEFAULT_TOOL_OUTPUT_LIMIT;
    this.#closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
  }

  async inspect(input: { cwd?: string; refresh?: boolean } = {}): Promise<HarnessInspection> {
    if (this.#closePromise) {
      return {
        status: "unavailable",
        error: invalidState("OpenCode Adapter is closed"),
      };
    }
    const cwd = input.cwd ?? process.cwd();
    const inFlight = this.#inspectionInFlight.get(cwd);
    if (inFlight) return inFlight;
    if (!input.refresh) {
      const cached = this.#inspectionCache.get(cwd);
      if (cached) return cached;
    }
    const inspection = this.#inspectCwd(cwd).then((result) => {
      if (result.status === "ready") this.#inspectionCache.set(cwd, result);
      return result;
    });
    this.#inspectionInFlight.set(cwd, inspection);
    return inspection.finally(() => {
      if (this.#inspectionInFlight.get(cwd) === inspection) this.#inspectionInFlight.delete(cwd);
    });
  }

  async #inspectCwd(cwd: string): Promise<HarnessInspection> {
    const startedAt = Date.now();
    let stage = "startup";
    const connection = this.#createConnection(this.#options);
    const transport = this.#createTransport(connection, cwd, this.#options);
    try {
      const health = await transport.health();
      if (health.healthy !== true) {
        throw new OpenCodeTransportError("protocolError", "OpenCode health check was not healthy");
      }
      stage = "model-catalog";
      const providers = await transport.providers();
      const catalog = normalizeOpenCodeModelCatalog(providers);
      stage = "commands";
      await transport.commands();
      return {
        status: "ready",
        catalog,
        capabilities: {
          configuration: {
            selectModel: catalog.models.length > 0,
            selectThinkingOption: catalog.thinkingOptions.length > 1,
            selectPermissionMode: true,
            permissionModeScope: "live",
          },
          history: { fork: true, forkAcrossCwd: false, rollbackLastTurn: true },
        },
        permissionModes: OPENCODE_PERMISSION_MODE_CATALOG,
      };
    } catch (error) {
      const normalized = normalizeError(error, "unavailable");
      return {
        status: normalized.code === "notInstalled" ? "notInstalled" : "error",
        error: {
          ...normalized,
          stage,
          durationMs: Date.now() - startedAt,
          ...(transport.stderrTail ? { stderrTail: transport.stderrTail } : {}),
        },
      };
    } finally {
      await transport.close().catch(() => undefined);
      await connection.close().catch(() => undefined);
    }
  }

  async open(input: OpenSessionInput): Promise<HarnessResult<HarnessSession>> {
    if (this.#closePromise) {
      return { ok: false, error: invalidState("OpenCode Adapter is closed") };
    }
    if (!input.cwd) {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "OpenCode Adapter requires cwd",
          retryable: false,
        },
      };
    }
    if (input.kind === "create" && input.thinkingOptionId && !input.model) {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "OpenCode Thinking selection requires a Model",
          retryable: false,
        },
      };
    }
    let connection: OpenCodeServerConnectionLike | undefined;
    let transport: OpenCodeTransport | undefined;
    let createdForCleanup: Session | undefined;
    let revertedForCleanup: string | undefined;
    try {
      const sourceRef =
        input.kind === "create"
          ? undefined
          : parseOpenCodeSessionRef(input.kind === "resume" ? input.nativeRef : input.sourceRef);
      const executionPolicy = input.executionPolicy ?? sourceRef?.executionPolicy ?? "default";
      let requestedPermissionMode: OpenCodePermissionMode | undefined;
      const requestedPermissionModeId =
        input.kind === "create"
          ? (input.permissionModeId ??
            (executionPolicy === "unattended-full-access"
              ? harnessPermissionModeIdSchema.parse("allow")
              : executionPolicy === "approval-required"
                ? harnessPermissionModeIdSchema.parse("ask")
                : OPENCODE_DEFAULT_PERMISSION_MODE_ID))
          : executionPolicy === "unattended-full-access"
            ? harnessPermissionModeIdSchema.parse("allow")
            : executionPolicy === "approval-required"
              ? harnessPermissionModeIdSchema.parse("ask")
              : undefined;
      if (requestedPermissionModeId) {
        try {
          requestedPermissionMode = decodeOpenCodePermissionModeId(requestedPermissionModeId);
        } catch {
          return {
            ok: false,
            error: {
              code: "invalidRequest",
              message: "OpenCode create Permission Mode is invalid",
              retryable: false,
            },
          };
        }
      }
      if (executionPolicy === "unattended-full-access" && requestedPermissionMode !== "allow") {
        return {
          ok: false,
          error: unsupported("OpenCode unattended execution requires the allow Permission Mode"),
        };
      }
      if (executionPolicy === "approval-required" && requestedPermissionMode !== "ask") {
        return {
          ok: false,
          error: unsupported(
            "OpenCode approval-required execution requires the ask Permission Mode",
          ),
        };
      }
      const sessionEnvironment = input.environment ?? this.#options.environment ?? process.env;
      const serverOptions: OpenCodeServerOptions = {
        ...this.#options,
        environment: managedOpenCodeEnvironment(sessionEnvironment, executionPolicy),
      };
      connection = this.#createConnection(serverOptions);
      transport = this.#createTransport(connection, input.cwd, serverOptions);
      const providers = await transport.providers();
      const modelCatalog = normalizeOpenCodeModelCatalog(providers);
      let session: Session;
      if (input.kind === "create") {
        const model = input.model ? decodeOpenCodeModelRef(input.model) : undefined;
        const variant = input.thinkingOptionId
          ? decodeOpenCodeVariant(input.thinkingOptionId)
          : undefined;
        if (input.model && !modelCatalog.models.some(({ ref }) => ref.id === input.model?.id)) {
          throw new OpenCodeTransportError(
            "protocolError",
            "Requested OpenCode Model is absent from the connected Provider catalog",
          );
        }
        const permission =
          requestedPermissionMode && requestedPermissionMode !== "default"
            ? requestedPermissionRules(undefined, requestedPermissionMode)
            : undefined;
        session = await transport.createSession({
          ...(model ? { model } : {}),
          ...(variant ? { variant } : {}),
          ...(permission ? { permission } : {}),
        });
        createdForCleanup = session;
      } else {
        if (!sourceRef) {
          throw new OpenCodeTransportError("protocolError", "OpenCode source ref is missing");
        }
        if (sourceRef.ref.harnessId !== this.harnessId) {
          await transport.close().catch(() => undefined);
          await connection.close().catch(() => undefined);
          return {
            ok: false,
            error: {
              code: "invalidRequest",
              message: "OpenCode Adapter cannot open another Harness's Native Session",
              retryable: false,
            },
          };
        }
        const source = await transport.getSession(sourceRef.ref.nativeSessionId);
        if (source.id !== sourceRef.ref.nativeSessionId) {
          throw new OpenCodeTransportError(
            "protocolError",
            "OpenCode resumed Session identity changed",
          );
        }
        if (!sameCwd(source.directory, input.cwd)) {
          await transport.close().catch(() => undefined);
          await connection.close().catch(() => undefined);
          return {
            ok: false,
            error: unsupported("OpenCode cross-cwd Fork and Resume are not supported"),
          };
        }
        if (input.kind === "resume") {
          session = source;
        } else if (input.kind === "fork") {
          const checkpoint = nativeCheckpointRefSchema.parse(input.checkpoint);
          if (checkpoint.harnessId !== this.harnessId || checkpoint.nativeSessionId !== source.id) {
            throw new OpenCodeTransportError(
              "protocolError",
              "OpenCode Checkpoint does not belong to the source Session",
            );
          }
          const sourceMessages = await transport.getMessages(source.id);
          const boundary = resolveOpenCodeForkBoundary(source, sourceMessages, checkpoint);
          if (!boundary) {
            await transport.close().catch(() => undefined);
            await connection.close().catch(() => undefined);
            return {
              ok: false,
              error: {
                code: "checkpointNotFound",
                message: "OpenCode Checkpoint is not on the source Session transcript",
                retryable: false,
              },
            };
          }
          session = await transport.forkSession(source.id, boundary.messageID);
          createdForCleanup = session;
          if (session.id === source.id) {
            throw new OpenCodeTransportError(
              "protocolError",
              "OpenCode Fork did not create a distinct Native Session",
            );
          }
          const derivedMessages = await transport.getMessages(session.id);
          const derived = projectOpenCodeHistory({
            session,
            messages: derivedMessages,
            toolOutputLimit: this.#toolOutputLimit,
          });
          if (derived.turns.length !== boundary.sourceTurnCount) {
            throw new OpenCodeTransportError(
              "protocolError",
              "OpenCode Fork derived history does not match the requested Checkpoint",
            );
          }
        } else {
          const sourceMessages = await transport.getMessages(source.id);
          const boundary = resolveOpenCodeLastTurnBoundary(source, sourceMessages);
          if (!boundary) {
            await transport.close().catch(() => undefined);
            await connection.close().catch(() => undefined);
            return {
              ok: false,
              error: invalidState("OpenCode Native Session has no Turn to roll back"),
            };
          }
          session = await transport.revertSession(source.id, boundary.lastUserMessageID);
          revertedForCleanup = source.id;
          const afterMessages = await transport.getMessages(session.id);
          const after = projectOpenCodeHistory({
            session,
            messages: afterMessages,
            toolOutputLimit: this.#toolOutputLimit,
          });
          if (after.turns.length !== boundary.sourceTurnCount - 1) {
            throw new OpenCodeTransportError(
              "protocolError",
              "OpenCode rollback did not remove exactly the last Turn",
            );
          }
        }
      }
      if (input.kind !== "create" && requestedPermissionMode) {
        session = await transport.updateSessionPermission(
          session.id,
          requestedPermissionRules(session.permission, requestedPermissionMode),
        );
      }
      const projection = await readProjection(
        transport,
        session.id,
        providers,
        this.#toolOutputLimit,
      );
      if (
        requestedPermissionMode &&
        permissionModeFromSession(projection.session.permission) !== requestedPermissionMode
      ) {
        throw new Error("OpenCode did not activate the requested Permission Mode");
      }
      const harnessSession = new OpenCodeHarnessSession({
        transport,
        connection,
        projection,
        providerCatalog: providers,
        modelCatalog,
        toolOutputLimit: this.#toolOutputLimit,
        closeTimeoutMs: this.#closeTimeoutMs,
        randomUUID: this.#uuid,
        executionPolicy,
        permissionMode: permissionModeFromSession(projection.session.permission),
        onClosed: () => this.#sessions.delete(harnessSession),
      });
      await harnessSession.start();
      this.#sessions.add(harnessSession);
      createdForCleanup = undefined;
      revertedForCleanup = undefined;
      return { ok: true, value: harnessSession };
    } catch (error) {
      if (revertedForCleanup && transport) {
        await transport.unrevertSession(revertedForCleanup).catch(() => undefined);
      }
      if (createdForCleanup && transport) {
        await transport.deleteSession(createdForCleanup.id).catch(() => undefined);
      }
      await transport?.close().catch(() => undefined);
      await connection?.close().catch(() => undefined);
      return { ok: false, error: normalizeError(error, "nativeFailure") };
    }
  }

  close(): Promise<void> {
    this.#closePromise ??= Promise.all([
      ...[...this.#sessions].map((session) => session.close()),
    ]).then(() => undefined);
    return this.#closePromise;
  }
}
