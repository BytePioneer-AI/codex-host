import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";

import {
  HarnessOutputChannel,
  type HarnessAdapter,
  type HarnessError,
  type HarnessInspection,
  type HarnessModelRef,
  type HarnessResult,
  type HarnessSession,
  type HarnessSessionCapabilities,
  type HarnessSessionState,
  type HarnessOutput,
  type HostEvent,
  type HostAgentMessageItem,
  type HostCommand,
  type HostItemSnapshot,
  type HostThreadSnapshot,
  type HostTurnSnapshot,
  type InspectHarnessInput,
  type InteractionRespondAccepted,
  type InteractionRespondCommand,
  type ModelSelectCompleted,
  type ModelSelectCommand,
  type OpenSessionInput,
  type PermissionModeSelectCommand,
  type PermissionModeSelectCompleted,
  type ThinkingSelectCommand,
  type ThinkingSelectCompleted,
  type TurnCancelAccepted,
  type TurnCancelCommand,
  type TurnCompletedEvent,
  type TurnOutcome,
  type TurnStartAccepted,
  type TurnStartCommand,
} from "@codexhost/harness-adapter";
import { commandInvocation } from "@codexhost/harness-discovery";
import {
  harnessIdSchema,
  hostItemIdSchema,
  nativeSessionRefSchema,
  nativeTurnRefSchema,
  type HarnessId,
  type NativeSessionRef,
} from "@codexhost/shared-contracts";

import { resolveHmHarnessExecutable } from "./command.js";
import {
  decodeHmHarnessModelRef,
  normalizeHmHarnessModelCatalog,
  parseHmHarnessProviderCatalog,
} from "./model-catalog.js";

const hmHarnessId = harnessIdSchema.parse("hmharness");
const DEFAULT_BRIDGE_TIMEOUT_MS = 10_000;
const DEFAULT_TURN_TIMEOUT_MS = 15 * 60_000;

const HMHARNESS_CAPABILITIES: HarnessSessionCapabilities = {
  configuration: {
    selectModel: true,
    selectThinkingOption: false,
    selectPermissionMode: false,
    permissionModeScope: "live",
  },
  history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
};

class HMHarnessBridgeError extends Error {
  constructor(
    message: string,
    readonly harnessError: Omit<HarnessError, "message"> & { message: string },
  ) {
    super(message);
    this.name = "HMHarnessBridgeError";
  }
}

export interface HMHarnessBridgeResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
}

export interface HMHarnessBridgeInput {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly stdin?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
  /** Streaming hook: invoked per complete stdout line while the process runs. */
  readonly onStdoutLine?: (line: string) => void;
}

export type HMHarnessBridgeRunner = (input: HMHarnessBridgeInput) => Promise<HMHarnessBridgeResult>;

export interface HMHarnessAdapterOptions {
  readonly command?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly inspectTimeoutMs?: number;
  readonly turnTimeoutMs?: number;
}

export interface HMHarnessAdapterDependencies {
  readonly randomUUID?: () => string;
  readonly runBridge?: HMHarnessBridgeRunner;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeBridgeError(error: unknown, fallbackCode: HarnessError["code"]): HarnessError {
  if (error instanceof HMHarnessBridgeError) return error.harnessError;
  const message = errorMessage(error);
  return {
    code: /ENOENT|not (?:recognized|found)/iu.test(message) ? "notInstalled" : fallbackCode,
    message,
    retryable: fallbackCode === "unavailable" || fallbackCode === "nativeFailure",
  };
}

function invalidState(message: string): HarnessError {
  return { code: "invalidState", message, retryable: false };
}

function unsupported(message: string): HarnessError {
  return { code: "unsupported", message, retryable: false };
}

function parseBridgeJson(stdout: string): Record<string, unknown> {
  const line = stdout
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .at(-1);
  if (!line)
    throw new HMHarnessBridgeError("HMHarness returned an empty result", {
      code: "protocolError",
      message: "HMHarness returned an empty result",
      retryable: false,
    });
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== "object" || parsed === null) throw new Error("invalid root");
    return parsed as Record<string, unknown>;
  } catch {
    throw new HMHarnessBridgeError("HMHarness returned malformed JSON", {
      code: "protocolError",
      message: "HMHarness returned malformed JSON",
      retryable: false,
    });
  }
}

async function processBridgeRunner(input: HMHarnessBridgeInput): Promise<HMHarnessBridgeResult> {
  const invocation = commandInvocation(input.executable, input.arguments, input.environment);
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.arguments, {
      cwd: input.cwd,
      env: input.environment,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      ...(invocation.windowsVerbatimArguments
        ? { windowsVerbatimArguments: invocation.windowsVerbatimArguments }
        : {}),
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutTail = "";
    let settled = false;
    const cancel = (code: HarnessError["code"], message: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.pid && process.platform === "win32") {
        spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true });
      } else {
        child.kill("SIGTERM");
      }
      reject(
        new HMHarnessBridgeError(message, { code, message, retryable: code !== "notInstalled" }),
      );
    };
    const timer = setTimeout(
      () => cancel("unavailable", `HMHarness command timed out after ${input.timeoutMs}ms`),
      input.timeoutMs,
    );
    const abort = (): void => cancel("processExited", "HMHarness command was cancelled");
    input.signal?.addEventListener("abort", abort, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
      if (!input.onStdoutLine) return;
      // NDJSON: forward every complete line the moment it arrives; the last
      // (possibly unterminated) line stays buffered and is handled at close.
      stdoutTail += chunk.toString("utf8");
      const lines = stdoutTail.split("\n");
      stdoutTail = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) {
          if (trimmed.charCodeAt(0) === 123 && !/"type"\s*:/.test(trimmed)) armExitWatchdog();
          input.onStdoutLine(trimmed);
        }
      }
    });
    let finalLineSeen = false;
    let exitWatchdog: ReturnType<typeof setTimeout> | null = null;
    const armExitWatchdog = (): void => {
      if (finalLineSeen || !input.onStdoutLine) return;
      finalLineSeen = true;
      exitWatchdog = setTimeout(() => {
        if (settled) return;
        if (child.pid && process.platform === "win32") {
          spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true });
        } else {
          child.kill("SIGKILL");
        }
      }, 5_000);
      exitWatchdog.unref?.();
    };
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error) => cancel("notInstalled", errorMessage(error)));
    child.once("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (exitWatchdog) clearTimeout(exitWatchdog);
      input.signal?.removeEventListener("abort", abort);
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode,
      });
    });
    child.stdin?.once("error", () => child.stdin?.destroy());
    if (input.stdin === undefined) child.stdin?.end();
    else child.stdin?.end(input.stdin);
  });
}

function bridgeEnvironment(
  environment: NodeJS.ProcessEnv,
  cwd: string,
  provider?: string,
): NodeJS.ProcessEnv {
  return {
    ...environment,
    HMH_DISABLE_MCP: "1",
    HMH_QUIET: "1",
    NO_COLOR: "1",
    ...(provider ? { HMH_CHAT_PROVIDER: provider } : {}),
    __CODEXHOST_HMHARNESS_CWD: cwd,
  };
}

function stateFor(
  model: HarnessModelRef | undefined,
  nativeRef: NativeSessionRef,
): HarnessSessionState {
  return {
    nativeRef,
    ...(model ? { effectiveModel: model } : {}),
  };
}

function conversationPrompt(turns: readonly HostTurnSnapshot[], current: string): string {
  if (turns.length === 0) return current;
  const transcript = turns
    .flatMap((turn) => {
      const input = turn.input.map(({ text }) => `USER:\n${text}`).join("\n\n");
      const output = turn.items
        .map(({ item }) => (item.type === "agentMessage" ? `ASSISTANT:\n${item.text}` : null))
        .filter((entry): entry is string => entry !== null)
        .join("\n\n");
      return [input, output].filter(Boolean).join("\n\n");
    })
    .join("\n\n---\n\n");
  return [
    "Continue this HMHarness conversation. Use the prior transcript only as context.",
    "<prior_transcript>",
    transcript,
    "</prior_transcript>",
    "<current_user_message>",
    current,
    "</current_user_message>",
  ].join("\n\n");
}

interface ActiveTurn {
  readonly command: TurnStartCommand;
  readonly abort: AbortController;
  completion: Promise<void>;
}

class HMHarnessSession implements HarnessSession {
  readonly harnessId: HarnessId = hmHarnessId;
  readonly capabilities = HMHARNESS_CAPABILITIES;
  readonly initialState: HarnessSessionState;
  readonly initialUsage = null;
  readonly outputs: AsyncIterable<HarnessOutput>;
  readonly #channel = new HarnessOutputChannel<HarnessOutput>();
  readonly #adapter: HMHarnessAdapter;
  readonly #bridge: HMHarnessBridgeRunner;
  readonly #cwd: string;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #executable: string;
  readonly #uuid: () => string;
  readonly #nativeRef: NativeSessionRef;
  readonly #turnTimeoutMs: number;
  readonly #onClosed: () => void;
  #active: ActiveTurn | null = null;
  #closed = false;
  #closePromise: Promise<void> | null = null;
  #model: HarnessModelRef | undefined;
  #snapshot: HostThreadSnapshot;
  #state: HarnessSessionState;

  constructor(input: {
    adapter: HMHarnessAdapter;
    bridge: HMHarnessBridgeRunner;
    cwd: string;
    environment: NodeJS.ProcessEnv;
    executable: string;
    model?: HarnessModelRef;
    randomUUID: () => string;
    turnTimeoutMs: number;
    onClosed: () => void;
  }) {
    this.#adapter = input.adapter;
    this.#bridge = input.bridge;
    this.#cwd = input.cwd;
    this.#environment = input.environment;
    this.#executable = input.executable;
    this.#uuid = input.randomUUID;
    this.#turnTimeoutMs = input.turnTimeoutMs;
    this.#onClosed = input.onClosed;
    this.#model = input.model;
    this.#nativeRef = nativeSessionRefSchema.parse({
      harnessId: hmHarnessId,
      nativeSessionId: input.randomUUID(),
      formatVersion: 1,
    });
    this.#state = stateFor(this.#model, this.#nativeRef);
    this.initialState = this.#state;
    this.#snapshot = { turns: [], state: this.#state };
    this.outputs = this.#channel.outputs;
  }

  async readSnapshot(): Promise<HarnessResult<HostThreadSnapshot>> {
    if (this.#closed) return { ok: false, error: invalidState("HMHarness Session is closed") };
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
    if (this.#closed) return { ok: false, error: invalidState("HMHarness Session is closed") };
    if (command.type === "turn.cancel") return this.#cancel(command);
    if (command.type === "model.select") return this.#selectModel(command);
    if (command.type === "thinking.select") {
      return { ok: false, error: unsupported("HMHarness has no Thinking options") };
    }
    if (command.type === "permissionMode.select") {
      return { ok: false, error: unsupported("HMHarness Permission Modes are not selectable") };
    }
    if (command.type === "interaction.respond") {
      return { ok: false, error: unsupported("HMHarness one-shot turns have no Interactions") };
    }
    if (this.#active) {
      return {
        ok: false,
        error: { code: "sessionBusy", message: "HMHarness Turn is active", retryable: true },
      };
    }
    const text = command.input.map(({ text: part }) => part).join("\n");
    if (!text.trim()) {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "HMHarness Turn must not be empty",
          retryable: false,
        },
      };
    }
    const active: ActiveTurn = {
      command,
      abort: new AbortController(),
      completion: Promise.resolve(),
    };
    this.#active = active;
    this.#event({ type: "turn.started", turnId: command.turnId });
    active.completion = this.#runTurn(active, conversationPrompt(this.#snapshot.turns, text))
      .catch(() => undefined)
      .finally(() => {
        if (this.#active === active) this.#active = null;
      });
    return { ok: true, value: { turnId: command.turnId } };
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#close();
    return this.#closePromise;
  }

  async #close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#active?.abort.abort();
    await this.#active?.completion;
    this.#channel.end();
    this.#onClosed();
  }

  #cancel(command: TurnCancelCommand): HarnessResult<TurnCancelAccepted> {
    const active = this.#active;
    if (!active || active.command.turnId !== command.turnId) {
      return { ok: false, error: invalidState("HMHarness cancellation has no active Turn") };
    }
    active.abort.abort();
    return { ok: true, value: { cancellationRequested: true } };
  }

  #selectModel(command: ModelSelectCommand): HarnessResult<ModelSelectCompleted> {
    if (this.#active) {
      return {
        ok: false,
        error: { code: "sessionBusy", message: "HMHarness Turn is active", retryable: true },
      };
    }
    const native = decodeHmHarnessModelRef(command.model);
    if (native.provider.includes("\u0000") || native.model.includes("\u0000")) {
      return {
        ok: false,
        error: { code: "invalidRequest", message: "HMHarness Model is invalid", retryable: false },
      };
    }
    this.#model = command.model;
    this.#state = stateFor(this.#model, this.#nativeRef);
    this.#snapshot = { ...this.#snapshot, state: this.#state };
    this.#event({ type: "session.state.changed", state: this.#state });
    return { ok: true, value: { completed: true } };
  }

  async #runTurn(active: ActiveTurn, prompt: string): Promise<void> {
    const nativeModel = this.#model ? decodeHmHarnessModelRef(this.#model) : undefined;
    // Streaming state: the bridge emits NDJSON progress lines (type: "delta")
    // while the agent loop runs and one final result object as the last line.
    // Deltas stream into the UI as item.started + text.append; the final line
    // remains the source of truth for the completed snapshot.
    let streamItemId: ReturnType<typeof hostItemIdSchema.parse> | undefined;
    let streamText = "";
    const appendStreamDelta = (text: string): void => {
      if (!text) return;
      if (!streamItemId) {
        streamItemId = hostItemIdSchema.parse(`hmharness-agent:${this.#uuid()}`);
        this.#event({
          type: "item.started",
          turnId: active.command.turnId,
          item: { type: "agentMessage", itemId: streamItemId, text },
        });
        streamText = text;
        return;
      }
      streamText += text;
      this.#event({
        type: "item.updated",
        turnId: active.command.turnId,
        itemId: streamItemId,
        update: { type: "text.append", text },
      });
    };
    const handleStreamLine = (line: string): void => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return; // non-JSON progress line (older bridge) - ignore
      }
      if (typeof parsed !== "object" || parsed === null) return;
      const record = parsed as { type?: unknown; text?: unknown };
      if (record.type === "delta" && typeof record.text === "string") {
        appendStreamDelta(record.text);
      }
      // "line" / "tool" progress events carry no UI contract yet - dropped.
    };
    try {
      const result = await this.#bridge({
        executable: this.#executable,
        arguments: ["run"],
        cwd: this.#cwd,
        environment: {
          ...bridgeEnvironment(this.#environment, this.#cwd, nativeModel?.provider),
          HMH_CODEXHOST_STREAM: "1",
        },
        stdin: prompt,
        signal: active.abort.signal,
        timeoutMs: this.#turnTimeoutMs,
        onStdoutLine: handleStreamLine,
      });
      if (result.exitCode !== 0) {
        throw new HMHarnessBridgeError(
          `HMHarness command failed with exit code ${result.exitCode ?? "signal"}`,
          {
            code: "nativeFailure",
            message: `HMHarness command failed with exit code ${result.exitCode ?? "signal"}`,
            retryable: true,
            ...(result.stderr ? { stderrTail: result.stderr.slice(-4000) } : {}),
          },
        );
      }
      const parsed = parseBridgeJson(result.stdout);
      if (typeof parsed.text !== "string") {
        throw new HMHarnessBridgeError("HMHarness result has no text", {
          code: "protocolError",
          message: "HMHarness result has no text",
          retryable: false,
        });
      }
      this.#succeedTurn(active, parsed.text, streamItemId, streamText);
    } catch (error) {
      const normalized = normalizeBridgeError(error, "nativeFailure");
      this.#failOrCancelTurn(active, normalized, streamItemId, streamText);
    }
  }

  #succeedTurn(
    active: ActiveTurn,
    text: string,
    streamItemId?: ReturnType<typeof hostItemIdSchema.parse>,
    streamText?: string,
  ): void {
    // When the final text extends the streamed text exactly, keep the one
    // streamed item; otherwise emit a fresh final item (the UI replaces it).
    if (streamItemId !== undefined && text === (streamText ?? "\u0000")) {
      const item: HostAgentMessageItem = { type: "agentMessage", itemId: streamItemId, text };
      const snapshot: HostItemSnapshot = { item, outcome: { status: "succeeded" } };
      this.#event({
        type: "item.completed",
        turnId: active.command.turnId,
        snapshot,
      });
      this.#completeTurn(active, { status: "succeeded" }, [snapshot]);
      return;
    }
    if (streamItemId !== undefined) {
      // The streamed item is the same logical message: close IT with the
      // authoritative final text instead of opening a ghost duplicate and
      // leaving the streamed one forever "in progress" (which read as the
      // turn never finishing in the UI).
      const closed: HostAgentMessageItem = { type: "agentMessage", itemId: streamItemId, text };
      const closedSnapshot: HostItemSnapshot = { item: closed, outcome: { status: "succeeded" } };
      this.#event({
        type: "item.completed",
        turnId: active.command.turnId,
        snapshot: closedSnapshot,
      });
      this.#completeTurn(active, { status: "succeeded" }, [closedSnapshot]);
      return;
    }
    const itemId = hostItemIdSchema.parse(`hmharness-agent:${this.#uuid()}`);
    const item: HostAgentMessageItem = { type: "agentMessage", itemId, text };
    this.#event({ type: "item.started", turnId: active.command.turnId, item });
    const snapshot: HostItemSnapshot = { item, outcome: { status: "succeeded" } };
    this.#event({
      type: "item.completed",
      turnId: active.command.turnId,
      snapshot,
    });
    this.#completeTurn(active, { status: "succeeded" }, [snapshot]);
  }

  #failOrCancelTurn(
    active: ActiveTurn,
    error: HarnessError,
    streamItemId?: ReturnType<typeof hostItemIdSchema.parse>,
    streamText?: string,
  ): void {
    const cancelled = active.abort.signal.aborted;
    // Close any streamed item so the UI is not left with a dangling bubble:
    // partial text is preserved in the failed/cancelled snapshot.
    if (streamItemId) {
      const item: HostAgentMessageItem = {
        type: "agentMessage",
        itemId: streamItemId,
        text: streamText ?? "",
      };
      const snapshot: HostItemSnapshot = {
        item,
        outcome: cancelled
          ? { status: "cancelled", reason: "Cancelled by user" }
          : { status: "failed", error },
      };
      this.#event({
        type: "item.completed",
        turnId: active.command.turnId,
        snapshot,
      });
      this.#completeTurn(
        active,
        cancelled
          ? { status: "cancelled", reason: "Cancelled by user" }
          : { status: "failed", error },
        [snapshot],
      );
      return;
    }
    this.#completeTurn(
      active,
      cancelled
        ? { status: "cancelled", reason: "Cancelled by user" }
        : { status: "failed", error },
      [],
    );
  }

  #completeTurn(
    active: ActiveTurn,
    outcome: TurnOutcome,
    items: readonly HostItemSnapshot[],
  ): void {
    const nativeTurnRef = nativeTurnRefSchema.parse({
      harnessId: hmHarnessId,
      nativeSessionId: this.#nativeRef.nativeSessionId,
      nativeTurnKey: `turn:${active.command.turnId}`,
      formatVersion: 1,
    });
    const snapshot: HostTurnSnapshot = {
      nativeTurnRef,
      input: active.command.input,
      items: [...items],
      outcome:
        outcome.status === "failed"
          ? { status: "failed", error: outcome.error }
          : outcome.status === "cancelled"
            ? { status: "cancelled", ...(outcome.reason ? { reason: outcome.reason } : {}) }
            : { status: "succeeded" },
      ...(this.#model ? { model: this.#model } : {}),
    };
    this.#snapshot = { ...this.#snapshot, turns: [...this.#snapshot.turns, snapshot] };
    const event: TurnCompletedEvent = {
      type: "turn.completed",
      turnId: active.command.turnId,
      nativeTurnRef,
      outcome,
    };
    this.#event(event);
  }

  #event(event: HostEvent): void {
    this.#channel.emit({ kind: "event", event });
  }
}

export class HMHarnessAdapter implements HarnessAdapter {
  readonly harnessId: HarnessId = hmHarnessId;
  readonly #options: HMHarnessAdapterOptions;
  readonly #runBridge: HMHarnessBridgeRunner;
  readonly #uuid: () => string;
  readonly #sessions = new Set<HMHarnessSession>();
  #closed = false;
  #closePromise: Promise<void> | null = null;
  #inspectionCache = new Map<string, HarnessInspection>();
  #inspectionInFlight = new Map<string, Promise<HarnessInspection>>();

  constructor(
    options: HMHarnessAdapterOptions = {},
    dependencies: HMHarnessAdapterDependencies = {},
  ) {
    this.#options = options;
    this.#runBridge = dependencies.runBridge ?? processBridgeRunner;
    this.#uuid = dependencies.randomUUID ?? randomUUID;
  }

  async inspect(input: InspectHarnessInput = {}): Promise<HarnessInspection> {
    if (this.#closed)
      return { status: "unavailable", error: invalidState("HMHarness Adapter is closed") };
    const cwd = path.resolve(input.cwd ?? process.cwd());
    if (!input.refresh) {
      const cached = this.#inspectionCache.get(cwd);
      if (cached) return cached;
    }
    const inFlight = this.#inspectionInFlight.get(cwd);
    if (inFlight) return inFlight;
    const inspection = this.#inspectCwd(cwd).finally(() => {
      if (this.#inspectionInFlight.get(cwd) === inspection) this.#inspectionInFlight.delete(cwd);
    });
    this.#inspectionInFlight.set(cwd, inspection);
    return inspection;
  }

  async #inspectCwd(cwd: string): Promise<HarnessInspection> {
    const executable = resolveHmHarnessExecutable({
      ...(this.#options.command ? { command: this.#options.command } : {}),
      environment: this.#options.environment ?? process.env,
    });
    if (!executable) {
      return {
        status: "notInstalled",
        error: {
          code: "notInstalled",
          message: "HMHarness bridge (hmh-codexhost) is not installed",
          retryable: false,
        },
      };
    }
    try {
      const result = await this.#runBridge({
        executable,
        arguments: ["providers", "--json"],
        cwd,
        environment: bridgeEnvironment(this.#options.environment ?? process.env, cwd),
        timeoutMs: this.#options.inspectTimeoutMs ?? DEFAULT_BRIDGE_TIMEOUT_MS,
      });
      if (result.exitCode !== 0) {
        throw new HMHarnessBridgeError("HMHarness provider inspection failed", {
          code: "unavailable",
          message: "HMHarness provider inspection failed",
          retryable: true,
          ...(result.stderr ? { stderrTail: result.stderr.slice(-4000) } : {}),
        });
      }
      const inspection: HarnessInspection = {
        status: "ready",
        catalog: normalizeHmHarnessModelCatalog(parseHmHarnessProviderCatalog(result.stdout)),
        capabilities: HMHARNESS_CAPABILITIES,
      };
      this.#inspectionCache.set(cwd, inspection);
      return inspection;
    } catch (error) {
      return {
        status: "error",
        error: { ...normalizeBridgeError(error, "unavailable"), stage: "model-catalog" },
      };
    }
  }

  async open(input: OpenSessionInput): Promise<HarnessResult<HMHarnessSession>> {
    if (this.#closed) return { ok: false, error: invalidState("HMHarness Adapter is closed") };
    if (input.kind !== "create") {
      return { ok: false, error: unsupported("HMHarness supports only fresh Sessions") };
    }
    const executable = resolveHmHarnessExecutable({
      ...(this.#options.command ? { command: this.#options.command } : {}),
      environment: this.#options.environment ?? process.env,
    });
    if (!executable) {
      return {
        ok: false,
        error: {
          code: "notInstalled",
          message: "HMHarness bridge (hmh-codexhost) is not installed",
          retryable: false,
        },
      };
    }
    if (input.model) {
      const inspection = await this.inspect({ cwd: input.cwd });
      if (
        inspection.status !== "ready" ||
        !inspection.catalog.models.some(({ ref }) => ref.id === input.model?.id)
      ) {
        return {
          ok: false,
          error: {
            code: "invalidRequest",
            message: "Requested HMHarness Model is absent from its provider catalog",
            retryable: false,
          },
        };
      }
    }
    const session = new HMHarnessSession({
      adapter: this,
      bridge: this.#runBridge,
      cwd: path.resolve(input.cwd),
      environment: { ...(this.#options.environment ?? process.env), ...(input.environment ?? {}) },
      executable,
      ...(input.model ? { model: input.model } : {}),
      randomUUID: this.#uuid,
      turnTimeoutMs: this.#options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
      onClosed: () => this.#sessionClosed(session),
    });
    this.#sessions.add(session);
    return { ok: true, value: session };
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#close();
    return this.#closePromise;
  }

  async #close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await Promise.all([...this.#sessions].map((session) => session.close()));
  }

  #sessionClosed(session: HMHarnessSession): void {
    this.#sessions.delete(session);
  }
}
