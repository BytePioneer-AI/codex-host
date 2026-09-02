import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { parseHostUsage, sanitizeDiagnosticTail, type HostUsage } from "@codexhost/harness-adapter";
import {
  harnessThinkingOptionIdSchema,
  jsonValueSchema,
  type HarnessThinkingOptionId,
  type JsonObject,
  type JsonValue,
} from "@codexhost/shared-contracts";

import { resolvePiExecutable, withNodeRuntimeOnPath } from "./command.js";
import type { PiSessionHistory } from "./pi-history.js";
import {
  latestPiCacheHitRatePercent,
  optionalPiCacheHitRatePercent,
  optionalPiStateContextUsage,
  parsePiSessionUsage,
  parsePiStateContextUsage,
} from "./pi-usage.js";
import type { PiNativeModel, PiNativeModelRef } from "./pi-model-catalog.js";
import { verifyPiSessionCwd } from "./pi-session-file.js";

export interface PiSessionState {
  sessionId: string;
  sessionFile: string | null;
  provider: string | null;
  modelId: string | null;
  thinkingLevel: HarnessThinkingOptionId | null;
  contextUsage: Pick<HostUsage, "contextUsedTokens" | "contextWindowTokens"> | null;
}

export type PiInteractionRequest =
  | {
      requestId: string;
      method: "select";
      title: string;
      options: string[];
      timeoutMs?: number;
    }
  | {
      requestId: string;
      method: "confirm";
      title: string;
      message: string;
      timeoutMs?: number;
    }
  | {
      requestId: string;
      method: "input";
      title: string;
      placeholder?: string;
      timeoutMs?: number;
    }
  | {
      requestId: string;
      method: "editor";
      title: string;
      prefill?: string;
      timeoutMs?: number;
    };

export type PiInteractionResponse =
  | { requestId: string; cancelled: true }
  | { requestId: string; value: string }
  | { requestId: string; confirmed: boolean };

export type PiTurnEvent =
  | { type: "text.delta"; messageId: string; delta: string }
  | { type: "reasoning.delta"; messageId: string; delta: string }
  | { type: "reasoning.completed"; messageId: string }
  | { type: "message.completed"; messageId: string }
  | { type: "compaction.started" }
  | {
      type: "compaction.completed";
      outcome: "succeeded" | "cancelled" | "failed";
      errorMessage?: string;
    }
  | { type: "interaction.requested"; request: PiInteractionRequest }
  | {
      type: "interaction.closed";
      requestId: string;
      reason: "responded" | "cancelled" | "expired" | "superseded";
    }
  | { type: "tool.started"; callId: string; toolName: string; arguments: JsonValue }
  | { type: "tool.updated"; callId: string; output: JsonValue }
  | {
      type: "tool.completed";
      callId: string;
      toolName: string;
      result: JsonValue;
      isError: boolean;
    };

export interface PiTurnResult {
  text: string;
  cancelled: boolean;
}

export interface PiCompactResult {
  outcome: "succeeded" | "cancelled" | "failed";
  errorMessage?: string;
}

export type PiRpcFaultKind = "notInstalled" | "unavailable" | "protocolError" | "processExited";

export class PiRpcFaultError extends Error {
  constructor(
    readonly kind: PiRpcFaultKind,
    message: string,
    readonly diagnostic?: string,
  ) {
    super(message);
    this.name = "PiRpcFaultError";
  }
}

export class PiRpcUnsupportedCommandError extends Error {
  constructor(readonly command: string) {
    super(`Pi RPC does not support '${command}'`);
    this.name = "PiRpcUnsupportedCommandError";
  }
}

export interface PiRpcSessionOptions {
  cwd: string;
  command?: string;
  environment?: NodeJS.ProcessEnv;
  sessionFile?: string;
  forkSessionFile?: string;
  model?: PiNativeModelRef;
  commandTimeoutMs?: number;
  compactionTimeoutMs?: number;
  cancelTimeoutMs?: number;
  closeTimeoutMs?: number;
  onFault?: (error: PiRpcFaultError) => void;
}

export interface PiRpcProcessOptions {
  cwd: string;
  command?: string;
  environment: NodeJS.ProcessEnv;
  sessionFile?: string;
  forkSessionFile?: string;
  model?: PiNativeModelRef;
}

export interface PiRpcProcessAdapter {
  spawn(options: PiRpcProcessOptions): ChildProcessWithoutNullStreams;
}

interface PendingCommand {
  command: string;
  resolve(value: Record<string, unknown>): void;
  reject(error: Error): void;
  timeout: NodeJS.Timeout | null;
}

interface ManualCompaction {
  onEvent(event: PiTurnEvent): void;
  resolve(result: PiCompactResult): void;
  reject(error: Error): void;
}

interface ActiveTurn {
  text: string;
  assistantMessageId: string | null;
  sawStreamedMessageText: boolean;
  sawStreamedMessageReasoning: boolean;
  lastFinalizedMessageText: string | null;
  lastFinalizedMessageReasoning: string | null;
  reasoningMessageOpen: boolean;
  onEvent(event: PiTurnEvent): void;
  resolve(value: PiTurnResult): void;
  reject(error: Error): void;
  failure: Error | null;
  sawTool: boolean;
  tools: Map<string, string>;
  interactions: Map<string, { request: PiInteractionRequest; timeout: NodeJS.Timeout | null }>;
  settlement: "pending" | "confirming" | "confirmed";
  cancellation: "none" | "requesting" | "accepted";
  cancellationTimeout: NodeJS.Timeout | null;
  abortPromise: Promise<void> | null;
}

const textDecoder = new TextDecoder("utf-8", { fatal: true });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function message(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function nonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function parseNativeModel(value: unknown, context: string): PiNativeModelRef | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value) || !nonBlankString(value.provider) || !nonBlankString(value.id)) {
    throw new PiRpcFaultError("protocolError", `Pi RPC returned an invalid ${context} Model`);
  }
  return { provider: value.provider, id: value.id };
}

function sessionStateData(response: Record<string, unknown>): Record<string, unknown> {
  const data = isRecord(response.data) ? response.data : null;
  if (!data) throw new PiRpcFaultError("protocolError", "Pi RPC state response has no data");
  return data;
}

function parseSessionState(response: Record<string, unknown>): PiSessionState {
  const data = sessionStateData(response);
  const model = parseNativeModel(data.model, "state");
  if (!nonBlankString(data.sessionId)) {
    throw new PiRpcFaultError("protocolError", "Pi RPC state has no stable Session identity");
  }
  const thinkingLevel =
    data.thinkingLevel === undefined
      ? null
      : harnessThinkingOptionIdSchema.safeParse(data.thinkingLevel);
  if (thinkingLevel !== null && !thinkingLevel.success) {
    throw new PiRpcFaultError("protocolError", "Pi RPC state has an invalid Thinking level");
  }
  return {
    sessionId: data.sessionId,
    sessionFile: typeof data.sessionFile === "string" ? data.sessionFile : null,
    provider: model?.provider ?? null,
    modelId: model?.id ?? null,
    thinkingLevel: thinkingLevel?.data ?? null,
    contextUsage: optionalPiStateContextUsage(data.contextUsage),
  };
}

function parseSessionStreaming(response: Record<string, unknown>): boolean {
  const isStreaming = sessionStateData(response).isStreaming;
  if (typeof isStreaming !== "boolean") {
    throw new PiRpcFaultError("protocolError", "Pi RPC state has no Streaming status");
  }
  return isStreaming;
}

function parseSessionHistory(response: Record<string, unknown>): PiSessionHistory {
  const data = isRecord(response.data) ? response.data : null;
  if (!data || !Array.isArray(data.entries)) {
    throw new PiRpcFaultError("protocolError", "Pi RPC entries response has no Entries");
  }
  const entries = data.entries.map((entry) => {
    const parsed = jsonValueSchema.safeParse(entry);
    if (!parsed.success || !isRecord(parsed.data)) {
      throw new PiRpcFaultError(
        "protocolError",
        "Pi RPC entries response contains an invalid Entry",
      );
    }
    return parsed.data as JsonObject;
  });
  if (data.leafId !== null && typeof data.leafId !== "string") {
    throw new PiRpcFaultError("protocolError", "Pi RPC entries response has an invalid leaf ID");
  }
  return { entries, leafId: data.leafId as string | null };
}

function parseAvailableThinkingLevels(
  response: Record<string, unknown>,
): HarnessThinkingOptionId[] {
  const data = isRecord(response.data) ? response.data : null;
  if (!data || !Array.isArray(data.levels) || data.levels.length === 0) {
    throw new PiRpcFaultError("protocolError", "Pi RPC Thinking catalog response has no levels");
  }
  const levels = data.levels.map((level) => {
    const parsed = harnessThinkingOptionIdSchema.safeParse(level);
    if (!parsed.success) {
      throw new PiRpcFaultError(
        "protocolError",
        "Pi RPC Thinking catalog contains an invalid level",
      );
    }
    return parsed.data;
  });
  if (new Set(levels).size !== levels.length) {
    throw new PiRpcFaultError("protocolError", "Pi RPC Thinking catalog contains duplicate levels");
  }
  return levels;
}

function parseAvailableModels(response: Record<string, unknown>): PiNativeModel[] {
  const data = isRecord(response.data) ? response.data : null;
  if (!data || !Array.isArray(data.models)) {
    throw new PiRpcFaultError("protocolError", "Pi RPC Model catalog response has no models");
  }
  return data.models.map((model) => {
    const parsed = parseNativeModel(model, "catalog");
    if (!parsed || !isRecord(model) || typeof model.reasoning !== "boolean") {
      throw new PiRpcFaultError(
        "protocolError",
        "Pi RPC catalog contains a Model without reasoning capability",
      );
    }
    return { ...parsed, reasoning: model.reasoning };
  });
}

function assistantText(value: unknown): string | null {
  if (!isRecord(value) || value.role !== "assistant" || !Array.isArray(value.content)) return null;
  return value.content
    .filter(
      (content): content is Record<string, unknown> =>
        isRecord(content) && content.type === "text" && typeof content.text === "string",
    )
    .map((content) => content.text as string)
    .join("");
}

function assistantMessageId(value: unknown): string | null {
  if (!isRecord(value) || value.role !== "assistant") return null;
  return nonBlankString(value.responseId) ? value.responseId : null;
}

function extractReasoningText(content: unknown): string | null {
  if (!isRecord(content)) return null;
  const type = String(content.type ?? "");
  if (type === "thinking" || type === "reasoning" || type === "thought") {
    const text = content.thinking ?? content.reasoning ?? content.text ?? content.delta;
    return typeof text === "string" ? text : null;
  }
  return null;
}

function assistantReasoning(value: unknown): string | null {
  if (!isRecord(value) || value.role !== "assistant" || !Array.isArray(value.content)) return null;
  return value.content
    .map(extractReasoningText)
    .filter((text): text is string => typeof text === "string")
    .join("");
}

function assistantFailure(value: unknown): Error | null | undefined {
  if (!isRecord(value) || value.role !== "assistant") return undefined;
  if (value.stopReason !== "error" && value.stopReason !== "aborted") return null;
  const fallback =
    value.stopReason === "aborted"
      ? "Pi assistant message was aborted"
      : "Pi assistant message failed";
  return new Error(nonBlankString(value.errorMessage) ? value.errorMessage : fallback);
}

function signalProcessTree(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (!isRecord(error) || error.code !== "ESRCH") throw error;
  }
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return Promise.race([
    new Promise<boolean>((resolve) => child.once("exit", () => resolve(true))),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

interface PiProcessCommandDependencies {
  platform: NodeJS.Platform;
  homeDirectory: string;
  isExecutable(filePath: string): boolean;
}

export function piRpcProcessCommand(
  options: PiRpcProcessOptions,
  dependencies: Partial<PiProcessCommandDependencies> = {},
): {
  command: string;
  arguments: string[];
  windowsVerbatimArguments: boolean;
} {
  if (options.sessionFile && options.forkSessionFile) {
    throw new Error("Pi RPC cannot combine Session resume and Fork startup");
  }
  if (options.model && (options.sessionFile || options.forkSessionFile)) {
    throw new Error("Pi RPC cannot combine a startup Model with Session restore or Fork");
  }
  const platform = dependencies.platform ?? process.platform;
  const command = resolvePiExecutable(
    {
      ...(options.command ? { command: options.command } : {}),
      environment: options.environment,
    },
    {
      platform,
      ...(dependencies.homeDirectory ? { homeDirectory: dependencies.homeDirectory } : {}),
      ...(dependencies.isExecutable ? { isExecutable: dependencies.isExecutable } : {}),
    },
  );
  const sessionArguments = options.forkSessionFile
    ? ["--fork", options.forkSessionFile]
    : options.sessionFile
      ? ["--session", options.sessionFile]
      : [];
  const modelArguments = options.model
    ? ["--provider", options.model.provider, "--model", options.model.id]
    : [];
  const arguments_ = ["--mode", "rpc", ...modelArguments, ...sessionArguments];
  const extension = path.win32.extname(command).toLowerCase();
  if (platform !== "win32" || ![".cmd", ".bat"].includes(extension)) {
    return { command, arguments: arguments_, windowsVerbatimArguments: false };
  }
  const quote = (value: string): string => `"${value.replaceAll("%", "%%").replaceAll('"', '""')}"`;
  const commandLine = [command, ...arguments_].map(quote).join(" ");
  return {
    command: options.environment?.ComSpec ?? options.environment?.COMSPEC ?? "cmd.exe",
    arguments: ["/d", "/v:off", "/s", "/c", `"${commandLine}"`],
    windowsVerbatimArguments: true,
  };
}

const nodeProcessAdapter: PiRpcProcessAdapter = {
  spawn(options) {
    const invocation = piRpcProcessCommand(options);
    return spawn(invocation.command, invocation.arguments, {
      cwd: options.cwd,
      env: options.environment,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
  },
};

export class PiRpcSession {
  readonly #options: Required<
    Pick<
      PiRpcSessionOptions,
      "commandTimeoutMs" | "compactionTimeoutMs" | "cancelTimeoutMs" | "closeTimeoutMs"
    >
  > &
    PiRpcSessionOptions;
  readonly #processAdapter: PiRpcProcessAdapter;
  #activeTurn: ActiveTurn | null = null;
  #buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  #child: ChildProcessWithoutNullStreams | null = null;
  #closed = false;
  #compactionActive = false;
  #compactionTurn: ActiveTurn | null = null;
  #compactionTimeout: NodeJS.Timeout | null = null;
  #failed = false;
  #pending = new Map<string, PendingCommand>();
  #state: PiSessionState | null = null;
  #latestCacheHitRatePercent: number | null | undefined;
  #manualCompaction: ManualCompaction | null = null;
  #stderrTail = "";

  constructor(
    options: PiRpcSessionOptions,
    processAdapter: PiRpcProcessAdapter = nodeProcessAdapter,
  ) {
    if (options.sessionFile && options.forkSessionFile) {
      throw new Error("Pi RPC cannot combine Session resume and Fork startup");
    }
    if (options.model && (options.sessionFile || options.forkSessionFile)) {
      throw new Error("Pi RPC cannot combine a startup Model with Session restore or Fork");
    }
    this.#options = {
      commandTimeoutMs: 30_000,
      compactionTimeoutMs: 300_000,
      cancelTimeoutMs: 2_000,
      closeTimeoutMs: 2_000,
      ...options,
    };
    this.#processAdapter = processAdapter;
  }

  get state(): PiSessionState {
    if (!this.#state) throw new Error("Pi RPC Session has not started");
    return this.#state;
  }

  get stderrTail(): string {
    return this.#stderrTail;
  }

  async start(): Promise<this> {
    if (this.#child || this.#closed) throw new Error("Pi RPC Session cannot be started twice");
    const child = this.#processAdapter.spawn({
      cwd: this.#options.cwd,
      ...(this.#options.command ? { command: this.#options.command } : {}),
      environment: withNodeRuntimeOnPath({
        ...process.env,
        ...this.#options.environment,
        PI_SKIP_VERSION_CHECK: "1",
        PI_TELEMETRY: "0",
      }),
      ...(this.#options.sessionFile ? { sessionFile: this.#options.sessionFile } : {}),
      ...(this.#options.forkSessionFile ? { forkSessionFile: this.#options.forkSessionFile } : {}),
      ...(this.#options.model ? { model: this.#options.model } : {}),
    });
    this.#child = child;
    child.stdout.on("data", (chunk: Buffer) => this.#push(chunk));
    child.stdout.on("end", () => {
      if (this.#buffer.length !== 0) {
        this.#fail(new PiRpcFaultError("protocolError", "Pi RPC stdout ended mid-frame"));
      }
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      this.#stderrTail = sanitizeDiagnosticTail(`${this.#stderrTail}${chunk.toString()}`);
    });
    child.once("error", (error) => {
      const kind = isRecord(error) && error.code === "ENOENT" ? "notInstalled" : "unavailable";
      this.#fail(
        new PiRpcFaultError(kind, `Pi RPC failed to start: ${error.message}`, this.stderrTail),
      );
    });
    child.once("exit", (code, signal) => {
      if (!this.#closed) {
        this.#fail(
          new PiRpcFaultError(
            "processExited",
            `Pi RPC exited (code=${code}, signal=${signal})`,
            this.stderrTail,
          ),
        );
      }
    });
    await Promise.race([
      new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      }),
      new Promise<never>((_resolve, reject) =>
        setTimeout(
          () => reject(new Error("Pi RPC start timed out")),
          this.#options.commandTimeoutMs,
        ),
      ),
    ]);
    try {
      this.#state = parseSessionState(await this.#send("get_state", {}));
    } catch (error) {
      const fault =
        error instanceof PiRpcFaultError
          ? error
          : new PiRpcFaultError("unavailable", `Pi RPC state unavailable: ${message(error)}`);
      this.#fail(fault);
      throw fault;
    }
    return this;
  }

  async getEntries(): Promise<PiSessionHistory> {
    try {
      return parseSessionHistory(await this.#send("get_entries", {}));
    } catch (error) {
      if (error instanceof PiRpcFaultError) this.#fail(error);
      throw error;
    }
  }

  async compact(
    customInstructions: string | undefined,
    onEvent: (event: PiTurnEvent) => void,
  ): Promise<PiCompactResult> {
    if (!this.#child || !this.#state || this.#closed || this.#failed) {
      throw new Error("Pi RPC Session is unavailable");
    }
    if (this.#activeTurn || this.#manualCompaction || this.#compactionActive) {
      throw new Error("Pi RPC Session already has an active operation");
    }

    const result = new Promise<PiCompactResult>((resolve, reject) => {
      this.#manualCompaction = { onEvent, resolve, reject };
    });
    try {
      await this.#send("compact", customInstructions ? { customInstructions } : {});
    } catch (error) {
      const pending = this.#manualCompaction as ManualCompaction | null;
      this.#manualCompaction = null;
      pending?.reject(error instanceof Error ? error : new Error(message(error)));
    }
    return result;
  }

  async getSessionUsage(): Promise<HostUsage | null> {
    try {
      const usage = parsePiSessionUsage(await this.#send("get_session_stats", {}));
      await this.#ensureLatestCacheHitRate();
      return this.#withLatestCacheHitRate(usage);
    } catch (error) {
      if (!(error instanceof PiRpcUnsupportedCommandError)) throw error;
      const response = await this.#send("get_state", {});
      const observedState = parseSessionState(response);
      if (
        !this.#state ||
        observedState.sessionId !== this.#state.sessionId ||
        observedState.provider !== this.#state.provider ||
        observedState.modelId !== this.#state.modelId
      ) {
        throw new Error("Pi RPC Usage fallback does not match the confirmed Session state");
      }
      await this.#ensureLatestCacheHitRate();
      const usage = parsePiStateContextUsage(response);
      return usage ? this.#withLatestCacheHitRate(usage) : null;
    }
  }

  async #ensureLatestCacheHitRate(): Promise<void> {
    if (this.#latestCacheHitRatePercent !== undefined) return;
    try {
      this.#latestCacheHitRatePercent = latestPiCacheHitRatePercent(
        parseSessionHistory(await this.#send("get_entries", {})),
      );
    } catch {
      this.#latestCacheHitRatePercent = null;
    }
  }

  #withLatestCacheHitRate(usage: HostUsage): HostUsage {
    return this.#latestCacheHitRatePercent === null || this.#latestCacheHitRatePercent === undefined
      ? usage
      : parseHostUsage({ ...usage, cacheHitRatePercent: this.#latestCacheHitRatePercent });
  }

  async fork(entryId: string): Promise<PiSessionState> {
    if (entryId.length === 0) throw new Error("Pi Fork Entry ID must not be empty");
    await this.#send("fork", { entryId });
    return this.#refreshState("Fork");
  }

  async clone(): Promise<PiSessionState> {
    await this.#send("clone", {});
    return this.#refreshState("Clone");
  }

  verifySessionCwd(expectedCwd: string): Promise<void> {
    return verifyPiSessionCwd({
      sessionFile: this.state.sessionFile,
      sessionId: this.state.sessionId,
      expectedCwd,
    });
  }

  async getAvailableModels(): Promise<PiNativeModel[]> {
    try {
      return parseAvailableModels(await this.#send("get_available_models", {}));
    } catch (error) {
      if (error instanceof PiRpcFaultError) this.#fail(error);
      throw error;
    }
  }

  async getAvailableThinkingLevels(): Promise<HarnessThinkingOptionId[] | null> {
    try {
      return parseAvailableThinkingLevels(await this.#send("get_available_thinking_levels", {}));
    } catch (error) {
      if (error instanceof PiRpcUnsupportedCommandError) return null;
      if (error instanceof PiRpcFaultError) this.#fail(error);
      throw error;
    }
  }

  async selectModel(model: PiNativeModelRef): Promise<PiSessionState> {
    await this.#send("set_model", { provider: model.provider, modelId: model.id });
    return this.#refreshState("Model");
  }

  async selectThinkingOption(thinkingOptionId: HarnessThinkingOptionId): Promise<PiSessionState> {
    const level = harnessThinkingOptionIdSchema.parse(thinkingOptionId);
    await this.#send("set_thinking_level", { level });
    return this.#refreshState("Thinking");
  }

  async #refreshState(operation: string): Promise<PiSessionState> {
    try {
      this.#state = parseSessionState(await this.#send("get_state", {}));
      return this.#state;
    } catch (error) {
      const fault =
        error instanceof PiRpcFaultError
          ? error
          : new PiRpcFaultError(
              "protocolError",
              `Pi RPC ${operation} state could not be confirmed: ${message(error)}`,
            );
      this.#fail(fault);
      throw fault;
    }
  }

  async runTurn(text: string, onEvent: (event: PiTurnEvent) => void): Promise<PiTurnResult> {
    if (!this.#child || !this.#state || this.#closed || this.#failed) {
      throw new Error("Pi RPC Session is unavailable");
    }
    if (this.#activeTurn) throw new Error("Pi RPC Session already has an active Turn");
    if (text.length === 0) throw new Error("Pi text Turn must not be empty");

    const settled = new Promise<PiTurnResult>((resolve, reject) => {
      this.#activeTurn = {
        text: "",
        assistantMessageId: null,
        sawStreamedMessageText: false,
        sawStreamedMessageReasoning: false,
        lastFinalizedMessageText: null,
        lastFinalizedMessageReasoning: null,
        reasoningMessageOpen: false,
        onEvent,
        resolve,
        reject,
        failure: null,
        sawTool: false,
        tools: new Map(),
        interactions: new Map(),
        settlement: "pending",
        cancellation: "none",
        cancellationTimeout: null,
        abortPromise: null,
      };
    });
    try {
      await this.#send("prompt", { message: text });
    } catch (error) {
      this.#rejectActiveTurn(error instanceof Error ? error : new Error(message(error)));
    }
    return settled;
  }

  respondToInteraction(response: PiInteractionResponse): Promise<void> {
    return this.#resolveInteraction(response, "cancelled" in response ? "cancelled" : "responded");
  }

  async #resolveInteraction(
    response: PiInteractionResponse,
    reason: "responded" | "cancelled" | "expired",
  ): Promise<void> {
    const active = this.#activeTurn;
    const pending = active?.interactions.get(response.requestId);
    if (!active || !pending || this.#closed || this.#failed) {
      throw new Error("Pi RPC interaction is not pending");
    }
    if ("value" in response && !["select", "input", "editor"].includes(pending.request.method)) {
      throw new Error("Pi RPC interaction response type does not match the request");
    }
    if ("confirmed" in response && pending.request.method !== "confirm") {
      throw new Error("Pi RPC confirmation does not match the request");
    }
    const frame =
      "cancelled" in response
        ? { type: "extension_ui_response", id: response.requestId, cancelled: true }
        : "confirmed" in response
          ? { type: "extension_ui_response", id: response.requestId, confirmed: response.confirmed }
          : { type: "extension_ui_response", id: response.requestId, value: response.value };
    if (!active.interactions.delete(response.requestId)) {
      throw new Error("Pi RPC interaction is not pending");
    }
    if (pending.timeout) clearTimeout(pending.timeout);
    active.onEvent({ type: "interaction.closed", requestId: response.requestId, reason });
    try {
      await this.#write(frame);
    } catch (error) {
      const fault = new PiRpcFaultError(
        "protocolError",
        `Pi RPC interaction response failed: ${message(error)}`,
      );
      this.#fail(fault);
      throw fault;
    }
  }

  abort(): Promise<void> {
    const active = this.#activeTurn;
    if (!active || this.#closed || this.#failed) {
      return Promise.reject(new Error("Pi RPC Session has no cancellable Turn"));
    }
    if (active.abortPromise) return active.abortPromise;
    active.cancellation = "requesting";
    active.cancellationTimeout = setTimeout(() => {
      this.#terminateFailedCancellation(
        active,
        new PiRpcFaultError(
          "protocolError",
          "Pi Turn cancellation did not settle within its bound",
        ),
      );
    }, this.#options.cancelTimeoutMs);
    const aborting = this.#send("abort", {})
      .then(() => {
        if (this.#activeTurn !== active) return;
        active.cancellation = "accepted";
        this.#finishSettledTurn(active);
      })
      .catch((error: unknown) => {
        if (this.#activeTurn !== active) throw error;
        const fault =
          error instanceof PiRpcFaultError
            ? error
            : new PiRpcFaultError("protocolError", `Pi RPC Abort failed: ${message(error)}`);
        this.#terminateFailedCancellation(active, fault);
        throw fault;
      });
    active.abortPromise = aborting;
    return aborting;
  }

  #terminateFailedCancellation(active: ActiveTurn, fault: PiRpcFaultError): void {
    if (this.#activeTurn !== active) return;
    if (active.cancellationTimeout) clearTimeout(active.cancellationTimeout);
    active.cancellationTimeout = null;
    this.#fail(fault);
    void this.close().catch(() => undefined);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#rejectAll(new Error("Pi RPC Session closed"));
    await this.#stopProcess();
  }

  async #stopProcess(): Promise<void> {
    const child = this.#child;
    if (!child) return;
    if (child.stdin.writable) child.stdin.end();
    if (await waitForExit(child, this.#options.closeTimeoutMs)) return;
    signalProcessTree(child, "SIGTERM");
    if (await waitForExit(child, this.#options.closeTimeoutMs)) return;
    signalProcessTree(child, "SIGKILL");
    if (!(await waitForExit(child, this.#options.closeTimeoutMs))) {
      throw new Error("Pi RPC process tree did not exit within cleanup bounds");
    }
  }

  #push(chunk: Buffer<ArrayBufferLike>): void {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    let newline = this.#buffer.indexOf(0x0a);
    while (newline >= 0) {
      const frame = this.#buffer.subarray(0, newline);
      this.#buffer = this.#buffer.subarray(newline + 1);
      try {
        const value = JSON.parse(textDecoder.decode(frame));
        if (!isRecord(value) || typeof value.type !== "string") {
          throw new PiRpcFaultError("protocolError", "Pi RPC returned an invalid envelope");
        }
        this.#handle(value);
      } catch (error) {
        this.#fail(
          error instanceof PiRpcFaultError
            ? error
            : new PiRpcFaultError(
                "protocolError",
                `Pi RPC returned invalid JSONL: ${message(error)}`,
              ),
        );
      }
      newline = this.#buffer.indexOf(0x0a);
    }
  }

  #handle(value: Record<string, unknown>): void {
    if (this.#closed || this.#failed) return;
    if (value.type === "response") {
      this.#handleResponse(value);
      return;
    }
    if (value.type === "compaction_start") {
      this.#compactionActive = true;
      this.#compactionTurn = this.#activeTurn;
      this.#compactionTimeout ??= setTimeout(() => {
        this.#compactionTimeout = null;
        this.#fail(
          new PiRpcFaultError(
            "protocolError",
            `Pi RPC compaction timed out after ${this.#options.compactionTimeoutMs}ms`,
          ),
        );
      }, this.#options.compactionTimeoutMs);
      const onEvent = this.#activeTurn?.onEvent ?? this.#manualCompaction?.onEvent;
      onEvent?.({ type: "compaction.started" });
      for (const pending of this.#pending.values()) {
        if ((pending.command !== "prompt" && pending.command !== "compact") || !pending.timeout)
          continue;
        clearTimeout(pending.timeout);
        pending.timeout = null;
      }
      return;
    }
    if (value.type === "compaction_end") {
      this.#compactionActive = false;
      if (this.#compactionTimeout) clearTimeout(this.#compactionTimeout);
      this.#compactionTimeout = null;
      const compactionTurn = this.#compactionTurn;
      this.#compactionTurn = null;
      for (const [id, pending] of this.#pending) {
        if (pending.command === "prompt" || pending.command === "compact") {
          this.#armCommandTimeout(id, pending);
        }
      }
      const outcome =
        value.aborted === true ? "cancelled" : isRecord(value.result) ? "succeeded" : "failed";
      const event: PiTurnEvent = {
        type: "compaction.completed",
        outcome,
        ...(nonBlankString(value.errorMessage) ? { errorMessage: value.errorMessage } : {}),
      };
      compactionTurn?.onEvent(event);
      const manual = this.#manualCompaction;
      this.#manualCompaction = null;
      manual?.onEvent(event);
      manual?.resolve({
        outcome,
        ...(event.errorMessage ? { errorMessage: event.errorMessage } : {}),
      });
      return;
    }
    const active = this.#activeTurn;
    if (!active) {
      if (value.type === "extension_ui_request" && this.#isBlockingInteraction(value)) {
        this.#fail(
          new PiRpcFaultError(
            "protocolError",
            "Pi RPC requested blocking Extension UI outside an active Turn",
          ),
        );
      }
      return;
    }
    if (value.type === "extension_ui_request") {
      this.#startInteraction(active, value);
      return;
    }
    if (value.type === "message_start" && assistantText(value.message) !== null) {
      this.#startAssistantMessage(active, value.message);
      return;
    }
    if (value.type === "message_update" && isRecord(value.assistantMessageEvent)) {
      const event = value.assistantMessageEvent;
      const eventType = String(event.type ?? "");
      const isThinking =
        eventType === "thinking_delta" ||
        eventType === "reasoning_delta" ||
        eventType === "thought_delta" ||
        eventType === "thinking" ||
        eventType === "reasoning";
      const isText =
        eventType === "text_delta" || eventType === "text" || eventType === "content_block_delta";

      const delta =
        typeof event.delta === "string"
          ? event.delta
          : typeof event.thinking === "string"
            ? event.thinking
            : typeof event.reasoning === "string"
              ? event.reasoning
              : typeof event.text === "string"
                ? event.text
                : isRecord(event.delta) && typeof event.delta.thinking === "string"
                  ? event.delta.thinking
                  : isRecord(event.delta) && typeof event.delta.text === "string"
                    ? event.delta.text
                    : null;

      if (isThinking && delta !== null && delta.length > 0) {
        const messageId = this.#ensureAssistantMessage(active, value.message);
        active.reasoningMessageOpen = true;
        active.sawStreamedMessageReasoning = true;
        active.onEvent({ type: "reasoning.delta", messageId, delta });
      } else if (isText && delta !== null && delta.length > 0) {
        const messageId = this.#ensureAssistantMessage(active, value.message);
        active.text += delta;
        active.sawStreamedMessageText = true;
        active.onEvent({ type: "text.delta", messageId, delta });
      } else if (event.type === "error") {
        this.#ensureAssistantMessage(active, value.message);
        active.failure =
          assistantFailure(event.error) ??
          assistantFailure(value.message) ??
          new Error("Pi assistant message failed");
      }
      return;
    }
    if (value.type === "message_end") {
      this.#finalizeAssistantMessage(active, value.message);
      return;
    }
    if (value.type === "turn_end") {
      this.#finalizeAssistantMessage(active, value.message);
      return;
    }
    if (value.type === "tool_execution_start") {
      this.#startTool(active, value);
      return;
    }
    if (value.type === "tool_execution_update") {
      this.#updateTool(active, value);
      return;
    }
    if (value.type === "tool_execution_end") {
      this.#completeTool(active, value);
      return;
    }
    if (value.type === "agent_settled") {
      if (active.settlement !== "pending") return;
      active.settlement = "confirming";
      void this.#confirmSettledTurn(active);
    }
  }

  #isBlockingInteraction(value: Record<string, unknown>): boolean {
    return ["select", "confirm", "input", "editor"].includes(String(value.method));
  }

  #startInteraction(active: ActiveTurn, value: Record<string, unknown>): void {
    if (!this.#isBlockingInteraction(value)) return;
    const requestId = value.id;
    const method = value.method;
    const title = value.title;
    const timeoutMs = value.timeout;
    if (
      typeof requestId !== "string" ||
      requestId.length === 0 ||
      typeof method !== "string" ||
      typeof title !== "string" ||
      title.length === 0 ||
      (timeoutMs !== undefined &&
        (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs < 0)) ||
      active.interactions.has(requestId)
    ) {
      throw new PiRpcFaultError("protocolError", "Pi RPC returned an invalid Interaction request");
    }

    let request: PiInteractionRequest;
    if (method === "select") {
      if (
        !Array.isArray(value.options) ||
        value.options.length === 0 ||
        !value.options.every(
          (option): option is string => typeof option === "string" && option.length > 0,
        )
      ) {
        throw new PiRpcFaultError("protocolError", "Pi RPC select request has invalid options");
      }
      request = {
        requestId,
        method,
        title,
        options: [...value.options],
        ...(typeof timeoutMs === "number" ? { timeoutMs } : {}),
      };
    } else if (method === "confirm") {
      if (typeof value.message !== "string") {
        throw new PiRpcFaultError("protocolError", "Pi RPC confirm request has no message");
      }
      request = {
        requestId,
        method,
        title,
        message: value.message,
        ...(typeof timeoutMs === "number" ? { timeoutMs } : {}),
      };
    } else if (method === "input") {
      if (value.placeholder !== undefined && typeof value.placeholder !== "string") {
        throw new PiRpcFaultError("protocolError", "Pi RPC input placeholder is invalid");
      }
      request = {
        requestId,
        method,
        title,
        ...(typeof value.placeholder === "string" ? { placeholder: value.placeholder } : {}),
        ...(typeof timeoutMs === "number" ? { timeoutMs } : {}),
      };
    } else {
      if (value.prefill !== undefined && typeof value.prefill !== "string") {
        throw new PiRpcFaultError("protocolError", "Pi RPC editor prefill is invalid");
      }
      request = {
        requestId,
        method: "editor",
        title,
        ...(typeof value.prefill === "string" ? { prefill: value.prefill } : {}),
        ...(typeof timeoutMs === "number" ? { timeoutMs } : {}),
      };
    }

    const pending = { request, timeout: null as NodeJS.Timeout | null };
    if (request.timeoutMs !== undefined) {
      pending.timeout = setTimeout(() => {
        if (this.#activeTurn !== active || !active.interactions.has(requestId)) return;
        void this.#resolveInteraction({ requestId, cancelled: true }, "expired").catch((error) => {
          if (this.#closed || this.#failed) return;
          this.#fail(
            new PiRpcFaultError(
              "protocolError",
              `Pi RPC Interaction timeout handling failed: ${message(error)}`,
            ),
          );
        });
      }, request.timeoutMs);
    }
    active.interactions.set(requestId, pending);
    active.onEvent({ type: "interaction.requested", request });
  }

  #handleResponse(value: Record<string, unknown>): void {
    const id = value.id;
    if (typeof id !== "string") {
      this.#fail(new PiRpcFaultError("protocolError", "Pi RPC response has no id"));
      return;
    }
    const pending = this.#pending.get(id);
    if (!pending) {
      this.#fail(new PiRpcFaultError("protocolError", "Pi RPC response id is not pending"));
      return;
    }
    if (pending.timeout) clearTimeout(pending.timeout);
    this.#pending.delete(id);
    if (value.success === true) pending.resolve(value);
    else {
      const error = typeof value.error === "string" ? value.error : "Pi RPC command failed";
      if (value.command === pending.command && error === `Unknown command: ${pending.command}`) {
        pending.reject(new PiRpcUnsupportedCommandError(pending.command));
      } else {
        pending.reject(new Error(error));
      }
    }
  }

  #startTool(active: ActiveTurn, value: Record<string, unknown>): void {
    const callId = value.toolCallId;
    const toolName = value.toolName;
    const argumentsResult = jsonValueSchema.safeParse(value.args);
    if (
      typeof callId !== "string" ||
      callId.length === 0 ||
      typeof toolName !== "string" ||
      toolName.length === 0 ||
      !argumentsResult.success ||
      active.tools.has(callId)
    ) {
      throw new PiRpcFaultError("protocolError", "Pi RPC returned an invalid Tool start");
    }
    active.sawTool = true;
    active.tools.set(callId, toolName);
    active.onEvent({
      type: "tool.started",
      callId,
      toolName,
      arguments: argumentsResult.data,
    });
  }

  #updateTool(active: ActiveTurn, value: Record<string, unknown>): void {
    const callId = value.toolCallId;
    const outputResult = jsonValueSchema.safeParse(value.partialResult);
    if (typeof callId !== "string" || !active.tools.has(callId) || !outputResult.success) {
      throw new PiRpcFaultError("protocolError", "Pi RPC returned an invalid Tool update");
    }
    active.onEvent({ type: "tool.updated", callId, output: outputResult.data });
  }

  #completeTool(active: ActiveTurn, value: Record<string, unknown>): void {
    const callId = value.toolCallId;
    const toolName = value.toolName;
    const result = jsonValueSchema.safeParse(value.result);
    const expectedName = typeof callId === "string" ? active.tools.get(callId) : undefined;
    if (
      typeof callId !== "string" ||
      typeof toolName !== "string" ||
      expectedName !== toolName ||
      typeof value.isError !== "boolean" ||
      !result.success
    ) {
      throw new PiRpcFaultError("protocolError", "Pi RPC returned an invalid Tool end");
    }
    active.tools.delete(callId);
    active.onEvent({
      type: "tool.completed",
      callId,
      toolName,
      result: result.data,
      isError: value.isError,
    });
  }

  async #confirmSettledTurn(active: ActiveTurn): Promise<void> {
    try {
      const response = await this.#send("get_state", {});
      const state = parseSessionState(response);
      if (parseSessionStreaming(response)) {
        throw new PiRpcFaultError("protocolError", "Pi RPC agent_settled state is still Streaming");
      }
      if (this.#activeTurn !== active) return;
      this.#state = state;
      active.settlement = "confirmed";
      this.#finishSettledTurn(active);
    } catch (error) {
      if (this.#activeTurn !== active) return;
      const fault =
        error instanceof PiRpcFaultError
          ? error
          : new PiRpcFaultError(
              "protocolError",
              `Pi RPC stable Turn state could not be confirmed: ${message(error)}`,
            );
      this.#fail(fault);
    }
  }

  #finishSettledTurn(active: ActiveTurn): void {
    if (
      this.#activeTurn !== active ||
      active.settlement !== "confirmed" ||
      active.cancellation === "requesting"
    ) {
      return;
    }
    if (active.cancellationTimeout) clearTimeout(active.cancellationTimeout);
    active.cancellationTimeout = null;
    this.#closeInteractions(
      active,
      active.cancellation === "accepted" ? "cancelled" : "superseded",
    );
    if (active.tools.size > 0) {
      this.#fail(
        new PiRpcFaultError("protocolError", "Pi RPC settled with active Tool executions"),
      );
      return;
    }
    this.#activeTurn = null;
    if (active.cancellation === "accepted") {
      active.resolve({ text: active.text, cancelled: true });
    } else if (active.failure) {
      active.reject(active.failure);
    } else if (active.text.trim().length === 0 && !active.sawTool) {
      active.reject(new Error("Pi RPC settled without displayable output"));
    } else {
      active.resolve({ text: active.text, cancelled: false });
    }
  }

  #startAssistantMessage(active: ActiveTurn, value: unknown): string {
    if (active.assistantMessageId !== null && active.reasoningMessageOpen) {
      active.onEvent({ type: "reasoning.completed", messageId: active.assistantMessageId });
    }
    const messageId = assistantMessageId(value) ?? randomUUID();
    active.assistantMessageId = messageId;
    active.sawStreamedMessageText = false;
    active.sawStreamedMessageReasoning = false;
    active.reasoningMessageOpen = false;
    return messageId;
  }

  #ensureAssistantMessage(active: ActiveTurn, value: unknown): string {
    return active.assistantMessageId ?? this.#startAssistantMessage(active, value);
  }

  #finalizeAssistantMessage(active: ActiveTurn, value: unknown): void {
    const finalText = assistantText(value);
    const finalReasoning = assistantReasoning(value);
    const failure = assistantFailure(value);
    const cacheHitRatePercent = optionalPiCacheHitRatePercent(value);
    if (finalText === null || finalReasoning === null || failure === undefined) return;
    if (
      active.assistantMessageId === null &&
      finalText === active.lastFinalizedMessageText &&
      finalReasoning === active.lastFinalizedMessageReasoning &&
      !active.sawStreamedMessageText &&
      !active.sawStreamedMessageReasoning
    ) {
      return;
    }

    active.failure = failure;
    this.#latestCacheHitRatePercent = cacheHitRatePercent;
    const messageId = this.#ensureAssistantMessage(active, value);
    if (!active.sawStreamedMessageReasoning && finalReasoning.length > 0) {
      active.reasoningMessageOpen = true;
      active.onEvent({ type: "reasoning.delta", messageId, delta: finalReasoning });
    }
    if (active.reasoningMessageOpen && active.failure === null) {
      active.onEvent({ type: "reasoning.completed", messageId });
    }

    if (!active.sawStreamedMessageText && finalText.length > 0) {
      active.text += finalText;
      active.onEvent({ type: "text.delta", messageId, delta: finalText });
    }

    active.assistantMessageId = null;
    active.sawStreamedMessageText = false;
    active.sawStreamedMessageReasoning = false;
    active.reasoningMessageOpen = false;
    active.lastFinalizedMessageText = finalText;
    active.lastFinalizedMessageReasoning = finalReasoning;
    active.onEvent({ type: "message.completed", messageId });
  }

  #write(value: Record<string, unknown>): Promise<void> {
    const child = this.#child;
    if (!child?.stdin.writable || this.#closed || this.#failed) {
      return Promise.reject(new Error("Pi RPC stdin is unavailable"));
    }
    return new Promise((resolve, reject) => {
      const frame = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
      child.stdin.write(frame, (error) => (error ? reject(error) : resolve()));
    });
  }

  #send(type: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const child = this.#child;
    if (!child?.stdin.writable || this.#closed || this.#failed) {
      return Promise.reject(new Error("Pi RPC stdin is unavailable"));
    }
    const id = `codexhost-${randomUUID()}`;
    return new Promise((resolve, reject) => {
      const pending: PendingCommand = {
        command: type,
        resolve,
        reject,
        timeout: null,
      };
      this.#pending.set(id, pending);
      this.#armCommandTimeout(id, pending);
      const frame = Buffer.from(`${JSON.stringify({ id, type, ...payload })}\n`, "utf8");
      child.stdin.write(frame, (error) => {
        if (error) {
          if (pending.timeout) clearTimeout(pending.timeout);
          this.#pending.delete(id);
          reject(error);
        }
      });
    });
  }

  #armCommandTimeout(id: string, pending: PendingCommand): void {
    if (
      pending.timeout ||
      this.#pending.get(id) !== pending ||
      ((pending.command === "prompt" || pending.command === "compact") && this.#compactionActive)
    ) {
      return;
    }
    pending.timeout = setTimeout(() => {
      if (this.#pending.get(id) !== pending) return;
      pending.timeout = null;
      const error = new Error(`Pi RPC '${pending.command}' command timed out`);
      if (pending.command !== "prompt") {
        this.#pending.delete(id);
        pending.reject(error);
        return;
      }
      const fault = new PiRpcFaultError("protocolError", error.message);
      void this.#terminateTimedOutPrompt(fault);
    }, this.#options.commandTimeoutMs);
  }

  async #terminateTimedOutPrompt(fault: PiRpcFaultError): Promise<void> {
    if (this.#closed || this.#failed) return;
    this.#failed = true;
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      if (pending.timeout) clearTimeout(pending.timeout);
      pending.timeout = null;
    }
    let finalFault = fault;
    try {
      await this.#stopProcess();
    } catch (error) {
      finalFault = new PiRpcFaultError(
        "processExited",
        `Pi RPC timed-out Prompt cleanup failed: ${message(error)}`,
      );
    }
    this.#rejectAll(finalFault);
    this.#options.onFault?.(finalFault);
  }

  #closeInteractions(active: ActiveTurn, reason: "cancelled" | "expired" | "superseded"): void {
    for (const [requestId, pending] of active.interactions) {
      active.interactions.delete(requestId);
      if (pending.timeout) clearTimeout(pending.timeout);
      active.onEvent({
        type: "interaction.closed",
        requestId,
        reason,
      });
    }
  }

  #rejectActiveTurn(error: Error): void {
    const active = this.#activeTurn;
    if (!active) return;
    if (active.cancellationTimeout) clearTimeout(active.cancellationTimeout);
    this.#closeInteractions(active, "cancelled");
    this.#activeTurn = null;
    active.reject(error);
  }

  #rejectAll(error: Error): void {
    if (this.#compactionTimeout) clearTimeout(this.#compactionTimeout);
    this.#compactionTimeout = null;
    for (const pending of this.#pending.values()) {
      if (pending.timeout) clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
    const manual = this.#manualCompaction;
    this.#manualCompaction = null;
    manual?.reject(error);
    this.#rejectActiveTurn(error);
  }

  #fail(error: PiRpcFaultError): void {
    if (this.#closed || this.#failed) return;
    this.#failed = true;
    this.#rejectAll(error);
    this.#options.onFault?.(error);
  }
}
