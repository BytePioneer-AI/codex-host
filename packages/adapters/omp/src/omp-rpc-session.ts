import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { parseHostUsage, sanitizeDiagnosticTail, type HostUsage } from "@codexhost/harness-adapter";
import {
  harnessThinkingOptionIdSchema,
  jsonValueSchema,
  type HarnessThinkingOptionId,
  type HostItemId,
  type JsonObject,
  type JsonValue,
} from "@codexhost/shared-contracts";

import { resolveOmpExecutable, withNodeRuntimeOnPath } from "./command.js";
import type { OmpSessionHistory } from "./omp-history.js";

export type { OmpSessionHistory } from "./omp-history.js";
import {
  latestOmpCacheHitRatePercent,
  optionalOmpCacheHitRatePercent,
  optionalOmpStateContextUsage,
  parseOmpSessionUsage,
  parseOmpStateContextUsage,
} from "./omp-usage.js";
import type { OmpNativeModel, OmpNativeModelRef } from "./omp-model-catalog.js";
import type { OmpPermissionMode } from "./omp-permission-modes.js";
import { readOmpSessionHistory, verifyOmpSessionCwd } from "./omp-session-file.js";
import { OmpFrameDecoder } from "./omp-protocol.js";
import { isOmpProcessId, isOmpProcessPayload, ompProcessOsPid } from "./omp-subagent.js";

export interface OmpSessionState {
  sessionId: string;
  sessionFile: string | null;
  provider: string | null;
  modelId: string | null;
  thinkingLevel: HarnessThinkingOptionId | null;
  contextUsage: Pick<HostUsage, "contextUsedTokens" | "contextWindowTokens"> | null;
  availableThinkingLevels: HarnessThinkingOptionId[] | null;
}

export type OmpTurnEvent =
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
  | { type: "tool.started"; callId: string; toolName: string; arguments: JsonValue }
  | { type: "tool.updated"; callId: string; output: JsonValue }
  | {
      type: "tool.completed";
      callId: string;
      toolName: string;
      result: JsonValue;
      isError: boolean;
    }
  | {
      type: "subagent.started";
      callId: string;
      nativeSubagentId: string;
      description: string;
      role?: string;
      prompt?: string;
      background: boolean;
      sessionFile?: string;
    }
  | {
      type: "subagent.updated";
      callId: string;
      nativeSubagentId: string;
      status: OmpSubagentTurnStatus;
      description?: string;
      resultSummary?: string;
      sessionFile?: string;
    }
  | {
      type: "subagent.completed";
      callId: string;
      nativeSubagentId: string;
      isError: boolean;
      resultSummary?: string;
      sessionFile?: string;
    }
  | { type: "subagent.transcript.changed"; callId: string; nativeSubagentId: string }
  | {
      type: "process.state.changed";
      processId: string;
      status: "running" | "exited";
      itemId?: HostItemId;
      command?: string;
      cwd?: string;
      osPid?: number | null;
    };
export interface OmpTurnResult {
  text: string;
  cancelled: boolean;
}

export interface OmpCompactResult {
  outcome: "succeeded" | "cancelled" | "failed";
  errorMessage?: string;
}

export type OmpSubagentTurnStatus = "pending" | "running" | "completed" | "failed" | "interrupted";

export interface OmpSubagentMessagesResult {
  sessionFile: string;
  fromByte: number;
  nextByte: number;
  reset: boolean;
  entries: JsonObject[];
  messages: JsonObject[];
}

export type OmpRpcFaultKind = "notInstalled" | "unavailable" | "protocolError" | "processExited";

export class OmpRpcFaultError extends Error {
  constructor(
    readonly kind: OmpRpcFaultKind,
    message: string,
    readonly diagnostic?: string,
  ) {
    super(message);
    this.name = "OmpRpcFaultError";
  }
}

export class OmpRpcUnsupportedCommandError extends Error {
  constructor(readonly command: string) {
    super(`Omp RPC does not support '${command}'`);
    this.name = "OmpRpcUnsupportedCommandError";
  }
}

export interface OmpRpcSessionOptions {
  cwd: string;
  command?: string;
  environment?: NodeJS.ProcessEnv;
  sessionFile?: string;
  forkSessionFile?: string;
  model?: OmpNativeModelRef;
  permissionMode?: OmpPermissionMode;
  commandTimeoutMs?: number;
  compactionTimeoutMs?: number;
  cancelTimeoutMs?: number;
  closeTimeoutMs?: number;
  onSubagentEvent?: (event: OmpTurnEvent) => void;
  onFault?: (error: OmpRpcFaultError) => void;
}

export interface OmpRpcProcessOptions {
  cwd: string;
  command?: string;
  environment: NodeJS.ProcessEnv;
  sessionFile?: string;
  forkSessionFile?: string;
  model?: OmpNativeModelRef;
  permissionMode?: OmpPermissionMode;
}

export interface OmpRpcProcessAdapter {
  spawn(options: OmpRpcProcessOptions): ChildProcessWithoutNullStreams;
}

interface PendingCommand {
  command: string;
  resolve(value: Record<string, unknown>): void;
  reject(error: Error): void;
  timeout: NodeJS.Timeout | null;
}

interface ManualCompaction {
  onEvent(event: OmpTurnEvent): void;
  resolve(result: OmpCompactResult): void;
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
  onEvent(event: OmpTurnEvent): void;
  resolve(value: OmpTurnResult): void;
  reject(error: Error): void;
  failure: Error | null;
  sawTool: boolean;
  tools: Map<string, string>;
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

function parseNativeModel(value: unknown, context: string): OmpNativeModelRef | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value) || !nonBlankString(value.provider) || !nonBlankString(value.id)) {
    throw new OmpRpcFaultError("protocolError", `Omp RPC returned an invalid ${context} Model`);
  }
  return { provider: value.provider, id: value.id };
}

function sessionStateData(response: Record<string, unknown>): Record<string, unknown> {
  const data = isRecord(response.data) ? response.data : null;
  if (!data) throw new OmpRpcFaultError("protocolError", "Omp RPC state response has no data");
  return data;
}

function parseSessionState(response: Record<string, unknown>): OmpSessionState {
  const data = sessionStateData(response);
  const model = parseNativeModel(data.model, "state");
  if (!nonBlankString(data.sessionId)) {
    throw new OmpRpcFaultError("protocolError", "Omp RPC state has no stable Session identity");
  }
  const thinkingLevel =
    data.thinkingLevel === undefined
      ? null
      : harnessThinkingOptionIdSchema.safeParse(data.thinkingLevel);
  if (thinkingLevel !== null && !thinkingLevel.success) {
    throw new OmpRpcFaultError("protocolError", "Omp RPC state has an invalid Thinking level");
  }
  const thinking =
    isRecord(data.model) && isRecord(data.model.thinking) ? data.model.thinking : null;
  const availableThinkingLevels =
    thinking && Array.isArray(thinking.efforts)
      ? thinking.efforts.flatMap((level) => {
          const parsed = harnessThinkingOptionIdSchema.safeParse(level);
          return parsed.success ? [parsed.data] : [];
        })
      : null;
  return {
    sessionId: data.sessionId,
    sessionFile: typeof data.sessionFile === "string" ? data.sessionFile : null,
    provider: model?.provider ?? null,
    modelId: model?.id ?? null,
    thinkingLevel: thinkingLevel?.data ?? null,
    contextUsage: optionalOmpStateContextUsage(data.contextUsage),
    availableThinkingLevels,
  };
}

function parseSessionStreaming(response: Record<string, unknown>): boolean {
  const isStreaming = sessionStateData(response).isStreaming;
  if (typeof isStreaming !== "boolean") {
    throw new OmpRpcFaultError("protocolError", "Omp RPC state has no Streaming status");
  }
  return isStreaming;
}

function parseAvailableModels(response: Record<string, unknown>): OmpNativeModel[] {
  const data = isRecord(response.data) ? response.data : null;
  if (!data || !Array.isArray(data.models)) {
    throw new OmpRpcFaultError("protocolError", "Omp RPC Model catalog response has no models");
  }
  return data.models.map((model) => {
    const parsed = parseNativeModel(model, "catalog");
    if (!parsed || !isRecord(model) || typeof model.reasoning !== "boolean") {
      throw new OmpRpcFaultError(
        "protocolError",
        "Omp RPC catalog contains a Model without reasoning capability",
      );
    }
    return { ...parsed, reasoning: model.reasoning };
  });
}

function parseSubagentMessages(response: Record<string, unknown>): OmpSubagentMessagesResult {
  const data = isRecord(response.data) ? response.data : null;
  if (
    !data ||
    !nonBlankString(data.sessionFile) ||
    !Number.isSafeInteger(data.fromByte) ||
    !Number.isSafeInteger(data.nextByte) ||
    (data.fromByte as number) < 0 ||
    (data.nextByte as number) < (data.fromByte as number) ||
    typeof data.reset !== "boolean" ||
    !Array.isArray(data.entries) ||
    !Array.isArray(data.messages)
  ) {
    throw new OmpRpcFaultError("protocolError", "Omp RPC Subagent transcript response is invalid");
  }
  const entries = data.entries.flatMap((value) => (isRecord(value) ? [value as JsonObject] : []));
  const messages = data.messages.flatMap((value) => (isRecord(value) ? [value as JsonObject] : []));
  if (entries.length !== data.entries.length || messages.length !== data.messages.length) {
    throw new OmpRpcFaultError(
      "protocolError",
      "Omp RPC Subagent transcript contains invalid data",
    );
  }
  return {
    sessionFile: data.sessionFile,
    fromByte: data.fromByte as number,
    nextByte: data.nextByte as number,
    reset: data.reset,
    entries,
    messages,
  };
}

function subagentStatus(value: unknown): OmpSubagentTurnStatus {
  if (value === "pending" || value === "running" || value === "completed") return value;
  if (value === "failed" || value === "aborted" || value === "interrupted") return "failed";
  throw new OmpRpcFaultError("protocolError", "Omp RPC Subagent status is invalid");
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
      ? "Omp assistant message was aborted"
      : "Omp assistant message failed";
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

interface OmpProcessCommandDependencies {
  platform: NodeJS.Platform;
  homeDirectory: string;
  isExecutable(filePath: string): boolean;
}

export function ompRpcProcessCommand(
  options: OmpRpcProcessOptions,
  dependencies: Partial<OmpProcessCommandDependencies> = {},
): {
  command: string;
  arguments: string[];
  windowsVerbatimArguments: boolean;
} {
  if (options.sessionFile && options.forkSessionFile) {
    throw new Error("Omp RPC cannot combine Session resume and Fork startup");
  }
  if (options.model && (options.sessionFile || options.forkSessionFile)) {
    throw new Error("Omp RPC cannot combine a startup Model with Session restore or Fork");
  }
  const platform = dependencies.platform ?? process.platform;
  const command = resolveOmpExecutable(
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
      ? ["--resume", options.sessionFile]
      : [];
  const modelArguments = options.model
    ? ["--provider", options.model.provider, "--model", options.model.id]
    : [];
  const permissionArguments = options.permissionMode
    ? ["--approval-mode", options.permissionMode]
    : [];
  const arguments_ = [
    "--mode",
    "rpc",
    ...permissionArguments,
    ...modelArguments,
    ...sessionArguments,
  ];
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

const nodeProcessAdapter: OmpRpcProcessAdapter = {
  spawn(options) {
    const invocation = ompRpcProcessCommand(options);
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

export class OmpRpcSession {
  readonly #options: Required<
    Pick<
      OmpRpcSessionOptions,
      "commandTimeoutMs" | "compactionTimeoutMs" | "cancelTimeoutMs" | "closeTimeoutMs"
    >
  > &
    OmpRpcSessionOptions;
  readonly #processAdapter: OmpRpcProcessAdapter;
  #activeTurn: ActiveTurn | null = null;
  #buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  #child: ChildProcessWithoutNullStreams | null = null;
  #closed = false;
  #compactionActive = false;
  #compactionTurn: ActiveTurn | null = null;
  #compactionTimeout: NodeJS.Timeout | null = null;
  #failed = false;
  #pending = new Map<string, PendingCommand>();
  #state: OmpSessionState | null = null;
  #latestCacheHitRatePercent: number | null | undefined;
  #manualCompaction: ManualCompaction | null = null;
  #stderrTail = "";
  #frameDecoder = new OmpFrameDecoder();
  #readyResolve: (() => void) | null = null;
  readonly #ready = new Promise<void>((resolve) => {
    this.#readyResolve = resolve;
  });

  constructor(
    options: OmpRpcSessionOptions,
    processAdapter: OmpRpcProcessAdapter = nodeProcessAdapter,
  ) {
    if (options.sessionFile && options.forkSessionFile) {
      throw new Error("Omp RPC cannot combine Session resume and Fork startup");
    }
    if (options.model && (options.sessionFile || options.forkSessionFile)) {
      throw new Error("Omp RPC cannot combine a startup Model with Session restore or Fork");
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

  get state(): OmpSessionState {
    if (!this.#state) throw new Error("Omp RPC Session has not started");
    return this.#state;
  }

  get stderrTail(): string {
    return this.#stderrTail;
  }

  async start(): Promise<this> {
    if (this.#child || this.#closed) throw new Error("Omp RPC Session cannot be started twice");
    const child = this.#processAdapter.spawn({
      cwd: this.#options.cwd,
      ...(this.#options.command ? { command: this.#options.command } : {}),
      environment: withNodeRuntimeOnPath({
        ...process.env,
        ...this.#options.environment,
        OMP_SKIP_VERSION_CHECK: "1",
        OMP_TELEMETRY: "0",
      }),
      ...(this.#options.sessionFile ? { sessionFile: this.#options.sessionFile } : {}),
      ...(this.#options.forkSessionFile ? { forkSessionFile: this.#options.forkSessionFile } : {}),
      ...(this.#options.model ? { model: this.#options.model } : {}),
      ...(this.#options.permissionMode ? { permissionMode: this.#options.permissionMode } : {}),
    });
    this.#child = child;
    child.stdout.on("data", (chunk: Buffer) => this.#push(chunk));
    child.stdout.on("end", () => {
      if (this.#buffer.length !== 0) {
        this.#fail(new OmpRpcFaultError("protocolError", "Omp RPC stdout ended mid-frame"));
      }
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      this.#stderrTail = sanitizeDiagnosticTail(`${this.#stderrTail}${chunk.toString()}`);
    });
    child.once("error", (error) => {
      const kind = isRecord(error) && error.code === "ENOENT" ? "notInstalled" : "unavailable";
      this.#fail(
        new OmpRpcFaultError(kind, `Omp RPC failed to start: ${error.message}`, this.stderrTail),
      );
    });
    child.once("exit", (code, signal) => {
      if (!this.#closed) {
        this.#fail(
          new OmpRpcFaultError(
            "processExited",
            `Omp RPC exited (code=${code}, signal=${signal})`,
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
          () => reject(new Error("Omp RPC start timed out")),
          this.#options.commandTimeoutMs,
        ),
      ),
    ]);
    await Promise.race([
      this.#ready,
      new Promise<never>((_resolve, reject) =>
        setTimeout(
          () => reject(new Error("Omp RPC ready signal timed out")),
          this.#options.commandTimeoutMs,
        ),
      ),
    ]);
    await this.#send("negotiate_protocol", { protocolVersion: 2 }).catch(() => undefined);
    try {
      this.#state = parseSessionState(await this.#send("get_state", {}));
    } catch (error) {
      const fault =
        error instanceof OmpRpcFaultError
          ? error
          : new OmpRpcFaultError("unavailable", `Omp RPC state unavailable: ${message(error)}`);
      this.#fail(fault);
      throw fault;
    }
    return this;
  }

  async getEntries(): Promise<OmpSessionHistory> {
    try {
      if (this.state.sessionFile) {
        return await readOmpSessionHistory(this.state.sessionFile);
      }
      const response = await this.#send("get_messages", {});
      const data = isRecord(response.data) ? response.data : null;
      if (!data || !Array.isArray(data.messages)) {
        throw new OmpRpcFaultError("protocolError", "Omp RPC messages response has no messages");
      }
      let branchEntryIds: string[] | null = null;
      try {
        const branchResponse = await this.#send("get_branch_messages", {});
        const branchData = isRecord(branchResponse.data) ? branchResponse.data : null;
        if (branchData && Array.isArray(branchData.messages)) {
          const parsed = branchData.messages.flatMap((entry) => {
            if (!isRecord(entry) || !nonBlankString(entry.entryId)) return [];
            return [entry.entryId];
          });
          if (parsed.length === branchData.messages.length) branchEntryIds = parsed;
        }
      } catch (error) {
        if (!(error instanceof OmpRpcUnsupportedCommandError)) throw error;
      }
      let userIndex = 0;
      let parentId: string | null = null;
      const entries = data.messages.map((nativeMessage, index) => {
        const role = isRecord(nativeMessage) ? nativeMessage.role : undefined;
        const branchId = role === "user" ? branchEntryIds?.[userIndex] : undefined;
        if (branchId) userIndex += 1;
        const id =
          branchId ??
          (isRecord(nativeMessage) && nonBlankString(nativeMessage.id)
            ? nativeMessage.id
            : `omp-message-${index}`);
        const entry = { id, parentId, type: "message", message: nativeMessage } as JsonObject;
        parentId = id;
        return entry;
      });
      return { entries, leafId: parentId };
    } catch (error) {
      if (error instanceof OmpRpcFaultError) this.#fail(error);
      throw error;
    }
  }

  async getSubagentMessages(input: {
    subagentId?: string;
    sessionFile?: string;
    fromByte?: number;
  }): Promise<OmpSubagentMessagesResult> {
    if (
      (input.subagentId === undefined || !nonBlankString(input.subagentId)) &&
      (input.sessionFile === undefined || !nonBlankString(input.sessionFile))
    ) {
      throw new Error("Omp Subagent transcript requires a Subagent ID or Session file");
    }
    if (
      input.fromByte !== undefined &&
      (!Number.isSafeInteger(input.fromByte) || input.fromByte < 0)
    ) {
      throw new Error("Omp Subagent transcript offset is invalid");
    }
    const response = await this.#send("get_subagent_messages", {
      ...(input.subagentId ? { subagentId: input.subagentId } : {}),
      ...(input.sessionFile ? { sessionFile: input.sessionFile } : {}),
      ...(input.fromByte !== undefined ? { fromByte: input.fromByte } : {}),
    });
    return parseSubagentMessages(response);
  }

  async compact(
    customInstructions: string | undefined,
    onEvent: (event: OmpTurnEvent) => void,
  ): Promise<OmpCompactResult> {
    if (!this.#child || !this.#state || this.#closed || this.#failed) {
      throw new Error("Omp RPC Session is unavailable");
    }
    if (this.#activeTurn || this.#manualCompaction || this.#compactionActive) {
      throw new Error("Omp RPC Session already has an active operation");
    }

    const result = new Promise<OmpCompactResult>((resolve, reject) => {
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
      const usage = parseOmpSessionUsage(await this.#send("get_session_stats", {}));
      await this.#ensureLatestCacheHitRate();
      return this.#withLatestCacheHitRate(usage);
    } catch (error) {
      if (!(error instanceof OmpRpcUnsupportedCommandError)) throw error;
      const response = await this.#send("get_state", {});
      const observedState = parseSessionState(response);
      if (
        !this.#state ||
        observedState.sessionId !== this.#state.sessionId ||
        observedState.provider !== this.#state.provider ||
        observedState.modelId !== this.#state.modelId
      ) {
        throw new Error("Omp RPC Usage fallback does not match the confirmed Session state");
      }
      await this.#ensureLatestCacheHitRate();
      const usage = parseOmpStateContextUsage(response);
      return usage ? this.#withLatestCacheHitRate(usage) : null;
    }
  }

  async #ensureLatestCacheHitRate(): Promise<void> {
    if (this.#latestCacheHitRatePercent !== undefined) return;
    try {
      this.#latestCacheHitRatePercent = latestOmpCacheHitRatePercent(await this.getEntries());
    } catch {
      this.#latestCacheHitRatePercent = null;
    }
  }

  #withLatestCacheHitRate(usage: HostUsage): HostUsage {
    return this.#latestCacheHitRatePercent === null || this.#latestCacheHitRatePercent === undefined
      ? usage
      : parseHostUsage({ ...usage, cacheHitRatePercent: this.#latestCacheHitRatePercent });
  }

  async fork(entryId: string): Promise<OmpSessionState> {
    if (!nonBlankString(entryId)) throw new Error("Omp RPC Fork requires an Entry identity");
    try {
      const response = await this.#send("branch", { entryId });
      const data = isRecord(response.data) ? response.data : null;
      if (!data || data.cancelled === true) {
        throw new OmpRpcFaultError("unavailable", "Omp RPC Fork was cancelled");
      }
      this.#state = parseSessionState(await this.#send("get_state", {}));
      return this.#state;
    } catch (error) {
      if (error instanceof OmpRpcFaultError) this.#fail(error);
      throw error;
    }
  }

  verifySessionCwd(expectedCwd: string): Promise<void> {
    return verifyOmpSessionCwd({
      sessionFile: this.state.sessionFile,
      sessionId: this.state.sessionId,
      expectedCwd,
    });
  }

  async getAvailableModels(): Promise<OmpNativeModel[]> {
    try {
      return parseAvailableModels(await this.#send("get_available_models", {}));
    } catch (error) {
      if (error instanceof OmpRpcFaultError) this.#fail(error);
      throw error;
    }
  }

  async getAvailableThinkingLevels(): Promise<HarnessThinkingOptionId[] | null> {
    return this.state.availableThinkingLevels;
  }

  async selectModel(model: OmpNativeModelRef): Promise<OmpSessionState> {
    await this.#send("set_model", { provider: model.provider, modelId: model.id });
    return this.#refreshState("Model");
  }

  async selectThinkingOption(thinkingOptionId: HarnessThinkingOptionId): Promise<OmpSessionState> {
    const level = harnessThinkingOptionIdSchema.parse(thinkingOptionId);
    await this.#send("set_thinking_level", { level });
    return this.#refreshState("Thinking");
  }

  async #refreshState(operation: string): Promise<OmpSessionState> {
    try {
      this.#state = parseSessionState(await this.#send("get_state", {}));
      return this.#state;
    } catch (error) {
      const fault =
        error instanceof OmpRpcFaultError
          ? error
          : new OmpRpcFaultError(
              "protocolError",
              `Omp RPC ${operation} state could not be confirmed: ${message(error)}`,
            );
      this.#fail(fault);
      throw fault;
    }
  }

  async runTurn(text: string, onEvent: (event: OmpTurnEvent) => void): Promise<OmpTurnResult> {
    if (!this.#child || !this.#state || this.#closed || this.#failed) {
      throw new Error("Omp RPC Session is unavailable");
    }
    if (this.#activeTurn) throw new Error("Omp RPC Session already has an active Turn");
    if (text.length === 0) throw new Error("Omp text Turn must not be empty");

    const settled = new Promise<OmpTurnResult>((resolve, reject) => {
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

  async steer(text: string): Promise<void> {
    if (!this.#child || !this.#state || this.#closed || this.#failed) {
      throw new Error("Omp RPC Session is unavailable");
    }
    if (!this.#activeTurn) throw new Error("Omp RPC Session has no active Turn");
    if (text.length === 0) throw new Error("Omp steer input must not be empty");
    try {
      await this.#send("steer", { message: text });
    } catch (error) {
      if (error instanceof OmpRpcFaultError) throw error;
      throw new OmpRpcFaultError("protocolError", `Omp RPC Steer failed: ${message(error)}`);
    }
  }

  abort(): Promise<void> {
    const active = this.#activeTurn;
    if (!active || this.#closed || this.#failed) {
      return Promise.reject(new Error("Omp RPC Session has no cancellable Turn"));
    }
    if (active.abortPromise) return active.abortPromise;
    active.cancellation = "requesting";
    active.cancellationTimeout = setTimeout(() => {
      this.#terminateFailedCancellation(
        active,
        new OmpRpcFaultError(
          "protocolError",
          "Omp Turn cancellation did not settle within its bound",
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
          error instanceof OmpRpcFaultError
            ? error
            : new OmpRpcFaultError("protocolError", `Omp RPC Abort failed: ${message(error)}`);
        this.#terminateFailedCancellation(active, fault);
        throw fault;
      });
    active.abortPromise = aborting;
    return aborting;
  }

  #terminateFailedCancellation(active: ActiveTurn, fault: OmpRpcFaultError): void {
    if (this.#activeTurn !== active) return;
    if (active.cancellationTimeout) clearTimeout(active.cancellationTimeout);
    active.cancellationTimeout = null;
    this.#fail(fault);
    void this.close().catch(() => undefined);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#rejectAll(new Error("Omp RPC Session closed"));
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
      throw new Error("Omp RPC process tree did not exit within cleanup bounds");
    }
  }

  #push(chunk: Buffer<ArrayBufferLike>): void {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    let newline = this.#buffer.indexOf(0x0a);
    while (newline >= 0) {
      const frame = this.#buffer.subarray(0, newline);
      this.#buffer = this.#buffer.subarray(newline + 1);
      try {
        const decoded = this.#frameDecoder.push(JSON.parse(textDecoder.decode(frame)));
        if (decoded === null) {
          newline = this.#buffer.indexOf(0x0a);
          continue;
        }
        const value = decoded;
        if (!isRecord(value) || typeof value.type !== "string") {
          throw new OmpRpcFaultError("protocolError", "Omp RPC returned an invalid envelope");
        }
        this.#handle(value);
      } catch (error) {
        this.#fail(
          error instanceof OmpRpcFaultError
            ? error
            : new OmpRpcFaultError(
                "protocolError",
                `Omp RPC returned invalid JSONL: ${message(error)}`,
              ),
        );
      }
      newline = this.#buffer.indexOf(0x0a);
    }
  }

  #handle(value: Record<string, unknown>): void {
    if (this.#closed || this.#failed) return;
    if (value.type === "ready") {
      this.#readyResolve?.();
      this.#readyResolve = null;
      return;
    }
    if (value.type === "response") {
      this.#handleResponse(value);
      return;
    }
    if (value.type === "auto_compaction_start" || value.type === "compaction_start") {
      this.#compactionActive = true;
      this.#compactionTurn = this.#activeTurn;
      this.#compactionTimeout ??= setTimeout(() => {
        this.#compactionTimeout = null;
        this.#fail(
          new OmpRpcFaultError(
            "protocolError",
            `Omp RPC compaction timed out after ${this.#options.compactionTimeoutMs}ms`,
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
    if (value.type === "auto_compaction_end" || value.type === "compaction_end") {
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
      const event: OmpTurnEvent = {
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
    if (this.#handleSubagentFrame(active, value)) return;
    if (!active) {
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
          new Error("Omp assistant message failed");
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
    if (value.type === "agent_end" && Array.isArray(value.messages)) {
      for (let index = value.messages.length - 1; index >= 0; index -= 1) {
        const message = value.messages[index];
        if (!isRecord(message) || message.role !== "assistant") continue;
        this.#finalizeAssistantMessage(active, message);
        break;
      }
    }
    if (value.type === "agent_end" && value.isTerminal !== false) {
      if (active.settlement !== "pending") return;
      active.settlement = "confirming";
      void this.#confirmSettledTurn(active);
    }
  }

  #handleSubagentFrame(active: ActiveTurn | null, value: Record<string, unknown>): boolean {
    if (
      value.type !== "subagent_lifecycle" &&
      value.type !== "subagent_progress" &&
      value.type !== "subagent_event" &&
      value.type !== "process_lifecycle" &&
      value.type !== "process_event"
    ) {
      return false;
    }
    if (value.type === "process_lifecycle" || value.type === "process_event") {
      const payload = isRecord(value.payload) ? value.payload : null;
      const rawId = payload ? (payload.id ?? payload.processId ?? payload.name) : undefined;
      const processId =
        typeof rawId === "string" && rawId.trim().length > 0
          ? rawId.trim()
          : typeof rawId === "number" && Number.isFinite(rawId)
            ? String(rawId)
            : undefined;
      if (processId) {
        const emit = active?.onEvent ?? this.#options.onSubagentEvent;
        const rawStatus = typeof payload?.status === "string" ? payload.status.toLowerCase() : "";
        const status =
          rawStatus === "exited" ||
          rawStatus === "completed" ||
          rawStatus === "failed" ||
          rawStatus === "stopped" ||
          rawStatus === "terminated"
            ? "exited"
            : "running";
        const command = typeof payload?.command === "string" ? payload.command : undefined;
        const cwd = typeof payload?.cwd === "string" ? payload.cwd : undefined;
        const osPid = typeof payload?.osPid === "number" ? payload.osPid : undefined;
        emit?.({
          type: "process.state.changed",
          processId,
          status,
          ...(command ? { command } : {}),
          ...(cwd ? { cwd } : {}),
          ...(osPid !== undefined ? { osPid } : {}),
        });
        return true;
      }
      return false;
    }
    const payload = isRecord(value.payload) ? value.payload : null;
    const progressPayload =
      value.type === "subagent_progress" && payload && isRecord(payload.progress)
        ? payload.progress
        : null;
    const nativeIdValue = progressPayload?.id ?? payload?.id;
    if (!payload || !nonBlankString(nativeIdValue)) {
      throw new OmpRpcFaultError("protocolError", "Omp RPC Subagent frame has no stable ID");
    }
    const nativeSubagentId = nativeIdValue;
    const callId = nonBlankString(payload.parentToolCallId)
      ? payload.parentToolCallId
      : nativeSubagentId;
    const emit = active?.onEvent ?? this.#options.onSubagentEvent;
    const isProcess =
      isOmpProcessId(nativeSubagentId) ||
      isOmpProcessPayload(payload) ||
      isOmpProcessPayload(progressPayload);
    if (isProcess) {
      if (value.type === "subagent_lifecycle") {
        const rawStatus = typeof payload?.status === "string" ? payload.status.toLowerCase() : "";
        const status =
          rawStatus === "exited" ||
          rawStatus === "completed" ||
          rawStatus === "failed" ||
          rawStatus === "stopped" ||
          rawStatus === "terminated" ||
          rawStatus === "aborted"
            ? "exited"
            : "running";
        const command =
          (typeof payload?.command === "string" && payload.command.trim().length > 0
            ? payload.command.trim()
            : undefined) ??
          (typeof payload?.task === "string" && payload.task.trim().length > 0
            ? payload.task.trim()
            : undefined) ??
          (typeof payload?.description === "string" && payload.description.trim().length > 0
            ? payload.description.trim()
            : undefined) ??
          nativeSubagentId;
        const cwd = typeof payload?.cwd === "string" ? payload.cwd : undefined;
        const osPid = ompProcessOsPid(payload);
        emit?.({
          type: "process.state.changed",
          processId: nativeSubagentId,
          status,
          ...(command ? { command } : {}),
          ...(cwd ? { cwd } : {}),
          ...(osPid !== undefined ? { osPid } : {}),
        });
        return true;
      }
      if (value.type === "subagent_progress") {
        const rawStatus =
          typeof progressPayload?.status === "string" ? progressPayload.status.toLowerCase() : "";
        const status =
          rawStatus === "exited" ||
          rawStatus === "completed" ||
          rawStatus === "failed" ||
          rawStatus === "stopped" ||
          rawStatus === "terminated" ||
          rawStatus === "aborted"
            ? "exited"
            : "running";
        emit?.({
          type: "process.state.changed",
          processId: nativeSubagentId,
          status,
        });
        return true;
      }
      if (value.type === "subagent_event") {
        return true;
      }
    }
    if (value.type === "subagent_event") {
      emit?.({ type: "subagent.transcript.changed", callId, nativeSubagentId });
      return true;
    }
    if (value.type === "subagent_lifecycle") {
      const status = payload.status;
      if (status === "started") {
        const description = nonBlankString(payload.description)
          ? payload.description
          : nonBlankString(payload.agent)
            ? `${payload.agent} delegation`
            : "Subagent delegation";
        emit?.({
          type: "subagent.started",
          callId,
          nativeSubagentId,
          description,
          ...(nonBlankString(payload.agent) ? { role: payload.agent } : {}),
          ...(nonBlankString(payload.task) ? { prompt: payload.task } : {}),
          background:
            payload.detached === true ||
            payload.background === true ||
            payload.async === true ||
            payload.run_in_background === true,
          ...(typeof payload.sessionFile === "string" ? { sessionFile: payload.sessionFile } : {}),
        });
        return true;
      }
      if (status !== "completed" && status !== "failed" && status !== "aborted") {
        throw new OmpRpcFaultError("protocolError", "Omp RPC Subagent lifecycle status is invalid");
      }
      emit?.({
        type: "subagent.completed",
        callId,
        nativeSubagentId,
        isError: status !== "completed",
        ...(nonBlankString(payload.resultSummary) ? { resultSummary: payload.resultSummary } : {}),
        ...(typeof payload.sessionFile === "string" ? { sessionFile: payload.sessionFile } : {}),
      });
      return true;
    }
    const progress = progressPayload;
    if (!progress || !nonBlankString(progress.id) || progress.id !== nativeSubagentId) {
      throw new OmpRpcFaultError("protocolError", "Omp RPC Subagent progress is invalid");
    }
    const status = subagentStatus(progress.status);
    const recentOutput = Array.isArray(progress.recentOutput)
      ? progress.recentOutput.filter((item): item is string => typeof item === "string")
      : [];
    const resultSummary = recentOutput.at(-1);
    emit?.({
      type: "subagent.updated",
      callId,
      nativeSubagentId,
      status,
      ...(nonBlankString(progress.description)
        ? { description: progress.description }
        : nonBlankString(payload.task)
          ? { description: payload.task }
          : {}),
      ...(resultSummary !== undefined ? { resultSummary } : {}),
      ...(typeof payload.sessionFile === "string" ? { sessionFile: payload.sessionFile } : {}),
    });
    return true;
  }

  #handleResponse(value: Record<string, unknown>): void {
    const id = value.id;
    if (typeof id !== "string") {
      this.#fail(new OmpRpcFaultError("protocolError", "Omp RPC response has no id"));
      return;
    }
    const pending = this.#pending.get(id);
    if (!pending) {
      this.#fail(new OmpRpcFaultError("protocolError", "Omp RPC response id is not pending"));
      return;
    }
    if (pending.timeout) clearTimeout(pending.timeout);
    this.#pending.delete(id);
    if (value.success === true) pending.resolve(value);
    else {
      const error = typeof value.error === "string" ? value.error : "Omp RPC command failed";
      if (value.command === pending.command && error === `Unknown command: ${pending.command}`) {
        pending.reject(new OmpRpcUnsupportedCommandError(pending.command));
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
      throw new OmpRpcFaultError("protocolError", "Omp RPC returned an invalid Tool start");
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
    if (typeof callId !== "string" || callId.length === 0 || !active.tools.has(callId)) {
      return;
    }
    if (!Object.hasOwn(value, "partialResult") || value.partialResult === undefined) {
      return;
    }
    const outputResult = jsonValueSchema.safeParse(value.partialResult);
    if (!outputResult.success) {
      return;
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
      (value.isError !== undefined && typeof value.isError !== "boolean") ||
      !result.success
    ) {
      throw new OmpRpcFaultError("protocolError", "Omp RPC returned an invalid Tool end");
    }
    active.tools.delete(callId);
    active.onEvent({
      type: "tool.completed",
      callId,
      toolName,
      result: result.data,
      isError: value.isError === true,
    });
  }

  async #confirmSettledTurn(active: ActiveTurn): Promise<void> {
    try {
      const response = await this.#send("get_state", {});
      const state = parseSessionState(response);
      if (parseSessionStreaming(response)) {
        throw new OmpRpcFaultError("protocolError", "Omp RPC agent_end state is still Streaming");
      }
      if (this.#activeTurn !== active) return;
      this.#state = state;
      active.settlement = "confirmed";
      this.#finishSettledTurn(active);
    } catch (error) {
      if (this.#activeTurn !== active) return;
      const fault =
        error instanceof OmpRpcFaultError
          ? error
          : new OmpRpcFaultError(
              "protocolError",
              `Omp RPC stable Turn state could not be confirmed: ${message(error)}`,
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
    if (active.tools.size > 0) {
      this.#fail(
        new OmpRpcFaultError("protocolError", "Omp RPC settled with active Tool executions"),
      );
      return;
    }
    this.#activeTurn = null;
    if (active.cancellation === "accepted") {
      active.resolve({ text: active.text, cancelled: true });
    } else if (active.failure) {
      active.reject(active.failure);
    } else if (active.text.trim().length === 0 && !active.sawTool) {
      active.reject(new Error("Omp RPC settled without displayable output"));
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
    const cacheHitRatePercent = optionalOmpCacheHitRatePercent(value);
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
      return Promise.reject(new Error("Omp RPC stdin is unavailable"));
    }
    return new Promise((resolve, reject) => {
      const frame = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
      child.stdin.write(frame, (error) => (error ? reject(error) : resolve()));
    });
  }

  #send(type: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const child = this.#child;
    if (!child?.stdin.writable || this.#closed || this.#failed) {
      return Promise.reject(new Error("Omp RPC stdin is unavailable"));
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
      const error = new Error(`Omp RPC '${pending.command}' command timed out`);
      if (pending.command !== "prompt") {
        this.#pending.delete(id);
        pending.reject(error);
        return;
      }
      const fault = new OmpRpcFaultError("protocolError", error.message);
      void this.#terminateTimedOutPrompt(fault);
    }, this.#options.commandTimeoutMs);
  }

  async #terminateTimedOutPrompt(fault: OmpRpcFaultError): Promise<void> {
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
      finalFault = new OmpRpcFaultError(
        "processExited",
        `Omp RPC timed-out Prompt cleanup failed: ${message(error)}`,
      );
    }
    this.#rejectAll(finalFault);
    this.#options.onFault?.(finalFault);
  }

  #rejectActiveTurn(error: Error): void {
    const active = this.#activeTurn;
    if (!active) return;
    if (active.cancellationTimeout) clearTimeout(active.cancellationTimeout);
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

  #fail(error: OmpRpcFaultError): void {
    if (this.#closed || this.#failed) return;
    this.#failed = true;
    this.#rejectAll(error);
    this.#options.onFault?.(error);
  }
}
