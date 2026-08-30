import { randomUUID } from "node:crypto";
import path from "node:path";

import type {
  ClientResponse,
  HistoryEntry,
  MuxFrame,
  RpcId,
  RpcResponse,
} from "@deepseek-ai/dsh-host-apiproxy/api";
import type { SessionId } from "@deepseek-ai/dsh-session/types";

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
  type HarnessModelRef,
  type HarnessOutput,
  type HarnessResult,
  type HarnessSession,
  type HarnessSessionCapabilities,
  type HarnessSessionState,
  type HostAgentMessageItem,
  type HostApprovalInteraction,
  type HostCommand,
  type HostContextCompactionItem,
  type HostFileChangeItem,
  type HostItem,
  type HostItemOutcome,
  type HostItemSnapshot,
  type HostQuestionInteraction,
  type HostReasoningItem,
  type HostThreadSnapshot,
  type HostToolExecutionItem,
  type HostTurnSnapshot,
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
  type TurnStartAccepted,
  type TurnStartCommand,
} from "@codexhost/harness-adapter";
import {
  harnessCommandCatalogSchema,
  harnessIdSchema,
  harnessThinkingOptionIdSchema,
  hostInteractionIdSchema,
  hostItemIdSchema,
  nativeSessionRefSchema,
  nativeTurnRefSchema,
  type HarnessId,
  type HarnessThinkingOption,
  type HostInteractionId,
  type HostItemId,
  type HostTurnId,
  type NativeSessionRef,
  type NativeTurnRef,
} from "@codexhost/shared-contracts";

import {
  DeepSeekHarnessTransportError,
  DeepSeekHostConnection,
  type DeepSeekCommandClient,
  type DeepSeekHostClient,
  type DeepSeekHostConnectionOptions,
  type DeepSeekHostSubscriber,
  type DeepSeekMuxEnvelope,
} from "./host-client.js";
import { projectDeepSeekHistory } from "./history.js";
import {
  decodeDeepSeekHarnessModelRef,
  encodeDeepSeekHarnessModelRef,
  normalizeDeepSeekModelCatalog,
  normalizeDeepSeekThinkingOptions,
  parseDeepSeekThinkingOptionId,
} from "./model-catalog.js";
import {
  contentText,
  deepSeekUsageKey,
  isRecord,
  mergeDeepSeekUsage,
  nonBlankString,
  parseArguments,
  parseDeepSeekContextWindow,
  parseDeepSeekOutputTokensPerSecond,
  parseDeepSeekUsage,
  projectToolResult,
  projectTurnReason,
  structuredDiffs,
} from "./projection.js";

export interface DeepSeekHarnessAdapterOptions extends DeepSeekHostConnectionOptions {
  toolOutputLimit?: number;
}

export interface DeepSeekHostConnectionLike {
  readonly client: DeepSeekHostClient;
  readonly stderrTail?: string;
  connect(): Promise<void>;
  subscribe(sessionId: string, subscriber: DeepSeekHostSubscriber): () => void;
  close(): Promise<void>;
}

export interface DeepSeekHarnessAdapterDependencies {
  randomUUID(): string;
  createConnection(options: DeepSeekHostConnectionOptions): DeepSeekHostConnectionLike;
}

interface ActiveTool {
  item: HostToolExecutionItem;
  startedAtMs: number;
  toolName: string;
}

type ActiveInteraction =
  | {
      type: "approval";
      interaction: HostApprovalInteraction;
      rpcId: RpcId;
      approvalId: string;
    }
  | {
      type: "question";
      interaction: HostQuestionInteraction;
      rpcId: RpcId;
      questions: Extract<MuxFrame, { type: "question/requested" }>["questions"];
    };

interface ActiveTurn {
  command: TurnStartCommand;
  nativeTurn: number | null;
  started: boolean;
  cancellationRequested: boolean;
  agentItem: HostAgentMessageItem | null;
  reasoningItem: HostReasoningItem | null;
  tools: Map<string, ActiveTool>;
  interactions: Map<HostInteractionId, ActiveInteraction>;
  snapshots: HostItemSnapshot[];
}

interface ActiveCommand {
  command: HarnessCommandInvocation;
  abort: AbortController;
  cancellationRequested: boolean;
  item: HostContextCompactionItem;
}

const deepSeekHarnessId = harnessIdSchema.parse("deepseek-harness");
const deepSeekCommandCatalog = harnessCommandCatalogSchema.parse({
  commands: [
    {
      id: "dsh.compact",
      invocation: "/compact",
      label: "Compact context",
      description:
        "Compact the current conversation context through the DeepSeek Harness command registry",
      argumentMode: "none",
    },
  ],
});
const emptyDeepSeekCommandCatalog = harnessCommandCatalogSchema.parse({ commands: [] });
const DSH_COMPACT_BUSY =
  "Compaction is unavailable because this process has an active compaction, or the agent is not idle.";
const DSH_COMPACT_CANCELLED = "Compaction cancelled.";
const DEFAULT_TOOL_OUTPUT_LIMIT = 64_000;
const HISTORY_PAGE_MESSAGES = 100;
const HISTORY_PAGE_LIMIT = 10_000;
const DELEGATION_PERMISSION_PRESET = "danger-full-access";

function normalizedError(error: unknown, fallback: HarnessError["code"]): HarnessError {
  if (error instanceof DeepSeekHarnessTransportError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.code === "unavailable" || error.code === "processExited",
    };
  }
  return {
    code: fallback,
    message: error instanceof Error ? error.message : String(error),
    retryable: fallback === "unavailable" || fallback === "nativeFailure",
  };
}

function invalidState(message: string): HarnessError {
  return { code: "invalidState", message, retryable: false };
}

function unsupported(message: string): HarnessError {
  return { code: "unsupported", message, retryable: false };
}

function commandFailure(operation: string, error: { code: string; message: string }): HarnessError {
  const code = error.code === "session-not-found" ? "unavailable" : "nativeFailure";
  return {
    code,
    message: `DeepSeek Harness '${operation}' failed: ${error.message}`,
    retryable: code === "unavailable" || error.code === "internal",
  };
}

function unwrapRpc<T>(response: RpcResponse<T>, operation: string): T {
  if (response.result.ok) return response.result.value;
  const error = response.result.error;
  throw new DeepSeekHarnessTransportError(
    error.code === "session-not-found" ? "unavailable" : "protocolError",
    `DeepSeek Harness '${operation}' failed: ${error.message}`,
  );
}

function delegationPermissionIsApplied(entries: readonly HistoryEntry[]): boolean {
  let preset: string | undefined;
  let sandboxMode: string | undefined;
  let approvalPolicy: string | undefined;
  for (const entry of entries) {
    const nativeEvent: unknown = entry.event;
    if (
      !isRecord(nativeEvent) ||
      typeof nativeEvent.type !== "string" ||
      !isRecord(nativeEvent.data)
    ) {
      continue;
    }
    const data = nativeEvent.data;
    if (nativeEvent.type === "permission/preset" && nonBlankString(data.preset)) {
      preset = data.preset;
    } else if (nativeEvent.type === "sandbox/mode" && nonBlankString(data.mode)) {
      sandboxMode = data.mode;
    } else if (nativeEvent.type === "approval/policy" && nonBlankString(data.policy)) {
      approvalPolicy = data.policy;
    }
  }
  return (
    preset === DELEGATION_PERMISSION_PRESET &&
    sandboxMode === DELEGATION_PERMISSION_PRESET &&
    approvalPolicy === "never"
  );
}

async function applyDelegationPermission(
  client: DeepSeekHostClient,
  sessionId: SessionId,
): Promise<void> {
  const response = await client.commands.execute(
    sessionId,
    `/permission ${DELEGATION_PERMISSION_PRESET}`,
  );
  if (!response.ok) {
    throw commandFailure("commands/execute", response.error);
  }
  const execution = response.value;
  if (!execution || execution.result.kind !== "success") {
    throw new DeepSeekHarnessTransportError(
      "nativeFailure",
      execution?.result.text ?? "DeepSeek Harness did not apply the requested Permission Mode",
    );
  }
  const entries = await readAllDeepSeekHistory(client, sessionId);
  if (!delegationPermissionIsApplied(entries)) {
    throw new DeepSeekHarnessTransportError(
      "nativeFailure",
      "DeepSeek Harness did not confirm danger-full-access with approval policy never",
    );
  }
}

export async function readAllDeepSeekHistory(
  client: DeepSeekHostClient,
  sessionId: SessionId,
): Promise<HistoryEntry[]> {
  let beforeSeq: number | undefined;
  const pages: HistoryEntry[][] = [];
  for (let page = 0; page < HISTORY_PAGE_LIMIT; page += 1) {
    const value = unwrapRpc(
      await client.sessions.history({
        sessionId,
        maxMessages: HISTORY_PAGE_MESSAGES,
        ...(beforeSeq === undefined ? {} : { beforeSeq }),
      }),
      "session.history",
    );
    pages.unshift(value.events);
    if (!value.hasMore) return pages.flat();
    const firstSeq = value.events[0]?.event.seq;
    if (firstSeq === undefined || (beforeSeq !== undefined && firstSeq >= beforeSeq)) {
      throw new DeepSeekHarnessTransportError(
        "protocolError",
        "DeepSeek Harness history pagination did not advance",
      );
    }
    beforeSeq = firstSeq;
  }
  throw new DeepSeekHarnessTransportError(
    "protocolError",
    "DeepSeek Harness history exceeded the pagination safety bound",
  );
}

class DeepSeekHarnessSession implements HarnessSession, DeepSeekHostSubscriber {
  readonly harnessId: HarnessId = deepSeekHarnessId;
  readonly capabilities: HarnessSessionCapabilities = {
    configuration: {
      selectModel: true,
      selectThinkingOption: true,
      selectPermissionMode: false,
    },
    history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
  };
  readonly commands: HarnessCommandCapability = {
    list: () => this.#listHarnessCommands(),
    execute: (command) => this.#executeHarnessCommand(command),
  };
  readonly initialState: HarnessSessionState;
  readonly initialUsage: HostUsage | null;

  readonly outputs: AsyncIterable<HarnessOutput>;
  readonly #channel = new HarnessOutputChannel<HarnessOutput>();
  readonly #client: DeepSeekHostClient;
  readonly #commandClient: DeepSeekCommandClient;
  readonly #nativeRef: NativeSessionRef;
  readonly #onClosed: () => void;
  readonly #toolOutputLimit: number;
  readonly #unsubscribe: () => void;
  #active: ActiveTurn | null = null;
  #activeCommand: ActiveCommand | null = null;
  #closePromise: Promise<void> | null = null;
  #closed = false;
  #configuring = false;
  #lastSeq: number;
  #reading = false;
  #model: HarnessModelRef;
  #thinkingOptionId: HarnessThinkingOption["id"] | undefined;
  #availableThinkingOptions: HarnessThinkingOption[];
  #contextWindowTokens: number | undefined;
  #turns: HostTurnSnapshot[];
  #usageBaseline: HostUsage | null;
  #usageByStep = new Map<string, HostUsage>();
  #usage: HostUsage | null = null;
  #usageSequence = 0;
  #latestUsageKey: string | undefined;
  #outputTokensPerSecond: number | undefined;

  constructor(input: {
    client: DeepSeekHostClient;
    model: HarnessModelRef;
    nativeSessionId: string;
    lastSeq: number;
    contextWindowTokens?: number;
    thinkingOptionId?: HarnessThinkingOption["id"];
    availableThinkingOptions?: HarnessThinkingOption[];
    initialUsage?: HostUsage | null;
    onClosed(): void;
    snapshot: HostThreadSnapshot;
    toolOutputLimit: number;
    unsubscribe(): void;
  }) {
    this.#client = input.client;
    this.#commandClient = input.client.commands;
    this.#model = input.model;
    this.#thinkingOptionId = input.thinkingOptionId;
    this.#availableThinkingOptions = input.availableThinkingOptions ?? [];
    this.#onClosed = input.onClosed;
    this.#toolOutputLimit = input.toolOutputLimit;
    this.#unsubscribe = input.unsubscribe;
    this.#lastSeq = input.lastSeq;
    this.#contextWindowTokens = input.contextWindowTokens;
    this.initialUsage = input.initialUsage ?? null;
    this.#usageBaseline = this.initialUsage;
    this.#usage = this.initialUsage;
    this.#turns = [...input.snapshot.turns];
    this.#nativeRef = nativeSessionRefSchema.parse({
      harnessId: this.harnessId,
      nativeSessionId: input.nativeSessionId,
      formatVersion: 1,
    });
    this.initialState = {
      nativeRef: this.#nativeRef,
      effectiveModel: input.model,
      ...(input.thinkingOptionId ? { effectiveThinkingOptionId: input.thinkingOptionId } : {}),
      ...(input.availableThinkingOptions && input.availableThinkingOptions.length > 0
        ? { availableThinkingOptions: input.availableThinkingOptions }
        : {}),
    };
    this.outputs = this.#channel.outputs;
  }

  async readSnapshot(): Promise<HarnessResult<HostThreadSnapshot>> {
    if (this.#closed) {
      return { ok: false, error: invalidState("DeepSeek Harness Session is closed") };
    }
    if (this.#active || this.#activeCommand || this.#configuring || this.#reading) {
      return {
        ok: false,
        error: {
          code: "sessionBusy",
          message: "DeepSeek Harness Session cannot read while another operation is active",
          retryable: true,
        },
      };
    }
    this.#reading = true;
    try {
      const [entries, modelState] = await Promise.all([
        readAllDeepSeekHistory(this.#client, this.#nativeRef.nativeSessionId as SessionId),
        this.#client.sessions.models({
          sessionId: this.#nativeRef.nativeSessionId as SessionId,
        }),
      ]);
      const models = unwrapRpc(modelState, "session.models");
      const model = encodeDeepSeekHarnessModelRef(models.current);
      const projection = projectDeepSeekHistory({
        harnessId: this.harnessId,
        sessionId: this.#nativeRef.nativeSessionId,
        entries,
        fallbackModel: model,
        toolOutputLimit: this.#toolOutputLimit,
      });
      this.#lastSeq = Math.max(this.#lastSeq, projection.lastSeq);
      this.#turns = [...projection.snapshot.turns];
      this.#contextWindowTokens = projection.contextWindowTokens;
      this.#usageBaseline = projection.usage;
      this.#usageByStep.clear();
      this.#latestUsageKey = undefined;
      this.#model = model;
      this.#thinkingOptionId = parseDeepSeekThinkingOptionId(models.current.reasoningEffort);
      this.#availableThinkingOptions = normalizeDeepSeekThinkingOptions(models);
      const usage = this.#withOutputSpeed(projection.usage);
      if (JSON.stringify(usage) !== JSON.stringify(this.#usage)) {
        this.#usage = usage;
        this.#emit({ type: "session.usage.changed", usage });
      }
      return {
        ok: true,
        value: {
          ...projection.snapshot,
          state: {
            nativeRef: this.#nativeRef,
            effectiveModel: this.#model,
            ...(this.#thinkingOptionId
              ? { effectiveThinkingOptionId: this.#thinkingOptionId }
              : {}),
            ...(this.#availableThinkingOptions.length > 0
              ? { availableThinkingOptions: this.#availableThinkingOptions }
              : {}),
          },
        },
      };
    } catch (error) {
      return { ok: false, error: normalizedError(error, "nativeFailure") };
    } finally {
      this.#reading = false;
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
    if (this.#closed)
      return { ok: false, error: invalidState("DeepSeek Harness Session is closed") };
    if (command.type === "turn.cancel") return this.#cancel(command);
    if (command.type === "interaction.respond") return this.#respond(command);
    if (command.type === "model.select") return this.#selectModel(command);
    if (command.type === "thinking.select") return this.#selectThinking(command);
    if (command.type !== "turn.start") {
      return {
        ok: false,
        error: unsupported(`DeepSeek Harness does not support '${command.type}'`),
      };
    }
    if (this.#active || this.#activeCommand || this.#configuring || this.#reading) {
      return {
        ok: false,
        error: {
          code: "sessionBusy",
          message: "DeepSeek Harness Session already has another active operation",
          retryable: true,
        },
      };
    }
    const text = command.input.map((input) => input.text).join("\n");
    if (!text) {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "DeepSeek Harness Turn is empty",
          retryable: false,
        },
      };
    }
    const active: ActiveTurn = {
      command,
      nativeTurn: null,
      started: false,
      cancellationRequested: false,
      agentItem: null,
      reasoningItem: null,
      tools: new Map(),
      interactions: new Map(),
      snapshots: [],
    };
    this.#active = active;
    try {
      unwrapRpc(
        await this.#client.sessions.prompt({
          sessionId: this.#nativeRef.nativeSessionId as SessionId,
          mode: "queue",
          content: [{ type: "text", text }],
        }),
        "session.prompt",
      );
      return { ok: true, value: { turnId: command.turnId } };
    } catch (error) {
      if (this.#active === active) this.#active = null;
      return { ok: false, error: normalizedError(error, "nativeFailure") };
    }
  }

  onMux(envelope: DeepSeekMuxEnvelope): void {
    if (this.#closed) return;
    const frame = envelope.payload;
    if (frame.type === "session/projection") {
      if (frame.sessionId === this.#nativeRef.nativeSessionId && frame.key === "sessionStats") {
        const speed = parseDeepSeekOutputTokensPerSecond(frame.value);
        if (speed !== undefined) {
          this.#outputTokensPerSecond = speed;
          this.#publishUsage();
        }
      }
      return;
    }
    if (frame.type === "session/event") {
      if (frame.event.seq <= this.#lastSeq) return;
      this.#lastSeq = frame.event.seq;
      if (!isRecord(frame.event.data)) {
        this.#fault(
          normalizedError("DeepSeek Harness emitted invalid event data", "protocolError"),
        );
        return;
      }
      try {
        this.#event(frame.event.type, frame.event.data);
      } catch (error) {
        this.#fault(normalizedError(error, "protocolError"));
      }
      return;
    }
    if (frame.type === "approval/requested") {
      this.#approval(envelope.rpcId, frame);
    } else if (frame.type === "approval/resolved") {
      this.#closeNativeInteraction("approval", frame.approvalId);
    } else if (frame.type === "question/requested") {
      this.#question(envelope.rpcId, frame);
    } else if (frame.type === "question/resolved") {
      this.#closeNativeInteraction("question", frame.questionRpcId);
    }
  }

  onFault(error: DeepSeekHarnessTransportError): void {
    this.#fault(normalizedError(error, error.code));
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#performClose();
    return this.#closePromise;
  }

  async #performClose(): Promise<void> {
    if (this.#closed) return;
    const activeCommand = this.#activeCommand;
    if (activeCommand) {
      activeCommand.cancellationRequested = true;
      activeCommand.abort.abort(new Error("codexhost Session closed"));
      this.#finishCommand(activeCommand, {
        status: "cancelled",
        reason: "DeepSeek Harness command was cancelled because the Session closed",
      });
    }
    const active = this.#active;
    if (active) {
      for (const pending of active.interactions.values()) {
        await this.#client
          .respond({
            type: "client-response",
            rpcId: pending.rpcId,
            result: {
              ok: false,
              error: { code: "cancelled", message: "codexhost Session closed", details: {} },
            },
          })
          .catch(() => undefined);
      }
    }
    this.#unsubscribe();
    this.#closed = true;
    this.#channel.end();
    this.#onClosed();
  }

  async #selectModel(command: ModelSelectCommand): Promise<HarnessResult<ModelSelectCompleted>> {
    if (this.#active || this.#activeCommand || this.#configuring || this.#reading) {
      return {
        ok: false,
        error: {
          code: "sessionBusy",
          message:
            "DeepSeek Harness Session cannot select a Model while another operation is active",
          retryable: true,
        },
      };
    }
    let requested: ReturnType<typeof decodeDeepSeekHarnessModelRef>;
    try {
      requested = decodeDeepSeekHarnessModelRef(command.model);
    } catch (error) {
      return { ok: false, error: normalizedError(error, "invalidRequest") };
    }

    this.#configuring = true;
    try {
      try {
        unwrapRpc(
          await this.#client.sessions.selectModel({
            sessionId: this.#nativeRef.nativeSessionId as SessionId,
            provider: requested.provider,
            model: requested.model,
          }),
          "session.selectModel",
        );
        const models = unwrapRpc(
          await this.#client.sessions.models({
            sessionId: this.#nativeRef.nativeSessionId as SessionId,
          }),
          "session.models",
        );
        if (
          models.current.provider !== requested.provider ||
          models.current.model !== requested.model
        ) {
          return {
            ok: false,
            error: {
              code: "nativeFailure",
              message: "DeepSeek Harness did not activate the requested Model",
              retryable: false,
            },
          };
        }
        this.#model = encodeDeepSeekHarnessModelRef(models.current);
        this.#thinkingOptionId = parseDeepSeekThinkingOptionId(models.current.reasoningEffort);
        this.#availableThinkingOptions = normalizeDeepSeekThinkingOptions(models);
        this.#emit({
          type: "session.state.changed",
          state: {
            nativeRef: this.#nativeRef,
            effectiveModel: this.#model,
            ...(this.#thinkingOptionId
              ? { effectiveThinkingOptionId: this.#thinkingOptionId }
              : {}),
            ...(this.#availableThinkingOptions.length > 0
              ? { availableThinkingOptions: this.#availableThinkingOptions }
              : {}),
          },
        });
        return { ok: true, value: { completed: true } };
      } catch (error) {
        return { ok: false, error: normalizedError(error, "nativeFailure") };
      }
    } finally {
      this.#configuring = false;
    }
  }

  async #selectThinking(
    command: ThinkingSelectCommand,
  ): Promise<HarnessResult<ThinkingSelectCompleted>> {
    if (this.#active || this.#configuring || this.#reading) {
      return {
        ok: false,
        error: {
          code: "sessionBusy",
          message:
            "DeepSeek Harness Session cannot select Thinking while another operation is active",
          retryable: true,
        },
      };
    }
    const requested = harnessThinkingOptionIdSchema.safeParse(command.thinkingOptionId);
    if (!requested.success) {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "DeepSeek Harness Thinking option is invalid",
          retryable: false,
        },
      };
    }
    const current = decodeDeepSeekHarnessModelRef(this.#model);
    this.#configuring = true;
    try {
      try {
        unwrapRpc(
          await this.#client.sessions.selectModel({
            sessionId: this.#nativeRef.nativeSessionId as SessionId,
            provider: current.provider,
            model: current.model,
            reasoningEffort: requested.data,
          }),
          "session.selectModel",
        );
        const models = unwrapRpc(
          await this.#client.sessions.models({
            sessionId: this.#nativeRef.nativeSessionId as SessionId,
          }),
          "session.models",
        );
        if (
          models.current.provider !== current.provider ||
          models.current.model !== current.model ||
          models.current.reasoningEffort !== requested.data
        ) {
          return {
            ok: false,
            error: {
              code: "nativeFailure",
              message: "DeepSeek Harness did not activate the requested Thinking option",
              retryable: false,
            },
          };
        }
        this.#thinkingOptionId = requested.data;
        this.#availableThinkingOptions = normalizeDeepSeekThinkingOptions(models);
        this.#emit({
          type: "session.state.changed",
          state: {
            nativeRef: this.#nativeRef,
            effectiveModel: this.#model,
            effectiveThinkingOptionId: this.#thinkingOptionId,
            ...(this.#availableThinkingOptions.length > 0
              ? { availableThinkingOptions: this.#availableThinkingOptions }
              : {}),
          },
        });
        return { ok: true, value: { completed: true } };
      } catch (error) {
        return { ok: false, error: normalizedError(error, "nativeFailure") };
      }
    } finally {
      this.#configuring = false;
    }
  }

  async #listHarnessCommands(): Promise<HarnessResult<typeof deepSeekCommandCatalog>> {
    if (this.#closed) {
      return { ok: false, error: invalidState("DeepSeek Harness Session is closed") };
    }
    try {
      const result = await this.#commandClient.list(this.#nativeRef.nativeSessionId as SessionId);
      if (!result.ok) return { ok: false, error: commandFailure("commands/list", result.error) };
      const available = result.value.some(
        (descriptor) => descriptor.name === "compact" && descriptor.input === undefined,
      );
      return { ok: true, value: available ? deepSeekCommandCatalog : emptyDeepSeekCommandCatalog };
    } catch (error) {
      return { ok: false, error: normalizedError(error, "unavailable") };
    }
  }

  async #executeHarnessCommand(
    command: HarnessCommandInvocation,
  ): Promise<HarnessResult<HarnessCommandAccepted>> {
    if (this.#closed) {
      return { ok: false, error: invalidState("DeepSeek Harness Session is closed") };
    }
    if (command.commandId !== "dsh.compact") {
      return {
        ok: false,
        error: {
          code: "unsupported",
          message: `DeepSeek Harness does not expose command '${command.commandId}'`,
          retryable: false,
        },
      };
    }
    if (this.#active || this.#activeCommand || this.#configuring || this.#reading) {
      return {
        ok: false,
        error: {
          code: "sessionBusy",
          message:
            "DeepSeek Harness Session cannot execute a command while another operation is active",
          retryable: true,
        },
      };
    }
    if (command.arguments && Object.keys(command.arguments).length > 0) {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "DeepSeek Harness compact command does not accept arguments",
          retryable: false,
        },
      };
    }

    const active: ActiveCommand = {
      command,
      abort: new AbortController(),
      cancellationRequested: false,
      item: { type: "contextCompaction", itemId: this.#newItemId() },
    };
    this.#activeCommand = active;
    this.#emit({ type: "turn.started", turnId: command.turnId });
    this.#emit({ type: "item.started", turnId: command.turnId, item: active.item });
    void this.#runHarnessCommand(active);
    return { ok: true, value: { turnId: command.turnId } };
  }

  async #runHarnessCommand(active: ActiveCommand): Promise<void> {
    try {
      const response = await this.#commandClient.execute(
        this.#nativeRef.nativeSessionId as SessionId,
        "/compact",
        active.abort.signal,
      );
      if (this.#activeCommand !== active) return;
      if (!response.ok) {
        if (active.cancellationRequested || response.error.code === "cancelled") {
          this.#finishCommand(active, {
            status: "cancelled",
            reason: "DeepSeek Harness context compaction was cancelled",
          });
        } else {
          this.#finishCommand(active, {
            status: "failed",
            error: commandFailure("commands/execute", response.error),
          });
        }
        return;
      }
      const execution = response.value;
      if (!execution) {
        this.#finishCommand(active, {
          status: "failed",
          error: {
            code: "nativeFailure",
            message: "DeepSeek Harness did not resolve the registered /compact command",
            retryable: false,
          },
        });
        return;
      }
      if (execution.result.kind === "success") {
        this.#finishCommand(active, { status: "succeeded" });
      } else if (active.cancellationRequested || execution.result.text === DSH_COMPACT_CANCELLED) {
        this.#finishCommand(active, {
          status: "cancelled",
          reason: execution.result.text,
        });
      } else {
        this.#finishCommand(active, {
          status: "failed",
          error: {
            code: execution.result.text === DSH_COMPACT_BUSY ? "sessionBusy" : "nativeFailure",
            message: execution.result.text,
            retryable: true,
          },
        });
      }
    } catch (error) {
      if (this.#activeCommand !== active) return;
      if (active.cancellationRequested || active.abort.signal.aborted) {
        this.#finishCommand(active, {
          status: "cancelled",
          reason: "DeepSeek Harness context compaction was cancelled",
        });
      } else {
        this.#finishCommand(active, {
          status: "failed",
          error: normalizedError(error, "nativeFailure"),
        });
      }
    }
  }

  #finishCommand(active: ActiveCommand, outcome: HostItemOutcome): void {
    if (this.#activeCommand !== active) return;
    this.#activeCommand = null;
    this.#emit({
      type: "item.completed",
      turnId: active.command.turnId,
      snapshot: { item: active.item, outcome },
    });
    this.#emit({ type: "turn.completed", turnId: active.command.turnId, outcome });
  }

  async #cancel(command: TurnCancelCommand): Promise<HarnessResult<TurnCancelAccepted>> {
    const activeCommand = this.#activeCommand;
    if (activeCommand?.command.turnId === command.turnId) {
      if (!activeCommand.cancellationRequested) {
        activeCommand.cancellationRequested = true;
        activeCommand.abort.abort(new Error("DeepSeek Harness command cancelled by user"));
      }
      return { ok: true, value: { cancellationRequested: true } };
    }
    const active = this.#active;
    if (!active || active.command.turnId !== command.turnId) {
      return { ok: false, error: invalidState("DeepSeek Harness cancel requires the active Turn") };
    }
    try {
      unwrapRpc(
        await this.#client.sessions.cancel({
          sessionId: this.#nativeRef.nativeSessionId as SessionId,
        }),
        "session.cancel",
      );
      active.cancellationRequested = true;
      return { ok: true, value: { cancellationRequested: true } };
    } catch (error) {
      return { ok: false, error: normalizedError(error, "nativeFailure") };
    }
  }

  async #respond(
    command: InteractionRespondCommand,
  ): Promise<HarnessResult<InteractionRespondAccepted>> {
    const active = this.#active;
    const pending = active?.interactions.get(command.interactionId);
    if (!active || !pending) {
      return { ok: false, error: invalidState("DeepSeek Harness Interaction is not active") };
    }
    let message: ClientResponse;
    if (pending.type === "approval") {
      if (command.response.type !== "approval") {
        return { ok: false, error: invalidState("DeepSeek Harness approval response is invalid") };
      }
      const validationError = validateHostApprovalResponse(pending.interaction, command.response);
      if (validationError) return { ok: false, error: validationError };
      message = {
        type: "client-response",
        rpcId: pending.rpcId,
        result: {
          ok: true,
          value: {
            sessionId: this.#nativeRef.nativeSessionId,
            approvalId: pending.approvalId,
            outcome: command.response.actionId === "allow-once" ? "allowed-once" : "rejected",
          },
        },
      };
    } else {
      if (command.response.type !== "question") {
        return { ok: false, error: invalidState("DeepSeek Harness question response is invalid") };
      }
      const response = command.response;
      const validationError = validateHostQuestionResponse(pending.interaction, response);
      if (validationError) return { ok: false, error: validationError };
      if (response.cancelled) {
        message = {
          type: "client-response",
          rpcId: pending.rpcId,
          result: {
            ok: false,
            error: { code: "cancelled", message: "Question cancelled by user", details: {} },
          },
        };
      } else {
        const answers = pending.questions.map((question) => {
          const values = response.answers[question.id] ?? [];
          const labels = new Set(question.options?.map((option) => option.label) ?? []);
          const selected = values.filter((value) => labels.has(value));
          const custom = values.find((value) => !labels.has(value));
          return { id: question.id, selected, ...(custom ? { custom } : {}) };
        });
        message = {
          type: "client-response",
          rpcId: pending.rpcId,
          result: {
            ok: true,
            value: { sessionId: this.#nativeRef.nativeSessionId, answer: { answers } },
          },
        };
      }
    }
    try {
      const receipt = await this.#client.respond(message);
      if (!receipt.accepted) {
        return {
          ok: false,
          error: invalidState(`DeepSeek Harness rejected Interaction: ${receipt.reason}`),
        };
      }
      this.#closeHostInteraction(active, command.interactionId, "responded");
      return { ok: true, value: { accepted: true } };
    } catch (error) {
      return { ok: false, error: normalizedError(error, "nativeFailure") };
    }
  }

  #event(type: string, data: Record<string, unknown>): void {
    const active = this.#active;
    switch (type) {
      case "turn/start": {
        if (!active || !Number.isSafeInteger(data.turn) || active.started) {
          throw new Error("DeepSeek Harness turn/start does not match the pending Turn");
        }
        active.nativeTurn = data.turn as number;
        active.started = true;
        this.#emit({ type: "turn.started", turnId: active.command.turnId });
        return;
      }
      case "request/header": {
        const header = isRecord(data.header) ? data.header : null;
        const config = header && isRecord(header.config) ? header.config : null;
        if (config && nonBlankString(config.provider) && nonBlankString(config.model)) {
          this.#model = encodeDeepSeekHarnessModelRef({
            provider: config.provider,
            model: config.model,
          });
        }
        return;
      }
      case "request/context": {
        const contextWindowTokens = parseDeepSeekContextWindow(data.contextWindow);
        if (contextWindowTokens !== undefined) {
          this.#contextWindowTokens = contextWindowTokens;
          const latestUsageKey = this.#latestUsageKey;
          const latest =
            latestUsageKey === undefined ? undefined : this.#usageByStep.get(latestUsageKey);
          if (latest && latestUsageKey !== undefined) {
            const contextUsedTokens =
              (latest.inputTokens ?? 0) +
              (latest.cachedInputTokens ?? 0) +
              (latest.cacheWriteInputTokens ?? 0);
            this.#usageByStep.set(latestUsageKey, {
              ...latest,
              contextUsedTokens,
              contextWindowTokens,
            });
            this.#publishUsage(active?.command.turnId);
          }
        }
        return;
      }
      case "assistant/chunk":
        if (!active?.started || !isRecord(data.chunk)) return;
        if (data.chunk.type === "text-delta" && typeof data.chunk.text === "string") {
          this.#appendAgent(active, data.chunk.text);
        } else if (data.chunk.type === "reasoning-delta" && typeof data.chunk.text === "string") {
          this.#appendReasoning(active, data.chunk.text);
        } else if (data.chunk.type === "usage") {
          this.#updateUsage(
            data.chunk.usage,
            active.command.turnId,
            deepSeekUsageKey(data, `live:${this.#usageSequence++}`),
          );
        }
        return;
      case "assistant/message":
        if (!active?.started) return;
        this.#completeReasoning(active, { status: "succeeded" });
        if (!active.agentItem) {
          const text = isRecord(data.message) ? contentText(data.message) : "";
          if (text) this.#appendAgent(active, text);
        }
        this.#completeAgent(active, { status: "succeeded" });
        if (data.usage !== undefined) {
          this.#updateUsage(
            data.usage,
            active.command.turnId,
            deepSeekUsageKey(data, `live:${this.#usageSequence++}`),
          );
        }
        return;
      case "tool/call":
        if (!active?.started) return;
        this.#startTool(active, data);
        return;
      case "tool/result":
        if (!active?.started) return;
        this.#completeTool(active, data);
        return;
      case "turn/end":
        if (!active?.started || data.turn !== active.nativeTurn) {
          throw new Error("DeepSeek Harness turn/end does not match the active Turn");
        }
        this.#finishTurn(active, data.reason);
        return;
      default:
        return;
    }
  }

  #appendAgent(active: ActiveTurn, text: string): void {
    if (!text) return;
    if (!active.agentItem) {
      active.agentItem = { type: "agentMessage", itemId: this.#newItemId(), text: "" };
      this.#emit({ type: "item.started", turnId: active.command.turnId, item: active.agentItem });
    }
    active.agentItem = { ...active.agentItem, text: active.agentItem.text + text };
    this.#emit({
      type: "item.updated",
      turnId: active.command.turnId,
      itemId: active.agentItem.itemId,
      update: { type: "text.append", text },
    });
  }

  #appendReasoning(active: ActiveTurn, text: string): void {
    if (!text) return;
    if (!active.reasoningItem) {
      active.reasoningItem = { type: "reasoning", itemId: this.#newItemId(), text: "" };
      this.#emit({
        type: "item.started",
        turnId: active.command.turnId,
        item: active.reasoningItem,
      });
    }
    active.reasoningItem = { ...active.reasoningItem, text: active.reasoningItem.text + text };
    this.#emit({
      type: "item.updated",
      turnId: active.command.turnId,
      itemId: active.reasoningItem.itemId,
      update: { type: "text.append", text },
    });
  }

  #completeAgent(active: ActiveTurn, outcome: HostItemOutcome): void {
    const item = active.agentItem;
    if (!item) return;
    active.agentItem = null;
    this.#completeItem(active, item, outcome);
  }

  #completeReasoning(active: ActiveTurn, outcome: HostItemOutcome): void {
    const item = active.reasoningItem;
    if (!item) return;
    active.reasoningItem = null;
    this.#completeItem(active, item, outcome);
  }

  #startTool(active: ActiveTurn, data: Record<string, unknown>): void {
    if (
      !nonBlankString(data.callId) ||
      !nonBlankString(data.name) ||
      active.tools.has(data.callId)
    ) {
      throw new Error("DeepSeek Harness emitted an invalid tool/call");
    }
    const item: HostToolExecutionItem = {
      type: "toolExecution",
      itemId: this.#newItemId(),
      toolName: data.name,
      arguments: parseArguments(data.arguments),
    };
    active.tools.set(data.callId, { item, toolName: data.name, startedAtMs: Date.now() });
    this.#emit({ type: "item.started", turnId: active.command.turnId, item });
  }

  #completeTool(active: ActiveTurn, data: Record<string, unknown>): void {
    const result = projectToolResult(data.message, this.#toolOutputLimit);
    if (!result) throw new Error("DeepSeek Harness emitted an invalid tool/result");
    const tool = active.tools.get(result.callId);
    if (!tool) throw new Error("DeepSeek Harness tool/result references an unknown Tool");
    active.tools.delete(result.callId);
    tool.item = {
      ...tool.item,
      ...(result.output ? { output: result.output } : {}),
      durationMs: Math.max(0, Date.now() - tool.startedAtMs),
    };
    const failed = data.error !== undefined || result.failed;
    this.#completeItem(
      active,
      tool.item,
      failed
        ? {
            status: "failed",
            error: normalizedError(
              `DeepSeek Harness Tool '${tool.toolName}' failed`,
              "nativeFailure",
            ),
          }
        : { status: "succeeded" },
    );
    if (!failed) {
      const changes = structuredDiffs(data.meta);
      if (changes) {
        const fileItem: HostFileChangeItem = {
          type: "fileChange",
          itemId: this.#newItemId(),
          changes,
        };
        this.#emit({ type: "item.started", turnId: active.command.turnId, item: fileItem });
        this.#completeItem(active, fileItem, { status: "succeeded" });
      }
    }
  }

  #approval(rpcId: RpcId, frame: Extract<MuxFrame, { type: "approval/requested" }>): void {
    const active = this.#active;
    if (!active) {
      void this.#client.respond({
        type: "client-response",
        rpcId,
        result: {
          ok: true,
          value: {
            sessionId: this.#nativeRef.nativeSessionId,
            approvalId: frame.approvalId,
            outcome: "rejected",
          },
        },
      });
      return;
    }
    if ([...active.interactions.values()].some((pending) => pending.rpcId === rpcId)) return;
    const interactionId = hostInteractionIdSchema.parse(this.#newItemId());
    const interaction: HostApprovalInteraction = {
      type: "approval",
      interactionId,
      turnId: active.command.turnId,
      title: frame.reason ?? `Allow ${frame.toolName}?`,
      description: frame.callId ? `${frame.toolName} (${frame.callId})` : frame.toolName,
      subject: { type: "nativeAction" },
      actions: [
        { id: "allow-once", label: "Allow once", effect: "allowOnce" },
        { id: "reject", label: "Reject", effect: "deny" },
      ],
    };
    active.interactions.set(interactionId, {
      type: "approval",
      interaction,
      rpcId,
      approvalId: frame.approvalId,
    });
    this.#channel.emit({ kind: "interaction", interaction });
  }

  #question(rpcId: RpcId, frame: Extract<MuxFrame, { type: "question/requested" }>): void {
    const active = this.#active;
    if (!active) {
      void this.#client.respond({
        type: "client-response",
        rpcId,
        result: {
          ok: false,
          error: { code: "cancelled", message: "No active codexhost Turn", details: {} },
        },
      });
      return;
    }
    if ([...active.interactions.values()].some((pending) => pending.rpcId === rpcId)) return;
    const interactionId = hostInteractionIdSchema.parse(this.#newItemId());
    const interaction: HostQuestionInteraction = {
      type: "question",
      interactionId,
      turnId: active.command.turnId,
      title: frame.questions[0]?.header ?? "DeepSeek Harness question",
      questions: frame.questions.map((question) =>
        question.options && question.options.length > 0
          ? {
              id: question.id,
              type: "choice" as const,
              prompt: question.question,
              options: question.options.map((option) => ({
                value: option.label,
                label: option.label,
                ...(option.description ? { description: option.description } : {}),
              })),
              multiple: question.multiSelect === true,
              allowOther: true,
              optional: false,
            }
          : {
              id: question.id,
              type: "text" as const,
              prompt: question.question,
              multiline: true,
              secret: false,
              optional: false,
            },
      ),
    };
    active.interactions.set(interactionId, {
      type: "question",
      interaction,
      rpcId,
      questions: frame.questions,
    });
    this.#channel.emit({ kind: "interaction", interaction });
  }

  #closeNativeInteraction(type: "approval" | "question", nativeId: string): void {
    const active = this.#active;
    if (!active) return;
    for (const [interactionId, pending] of active.interactions) {
      const matches =
        type === "approval"
          ? pending.type === "approval" && pending.approvalId === nativeId
          : pending.type === "question" && pending.rpcId === nativeId;
      if (!matches) continue;
      this.#closeHostInteraction(active, interactionId, "responded");
    }
  }

  #closeHostInteraction(
    active: ActiveTurn,
    interactionId: HostInteractionId,
    reason: "responded" | "cancelled",
  ): void {
    if (!active.interactions.delete(interactionId)) return;
    this.#emit({
      type: "interaction.closed",
      interactionId,
      turnId: active.command.turnId,
      reason,
    });
  }

  #finishTurn(active: ActiveTurn, reason: unknown): void {
    const terminal = projectTurnReason(reason);
    const itemOutcome: HostItemOutcome =
      terminal.outcome.status === "succeeded"
        ? { status: "succeeded" }
        : terminal.outcome.status === "cancelled"
          ? {
              status: "cancelled",
              ...(terminal.outcome.reason ? { reason: terminal.outcome.reason } : {}),
            }
          : { status: "failed", error: terminal.outcome.error };
    this.#completeReasoning(active, itemOutcome);
    this.#completeAgent(active, itemOutcome);
    for (const tool of active.tools.values()) this.#completeItem(active, tool.item, itemOutcome);
    active.tools.clear();
    for (const interactionId of [...active.interactions.keys()]) {
      this.#closeHostInteraction(active, interactionId, "cancelled");
    }
    const nativeTurnRef = this.#nativeTurnRef(active.nativeTurn as number);
    this.#turns.push({
      nativeTurnRef,
      input: active.command.input,
      items: [...active.snapshots],
      outcome: terminal.history,
      model: this.#model,
    });
    this.#emit({
      type: "turn.completed",
      turnId: active.command.turnId,
      nativeTurnRef,
      outcome: terminal.outcome,
    });
    if (this.#active === active) this.#active = null;
  }

  #completeItem(active: ActiveTurn, item: HostItem, outcome: HostItemOutcome): void {
    const snapshot = { item, outcome };
    active.snapshots.push(snapshot);
    this.#emit({ type: "item.completed", turnId: active.command.turnId, snapshot });
  }

  #updateUsage(value: unknown, turnId: HostTurnId, key: string): void {
    const usage = parseDeepSeekUsage(value, this.#contextWindowTokens);
    if (!usage) return;
    this.#usageByStep.set(key, usage);
    this.#latestUsageKey = key;
    this.#publishUsage(turnId);
  }

  #publishUsage(observedForTurnId?: HostTurnId): void {
    let usage = this.#usageBaseline;
    for (const stepUsage of this.#usageByStep.values()) {
      usage = mergeDeepSeekUsage(usage, stepUsage);
    }
    usage = this.#withOutputSpeed(usage);
    if (JSON.stringify(usage) === JSON.stringify(this.#usage)) return;
    this.#usage = usage;
    this.#emit({
      type: "session.usage.changed",
      usage,
      ...(observedForTurnId ? { observedForTurnId } : {}),
    });
  }

  #withOutputSpeed(usage: HostUsage | null): HostUsage | null {
    if (this.#outputTokensPerSecond === undefined) return usage;
    return usage
      ? { ...usage, outputTokensPerSecond: this.#outputTokensPerSecond }
      : { outputTokensPerSecond: this.#outputTokensPerSecond };
  }

  #nativeTurnRef(turn: number): NativeTurnRef {
    return nativeTurnRefSchema.parse({
      harnessId: this.harnessId,
      nativeSessionId: this.#nativeRef.nativeSessionId,
      nativeTurnKey: `turn:${turn}`,
      formatVersion: 1,
    });
  }

  #newItemId(): HostItemId {
    return hostItemIdSchema.parse(randomUUID());
  }

  #fault(error: HarnessError): void {
    if (this.#closed) return;
    const activeCommand = this.#activeCommand;
    if (activeCommand) {
      activeCommand.abort.abort(new Error(error.message));
      this.#finishCommand(activeCommand, { status: "failed", error });
    }
    const active = this.#active;
    if (active) {
      const outcome: HostItemOutcome = { status: "failed", error };
      this.#completeReasoning(active, outcome);
      this.#completeAgent(active, outcome);
      for (const tool of active.tools.values()) this.#completeItem(active, tool.item, outcome);
      active.tools.clear();
      for (const interactionId of [...active.interactions.keys()]) {
        this.#closeHostInteraction(active, interactionId, "cancelled");
      }
      this.#emit({
        type: "turn.completed",
        turnId: active.command.turnId,
        outcome: { status: "failed", error },
      });
      this.#active = null;
    }
    this.#emit({ type: "session.faulted", error });
    this.#unsubscribe();
    this.#channel.end();
    this.#closed = true;
    this.#onClosed();
  }

  #emit(output: Extract<HarnessOutput, { kind: "event" }>["event"]): void {
    this.#channel.emit({ kind: "event", event: output });
  }
}

export class DeepSeekHarnessAdapter implements HarnessAdapter {
  readonly harnessId: HarnessId = deepSeekHarnessId;
  readonly #connection: DeepSeekHostConnectionLike;
  readonly #dependencies: DeepSeekHarnessAdapterDependencies;
  readonly #options: DeepSeekHarnessAdapterOptions;
  readonly #sessions = new Set<DeepSeekHarnessSession>();
  readonly #toolOutputLimit: number;
  #closePromise: Promise<void> | null = null;

  constructor(
    options: DeepSeekHarnessAdapterOptions = {},
    dependencies?: DeepSeekHarnessAdapterDependencies,
  ) {
    this.#options = options;
    this.#toolOutputLimit = options.toolOutputLimit ?? DEFAULT_TOOL_OUTPUT_LIMIT;
    this.#dependencies = dependencies ?? {
      randomUUID,
      createConnection: (connectionOptions) => new DeepSeekHostConnection(connectionOptions),
    };
    this.#connection = this.#dependencies.createConnection(options);
  }

  async inspect(): Promise<HarnessInspection> {
    if (this.#closePromise) {
      return { status: "unavailable", error: invalidState("DeepSeek Harness Adapter is closing") };
    }
    const startedAt = Date.now();
    let stage = "startup";
    try {
      await this.#connection.connect();
      stage = "host-describe";
      const [description, directory] = await Promise.all([
        this.#connection.client.host.describe({}),
        this.#connection.client.llm.models({}),
      ]);
      const host = unwrapRpc(description, "host.describe");
      stage = "model-catalog";
      const models = unwrapRpc(directory, "llm.models");
      if (!nonBlankString(host.provider) || !nonBlankString(host.model)) {
        throw new DeepSeekHarnessTransportError(
          "protocolError",
          "DeepSeek Harness Host has no default Model selection",
        );
      }
      return {
        status: "ready",
        catalog: normalizeDeepSeekModelCatalog(models.groups, {
          provider: host.provider,
          model: host.model,
        }),
        capabilities: {
          configuration: {
            selectModel: true,
            selectThinkingOption: true,
            selectPermissionMode: false,
          },
          history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
        },
      };
    } catch (error) {
      const normalized = normalizedError(error, "unavailable");
      return {
        status: normalized.code === "notInstalled" ? "notInstalled" : "unavailable",
        error: {
          ...normalized,
          stage,
          durationMs: Date.now() - startedAt,
          ...(normalized.stderrTail || !this.#connection.stderrTail
            ? {}
            : { stderrTail: this.#connection.stderrTail }),
        },
      };
    }
  }

  async open(input: OpenSessionInput): Promise<HarnessResult<HarnessSession>> {
    if (this.#closePromise) {
      return { ok: false, error: invalidState("DeepSeek Harness Adapter is closing") };
    }
    if (!input.cwd.trim()) {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "DeepSeek Harness requires cwd",
          retryable: false,
        },
      };
    }
    if (input.kind !== "create" && input.kind !== "resume") {
      return { ok: false, error: unsupported(`DeepSeek Harness does not support '${input.kind}'`) };
    }
    if (input.kind === "create" && input.permissionModeId) {
      return {
        ok: false,
        error: unsupported("DeepSeek Harness does not select Permission Mode"),
      };
    }
    try {
      await this.#connection.connect();
      const cwd = path.resolve(input.cwd);
      let sessionId: string;
      if (input.kind === "create") {
        sessionId = `session-${this.#dependencies.randomUUID()}`;
      } else {
        const parsed = nativeSessionRefSchema.safeParse(input.nativeRef);
        if (!parsed.success || parsed.data.harnessId !== this.harnessId) {
          return {
            ok: false,
            error: {
              code: "invalidRequest",
              message: "DeepSeek Harness cannot resume another Harness's Native Session",
              retryable: false,
            },
          };
        }
        sessionId = parsed.data.nativeSessionId;
      }

      const pending: DeepSeekMuxEnvelope[] = [];
      let session: DeepSeekHarnessSession | null = null;
      const unsubscribe = this.#connection.subscribe(sessionId, {
        onMux: (envelope) => (session ? session.onMux(envelope) : pending.push(envelope)),
        onFault: (error) => session?.onFault(error),
      });
      try {
        if (input.kind === "create") {
          const created = unwrapRpc(
            await this.#connection.client.sessions.create({
              sessionId: sessionId as SessionId,
              cwd,
            }),
            "session.create",
          );
          if (created.sessionId !== sessionId) {
            throw new DeepSeekHarnessTransportError(
              "protocolError",
              "DeepSeek Harness created an unexpected Session identity",
            );
          }
          if (input.model || input.thinkingOptionId) {
            let target = input.model ? decodeDeepSeekHarnessModelRef(input.model) : null;
            if (!target) {
              const currentModels = unwrapRpc(
                await this.#connection.client.sessions.models({
                  sessionId: sessionId as SessionId,
                }),
                "session.models",
              );
              target = {
                provider: currentModels.current.provider,
                model: currentModels.current.model,
              };
            }
            unwrapRpc(
              await this.#connection.client.sessions.selectModel({
                sessionId: sessionId as SessionId,
                provider: target.provider,
                model: target.model,
                ...(input.thinkingOptionId ? { reasoningEffort: input.thinkingOptionId } : {}),
              }),
              "session.selectModel",
            );
          }
          if (input.executionPolicy === "unattended-full-access") {
            await applyDelegationPermission(this.#connection.client, sessionId as SessionId);
          }
        }
        const [entries, modelState] = await Promise.all([
          readAllDeepSeekHistory(this.#connection.client, sessionId as SessionId),
          this.#connection.client.sessions.models({ sessionId: sessionId as SessionId }),
        ]);
        const models = unwrapRpc(modelState, "session.models");
        const model = encodeDeepSeekHarnessModelRef(models.current);
        const projection = projectDeepSeekHistory({
          harnessId: this.harnessId,
          sessionId,
          entries,
          fallbackModel: model,
          toolOutputLimit: this.#toolOutputLimit,
        });
        const thinkingOptionId = parseDeepSeekThinkingOptionId(models.current.reasoningEffort);
        session = new DeepSeekHarnessSession({
          client: this.#connection.client,
          model,
          nativeSessionId: sessionId,
          lastSeq: projection.lastSeq,
          ...(thinkingOptionId ? { thinkingOptionId } : {}),
          availableThinkingOptions: normalizeDeepSeekThinkingOptions(models),
          ...(projection.contextWindowTokens !== undefined
            ? { contextWindowTokens: projection.contextWindowTokens }
            : {}),
          initialUsage: projection.usage,
          snapshot: projection.snapshot,
          toolOutputLimit: this.#toolOutputLimit,
          unsubscribe,
          onClosed: () => this.#sessions.delete(session as DeepSeekHarnessSession),
        });
        this.#sessions.add(session);
        for (const envelope of pending) session.onMux(envelope);
        return { ok: true, value: session };
      } catch (error) {
        unsubscribe();
        throw error;
      }
    } catch (error) {
      return { ok: false, error: normalizedError(error, "unavailable") };
    }
  }

  close(): Promise<void> {
    this.#closePromise ??= Promise.allSettled([
      ...[...this.#sessions].map((session) => session.close()),
    ]).then(async () => this.#connection.close());
    return this.#closePromise;
  }
}
