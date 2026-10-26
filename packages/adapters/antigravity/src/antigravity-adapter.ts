import { spawn, type ChildProcessByStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import type { Readable, Writable } from "node:stream";

import {
  unsupportedSteer,
  HarnessOutputChannel,
  sanitizeDiagnosticTail,
  type HarnessAdapter,
  type HarnessError,
  type HarnessCommandAccepted,
  type HarnessCommandCapability,
  type HarnessCommandInvocation,
  type HarnessInspection,
  type HarnessModelCatalog,
  type HarnessModelRef,
  type HarnessOutput,
  type HarnessResult,
  type HarnessSession,
  type HarnessSessionCapabilities,
  type HarnessSessionState,
  type HarnessUsageStatisticsCapability,
  type InspectHarnessInput,
  type HostAgentMessageItem,
  type HostCommand,
  type HostEvent,
  type HostFileChange,
  type HostItem,
  type HostItemOutcome,
  type HostItemSnapshot,
  type HostSubagentState,
  type HostThreadSnapshot,
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
  type TurnSteerAccepted,
  type TurnSteerCommand,
  type TurnOutcome,
  type TurnStartAccepted,
  type TurnStartCommand,
} from "@codexhost/harness-adapter";
import { commandInvocation } from "@codexhost/harness-discovery";
import {
  harnessIdSchema,
  harnessModelRefSchema,
  harnessThinkingOptionIdSchema,
  hostItemIdSchema,
  nativeCheckpointRefSchema,
  nativeSessionRefSchema,
  nativeTurnRefSchema,
  type HarnessId,
  type HarnessAccountSnapshot,
  type HarnessPermissionModeId,
  type HarnessThinkingOptionId,
  type HostItemId,
  type NativeSessionRef,
  type NativeTurnRef,
} from "@codexhost/shared-contracts";

import { resolveAntigravityExecutable } from "./command.js";
import { forkAntigravitySession } from "./fork.js";
import { AntigravityHistory, antigravityHookDirectory } from "./history.js";
import {
  antigravityAvailableThinkingOptions,
  antigravityModelArguments,
  parseAntigravityModels,
} from "./model-catalog.js";
import {
  ANTIGRAVITY_PERMISSION_MODE_CATALOG,
  decodeAntigravityPermissionModeId,
  type AntigravityPermissionMode,
} from "./permission-modes.js";
import { rollbackAntigravityLastTurn } from "./rollback.js";
import { ANTIGRAVITY_COMMAND_CATALOG, parseAndFormatAntigravityCommand } from "./slash-commands.js";
import {
  codeActionFileChange,
  requestAntigravityTrajectorySteps,
  type AntigravityCodeAction,
} from "./code-action-diff.js";
import { fetchAntigravityQuota, type AntigravityQuotaSnapshot } from "./quota.js";
import { AntigravityQuestionBridge, type BridgeOptions } from "./question-bridge.js";
import { AntigravitySubagents } from "./subagents.js";
import { nativeSubagentIdSchema, readSubagentTranscript } from "./subagent-transcript.js";
import { createAntigravityUsageStatistics } from "./usage-statistics.js";
import {
  antigravityToolErrorMessage,
  isAntigravityPermissionDenial,
  isRecord,
  parseAntigravityStreamLine,
  type AntigravityResultEvent,
  type AntigravityStepUpdateEvent,
  type AntigravityStreamEvent,
  type AntigravityUsage,
} from "./stream-events.js";
import {
  completeAntigravityToolItem,
  isAntigravityFileMutatingTool,
  startAntigravityToolItem,
  toolTargetFile,
} from "./tool-projection.js";

export interface AntigravityAdapterOptions {
  command?: string;
  environment?: NodeJS.ProcessEnv;
  inspectTimeoutMs?: number;
  printTimeout?: string;
  toolOutputLimit?: number;
  subagentObservationTimeoutMs?: number;
  /**
   * How long a finished Turn's cleanup waits for its agy to report closing after signalling it.
   * A child that keeps agy's output open must not hold later Turns' cleanup or close().
   */
  turnCleanupWaitMs?: number;
}

interface ActiveTurn {
  command: TurnStartCommand;
  /** Model passed to this CLI invocation, independent of later selections. */
  model: HarnessModelRef | undefined;
  process: ChildProcessByStdio<Writable, Readable, Readable>;
  questions: AntigravityQuestionBridge;
  subagents: AntigravitySubagents;
  logPath: string;
  /** The native driver this Turn runs on; a successful Turn hands it to the next one. */
  transport: AntigravityTransport;
  /** Steps below this index belong to an earlier Turn on a reused driver. */
  firstStepIndex: number;
  agentItem: HostAgentMessageItem | null;
  agentText: string;
  tools: Map<number, HostItem>;
  completedItems: HostItemSnapshot[];
  stderr: string;
  cancellationRequested: boolean;
  receivedResult: boolean;
  /** agy's own effective permission mode, as reported by the `init` event. */
  nativePermissionMode: string | null;
  /** First tool denial of the Turn, kept to explain an otherwise empty result. */
  permissionDenial: string | null;
  latestUsage: HostUsage | null;
  contextUsagePromise: Promise<Pick<
    HostUsage,
    "contextUsedTokens" | "contextWindowTokens"
  > | null> | null;
  /**
   * Serializes stream handling: resolving a real edit diff needs an awaited
   * Language Server round trip, and Items must still reach the Host in the
   * order agy reported them.
   */
  queue: Promise<void>;
  /** Applied edits already claimed by a tool step, so a repeat edit of the
   * same file maps to the next recorded Code Action rather than the first. */
  codeActionCursor: number;
  fileChanges: Map<number, HostFileChange>;
  /** First sighting of a step whose Item was deferred: agy names the tool and
   * its parameters when the step opens, not when it ends. */
  pendingSteps: Map<number, AntigravityStepUpdateEvent["step_update"]>;
  httpsPort: number | null;
}

/**
 * One agy stream-json driver. A successful Turn keeps it (and its Question bridge)
 * alive for the next Turn of the same model/effort/permission selection, so
 * continued conversations skip CLI, Language Server, and customization startup.
 * Any other outcome disposes it.
 */
interface AntigravityTransport {
  process: ChildProcessByStdio<Writable, Readable, Readable>;
  exited: Promise<void>;
  questions: AntigravityQuestionBridge;
  logPath: string;
  /** Model, effort, and permission mode this process was started with. */
  key: string;
  nativePermissionMode: string | null;
  httpsPort: number | null;
  codeActionCursor: number;
  /** Highest `num_turns` whose result this process already reported. */
  lastResultTurn: number;
  /** Fingerprint of the last successful result, to ignore a replayed one. */
  lastResultJSON: string | null;
  /** Highest step index this process already reported. */
  lastStepIndex: number;
}

const antigravityHarnessId = harnessIdSchema.parse("antigravity");
const DEFAULT_INSPECT_TIMEOUT_MS = 20_000;
const DEFAULT_PRINT_TIMEOUT = "30m";
const DEFAULT_TOOL_OUTPUT_LIMIT = 64_000;
const DEFAULT_SUBAGENT_OBSERVATION_TIMEOUT_MS = 30_000;
/** How long a finished Turn's agy may take to exit after its stdin closes before it is signalled. */
const NATIVE_EXIT_GRACE_MS = 2_000;
const DEFAULT_TURN_CLEANUP_WAIT_MS = 5_000;
const CONTEXT_USAGE_TIMEOUT_MS = 8_000;
const CONTEXT_USAGE_RETRY_MS = 100;
const TRAJECTORY_TIMEOUT_MS = 2_000;
const GEMINI_CONTEXT_WINDOW_TOKENS = 1_048_576;
const CLAUDE_CONTEXT_WINDOW_TOKENS = 200_000;

/**
 * agy names a tool and its parameters when a step opens and repeats only what
 * changed when it ends, so a step whose Item was deferred has to carry that
 * opening detail forward.
 */
function mergePendingStep(
  pending: AntigravityStepUpdateEvent["step_update"] | undefined,
  step: AntigravityStepUpdateEvent["step_update"],
): AntigravityStepUpdateEvent["step_update"] {
  if (!pending) return step;
  const toolName = step.tool_name ?? pending.tool_name;
  const name = step.tool_info?.name ?? pending.tool_info?.name;
  const parameters = step.tool_info?.parameters ?? pending.tool_info?.parameters;
  const output = step.tool_info?.output ?? pending.tool_info?.output;
  const error = step.tool_info?.error ?? pending.tool_info?.error;
  return {
    ...pending,
    ...step,
    ...(toolName !== undefined ? { tool_name: toolName } : {}),
    ...(step.tool_info !== undefined || pending.tool_info !== undefined
      ? {
          tool_info: {
            ...(name !== undefined ? { name } : {}),
            ...(parameters !== undefined ? { parameters } : {}),
            ...(output !== undefined ? { output } : {}),
            ...(error !== undefined ? { error } : {}),
          },
        }
      : {}),
  };
}

/**
 * agy reports a tool target with the platform's own separators while its
 * trajectory reports a `file://` URI, so the two only compare after both are
 * resolved — case-insensitively where the filesystem is.
 */
function sameFile(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function resolveAntigravityContextWindow(modelId?: string, reportedWindow?: number): number {
  if (modelId && /^claude(?:[-_.]|$)/iu.test(modelId)) {
    return CLAUDE_CONTEXT_WINDOW_TOKENS;
  }
  if (!modelId || /^gemini(?:[-_.]|$)/iu.test(modelId)) {
    return GEMINI_CONTEXT_WINDOW_TOKENS;
  }
  return reportedWindow && reportedWindow > 0 ? reportedWindow : GEMINI_CONTEXT_WINDOW_TOKENS;
}

const CAPABILITIES: HarnessSessionCapabilities = {
  configuration: {
    selectModel: true,
    selectThinkingOption: true,
    selectPermissionMode: true,
    permissionModeScope: "live",
  },
  history: { fork: true, forkAcrossCwd: true, rollbackLastTurn: true },
  subagents: { observe: true, readTranscript: true },
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function invalidState(message: string): HarnessError {
  return { code: "invalidState", message, retryable: false };
}

/** Resolves once `promise` settles or `timeoutMs` passes, whichever comes first. */
function settledWithin(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    const settle = (): void => {
      clearTimeout(timer);
      resolve();
    };
    void promise.then(settle, settle);
  });
}

export const ANTIGRAVITY_WORKSPACE_FILE_INSTRUCTION =
  "[System Instruction: When creating new files in the workspace, you MUST use the write_to_file tool. When modifying existing files, use the replace_file_content tool. CRITICAL: NEVER include ArtifactMetadata when calling write_to_file for workspace files (ArtifactMetadata is strictly reserved for artifacts in the brain directory, and providing it for workspace files causes a path validation rejection). Do NOT use terminal commands (such as Set-Content, Out-File, echo, or cat) to create or write code files. For clarification, ask_question is connected to the codexhost Desktop through a Hook. Use single-choice or text questions. The Hook returns the actual user response in its reason while blocking the native auto-skip behavior; do not retry merely because the native tool reports it was blocked.]\n\n";

/**
 * agy also receives the Question Hook directory as a workspace (`--add-dir`), so the Turn prompt
 * names the project directory; otherwise a terminal command can run in the Hook directory.
 */
function antigravityWorkingDirectoryInstruction(cwd: string): string {
  return `[System Instruction: The project working directory is ${JSON.stringify(cwd)}. Run terminal commands and resolve relative file paths in this directory unless the task requires another one.]\n\n`;
}

export function formatAntigravityTurnPrompt(text: string, cwd?: string): string {
  if (text.startsWith("/") || text.includes("ArtifactMetadata")) {
    return text;
  }
  const workingDirectory = cwd ? antigravityWorkingDirectoryInstruction(cwd) : "";
  return `${ANTIGRAVITY_WORKSPACE_FILE_INSTRUCTION}${workingDirectory}${text}`;
}

/**
 * Headless agy answers a permission request by denying it, then reports the
 * Turn as successful with an empty response. Without this the user sees a Turn
 * that silently did nothing. The denial echoes the rejected command line, so it
 * is redacted before it leaves the Adapter.
 */
export function permissionDeniedTurnError(nativeMode: string | null, denial: string): HarnessError {
  const mode = nativeMode ? ` '${nativeMode}'` : "";
  return {
    code: "nativeFailure",
    message:
      `Antigravity denied a tool call under its${mode} permission mode and produced no response. ` +
      "codexhost uses native Skip permissions and does not enforce tool permissions. " +
      "Check Antigravity CLI diagnostics and native Hooks for the denial; Desktop approvals and Configured permissions are not supported.",
    retryable: false,
    diagnostic: sanitizeDiagnosticTail(denial),
  };
}

function safeToken(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function contextWindowMetadata(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const trajectory = isRecord(value.trajectory) ? value.trajectory : value;
  const generatorMetadata = trajectory.generatorMetadata;
  if (!Array.isArray(generatorMetadata)) return null;
  const first = generatorMetadata[0];
  if (!isRecord(first) || !isRecord(first.chatModel)) return null;
  const chatStartMetadata = first.chatModel.chatStartMetadata;
  if (!isRecord(chatStartMetadata) || !isRecord(chatStartMetadata.contextWindowMetadata)) {
    return null;
  }
  return chatStartMetadata.contextWindowMetadata;
}

/** Parses the real context counters exposed by agy's local Language Server. */
export function parseAntigravityContextUsage(
  value: unknown,
  modelId?: string,
): Pick<HostUsage, "contextUsedTokens" | "contextWindowTokens"> | null {
  const metadata = contextWindowMetadata(value);
  if (!metadata) return null;
  const breakdown = isRecord(metadata.tokenBreakdown) ? metadata.tokenBreakdown : null;
  const used = safeToken(
    metadata.estimatedTokensUsed ??
      metadata.estimated_tokens_used ??
      breakdown?.totalTokens ??
      breakdown?.total_tokens,
  );
  const window = safeToken(metadata.maxContextTokens ?? metadata.max_context_tokens);
  if (used === undefined) return null;
  const contextWindowTokens = resolveAntigravityContextWindow(modelId, window);
  return { contextUsedTokens: used, contextWindowTokens };
}

function requestAntigravityContextUsage(
  port: number,
  conversationId: string,
  timeoutMs: number,
  modelId?: string,
): Promise<Pick<HostUsage, "contextUsedTokens" | "contextWindowTokens"> | null> {
  return new Promise((resolve) => {
    const request = https.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/exa.language_server_pb.LanguageServerService/GetCascadeTrajectoryGeneratorMetadata",
        method: "POST",
        rejectUnauthorized: false,
        timeout: timeoutMs,
        headers: { "content-type": "application/json" },
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () => {
          if (response.statusCode !== 200) return resolve(null);
          try {
            resolve(parseAntigravityContextUsage(JSON.parse(body), modelId));
          } catch {
            resolve(null);
          }
        });
      },
    );
    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve(null));
    request.end(
      JSON.stringify({
        cascadeId: conversationId,
        generatorMetadataOffset: 0,
        includeMessages: false,
      }),
    );
  });
}

async function antigravityHttpsPort(logPath: string): Promise<number | null> {
  try {
    const log = await readFile(logPath, "utf8");
    const match = log.match(
      /Language server listening on random port at (\d+) for HTTPS \(gRPC\)/iu,
    );
    const port = match ? Number(match[1]) : Number.NaN;
    return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null;
  } catch {
    return null;
  }
}

async function pollAntigravityContextUsage(
  logPath: string,
  conversationId: string,
  modelId?: string,
  isDone?: () => boolean,
): Promise<Pick<HostUsage, "contextUsedTokens" | "contextWindowTokens"> | null> {
  const deadline = Date.now() + CONTEXT_USAGE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const port = await antigravityHttpsPort(logPath);
    if (port !== null) {
      const usage = await requestAntigravityContextUsage(
        port,
        conversationId,
        CONTEXT_USAGE_RETRY_MS,
        modelId,
      );
      if (usage) return usage;
    }
    if (isDone?.()) break;
    await new Promise<void>((resolve) => setTimeout(resolve, CONTEXT_USAGE_RETRY_MS));
  }
  return null;
}

/**
 * Host usage from one agy usage object. A step's usage describes one model request, whose prompt
 * estimates the context in use; agy reports that prompt as `input_tokens` plus the separate
 * `cache_read_tokens`. A result's usage sums every request of the native Conversation, so it
 * carries context only when agy names it.
 */
function hostUsage(
  value: AntigravityUsage | undefined,
  modelId: string | undefined,
  scope: "request" | "conversation",
): HostUsage | null {
  if (!value) return null;
  const inputTokens = safeToken(value.input_tokens);
  const outputTokens = safeToken(value.output_tokens);
  const reasoningOutputTokens = safeToken(value.thinking_tokens);
  const totalTokens = safeToken(value.total_tokens);
  const requestPromptTokens =
    scope === "request" && inputTokens !== undefined
      ? inputTokens + (safeToken(value.cache_read_tokens) ?? 0)
      : undefined;
  const contextUsedTokens =
    safeToken(value.context_used_tokens ?? value.estimated_tokens_used) ?? requestPromptTokens;
  const rawWindow = safeToken(value.context_window_tokens ?? value.max_context_tokens);
  const contextWindowTokens =
    contextUsedTokens !== undefined || rawWindow !== undefined
      ? resolveAntigravityContextWindow(modelId, rawWindow)
      : undefined;
  const usage: HostUsage = {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(contextUsedTokens !== undefined &&
    contextWindowTokens !== undefined &&
    contextWindowTokens > 0
      ? { contextUsedTokens, contextWindowTokens }
      : {}),
  };
  return Object.keys(usage).length > 0 ? usage : null;
}

function normalizedProcessError(
  detail: string,
  fallback: string,
  exposeDetail = false,
): HarnessError {
  const nativeDetail = detail.trim();
  // stderr can echo the invoked command line, so retain its existing redacted
  // diagnostic tail. A structured result.error is shown verbatim below.
  const diagnostic = sanitizeDiagnosticTail(nativeDetail);
  if (/sign[ -]?in|authenticat|credential|login/iu.test(nativeDetail)) {
    return {
      code: "authenticationRequired",
      message: exposeDetail ? nativeDetail || fallback : diagnostic || fallback,
      retryable: false,
    };
  }
  return {
    code: "nativeFailure",
    message: exposeDetail && nativeDetail ? `${fallback}: ${nativeDetail}` : fallback,
    // These native rejections need a changed precondition or a quota reset;
    // immediately replaying a Turn (and its tools) cannot resolve them.
    retryable: !/User location is not supported for the API use|Individual quota reached/iu.test(
      nativeDetail,
    ),
    ...(diagnostic ? { stderrTail: diagnostic.slice(-4_000) } : {}),
  };
}

async function runBuffered(
  executable: string,
  arguments_: string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
  const invocation = commandInvocation(executable, arguments_, environment);
  return await new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.arguments, {
      cwd,
      env: environment,
      ...(signal ? { signal, killSignal: "SIGKILL" as const } : {}),
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Antigravity CLI timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr.trim() || `Antigravity CLI exited with code ${String(code)}`));
    });
  });
}

class AntigravitySession implements HarnessSession {
  readonly harnessId: HarnessId = antigravityHarnessId;
  readonly capabilities = CAPABILITIES;
  readonly commands: HarnessCommandCapability;
  readonly initialUsage: HostUsage | null = null;
  readonly outputs: AsyncIterable<HarnessOutput>;
  readonly #channel = new HarnessOutputChannel<HarnessOutput>();
  readonly #cwd: string;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #executable: string;
  readonly #onClosed: () => void;
  readonly #printTimeout: string;
  readonly #toolOutputLimit: number;
  readonly #subagentObservationTimeoutMs: number;
  readonly #turnCleanupWaitMs: number;
  readonly #history: AntigravityHistory;
  readonly #subagentObservers = new Set<AntigravitySubagents>();
  #active: ActiveTurn | null = null;
  /** Set from the moment a turn.start is accepted until it finishes starting. */
  #starting = false;
  /** The driver a successful Turn kept for this Session's next Turn. */
  #transport: AntigravityTransport | null = null;
  #preparingQuestions: Promise<AntigravityQuestionBridge> | null = null;
  #questionCleanup: Promise<void> = Promise.resolve();
  #closed = false;
  #model: HarnessModelRef | undefined;
  #nativeRef: NativeSessionRef | undefined;
  /** The last result's `response`: agy carries earlier Turns' replies in it. */
  #lastResultResponse = "";
  #permissionMode: AntigravityPermissionMode;
  #thinkingOptionId: HarnessThinkingOptionId | undefined;
  readonly #catalog: HarnessModelCatalog | undefined;

  constructor(input: {
    catalog?: HarnessModelCatalog;
    cwd: string;
    environment: NodeJS.ProcessEnv;
    executable: string;
    model?: HarnessModelRef;
    nativeRef?: NativeSessionRef;
    history: AntigravityHistory;
    permissionMode: AntigravityPermissionMode;
    printTimeout: string;
    thinkingOptionId?: HarnessThinkingOptionId;
    toolOutputLimit: number;
    subagentObservationTimeoutMs: number;
    turnCleanupWaitMs: number;
    onClosed(): void;
  }) {
    this.#catalog = input.catalog;
    this.#cwd = input.cwd;
    this.#environment = input.environment;
    this.#executable = input.executable;
    this.#history = input.history;
    this.#model = input.model ?? input.history.model;
    this.#nativeRef = input.nativeRef;
    this.#permissionMode = input.permissionMode;
    this.#printTimeout = input.printTimeout;
    this.#thinkingOptionId = input.thinkingOptionId ?? input.history.thinkingOptionId;
    this.#toolOutputLimit = input.toolOutputLimit;
    this.#subagentObservationTimeoutMs = input.subagentObservationTimeoutMs;
    this.#turnCleanupWaitMs = input.turnCleanupWaitMs;
    this.#onClosed = input.onClosed;
    this.initialState = this.#state();
    this.outputs = this.#channel.outputs;
    this.commands = {
      list: async () => ({ ok: true, value: ANTIGRAVITY_COMMAND_CATALOG }),
      execute: (command) => this.#executeHarnessCommand(command),
    };
  }

  get nativeRef(): NativeSessionRef | undefined {
    return this.#nativeRef;
  }

  get model(): HarnessModelRef | undefined {
    return this.#model;
  }

  get thinkingOptionId(): HarnessThinkingOptionId | undefined {
    return this.#thinkingOptionId;
  }

  get permissionMode(): AntigravityPermissionMode {
    return this.#permissionMode;
  }

  get history(): AntigravityHistory {
    return this.#history;
  }

  get isActive(): boolean {
    return (
      this.#active !== null ||
      this.#starting ||
      this.#preparingQuestions !== null ||
      [...this.#subagentObservers].some((observer) => observer.running)
    );
  }

  subagentState(id: string): HostSubagentState | undefined {
    for (const observer of [...this.#subagentObservers].reverse()) {
      const state = observer.state(id);
      if (state) return state;
    }
    return historySubagentState(this.#history, id);
  }

  readonly initialState: HarnessSessionState;

  async readSnapshot(): Promise<HarnessResult<HostThreadSnapshot>> {
    if (this.#closed) return { ok: false, error: invalidState("Antigravity Session is closed") };
    return { ok: true, value: { turns: this.#history.snapshot(), state: this.#state() } };
  }

  execute(command: TurnStartCommand): Promise<HarnessResult<TurnStartAccepted>>;
  execute(command: TurnSteerCommand): Promise<HarnessResult<TurnSteerAccepted>>;
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
      | TurnSteerAccepted
      | TurnCancelAccepted
      | InteractionRespondAccepted
      | ModelSelectCompleted
      | ThinkingSelectCompleted
      | PermissionModeSelectCompleted
    >
  > {
    if (this.#closed) return { ok: false, error: invalidState("Antigravity Session is closed") };
    if (command.type === "turn.cancel") return this.#cancel(command);
    // Headless stream-json runs each stdin message as its own Turn; steering exists only in the TUI.
    if (command.type === "turn.steer") return unsupportedSteer("Antigravity");
    if (command.type === "model.select") return this.#selectModel(command);
    if (command.type === "permissionMode.select") return this.#selectPermissionMode(command);
    if (command.type === "thinking.select") return this.#selectThinking(command);
    if (command.type === "interaction.respond") {
      return (
        this.#active?.questions.respond(command) ?? {
          ok: false,
          error: invalidState("Antigravity Question is not active"),
        }
      );
    }
    if (this.isActive) {
      return {
        ok: false,
        error: {
          code: "sessionBusy",
          message: "Antigravity Turn is already running",
          retryable: true,
        },
      };
    }
    const text = command.input
      .map(({ text: part }) => part)
      .join("\n")
      .trim();
    if (!text) {
      return {
        ok: false,
        error: { code: "invalidRequest", message: "Antigravity Turn is empty", retryable: false },
      };
    }

    // Claim the Session synchronously, before any await, so two concurrent starts cannot
    // both pass the busy check and overwrite #active. Every exit path releases the claim.
    this.#starting = true;
    try {
      return await this.#startTurn(command, text);
    } finally {
      this.#starting = false;
    }
  }

  async #startTurn(
    command: TurnStartCommand,
    text: string,
  ): Promise<HarnessResult<TurnStartAccepted>> {
    let questions: AntigravityQuestionBridge;
    const hookDirectory = antigravityHookDirectory(this.#environment);
    const transportKey = JSON.stringify([
      this.#model?.id ?? null,
      this.#thinkingOptionId ?? null,
      this.#permissionMode,
    ]);
    await this.#questionCleanup.catch(() => undefined);
    if (this.#closed) {
      return { ok: false, error: invalidState("Antigravity Session is closed") };
    }
    let reusable = this.#transport;
    if (
      reusable &&
      (reusable.key !== transportKey ||
        reusable.process.exitCode !== null ||
        reusable.process.signalCode !== null ||
        !reusable.process.stdin.writable)
    ) {
      await this.#disposeTransport(reusable);
      reusable = null;
    }
    const questionOptions: BridgeOptions = {
      ...(hookDirectory ? { directory: hookDirectory } : {}),
      turnId: command.turnId,
      nativeSessionId: () =>
        this.#active?.command === command && !this.#active.cancellationRequested
          ? this.#nativeRef?.nativeSessionId
          : undefined,
      schedule: (action) => {
        if (this.#active?.command === command) this.#enqueue(this.#active, action);
        else action();
      },
      emit: (output) => {
        const active = this.#active;
        if (!active || active.command !== command) return;
        if (output.kind === "event" && output.event.type === "item.started" && active.agentItem) {
          this.#completeItem(active, active.agentItem, { status: "succeeded" });
          active.agentItem = null;
          active.agentText = "";
        }
        if (output.kind === "event" && output.event.type === "item.completed") {
          active.completedItems.push(output.event.snapshot);
        }
        this.#channel.emit(output);
      },
    };
    this.#preparingQuestions = reusable
      ? Promise.resolve(reusable.questions.rebind(questionOptions))
      : AntigravityQuestionBridge.create(questionOptions);
    try {
      questions = await this.#preparingQuestions;
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "nativeFailure",
          message: `Question bridge setup failed: ${errorMessage(error)}`,
          retryable: true,
        },
      };
    } finally {
      this.#preparingQuestions = null;
    }
    if (this.#closed) {
      await this.#disposeTransport(reusable);
      if (!reusable) await questions.dispose();
      return { ok: false, error: invalidState("Antigravity Session is closed") };
    }
    const environment = { ...this.#environment, ...questions.environment };
    const logPath =
      reusable?.logPath ?? path.join(os.tmpdir(), `codexhost-antigravity-${randomUUID()}.log`);
    const arguments_ = [
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--print-timeout",
      this.#printTimeout,
    ];
    if (this.#nativeRef) arguments_.unshift("--conversation", this.#nativeRef.nativeSessionId);
    arguments_.push(...antigravityModelArguments(this.#model, this.#thinkingOptionId));
    arguments_.push("--dangerously-skip-permissions");
    arguments_.push("--add-dir", this.#cwd);
    arguments_.push("--add-dir", questions.directory);
    arguments_.push("--log-file", logPath);
    const invocation = commandInvocation(this.#executable, arguments_, environment);
    let child: ChildProcessByStdio<Writable, Readable, Readable>;
    try {
      child =
        reusable?.process ??
        spawn(invocation.command, invocation.arguments, {
          cwd: this.#cwd,
          env: environment,
          windowsHide: true,
          windowsVerbatimArguments: invocation.windowsVerbatimArguments,
          stdio: ["pipe", "pipe", "pipe"],
        });
    } catch (error) {
      await questions.dispose();
      return {
        ok: false,
        error: { code: "nativeFailure", message: errorMessage(error), retryable: true },
      };
    }
    const transport: AntigravityTransport = reusable ?? {
      process: child,
      exited: new Promise<void>((resolve) => child.once("close", () => resolve())),
      questions,
      logPath,
      key: transportKey,
      nativePermissionMode: null,
      httpsPort: null,
      codeActionCursor: 0,
      lastResultTurn: -1,
      lastResultJSON: null,
      lastStepIndex: -1,
    };
    const active: ActiveTurn = {
      command,
      model: this.#model,
      process: child,
      questions,
      subagents: new AntigravitySubagents({
        turnId: command.turnId,
        parentId: () => this.#nativeRef?.nativeSessionId,
        port: () => this.#languageServerPort(active),
        cwd: this.#cwd,
        outputLimit: this.#toolOutputLimit,
        observationTimeoutMs: this.#subagentObservationTimeoutMs,
        initialStates: this.#history
          .snapshot()
          .flatMap((turn) =>
            turn.items.flatMap(({ item }) =>
              item.type === "subagentDelegation" ? item.subagents : [],
            ),
          ),
        emit: (event) => {
          if (event.type === "subagent.state.changed") {
            const state = active.subagents.state(event.nativeSubagentId);
            if (state) this.#history.updateSubagent(state);
          }
          this.#event(event);
        },
        complete: (snapshot) => active.completedItems.push(snapshot),
        schedule: (work) => this.#enqueue(active, work),
      }),
      logPath,
      transport,
      firstStepIndex: reusable ? reusable.lastStepIndex + 1 : 0,
      agentItem: null,
      agentText: "",
      tools: new Map(),
      completedItems: [],
      stderr: "",
      cancellationRequested: false,
      receivedResult: false,
      nativePermissionMode: null,
      permissionDenial: null,
      latestUsage: null,
      contextUsagePromise: null,
      queue: Promise.resolve(),
      codeActionCursor: reusable?.codeActionCursor ?? 0,
      fileChanges: new Map(),
      pendingSteps: new Map(),
      httpsPort: null,
    };
    this.#active = active;
    this.#transport = transport;
    this.#subagentObservers.add(active.subagents);
    // A reused process already has its stream listeners and its stdin error handler;
    // attaching a second set would deliver every event twice.
    if (!reusable) {
      child.stdin.on("error", () => undefined);
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        const turn = this.#active;
        if (turn?.process === child) turn.stderr = (turn.stderr + chunk).slice(-8_000);
      });
      const lines = readline.createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        const turn = this.#active;
        if (!turn || turn.process !== child) return;
        const event = parseAntigravityStreamLine(line);
        if (!event) {
          if (line.trim()) turn.stderr = (turn.stderr + `\n${line}`).slice(-8_000);
          return;
        }
        // agy replays the previous Turn's result and old steps when it starts the next
        // stdin message, so only genuinely new Turn output reaches the Host. A replay is
        // filtered whatever its status: a native ERROR that the Host accepted as a
        // success (a replied Turn repeating an earlier Conversation error) still keeps
        // this driver, so its replay would otherwise fail the next Turn before its own
        // result arrived.
        if (event.event === "result" && Number.isInteger(event.result.num_turns)) {
          const fingerprint = JSON.stringify(event.result);
          if (
            event.result.num_turns <= transport.lastResultTurn &&
            fingerprint === transport.lastResultJSON
          ) {
            return;
          }
          transport.lastResultTurn = Math.max(transport.lastResultTurn, event.result.num_turns);
          transport.lastResultJSON = fingerprint;
        }
        if (event.event === "step_update") {
          const index = event.step_update.step_index;
          if (Number.isInteger(index)) {
            if (index < turn.firstStepIndex) return;
            transport.lastStepIndex = Math.max(transport.lastStepIndex, index);
          }
        }
        this.#enqueue(turn, () => this.#handleEvent(turn, event));
      });
      child.once("error", (error) => {
        const turn = this.#active;
        if (turn?.process !== child) return;
        this.#enqueue(turn, () => {
          if (this.#active !== turn) return;
          this.#completeTurn(turn, {
            status: "failed",
            error: { code: "nativeFailure", message: error.message, retryable: true },
          });
        });
      });
      child.once("close", (code) => {
        if (this.#transport === transport) this.#transport = null;
        const turn = this.#active;
        if (!turn || turn.process !== child) {
          // An idle driver exited between Turns. Nothing else will release its bridge and
          // log, so do it here rather than leaking an HTTP server and a temp file.
          void this.#disposeTransport(transport);
          return;
        }
        this.#enqueue(turn, () => {
          if (turn.subagents.running) void turn.subagents.cancel();
          else turn.subagents.stop();
          if (this.#active !== turn || turn.receivedResult) return;
          if (turn.cancellationRequested) {
            this.#completeTurn(turn, { status: "cancelled", reason: "Cancelled by user" });
          } else {
            this.#completeTurn(turn, {
              status: "failed",
              error: normalizedProcessError(
                turn.stderr,
                `Antigravity CLI exited before a result event (code ${String(code)})`,
              ),
            });
          }
        });
      });
    }
    try {
      const turnPrompt = formatAntigravityTurnPrompt(text, this.#cwd);
      if (child.stdin.writable) {
        child.stdin.write(
          `${JSON.stringify({ event: "user", message: { content: turnPrompt } })}\n`,
          () => undefined,
        );
      }
    } catch (error) {
      child.kill();
      this.#completeTurn(active, {
        status: "failed",
        error: { code: "nativeFailure", message: errorMessage(error), retryable: true },
      });
      return {
        ok: false,
        error: { code: "nativeFailure", message: errorMessage(error), retryable: true },
      };
    }
    this.#event({ type: "turn.started", turnId: command.turnId });
    return { ok: true, value: { turnId: command.turnId } };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const preparing = await this.#preparingQuestions?.catch(() => undefined);
    await preparing?.dispose();
    if (this.#active) {
      const active = this.#active;
      active.cancellationRequested = true;
      await active.subagents.cancel();
      active.process.kill();
      this.#completeTurn(active, { status: "cancelled", reason: "Session closed" });
    } else if (this.#transport) {
      // A retained driver from a successful Turn belongs to the Session; close releases it.
      await this.#disposeTransport(this.#transport);
    }
    await Promise.all([...this.#subagentObservers].map((observer) => observer.cancel()));
    await this.#questionCleanup;
    await this.#history.flush().catch(() => undefined);
    this.#channel.end();
    this.#onClosed();
  }

  /**
   * Runs stream work one item at a time. Resolving a real edit patch needs an
   * awaited Language Server call, and Codex Desktop renders Items in arrival
   * order, so nothing may overtake a step that is still resolving.
   */
  #enqueue(active: ActiveTurn, work: () => Promise<void> | void): void {
    active.queue = active.queue.then(work).catch((error: unknown) => {
      if (this.#active !== active) return;
      this.#completeTurn(active, {
        status: "failed",
        error: { code: "nativeFailure", message: errorMessage(error), retryable: true },
      });
    });
  }

  async #handleEvent(active: ActiveTurn, event: AntigravityStreamEvent): Promise<void> {
    if (this.#active !== active) return;
    if (event.event === "init") {
      active.nativePermissionMode = event.init?.permission_mode ?? null;
      if (this.#nativeRef && this.#nativeRef.nativeSessionId !== event.conversation_id) {
        this.#completeTurn(active, {
          status: "failed",
          error: {
            code: "sessionNotFound",
            message: "Antigravity resumed a different Conversation",
            retryable: false,
          },
        });
        active.process.kill();
        return;
      }
      this.#nativeRef = nativeSessionRefSchema.parse({
        harnessId: this.harnessId,
        nativeSessionId: event.conversation_id,
        formatVersion: 1,
      });
      this.#history.bindNativeSession(event.conversation_id);
      this.#event({ type: "session.state.changed", state: this.#state() });
      this.#ensureContextUsage(active, event.conversation_id);
      return;
    }
    if (event.event === "step_update") {
      if (event.step_update.conversation_id !== this.#nativeRef?.nativeSessionId) return;
      await this.#handleStep(active, event.step_update);
      const usage = hostUsage(event.step_update.usage, active.model?.id, "request");
      if (usage) this.#publishUsage(active, usage);
      this.#ensureContextUsage(active, event.step_update.conversation_id);
      return;
    }
    if (event.event !== "result") return;
    active.receivedResult = true;
    await this.#handleResult(active, event);
  }

  async #handleResult(active: ActiveTurn, event: AntigravityResultEvent): Promise<void> {
    if (this.#active !== active) return;
    const resultConversationId = event.result.conversation_id.trim();
    if (
      resultConversationId &&
      this.#nativeRef &&
      resultConversationId !== this.#nativeRef.nativeSessionId
    ) {
      this.#completeTurn(active, {
        status: "failed",
        error: {
          code: "protocolError",
          message: "Antigravity returned a result for a different Conversation",
          retryable: false,
        },
      });
      return;
    }
    const usage = hostUsage(event.result.usage, active.model?.id, "conversation");
    if (usage) this.#publishUsage(active, usage);
    this.#ensureContextUsage(active, event.result.conversation_id);
    if (active.contextUsagePromise) {
      const contextUsage = await active.contextUsagePromise;
      if (contextUsage) this.#publishUsage(active, contextUsage);
    }
    await active.subagents.refresh();
    if (this.#active !== active) return;
    const convId = resultConversationId || this.#nativeRef?.nativeSessionId || "";

    if (!this.#nativeRef && convId) {
      this.#nativeRef = nativeSessionRefSchema.parse({
        harnessId: this.harnessId,
        nativeSessionId: convId,
        formatVersion: 1,
      });
      this.#history.bindNativeSession(convId);
      this.#event({ type: "session.state.changed", state: this.#state() });
    }
    const response = event.result.response ?? "";
    // agy's result.response also carries earlier Turns' replies, so only the
    // text after the previous result's response is this Turn's own reply.
    const turnReply = response.startsWith(this.#lastResultResponse)
      ? response.slice(this.#lastResultResponse.length)
      : response;
    const repliedThisTurn = Boolean(active.agentItem) || turnReply.trim() !== "";
    if (response) this.#lastResultResponse = response;
    if (turnReply.trim() !== "") this.#appendOrSyncAgentText(active, turnReply, false);
    const safeTurnId =
      event.result.num_turns !== undefined && event.result.num_turns !== null
        ? `turn:${event.result.num_turns}`
        : `turn:${this.#history.snapshot().length + 1}`;
    const safeSessionId = convId || this.#nativeRef?.nativeSessionId || "unknown-session";

    const nativeTurnRef = nativeTurnRefSchema.parse({
      harnessId: this.harnessId,
      nativeSessionId: safeSessionId,
      nativeTurnKey: safeTurnId,
      formatVersion: 1,
    });
    const checkpoint = nativeCheckpointRefSchema.parse({
      harnessId: this.harnessId,
      nativeSessionId: safeSessionId,
      checkpointId: safeTurnId,
      formatVersion: 1,
    });
    if (active.cancellationRequested) {
      this.#completeTurn(
        active,
        { status: "cancelled", reason: "Cancelled by user", checkpoint },
        nativeTurnRef,
      );
    } else if (event.result.status === "SUCCESS") {
      if (active.permissionDenial !== null && !active.agentItem) {
        this.#completeTurn(
          active,
          {
            status: "failed",
            error: permissionDeniedTurnError(active.nativePermissionMode, active.permissionDenial),
            checkpoint,
          },
          nativeTurnRef,
        );
      } else {
        this.#completeTurn(active, { status: "succeeded", checkpoint }, nativeTurnRef);
      }
    } else {
      const nativeError = event.result.error?.trim();
      const errorDetail = nativeError || active.stderr;
      const error = normalizedProcessError(
        errorDetail,
        `Antigravity Turn ended with status ${event.result.status}`,
        nativeError !== undefined,
      );
      if (repliedThisTurn && nativeError && this.#reportedEarlier(error)) {
        // agy keeps a Conversation's first failure and repeats it in the result
        // of every later Turn, even when that Turn answered without error. A
        // Turn that replied and only repeats an error an earlier Turn of this
        // Conversation already reported did not fail.
        this.#completeTurn(active, { status: "succeeded", checkpoint }, nativeTurnRef);
      } else {
        this.#completeTurn(active, { status: "failed", error, checkpoint }, nativeTurnRef);
      }
    }
  }

  #reportedEarlier(error: HarnessError): boolean {
    return this.#history
      .snapshot()
      .some(
        ({ outcome }) =>
          outcome.status === "failed" &&
          outcome.error.code === error.code &&
          outcome.error.message === error.message,
      );
  }

  #publishUsage(active: ActiveTurn, usage: HostUsage): void {
    active.latestUsage = { ...(active.latestUsage ?? {}), ...usage };
    this.#event({
      type: "session.usage.changed",
      usage: active.latestUsage,
      observedForTurnId: active.command.turnId,
    });
  }

  #ensureContextUsage(active: ActiveTurn, conversationId: string): void {
    if (active.contextUsagePromise) return;
    active.contextUsagePromise = pollAntigravityContextUsage(
      active.logPath,
      conversationId,
      active.model?.id,
      () =>
        active.receivedResult || active.cancellationRequested || active.process.exitCode !== null,
    );
  }

  async #handleStep(
    active: ActiveTurn,
    step: AntigravityStepUpdateEvent["step_update"],
  ): Promise<void> {
    if (step.step_type === "subagent") {
      if (active.agentItem) {
        this.#completeItem(active, active.agentItem, { status: "succeeded" });
        active.agentItem = null;
        active.agentText = "";
      }
      if (active.subagents.handle(step)) return;
      step = { ...step, step_type: "tool" };
    }
    if (step.step_type === "agent_response") {
      if (typeof step.text_delta === "string" && step.text_delta.length > 0) {
        this.#appendOrSyncAgentText(active, step.text_delta, true);
        return;
      }
      const fullOrDelta =
        step.text ??
        (typeof step.content === "string" ? step.content : undefined) ??
        (typeof step.message === "string" ? step.message : undefined);
      if (typeof fullOrDelta === "string" && fullOrDelta.length > 0) {
        this.#appendOrSyncAgentText(active, fullOrDelta, false);
        return;
      }
      return;
    }
    if (step.step_type !== "tool") return;
    if (active.agentItem) {
      this.#completeItem(active, active.agentItem, { status: "succeeded" });
      active.agentItem = null;
      active.agentText = "";
    }
    const merged = mergePendingStep(active.pendingSteps.get(step.step_index), step);
    let item = active.tools.get(step.step_index);
    if (!item) {
      const started = await this.#startToolItem(active, merged);
      if (!started) {
        active.pendingSteps.set(step.step_index, merged);
        return;
      }
      active.pendingSteps.delete(step.step_index);
      item = started;
      active.tools.set(step.step_index, item);
      this.#event({ type: "item.started", turnId: active.command.turnId, item });
    }
    if (merged.state !== "DONE" && merged.state !== "ERROR") return;
    const toolError = antigravityToolErrorMessage(merged.tool_info?.error);
    if (toolError !== null && active.permissionDenial === null) {
      if (isAntigravityPermissionDenial(toolError)) active.permissionDenial = toolError;
    }
    const completed = completeAntigravityToolItem(item, merged, this.#toolOutputLimit, this.#cwd);
    active.tools.delete(step.step_index);
    const toolName =
      merged.tool_name ??
      merged.tool_info?.name ??
      (item.type === "toolExecution" ? item.toolName : item.type);
    const itemOutcome: HostItemOutcome =
      merged.state === "ERROR"
        ? {
            status: "failed",
            error: {
              code: "nativeFailure",
              message: toolError
                ? `Antigravity tool '${toolName}' failed: ${toolError}`
                : `Antigravity tool '${toolName}' failed`,
              retryable: false,
            },
          }
        : { status: "succeeded" };
    this.#completeItem(active, completed, itemOutcome);
  }

  /**
   * A file-mutating step only becomes a File Change Item once its patch is
   * known. agy publishes the step before the Language Server has recorded the
   * applied edit, so an unresolved step stays uncarded until its terminal
   * update rather than showing an empty patch.
   */
  async #startToolItem(
    active: ActiveTurn,
    step: AntigravityStepUpdateEvent["step_update"],
  ): Promise<HostItem | null> {
    const toolName = step.tool_name ?? step.tool_info?.name ?? "antigravity.tool";
    if (isAntigravityFileMutatingTool(toolName)) {
      const change = await this.#claimFileChange(active, step, toolName);
      if (change) {
        return { type: "fileChange", itemId: this.#newItemId(), changes: [change] };
      }
      if (step.state !== "DONE" && step.state !== "ERROR") return null;
    }
    return startAntigravityToolItem(this.#newItemId(), step, this.#cwd);
  }

  async #claimFileChange(
    active: ActiveTurn,
    step: AntigravityStepUpdateEvent["step_update"],
    toolName: string,
  ): Promise<HostFileChange | null> {
    const claimed = active.fileChanges.get(step.step_index);
    if (claimed) return claimed;
    const target = toolTargetFile(toolName, step.tool_info?.parameters);
    if (!target) return null;
    const port = await this.#languageServerPort(active);
    if (port === null) return null;
    const actions = await requestAntigravityTrajectorySteps(
      port,
      step.conversation_id,
      TRAJECTORY_TIMEOUT_MS,
    );
    const index = actions.findIndex(
      (action, at) => at >= active.codeActionCursor && sameFile(action.absolutePath, target),
    );
    const action: AntigravityCodeAction | undefined = index === -1 ? undefined : actions[index];
    if (!action) return null;
    const change = codeActionFileChange(action, this.#cwd);
    if (!change) return null;
    active.codeActionCursor = index + 1;
    active.fileChanges.set(step.step_index, change);
    return change;
  }

  async #languageServerPort(active: ActiveTurn): Promise<number | null> {
    if (active.httpsPort !== null) return active.httpsPort;
    const port = await antigravityHttpsPort(active.logPath);
    if (port !== null) active.httpsPort = port;
    return port;
  }

  #appendOrSyncAgentText(active: ActiveTurn, text: string, isExplicitDelta: boolean): void {
    if (!text) return;
    if (isExplicitDelta || !active.agentItem) {
      this.#appendAgentText(active, text);
      return;
    }
    if (
      text === active.agentText ||
      active.agentText.startsWith(text) ||
      active.agentText.trim() === text.trim() ||
      active.agentText.endsWith(text) ||
      active.agentText.includes(text.trim())
    ) {
      return;
    }
    if (text.startsWith(active.agentText)) {
      const delta = text.slice(active.agentText.length);
      if (delta.length > 0) this.#appendAgentText(active, delta);
      return;
    }
    this.#appendAgentText(active, text);
  }

  #appendAgentText(active: ActiveTurn, text: string): void {
    if (!active.agentItem) {
      active.agentItem = { type: "agentMessage", itemId: this.#newItemId(), text };
      active.agentText = text;
      this.#event({ type: "item.started", turnId: active.command.turnId, item: active.agentItem });
      return;
    }
    active.agentText += text;
    active.agentItem = { ...active.agentItem, text: active.agentText };
    this.#event({
      type: "item.updated",
      turnId: active.command.turnId,
      itemId: active.agentItem.itemId,
      update: { type: "text.append", text },
    });
  }

  #completeTurn(active: ActiveTurn, outcome: TurnOutcome, nativeTurnRef?: NativeTurnRef): void {
    if (this.#active !== active) return;
    active.questions.stop();
    const transport = active.transport;
    // A successful Turn keeps its driver for the next Turn of this Session; the bridge is
    // rebound there. Anything else (failure, cancellation, close) releases the driver.
    const keepTransport =
      outcome.status === "succeeded" &&
      !this.#closed &&
      this.#transport === transport &&
      active.process.exitCode === null &&
      active.process.signalCode === null &&
      active.process.stdin.writable;
    if (keepTransport) {
      transport.httpsPort = active.httpsPort ?? transport.httpsPort;
      transport.codeActionCursor = active.codeActionCursor;
      transport.nativePermissionMode = active.nativePermissionMode;
    }
    this.#questionCleanup = this.#questionCleanup
      .then(async () => {
        // Cancel first: a failed Turn's Subagents may stay observable as running, and
        // `settled` would then never resolve, stranding the driver.
        if (!keepTransport && outcome.status !== "succeeded") await active.subagents.cancel();
        await active.subagents.settled;
        if (!keepTransport) await this.#disposeTransport(transport);
        this.#subagentObservers.delete(active.subagents);
      })
      .catch(() => undefined);
    this.#active = null;
    const itemOutcome: HostItemOutcome =
      outcome.status === "failed"
        ? { status: "failed", error: outcome.error }
        : outcome.status === "cancelled"
          ? { status: "cancelled", ...(outcome.reason ? { reason: outcome.reason } : {}) }
          : { status: "succeeded" };
    active.subagents.finish(itemOutcome);
    if (active.agentItem) this.#completeItem(active, active.agentItem, itemOutcome);
    // A step whose patch never resolved still ran, so an interrupted Turn
    // reports it as a Tool Execution rather than dropping it silently.
    for (const step of active.pendingSteps.values()) {
      const item = startAntigravityToolItem(this.#newItemId(), step, this.#cwd);
      this.#event({ type: "item.started", turnId: active.command.turnId, item });
      this.#completeItem(active, item, itemOutcome);
    }
    active.pendingSteps.clear();
    for (const item of active.tools.values()) this.#completeItem(active, item, itemOutcome);
    active.tools.clear();
    if (nativeTurnRef) {
      this.#history.append({
        nativeTurnRef,
        ...(outcome.checkpoint ? { checkpoint: outcome.checkpoint } : {}),
        turnInput: active.command.input,
        items: active.completedItems.map((snapshot) => ({
          ...snapshot,
          item: active.subagents.snapshot(snapshot.item),
        })),
        outcome:
          outcome.status === "failed"
            ? { status: "failed", error: outcome.error }
            : outcome.status === "cancelled"
              ? { status: "cancelled", ...(outcome.reason ? { reason: outcome.reason } : {}) }
              : { status: "succeeded" },
        ...(this.#model ? { model: this.#model } : {}),
      });
    }
    this.#event({
      type: "turn.completed",
      turnId: active.command.turnId,
      outcome,
      ...(nativeTurnRef ? { nativeTurnRef } : {}),
    });
  }

  /** Releases a native driver: stop its bridge, end stdin, then kill if it lingers. */
  async #disposeTransport(transport: AntigravityTransport | null): Promise<void> {
    if (!transport) return;
    if (this.#transport === transport) this.#transport = null;
    transport.questions.stop();
    if (transport.process.stdin.writable) transport.process.stdin.end();
    const timer = setTimeout(() => transport.process.kill(), NATIVE_EXIT_GRACE_MS);
    const hardTimer = setTimeout(
      () => transport.process.kill("SIGKILL"),
      NATIVE_EXIT_GRACE_MS + 5_000,
    );
    try {
      // A process that keeps agy's output open can delay `close` indefinitely, and later
      // Turns' cleanup and close() queue behind this one.
      await settledWithin(transport.exited, NATIVE_EXIT_GRACE_MS + this.#turnCleanupWaitMs);
    } finally {
      clearTimeout(timer);
      clearTimeout(hardTimer);
      await transport.questions.dispose();
      await unlink(transport.logPath).catch(() => undefined);
    }
  }

  #completeItem(active: ActiveTurn, item: HostItem, outcome: HostItemOutcome): void {
    const snapshot = { item, outcome } satisfies HostItemSnapshot;
    active.completedItems.push(snapshot);
    this.#event({ type: "item.completed", turnId: active.command.turnId, snapshot });
  }

  async #executeHarnessCommand(
    command: HarnessCommandInvocation,
  ): Promise<HarnessResult<HarnessCommandAccepted>> {
    if (this.#closed) {
      return { ok: false, error: invalidState("Antigravity Session is closed") };
    }
    if (this.isActive) {
      return {
        ok: false,
        error: {
          code: "sessionBusy",
          message: "Antigravity Turn is already running",
          retryable: true,
        },
      };
    }
    const formatted = parseAndFormatAntigravityCommand(command);
    if (!formatted.ok) {
      return formatted;
    }
    const started = await this.execute({
      type: "turn.start",
      turnId: command.turnId,
      input: [{ type: "text", text: formatted.value.prompt }],
    });
    if (!started.ok) {
      return started;
    }
    return { ok: true, value: { turnId: command.turnId } };
  }

  async #cancel(command: TurnCancelCommand): Promise<HarnessResult<TurnCancelAccepted>> {
    if (!this.#active || this.#active.command.turnId !== command.turnId) {
      return {
        ok: false,
        error: {
          code: "invalidState",
          message: "Antigravity Turn is not active",
          retryable: false,
        },
      };
    }
    const active = this.#active;
    active.cancellationRequested = true;
    active.questions.stop();
    await active.subagents.cancel();
    active.process.kill();
    return { ok: true, value: { cancellationRequested: true } };
  }

  #selectModel(command: ModelSelectCommand): HarnessResult<ModelSelectCompleted> {
    this.#model = harnessModelRefSchema.parse(command.model);
    // Efforts are per-Model, so a Model that does not accept the retained
    // option must drop it rather than pass a combination the CLI rejects.
    const available = antigravityAvailableThinkingOptions(this.#catalog, this.#model);
    if (this.#thinkingOptionId && !available?.some(({ id }) => id === this.#thinkingOptionId)) {
      this.#thinkingOptionId = undefined;
    }
    this.#history.setSelection(this.#model, this.#thinkingOptionId);
    this.#event({ type: "session.state.changed", state: this.#state() });
    return { ok: true, value: { completed: true } };
  }

  #selectThinking(command: ThinkingSelectCommand): HarnessResult<ThinkingSelectCompleted> {
    const requested = harnessThinkingOptionIdSchema.safeParse(command.thinkingOptionId);
    if (!requested.success) {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "Antigravity Thinking option is not a valid identifier",
          retryable: false,
        },
      };
    }
    const available = antigravityAvailableThinkingOptions(this.#catalog, this.#model);
    if (!available?.some(({ id }) => id === requested.data)) {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: `Antigravity Model does not accept effort "${requested.data}"`,
          retryable: false,
        },
      };
    }
    this.#thinkingOptionId = requested.data;
    this.#history.setSelection(this.#model, this.#thinkingOptionId);
    this.#event({ type: "session.state.changed", state: this.#state() });
    return { ok: true, value: { completed: true } };
  }

  #selectPermissionMode(
    command: PermissionModeSelectCommand,
  ): HarnessResult<PermissionModeSelectCompleted> {
    if (this.isActive) {
      return {
        ok: false,
        error: { code: "sessionBusy", message: "Turn is active", retryable: true },
      };
    }
    try {
      this.#permissionMode = decodeAntigravityPermissionModeId(command.permissionModeId);
    } catch (error) {
      return {
        ok: false,
        error: { code: "invalidRequest", message: errorMessage(error), retryable: false },
      };
    }
    this.#event({ type: "session.state.changed", state: this.#state() });
    return { ok: true, value: { completed: true } };
  }

  #state(): HarnessSessionState {
    const availableThinkingOptions = antigravityAvailableThinkingOptions(
      this.#catalog,
      this.#model,
    );
    return {
      ...(this.#nativeRef ? { nativeRef: this.#nativeRef } : {}),
      ...(this.#model ? { effectiveModel: this.#model } : {}),
      ...(this.#thinkingOptionId ? { effectiveThinkingOptionId: this.#thinkingOptionId } : {}),
      ...(availableThinkingOptions ? { availableThinkingOptions } : {}),
      effectivePermissionModeId: ANTIGRAVITY_PERMISSION_MODE_CATALOG.modes.find(
        ({ id }) => id === this.#permissionMode,
      )?.id as HarnessPermissionModeId,
    };
  }

  #event(event: HostEvent): void {
    this.#channel.emit({ kind: "event", event });
  }

  #newItemId(): HostItemId {
    return hostItemIdSchema.parse(randomUUID());
  }
}

function historySubagentState(
  history: AntigravityHistory,
  id: string,
): HostSubagentState | undefined {
  for (const turn of history.snapshot().reverse()) {
    for (const { item } of [...turn.items].reverse()) {
      if (item.type !== "subagentDelegation") continue;
      const state = item.subagents.find((child) => child.nativeSubagentId === id);
      if (state) return state;
    }
  }
  return undefined;
}

export class AntigravityAdapter implements HarnessAdapter {
  readonly commandCatalog = ANTIGRAVITY_COMMAND_CATALOG;
  readonly harnessId: HarnessId = antigravityHarnessId;
  readonly usageStatistics: HarnessUsageStatisticsCapability;
  readonly subagents = {
    readSnapshot: async (input: {
      parent: NativeSessionRef;
      nativeSubagentId: string;
      cwd: string;
    }): Promise<HarnessResult<HostThreadSnapshot>> => {
      if (
        this.#closed ||
        input.parent.harnessId !== this.harnessId ||
        !nativeSubagentIdSchema.safeParse(input.nativeSubagentId).success
      ) {
        return { ok: false, error: invalidState("Invalid Antigravity Subagent reference") };
      }
      const session = this.#findSession(input.parent.nativeSessionId);
      const history =
        session?.history ??
        (await AntigravityHistory.findByNativeSessionId(
          this.#environment,
          input.parent.nativeSessionId,
        ));
      const state =
        session?.subagentState(input.nativeSubagentId) ??
        (history ? historySubagentState(history, input.nativeSubagentId) : undefined);
      if (!state) {
        return {
          ok: false,
          error: invalidState("Subagent does not belong to this parent Session"),
        };
      }
      return readSubagentTranscript({
        parentId: input.parent.nativeSessionId,
        childId: input.nativeSubagentId,
        status: state.status,
        cwd: input.cwd,
        outputLimit: this.#toolOutputLimit,
      });
    },
  };
  readonly #command: string | undefined;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #inspectTimeoutMs: number;
  readonly #inspectionCache = new Map<string, Extract<HarnessInspection, { status: "ready" }>>();
  readonly #inspectionInFlight = new Map<string, Promise<HarnessInspection>>();
  readonly #printTimeout: string;
  readonly #sessions = new Set<AntigravitySession>();
  readonly #toolOutputLimit: number;
  readonly #subagentObservationTimeoutMs: number;
  readonly #turnCleanupWaitMs: number;
  #closed = false;
  #quota: AntigravityQuotaSnapshot | null = null;
  #quotaCwd: string | null = null;
  #quotaRefresh: Promise<AntigravityQuotaSnapshot | null> | null = null;
  readonly #quotaAbort = new AbortController();

  constructor(options: AntigravityAdapterOptions = {}) {
    this.#command = options.command;
    this.#environment = options.environment ?? process.env;
    this.usageStatistics = createAntigravityUsageStatistics(this.#environment);
    this.#inspectTimeoutMs = options.inspectTimeoutMs ?? DEFAULT_INSPECT_TIMEOUT_MS;
    this.#printTimeout = options.printTimeout ?? DEFAULT_PRINT_TIMEOUT;
    this.#toolOutputLimit = options.toolOutputLimit ?? DEFAULT_TOOL_OUTPUT_LIMIT;
    const subagentObservationTimeoutMs =
      options.subagentObservationTimeoutMs ?? DEFAULT_SUBAGENT_OBSERVATION_TIMEOUT_MS;
    if (!Number.isFinite(subagentObservationTimeoutMs) || subagentObservationTimeoutMs <= 0) {
      throw new RangeError("subagentObservationTimeoutMs must be a finite positive number");
    }
    this.#subagentObservationTimeoutMs = subagentObservationTimeoutMs;
    const turnCleanupWaitMs = options.turnCleanupWaitMs ?? DEFAULT_TURN_CLEANUP_WAIT_MS;
    if (!Number.isFinite(turnCleanupWaitMs) || turnCleanupWaitMs < 0) {
      throw new RangeError("turnCleanupWaitMs must be a finite non-negative number");
    }
    this.#turnCleanupWaitMs = turnCleanupWaitMs;
  }

  async inspect(input: InspectHarnessInput = {}): Promise<HarnessInspection> {
    if (this.#closed) {
      return { status: "unavailable", error: invalidState("Antigravity Adapter is closed") };
    }
    const cwd = path.resolve(input.cwd ?? process.cwd());
    const inFlight = this.#inspectionInFlight.get(cwd);
    if (inFlight) return inFlight;
    if (!input.refresh) {
      const cached = this.#inspectionCache.get(cwd);
      if (cached) return cached;
    }

    const inspection = this.#inspectCwd(cwd).then((result) => {
      if (result.status === "ready") {
        this.#inspectionCache.set(cwd, result);
        this.#quotaCwd = cwd;
        void this.refreshCredits().catch(() => undefined);
      }
      return result;
    });
    this.#inspectionInFlight.set(cwd, inspection);
    return inspection.finally(() => {
      if (this.#inspectionInFlight.get(cwd) === inspection) {
        this.#inspectionInFlight.delete(cwd);
      }
    });
  }

  async #inspectCwd(cwd: string): Promise<HarnessInspection> {
    const executable = resolveAntigravityExecutable({
      ...(this.#command ? { command: this.#command } : {}),
      environment: this.#environment,
    });
    if (!executable) {
      return {
        status: "notInstalled",
        error: {
          code: "notInstalled",
          message: "Antigravity CLI (agy) is not installed",
          retryable: false,
        },
      };
    }
    try {
      const { stdout } = await runBuffered(
        executable,
        ["models"],
        cwd,
        this.#environment,
        this.#inspectTimeoutMs,
      );
      return {
        status: "ready",
        catalog: parseAntigravityModels(stdout),
        permissionModes: ANTIGRAVITY_PERMISSION_MODE_CATALOG,
        capabilities: CAPABILITIES,
      };
    } catch (error) {
      const message = errorMessage(error);
      const normalized = normalizedProcessError(message, message);
      return {
        status: "error",
        error: { ...normalized, stage: "model-catalog" },
      };
    }
  }

  async inspectAccount(): Promise<HarnessAccountSnapshot | null> {
    // The native /usage command resolves authentication itself. Never fall back
    // to the last quota observation when authentication has changed or failed.
    const snapshot = await this.refreshCredits();
    if (!snapshot) return null;
    return {
      credits: {
        ...(snapshot.label ? { label: snapshot.label } : {}),
        ...(snapshot.scope ? { scope: snapshot.scope } : {}),
        usedPercent: snapshot.usedPercent,
        periodType: snapshot.periodType,
        ...(snapshot.resetsAt ? { resetsAt: snapshot.resetsAt } : {}),
        ...(snapshot.productUsage ? { productUsage: [...snapshot.productUsage] } : {}),
      },
    };
  }

  /** Public account telemetry cache; never attributes quota to historical Thread spend. */
  credits(): AntigravityQuotaSnapshot | null {
    return this.#quota;
  }

  refreshCredits(): Promise<AntigravityQuotaSnapshot | null> {
    if (this.#quotaRefresh) return this.#quotaRefresh;
    this.#quotaRefresh = this.#loadQuota().finally(() => {
      this.#quotaRefresh = null;
    });
    return this.#quotaRefresh;
  }

  async #loadQuota(): Promise<AntigravityQuotaSnapshot | null> {
    if (this.#closed) return null;
    const executable = resolveAntigravityExecutable({
      ...(this.#command ? { command: this.#command } : {}),
      environment: this.#environment,
    });
    if (!executable) return null;
    const cwd = this.#quotaCwd ?? process.cwd();
    const snapshot = await fetchAntigravityQuota(async (arguments_) => {
      const { stdout } = await runBuffered(
        executable,
        [...arguments_],
        cwd,
        this.#environment,
        Math.min(this.#inspectTimeoutMs, 10_000),
        this.#quotaAbort.signal,
      );
      return stdout;
    });
    if (snapshot) this.#quota = snapshot;
    return snapshot;
  }

  #findSession(nativeSessionId: string): AntigravitySession | undefined {
    for (const session of this.#sessions) {
      if (session.nativeRef?.nativeSessionId === nativeSessionId) {
        return session;
      }
    }
    return undefined;
  }

  async open(input: OpenSessionInput): Promise<HarnessResult<HarnessSession>> {
    if (this.#closed) return { ok: false, error: invalidState("Antigravity Adapter is closed") };
    let permissionMode: AntigravityPermissionMode = "dangerously-skip-permissions";
    if (input.kind !== "fork" && input.permissionModeId) {
      try {
        permissionMode = decodeAntigravityPermissionModeId(input.permissionModeId);
      } catch (error) {
        return {
          ok: false,
          error: { code: "invalidRequest", message: errorMessage(error), retryable: false },
        };
      }
    }
    if (!input.cwd) {
      return {
        ok: false,
        error: { code: "invalidRequest", message: "Antigravity requires cwd", retryable: false },
      };
    }
    const executable = resolveAntigravityExecutable({
      ...(this.#command ? { command: this.#command } : {}),
      environment: this.#environment,
    });
    if (!executable) {
      return {
        ok: false,
        error: {
          code: "notInstalled",
          message: "Antigravity CLI is not installed",
          retryable: false,
        },
      };
    }
    const cwd = path.resolve(input.cwd);
    let catalog = this.#inspectionCache.get(cwd)?.catalog;
    if (!catalog) {
      const inspection = await this.inspect({ cwd: input.cwd });
      if (inspection.status === "ready") catalog = inspection.catalog;
    }

    if (input.kind === "fork") {
      const sourceSession = this.#findSession(input.sourceRef.nativeSessionId);
      return forkAntigravitySession({
        harnessId: this.harnessId,
        input,
        adapterEnvironment: this.#environment,
        ...(sourceSession
          ? {
              sourceSession: {
                history: sourceSession.history,
                model: sourceSession.model,
                thinkingOptionId: sourceSession.thinkingOptionId,
                permissionMode: sourceSession.permissionMode,
                isActive: sourceSession.isActive,
              },
            }
          : {}),
        createSession: (params) => {
          const session = new AntigravitySession({
            ...(catalog ? { catalog } : {}),
            cwd: params.cwd,
            environment: params.environment,
            executable,
            history: params.history,
            ...(params.model ? { model: params.model } : {}),
            nativeRef: params.nativeRef,
            permissionMode: params.permissionMode,
            printTimeout: this.#printTimeout,
            ...(params.thinkingOptionId ? { thinkingOptionId: params.thinkingOptionId } : {}),
            toolOutputLimit: this.#toolOutputLimit,
            subagentObservationTimeoutMs: this.#subagentObservationTimeoutMs,
            turnCleanupWaitMs: this.#turnCleanupWaitMs,
            onClosed: () => this.#sessions.delete(session),
          });
          this.#sessions.add(session);
          return session;
        },
      });
    }

    if (input.kind === "rollbackLastTurn") {
      const sourceSession = this.#findSession(input.sourceRef.nativeSessionId);
      return rollbackAntigravityLastTurn({
        harnessId: this.harnessId,
        input,
        adapterEnvironment: this.#environment,
        ...(sourceSession
          ? {
              sourceSession: {
                history: sourceSession.history,
                model: sourceSession.model,
                thinkingOptionId: sourceSession.thinkingOptionId,
                permissionMode: sourceSession.permissionMode,
                isActive: sourceSession.isActive,
              },
            }
          : {}),
        createSession: (params) => {
          const session = new AntigravitySession({
            ...(catalog ? { catalog } : {}),
            cwd: params.cwd,
            environment: params.environment,
            executable,
            history: params.history,
            ...(params.model ? { model: params.model } : {}),
            nativeRef: params.nativeRef,
            permissionMode: params.permissionMode,
            printTimeout: this.#printTimeout,
            ...(params.thinkingOptionId ? { thinkingOptionId: params.thinkingOptionId } : {}),
            toolOutputLimit: this.#toolOutputLimit,
            subagentObservationTimeoutMs: this.#subagentObservationTimeoutMs,
            turnCleanupWaitMs: this.#turnCleanupWaitMs,
            onClosed: () => this.#sessions.delete(session),
          });
          this.#sessions.add(session);
          return session;
        },
      });
    }

    let nativeRef: NativeSessionRef | undefined;
    if (input.kind === "resume") {
      nativeRef = nativeSessionRefSchema.parse(input.nativeRef);
      if (nativeRef.harnessId !== this.harnessId) {
        return {
          ok: false,
          error: {
            code: "invalidRequest",
            message: "Antigravity cannot resume another Harness Session",
            retryable: false,
          },
        };
      }
    }
    const sessionEnvironment = { ...this.#environment, ...(input.environment ?? {}) };
    const history = await AntigravityHistory.open({
      environment: sessionEnvironment,
      ...(nativeRef ? { nativeSessionId: nativeRef.nativeSessionId } : {}),
      ...(input.kind === "resume" && input.knownTurnRefs
        ? { knownTurnRefs: input.knownTurnRefs }
        : {}),
    });
    const model = (input.kind === "create" ? input.model : undefined) ?? history.model;
    const thinkingOptionId =
      (input.kind === "create" ? input.thinkingOptionId : undefined) ?? history.thinkingOptionId;
    // `thread/start` reaches open() directly, so an effort the Model does not
    // accept has to be refused here; otherwise the CLI only rejects the
    // resulting `--effort` once the first Turn runs.
    if (thinkingOptionId) {
      const available = antigravityAvailableThinkingOptions(catalog, model);
      if (!available?.some(({ id }) => id === thinkingOptionId)) {
        return {
          ok: false,
          error: {
            code: "invalidRequest",
            message: `Antigravity Model does not accept effort "${thinkingOptionId}"`,
            retryable: false,
          },
        };
      }
    }
    if (model || thinkingOptionId) history.setSelection(model, thinkingOptionId);
    const session = new AntigravitySession({
      ...(catalog ? { catalog } : {}),
      cwd: input.cwd,
      environment: sessionEnvironment,
      executable,
      history,
      ...(model ? { model } : {}),
      ...(nativeRef ? { nativeRef } : {}),
      permissionMode,
      printTimeout: this.#printTimeout,
      ...(thinkingOptionId ? { thinkingOptionId } : {}),
      toolOutputLimit: this.#toolOutputLimit,
      subagentObservationTimeoutMs: this.#subagentObservationTimeoutMs,
      turnCleanupWaitMs: this.#turnCleanupWaitMs,
      onClosed: () => this.#sessions.delete(session),
    });
    this.#sessions.add(session);
    return { ok: true, value: session };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#inspectionCache.clear();
    this.#quota = null;
    this.#quotaCwd = null;
    this.#quotaAbort.abort();
    await Promise.all([...this.#sessions].map((session) => session.close()));
  }
}
