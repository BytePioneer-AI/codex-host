import { spawn, type ChildProcessByStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import type { Readable, Writable } from "node:stream";

import {
  HarnessOutputChannel,
  sanitizeDiagnosticTail,
  type HarnessAdapter,
  type HarnessError,
  type HarnessInspection,
  type HarnessModelCatalog,
  type HarnessModelRef,
  type HarnessOutput,
  type HarnessResult,
  type HarnessSession,
  type HarnessSessionCapabilities,
  type HarnessSessionState,
  type InspectHarnessInput,
  type HostAgentMessageItem,
  type HostCommand,
  type HostEvent,
  type HostItem,
  type HostItemOutcome,
  type HostItemSnapshot,
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
  nativeSessionRefSchema,
  nativeTurnRefSchema,
  type HarnessId,
  type HarnessPermissionModeId,
  type HarnessThinkingOptionId,
  type HostItemId,
  type NativeSessionRef,
  type NativeTurnRef,
} from "@codexhost/shared-contracts";

import { resolveAntigravityExecutable } from "./command.js";
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
import { fetchAntigravityQuota, type AntigravityQuotaSnapshot } from "./quota.js";
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
  startAntigravityToolItem,
  synthesizeAntigravityFileChange,
} from "./tool-projection.js";

export interface AntigravityAdapterOptions {
  command?: string;
  environment?: NodeJS.ProcessEnv;
  inspectTimeoutMs?: number;
  printTimeout?: string;
  toolOutputLimit?: number;
}

interface ActiveTurn {
  command: TurnStartCommand;
  process: ChildProcessByStdio<Writable, Readable, Readable>;
  logPath: string;
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
}

const antigravityHarnessId = harnessIdSchema.parse("antigravity");
const DEFAULT_INSPECT_TIMEOUT_MS = 20_000;
const DEFAULT_PRINT_TIMEOUT = "30m";
const DEFAULT_TOOL_OUTPUT_LIMIT = 64_000;
const CONTEXT_USAGE_TIMEOUT_MS = 8_000;
const CONTEXT_USAGE_RETRY_MS = 100;
const GEMINI_CONTEXT_WINDOW_TOKENS = 1_048_576;

const CAPABILITIES: HarnessSessionCapabilities = {
  configuration: {
    selectModel: true,
    selectThinkingOption: true,
    selectPermissionMode: true,
    permissionModeScope: "live",
  },
  history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
  subagents: { observe: false, readTranscript: false },
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function invalidState(message: string): HarnessError {
  return { code: "invalidState", message, retryable: false };
}

function unsupported(message: string): HarnessError {
  return { code: "unsupported", message, retryable: false };
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
      "Headless Antigravity evaluates its own permission rules and cannot ask for approval; " +
      "retry with the Skip permissions Permission Mode.",
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
  if (used === undefined || window === undefined || window <= 0) return null;
  // agy's Gemini status line uses a 1 Mi-token window while LS metadata reports 256k.
  const contextWindowTokens =
    /^gemini(?:[-_.]|$)/iu.test(modelId ?? "") && window === 256_000
      ? GEMINI_CONTEXT_WINDOW_TOKENS
      : window;
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

function hostUsage(value: AntigravityUsage | undefined): HostUsage | null {
  if (!value) return null;
  const inputTokens = safeToken(value.input_tokens);
  const outputTokens = safeToken(value.output_tokens);
  const reasoningOutputTokens = safeToken(value.thinking_tokens);
  const cachedInputTokens = safeToken(value.cache_read_tokens);
  const totalTokens = safeToken(value.total_tokens);
  const contextUsedTokens = safeToken(value.context_used_tokens ?? value.estimated_tokens_used);
  const contextWindowTokens = safeToken(value.context_window_tokens ?? value.max_context_tokens);
  const usage: HostUsage = {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(contextUsedTokens !== undefined &&
    contextWindowTokens !== undefined &&
    contextWindowTokens > 0
      ? { contextUsedTokens, contextWindowTokens }
      : {}),
    ...(inputTokens !== undefined && cachedInputTokens !== undefined && inputTokens > 0
      ? { cacheHitRatePercent: Math.min(100, (cachedInputTokens / inputTokens) * 100) }
      : {}),
  };
  return Object.keys(usage).length > 0 ? usage : null;
}

function normalizedProcessError(stderr: string, fallback: string): HarnessError {
  // stderr can echo the invoked command line, so redact before it is surfaced.
  const diagnostic = sanitizeDiagnosticTail(stderr.trim());
  if (/sign[ -]?in|authenticat|credential|login/iu.test(diagnostic)) {
    return {
      code: "authenticationRequired",
      message: diagnostic || fallback,
      retryable: false,
    };
  }
  return {
    code: "nativeFailure",
    message: fallback,
    retryable: true,
    ...(diagnostic ? { stderrTail: diagnostic.slice(-4_000) } : {}),
  };
}

async function runBuffered(
  executable: string,
  arguments_: string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  const invocation = commandInvocation(executable, arguments_, environment);
  return await new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.arguments, {
      cwd,
      env: environment,
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
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr.trim() || `Antigravity CLI exited with code ${String(code)}`));
    });
  });
}

class AntigravitySession implements HarnessSession {
  readonly harnessId: HarnessId = antigravityHarnessId;
  readonly capabilities = CAPABILITIES;
  readonly initialUsage: HostUsage | null = null;
  readonly outputs: AsyncIterable<HarnessOutput>;
  readonly #channel = new HarnessOutputChannel<HarnessOutput>();
  readonly #cwd: string;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #executable: string;
  readonly #onClosed: () => void;
  readonly #printTimeout: string;
  readonly #toolOutputLimit: number;
  readonly #turns: HostThreadSnapshot["turns"];
  #active: ActiveTurn | null = null;
  #closed = false;
  #model: HarnessModelRef | undefined;
  #nativeRef: NativeSessionRef | undefined;
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
    knownTurnRefs?: NativeTurnRef[];
    permissionMode: AntigravityPermissionMode;
    printTimeout: string;
    thinkingOptionId?: HarnessThinkingOptionId;
    toolOutputLimit: number;
    onClosed(): void;
  }) {
    this.#catalog = input.catalog;
    this.#cwd = input.cwd;
    this.#environment = input.environment;
    this.#executable = input.executable;
    this.#model = input.model;
    this.#nativeRef = input.nativeRef;
    this.#permissionMode = input.permissionMode;
    this.#printTimeout = input.printTimeout;
    this.#thinkingOptionId = input.thinkingOptionId;
    this.#toolOutputLimit = input.toolOutputLimit;
    this.#onClosed = input.onClosed;
    this.#turns = (input.knownTurnRefs ?? []).map((nativeTurnRef) => ({
      nativeTurnRef,
      input: [],
      items: [],
      outcome: {
        status: "unknown",
        reason: "Antigravity CLI does not expose persisted assistant history to headless clients",
      },
    }));
    this.initialState = this.#state();
    this.outputs = this.#channel.outputs;
  }

  readonly initialState: HarnessSessionState;

  async readSnapshot(): Promise<HarnessResult<HostThreadSnapshot>> {
    if (this.#closed) return { ok: false, error: invalidState("Antigravity Session is closed") };
    return { ok: true, value: { turns: [...this.#turns], state: this.#state() } };
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
    if (this.#closed) return { ok: false, error: invalidState("Antigravity Session is closed") };
    if (command.type === "turn.cancel") return this.#cancel(command);
    if (command.type === "model.select") return this.#selectModel(command);
    if (command.type === "permissionMode.select") return this.#selectPermissionMode(command);
    if (command.type === "thinking.select") return this.#selectThinking(command);
    if (command.type === "interaction.respond") {
      return {
        ok: false,
        error: unsupported("Antigravity headless mode cannot answer interactive prompts"),
      };
    }
    if (this.#active) {
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

    const logPath = path.join(os.tmpdir(), `codexhost-antigravity-${randomUUID()}.log`);
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
    if (this.#permissionMode === "dangerously-skip-permissions") {
      arguments_.push("--dangerously-skip-permissions");
    }
    arguments_.push("--add-dir", this.#cwd);
    arguments_.push("--log-file", logPath);
    const invocation = commandInvocation(this.#executable, arguments_, this.#environment);
    let child: ChildProcessByStdio<Writable, Readable, Readable>;
    try {
      child = spawn(invocation.command, invocation.arguments, {
        cwd: this.#cwd,
        env: this.#environment,
        windowsHide: true,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      return {
        ok: false,
        error: { code: "nativeFailure", message: errorMessage(error), retryable: true },
      };
    }
    const active: ActiveTurn = {
      command,
      process: child,
      logPath,
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
    };
    this.#active = active;
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      active.stderr = (active.stderr + chunk).slice(-8_000);
    });
    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      const event = parseAntigravityStreamLine(line);
      if (event) this.#handleEvent(active, event);
      else if (line.trim()) active.stderr = (active.stderr + `\n${line}`).slice(-8_000);
    });
    child.once("error", (error) => {
      if (this.#active !== active) return;
      this.#completeTurn(active, {
        status: "failed",
        error: { code: "nativeFailure", message: error.message, retryable: true },
      });
    });
    child.once("exit", (code) => {
      void unlink(active.logPath).catch(() => undefined);
      if (this.#active !== active || active.receivedResult) return;
      if (active.cancellationRequested) {
        this.#completeTurn(active, { status: "cancelled", reason: "Cancelled by user" });
      } else {
        this.#completeTurn(active, {
          status: "failed",
          error: normalizedProcessError(
            active.stderr,
            `Antigravity CLI exited before a result event (code ${String(code)})`,
          ),
        });
      }
    });
    try {
      child.stdin.write(`${JSON.stringify({ event: "user", message: { content: text } })}\n`);
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
    if (this.#active) {
      this.#active.cancellationRequested = true;
      this.#active.process.kill();
      this.#completeTurn(this.#active, { status: "cancelled", reason: "Session closed" });
    }
    this.#channel.end();
    this.#onClosed();
  }

  #handleEvent(active: ActiveTurn, event: AntigravityStreamEvent): void {
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
      this.#event({ type: "session.state.changed", state: this.#state() });
      this.#ensureContextUsage(active, event.conversation_id);
      return;
    }
    if (event.event === "step_update") {
      this.#handleStep(active, event.step_update);
      const usage = hostUsage(event.step_update.usage);
      if (usage) this.#publishUsage(active, usage);
      this.#ensureContextUsage(active, event.step_update.conversation_id);
      return;
    }
    if (event.event !== "result") return;
    active.receivedResult = true;
    void this.#handleResult(active, event).catch((error: unknown) => {
      if (this.#active !== active) return;
      this.#completeTurn(active, {
        status: "failed",
        error: { code: "nativeFailure", message: errorMessage(error), retryable: true },
      });
    });
  }

  async #handleResult(active: ActiveTurn, event: AntigravityResultEvent): Promise<void> {
    if (this.#active !== active) return;
    const usage = hostUsage(event.result.usage);
    if (usage) this.#publishUsage(active, usage);
    this.#ensureContextUsage(active, event.result.conversation_id);
    if (active.contextUsagePromise) {
      const contextUsage = await active.contextUsagePromise;
      if (contextUsage) this.#publishUsage(active, contextUsage);
    }
    active.process.stdin.end();
    if (this.#active !== active) return;
    if (!this.#nativeRef) {
      this.#nativeRef = nativeSessionRefSchema.parse({
        harnessId: this.harnessId,
        nativeSessionId: event.result.conversation_id,
        formatVersion: 1,
      });
      this.#event({ type: "session.state.changed", state: this.#state() });
    }
    if (event.result.response) {
      this.#appendOrSyncAgentText(active, event.result.response, false);
    }
    const nativeTurnRef = nativeTurnRefSchema.parse({
      harnessId: this.harnessId,
      nativeSessionId: event.result.conversation_id,
      nativeTurnKey: `turn:${event.result.num_turns}`,
      formatVersion: 1,
    });
    if (active.cancellationRequested) {
      this.#completeTurn(
        active,
        { status: "cancelled", reason: "Cancelled by user" },
        nativeTurnRef,
      );
    } else if (event.result.status === "SUCCESS") {
      if (active.permissionDenial !== null && !active.agentItem) {
        this.#completeTurn(
          active,
          {
            status: "failed",
            error: permissionDeniedTurnError(active.nativePermissionMode, active.permissionDenial),
          },
          nativeTurnRef,
        );
      } else {
        this.#completeTurn(active, { status: "succeeded" }, nativeTurnRef);
      }
    } else {
      this.#completeTurn(
        active,
        {
          status: "failed",
          error: normalizedProcessError(
            active.stderr,
            `Antigravity Turn ended with status ${event.result.status}`,
          ),
        },
        nativeTurnRef,
      );
    }
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
      this.#model?.id,
      () =>
        active.receivedResult || active.cancellationRequested || active.process.exitCode !== null,
    );
  }

  #handleStep(active: ActiveTurn, step: AntigravityStepUpdateEvent["step_update"]): void {
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
    let item = active.tools.get(step.step_index);
    if (!item) {
      item = startAntigravityToolItem(this.#newItemId(), step, this.#cwd);
      active.tools.set(step.step_index, item);
      this.#event({ type: "item.started", turnId: active.command.turnId, item });
    }
    if (step.state !== "DONE" && step.state !== "ERROR") return;
    const toolError = antigravityToolErrorMessage(step.tool_info?.error);
    if (toolError !== null && active.permissionDenial === null) {
      if (isAntigravityPermissionDenial(toolError)) active.permissionDenial = toolError;
    }
    const completed = completeAntigravityToolItem(item, step, this.#toolOutputLimit, this.#cwd);
    active.tools.delete(step.step_index);
    const toolName =
      step.tool_name ??
      step.tool_info?.name ??
      (item.type === "toolExecution" ? item.toolName : item.type);
    const itemOutcome: HostItemOutcome =
      step.state === "ERROR"
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

    if (step.state !== "ERROR") {
      const params =
        step.tool_info?.parameters ?? (item.type === "toolExecution" ? item.arguments : undefined);
      const fileChanges = synthesizeAntigravityFileChange(toolName, params, this.#cwd);
      if (fileChanges && fileChanges.length > 0) {
        const fileItem: HostItem = {
          type: "fileChange",
          itemId: this.#newItemId(),
          changes: fileChanges,
        };
        this.#event({ type: "item.started", turnId: active.command.turnId, item: fileItem });
        this.#completeItem(active, fileItem, { status: "succeeded" });
      }
    }
  }

  #appendOrSyncAgentText(active: ActiveTurn, text: string, isExplicitDelta: boolean): void {
    if (!text) return;
    if (isExplicitDelta || !active.agentItem) {
      this.#appendAgentText(active, text);
      return;
    }
    if (text === active.agentText) return;
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
    this.#active = null;
    const itemOutcome: HostItemOutcome =
      outcome.status === "failed"
        ? { status: "failed", error: outcome.error }
        : outcome.status === "cancelled"
          ? { status: "cancelled", ...(outcome.reason ? { reason: outcome.reason } : {}) }
          : { status: "succeeded" };
    if (active.agentItem) this.#completeItem(active, active.agentItem, itemOutcome);
    for (const item of active.tools.values()) this.#completeItem(active, item, itemOutcome);
    active.tools.clear();
    if (nativeTurnRef) {
      this.#turns.push({
        nativeTurnRef,
        input: active.command.input,
        items: active.completedItems,
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

  #completeItem(active: ActiveTurn, item: HostItem, outcome: HostItemOutcome): void {
    const snapshot = { item, outcome } satisfies HostItemSnapshot;
    active.completedItems.push(snapshot);
    this.#event({ type: "item.completed", turnId: active.command.turnId, snapshot });
  }

  #cancel(command: TurnCancelCommand): HarnessResult<TurnCancelAccepted> {
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
    this.#active.cancellationRequested = true;
    this.#active.process.kill();
    return { ok: true, value: { cancellationRequested: true } };
  }

  #selectModel(command: ModelSelectCommand): HarnessResult<ModelSelectCompleted> {
    if (this.#active) {
      return {
        ok: false,
        error: { code: "sessionBusy", message: "Turn is active", retryable: true },
      };
    }
    this.#model = harnessModelRefSchema.parse(command.model);
    // Efforts are per-Model, so a Model that does not accept the retained
    // option must drop it rather than pass a combination the CLI rejects.
    const available = antigravityAvailableThinkingOptions(this.#catalog, this.#model);
    if (this.#thinkingOptionId && !available?.some(({ id }) => id === this.#thinkingOptionId)) {
      this.#thinkingOptionId = undefined;
    }
    this.#event({ type: "session.state.changed", state: this.#state() });
    return { ok: true, value: { completed: true } };
  }

  #selectThinking(command: ThinkingSelectCommand): HarnessResult<ThinkingSelectCompleted> {
    if (this.#active) {
      return {
        ok: false,
        error: { code: "sessionBusy", message: "Turn is active", retryable: true },
      };
    }
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
    this.#event({ type: "session.state.changed", state: this.#state() });
    return { ok: true, value: { completed: true } };
  }

  #selectPermissionMode(
    command: PermissionModeSelectCommand,
  ): HarnessResult<PermissionModeSelectCompleted> {
    if (this.#active) {
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

export class AntigravityAdapter implements HarnessAdapter {
  readonly harnessId: HarnessId = antigravityHarnessId;
  readonly #command: string | undefined;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #inspectTimeoutMs: number;
  readonly #inspectionCache = new Map<string, Extract<HarnessInspection, { status: "ready" }>>();
  readonly #inspectionInFlight = new Map<string, Promise<HarnessInspection>>();
  readonly #printTimeout: string;
  readonly #sessions = new Set<AntigravitySession>();
  readonly #toolOutputLimit: number;
  #closed = false;
  #quota: AntigravityQuotaSnapshot | null = null;
  #quotaCwd: string | null = null;
  #quotaRefresh: Promise<AntigravityQuotaSnapshot | null> | null = null;

  constructor(options: AntigravityAdapterOptions = {}) {
    this.#command = options.command;
    this.#environment = options.environment ?? process.env;
    this.#inspectTimeoutMs = options.inspectTimeoutMs ?? DEFAULT_INSPECT_TIMEOUT_MS;
    this.#printTimeout = options.printTimeout ?? DEFAULT_PRINT_TIMEOUT;
    this.#toolOutputLimit = options.toolOutputLimit ?? DEFAULT_TOOL_OUTPUT_LIMIT;
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

  /** Duck-typed by the Host Runtime to populate the account credits surface. */
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
        this.#inspectTimeoutMs,
      );
      return stdout;
    });
    if (snapshot) this.#quota = snapshot;
    return snapshot;
  }

  async open(input: OpenSessionInput): Promise<HarnessResult<HarnessSession>> {
    if (this.#closed) return { ok: false, error: invalidState("Antigravity Adapter is closed") };
    if (!input.cwd) {
      return {
        ok: false,
        error: { code: "invalidRequest", message: "Antigravity requires cwd", retryable: false },
      };
    }
    if (input.kind === "fork" || input.kind === "rollbackLastTurn") {
      return { ok: false, error: unsupported("Antigravity CLI does not expose history mutation") };
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
    let permissionMode: AntigravityPermissionMode = "configured";
    if (input.kind === "create" && input.permissionModeId) {
      try {
        permissionMode = decodeAntigravityPermissionModeId(input.permissionModeId);
      } catch (error) {
        return {
          ok: false,
          error: { code: "invalidRequest", message: errorMessage(error), retryable: false },
        };
      }
    }
    // Thinking selection is validated against the Catalog, so it has to be
    // present before the Session exists rather than whenever the Host happens
    // to have warmed the cache.
    const cwd = path.resolve(input.cwd);
    let catalog = this.#inspectionCache.get(cwd)?.catalog;
    if (!catalog) {
      const inspection = await this.inspect({ cwd: input.cwd });
      if (inspection.status === "ready") catalog = inspection.catalog;
    }
    // `thread/start` reaches open() directly, so an effort the Model does not
    // accept has to be refused here; otherwise the CLI only rejects the
    // resulting `--effort` once the first Turn runs.
    if (input.thinkingOptionId) {
      const available = antigravityAvailableThinkingOptions(catalog, input.model);
      if (!available?.some(({ id }) => id === input.thinkingOptionId)) {
        return {
          ok: false,
          error: {
            code: "invalidRequest",
            message: `Antigravity Model does not accept effort "${input.thinkingOptionId}"`,
            retryable: false,
          },
        };
      }
    }
    const session = new AntigravitySession({
      ...(catalog ? { catalog } : {}),
      cwd: input.cwd,
      environment: this.#environment,
      executable,
      ...(input.model ? { model: input.model } : {}),
      ...(nativeRef ? { nativeRef } : {}),
      ...(input.kind === "resume" && input.knownTurnRefs
        ? { knownTurnRefs: input.knownTurnRefs }
        : {}),
      permissionMode,
      printTimeout: this.#printTimeout,
      ...(input.thinkingOptionId ? { thinkingOptionId: input.thinkingOptionId } : {}),
      toolOutputLimit: this.#toolOutputLimit,
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
    await Promise.all([...this.#sessions].map((session) => session.close()));
  }
}
