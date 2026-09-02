import { randomUUID } from "node:crypto";
import path from "node:path";

import {
  deleteSession as deleteClaudeSession,
  forkSession as forkClaudeNativeSession,
  getSessionInfo as getClaudeSessionInfo,
  getSubagentMessages,
} from "@anthropic-ai/claude-agent-sdk";
import {
  HarnessOutputChannel,
  parseHostUsage,
  validateHostApprovalResponse,
  validateHostQuestionResponse,
  type HarnessAdapter,
  type HarnessCommandAccepted,
  type HarnessCommandCapability,
  type HarnessCommandInvocation,
  type HarnessError,
  type HarnessInspection,
  type HarnessModelRef,
  type HarnessPermissionModeId,
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
  type HostItemOutcome,
  type HostQuestionInteraction,
  type HostReasoningItem,
  type HostUsage,
  type InspectHarnessInput,
  type InteractionRespondAccepted,
  type InteractionRespondCommand,
  type ModelSelectCommand,
  type ModelSelectCompleted,
  type OpenSessionInput,
  type PermissionModeSelectCommand,
  type PermissionModeSelectCompleted,
  type HostThreadSnapshot,
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
  hostInteractionIdSchema,
  hostItemIdSchema,
  hostTurnIdSchema,
  nativeCheckpointRefSchema,
  nativeSessionRefSchema,
  nativeTurnRefSchema,
  type AccountCreditsSnapshot,
  type HarnessId,
  type HarnessThinkingOptionId,
  type HostInteractionId,
  type NativeSessionRef,
  type NativeTurnRef,
} from "@codexhost/shared-contracts";

import { ClaudeBackgroundOccupancy } from "./background-occupancy.js";
import { ClaudeCodeExecutableError, resolveClaudeCodeExecutable } from "./command.js";
import { forkClaudeSession } from "./claude-fork.js";
import { mapClaudeSnapshot, mapClaudeSubagentSnapshot } from "./claude-history.js";
import { claudeTranscriptItemId } from "./item-identity.js";
import { readClaudeTranscript } from "./claude-transcript.js";
import {
  CLAUDE_DEFAULT_MODEL_REF,
  decodeClaudeModelRef,
  normalizeClaudeModelCatalog,
} from "./model-catalog.js";
import {
  CLAUDE_DEFAULT_PERMISSION_MODE_ID,
  claudePermissionModeCatalogForModels,
  decodeClaudePermissionModeId,
  encodeClaudePermissionModeId,
  type ClaudePermissionMode,
} from "./permission-modes.js";
import { ClaudeSdkModelInspector, ClaudeSdkTransport } from "./sdk-transport.js";
import {
  CLAUDE_DEFAULT_THINKING_OPTION_ID,
  CLAUDE_THINKING_OPTIONS,
  parseClaudeThinkingOptionId,
} from "./thinking-options.js";
import { ClaudeSubagentLifecycle } from "./subagent-lifecycle.js";
import { ClaudeTaskTracker } from "./task-tracker.js";
import { ClaudeToolLifecycle } from "./tool-lifecycle.js";
import { estimateClaudeRequestCostUsd } from "./usage-estimate.js";
import type {
  ClaudeAdapterDependencies,
  ClaudeApprovalRequest,
  ClaudeAutonomousTurn,
  ClaudeInteractionRequest,
  ClaudeInteractionResponse,
  ClaudeLastRequestUsage,
  ClaudeModelInspector,
  ClaudePlanLimitEvent,
  ClaudeQuestionRequest,
  ClaudeTransportFailureKind,
  ClaudeTransportTurnResult,
  ClaudeTurnEvent,
  ClaudeTurnTransport,
} from "./transport.js";

export interface ClaudeCodeAdapterOptions {
  command?: string;
  environment?: NodeJS.ProcessEnv;
  closeTimeoutMs?: number;
  cancelTimeoutMs?: number;
  toolOutputLimit?: number;
  continuationQuiescenceMs?: number;
}

type SessionPhase = "open" | "closing" | "closed" | "faulted";

type ActiveInteraction =
  | {
      type: "approval";
      interaction: HostApprovalInteraction;
      request: ClaudeApprovalRequest;
    }
  | {
      type: "question";
      interaction: HostQuestionInteraction;
      request: ClaudeQuestionRequest;
    };

interface ContextUsageRefreshRequest {
  transport: ClaudeTurnTransport;
  turnId?: TurnStartCommand["turnId"];
  generation: number;
  retryDelaysMs: readonly number[];
}

interface RequestUsageRefreshRequest {
  turnId: TurnStartCommand["turnId"];
  messageId: string;
  boundary: number;
  generation: number;
}

interface ActiveTurn {
  command: TurnStartCommand;
  compactionItem: HostContextCompactionItem | null;
  item: HostAgentMessageItem | null;
  agentMessageOrdinal: number;
  assistantMessageId: string | null;
  reasoningItems: Map<string, HostReasoningItem>;
  reasoningOrdinal: number;
  pendingSubagentTranscriptCalls: Set<string>;
  subagents: ClaudeSubagentLifecycle;
  tools: ClaudeToolLifecycle;
  interactions: Map<HostInteractionId, ActiveInteraction>;
  interactionByRequestId: Map<string, HostInteractionId>;
  checkpointId: string | null;
  nativeTurnKey: string;
  nativeTurnRef: NativeTurnRef | null;
  cancellationRequested: boolean;
  usageRequestIds: Set<string>;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedCostUsd: number;
  estimatedCostAvailable: boolean;
  usageTokensCalibrated: boolean;
  usageCostCalibrated: boolean;
  held: boolean;
  completion: Promise<void>;
  resolveCompletion(): void;
}

const claudeCodeHarnessId = harnessIdSchema.parse("claude-code");
const claudeCommandCatalog = harnessCommandCatalogSchema.parse({
  commands: [
    {
      id: "claude.compact",
      invocation: "/compact",
      label: "Compact context",
      description: "Compact the current conversation context",
      argumentMode: "text",
    },
    {
      id: "claude.init",
      invocation: "/init",
      label: "Initialize CLAUDE.md",
      description: "Generate a CLAUDE.md guide for this project",
      argumentMode: "none",
    },
    {
      id: "claude.recap",
      invocation: "/recap",
      label: "Recap session",
      description: "Generate a one-line session recap",
      argumentMode: "none",
    },
  ],
});

type ClaudeHarnessCommand =
  | { id: "claude.compact"; text: string | undefined }
  | { id: "claude.init" }
  | { id: "claude.recap" };

function parseClaudeHarnessCommand(
  command: HarnessCommandInvocation,
): HarnessResult<ClaudeHarnessCommand> {
  if (command.commandId === "claude.init" || command.commandId === "claude.recap") {
    if (command.arguments && Object.keys(command.arguments).length > 0) {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: `Claude Code ${command.commandId} command does not accept arguments`,
          retryable: false,
        },
      };
    }
    return { ok: true, value: { id: command.commandId } };
  }
  if (command.commandId !== "claude.compact") {
    return {
      ok: false,
      error: {
        code: "unsupported",
        message: `Claude Code does not expose Harness command '${command.commandId}'`,
        retryable: false,
      },
    };
  }
  const arguments_ = command.arguments;
  const customInstructions = arguments_?.text;
  if (customInstructions !== undefined && typeof customInstructions !== "string") {
    return {
      ok: false,
      error: {
        code: "invalidRequest",
        message: "Claude Code compact command argument 'text' must be a string",
        retryable: false,
      },
    };
  }
  if (arguments_ && Object.keys(arguments_).some((key) => key !== "text")) {
    return {
      ok: false,
      error: {
        code: "invalidRequest",
        message: "Claude Code compact command has an unknown argument",
        retryable: false,
      },
    };
  }
  return { ok: true, value: { id: "claude.compact", text: customInstructions } };
}
const DEFAULT_CLOSE_TIMEOUT_MS = 7_000;
const DEFAULT_CANCEL_TIMEOUT_MS = 2_000;
const DEFAULT_TOOL_OUTPUT_LIMIT = 64_000;
const CONTEXT_USAGE_RETRY_DELAYS_MS = [0, 1_000, 2_000] as const;
const CONTEXT_USAGE_TTL_MS = 10_000;
const CONTEXT_USAGE_FAILURE_COOLDOWN_MS = 5_000;
const REQUEST_USAGE_RETRY_DELAYS_MS = [0, 100, 250, 500, 1_000] as const;
// Claude opens the continuation Segment within milliseconds of the Segment that
// observed a task notification, and the number of Segments it spends on queued
// notifications is not observable. The user task is therefore idle once the
// native Session stops opening Segments for this long.
const DEFAULT_CONTINUATION_QUIESCENCE_MS = 2_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function transcriptRequestUsage(
  messages: readonly unknown[],
  messageId: string,
): ClaudeLastRequestUsage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const entry = messages[index];
    if (
      !isRecord(entry) ||
      entry.type !== "assistant" ||
      (entry.parent_tool_use_id !== null && entry.parent_tool_use_id !== undefined) ||
      !isRecord(entry.message) ||
      entry.message.id !== messageId ||
      !isRecord(entry.message.usage)
    ) {
      continue;
    }
    const inputTokens = entry.message.usage.input_tokens;
    const outputTokens = entry.message.usage.output_tokens;
    const cacheCreationInputTokens = entry.message.usage.cache_creation_input_tokens;
    const cacheReadInputTokens = entry.message.usage.cache_read_input_tokens;
    if (
      safeNonNegativeInteger(inputTokens) &&
      safeNonNegativeInteger(outputTokens) &&
      safeNonNegativeInteger(cacheCreationInputTokens) &&
      safeNonNegativeInteger(cacheReadInputTokens)
    ) {
      return {
        requestId:
          typeof entry.request_id === "string" && entry.request_id.length > 0
            ? entry.request_id
            : messageId,
        ...(typeof entry.message.model === "string" && entry.message.model.length > 0
          ? { model: entry.message.model }
          : {}),
        ...(typeof entry.provider === "string" && entry.provider.length > 0
          ? { provider: entry.provider }
          : typeof entry.message.provider === "string" && entry.message.provider.length > 0
            ? { provider: entry.message.provider }
            : {}),
        inputTokens,
        outputTokens,
        cacheCreationInputTokens,
        cacheReadInputTokens,
      };
    }
  }
  return undefined;
}

function invalidState(message: string): HarnessError {
  return { code: "invalidState", message, retryable: false };
}

function transportFailure(kind: ClaudeTransportFailureKind): HarnessError {
  if (kind === "authentication") {
    return {
      code: "authenticationRequired",
      message: "Claude Code authentication is required",
      retryable: true,
    };
  }
  if (kind === "protocol") {
    return {
      code: "protocolError",
      message: "Claude Code returned an invalid Tool lifecycle",
      retryable: false,
    };
  }
  return {
    code: "nativeFailure",
    message:
      kind === "textConflict"
        ? "Claude Code returned inconsistent streamed text"
        : kind === "cancellationUnproven"
          ? "Claude Code cancellation could not be proven"
          : "Claude Code Turn failed",
    retryable: kind !== "textConflict",
  };
}

function startupFailure(error: unknown): HarnessError {
  if (error instanceof ClaudeCodeExecutableError) {
    return { code: "notInstalled", message: error.message, retryable: false };
  }
  const text = error instanceof Error ? error.message.toLowerCase() : "";
  if (
    text.includes("not logged in") ||
    text.includes("authentication") ||
    text.includes("api key")
  ) {
    return {
      code: "authenticationRequired",
      message: "Claude Code authentication is required",
      retryable: true,
    };
  }
  return {
    code: "unavailable",
    message: "Claude Code could not start",
    retryable: true,
  };
}

function faultError(): HarnessError {
  return {
    code: "processExited",
    message: "Claude Code Session became unavailable",
    retryable: true,
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function rejectAfter(
  milliseconds: number,
  message: string,
): { promise: Promise<never>; cancel(): void } {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), milliseconds);
  });
  return {
    promise,
    cancel() {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    },
  };
}

/**
 * Cache hit rate for the latest request only, never a Session cumulative value.
 * Every addend must be present; the denominator must be positive.
 */
function claudeCacheHitRatePercent(usage: {
  inputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}): number | undefined {
  const denominator =
    usage.inputTokens + usage.cacheCreationInputTokens + usage.cacheReadInputTokens;
  if (denominator <= 0) return undefined;
  return Math.min(100, Math.max(0, (usage.cacheReadInputTokens / denominator) * 100));
}

/**
 * Projects the Adapter's cached plan-limit observation into the generic
 * `AccountCreditsSnapshot` shape the Renderer's credits pill/popover expect.
 * The 5-hour window leads (it's the more actionable of the two — it resets
 * soonest); the 7-day window, when known, rides along as a secondary entry
 * rather than a fabricated "product". Falls back to the 7-day window alone
 * if a 5-hour observation hasn't arrived yet.
 */
function isoFromUnix(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString();
}

export function projectClaudePlanLimitToCredits(
  planLimit: ClaudePlanLimitEvent | null,
): AccountCreditsSnapshot | null {
  if (!planLimit) return null;
  const { fiveHour, sevenDay } = planLimit;
  if (!fiveHour && !sevenDay) return null;

  const primary = fiveHour ?? sevenDay;
  if (!primary) return null;
  const periodType: AccountCreditsSnapshot["periodType"] = fiveHour ? "five_hour" : "seven_day";
  const other = fiveHour && sevenDay ? sevenDay : undefined;

  return {
    usedPercent: primary.utilizationPercent,
    periodType,
    ...(primary.resetsAtUnix !== undefined ? { resetsAt: isoFromUnix(primary.resetsAtUnix) } : {}),
    ...(other
      ? {
          productUsage: [
            {
              product: "7-day window",
              usagePercent: other.utilizationPercent,
              ...(other.resetsAtUnix !== undefined
                ? { resetsAt: isoFromUnix(other.resetsAtUnix) }
                : {}),
            },
          ],
        }
      : {}),
  };
}

class ClaudeHarnessSession implements HarnessSession {
  readonly harnessId: HarnessId = claudeCodeHarnessId;
  readonly capabilities: HarnessSessionCapabilities = {
    configuration: {
      selectModel: true,
      selectThinkingOption: true,
      selectPermissionMode: true,
      permissionModeScope: "live",
    },
    history: { fork: true, forkAcrossCwd: false, rollbackLastTurn: true },
    subagents: { observe: true, readTranscript: true },
  };
  readonly commands: HarnessCommandCapability;
  readonly initialState: HarnessSessionState;
  readonly initialUsage = null;
  readonly outputs: AsyncIterable<HarnessOutput>;
  readonly #channel = new HarnessOutputChannel<HarnessOutput>();
  readonly #cancelTimeoutMs: number;
  readonly #closeTimeoutMs: number;
  readonly #createTransport: ClaudeAdapterDependencies["createTransport"];
  readonly #cwd: string;
  readonly #nativeRef: NativeSessionRef;
  readonly #onClosed: () => void;
  readonly #onPlanLimitObserved: (planLimit: ClaudePlanLimitEvent) => ClaudePlanLimitEvent | null;
  #openMode: "create" | "resume";
  readonly #randomUUID: () => string;
  #requestedModel: HarnessModelRef | undefined;
  #requestedPermissionModeId: HarnessPermissionModeId;
  #requestedThinkingOptionId: HarnessThinkingOptionId;
  readonly #readSessionMessages: ClaudeAdapterDependencies["readSessionMessages"];
  readonly #sessionId: string;
  readonly #toolOutputLimit: number;
  readonly #continuationQuiescenceMs: number;
  readonly #taskTracker = new ClaudeTaskTracker();
  #acceptingTurn = false;
  #active: ActiveTurn | null = null;
  #closePromise: Promise<void> | null = null;
  #configurationTask: Promise<void> | null = null;
  #phase: SessionPhase = "open";
  #readingHistory = false;
  #state: HarnessSessionState;
  #statePublished = false;
  #transport: ClaudeTurnTransport | null = null;
  #usageGeneration = 0;
  #latestUsage: HostUsage | null = null;
  #minimumContextUsedTokens: number | null = null;
  #calibratedInputTokens = 0;
  #calibratedOutputTokens = 0;
  #calibratedCostUsd = 0;
  #contextRefreshInFlight: Promise<void> | null = null;
  #contextRefreshPending: ContextUsageRefreshRequest | null = null;
  #contextRefreshWake: (() => void) | null = null;
  #contextUsageFreshUntilMs = 0;
  #contextUsageCooldownUntilMs = 0;
  #requestUsageBoundary = 0;
  #autonomousOrdinal = 0;
  #occupancy = new ClaudeBackgroundOccupancy();
  #cancelEscalation: ReturnType<typeof setTimeout> | null = null;
  #continuationQuiescence: ReturnType<typeof setTimeout> | null = null;

  constructor(
    cwd: string,
    dependencies: ClaudeAdapterDependencies,
    closeTimeoutMs: number,
    onClosed: () => void,
    onPlanLimitObserved: (planLimit: ClaudePlanLimitEvent) => ClaudePlanLimitEvent | null,
    options: {
      environment?: NodeJS.ProcessEnv;
      openMode: "create" | "resume";
      sessionId: string;
      requestedModel?: HarnessModelRef;
      requestedPermissionModeId: HarnessPermissionModeId;
      requestedThinkingOptionId: HarnessThinkingOptionId;
      toolOutputLimit: number;
      cancelTimeoutMs: number;
      continuationQuiescenceMs: number;
    },
  ) {
    this.#cwd = cwd;
    const environment = options.environment;
    this.#createTransport = environment
      ? (input) => dependencies.createTransport({ ...input, environment })
      : dependencies.createTransport;
    this.#randomUUID = dependencies.randomUUID;
    this.#readSessionMessages = dependencies.readSessionMessages;
    this.#cancelTimeoutMs = options.cancelTimeoutMs;
    this.#closeTimeoutMs = closeTimeoutMs;
    this.#onClosed = onClosed;
    this.#onPlanLimitObserved = onPlanLimitObserved;
    this.#openMode = options.openMode;
    this.#requestedModel = options.requestedModel;
    this.#requestedPermissionModeId = options.requestedPermissionModeId;
    this.#requestedThinkingOptionId = options.requestedThinkingOptionId;
    this.#sessionId = options.sessionId;
    this.#toolOutputLimit = options.toolOutputLimit;
    this.#continuationQuiescenceMs = options.continuationQuiescenceMs;
    this.#nativeRef = nativeSessionRefSchema.parse({
      harnessId: this.harnessId,
      nativeSessionId: this.#sessionId,
      formatVersion: 1,
    });
    this.commands = {
      list: async () => ({ ok: true, value: claudeCommandCatalog }),
      execute: (command) => this.#executeHarnessCommand(command),
    };
    this.initialState = this.#openMode === "resume" ? { nativeRef: this.#nativeRef } : {};
    this.#state = this.initialState;
    this.#statePublished = this.#openMode === "resume";
    this.outputs = this.#channel.outputs;
  }

  async readSnapshot(): Promise<HarnessResult<HostThreadSnapshot>> {
    if (this.#phase !== "open") {
      return { ok: false, error: invalidState("Claude Code Session is not open") };
    }
    if (this.#active || this.#acceptingTurn || this.#configurationTask || this.#readingHistory) {
      return {
        ok: false,
        error: {
          code: "sessionBusy",
          message: "Claude Code Session cannot read history during another operation",
          retryable: true,
        },
      };
    }
    if (!this.#statePublished) return { ok: true, value: { turns: [], state: this.#state } };

    this.#readingHistory = true;
    try {
      let messages: unknown[];
      try {
        messages = await this.#readSessionMessages({ cwd: this.#cwd, sessionId: this.#sessionId });
      } catch {
        return {
          ok: false,
          error: {
            code: "nativeFailure",
            message: "Claude Code history could not be read",
            retryable: true,
          },
        };
      }
      if (messages.length === 0) {
        return {
          ok: false,
          error: {
            code: "sessionNotFound",
            message: "Claude Code Native Session is unavailable",
            retryable: false,
          },
        };
      }
      try {
        return {
          ok: true,
          value: { ...mapClaudeSnapshot(messages, this.#sessionId), state: this.#state },
        };
      } catch {
        return {
          ok: false,
          error: {
            code: "protocolError",
            message: "Claude Code history is invalid",
            retryable: false,
          },
        };
      }
    } finally {
      this.#readingHistory = false;
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
      return { ok: false, error: invalidState("Claude Code Session is not open") };
    }
    if (command.type === "turn.cancel") return this.#cancel(command);
    if (command.type === "interaction.respond") return this.#respond(command);
    if (command.type === "model.select") return this.#selectModel(command);
    if (command.type === "permissionMode.select") return this.#selectPermissionMode(command);
    if (command.type === "thinking.select") return this.#selectThinking(command);
    if (this.#acceptingTurn || this.#active || this.#configurationTask || this.#readingHistory) {
      return {
        ok: false,
        error: {
          code: "sessionBusy",
          message: "Claude Code Session already has an active Turn",
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
          message: "Claude Code text Turn must not be empty",
          retryable: false,
        },
      };
    }

    this.#acceptingTurn = true;
    const startingTransport = this.#transport === null;
    let transport: ClaudeTurnTransport;
    try {
      transport = await this.#ensureTransport();
    } catch (error) {
      this.#acceptingTurn = false;
      return { ok: false, error: startupFailure(error) };
    }
    this.#acceptingTurn = false;
    if (this.#phase !== "open") {
      return { ok: false, error: invalidState("Claude Code Session closed during startup") };
    }
    if (startingTransport) this.#publishState();
    this.#usageGeneration += 1;
    this.#contextUsageFreshUntilMs = 0;
    this.#contextUsageCooldownUntilMs = 0;
    let resolveCompletion = (): void => undefined;
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    const nativeTurnKey = this.#randomUUID();
    const item: HostAgentMessageItem = {
      type: "agentMessage",
      itemId: claudeTranscriptItemId(nativeTurnKey, "agentMessage", 1),
      text: "",
    };
    const active: ActiveTurn = {
      command,
      compactionItem: null,
      item,
      agentMessageOrdinal: 1,
      assistantMessageId: null,
      reasoningItems: new Map(),
      reasoningOrdinal: 0,
      pendingSubagentTranscriptCalls: new Set(),
      subagents: new ClaudeSubagentLifecycle({
        newItemId: () => hostItemIdSchema.parse(this.#randomUUID()),
        emit: (event) => this.#event(event),
      }),
      tools: new ClaudeToolLifecycle({
        cwd: this.#cwd,
        outputLimit: this.#toolOutputLimit,
        taskTracker: this.#taskTracker,
        newItemId: () => hostItemIdSchema.parse(this.#randomUUID()),
        emit: (event) => this.#event(event),
      }),
      interactions: new Map(),
      interactionByRequestId: new Map(),
      checkpointId: null,
      nativeTurnKey,
      nativeTurnRef: null,
      cancellationRequested: false,
      usageRequestIds: new Set(),
      estimatedInputTokens: 0,
      estimatedOutputTokens: 0,
      estimatedCostUsd: 0,
      estimatedCostAvailable: false,
      usageTokensCalibrated: false,
      usageCostCalibrated: false,
      held: false,
      completion,
      resolveCompletion,
    };
    this.#active = active;
    this.#event({ type: "turn.started", turnId: command.turnId });
    this.#event({ type: "item.started", turnId: command.turnId, item });
    try {
      const nativeTurnRef = nativeTurnRefSchema.parse({
        harnessId: this.harnessId,
        nativeSessionId: this.#sessionId,
        nativeTurnKey,
        formatVersion: 1,
      });
      const running = transport.runTurn(text, nativeTurnRef.nativeTurnKey, (event) => {
        this.#handleTurnEvent(active, event);
      });
      // Claude preserves caller-assigned User Message UUIDs in native history.
      active.nativeTurnRef = nativeTurnRef;
      void running.then(
        (result) => this.#finishResult(active, result),
        () => this.#handleTurnTransportFailure(active),
      );
    } catch {
      this.#finishFailed(active, faultError());
    }
    return { ok: true, value: { turnId: command.turnId } };
  }

  async #executeHarnessCommand(
    command: HarnessCommandInvocation,
  ): Promise<HarnessResult<HarnessCommandAccepted>> {
    if (this.#phase !== "open") {
      return { ok: false, error: invalidState("Claude Code Session is not open") };
    }
    const parsed = parseClaudeHarnessCommand(command);
    if (!parsed.ok) return parsed;
    if (this.#acceptingTurn || this.#active || this.#configurationTask || this.#readingHistory) {
      return {
        ok: false,
        error: {
          code: "sessionBusy",
          message: "Claude Code Session already has an active operation",
          retryable: true,
        },
      };
    }

    this.#acceptingTurn = true;
    const startingTransport = this.#transport === null;
    let transport: ClaudeTurnTransport;
    try {
      transport = await this.#ensureTransport();
    } catch (error) {
      this.#acceptingTurn = false;
      return { ok: false, error: startupFailure(error) };
    }
    this.#acceptingTurn = false;
    if (this.#phase !== "open") {
      return { ok: false, error: invalidState("Claude Code Session closed during startup") };
    }
    if (startingTransport) this.#publishState();
    this.#usageGeneration += 1;
    this.#contextUsageFreshUntilMs = 0;
    this.#contextUsageCooldownUntilMs = 0;
    let resolveCompletion = (): void => undefined;
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    const nativeTurnKey = this.#randomUUID();
    const startAgentItem = parsed.value.id !== "claude.compact";
    const item: HostAgentMessageItem | null = startAgentItem
      ? {
          type: "agentMessage",
          itemId: claudeTranscriptItemId(nativeTurnKey, "agentMessage", 1),
          text: "",
        }
      : null;
    const active: ActiveTurn = {
      command: { type: "turn.start", turnId: command.turnId, input: [] },
      compactionItem: null,
      item,
      agentMessageOrdinal: startAgentItem ? 1 : 0,
      assistantMessageId: null,
      reasoningItems: new Map(),
      reasoningOrdinal: 0,
      pendingSubagentTranscriptCalls: new Set(),
      subagents: new ClaudeSubagentLifecycle({
        newItemId: () => hostItemIdSchema.parse(this.#randomUUID()),
        emit: (event) => this.#event(event),
      }),
      tools: new ClaudeToolLifecycle({
        cwd: this.#cwd,
        outputLimit: this.#toolOutputLimit,
        taskTracker: this.#taskTracker,
        newItemId: () => hostItemIdSchema.parse(this.#randomUUID()),
        emit: (event) => this.#event(event),
      }),
      interactions: new Map(),
      interactionByRequestId: new Map(),
      checkpointId: null,
      nativeTurnKey,
      nativeTurnRef: null,
      cancellationRequested: false,
      usageRequestIds: new Set(),
      estimatedInputTokens: 0,
      estimatedOutputTokens: 0,
      estimatedCostUsd: 0,
      estimatedCostAvailable: false,
      usageTokensCalibrated: false,
      usageCostCalibrated: false,
      held: false,
      completion,
      resolveCompletion,
    };
    this.#active = active;
    this.#event({ type: "turn.started", turnId: command.turnId });
    if (item) this.#event({ type: "item.started", turnId: command.turnId, item });
    const running =
      parsed.value.id === "claude.compact"
        ? transport.compact(nativeTurnKey, parsed.value.text, (event) =>
            this.#handleTurnEvent(active, event),
          )
        : parsed.value.id === "claude.init"
          ? transport.init(nativeTurnKey, (event) => this.#handleTurnEvent(active, event))
          : transport.recap(nativeTurnKey, (event) => this.#handleTurnEvent(active, event));
    try {
      void running.then(
        (result) => this.#finishResult(active, result),
        () => this.#handleTurnTransportFailure(active),
      );
    } catch {
      this.#finishFailed(active, faultError());
    }
    return { ok: true, value: { turnId: command.turnId } };
  }

  refreshUsage(): Promise<void> {
    if (this.#phase !== "open" || !this.#transport) return Promise.resolve();
    const now = Date.now();
    if (now < this.#contextUsageFreshUntilMs || now < this.#contextUsageCooldownUntilMs) {
      return Promise.resolve();
    }
    this.#requestContextUsage(
      this.#transport,
      this.#active?.command.turnId,
      CONTEXT_USAGE_RETRY_DELAYS_MS,
    );
    return this.#contextRefreshInFlight ?? Promise.resolve();
  }

  close(): Promise<void> {
    if (!this.#closePromise) this.#closePromise = this.#close();
    return this.#closePromise;
  }

  async #selectModel(command: ModelSelectCommand): Promise<HarnessResult<ModelSelectCompleted>> {
    if (this.#acceptingTurn || this.#active || this.#configurationTask || this.#readingHistory) {
      return {
        ok: false,
        error: {
          code: "sessionBusy",
          message: "Claude Code Session cannot select a Model during another operation",
          retryable: true,
        },
      };
    }
    let model: string | undefined;
    try {
      model = decodeClaudeModelRef(command.model);
    } catch {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "Claude Code Model Ref is invalid",
          retryable: false,
        },
      };
    }
    this.#usageGeneration += 1;
    this.#contextUsageFreshUntilMs = 0;
    this.#contextUsageCooldownUntilMs = 0;
    let resolveConfiguration = (): void => undefined;
    this.#configurationTask = new Promise<void>((resolve) => {
      resolveConfiguration = resolve;
    });
    try {
      const transport = this.#transport;
      if (transport) {
        try {
          await transport.setModel(model);
        } catch {
          return {
            ok: false,
            error: {
              code: "nativeFailure",
              message: "Claude Code rejected the Model selection",
              retryable: true,
            },
          };
        }
      }
      this.#requestedModel = command.model;
      this.#publishState(this.#configuredState());
      return { ok: true, value: { completed: true } };
    } finally {
      resolveConfiguration();
      this.#configurationTask = null;
    }
  }

  async #selectThinking(
    command: ThinkingSelectCommand,
  ): Promise<HarnessResult<ThinkingSelectCompleted>> {
    if (this.#acceptingTurn || this.#active || this.#configurationTask || this.#readingHistory) {
      return {
        ok: false,
        error: {
          code: "sessionBusy",
          message: "Claude Code Session cannot select Thinking during another operation",
          retryable: true,
        },
      };
    }
    let thinkingOptionId: HarnessThinkingOptionId;
    try {
      thinkingOptionId = parseClaudeThinkingOptionId(command.thinkingOptionId);
    } catch {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "Claude Code Thinking option is invalid",
          retryable: false,
        },
      };
    }
    this.#usageGeneration += 1;
    this.#contextUsageFreshUntilMs = 0;
    this.#contextUsageCooldownUntilMs = 0;
    let resolveConfiguration = (): void => undefined;
    this.#configurationTask = new Promise<void>((resolve) => {
      resolveConfiguration = resolve;
    });
    try {
      const transport = this.#transport;
      if (transport) {
        try {
          await transport.setThinkingOption(thinkingOptionId);
        } catch {
          return {
            ok: false,
            error: {
              code: "nativeFailure",
              message: "Claude Code rejected the Thinking selection",
              retryable: true,
            },
          };
        }
      }
      this.#requestedThinkingOptionId = thinkingOptionId;
      this.#publishState(this.#configuredState());
      return { ok: true, value: { completed: true } };
    } finally {
      resolveConfiguration();
      this.#configurationTask = null;
    }
  }

  async #selectPermissionMode(
    command: PermissionModeSelectCommand,
  ): Promise<HarnessResult<PermissionModeSelectCompleted>> {
    if (this.#configurationTask) {
      return {
        ok: false,
        error: {
          code: "sessionBusy",
          message: "Claude Code Session is already selecting Permission Mode",
          retryable: true,
        },
      };
    }
    let permissionMode: ClaudePermissionMode;
    try {
      permissionMode = decodeClaudePermissionModeId(command.permissionModeId);
    } catch {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "Claude Code Permission Mode is invalid",
          retryable: false,
        },
      };
    }
    this.#usageGeneration += 1;
    this.#contextUsageFreshUntilMs = 0;
    this.#contextUsageCooldownUntilMs = 0;
    let resolveConfiguration = (): void => undefined;
    this.#configurationTask = new Promise<void>((resolve) => {
      resolveConfiguration = resolve;
    });
    try {
      const transport = this.#transport;
      if (transport) {
        try {
          await transport.setPermissionMode(permissionMode);
        } catch (error) {
          const nativeMessage = error instanceof Error ? error.message.toLowerCase() : "";
          return {
            ok: false,
            error: {
              code: "nativeFailure",
              message:
                permissionMode === "auto" && nativeMessage.includes("auto mode unavailable")
                  ? "Auto mode is unavailable for the current Claude Code Model"
                  : "Claude Code rejected the Permission Mode selection",
              retryable: true,
            },
          };
        }
      }
      this.#requestedPermissionModeId = transport
        ? encodeClaudePermissionModeId(transport.getPermissionMode())
        : command.permissionModeId;
      this.#publishState(this.#configuredState());
      return { ok: true, value: { completed: true } };
    } finally {
      resolveConfiguration();
      this.#configurationTask = null;
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
        error: invalidState(
          "Claude Code Interaction Response must reference a pending Interaction",
        ),
      };
    }
    const transport = this.#transport;
    if (!transport) {
      return { ok: false, error: invalidState("Claude Code transport is unavailable") };
    }

    let response: ClaudeInteractionResponse;
    if (pending.type === "approval") {
      if (command.response.type !== "approval") {
        return {
          ok: false,
          error: {
            code: "invalidRequest",
            message: "Claude Code Approval requires an Approval Response",
            retryable: false,
          },
        };
      }
      const validationError = validateHostApprovalResponse(pending.interaction, command.response);
      if (validationError) return { ok: false, error: validationError };
      const actionId = command.response.actionId;
      const action = pending.interaction.actions.find(({ id }) => id === actionId);
      if (!action) {
        return {
          ok: false,
          error: {
            code: "invalidRequest",
            message: "Claude Code Approval action is unavailable",
            retryable: false,
          },
        };
      }
      response = {
        type: "approval",
        requestId: pending.request.requestId,
        decision: action.effect,
      };
    } else {
      if (command.response.type !== "question") {
        return {
          ok: false,
          error: {
            code: "invalidRequest",
            message: "Claude Code Question requires a Question Response",
            retryable: false,
          },
        };
      }
      const validationError = validateHostQuestionResponse(pending.interaction, command.response);
      if (validationError) return { ok: false, error: validationError };
      if (command.response.cancelled) {
        response = {
          type: "question",
          requestId: pending.request.requestId,
          cancelled: true,
        };
      } else {
        const answers: Record<string, string> = {};
        for (const [index, question] of pending.request.questions.entries()) {
          answers[question.question] =
            command.response.answers[`question-${index + 1}`]?.join(", ") ?? "";
        }
        response = {
          type: "question",
          requestId: pending.request.requestId,
          answers,
        };
      }
    }
    try {
      await transport.respondToInteraction(response);
      return { ok: true, value: { accepted: true } };
    } catch {
      return {
        ok: false,
        error: {
          code: "nativeFailure",
          message: "Claude Code Interaction response failed",
          retryable: false,
        },
      };
    }
  }

  async #cancel(command: TurnCancelCommand): Promise<HarnessResult<TurnCancelAccepted>> {
    const active = this.#active;
    if (!active || active.command.turnId !== command.turnId) {
      return {
        ok: false,
        error: invalidState("Claude Code Turn Cancel must reference the active Turn"),
      };
    }
    if (active.cancellationRequested) {
      return { ok: true, value: { cancellationRequested: true } };
    }
    active.cancellationRequested = true;
    if (active.held) {
      this.#finish(active, { status: "cancelled", reason: "Cancelled by user" });
      return { ok: true, value: { cancellationRequested: true } };
    }
    const timeout = rejectAfter(this.#cancelTimeoutMs, "Claude Code interrupt timed out");
    try {
      await Promise.race([this.#transport?.abort() ?? Promise.resolve(), timeout.promise]);
    } catch {
      this.#hardCancel(active);
      return { ok: true, value: { cancellationRequested: true } };
    } finally {
      timeout.cancel();
    }
    if (this.#active === active) this.#armCancelEscalation(active);
    return { ok: true, value: { cancellationRequested: true } };
  }

  async #close(): Promise<void> {
    if (this.#phase === "closed") return;
    this.#usageGeneration += 1;
    this.#contextUsageFreshUntilMs = 0;
    this.#contextUsageCooldownUntilMs = 0;
    this.#contextRefreshPending = null;
    this.#requestUsageBoundary += 1;
    this.#contextRefreshWake?.();
    this.#contextRefreshWake = null;
    this.#clearCancelEscalation();
    this.#clearContinuationQuiescence();
    if (this.#phase !== "faulted") this.#phase = "closing";
    const configurationTask = this.#configurationTask;
    if (configurationTask) {
      await Promise.race([configurationTask, delay(this.#closeTimeoutMs)]);
    }
    let transportClosed = false;
    const active = this.#active;
    if (active) {
      active.cancellationRequested = true;
      if (active.held) {
        this.#finishFailed(active, invalidState("Claude Code Session closed during active Turn"));
      } else {
        await this.#transport?.abort().catch(() => undefined);
        await Promise.race([active.completion, delay(this.#closeTimeoutMs)]);
        if (this.#active === active) {
          await this.#transport?.close().catch(() => undefined);
          transportClosed = true;
          this.#finishFailed(active, invalidState("Claude Code Session closed during active Turn"));
        }
      }
    }
    if (!transportClosed) await this.#transport?.close().catch(() => undefined);
    this.#phase = "closed";
    this.#channel.end();
    this.#onClosed();
  }

  async #ensureTransport(): Promise<ClaudeTurnTransport> {
    if (this.#transport) return this.#transport;
    const selectedModel =
      this.#requestedModel ?? (this.#openMode === "create" ? CLAUDE_DEFAULT_MODEL_REF : undefined);
    const model = selectedModel ? decodeClaudeModelRef(selectedModel) : undefined;
    const permissionMode = decodeClaudePermissionModeId(this.#requestedPermissionModeId);
    const transport = this.#createTransport({
      cwd: this.#cwd,
      sessionId: this.#sessionId,
      openMode: this.#openMode,
      ...(model ? { model } : {}),
      thinkingOptionId: this.#requestedThinkingOptionId,
      permissionMode,
      onPermissionModeChanged: (mode) => this.#handlePermissionModeChanged(mode),
      onFault: () => this.#fault(faultError()),
      onPlanLimit: (planLimit) => this.#handlePlanLimit(planLimit),
    });
    transport.setAutonomousTurnHandler((turn) => this.#handleAutonomousTurn(turn));
    transport.setIdleTurnHandler({
      onEvent: (event) => {
        const active = this.#active;
        if (active) this.#handleTurnEvent(active, event);
      },
      onTerminal: (result) => {
        const active = this.#active;
        if (active) this.#finishResult(active, result);
      },
    });
    try {
      await transport.start();
      this.#state = {
        ...this.#configuredState(true),
        effectivePermissionModeId: encodeClaudePermissionModeId(transport.getPermissionMode()),
      };
    } catch (error) {
      await transport.close().catch(() => undefined);
      throw error;
    }
    this.#openMode = "resume";
    this.#transport = transport;
    return transport;
  }

  #configuredState(nativeReady = this.#state.nativeRef !== undefined): HarnessSessionState {
    const effectiveModel =
      this.#requestedModel ??
      (this.#openMode === "create" ? CLAUDE_DEFAULT_MODEL_REF : this.#state.effectiveModel);
    return {
      ...(nativeReady ? { nativeRef: this.#nativeRef } : {}),
      ...(effectiveModel ? { effectiveModel } : {}),
      effectiveThinkingOptionId: this.#requestedThinkingOptionId,
      availableThinkingOptions: [...CLAUDE_THINKING_OPTIONS],
      effectivePermissionModeId: this.#requestedPermissionModeId,
    };
  }

  #publishState(state: HarnessSessionState = this.#state): void {
    this.#state = state;
    this.#statePublished = true;
    this.#event({ type: "session.state.changed", state });
  }

  #handlePermissionModeChanged(permissionMode: ClaudePermissionMode): void {
    if (this.#phase !== "open") return;
    const effectivePermissionModeId = encodeClaudePermissionModeId(permissionMode);
    if (this.#state.effectivePermissionModeId === effectivePermissionModeId) return;
    this.#requestedPermissionModeId = effectivePermissionModeId;
    this.#publishState({ ...this.#state, effectivePermissionModeId });
  }

  #handleTurnEvent(active: ActiveTurn, event: ClaudeTurnEvent): void {
    if (this.#active !== active || this.#phase === "closed" || this.#phase === "faulted") return;
    switch (event.type) {
      case "segment.started":
        this.#observeRootOutput();
        return;
      case "subagents.live":
        this.#occupancy.observeLive(event.nativeSubagentIds);
        return;
      case "compaction.started":
        this.#startCompaction(active);
        return;
      case "compaction.completed":
        this.#completeCompaction(active, event.outcome);
        return;
      case "text.delta":
        if (event.delta.length > 0) this.#observeRootOutput();
        this.#appendText(active, event.messageId, event.delta);
        return;
      case "reasoning.delta":
        if (event.delta.length > 0) this.#observeRootOutput();
        this.#activateAssistantMessage(active, event.messageId);
        this.#appendReasoning(active, event.messageId, event.delta);
        return;
      case "reasoning.completed":
        this.#completeReasoning(active, event.messageId, { status: "succeeded" });
        return;
      case "message.completed": {
        if (event.lastRequestUsage) {
          this.#requestUsageBoundary += 1;
          this.#applyLatestRequestUsage(active, event.lastRequestUsage);
        } else {
          this.#requestLatestRequestUsage(active, event.messageId);
        }
        if (event.checkpointId) active.checkpointId = event.checkpointId;
        this.#completeReasoning(active, event.messageId, { status: "succeeded" });
        if (
          active.tools.size > 0 ||
          active.subagents.size > 0 ||
          active.interactions.size > 0 ||
          active.compactionItem
        ) {
          return;
        }
        this.#completeAgentItem(active, { status: "succeeded" }, false);
        return;
      }
      case "tool.started":
        this.#observeRootOutput();
        for (const messageId of [...active.reasoningItems.keys()]) {
          this.#completeReasoning(active, messageId, { status: "succeeded" });
        }
        this.#completeAgentItem(active, { status: "succeeded" }, false);
        active.tools.start(active.command.turnId, event);
        return;
      case "tool.progress":
        active.tools.progress(event);
        return;
      case "tool.completed":
        active.tools.complete(active.command.turnId, event, active.cancellationRequested);
        return;
      case "subagent.started":
        this.#observeRootOutput();
        for (const messageId of [...active.reasoningItems.keys()]) {
          this.#completeReasoning(active, messageId, { status: "succeeded" });
        }
        this.#completeAgentItem(active, { status: "succeeded" }, false);
        active.subagents.start(active.command.turnId, event);
        if (event.operation === "send") {
          if (event.nativeSubagentId) this.#occupancy.occupyAgent(event.nativeSubagentId);
        } else if (event.background) {
          this.#occupancy.occupySpawn(event.callId, event.nativeSubagentId);
        }
        return;
      case "subagent.updated":
        active.subagents.update(active.command.turnId, event);
        if (event.nativeSubagentId) this.#occupancy.bind(event.callId, event.nativeSubagentId);
        if (
          event.status === "completed" ||
          event.status === "failed" ||
          event.status === "interrupted"
        ) {
          this.#settleBackgroundSubagent(
            event.status,
            event.nativeSubagentId,
            event.callId,
            event.resultSummary,
          );
        }
        if (active.pendingSubagentTranscriptCalls.delete(event.callId)) {
          const nativeSubagentId = active.subagents.nativeSubagentId(event.callId);
          if (nativeSubagentId) {
            this.#event({ type: "subagent.transcript.changed", nativeSubagentId });
          }
        }
        return;
      case "subagent.completed": {
        const subagent = active.subagents.complete(
          active.command.turnId,
          event,
          active.cancellationRequested,
        );
        if (subagent.status === "running") {
          if (subagent.nativeSubagentId) {
            this.#occupancy.bind(event.callId, subagent.nativeSubagentId);
          }
          return;
        }
        this.#occupancy.release(event.callId, subagent.nativeSubagentId);
        return;
      }
      case "subagent.settled":
        this.#settleBackgroundSubagent(
          event.status,
          event.nativeSubagentId,
          event.callId,
          event.resultSummary,
        );
        return;
      case "subagent.transcript.changed": {
        const nativeSubagentId = active.subagents.nativeSubagentId(event.callId);
        if (nativeSubagentId) {
          this.#event({ type: "subagent.transcript.changed", nativeSubagentId });
        } else {
          active.pendingSubagentTranscriptCalls.add(event.callId);
        }
        return;
      }
      case "interaction.requested":
        this.#startInteraction(active, event.request);
        return;
      case "interaction.closed":
        this.#closeInteraction(active, event.requestId, event.reason);
        return;
      case "usage.result":
        this.#applyResultUsage(active, event);
        return;
    }
  }

  #startCompaction(active: ActiveTurn): void {
    if (active.compactionItem) throw new Error("Claude Code Compaction started more than once");
    const item: HostContextCompactionItem = {
      type: "contextCompaction",
      itemId: hostItemIdSchema.parse(this.#randomUUID()),
    };
    active.compactionItem = item;
    this.#event({ type: "item.started", turnId: active.command.turnId, item });
  }

  #completeCompaction(active: ActiveTurn, result: "succeeded" | "failed"): void {
    if (result === "succeeded") this.#minimumContextUsedTokens = null;
    const outcome: HostItemOutcome =
      result === "succeeded"
        ? { status: "succeeded" }
        : {
            status: "failed",
            error: {
              code: "nativeFailure",
              message: "Claude Code context compaction failed",
              retryable: true,
            },
          };
    this.#completeCompactionItem(active, outcome);
  }

  #completeCompactionItem(active: ActiveTurn, outcome: HostItemOutcome): void {
    const item = active.compactionItem;
    if (!item) throw new Error("Claude Code Compaction completed without starting");
    active.compactionItem = null;
    this.#event({
      type: "item.completed",
      turnId: active.command.turnId,
      snapshot: { item, outcome },
    });
  }

  #startInteraction(active: ActiveTurn, request: ClaudeInteractionRequest): void {
    if (active.interactionByRequestId.has(request.requestId)) {
      throw new Error("Claude Code Interaction started more than once");
    }
    const interactionId = hostInteractionIdSchema.parse(this.#randomUUID());
    let pending: ActiveInteraction;
    if (request.type === "approval") {
      const interaction: HostApprovalInteraction = {
        type: "approval",
        interactionId,
        turnId: active.command.turnId,
        title: request.title,
        ...(request.description ? { description: request.description } : {}),
        subject: { type: "nativeAction" },
        actions: [
          { id: "allowOnce", label: "Allow once", effect: "allowOnce" },
          ...(request.suggestedScope === "session"
            ? [
                {
                  id: "allowForSession",
                  label: "Allow this conversation",
                  effect: "allowForSession" as const,
                },
              ]
            : request.suggestedScope === "always"
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
      pending = { type: "approval", interaction, request };
    } else {
      const firstQuestion = request.questions[0];
      if (!firstQuestion) throw new Error("Claude Code Question request is empty");
      const interaction: HostQuestionInteraction = {
        type: "question",
        interactionId,
        turnId: active.command.turnId,
        title: request.questions.length === 1 ? firstQuestion.header : "Claude Code",
        questions: request.questions.map((question, index) => ({
          id: `question-${index + 1}`,
          type: "choice",
          prompt: question.question,
          options: question.options.map((option) => ({
            value: option.label,
            label: option.label,
            description: option.description,
          })),
          multiple: question.multiSelect,
          allowOther: true,
          optional: false,
        })),
      };
      pending = { type: "question", interaction, request };
    }
    active.interactions.set(interactionId, pending);
    active.interactionByRequestId.set(request.requestId, interactionId);
    this.#channel.emit({ kind: "interaction", interaction: pending.interaction });
  }

  #closeInteraction(
    active: ActiveTurn,
    requestId: string,
    reason: "responded" | "cancelled" | "superseded",
  ): void {
    const interactionId = active.interactionByRequestId.get(requestId);
    if (!interactionId)
      throw new Error("Claude Code Interaction close references an unknown request");
    active.interactionByRequestId.delete(requestId);
    active.interactions.delete(interactionId);
    this.#event({
      type: "interaction.closed",
      interactionId,
      turnId: active.command.turnId,
      reason,
    });
  }

  #closeActiveInteractions(active: ActiveTurn, reason: "cancelled" | "superseded"): void {
    for (const [interactionId, pending] of active.interactions) {
      active.interactions.delete(interactionId);
      active.interactionByRequestId.delete(pending.request.requestId);
      this.#event({
        type: "interaction.closed",
        interactionId,
        turnId: active.command.turnId,
        reason,
      });
    }
  }

  #activateAssistantMessage(active: ActiveTurn, messageId: string): void {
    if (active.assistantMessageId === messageId) return;
    if (active.assistantMessageId !== null) {
      this.#completeReasoning(active, active.assistantMessageId, { status: "succeeded" });
      this.#completeAgentItem(active, { status: "succeeded" }, false);
    }
    if (!active.item) {
      active.agentMessageOrdinal += 1;
      active.item = {
        type: "agentMessage",
        itemId: claudeTranscriptItemId(
          active.nativeTurnKey,
          "agentMessage",
          active.agentMessageOrdinal,
        ),
        text: "",
      };
      this.#event({ type: "item.started", turnId: active.command.turnId, item: active.item });
    }
    active.assistantMessageId = messageId;
  }

  #appendText(active: ActiveTurn, messageId: string, delta: string): void {
    if (this.#active !== active || delta.length === 0) return;
    this.#activateAssistantMessage(active, messageId);
    if (!active.item) throw new Error("Claude Assistant text has no active Item");
    active.item = { ...active.item, text: active.item.text + delta };
    this.#event({
      type: "item.updated",
      turnId: active.command.turnId,
      itemId: active.item.itemId,
      update: { type: "text.append", text: delta },
    });
  }

  #completeAgentItem(active: ActiveTurn, outcome: HostItemOutcome, completeEmpty: boolean): void {
    active.assistantMessageId = null;
    const item = active.item;
    if (!item || (!completeEmpty && item.text.length === 0)) return;
    active.item = null;
    this.#event({
      type: "item.completed",
      turnId: active.command.turnId,
      snapshot: { item, outcome },
    });
  }

  #appendReasoning(active: ActiveTurn, messageId: string, delta: string): void {
    if (this.#active !== active || delta.length === 0) return;
    let item = active.reasoningItems.get(messageId);
    if (!item) {
      active.reasoningOrdinal += 1;
      item = {
        type: "reasoning",
        itemId: claudeTranscriptItemId(active.nativeTurnKey, "reasoning", active.reasoningOrdinal),
        text: "",
      };
      active.reasoningItems.set(messageId, item);
      this.#event({ type: "item.started", turnId: active.command.turnId, item });
    }
    item = { ...item, text: item.text + delta };
    active.reasoningItems.set(messageId, item);
    this.#event({
      type: "item.updated",
      turnId: active.command.turnId,
      itemId: item.itemId,
      update: { type: "text.append", text: delta },
    });
  }

  #completeReasoning(active: ActiveTurn, messageId: string, outcome: HostItemOutcome): void {
    const item = active.reasoningItems.get(messageId);
    if (!item) return;
    active.reasoningItems.delete(messageId);
    this.#event({
      type: "item.completed",
      turnId: active.command.turnId,
      snapshot: { item, outcome },
    });
  }

  #handleAutonomousTurn(turn: ClaudeAutonomousTurn): void {
    if (this.#phase !== "open") return;
    const held = this.#active;
    if (held?.held) {
      this.#continueHeldTurn(held, turn);
      return;
    }
    if (this.#active) return;
    this.#autonomousOrdinal += 1;
    const turnId = hostTurnIdSchema.parse(this.#randomUUID());
    let resolveCompletion = (): void => undefined;
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    const nativeTurnKey = turn.nativeTurnKey || `autonomous-${this.#autonomousOrdinal}`;
    const item: HostAgentMessageItem = {
      type: "agentMessage",
      itemId: claudeTranscriptItemId(nativeTurnKey, "agentMessage", 1),
      text: "",
    };
    const active: ActiveTurn = {
      command: { type: "turn.start", turnId, input: [] },
      compactionItem: null,
      item,
      agentMessageOrdinal: 1,
      assistantMessageId: null,
      reasoningItems: new Map(),
      reasoningOrdinal: 0,
      pendingSubagentTranscriptCalls: new Set(),
      subagents: new ClaudeSubagentLifecycle({
        newItemId: () => hostItemIdSchema.parse(this.#randomUUID()),
        emit: (event) => this.#event(event),
      }),
      tools: new ClaudeToolLifecycle({
        cwd: this.#cwd,
        outputLimit: this.#toolOutputLimit,
        taskTracker: this.#taskTracker,
        newItemId: () => hostItemIdSchema.parse(this.#randomUUID()),
        emit: (event) => this.#event(event),
      }),
      interactions: new Map(),
      interactionByRequestId: new Map(),
      checkpointId: null,
      nativeTurnKey,
      nativeTurnRef: nativeTurnRefSchema.parse({
        harnessId: this.harnessId,
        nativeSessionId: this.#sessionId,
        nativeTurnKey,
        formatVersion: 1,
      }),
      cancellationRequested: false,
      usageRequestIds: new Set(),
      estimatedInputTokens: 0,
      estimatedOutputTokens: 0,
      estimatedCostUsd: 0,
      estimatedCostAvailable: false,
      usageTokensCalibrated: false,
      usageCostCalibrated: false,
      held: false,
      completion,
      resolveCompletion,
    };
    this.#active = active;
    this.#event({ type: "turn.autonomous.started", turnId, input: [] });
    this.#event({ type: "turn.started", turnId });
    this.#event({ type: "item.started", turnId, item });
    for (const event of turn.events) this.#handleTurnEvent(active, event);
    this.#finishResult(active, turn.result);
  }

  #continueHeldTurn(active: ActiveTurn, turn: ClaudeAutonomousTurn): void {
    for (const event of turn.events) this.#handleTurnEvent(active, event);
    this.#finishResult(active, turn.result);
  }

  #settleBackgroundSubagent(
    status: "completed" | "failed" | "interrupted",
    nativeSubagentId?: string,
    callId?: string,
    resultSummary?: string,
  ): void {
    // The Subagent stopped, but its Root continuation runs in a later Segment.
    this.#occupancy.notify(callId, nativeSubagentId);
    if (!nativeSubagentId) return;
    this.#event({
      type: "subagent.state.changed",
      nativeSubagentId,
      status,
      ...(resultSummary ? { resultSummary } : {}),
    });
  }

  #interruptBackgroundSubagents(status: "failed" | "interrupted"): void {
    for (const nativeSubagentId of this.#occupancy.interruptAll()) {
      this.#event({ type: "subagent.state.changed", nativeSubagentId, status });
    }
  }

  #finishResult(active: ActiveTurn, result: ClaudeTransportTurnResult): void {
    if (this.#active !== active) return;
    if (result.status === "succeeded" && (active.tools.size > 0 || active.subagents.size > 0)) {
      this.#finishFailed(active, transportFailure("protocol"));
    } else if (result.status === "succeeded") {
      this.#finish(active, { status: "succeeded" });
    } else if (result.status === "cancelled") {
      this.#finish(active, { status: "cancelled", reason: result.reason });
    } else {
      this.#finishFailed(active, transportFailure(result.kind));
    }
  }

  #requestContextUsage(
    transport: ClaudeTurnTransport,
    turnId: TurnStartCommand["turnId"] | undefined,
    retryDelaysMs: readonly number[],
  ): void {
    if (this.#phase !== "open" || this.#transport !== transport) return;
    if (this.#contextRefreshInFlight) return;
    this.#contextRefreshPending = {
      transport,
      ...(turnId !== undefined ? { turnId } : {}),
      generation: this.#usageGeneration,
      retryDelaysMs,
    };
    this.#contextRefreshInFlight = this.#drainContextUsage();
  }

  async #drainContextUsage(): Promise<void> {
    try {
      while (this.#contextRefreshPending) {
        const request = this.#contextRefreshPending;
        this.#contextRefreshPending = null;
        await this.#readContextUsage(request);
      }
    } finally {
      this.#contextRefreshInFlight = null;
      if (this.#contextRefreshPending && this.#phase === "open") {
        this.#contextRefreshInFlight = this.#drainContextUsage();
      }
    }
  }

  async #readContextUsage(request: ContextUsageRefreshRequest): Promise<void> {
    for (const retryDelayMs of request.retryDelaysMs) {
      if (retryDelayMs > 0 && (await this.#waitForContextRetry(retryDelayMs))) return;
      if (
        this.#phase !== "open" ||
        this.#transport !== request.transport ||
        this.#usageGeneration !== request.generation ||
        this.#contextRefreshPending !== null
      ) {
        return;
      }
      try {
        const context = await request.transport.getContextUsage();
        if (
          this.#phase !== "open" ||
          this.#transport !== request.transport ||
          this.#usageGeneration !== request.generation ||
          this.#contextRefreshPending !== null
        ) {
          return;
        }
        if (context === null) continue;
        this.#contextUsageFreshUntilMs = Date.now() + CONTEXT_USAGE_TTL_MS;
        this.#contextUsageCooldownUntilMs = 0;
        this.#mergeAndPublishUsage(
          {
            contextUsedTokens: Math.max(context.usedTokens, this.#minimumContextUsedTokens ?? 0),
            contextWindowTokens: context.maxTokens,
          },
          request.turnId,
        );
        return;
      } catch {
        // Context Usage is an independent, best-effort projection.
      }
    }
    if (
      this.#phase === "open" &&
      this.#transport === request.transport &&
      this.#usageGeneration === request.generation
    ) {
      this.#contextUsageCooldownUntilMs = Date.now() + CONTEXT_USAGE_FAILURE_COOLDOWN_MS;
    }
  }

  async #waitForContextRetry(milliseconds: number): Promise<boolean> {
    let wake = (): void => undefined;
    const superseded = new Promise<true>((resolve) => {
      wake = () => resolve(true);
    });
    this.#contextRefreshWake = wake;
    const result = await Promise.race([delay(milliseconds).then(() => false), superseded]);
    if (this.#contextRefreshWake === wake) this.#contextRefreshWake = null;
    return result;
  }

  #requestLatestRequestUsage(active: ActiveTurn, messageId: string): void {
    const request: RequestUsageRefreshRequest = {
      turnId: active.command.turnId,
      messageId,
      boundary: (this.#requestUsageBoundary += 1),
      generation: this.#usageGeneration,
    };
    void this.#readLatestRequestUsage(request);
  }

  async #readLatestRequestUsage(request: RequestUsageRefreshRequest): Promise<void> {
    for (const retryDelayMs of REQUEST_USAGE_RETRY_DELAYS_MS) {
      if (retryDelayMs > 0) await delay(retryDelayMs);
      if (
        this.#phase !== "open" ||
        this.#usageGeneration !== request.generation ||
        this.#requestUsageBoundary !== request.boundary
      ) {
        return;
      }
      try {
        const messages = await this.#readSessionMessages({
          cwd: this.#cwd,
          sessionId: this.#sessionId,
        });
        if (
          this.#phase !== "open" ||
          this.#usageGeneration !== request.generation ||
          this.#requestUsageBoundary !== request.boundary
        ) {
          return;
        }
        const usage = transcriptRequestUsage(messages, request.messageId);
        if (!usage) continue;
        const active = this.#active;
        if (!active || active.command.turnId !== request.turnId) return;
        this.#applyLatestRequestUsage(active, usage);
        return;
      } catch {
        // The transcript is written asynchronously; retry without affecting the Turn.
      }
    }
  }

  #applyLatestRequestUsage(active: ActiveTurn, usage: ClaudeLastRequestUsage): void {
    const requestId = usage.requestId ?? `${active.nativeTurnKey}:${usage.model ?? "unknown"}`;
    if (active.usageRequestIds.has(requestId)) return;
    active.usageRequestIds.add(requestId);
    active.estimatedInputTokens +=
      usage.inputTokens + usage.cacheCreationInputTokens + usage.cacheReadInputTokens;
    active.estimatedOutputTokens += usage.outputTokens;
    const estimatedCostUsd = estimateClaudeRequestCostUsd(usage);
    if (estimatedCostUsd !== undefined) {
      active.estimatedCostUsd += estimatedCostUsd;
      active.estimatedCostAvailable = true;
    }

    const promptTokens =
      usage.inputTokens + usage.cacheCreationInputTokens + usage.cacheReadInputTokens;
    if (promptTokens > 0) this.#minimumContextUsedTokens = promptTokens;
    const cacheHitRatePercent = claudeCacheHitRatePercent(usage);
    const contextWindowTokens = this.#latestUsage?.contextWindowTokens;
    this.#mergeAndPublishUsage(
      {
        ...(cacheHitRatePercent !== undefined ? { cacheHitRatePercent } : {}),
        inputTokens: this.#calibratedInputTokens + active.estimatedInputTokens,
        outputTokens: this.#calibratedOutputTokens + active.estimatedOutputTokens,
        ...(active.estimatedCostAvailable
          ? { totalCostUsd: this.#calibratedCostUsd + active.estimatedCostUsd }
          : {}),
        ...(contextWindowTokens !== undefined && promptTokens > 0
          ? { contextUsedTokens: promptTokens, contextWindowTokens }
          : {}),
      },
      active.command.turnId,
    );
  }

  #applyResultUsage(
    active: ActiveTurn,
    event: Extract<ClaudeTurnEvent, { type: "usage.result" }>,
  ): void {
    const delta: Partial<HostUsage> = {};
    if (event.totalCostUsd !== undefined) {
      this.#calibratedCostUsd = event.totalCostUsd;
      active.estimatedCostUsd = 0;
      active.estimatedCostAvailable = false;
      active.usageCostCalibrated = true;
      delta.totalCostUsd = event.totalCostUsd;
    }
    if (event.modelUsage !== undefined) {
      let inputTokens = 0;
      let outputTokens = 0;
      for (const model of event.modelUsage) {
        inputTokens += model.inputTokens;
        outputTokens += model.outputTokens;
      }
      if (Number.isSafeInteger(inputTokens) && Number.isSafeInteger(outputTokens)) {
        this.#calibratedInputTokens = inputTokens;
        this.#calibratedOutputTokens = outputTokens;
        active.estimatedInputTokens = 0;
        active.estimatedOutputTokens = 0;
        active.usageTokensCalibrated = true;
        delta.inputTokens = inputTokens;
        delta.outputTokens = outputTokens;
      }
    }
    if (event.lastRequestUsage) {
      const cacheHitRatePercent = claudeCacheHitRatePercent(event.lastRequestUsage);
      if (cacheHitRatePercent !== undefined) delta.cacheHitRatePercent = cacheHitRatePercent;
    }
    this.#mergeAndPublishUsage(delta, active.command.turnId);
  }

  /**
   * Plan usage is account-wide, not Thread-scoped, so every observation is
   * offered to the Adapter's shared cache regardless of this Session's own
   * lifecycle phase. What this Thread then publishes is the value the Adapter
   * *accepted*, not the raw observation: a rejected push must not leave this
   * Thread's Usage popover showing a number the credits pill disagrees with.
   */
  #handlePlanLimit(planLimit: ClaudePlanLimitEvent): void {
    const effective = this.#onPlanLimitObserved(planLimit);
    if (effective) this.publishPlanLimit(effective);
  }

  publishPlanLimit(planLimit: ClaudePlanLimitEvent): void {
    if (this.#phase !== "open") return;
    const delta: Partial<HostUsage> = {};
    if (planLimit.fiveHour) {
      delta.planFiveHourUsedPercent = planLimit.fiveHour.utilizationPercent;
      if (planLimit.fiveHour.resetsAtUnix !== undefined) {
        delta.planFiveHourResetsAtUnix = planLimit.fiveHour.resetsAtUnix;
      }
    }
    if (planLimit.sevenDay) {
      delta.planSevenDayUsedPercent = planLimit.sevenDay.utilizationPercent;
      if (planLimit.sevenDay.resetsAtUnix !== undefined) {
        delta.planSevenDayResetsAtUnix = planLimit.sevenDay.resetsAtUnix;
      }
    }
    this.#mergeAndPublishUsage(delta, this.#active?.command.turnId);
  }

  /**
   * Every Usage observation replaces `#latestUsage` in full: unaffected fields
   * from the prior snapshot are carried forward, never cleared by an
   * incomplete new observation.
   */
  #mergeAndPublishUsage(
    delta: Partial<HostUsage>,
    turnId: TurnStartCommand["turnId"] | undefined,
  ): void {
    if (Object.keys(delta).length === 0) return;
    let usage: HostUsage;
    try {
      usage = parseHostUsage({ ...(this.#latestUsage ?? {}), ...delta });
    } catch {
      return;
    }
    if (this.#latestUsage) {
      const latestKeys = Object.keys(this.#latestUsage);
      const nextKeys = Object.keys(usage);
      if (
        latestKeys.length === nextKeys.length &&
        nextKeys.every(
          (key) => this.#latestUsage?.[key as keyof HostUsage] === usage[key as keyof HostUsage],
        )
      ) {
        return;
      }
    }
    this.#latestUsage = usage;
    this.#event({
      type: "session.usage.changed",
      ...(turnId !== undefined ? { observedForTurnId: turnId } : {}),
      usage,
    });
  }

  #finishFailed(active: ActiveTurn, error: HarnessError): void {
    this.#finish(active, { status: "failed", error });
  }

  /** Completes held work after a quiet period with no further Root output. */
  #armContinuationQuiescence(active: ActiveTurn): void {
    this.#clearContinuationQuiescence();
    if (!this.#occupancy.awaitingContinuation) return;
    const quiescence = setTimeout(() => {
      this.#continuationQuiescence = null;
      if (this.#active !== active || !active.held || this.#phase !== "open") return;
      this.#occupancy.releaseContinuations();
      if (this.#occupancy.unsettled) return;
      this.#finish(active, { status: "succeeded" });
    }, this.#continuationQuiescenceMs);
    quiescence.unref();
    this.#continuationQuiescence = quiescence;
  }

  #clearContinuationQuiescence(): void {
    if (!this.#continuationQuiescence) return;
    clearTimeout(this.#continuationQuiescence);
    this.#continuationQuiescence = null;
  }

  #observeRootOutput(): void {
    this.#clearContinuationQuiescence();
  }

  #finish(active: ActiveTurn, outcome: TurnOutcome): void {
    if (this.#active !== active) return;
    this.#requestUsageBoundary += 1;
    this.#clearCancelEscalation();
    this.#clearContinuationQuiescence();
    const hold =
      outcome.status === "succeeded" && !active.cancellationRequested && this.#occupancy.unsettled;
    this.#closeActiveInteractions(
      active,
      outcome.status === "succeeded" ? "superseded" : "cancelled",
    );
    const itemOutcome: HostItemOutcome = outcome;
    if (active.compactionItem) this.#completeCompactionItem(active, itemOutcome);
    active.tools.finalize(active.command.turnId, itemOutcome);
    active.subagents.finalize(active.command.turnId, itemOutcome);
    for (const messageId of [...active.reasoningItems.keys()]) {
      this.#completeReasoning(active, messageId, itemOutcome);
    }
    this.#completeAgentItem(active, itemOutcome, true);
    if (hold) {
      active.held = true;
      active.compactionItem = null;
      active.pendingSubagentTranscriptCalls.clear();
      this.#transport?.setIdleLive(true);
      this.#armContinuationQuiescence(active);
      return;
    }
    if (outcome.status !== "succeeded") {
      this.#interruptBackgroundSubagents(outcome.status === "cancelled" ? "interrupted" : "failed");
    }
    const checkpoint = active.checkpointId
      ? nativeCheckpointRefSchema.parse({
          harnessId: this.harnessId,
          nativeSessionId: this.#sessionId,
          checkpointId: active.checkpointId,
          formatVersion: 1,
        })
      : null;
    this.#event({
      type: "turn.completed",
      turnId: active.command.turnId,
      ...(active.nativeTurnRef ? { nativeTurnRef: active.nativeTurnRef } : {}),
      outcome: checkpoint ? { ...outcome, checkpoint } : outcome,
    });
    this.#active = null;
    this.#occupancy.clear();
    this.#transport?.setIdleLive(false);
    active.resolveCompletion();
  }

  #handleTurnTransportFailure(active: ActiveTurn): void {
    if (this.#active !== active) return;
    if (active.cancellationRequested) {
      this.#hardCancel(active);
      return;
    }
    this.#fault(faultError());
  }

  #armCancelEscalation(active: ActiveTurn): void {
    this.#clearCancelEscalation();
    const timer = setTimeout(() => {
      this.#cancelEscalation = null;
      if (this.#active !== active || this.#phase !== "open") return;
      this.#hardCancel(active);
    }, this.#cancelTimeoutMs);
    timer.unref();
    this.#cancelEscalation = timer;
  }

  #clearCancelEscalation(): void {
    if (!this.#cancelEscalation) return;
    clearTimeout(this.#cancelEscalation);
    this.#cancelEscalation = null;
  }

  #hardCancel(active: ActiveTurn): void {
    if (this.#active !== active) return;
    this.#clearCancelEscalation();
    const transport = this.#transport;
    this.#transport = null;
    this.#openMode = "resume";
    this.#finish(active, { status: "cancelled", reason: "Cancelled by user" });
    void transport?.close().catch(() => undefined);
  }

  #fault(error: HarnessError): void {
    if (this.#phase === "closed" || this.#phase === "closing" || this.#phase === "faulted") return;
    this.#clearCancelEscalation();
    this.#usageGeneration += 1;
    this.#contextUsageFreshUntilMs = 0;
    this.#contextUsageCooldownUntilMs = 0;
    this.#contextRefreshPending = null;
    this.#requestUsageBoundary += 1;
    this.#contextRefreshWake?.();
    this.#contextRefreshWake = null;
    const active = this.#active;
    if (active) this.#finishFailed(active, error);
    this.#phase = "faulted";
    this.#event({ type: "session.faulted", error });
    this.#channel.end();
    void this.#transport?.close();
    this.#onClosed();
  }

  #event(event: HostEvent): void {
    this.#channel.emit({ kind: "event", event });
  }
}

export class ClaudeCodeAdapter implements HarnessAdapter {
  readonly harnessId: HarnessId = claudeCodeHarnessId;
  readonly subagents = {
    readSnapshot: async (input: {
      parent: NativeSessionRef;
      nativeSubagentId: string;
      cwd: string;
    }): Promise<HarnessResult<HostThreadSnapshot>> => {
      if (input.parent.harnessId !== this.harnessId || input.nativeSubagentId.trim().length === 0) {
        return {
          ok: false,
          error: {
            code: "invalidRequest",
            message: "Claude Code Subagent reference is invalid",
            retryable: false,
          },
        };
      }
      try {
        const [messages, parentMessages] = await Promise.all([
          this.#dependencies.readSubagentMessages({
            cwd: input.cwd,
            sessionId: input.parent.nativeSessionId,
            nativeSubagentId: input.nativeSubagentId,
          }),
          this.#dependencies.readSessionMessages({
            cwd: input.cwd,
            sessionId: input.parent.nativeSessionId,
          }),
        ]);
        return {
          ok: true,
          value: mapClaudeSubagentSnapshot(
            messages,
            input.parent.nativeSessionId,
            input.nativeSubagentId,
            parentMessages,
          ),
        };
      } catch {
        return {
          ok: false,
          error: {
            code: "protocolError",
            message: "Claude Code Subagent history is invalid",
            retryable: false,
          },
        };
      }
    },
  };
  readonly #cancelTimeoutMs: number;
  readonly #closeTimeoutMs: number;
  readonly #dependencies: ClaudeAdapterDependencies;
  readonly #toolOutputLimit: number;
  readonly #continuationQuiescenceMs: number;
  readonly #inspectionCache = new Map<string, HarnessInspection>();
  readonly #inspectionInFlight = new Map<string, Promise<HarnessInspection>>();
  readonly #inspectors = new Set<ClaudeModelInspector>();
  readonly #sessions = new Set<ClaudeHarnessSession>();
  #closePromise: Promise<void> | null = null;
  #latestPlanLimit: ClaudePlanLimitEvent | null = null;

  constructor(options: ClaudeCodeAdapterOptions = {}, dependencies?: ClaudeAdapterDependencies) {
    this.#closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
    this.#cancelTimeoutMs = options.cancelTimeoutMs ?? DEFAULT_CANCEL_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.#cancelTimeoutMs) || this.#cancelTimeoutMs <= 0) {
      throw new RangeError("Claude Code cancel timeout must be a positive safe integer");
    }
    this.#toolOutputLimit = options.toolOutputLimit ?? DEFAULT_TOOL_OUTPUT_LIMIT;
    if (!Number.isSafeInteger(this.#toolOutputLimit) || this.#toolOutputLimit <= 0) {
      throw new RangeError("Claude Code Tool output limit must be a positive safe integer");
    }
    this.#continuationQuiescenceMs =
      options.continuationQuiescenceMs ?? DEFAULT_CONTINUATION_QUIESCENCE_MS;
    if (
      !Number.isSafeInteger(this.#continuationQuiescenceMs) ||
      this.#continuationQuiescenceMs <= 0
    ) {
      throw new RangeError("Claude Code continuation quiescence must be a positive safe integer");
    }
    this.#dependencies = dependencies ?? {
      randomUUID,
      inspectInstallation: () => {
        resolveClaudeCodeExecutable({
          ...(options.command ? { command: options.command } : {}),
          environment: options.environment ?? process.env,
        });
      },
      createInspector: (input) =>
        new ClaudeSdkModelInspector({
          ...input,
          ...(options.command ? { command: options.command } : {}),
          environment: options.environment ?? process.env,
          closeTimeoutMs: this.#closeTimeoutMs,
        }),
      createTransport: (input) =>
        new ClaudeSdkTransport({
          ...input,
          ...(options.command ? { command: options.command } : {}),
          environment: input.environment ?? options.environment ?? process.env,
          closeTimeoutMs: this.#closeTimeoutMs,
          abortTimeoutMs: this.#cancelTimeoutMs,
        }),
      deleteSession: ({ cwd, sessionId }) => deleteClaudeSession(sessionId, { dir: cwd }),
      forkSession: ({ checkpointId, cwd, sourceSessionId }) =>
        forkClaudeNativeSession(sourceSessionId, { dir: cwd, upToMessageId: checkpointId }),
      getSessionInfo: async ({ sessionId }) => {
        const info = await getClaudeSessionInfo(sessionId);
        if (!info) return undefined;
        return info.cwd ? { cwd: info.cwd } : {};
      },
      readSessionMessages: async ({ cwd, sessionId }) => {
        const transcript = await readClaudeTranscript({
          cwd,
          environment: options.environment ?? process.env,
          sessionId,
        });
        return transcript ?? [];
      },
      readSubagentMessages: ({ cwd, sessionId, nativeSubagentId }) =>
        getSubagentMessages(sessionId, nativeSubagentId, { dir: cwd }),
    };
  }

  async inspect(input: InspectHarnessInput = {}): Promise<HarnessInspection> {
    if (this.#closePromise) {
      return {
        status: "unavailable",
        error: invalidState("Claude Code Adapter is closing"),
      };
    }
    const cwd = path.resolve(input.cwd ?? process.cwd());
    if (!input.refresh) {
      const cached = this.#inspectionCache.get(cwd);
      if (cached) return cached;
    }
    const current = this.#inspectionInFlight.get(cwd);
    if (current) return current;
    const inspection = this.#inspectModels(cwd).then((result) => {
      if (result.status === "ready") this.#inspectionCache.set(cwd, result);
      return result;
    });
    this.#inspectionInFlight.set(cwd, inspection);
    void inspection.finally(() => {
      if (this.#inspectionInFlight.get(cwd) === inspection) {
        this.#inspectionInFlight.delete(cwd);
      }
    });
    return inspection;
  }

  async #inspectModels(cwd: string): Promise<HarnessInspection> {
    let inspector: ClaudeModelInspector | null = null;
    const startedAt = Date.now();
    let stage = "resolve-executable";
    try {
      this.#dependencies.inspectInstallation();
      stage = "startup";
      inspector = this.#dependencies.createInspector({ cwd });
      this.#inspectors.add(inspector);
      stage = "model-catalog";
      const snapshot = await inspector.inspect();
      const permissionModes = snapshot.canSelectPermissionMode
        ? claudePermissionModeCatalogForModels(snapshot.models)
        : undefined;
      if (!snapshot.canSelectModel) {
        return {
          status: "unavailable",
          error: {
            code: "unavailable",
            message: "Claude Code did not expose a selectable Model catalog",
            retryable: false,
            stage,
            durationMs: Date.now() - startedAt,
            ...(inspector.stderrTail ? { stderrTail: inspector.stderrTail } : {}),
          },
        };
      }
      const { catalog } = normalizeClaudeModelCatalog(snapshot);
      return {
        status: "ready",
        catalog,
        ...(permissionModes ? { permissionModes } : {}),
        capabilities: {
          configuration: {
            selectModel: true,
            selectThinkingOption: true,
            selectPermissionMode: snapshot.canSelectPermissionMode,
            permissionModeScope: "live",
          },
          history: { fork: true, forkAcrossCwd: false, rollbackLastTurn: true },
          subagents: { observe: true, readTranscript: true },
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const normalized =
        message.startsWith("Claude Code Model") || message.startsWith("Claude SDK context Usage")
          ? ({
              code: "protocolError",
              message: "Claude Code returned an invalid Model catalog",
              retryable: false,
            } satisfies HarnessError)
          : startupFailure(error);
      return {
        status: normalized.code === "notInstalled" ? "notInstalled" : "error",
        error: {
          ...normalized,
          stage,
          durationMs: Date.now() - startedAt,
          ...(inspector?.stderrTail ? { stderrTail: inspector.stderrTail } : {}),
        },
      };
    } finally {
      if (inspector) {
        await inspector.close().catch(() => undefined);
        this.#inspectors.delete(inspector);
      }
    }
  }

  async open(input: OpenSessionInput): Promise<HarnessResult<HarnessSession>> {
    if (this.#closePromise) {
      return {
        ok: false,
        error: invalidState("Claude Code Adapter is closing"),
      };
    }
    if (input.cwd.length === 0) {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "Claude Code Adapter requires cwd",
          retryable: false,
        },
      };
    }
    let rollback:
      | {
          openMode: "create" | "resume";
          sessionId?: string;
        }
      | undefined;
    if (input.kind === "rollbackLastTurn") {
      const sourceRef = nativeSessionRefSchema.safeParse(input.sourceRef);
      if (!sourceRef.success || sourceRef.data.harnessId !== this.harnessId) {
        return {
          ok: false,
          error: {
            code: "invalidRequest",
            message: "Claude Code cannot roll back another Harness's Native Session",
            retryable: false,
          },
        };
      }
      let sourceSnapshot: HostThreadSnapshot;
      try {
        const messages = await this.#dependencies.readSessionMessages({
          cwd: path.resolve(input.cwd),
          sessionId: sourceRef.data.nativeSessionId,
        });
        sourceSnapshot = mapClaudeSnapshot(messages, sourceRef.data.nativeSessionId);
      } catch {
        return {
          ok: false,
          error: {
            code: "nativeFailure",
            message: "Claude Code history could not be read",
            retryable: true,
          },
        };
      }
      if (sourceSnapshot.turns.length === 0) {
        return {
          ok: false,
          error: {
            code: "invalidState",
            message: "Claude Code Native Session has no Turn to roll back",
            retryable: false,
          },
        };
      }
      const retained = sourceSnapshot.turns.at(-2);
      if (!retained) {
        rollback = {
          openMode: "create",
          sessionId: this.#dependencies.randomUUID(),
        };
      } else if (!retained.checkpoint?.checkpointId) {
        return {
          ok: false,
          error: {
            code: "checkpointNotFound",
            message: "Claude Code last-Turn rollback boundary is unavailable",
            retryable: false,
          },
        };
      } else {
        const forked = await forkClaudeSession({
          checkpoint: retained.checkpoint,
          cwd: path.resolve(input.cwd),
          dependencies: this.#dependencies,
          harnessId: this.harnessId,
          sourceRef: sourceRef.data,
        });
        if (!forked.ok) return forked;
        rollback = {
          openMode: "resume",
          sessionId: forked.value.sessionId,
        };
      }
    }
    let requestedThinkingOptionId = CLAUDE_DEFAULT_THINKING_OPTION_ID;
    if (input.kind === "create" && input.thinkingOptionId) {
      try {
        requestedThinkingOptionId = parseClaudeThinkingOptionId(input.thinkingOptionId);
      } catch {
        return {
          ok: false,
          error: {
            code: "invalidRequest",
            message: "Claude Code create Thinking option is invalid",
            retryable: false,
          },
        };
      }
    }
    if (input.kind === "create" && input.model) {
      try {
        decodeClaudeModelRef(input.model);
      } catch {
        return {
          ok: false,
          error: {
            code: "invalidRequest",
            message: "Claude Code create Model Ref is invalid",
            retryable: false,
          },
        };
      }
    }
    const requestedPermissionModeId =
      input.kind === "create"
        ? (input.permissionModeId ??
          (input.executionPolicy === "unattended-full-access"
            ? encodeClaudePermissionModeId("bypassPermissions")
            : CLAUDE_DEFAULT_PERMISSION_MODE_ID))
        : input.executionPolicy === "unattended-full-access"
          ? encodeClaudePermissionModeId("bypassPermissions")
          : CLAUDE_DEFAULT_PERMISSION_MODE_ID;
    try {
      decodeClaudePermissionModeId(requestedPermissionModeId);
    } catch {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "Claude Code create Permission Mode is invalid",
          retryable: false,
        },
      };
    }
    const permissionModeConflictsWithPolicy =
      (input.kind === "create" &&
        input.executionPolicy === "approval-required" &&
        requestedPermissionModeId !== CLAUDE_DEFAULT_PERMISSION_MODE_ID) ||
      (input.kind === "create" &&
        input.executionPolicy === "unattended-full-access" &&
        requestedPermissionModeId !== encodeClaudePermissionModeId("bypassPermissions"));
    if (permissionModeConflictsWithPolicy) {
      return {
        ok: false,
        error: {
          code: "unsupported",
          message: "Claude Code Permission Mode conflicts with the requested execution policy",
          retryable: false,
        },
      };
    }
    const cwd = path.resolve(input.cwd);
    const nativeRef =
      input.kind === "resume" ? nativeSessionRefSchema.safeParse(input.nativeRef) : null;
    if (nativeRef && (!nativeRef.success || nativeRef.data.harnessId !== this.harnessId)) {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "Claude Code Adapter cannot resume another Harness's Native Session",
          retryable: false,
        },
      };
    }
    const forked =
      input.kind === "fork"
        ? await forkClaudeSession({
            checkpoint: input.checkpoint,
            cwd,
            dependencies: this.#dependencies,
            harnessId: this.harnessId,
            sourceRef: input.sourceRef,
          })
        : null;
    if (forked && !forked.ok) return forked;
    const session: ClaudeHarnessSession = new ClaudeHarnessSession(
      cwd,
      this.#dependencies,
      this.#closeTimeoutMs,
      () => this.#sessions.delete(session),
      (planLimit) => this.#recordPlanLimit(session, planLimit),
      {
        ...(input.environment ? { environment: input.environment } : {}),
        openMode: rollback?.openMode ?? (input.kind === "create" ? "create" : "resume"),
        sessionId:
          rollback?.sessionId ??
          (forked?.ok
            ? forked.value.sessionId
            : nativeRef?.success
              ? nativeRef.data.nativeSessionId
              : this.#dependencies.randomUUID()),
        ...(input.kind === "create" && input.model ? { requestedModel: input.model } : {}),
        requestedPermissionModeId,
        requestedThinkingOptionId,
        toolOutputLimit: this.#toolOutputLimit,
        cancelTimeoutMs: this.#cancelTimeoutMs,
        continuationQuiescenceMs: this.#continuationQuiescenceMs,
      },
    );
    this.#sessions.add(session);
    return { ok: true, value: session };
  }

  /** Account-level plan windows are shared, but only stable native pushes may update them. */
  #recordPlanLimit(
    origin: ClaudeHarnessSession,
    planLimit: ClaudePlanLimitEvent,
  ): ClaudePlanLimitEvent | null {
    const next: ClaudePlanLimitEvent = { ...(this.#latestPlanLimit ?? {}) };
    if (planLimit.fiveHour) next.fiveHour = planLimit.fiveHour;
    if (planLimit.sevenDay) next.sevenDay = planLimit.sevenDay;
    this.#latestPlanLimit = next.fiveHour || next.sevenDay ? next : null;
    if (this.#latestPlanLimit) {
      for (const session of this.#sessions) {
        if (session !== origin) session.publishPlanLimit(this.#latestPlanLimit);
      }
    }
    return this.#latestPlanLimit;
  }

  credits(): AccountCreditsSnapshot | null {
    return projectClaudePlanLimitToCredits(this.#latestPlanLimit);
  }

  close(): Promise<void> {
    if (!this.#closePromise) {
      this.#inspectionCache.clear();
      this.#closePromise = Promise.all([
        ...[...this.#inspectors].map((inspector) => inspector.close()),
        ...[...this.#sessions].map((session) => session.close()),
        ...this.#inspectionInFlight.values(),
      ]).then(() => undefined);
    }
    return this.#closePromise;
  }
}
