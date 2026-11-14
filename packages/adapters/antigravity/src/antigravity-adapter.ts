import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import {
  HarnessOutputChannel,
  sanitizeDiagnosticTail,
  unsupportedSteer,
  validateHostApprovalResponse,
  validateHostQuestionResponse,
  type HarnessAdapter,
  type HarnessCommandCapability,
  type HarnessError,
  type HarnessInspection,
  type HarnessOutput,
  type HarnessResult,
  type HarnessSession,
  type HarnessSessionCapabilities,
  type HarnessSessionState,
  type HostCommand,
  type HostEvent,
  type HostInteraction,
  type HostItemOutcome,
  type HostThreadSnapshot,
  type HostUsage,
  type HostUsageRequest,
  type InspectHarnessInput,
  type OpenSessionInput,
  type TurnOutcome,
  type TurnStartCommand,
  type TurnStartAccepted,
  type TurnSteerCommand,
  type TurnSteerAccepted,
  type TurnCancelCommand,
  type TurnCancelAccepted,
  type InteractionRespondCommand,
  type InteractionRespondAccepted,
  type ModelSelectCommand,
  type ModelSelectCompleted,
  type ThinkingSelectCommand,
  type ThinkingSelectCompleted,
  type PermissionModeSelectCommand,
  type PermissionModeSelectCompleted,
} from "@codexhost/harness-adapter";
import { commandInvocation } from "@codexhost/harness-discovery";
import {
  harnessIdSchema,
  harnessPermissionModeIdSchema,
  hostInteractionIdSchema,
  hostItemIdSchema,
  type HarnessCommandCatalog,
  type HarnessModelCatalog,
  type HarnessModelRef,
  type HarnessPermissionModeId,
  type HarnessThinkingOptionId,
  type HostTurnId,
  type NativeSessionRef,
  type NativeTurnRef,
} from "@codexhost/shared-contracts";
import { AntigravityAcpTransport } from "./acp-transport.js";
import {
  ANTIGRAVITY_MIN_ACP_VERSION,
  AntigravityTransportError,
  type AntigravityAcpAvailableModel,
  type AntigravityAcpConfigOption,
  type AntigravityAcpEvent,
  type AntigravityAcpSessionOpenResult,
  type AntigravityAcpTransportLike,
  type AntigravityAcpTransportOptions,
  type AntigravityPromptInputPart,
} from "./acp-types.js";
import {
  AntigravityToolTracker,
  buildAcpElicitationResponse,
  buildAcpPermissionResponse,
  buildLiveCommandCatalog,
  projectAcpApprovalInteraction,
  projectAcpQuestionInteraction,
  projectReplayedEventsToTurns,
} from "./acp-projection.js";
import { AntigravitySessionUsageTracker } from "./acp-usage.js";
import { resolveAntigravityExecutable } from "./command.js";
import { antigravityDelegationInstructions } from "./delegation.js";
import { forkAntigravitySession, nativeConversationDbPath, validNativeSessionRef } from "./fork.js";
import {
  parseAntigravityModels,
  parseAntigravityAcpModelCatalog,
  readAcpEffectiveModelState,
  splitAntigravityModelAndEffort,
} from "./model-catalog.js";
import { readNativeTurnCount } from "./native-turn-boundaries.js";
import {
  ANTIGRAVITY_PERMISSION_MODE_CATALOG,
  decodeAntigravityPermissionModeId,
} from "./permission-modes.js";
import { fetchAntigravityQuota, type AntigravityQuotaSnapshot } from "./quota.js";
import { rollbackAntigravityLastTurn } from "./rollback.js";
import { AntigravitySessionImport } from "./session-import.js";
import { ANTIGRAVITY_COMMAND_CATALOG, parseAndFormatAntigravityCommand } from "./slash-commands.js";
import { AntigravitySubagents, readNativeSubagentStatus } from "./subagents.js";
import { readSubagentTranscript } from "./subagent-transcript.js";
import { antigravityHome, createAntigravityUsageStatistics } from "./usage-statistics.js";

const harnessId = harnessIdSchema.parse("antigravity");
const SKIP = "dangerously-skip-permissions";
export const antigravitySessionCapabilities: HarnessSessionCapabilities = {
  configuration: {
    selectModel: true,
    selectThinkingOption: true,
    selectPermissionMode: true,
    permissionModeScope: "live",
  },
  history: { fork: true, forkAcrossCwd: true, rollbackLastTurn: true },
  subagents: { observe: true, readTranscript: true },
  autonomousTurns: { observe: false },
};
export interface AntigravityAdapterOptions {
  command?: string;
  environment?: NodeJS.ProcessEnv;
  inspectTimeoutMs?: number;
  commandTimeoutMs?: number;
  closeTimeoutMs?: number;
  printTimeout?: string;
  toolOutputLimit?: number;
  subagentObservationTimeoutMs?: number;
  turnCleanupWaitMs?: number;
  createTransport?: (options: AntigravityAcpTransportOptions) => AntigravityAcpTransportLike;
}
function ok<T>(value: T): HarnessResult<T> {
  return { ok: true, value };
}
function err(code: HarnessError["code"], message: string, retryable = false): HarnessResult<never> {
  return { ok: false, error: { code, message, retryable } };
}
export function normalizeAntigravityError(error: unknown): HarnessError {
  if (error instanceof AntigravityTransportError)
    return {
      code: error.toHarnessErrorCode(),
      message: sanitizeDiagnosticTail(error.message),
      retryable: error.retryable,
      ...(error.diagnostic ? { diagnostic: sanitizeDiagnosticTail(error.diagnostic) } : {}),
    };
  const message = sanitizeDiagnosticTail(error instanceof Error ? error.message : String(error));
  const code = (error as NodeJS.ErrnoException)?.code;
  return {
    code:
      code === "ENOENT"
        ? "notInstalled"
        : /authenticat|sign.?in|login|credential/iu.test(message)
          ? "authenticationRequired"
          : "nativeFailure",
    message,
    retryable: false,
  };
}
function runCli(
  executable: string,
  args: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
  timeout: number,
  signal: AbortSignal,
): Promise<string> {
  const invocation = commandInvocation(executable, [...args], environment);
  return new Promise((resolve, reject) => {
    execFile(
      invocation.command,
      invocation.arguments,
      {
        cwd,
        env: environment,
        timeout,
        signal,
        killSignal: "SIGKILL",
        windowsHide: true,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
        maxBuffer: 4 * 1024 * 1024,
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}
function runQuotaCli(
  executable: string,
  args: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
  timeout: number,
  signal: AbortSignal,
): Promise<string> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Aborted"));
  const invocation = commandInvocation(executable, [...args], environment);
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.arguments, {
      cwd,
      env: environment,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
    let stdout = "";
    let settled = false;
    const maxBytes = 4 * 1024 * 1024;
    const finish = (done: () => void) => {
      if (settled) return;
      settled = true;
      done();
    };
    const onAbort = () => {
      child.kill("SIGKILL");
      finish(() => reject(signal.reason ?? new Error("Aborted")));
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new Error("Antigravity quota command timed out")));
    }, timeout);
    timer.unref?.();
    signal.addEventListener("abort", onAbort, { once: true });
    child.on("error", (error) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      finish(() => reject(error));
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (settled) return;
      stdout += chunk;
      if (Buffer.byteLength(stdout, "utf8") > maxBytes) {
        child.kill("SIGKILL");
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        finish(() => reject(new Error("Antigravity quota output exceeded 4 MiB")));
        return;
      }
      if (stdout.includes("\n") && stdout.includes('"command_result"')) {
        for (const line of stdout.split(/\r?\n/u).slice(0, -1)) {
          if (line.includes('"command_result"')) {
            child.unref();
            finish(() => resolve(stdout));
            return;
          }
        }
      }
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (code === 0) finish(() => resolve(stdout));
      else finish(() => reject(new Error(`Antigravity quota exited with code ${code ?? "null"}`)));
    });
  });
}
interface RequestedConfiguration {
  model?: HarnessModelRef | undefined;
  thinkingOptionId?: HarnessThinkingOptionId | undefined;
  permissionModeId?: HarnessPermissionModeId | undefined;
}
interface SessionOptions extends RequestedConfiguration {
  cwd: string;
  environment: NodeJS.ProcessEnv;
  nativeRef?: NativeSessionRef;
  knownTurnRefs?: readonly NativeTurnRef[] | undefined;
  unattended: boolean;
  adapter: AntigravityAdapterOptions;
  onClosed(session: AntigravitySession): void;
}
interface ActiveTurn {
  turnId: HostTurnId;
  cancelled: boolean;
  ended: boolean;
  firstOutputAtMs?: number;
  model?: string;
  tracker?: AntigravityToolTracker;
  textItem?:
    | {
        type: "agentMessage" | "reasoning";
        itemId: ReturnType<typeof hostItemIdSchema.parse>;
        text: string;
      }
    | undefined;
}
interface PendingInteraction {
  interaction: HostInteraction;
  respond(
    command: InteractionRespondCommand,
  ): RequestPermissionResponse | CreateElicitationResponse;
  resolve(value: RequestPermissionResponse | CreateElicitationResponse): void;
  cancelValue: RequestPermissionResponse | CreateElicitationResponse;
}

export class AntigravitySession implements HarnessSession {
  readonly harnessId = harnessId;
  readonly capabilities = antigravitySessionCapabilities;
  readonly #channel = new HarnessOutputChannel<HarnessOutput>();
  readonly outputs = this.#channel.outputs;
  readonly #options: SessionOptions;
  readonly #subagents: AntigravitySubagents;
  #state: HarnessSessionState = {};
  #requested: RequestedConfiguration;
  #transport: AntigravityAcpTransportLike | undefined;
  readonly #readers = new Set<AntigravityAcpTransportLike>();
  #opening: Promise<void> | undefined;
  #availableModels: AntigravityAcpAvailableModel[] = [];
  #configOptions: AntigravityAcpConfigOption[] = [];
  #catalog: HarnessModelCatalog | undefined;
  #commands: HarnessCommandCatalog = ANTIGRAVITY_COMMAND_CATALOG;
  #turnCount = 0;
  #active: ActiveTurn | undefined;
  #pending = new Map<string, PendingInteraction>();
  #usage: AntigravitySessionUsageTracker | undefined;
  #usageWork: Promise<void> = Promise.resolve();
  #abort = new AbortController();
  #closed = false;
  #faulted = false;
  #closing: Promise<void> | undefined;
  #configuring = false;
  #historyOperation = false;

  constructor(options: SessionOptions) {
    this.#options = options;
    this.#requested = {
      model: options.model,
      thinkingOptionId: options.thinkingOptionId,
      permissionModeId: options.permissionModeId,
    };
    this.#subagents = new AntigravitySubagents({
      parentId: () => this.nativeRef?.nativeSessionId,
      cwd: options.cwd,
      home: antigravityHome(options.environment),
      outputLimit: options.adapter.toolOutputLimit ?? 64_000,
      emit: (event) => this.#emit(event),
    });
  }
  get initialState(): HarnessSessionState {
    return { ...this.#state };
  }
  get initialUsage(): HostUsage | null {
    return this.#usage?.currentUsage() ?? null;
  }
  get nativeRef(): NativeSessionRef | undefined {
    return this.#state.nativeRef;
  }
  get isActive(): boolean {
    return !!this.#active || !!this.#opening || this.#configuring || this.#subagents.running;
  }
  hasBackgroundWork(): boolean {
    return this.#subagents.running;
  }
  reserveHistoryOperation(): (() => void) | null {
    if (this.isActive || this.#historyOperation || this.#closed || this.#faulted) return null;
    this.#historyOperation = true;
    return () => {
      this.#historyOperation = false;
    };
  }
  #emit(event: HostEvent): void {
    this.#channel.emit({ kind: "event", event });
  }
  #publishState(): void {
    this.#emit({ type: "session.state.changed", state: { ...this.#state } });
  }

  #delegationPrompt(): { systemPromptAppend?: string } {
    const prompt = antigravityDelegationInstructions(this.#options.environment);
    return prompt ? { systemPromptAppend: prompt } : {};
  }
  #newTransport(skipPermissions: boolean): AntigravityAcpTransportLike {
    const options: AntigravityAcpTransportOptions = {
      cwd: this.#options.cwd,
      ...(this.#options.adapter.command ? { command: this.#options.adapter.command } : {}),
      environment: this.#options.environment,
      skipPermissions,
      ...(this.#options.adapter.commandTimeoutMs !== undefined
        ? { commandTimeoutMs: this.#options.adapter.commandTimeoutMs }
        : {}),
      ...(this.#options.adapter.closeTimeoutMs !== undefined
        ? { closeTimeoutMs: this.#options.adapter.closeTimeoutMs }
        : {}),
      onFault: (error) => {
        if (this.#transport === transport) this.handleTransportFault(error);
      },
    };
    const transport =
      this.#options.adapter.createTransport?.(options) ?? new AntigravityAcpTransport(options);
    return transport;
  }
  async initialize(): Promise<void> {
    if (this.#transport && !this.#opening) return;
    if (this.#opening) return this.#opening;
    this.#opening = this.#open().finally(() => {
      this.#opening = undefined;
    });
    return this.#opening;
  }
  async #open(): Promise<void> {
    const skip = this.#options.unattended || this.#requested.permissionModeId === SKIP;
    const transport = this.#newTransport(skip);
    this.#transport = transport;
    try {
      await transport.initialize();
      if (this.#closed || this.#faulted) {
        await transport.close();
        return;
      }
      const ref = this.nativeRef ?? this.#options.nativeRef;
      const { opened, replayedEvents } = await transport.openSession({
        kind: ref ? "resume" : "create",
        ...(ref ? { sessionId: ref.nativeSessionId } : {}),
        cwd: this.#options.cwd,
        ...this.#delegationPrompt(),
      });
      if (ref && opened.sessionId !== ref.nativeSessionId)
        throw new AntigravityTransportError(
          "protocolError",
          "Antigravity resumed a different native Session",
        );
      if (this.#closed || this.#faulted) {
        await transport.close();
        return;
      }
      if (
        !validNativeSessionRef(
          { harnessId, nativeSessionId: opened.sessionId, formatVersion: 1 },
          harnessId,
        )
      )
        throw new AntigravityTransportError(
          "protocolError",
          "Antigravity returned an invalid native Session ID",
        );
      this.#applyOpened(opened, skip);
      try {
        this.#turnCount = await readNativeTurnCount(
          nativeConversationDbPath(opened.sessionId, antigravityHome(this.#options.environment)),
        );
      } catch {
        this.#turnCount = projectReplayedEventsToTurns({
          nativeSessionId: opened.sessionId,
          cwd: this.#options.cwd,
          events: replayedEvents,
          ...(this.#options.knownTurnRefs ? { knownTurnRefs: this.#options.knownTurnRefs } : {}),
        }).length;
      }
      transport.setSessionEventHandler((event) => {
        if (this.#transport === transport && !this.#closed && !this.#faulted)
          this.#sessionEvent(event);
      });
      if (this.#requested.model) {
        const applied = await this.#setModelConfig(
          this.#requested.model.id,
          this.#requested.thinkingOptionId,
        );
        if (!applied.bakedInThinking) {
          if (this.#requested.thinkingOptionId) {
            await this.#setConfig("thinking", this.#requested.thinkingOptionId);
          } else if (
            applied.impliedThinking &&
            this.#hasConfigChoice("thinking", applied.impliedThinking)
          ) {
            await this.#setConfig("thinking", applied.impliedThinking);
          }
        }
      } else if (this.#requested.thinkingOptionId) {
        await this.#setConfig("thinking", this.#requested.thinkingOptionId);
      }
      if (!skip && this.#requested.permissionModeId) {
        await transport.setMode(this.#requested.permissionModeId);
        this.#state.effectivePermissionModeId = this.#requested.permissionModeId;
        this.#setLocatorPermissionMode(this.#requested.permissionModeId);
      }
      if (!this.#usage) {
        const context = replayedEvents.findLast((event) => event.type === "usage.context");
        this.#usage = new AntigravitySessionUsageTracker({
          nativeSessionId: opened.sessionId,
          homedir: antigravityHome(this.#options.environment),
          ...(context
            ? { initialContextUsedTokens: context.used, initialContextWindowTokens: context.size }
            : {}),
        });
        this.#usageWork = this.#replayUsage();
      }
      this.#publishState();
    } catch (error) {
      await transport.close().catch(() => undefined);
      if (this.#transport === transport) this.#transport = undefined;
      throw error;
    }
  }
  #setLocatorPermissionMode(permissionModeId: string): void {
    const ref = this.#state.nativeRef;
    if (!ref) return;
    const locator =
      ref.locator && typeof ref.locator === "object" && !Array.isArray(ref.locator)
        ? ref.locator
        : {};
    this.#state = {
      ...this.#state,
      nativeRef: { ...ref, locator: { ...locator, permissionModeId } },
    };
  }
  #applyOpened(opened: AntigravityAcpSessionOpenResult, skip: boolean): void {
    this.#availableModels = opened.models?.availableModels
      ? [...opened.models.availableModels]
      : [];
    this.#configOptions = opened.configOptions ?? [];
    this.#catalog =
      this.#availableModels.length || this.#configOptions.some((entry) => entry.id === "model")
        ? parseAntigravityAcpModelCatalog(this.#availableModels, this.#configOptions)
        : undefined;
    const savedLocator = this.#options.nativeRef?.locator;
    const locator = {
      ...(savedLocator && typeof savedLocator === "object" && !Array.isArray(savedLocator)
        ? savedLocator
        : {}),
      executionPolicy: this.#options.unattended ? "unattended-full-access" : "default",
      permissionModeId: skip ? SKIP : (opened.modes?.currentModeId ?? "default"),
    };
    const effective = readAcpEffectiveModelState(this.#configOptions, this.#catalog);
    if (!effective.effectiveModel && opened.models?.currentModelId) {
      const current = splitAntigravityModelAndEffort(opened.models.currentModelId);
      effective.effectiveModel = current.modelRef;
      if (current.effort) effective.effectiveThinkingOptionId = current.effort;
    }
    this.#state = {
      nativeRef: { harnessId, nativeSessionId: opened.sessionId, formatVersion: 1, locator },
      ...effective,
      effectivePermissionModeId: harnessPermissionModeIdSchema.parse(
        skip ? SKIP : (opened.modes?.currentModeId ?? "default"),
      ),
    };
  }
  #applyConfig(config: AntigravityAcpConfigOption[]): void {
    this.#configOptions = config;
    if (this.#availableModels.length || config.some((entry) => entry.id === "model")) {
      try {
        this.#catalog = parseAntigravityAcpModelCatalog(this.#availableModels, config);
      } catch {
        // Keep previous catalog when partial test fixtures omit model options.
      }
    }
    const { nativeRef, effectivePermissionModeId } = this.#state;
    this.#state = {
      ...(nativeRef ? { nativeRef } : {}),
      ...(effectivePermissionModeId ? { effectivePermissionModeId } : {}),
      ...readAcpEffectiveModelState(config, this.#catalog),
    };
    this.#publishState();
  }
  #findConfigOption(category: "model" | "thinking"): AntigravityAcpConfigOption | undefined {
    return this.#configOptions.find(
      (entry) =>
        entry.category === category ||
        entry.id === category ||
        (category === "thinking" && entry.id === "thought_level"),
    );
  }
  #hasConfigChoice(category: "model" | "thinking", value: string): boolean {
    const option = this.#findConfigOption(category);
    return !!option?.options.some((choice) => choice.value === value);
  }
  async #setModelConfig(
    requestedModelId: string,
    requestedThinking?: HarnessThinkingOptionId,
  ): Promise<{ impliedThinking?: HarnessThinkingOptionId; bakedInThinking: boolean }> {
    const option = this.#findConfigOption("model");
    if (!option) {
      throw new AntigravityTransportError(
        "unsupported",
        `Antigravity does not offer model=${requestedModelId}`,
      );
    }
    let targetValue = requestedModelId;
    let impliedThinking: HarnessThinkingOptionId | undefined;
    let bakedInThinking = false;
    if (!option.options.some((choice) => choice.value === requestedModelId)) {
      const split = splitAntigravityModelAndEffort(requestedModelId);
      if (split.effort && option.options.some((choice) => choice.value === split.modelRef.id)) {
        targetValue = split.modelRef.id;
        impliedThinking = split.effort;
      } else if (
        requestedThinking &&
        option.options.some((choice) => choice.value === `${requestedModelId}-${requestedThinking}`)
      ) {
        targetValue = `${requestedModelId}-${requestedThinking}`;
        bakedInThinking = true;
      } else {
        const variants = option.options.filter(
          (choice) =>
            choice.value.startsWith(`${requestedModelId}-`) &&
            /^(?:low|medium|high|xhigh)$/u.test(choice.value.slice(requestedModelId.length + 1)),
        );
        if (!requestedThinking && variants.length === 1 && variants[0]) {
          targetValue = variants[0].value;
          bakedInThinking = true;
        }
      }
    }
    await this.#setConfig("model", targetValue);
    return {
      ...(impliedThinking ? { impliedThinking } : {}),
      bakedInThinking,
    };
  }
  async #setConfig(category: "model" | "thinking", value: string): Promise<void> {
    const option = this.#findConfigOption(category);
    if (!option || !option.options.some((choice) => choice.value === value))
      throw new AntigravityTransportError(
        "unsupported",
        `Antigravity does not offer ${category}=${value}`,
      );
    const transport = this.#transport;
    if (!transport)
      throw new AntigravityTransportError("unavailable", "Native Session is not connected");
    const confirmed = await transport.setConfigOption(option.id, value);
    if (confirmed.find((entry) => entry.id === option.id)?.currentValue !== value)
      throw new AntigravityTransportError(
        "protocolError",
        `Antigravity did not confirm ${category} selection`,
      );
    this.#applyConfig(confirmed);
  }
  #sessionEvent(event: AntigravityAcpEvent): void {
    switch (event.type) {
      case "config.update":
        this.#applyConfig(event.configOptions);
        break;
      case "mode.update":
        if (!this.#transport?.skipPermissions) {
          this.#state.effectivePermissionModeId = harnessPermissionModeIdSchema.parse(
            event.currentModeId,
          );
          this.#setLocatorPermissionMode(event.currentModeId);
          this.#publishState();
        }
        break;
      case "commands.update":
        this.#commands = buildLiveCommandCatalog(event.commands);
        break;
      case "usage.context": {
        const usage = this.#usage?.recordContextWindow(event.used, event.size);
        if (usage) this.#emit({ type: "session.usage.changed", usage });
        break;
      }
    }
  }
  async #replayUsage(): Promise<void> {
    const tracker = this.#usage;
    if (!tracker) return;
    try {
      const history = await tracker.replayHistoricalRequests(this.#abort.signal);
      if (this.#closed || this.#faulted) return;
      for (const request of history.requests) this.#emit({ type: "usage.request", request });
      this.#emit({ type: "usage.history", complete: history.complete });
      this.#emit({ type: "session.usage.changed", usage: history.usage });
    } catch {
      if (!this.#closed && !this.#faulted) this.#emit({ type: "usage.history", complete: false });
    }
  }
  async refreshUsage(): Promise<void> {
    const tracker = this.#usage;
    if (!tracker || this.#closed || this.#faulted) return;
    this.#usageWork = this.#usageWork
      .then(async () => {
        const update = await tracker.collectNewTranscriptRequests({
          signal: this.#abort.signal,
        });
        if (this.#closed || this.#faulted) return;
        for (const request of update.requests) this.#emit({ type: "usage.request", request });
        this.#emit({ type: "usage.history", complete: update.complete });
        this.#emit({ type: "session.usage.changed", usage: update.usage });
      })
      .catch(() => {
        if (!this.#closed && !this.#faulted) this.#emit({ type: "usage.history", complete: false });
      });
    await this.#usageWork;
  }
  get commands(): HarnessCommandCapability {
    return {
      list: async () => ok(this.#commands),
      execute: async (invocation) => {
        const formatted = parseAndFormatAntigravityCommand(invocation);
        let prompt: string;
        if (formatted.ok) prompt = formatted.value.prompt;
        else {
          const descriptor = this.#commands.commands.find(
            (command) =>
              command.id === invocation.commandId || command.invocation === invocation.commandId,
          );
          if (!descriptor || formatted.error.code !== "unsupported") return formatted;
          const args = invocation.arguments ?? {};
          if (
            Object.keys(args).some((key) => key !== "text") ||
            (args.text !== undefined && typeof args.text !== "string")
          )
            return err("invalidRequest", "Command accepts only a text argument");
          prompt = `${descriptor.invocation}${typeof args.text === "string" && args.text.trim() ? ` ${args.text.trim()}` : ""}`;
        }
        return this.execute({
          type: "turn.start",
          turnId: invocation.turnId,
          input: [{ type: "text", text: prompt }],
        });
      },
    };
  }
  async readSnapshot(): Promise<HarnessResult<HostThreadSnapshot>> {
    if (this.#closed || this.#faulted) return err("invalidState", "Session is closed");
    if (!this.nativeRef) return ok({ turns: [], state: { ...this.#state } });
    const transport = this.#newTransport(
      this.#transport?.skipPermissions ?? this.#options.unattended,
    );
    this.#readers.add(transport);
    try {
      await transport.initialize();
      const { opened, replayedEvents } = await transport.openSession({
        kind: "load",
        sessionId: this.nativeRef.nativeSessionId,
        cwd: this.#options.cwd,
        ...this.#delegationPrompt(),
      });
      if (opened.sessionId !== this.nativeRef.nativeSessionId)
        throw new AntigravityTransportError("protocolError", "Snapshot loaded a different Session");
      const snapshot: HostThreadSnapshot = {
        turns: projectReplayedEventsToTurns({
          nativeSessionId: opened.sessionId,
          cwd: this.#options.cwd,
          events: replayedEvents,
          ...(this.#options.knownTurnRefs ? { knownTurnRefs: this.#options.knownTurnRefs } : {}),
          ...(this.#options.adapter.toolOutputLimit !== undefined
            ? { outputLimit: this.#options.adapter.toolOutputLimit }
            : {}),
        }),
        state: { ...this.#state },
      };
      await transport.close();
      this.#readers.delete(transport);
      return this.#closed || this.#faulted
        ? err("invalidState", "Session is closed")
        : ok(snapshot);
    } catch (error) {
      await transport
        .close()
        .then(() => this.#readers.delete(transport))
        .catch(() => undefined);
      return { ok: false, error: normalizeAntigravityError(error) };
    }
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
    >
  > {
    if (this.#closed || this.#faulted) return err("invalidState", "Session is closed");
    try {
      switch (command.type) {
        case "turn.steer":
          return unsupportedSteer("Antigravity ACP");
        case "turn.start": {
          if (this.#active || this.#configuring || this.#historyOperation)
            return err("sessionBusy", "Session is busy", true);
          if (
            !command.turnId ||
            !command.input.length ||
            !command.input.some((part) => typeof part.text === "string" && part.text.trim())
          )
            return err("invalidRequest", "Prompt and Turn ID must not be empty");
          const turn: ActiveTurn = { turnId: command.turnId, cancelled: false, ended: false };
          this.#active = turn;
          this.#emit({ type: "turn.started", turnId: turn.turnId });
          void this.#runTurn(turn, command);
          return ok({ turnId: command.turnId });
        }
        case "turn.cancel": {
          const turn = this.#active;
          if (!turn || turn.turnId !== command.turnId)
            return err("invalidRequest", "Turn is not active");
          if (!turn.cancelled) {
            turn.cancelled = true;
            this.#closeInteractions("cancelled");
            try {
              await this.#transport?.cancel();
            } catch (error) {
              this.handleTransportFault(
                new AntigravityTransportError(
                  "unavailable",
                  "Native cancellation could not be confirmed",
                  { cause: error },
                ),
              );
              return { ok: false, error: normalizeAntigravityError(error) };
            }
          }
          return ok({ cancellationRequested: true });
        }
        case "interaction.respond":
          return this.#respond(command);
        default:
          return await this.#select(command);
      }
    } catch (error) {
      return { ok: false, error: normalizeAntigravityError(error) };
    }
  }
  async #select(
    command: ModelSelectCommand | ThinkingSelectCommand | PermissionModeSelectCommand,
  ): Promise<HarnessResult<ModelSelectCompleted>> {
    if (this.#configuring || this.#historyOperation)
      return err("sessionBusy", "Configuration or history is changing", true);
    if (command.type === "permissionMode.select") {
      try {
        decodeAntigravityPermissionModeId(command.permissionModeId);
      } catch {
        return err("invalidRequest", "Unknown Antigravity Permission Mode");
      }
      if (this.#options.unattended && command.permissionModeId !== SKIP)
        return err("invalidRequest", "Unattended execution requires Skip permissions");
    }
    this.#configuring = true;
    try {
      const openingFromCold = !this.#transport;
      const previousPermissionMode = this.#requested.permissionModeId;
      if (openingFromCold && command.type === "permissionMode.select") {
        this.#requested.permissionModeId = command.permissionModeId;
      }
      try {
        await this.initialize();
      } catch (error) {
        if (openingFromCold && command.type === "permissionMode.select") {
          this.#requested.permissionModeId = previousPermissionMode;
        }
        throw error;
      }
      const transport = this.#transport;
      if (!transport || this.#closed || this.#faulted)
        return err("invalidState", "Native Session is not connected");
      if (openingFromCold && command.type === "permissionMode.select") {
        return ok({ completed: true });
      }
      if (command.type === "model.select") {
        const applied = await this.#setModelConfig(command.model.id);
        if (
          !applied.bakedInThinking &&
          applied.impliedThinking &&
          this.#hasConfigChoice("thinking", applied.impliedThinking)
        ) {
          await this.#setConfig("thinking", applied.impliedThinking);
        }
        this.#requested.model = this.#state.effectiveModel;
        this.#requested.thinkingOptionId = this.#state.effectiveThinkingOptionId;
      } else if (command.type === "thinking.select") {
        await this.#setConfig("thinking", command.thinkingOptionId);
        this.#requested.thinkingOptionId = this.#state.effectiveThinkingOptionId;
      } else {
        const nextSkip = command.permissionModeId === SKIP;
        if (nextSkip !== transport.skipPermissions) {
          if (this.#active)
            return err("sessionBusy", "Changing Skip permissions requires an idle Session", true);
          const old = transport;
          const previous = this.#requested.permissionModeId;
          this.#requested = {
            model: this.#state.effectiveModel,
            thinkingOptionId: this.#state.effectiveThinkingOptionId,
            permissionModeId: command.permissionModeId,
          };
          old.setSessionEventHandler(null);
          await old.close();
          this.#transport = undefined;
          try {
            await this.initialize();
          } catch (error) {
            this.#requested.permissionModeId = previous;
            try {
              await this.initialize();
            } catch {
              this.handleTransportFault(
                new AntigravityTransportError(
                  "unavailable",
                  "Cannot restore Session after Permission Mode change",
                ),
              );
            }
            throw error;
          }
        } else if (!nextSkip) {
          await transport.setMode(command.permissionModeId);
          this.#state.effectivePermissionModeId = command.permissionModeId;
          this.#setLocatorPermissionMode(command.permissionModeId);
          this.#requested.permissionModeId = command.permissionModeId;
          this.#publishState();
        }
      }
      return ok({ completed: true });
    } finally {
      this.#configuring = false;
    }
  }
  async #runTurn(turn: ActiveTurn, command: TurnStartCommand): Promise<void> {
    let outcome: TurnOutcome;
    let nativeTurnRef: NativeTurnRef | undefined;
    try {
      await this.initialize();
      if (!this.#isCurrent(turn)) return;
      if (turn.cancelled) {
        this.#finish(turn, { status: "cancelled" });
        return;
      }
      turn.tracker = new AntigravityToolTracker({
        turnId: turn.turnId,
        cwd: this.#options.cwd,
        ...(this.#options.adapter.toolOutputLimit !== undefined
          ? { outputLimit: this.#options.adapter.toolOutputLimit }
          : {}),
        parentConfiguration: {
          ...(this.#state.effectiveModel ? { model: this.#state.effectiveModel.id } : {}),
          ...(this.#state.effectiveThinkingOptionId
            ? { reasoningEffort: this.#state.effectiveThinkingOptionId }
            : {}),
        },
        emit: (event) => {
          if (this.#isCurrent(turn)) this.#emit(event);
        },
        onSubagentSpawned: (id, item) => this.#subagents.track(id, item),
      });
      if (this.#state.effectiveModel) turn.model = this.#state.effectiveModel.id;
      const transport = this.#transport;
      const ref = this.nativeRef;
      if (!transport || !ref)
        throw new AntigravityTransportError("unavailable", "Native Session is not connected");
      const result = await transport.prompt(promptParts(command), {
        onEvent: (event) => {
          if (!this.#isCurrent(turn) || turn.cancelled) return;
          if (event.type === "agent.text" || event.type === "agent.thought") {
            turn.firstOutputAtMs ??= Date.now();
            this.#appendText(
              turn,
              event.type === "agent.text" ? "agentMessage" : "reasoning",
              event.text,
            );
          } else if (event.type === "tool.call" || event.type === "tool.update") {
            turn.firstOutputAtMs ??= Date.now();
            this.#completeText(turn, { status: "succeeded" });
            turn.tracker?.handleToolEvent(event);
          } else this.#sessionEvent(event);
        },
        onPermission: (request) => this.#permission(turn, request),
        onElicitation: (request) => this.#question(turn, request),
      });
      const completedAtMs = Date.now();
      if (!this.#isCurrent(turn)) return;
      outcome =
        turn.cancelled || result.stopReason === "cancelled"
          ? { status: "cancelled" }
          : result.stopReason === "refusal"
            ? {
                status: "failed",
                error: {
                  code: "nativeFailure",
                  message: "Antigravity refused the prompt",
                  retryable: false,
                },
              }
            : { status: "succeeded" };
      const before = this.#turnCount;
      let count: number;
      try {
        count = await readNativeTurnCount(
          nativeConversationDbPath(ref.nativeSessionId, antigravityHome(this.#options.environment)),
        );
      } catch {
        count = outcome.status === "succeeded" ? before + 1 : before;
      }
      if (count > before) {
        const key = `turn-${count - 1}`;
        nativeTurnRef = {
          harnessId,
          nativeSessionId: ref.nativeSessionId,
          formatVersion: 1,
          nativeTurnKey: key,
        };
        outcome = { ...outcome, checkpoint: { ...ref, checkpointId: key } };
        this.#turnCount = count;
      }
      await this.#usageWork;
      if (this.#usage && this.#isCurrent(turn)) {
        try {
          const timing = {
            ...(turn.firstOutputAtMs !== undefined
              ? { firstOutputAtMs: turn.firstOutputAtMs }
              : {}),
            completedAtMs,
          };
          const update = await this.#usage.collectNewTranscriptRequests({
            ...timing,
            ...(result.usage ? { promptUsage: result.usage } : {}),
            signal: this.#abort.signal,
          });
          const recorded = this.#usage.recordTurnPromptUsage({
            ...(result.usage ? { usage: result.usage } : {}),
            ...(turn.model ? { model: turn.model } : {}),
            ...timing,
          });
          if (!this.#isCurrent(turn)) return;
          const requests: HostUsageRequest[] = update.requests.length
            ? update.requests
            : recorded.fallbackRequest
              ? [recorded.fallbackRequest]
              : [];
          for (const request of requests) this.#emit({ type: "usage.request", request });
          this.#emit({ type: "usage.history", complete: update.complete });
          this.#emit({
            type: "session.usage.changed",
            usage: recorded.usage ?? update.usage,
            observedForTurnId: turn.turnId,
          });
        } catch {
          if (this.#isCurrent(turn)) this.#emit({ type: "usage.history", complete: false });
        }
      }
    } catch (error) {
      if (
        error instanceof AntigravityTransportError &&
        (error.kind === "processExited" ||
          error.kind === "protocolError" ||
          this.#transport?.isClosed)
      ) {
        this.handleTransportFault(error);
      }
      outcome = turn.cancelled
        ? { status: "cancelled" }
        : { status: "failed", error: normalizeAntigravityError(error) };
    }
    if (this.#isCurrent(turn)) this.#finish(turn, outcome, nativeTurnRef);
  }
  #isCurrent(turn: ActiveTurn): boolean {
    return this.#active === turn && !turn.ended;
  }
  #appendText(turn: ActiveTurn, type: "agentMessage" | "reasoning", text: string): void {
    if (!text) return;
    if (turn.textItem?.type !== type) this.#completeText(turn, { status: "succeeded" });
    if (!turn.textItem) {
      turn.textItem = { type, itemId: hostItemIdSchema.parse(randomUUID()), text: "" };
      this.#emit({ type: "item.started", turnId: turn.turnId, item: { ...turn.textItem } });
    }
    turn.textItem.text += text;
    this.#emit({
      type: "item.updated",
      turnId: turn.turnId,
      itemId: turn.textItem.itemId,
      update: { type: "text.append", text },
    });
  }
  #completeText(turn: ActiveTurn, outcome: HostItemOutcome): void {
    if (!turn.textItem) return;
    this.#emit({
      type: "item.completed",
      turnId: turn.turnId,
      snapshot: { item: { ...turn.textItem }, outcome },
    });
    turn.textItem = undefined;
  }
  #finish(turn: ActiveTurn, outcome: TurnOutcome, nativeTurnRef?: NativeTurnRef): void {
    if (!this.#isCurrent(turn)) return;
    this.#closeInteractions("cancelled");
    this.#completeText(turn, outcome);
    turn.tracker?.finishPending(outcome);
    turn.ended = true;
    this.#active = undefined;
    this.#emit({
      type: "turn.completed",
      turnId: turn.turnId,
      ...(nativeTurnRef
        ? { nativeTurnRef }
        : outcome.status === "succeeded"
          ? { ephemeral: true as const }
          : {}),
      outcome,
    });
  }
  #permission(
    turn: ActiveTurn,
    request: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    const ref = this.nativeRef;
    if (
      !this.#isCurrent(turn) ||
      turn.cancelled ||
      !ref ||
      request.sessionId !== ref.nativeSessionId
    )
      return Promise.resolve({ outcome: { outcome: "cancelled" } });
    const interactionId = hostInteractionIdSchema.parse(randomUUID());
    const projected = projectAcpApprovalInteraction({
      interactionId,
      sessionId: ref.nativeSessionId,
      turnId: turn.turnId,
      cwd: this.#options.cwd,
      request,
    });
    return new Promise((resolve) => {
      this.#pending.set(interactionId, {
        interaction: projected.interaction,
        cancelValue: { outcome: { outcome: "cancelled" } },
        resolve: (value) => resolve(value as RequestPermissionResponse),
        respond: (command) => {
          if (command.response.type !== "approval")
            throw new Error("Mismatched interaction response");
          return buildAcpPermissionResponse({
            actionId: command.response.actionId,
            actionToOptionId: projected.actionToOptionId,
          });
        },
      });
      this.#channel.emit({ kind: "interaction", interaction: projected.interaction });
    });
  }
  #question(
    turn: ActiveTurn,
    request: CreateElicitationRequest,
  ): Promise<CreateElicitationResponse> {
    const ref = this.nativeRef;
    if (
      !this.#isCurrent(turn) ||
      turn.cancelled ||
      !ref ||
      ("sessionId" in request && request.sessionId !== ref.nativeSessionId)
    )
      return Promise.resolve({ action: "cancel" });
    const interactionId = hostInteractionIdSchema.parse(randomUUID());
    const toolCallId =
      "toolCallId" in request && typeof request.toolCallId === "string"
        ? request.toolCallId
        : undefined;
    const itemId = toolCallId ? turn.tracker?.activeToolItemId(toolCallId) : undefined;
    const rawInput = toolCallId ? turn.tracker?.rawToolInput(toolCallId) : undefined;
    const rawQuestions =
      rawInput && typeof rawInput === "object" && "questions" in rawInput
        ? rawInput.questions
        : rawInput;
    const projected = projectAcpQuestionInteraction({
      interactionId,
      sessionId: ref.nativeSessionId,
      turnId: turn.turnId,
      ...(itemId ? { itemId } : {}),
      request,
      ...(rawQuestions !== undefined ? { rawQuestions } : {}),
    });
    return new Promise((resolve) => {
      this.#pending.set(interactionId, {
        interaction: projected.interaction,
        cancelValue: { action: "cancel" },
        resolve: (value) => resolve(value as CreateElicitationResponse),
        respond: (command) => {
          if (command.response.type !== "question")
            throw new Error("Mismatched interaction response");
          return buildAcpElicitationResponse({
            response: command.response,
            fieldMap: projected.fieldMap,
          });
        },
      });
      this.#channel.emit({ kind: "interaction", interaction: projected.interaction });
    });
  }
  #respond(command: InteractionRespondCommand): HarnessResult<InteractionRespondAccepted> {
    const pending = this.#pending.get(command.interactionId);
    if (!pending || !this.#active || this.#active.cancelled)
      return err("invalidRequest", "Interaction is no longer active");
    const interaction = pending.interaction;
    let error: HarnessError | null;
    if (interaction.type === "approval" && command.response.type === "approval")
      error = validateHostApprovalResponse(interaction, command.response);
    else if (interaction.type === "question" && command.response.type === "question")
      error = validateHostQuestionResponse(interaction, command.response);
    else return err("invalidRequest", "Mismatched interaction response");
    if (error) return { ok: false, error };
    const value = pending.respond(command);
    this.#pending.delete(command.interactionId);
    pending.resolve(value);
    this.#emit({
      type: "interaction.closed",
      interactionId: command.interactionId,
      turnId: interaction.turnId,
      reason: "responded",
    });
    return ok({ accepted: true });
  }
  #closeInteractions(reason: "cancelled"): void {
    for (const [id, pending] of this.#pending) {
      pending.resolve(pending.cancelValue);
      this.#emit({
        type: "interaction.closed",
        interactionId: hostInteractionIdSchema.parse(id),
        turnId: pending.interaction.turnId,
        reason,
      });
    }
    this.#pending.clear();
  }
  handleTransportFault(error: AntigravityTransportError): void {
    if (this.#closed || this.#faulted) return;
    this.#faulted = true;
    this.#abort.abort();
    this.#closeInteractions("cancelled");
    if (this.#active)
      this.#finish(this.#active, { status: "failed", error: normalizeAntigravityError(error) });
    this.#emit({ type: "session.faulted", error: normalizeAntigravityError(error) });
    this.#channel.end();
    this.#subagents.stop();
    void this.#transport?.close().catch(() => undefined);
  }
  close(): Promise<void> {
    return (this.#closing ??= this.#close().catch((error) => {
      this.#closing = undefined;
      throw error;
    }));
  }
  async #close(): Promise<void> {
    this.#closed = true;
    this.#abort.abort();
    this.#closeInteractions("cancelled");
    const active = this.#active;
    if (active) this.#finish(active, { status: "cancelled", reason: "Session closed" });
    this.#channel.end();
    this.#transport?.setSessionEventHandler(null);
    if (active) await this.#transport?.cancel().catch(() => undefined);
    await Promise.all([
      this.#transport?.close(),
      this.#subagents.close(),
      ...[...this.#readers].map((reader) => reader.close()),
    ]);
    this.#readers.clear();
    this.#options.onClosed(this);
  }
}

/** Host text input can carry inline image data URIs without changing the public text contract. */
function promptParts(command: TurnStartCommand): AntigravityPromptInputPart[] {
  return command.input.flatMap((part): AntigravityPromptInputPart[] => {
    const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([a-zA-Z0-9+/=\r\n]+)$/u.exec(
      part.text.trim(),
    );
    return match
      ? [
          {
            type: "image",
            mimeType: match[1] ?? "image/png",
            data: (match[2] ?? "").replace(/\s/gu, ""),
          },
        ]
      : [{ type: "text", text: part.text }];
  });
}

export class AntigravityAdapter implements HarnessAdapter {
  readonly harnessId = harnessId;
  readonly commandCatalog = ANTIGRAVITY_COMMAND_CATALOG;
  readonly liveCommandCatalog = true;
  readonly sessionImport: AntigravitySessionImport;
  readonly usageStatistics: ReturnType<typeof createAntigravityUsageStatistics>;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #sessions = new Set<AntigravitySession>();
  readonly #cache = new Map<string, HarnessInspection>();
  readonly #inflight = new Map<string, Promise<HarnessInspection>>();
  readonly #abort = new AbortController();
  #closed = false;
  #quota: AntigravityQuotaSnapshot | null = null;
  #quotaRefresh: Promise<AntigravityQuotaSnapshot | null> | undefined;
  #quotaCwd = process.cwd();
  constructor(readonly options: AntigravityAdapterOptions = {}) {
    this.#environment = options.environment ?? process.env;
    this.sessionImport = new AntigravitySessionImport(this.#environment);
    this.usageStatistics = createAntigravityUsageStatistics(this.#environment);
  }
  async inspect(input: InspectHarnessInput = {}): Promise<HarnessInspection> {
    if (this.#closed)
      return {
        status: "unavailable",
        error: { code: "invalidState", message: "Adapter is closed", retryable: false },
      };
    const cwd = path.resolve(input.cwd ?? process.cwd());
    const key = `${cwd}\0${input.purpose ?? "catalog"}`;
    const cached = this.#cache.get(key);
    const inFlight = this.#inflight.get(key);
    if (!input.refresh && cached) return cached;
    if (!input.refresh && inFlight) return inFlight;
    if (input.refresh) {
      this.#cache.delete(`${cwd}\0catalog`);
      this.#cache.delete(`${cwd}\0availability`);
    }
    const pending = this.#inspect(cwd, input.purpose)
      .then((result) => {
        if (!this.#closed && this.#inflight.get(key) === pending && result.status === "ready")
          this.#cache.set(key, result);
        return result;
      })
      .finally(() => {
        if (this.#inflight.get(key) === pending) this.#inflight.delete(key);
      });
    this.#inflight.set(key, pending);
    return pending;
  }
  async #inspect(cwd: string, purpose?: "availability"): Promise<HarnessInspection> {
    try {
      const command = resolveAntigravityExecutable({
        ...(this.options.command ? { command: this.options.command } : {}),
        environment: this.#environment,
      });
      if (!command)
        return {
          status: "notInstalled",
          error: {
            code: "notInstalled",
            message: "Antigravity CLI (agy) is not installed",
            retryable: false,
          },
        };
      const versionOutput = await runCli(
        command,
        ["--version"],
        cwd,
        this.#environment,
        this.options.inspectTimeoutMs ?? 20_000,
        this.#abort.signal,
      );
      const version = /\b(\d+)\.(\d+)\.(\d+)\b/u.exec(versionOutput);
      const minimum = ANTIGRAVITY_MIN_ACP_VERSION.split(".").map(Number);
      const supported =
        version &&
        [1, 2, 3].reduce(
          (comparison, index) =>
            comparison || Math.sign(Number(version[index]) - Number(minimum[index - 1])),
          0,
        ) >= 0;
      if (!supported)
        return {
          status: "unavailable",
          error: {
            code: "unsupported",
            message: `Antigravity ACP requires agy >= ${ANTIGRAVITY_MIN_ACP_VERSION}; upgrade the CLI. Detected: ${version?.[0] ?? "unknown"}`,
            retryable: false,
          },
        };
      this.#quotaCwd = cwd;
      const catalog =
        purpose === "availability"
          ? { models: [], thinkingOptions: [] }
          : parseAntigravityModels(
              await runCli(
                command,
                ["models"],
                cwd,
                this.#environment,
                this.options.inspectTimeoutMs ?? 20_000,
                this.#abort.signal,
              ),
            );
      return {
        status: "ready",
        catalog,
        capabilities: antigravitySessionCapabilities,
        permissionModes: ANTIGRAVITY_PERMISSION_MODE_CATALOG,
      };
    } catch (error) {
      const normalized = normalizeAntigravityError(error);
      return {
        status: normalized.code === "notInstalled" ? "notInstalled" : "error",
        error: normalized,
      };
    }
  }
  async open(input: OpenSessionInput): Promise<HarnessResult<HarnessSession>> {
    if (this.#closed) return err("invalidState", "Adapter is closed");
    if (!input.cwd || !path.isAbsolute(input.cwd))
      return err("invalidRequest", "cwd must be an absolute directory");
    try {
      if (!(await stat(input.cwd)).isDirectory())
        return err("invalidRequest", "cwd is not a directory");
    } catch {
      return err("invalidRequest", "cwd is unavailable");
    }
    if (input.kind === "fork" || input.kind === "rollbackLastTurn") {
      const source = [...this.#sessions].find(
        (session) => session.nativeRef?.nativeSessionId === input.sourceRef.nativeSessionId,
      );
      const release = source?.reserveHistoryOperation();
      if (source && !release) return err("sessionBusy", "Source Session is busy", true);
      const common = {
        harnessId,
        adapterEnvironment: this.#environment,
        openSession: (resume: Extract<OpenSessionInput, { kind: "resume" }>) => this.open(resume),
      };
      try {
        return await (input.kind === "fork"
          ? forkAntigravitySession({ ...common, input })
          : rollbackAntigravityLastTurn({ ...common, input }));
      } finally {
        release?.();
      }
    }
    if (input.kind === "resume" && !validNativeSessionRef(input.nativeRef, harnessId))
      return err("invalidRequest", "Invalid Antigravity Native Session");
    const locator = input.kind === "resume" ? input.nativeRef.locator : undefined;
    const unattended =
      input.kind === "create"
        ? input.executionPolicy === "unattended-full-access"
        : !!locator &&
          typeof locator === "object" &&
          !Array.isArray(locator) &&
          locator.executionPolicy === "unattended-full-access";
    if (unattended && input.permissionModeId && input.permissionModeId !== SKIP)
      return err("invalidRequest", "Unattended execution requires Skip permissions");
    if (input.permissionModeId) {
      try {
        decodeAntigravityPermissionModeId(input.permissionModeId);
      } catch {
        return err("invalidRequest", "Unknown Antigravity Permission Mode");
      }
    }
    const session = new AntigravitySession({
      cwd: input.cwd,
      environment: { ...this.#environment, ...input.environment },
      model: input.model,
      thinkingOptionId: input.thinkingOptionId,
      permissionModeId:
        unattended ||
        (!input.permissionModeId &&
          locator &&
          typeof locator === "object" &&
          !Array.isArray(locator) &&
          locator.permissionModeId === SKIP)
          ? harnessPermissionModeIdSchema.parse(SKIP)
          : input.permissionModeId,
      ...(input.kind === "resume"
        ? { nativeRef: input.nativeRef, knownTurnRefs: input.knownTurnRefs }
        : {}),
      unattended,
      adapter: this.options,
      onClosed: (closed) => this.#sessions.delete(closed),
    });
    this.#sessions.add(session);
    try {
      if (input.kind === "resume") await session.initialize();
      if (this.#closed) {
        await session.close();
        return err("invalidState", "Adapter is closed");
      }
      return ok(session);
    } catch (error) {
      await session.close().catch(() => undefined);
      return { ok: false, error: normalizeAntigravityError(error) };
    }
  }
  readonly subagents = {
    readSnapshot: async (input: {
      parent: NativeSessionRef;
      nativeSubagentId: string;
      cwd: string;
    }): Promise<HarnessResult<HostThreadSnapshot>> => {
      if (this.#closed) return err("invalidState", "Adapter is closed");
      if (!validNativeSessionRef(input.parent, harnessId))
        return err("invalidRequest", "Invalid parent Native Session");
      const home = antigravityHome(this.#environment);
      const status = await readNativeSubagentStatus(
        home,
        input.parent.nativeSessionId,
        input.nativeSubagentId,
      );
      if (!status)
        return err("sessionNotFound", "Native Subagent does not belong to this parent Session");
      return readSubagentTranscript({
        parentId: input.parent.nativeSessionId,
        childId: input.nativeSubagentId,
        cwd: input.cwd,
        status,
        outputLimit: this.options.toolOutputLimit ?? 64_000,
        home,
      });
    },
  };
  credits(): AntigravityQuotaSnapshot | null {
    return this.#quota;
  }
  refreshCredits(): Promise<AntigravityQuotaSnapshot | null> {
    if (this.#closed) return Promise.resolve(null);
    return (this.#quotaRefresh ??= (async () => {
      const command = resolveAntigravityExecutable({
        ...(this.options.command ? { command: this.options.command } : {}),
        environment: this.#environment,
      });
      const quota = command
        ? await fetchAntigravityQuota((args) =>
            runQuotaCli(
              command,
              args,
              this.#quotaCwd,
              this.#environment,
              this.options.inspectTimeoutMs ?? 20_000,
              this.#abort.signal,
            ),
          )
        : null;
      if (!this.#closed) this.#quota = quota;
      return this.#closed ? null : quota;
    })().finally(() => {
      this.#quotaRefresh = undefined;
    }));
  }
  async inspectAccount() {
    const credits = await this.refreshCredits();
    if (!credits) return null;
    return {
      credits: {
        usedPercent: credits.usedPercent,
        periodType: credits.periodType,
        ...(credits.label ? { label: credits.label } : {}),
        ...(credits.scope ? { scope: credits.scope } : {}),
        ...(credits.resetsAt ? { resetsAt: credits.resetsAt } : {}),
        ...(credits.productUsage ? { productUsage: credits.productUsage } : {}),
      },
    };
  }
  async close(): Promise<void> {
    this.#closed = true;
    this.#abort.abort();
    this.#cache.clear();
    this.#inflight.clear();
    this.#quota = null;
    await Promise.all([...this.#sessions].map((session) => session.close()));
    this.#sessions.clear();
  }
}
