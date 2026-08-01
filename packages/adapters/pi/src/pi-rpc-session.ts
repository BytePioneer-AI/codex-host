import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import path from "node:path";

import type { HostUsage } from "@codexhost/harness-adapter";
import {
  harnessThinkingOptionIdSchema,
  jsonValueSchema,
  type HarnessThinkingOptionId,
  type JsonObject,
  type JsonValue,
} from "@codexhost/shared-contracts";

import type { PiSessionHistory } from "./pi-history.js";
import {
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
  | { type: "text.delta"; delta: string }
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

export type PiRpcFaultKind = "notInstalled" | "unavailable" | "protocolError" | "processExited";

export class PiRpcFaultError extends Error {
  constructor(
    readonly kind: PiRpcFaultKind,
    message: string,
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
  turnTimeoutMs?: number;
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
  timeout: NodeJS.Timeout;
}

interface ActiveTurn {
  text: string;
  streamedMessageText: string;
  lastFinalizedMessageText: string | null;
  onEvent(event: PiTurnEvent): void;
  resolve(value: PiTurnResult): void;
  reject(error: Error): void;
  timeout: NodeJS.Timeout;
  failure: Error | null;
  sawTool: boolean;
  tools: Map<string, string>;
  interactions: Map<string, { request: PiInteractionRequest; timeout: NodeJS.Timeout | null }>;
  settled: boolean;
  cancellation: "none" | "requesting" | "accepted";
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

function parseSessionState(response: Record<string, unknown>): PiSessionState {
  const data = isRecord(response.data) ? response.data : null;
  if (!data) throw new PiRpcFaultError("protocolError", "Pi RPC state response has no data");
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
  isFile(filePath: string): boolean;
}

function environmentValue(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  return Object.entries(environment).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}

function isRegularFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function resolveWindowsCommand(
  command: string,
  environment: NodeJS.ProcessEnv,
  isFile: (filePath: string) => boolean,
): string {
  if (path.win32.isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    return command;
  }
  const extensions = path.win32.extname(command)
    ? [""]
    : (environmentValue(environment, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD")
        .split(";")
        .map((extension) => extension.trim())
        .filter((extension) => extension.length > 0);
  const pathValue = environmentValue(environment, "PATH");
  if (!pathValue) return command;
  for (const rawDirectory of pathValue.split(path.win32.delimiter)) {
    const directory = rawDirectory.trim().replace(/^"|"$/gu, "");
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = path.win32.join(directory, `${command}${extension}`);
      if (isFile(candidate)) return candidate;
    }
  }
  return command;
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
  const selectedCommand = options.command ?? options.environment.PI_COMMAND ?? "pi";
  const command =
    platform === "win32"
      ? resolveWindowsCommand(
          selectedCommand,
          options.environment,
          dependencies.isFile ?? isRegularFile,
        )
      : selectedCommand;
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
    Pick<PiRpcSessionOptions, "commandTimeoutMs" | "turnTimeoutMs" | "closeTimeoutMs">
  > &
    PiRpcSessionOptions;
  readonly #processAdapter: PiRpcProcessAdapter;
  #activeTurn: ActiveTurn | null = null;
  #buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  #child: ChildProcessWithoutNullStreams | null = null;
  #closed = false;
  #failed = false;
  #pending = new Map<string, PendingCommand>();
  #state: PiSessionState | null = null;

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
      turnTimeoutMs: 180_000,
      closeTimeoutMs: 2_000,
      ...options,
    };
    this.#processAdapter = processAdapter;
  }

  get state(): PiSessionState {
    if (!this.#state) throw new Error("Pi RPC Session has not started");
    return this.#state;
  }

  async start(): Promise<this> {
    if (this.#child || this.#closed) throw new Error("Pi RPC Session cannot be started twice");
    const child = this.#processAdapter.spawn({
      cwd: this.#options.cwd,
      ...(this.#options.command ? { command: this.#options.command } : {}),
      environment: {
        ...process.env,
        ...this.#options.environment,
        PI_SKIP_VERSION_CHECK: "1",
        PI_TELEMETRY: "0",
      },
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
    child.stderr.resume();
    child.once("error", (error) => {
      const kind = isRecord(error) && error.code === "ENOENT" ? "notInstalled" : "unavailable";
      this.#fail(new PiRpcFaultError(kind, `Pi RPC failed to start: ${error.message}`));
    });
    child.once("exit", (code, signal) => {
      if (!this.#closed) {
        this.#fail(
          new PiRpcFaultError("processExited", `Pi RPC exited (code=${code}, signal=${signal})`),
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

  async getSessionUsage(): Promise<HostUsage | null> {
    try {
      return parsePiSessionUsage(await this.#send("get_session_stats", {}));
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
      return parsePiStateContextUsage(response);
    }
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
      const timeout = setTimeout(() => {
        this.#fail(new PiRpcFaultError("protocolError", "Pi Turn timed out"));
      }, this.#options.turnTimeoutMs);
      this.#activeTurn = {
        text: "",
        streamedMessageText: "",
        lastFinalizedMessageText: null,
        onEvent,
        resolve,
        reject,
        timeout,
        failure: null,
        sawTool: false,
        tools: new Map(),
        interactions: new Map(),
        settled: false,
        cancellation: "none",
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
    const aborting = this.#send("abort", {})
      .then(() => {
        if (this.#activeTurn !== active) return;
        active.cancellation = "accepted";
        this.#finishSettledTurn(active);
      })
      .catch((error: unknown) => {
        if (this.#activeTurn === active) {
          active.cancellation = "none";
          this.#finishSettledTurn(active);
        }
        throw error;
      });
    active.abortPromise = aborting;
    return aborting;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#rejectAll(new Error("Pi RPC Session closed"));
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
    if (value.type === "response") {
      this.#handleResponse(value);
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
      active.streamedMessageText = "";
      return;
    }
    if (value.type === "message_update" && isRecord(value.assistantMessageEvent)) {
      const event = value.assistantMessageEvent;
      if (event.type === "text_delta" && typeof event.delta === "string") {
        active.text += event.delta;
        active.streamedMessageText += event.delta;
        active.onEvent({ type: "text.delta", delta: event.delta });
      } else if (event.type === "error") {
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
      active.settled = true;
      this.#finishSettledTurn(active);
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
    clearTimeout(pending.timeout);
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

  #finishSettledTurn(active: ActiveTurn): void {
    if (this.#activeTurn !== active || !active.settled || active.cancellation === "requesting") {
      return;
    }
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
    clearTimeout(active.timeout);
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

  #finalizeAssistantMessage(active: ActiveTurn, value: unknown): void {
    const finalText = assistantText(value);
    const failure = assistantFailure(value);
    if (finalText === null || failure === undefined) return;
    active.failure = failure;
    if (finalText === active.lastFinalizedMessageText && active.streamedMessageText.length === 0) {
      return;
    }
    const missingText = finalText.startsWith(active.streamedMessageText)
      ? finalText.slice(active.streamedMessageText.length)
      : active.streamedMessageText.length === 0
        ? finalText
        : null;
    if (missingText === null) {
      active.text = active.text.slice(0, -active.streamedMessageText.length) + finalText;
    } else if (missingText.length > 0) {
      active.text += missingText;
      active.onEvent({ type: "text.delta", delta: missingText });
    }
    active.streamedMessageText = "";
    active.lastFinalizedMessageText = finalText;
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
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Pi RPC '${type}' command timed out`));
      }, this.#options.commandTimeoutMs);
      this.#pending.set(id, { command: type, resolve, reject, timeout });
      const frame = Buffer.from(`${JSON.stringify({ id, type, ...payload })}\n`, "utf8");
      child.stdin.write(frame, (error) => {
        if (error) {
          clearTimeout(timeout);
          this.#pending.delete(id);
          reject(error);
        }
      });
    });
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
    clearTimeout(active.timeout);
    this.#closeInteractions(active, "cancelled");
    this.#activeTurn = null;
    active.reject(error);
  }

  #rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
    this.#rejectActiveTurn(error);
  }

  #fail(error: PiRpcFaultError): void {
    if (this.#closed || this.#failed) return;
    this.#failed = true;
    this.#rejectAll(error);
    this.#options.onFault?.(error);
  }
}
