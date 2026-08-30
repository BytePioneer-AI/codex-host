import { spawn, type ChildProcessByStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import readline from "node:readline";
import type { Readable } from "node:stream";

import {
  HarnessOutputChannel,
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
  type HostAgentMessageItem,
  type HostCommand,
  type HostEvent,
  type HostItem,
  type HostItemOutcome,
  type HostItemSnapshot,
  type HostThreadSnapshot,
  type HostToolExecutionItem,
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
  harnessModelCatalogSchema,
  harnessModelRefSchema,
  hostItemIdSchema,
  nativeSessionRefSchema,
  nativeTurnRefSchema,
  type HarnessId,
  type HarnessPermissionModeId,
  type HostItemId,
  type JsonValue,
  type NativeSessionRef,
  type NativeTurnRef,
} from "@codexhost/shared-contracts";

import { resolveAntigravityExecutable } from "./command.js";
import {
  ANTIGRAVITY_PERMISSION_MODE_CATALOG,
  decodeAntigravityPermissionModeId,
  type AntigravityPermissionMode,
} from "./permission-modes.js";

export interface AntigravityAdapterOptions {
  command?: string;
  environment?: NodeJS.ProcessEnv;
  inspectTimeoutMs?: number;
  printTimeout?: string;
  toolOutputLimit?: number;
}

interface AntigravityUsage {
  input_tokens?: unknown;
  output_tokens?: unknown;
  thinking_tokens?: unknown;
  cache_read_tokens?: unknown;
  total_tokens?: unknown;
}

interface AntigravityInitEvent {
  event: "init";
  conversation_id: string;
  init?: { permission_mode?: string };
}

interface AntigravityStepUpdateEvent {
  event: "step_update";
  step_update: {
    conversation_id: string;
    step_index: number;
    state: "ACTIVE" | "DONE" | "ERROR" | string;
    step_type: string;
    text_delta?: string;
    duration_seconds?: number;
    usage?: AntigravityUsage;
    tool_name?: string;
    tool_info?: {
      name?: string;
      parameters?: unknown;
      output?: unknown;
      error?: unknown;
    };
  };
}

interface AntigravityResultEvent {
  event: "result";
  result: {
    conversation_id: string;
    status: string;
    response?: string;
    num_turns: number;
    usage?: AntigravityUsage;
  };
}

interface AntigravityCommandResultEvent {
  event: "command_result";
  command: unknown;
}

export type AntigravityStreamEvent =
  | AntigravityInitEvent
  | AntigravityStepUpdateEvent
  | AntigravityResultEvent
  | AntigravityCommandResultEvent;

interface ActiveTurn {
  command: TurnStartCommand;
  process: ChildProcessByStdio<null, Readable, Readable>;
  agentItem: HostAgentMessageItem | null;
  agentText: string;
  tools: Map<number, HostToolExecutionItem>;
  completedItems: HostItemSnapshot[];
  stderr: string;
  cancellationRequested: boolean;
  receivedResult: boolean;
}

const antigravityHarnessId = harnessIdSchema.parse("antigravity");
const DEFAULT_INSPECT_TIMEOUT_MS = 20_000;
const DEFAULT_PRINT_TIMEOUT = "30m";
const DEFAULT_TOOL_OUTPUT_LIMIT = 64_000;

const CAPABILITIES: HarnessSessionCapabilities = {
  configuration: {
    selectModel: true,
    selectThinkingOption: false,
    selectPermissionMode: true,
  },
  history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
  subagents: { observe: false, readTranscript: false },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function invalidState(message: string): HarnessError {
  return { code: "invalidState", message, retryable: false };
}

function unsupported(message: string): HarnessError {
  return { code: "unsupported", message, retryable: false };
}

function jsonValue(value: unknown): JsonValue {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function boundedText(value: unknown, limit: number): { text: string; truncated: boolean } | null {
  if (value === undefined) return null;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return null;
  return { text: text.slice(0, limit), truncated: text.length > limit };
}

function safeToken(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function hostUsage(value: AntigravityUsage | undefined): HostUsage | null {
  if (!value) return null;
  const inputTokens = safeToken(value.input_tokens);
  const outputTokens = safeToken(value.output_tokens);
  const reasoningOutputTokens = safeToken(value.thinking_tokens);
  const cachedInputTokens = safeToken(value.cache_read_tokens);
  const totalTokens = safeToken(value.total_tokens);
  const usage: HostUsage = {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(inputTokens !== undefined && cachedInputTokens !== undefined && inputTokens > 0
      ? { cacheHitRatePercent: Math.min(100, (cachedInputTokens / inputTokens) * 100) }
      : {}),
  };
  return Object.keys(usage).length > 0 ? usage : null;
}

export function parseAntigravityModels(output: string): HarnessModelCatalog {
  const models = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf("\t");
      if (separator <= 0) return null;
      const id = line.slice(0, separator).trim();
      const label = line.slice(separator + 1).trim();
      const ref = harnessModelRefSchema.safeParse({ id });
      return ref.success && label ? { ref: ref.data, label, resolvedModelLabel: label } : null;
    })
    .filter((model): model is NonNullable<typeof model> => model !== null);
  if (models.length === 0) throw new Error("Antigravity CLI returned no usable Models");
  return harnessModelCatalogSchema.parse({
    models,
    defaultModel: models[0]?.ref,
    thinkingOptions: [],
  });
}

export function parseAntigravityStreamLine(line: string): AntigravityStreamEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.event !== "string") return null;
  if (
    parsed.event === "init" &&
    typeof parsed.conversation_id === "string" &&
    parsed.conversation_id.length > 0
  ) {
    return parsed as unknown as AntigravityInitEvent;
  }
  if (
    parsed.event === "step_update" &&
    isRecord(parsed.step_update) &&
    typeof parsed.step_update.conversation_id === "string" &&
    typeof parsed.step_update.step_index === "number" &&
    typeof parsed.step_update.state === "string" &&
    typeof parsed.step_update.step_type === "string"
  ) {
    return parsed as unknown as AntigravityStepUpdateEvent;
  }
  if (
    parsed.event === "result" &&
    isRecord(parsed.result) &&
    typeof parsed.result.conversation_id === "string" &&
    typeof parsed.result.status === "string" &&
    typeof parsed.result.num_turns === "number"
  ) {
    return parsed as unknown as AntigravityResultEvent;
  }
  if (parsed.event === "command_result") return parsed as unknown as AntigravityCommandResultEvent;
  return null;
}

function normalizedProcessError(stderr: string, fallback: string): HarnessError {
  const diagnostic = stderr.trim();
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

  constructor(input: {
    cwd: string;
    environment: NodeJS.ProcessEnv;
    executable: string;
    model?: HarnessModelRef;
    nativeRef?: NativeSessionRef;
    knownTurnRefs?: NativeTurnRef[];
    permissionMode: AntigravityPermissionMode;
    printTimeout: string;
    toolOutputLimit: number;
    onClosed(): void;
  }) {
    this.#cwd = input.cwd;
    this.#environment = input.environment;
    this.#executable = input.executable;
    this.#model = input.model;
    this.#nativeRef = input.nativeRef;
    this.#permissionMode = input.permissionMode;
    this.#printTimeout = input.printTimeout;
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
    if (command.type === "thinking.select") {
      return { ok: false, error: unsupported("Antigravity Thinking selection is Model-specific") };
    }
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

    const arguments_ = [
      "-p",
      text,
      "--output-format",
      "stream-json",
      "--print-timeout",
      this.#printTimeout,
    ];
    if (this.#nativeRef) arguments_.unshift("--conversation", this.#nativeRef.nativeSessionId);
    if (this.#model) arguments_.push("--model", this.#model.id);
    if (this.#permissionMode === "dangerously-skip-permissions") {
      arguments_.push("--dangerously-skip-permissions");
    }
    const invocation = commandInvocation(this.#executable, arguments_, this.#environment);
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(invocation.command, invocation.arguments, {
        cwd: this.#cwd,
        env: this.#environment,
        windowsHide: true,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
        stdio: ["ignore", "pipe", "pipe"],
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
      agentItem: null,
      agentText: "",
      tools: new Map(),
      completedItems: [],
      stderr: "",
      cancellationRequested: false,
      receivedResult: false,
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
      return;
    }
    if (event.event === "step_update") {
      this.#handleStep(active, event.step_update);
      const usage = hostUsage(event.step_update.usage);
      if (usage) {
        this.#event({
          type: "session.usage.changed",
          usage,
          observedForTurnId: active.command.turnId,
        });
      }
      return;
    }
    if (event.event !== "result") return;
    active.receivedResult = true;
    const usage = hostUsage(event.result.usage);
    if (usage) {
      this.#event({
        type: "session.usage.changed",
        usage,
        observedForTurnId: active.command.turnId,
      });
    }
    if (!this.#nativeRef) {
      this.#nativeRef = nativeSessionRefSchema.parse({
        harnessId: this.harnessId,
        nativeSessionId: event.result.conversation_id,
        formatVersion: 1,
      });
      this.#event({ type: "session.state.changed", state: this.#state() });
    }
    if (!active.agentItem && event.result.response) {
      this.#appendAgentText(active, event.result.response);
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
      this.#completeTurn(active, { status: "succeeded" }, nativeTurnRef);
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

  #handleStep(active: ActiveTurn, step: AntigravityStepUpdateEvent["step_update"]): void {
    if (step.step_type === "agent_response" && step.text_delta) {
      this.#appendAgentText(active, step.text_delta);
      return;
    }
    if (step.step_type !== "tool") return;
    let item = active.tools.get(step.step_index);
    if (!item) {
      item = {
        type: "toolExecution",
        itemId: this.#newItemId(),
        toolName: step.tool_name ?? step.tool_info?.name ?? "antigravity.tool",
        arguments: jsonValue(step.tool_info?.parameters),
      };
      active.tools.set(step.step_index, item);
      this.#event({ type: "item.started", turnId: active.command.turnId, item });
    }
    if (step.state !== "DONE" && step.state !== "ERROR") return;
    const output = boundedText(
      step.tool_info?.output ?? step.tool_info?.error,
      this.#toolOutputLimit,
    );
    const completed: HostToolExecutionItem = {
      ...item,
      ...(output
        ? {
            output: { content: [{ type: "text", text: output.text }], truncated: output.truncated },
          }
        : {}),
      ...(typeof step.duration_seconds === "number"
        ? { durationMs: Math.max(0, Math.round(step.duration_seconds * 1_000)) }
        : {}),
    };
    active.tools.delete(step.step_index);
    this.#completeItem(
      active,
      completed,
      step.state === "ERROR"
        ? {
            status: "failed",
            error: {
              code: "nativeFailure",
              message: `Antigravity tool '${completed.toolName}' failed`,
              retryable: false,
            },
          }
        : { status: "succeeded" },
    );
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
    return {
      ...(this.#nativeRef ? { nativeRef: this.#nativeRef } : {}),
      ...(this.#model ? { effectiveModel: this.#model } : {}),
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
  readonly #printTimeout: string;
  readonly #sessions = new Set<AntigravitySession>();
  readonly #toolOutputLimit: number;
  #closed = false;

  constructor(options: AntigravityAdapterOptions = {}) {
    this.#command = options.command;
    this.#environment = options.environment ?? process.env;
    this.#inspectTimeoutMs = options.inspectTimeoutMs ?? DEFAULT_INSPECT_TIMEOUT_MS;
    this.#printTimeout = options.printTimeout ?? DEFAULT_PRINT_TIMEOUT;
    this.#toolOutputLimit = options.toolOutputLimit ?? DEFAULT_TOOL_OUTPUT_LIMIT;
  }

  async inspect(input: { cwd?: string } = {}): Promise<HarnessInspection> {
    if (this.#closed) {
      return { status: "unavailable", error: invalidState("Antigravity Adapter is closed") };
    }
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
        input.cwd ?? process.cwd(),
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
    const session = new AntigravitySession({
      cwd: input.cwd,
      environment: this.#environment,
      executable,
      ...(input.kind === "create" && input.model ? { model: input.model } : {}),
      ...(nativeRef ? { nativeRef } : {}),
      ...(input.kind === "resume" && input.knownTurnRefs
        ? { knownTurnRefs: input.knownTurnRefs }
        : {}),
      permissionMode,
      printTimeout: this.#printTimeout,
      toolOutputLimit: this.#toolOutputLimit,
      onClosed: () => this.#sessions.delete(session),
    });
    this.#sessions.add(session);
    return { ok: true, value: session };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await Promise.all([...this.#sessions].map((session) => session.close()));
  }
}
