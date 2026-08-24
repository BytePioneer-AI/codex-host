import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import {
  query,
  type CanUseTool,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type SDKUserMessage,
  type SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import { sanitizeDiagnosticTail } from "@codexhost/harness-adapter";
import type { HarnessThinkingOptionId } from "@codexhost/shared-contracts";

import { resolveClaudeCodeExecutable, withNodeRuntimeOnPath } from "./command.js";
import type { ClaudeModelInspectionSnapshot } from "./model-catalog.js";
import { ClaudeNativeTurnAccumulator } from "./native-message.js";
import { isClaudePermissionMode, type ClaudePermissionMode } from "./permission-modes.js";
import { claudeThinkingConfiguration, parseClaudeThinkingOptionId } from "./thinking-options.js";
import type {
  ClaudeApprovalRequest,
  ClaudeApprovalSuggestionScope,
  ClaudeAutonomousTurn,
  ClaudeInteractionRequest,
  ClaudeInteractionResponse,
  ClaudeModelInspector,
  ClaudeQuestion,
  ClaudeTransportContextUsage,
  ClaudeTransportTurnResult,
  ClaudeTurnEvent,
  ClaudeTurnTransport,
} from "./transport.js";

const CLIENT_APP = "codexhost-claude-code-adapter/0.0.0";
const APPROVAL_TITLE_MAX_LENGTH = 120;
const APPROVAL_DESCRIPTION_MAX_LENGTH = 500;

class PushableInput<T> implements AsyncIterable<T> {
  #closed = false;
  #queue: T[] = [];
  #waiters: Array<(result: IteratorResult<T>) => void> = [];

  push(value: T): void {
    if (this.#closed) throw new Error("Claude SDK input is closed");
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ done: false, value });
    else this.#queue.push(value);
  }

  end(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.#queue.shift();
        if (value !== undefined) return Promise.resolve({ done: false, value });
        if (this.#closed) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

interface PendingInteraction {
  controlRequestId: string;
  input: Record<string, unknown>;
  onAbort(): void;
  request: ClaudeInteractionRequest;
  resolve(result: PermissionResult): void;
  suggestions?: PermissionUpdate[];
  signal: AbortSignal;
  toolUseId: string;
}

interface ActiveTurn {
  accumulator: ClaudeNativeTurnAccumulator;
  controlRequestIds: Set<string>;
  interactions: Map<string, PendingInteraction>;
  onEvent(event: ClaudeTurnEvent): void;
  resolve(result: ClaudeTransportTurnResult): void;
  reject(error: unknown): void;
}

export interface ClaudeSdkTransportOptions {
  command?: string;
  environment?: NodeJS.ProcessEnv;
  cwd: string;
  sessionId: string;
  openMode: "create" | "resume";
  model?: string;
  thinkingOptionId: HarnessThinkingOptionId;
  permissionMode: ClaudePermissionMode;
  closeTimeoutMs: number;
  onPermissionModeChanged(permissionMode: ClaudePermissionMode): void;
  onFault(error: unknown): void;
  queryFactory?: typeof query;
}

export interface ClaudeSdkModelInspectorOptions {
  command?: string;
  environment?: NodeJS.ProcessEnv;
  cwd: string;
  closeTimeoutMs: number;
  queryFactory?: typeof query;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function taskNotificationSubagent(message: unknown): {
  nativeSubagentId: string;
  resultSummary?: string;
} | null {
  if (!isRecord(message) || message.type !== "user" || !isRecord(message.origin)) return null;
  if (message.origin.kind !== "task-notification" || !isRecord(message.message)) return null;
  if (typeof message.message.content !== "string") return null;
  const taskId = message.message.content.match(/<task-id>([^<]+)<\/task-id>/)?.[1]?.trim();
  if (!taskId) return null;
  const summary = message.message.content.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.trim();
  return {
    nativeSubagentId: taskId,
    ...(summary ? { resultSummary: summary.slice(0, 2_000) } : {}),
  };
}

export function allowsDangerouslySkipPermissions(
  getuid: (() => number) | undefined = process.getuid,
): boolean {
  return getuid === undefined || getuid() !== 0;
}

function processExited(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function permissionModeFromMessage(value: unknown): ClaudePermissionMode | undefined {
  if (
    !isRecord(value) ||
    value.type !== "system" ||
    (value.subtype !== "init" && value.subtype !== "status") ||
    !("permissionMode" in value) ||
    value.permissionMode === undefined
  ) {
    return undefined;
  }
  return isClaudePermissionMode(value.permissionMode) ? value.permissionMode : undefined;
}

function parseContextUsage(value: unknown): ClaudeTransportContextUsage {
  if (!isRecord(value)) throw new Error("Claude SDK context Usage is invalid");
  const usedTokens = value.totalTokens;
  const maxTokens = value.maxTokens;
  const model = value.model;
  if (
    typeof usedTokens !== "number" ||
    !Number.isSafeInteger(usedTokens) ||
    usedTokens < 0 ||
    typeof maxTokens !== "number" ||
    !Number.isSafeInteger(maxTokens) ||
    maxTokens <= 0 ||
    typeof model !== "string" ||
    model.trim().length === 0 ||
    model.length > 256
  ) {
    throw new Error("Claude SDK context Usage contains invalid values");
  }
  return { usedTokens, maxTokens, model };
}

function parseQuestions(input: Record<string, unknown>): ClaudeQuestion[] | null {
  if (!Array.isArray(input.questions) || input.questions.length < 1 || input.questions.length > 4) {
    return null;
  }
  const questions: ClaudeQuestion[] = [];
  const questionTexts = new Set<string>();
  for (const value of input.questions) {
    if (!isRecord(value)) return null;
    const question = value.question;
    const header = value.header;
    const multiSelect = value.multiSelect;
    if (
      typeof question !== "string" ||
      question.length === 0 ||
      questionTexts.has(question) ||
      typeof header !== "string" ||
      header.length === 0 ||
      typeof multiSelect !== "boolean" ||
      !Array.isArray(value.options) ||
      value.options.length < 2 ||
      value.options.length > 4
    ) {
      return null;
    }
    const labels = new Set<string>();
    const options = [];
    for (const option of value.options) {
      if (
        !isRecord(option) ||
        typeof option.label !== "string" ||
        option.label.length === 0 ||
        labels.has(option.label) ||
        typeof option.description !== "string"
      ) {
        return null;
      }
      labels.add(option.label);
      options.push({ label: option.label, description: option.description });
    }
    questionTexts.add(question);
    questions.push({ question, header, options, multiSelect });
  }
  return questions;
}

function boundedDisplayText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text.length > 0 && text.length <= maxLength ? text : null;
}

const SESSION_PERMISSION_DESTINATIONS = new Set(["session", "cliArg"]);
const PERSISTENT_PERMISSION_DESTINATIONS = new Set([
  "userSettings",
  "projectSettings",
  "localSettings",
]);
const PERMISSION_BEHAVIORS = new Set(["allow", "deny", "ask"]);
const PERMISSION_MODES = new Set([
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
  "dontAsk",
  "auto",
]);

function permissionUpdateDestination(value: unknown): "session" | "always" | undefined {
  if (typeof value !== "string") return undefined;
  if (SESSION_PERMISSION_DESTINATIONS.has(value)) return "session";
  if (PERSISTENT_PERMISSION_DESTINATIONS.has(value)) return "always";
  return undefined;
}

function isPermissionUpdate(value: unknown): value is PermissionUpdate {
  if (!isRecord(value) || !permissionUpdateDestination(value.destination)) return false;
  if (value.type === "setMode") {
    return typeof value.mode === "string" && PERMISSION_MODES.has(value.mode);
  }
  if (value.type === "addDirectories" || value.type === "removeDirectories") {
    return (
      Array.isArray(value.directories) &&
      value.directories.every((directory) => typeof directory === "string")
    );
  }
  if (value.type === "addRules" || value.type === "replaceRules" || value.type === "removeRules") {
    return (
      typeof value.behavior === "string" &&
      PERMISSION_BEHAVIORS.has(value.behavior) &&
      Array.isArray(value.rules) &&
      value.rules.every(
        (rule) =>
          isRecord(rule) &&
          typeof rule.toolName === "string" &&
          (rule.ruleContent === undefined || typeof rule.ruleContent === "string"),
      )
    );
  }
  return false;
}

function permissionSuggestionScope(value: unknown): ClaudeApprovalSuggestionScope | undefined {
  if (!Array.isArray(value) || value.length === 0 || !value.every(isPermissionUpdate)) {
    return undefined;
  }
  return value.some(({ destination }) => permissionUpdateDestination(destination) === "always")
    ? "always"
    : "session";
}

function parseApprovalRequest(
  requestId: string,
  toolName: string,
  options: Parameters<CanUseTool>[2],
): ClaudeApprovalRequest | null {
  const title = [options.title, options.displayName, options.description, toolName]
    .map((value) => boundedDisplayText(value, APPROVAL_TITLE_MAX_LENGTH))
    .find((value): value is string => value !== null);
  if (!title) return null;
  const description = boundedDisplayText(options.description, APPROVAL_DESCRIPTION_MAX_LENGTH);
  const suggestedScope = permissionSuggestionScope(options.suggestions);
  return {
    type: "approval",
    requestId,
    title,
    ...(description && description !== title ? { description } : {}),
    ...(suggestedScope ? { suggestedScope } : {}),
  };
}

function denied(toolUseId: string, message: string): PermissionResult {
  return {
    behavior: "deny",
    message,
    toolUseID: toolUseId,
    decisionClassification: "user_reject",
  };
}

function allowed(
  toolUseId: string,
  input: Record<string, unknown>,
  suggestions?: PermissionUpdate[],
): PermissionResult {
  return {
    behavior: "allow",
    updatedInput: input,
    toolUseID: toolUseId,
    decisionClassification: suggestions ? "user_permanent" : "user_temporary",
    ...(suggestions ? { updatedPermissions: suggestions } : {}),
  };
}

export class ClaudeSdkTransport implements ClaudeTurnTransport {
  readonly sessionId: string;
  readonly #children: ChildProcessWithoutNullStreams[] = [];
  readonly #closeTimeoutMs: number;
  readonly #command: string | undefined;
  readonly #cwd: string;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #input = new PushableInput<SDKUserMessage>();
  readonly #model: string | undefined;
  readonly #onFault: (error: unknown) => void;
  readonly #onPermissionModeChanged: (permissionMode: ClaudePermissionMode) => void;
  readonly #openMode: "create" | "resume";
  #permissionMode: ClaudePermissionMode;
  readonly #queryFactory: typeof query;
  #thinkingOptionId: HarnessThinkingOptionId;
  #active: ActiveTurn | null = null;
  #autonomous: {
    accumulator: ClaudeNativeTurnAccumulator;
    events: ClaudeTurnEvent[];
    nativeTurnKey: string | null;
    completedSubagents: Array<{ nativeSubagentId: string; resultSummary?: string }>;
  } | null = null;
  #autonomousTurnHandler: ((turn: ClaudeAutonomousTurn) => void) | null = null;
  #closePromise: Promise<void> | null = null;
  #consumeTask: Promise<void> | null = null;
  #stderrTail = "";
  #interactionOrdinal = 0;
  #query: Query | null = null;
  #started = false;

  constructor(options: ClaudeSdkTransportOptions) {
    this.sessionId = options.sessionId;
    this.#cwd = options.cwd;
    this.#closeTimeoutMs = options.closeTimeoutMs;
    this.#command = options.command;
    this.#environment = options.environment ?? process.env;
    this.#model = options.model;
    this.#onFault = options.onFault;
    this.#onPermissionModeChanged = options.onPermissionModeChanged;
    this.#openMode = options.openMode;
    this.#permissionMode = options.permissionMode;
    this.#queryFactory = options.queryFactory ?? query;
    this.#thinkingOptionId = parseClaudeThinkingOptionId(options.thinkingOptionId);
  }

  setAutonomousTurnHandler(handler: (turn: ClaudeAutonomousTurn) => void): void {
    this.#autonomousTurnHandler = handler;
  }

  async start(): Promise<void> {
    if (this.#started) return;
    if (this.#closePromise) throw new Error("Claude SDK transport is closing");
    const executable = resolveClaudeCodeExecutable({
      ...(this.#command ? { command: this.#command } : {}),
      environment: this.#environment,
    });
    const thinking = claudeThinkingConfiguration(this.#thinkingOptionId);
    const activeQuery = this.#queryFactory({
      prompt: this.#input,
      options: {
        cwd: this.#cwd,
        ...(this.#openMode === "resume"
          ? { resume: this.sessionId }
          : { sessionId: this.sessionId }),
        ...(this.#model ? { model: this.#model } : {}),
        thinking: thinking.enabled ? { type: "adaptive" } : { type: "disabled" },
        ...(thinking.effort ? { effort: thinking.effort } : {}),
        pathToClaudeCodeExecutable: executable,
        settingSources: ["user"],
        permissionMode: this.#permissionMode,
        ...(allowsDangerouslySkipPermissions() ? { allowDangerouslySkipPermissions: true } : {}),
        canUseTool: (toolName, input, options) => this.#canUseTool(toolName, input, options),
        persistSession: true,
        includePartialMessages: true,
        forwardSubagentText: true,
        env: withNodeRuntimeOnPath({
          ...this.#environment,
          CLAUDE_AGENT_SDK_CLIENT_APP: CLIENT_APP,
        }),
        spawnClaudeCodeProcess: (options) => this.#spawn(options),
      },
    });
    this.#query = activeQuery;
    try {
      await activeQuery.initializationResult();
    } catch (error) {
      activeQuery.close();
      this.#query = null;
      throw error;
    }
    this.#started = true;
    this.#consumeTask = this.#consume(activeQuery);
  }

  async getContextUsage(): Promise<ClaudeTransportContextUsage | null> {
    const activeQuery = this.#query;
    if (!this.#started || !activeQuery) return null;
    return parseContextUsage(await activeQuery.getContextUsage());
  }

  getPermissionMode(): ClaudePermissionMode {
    if (!this.#started || !this.#query) throw new Error("Claude SDK transport is not started");
    return this.#permissionMode;
  }

  async setModel(model?: string): Promise<void> {
    const activeQuery = this.#query;
    if (!this.#started || !activeQuery) throw new Error("Claude SDK transport is not started");
    await activeQuery.setModel(model);
  }

  async setThinkingOption(thinkingOptionId: HarnessThinkingOptionId): Promise<void> {
    const activeQuery = this.#query;
    if (!this.#started || !activeQuery) throw new Error("Claude SDK transport is not started");
    const id = parseClaudeThinkingOptionId(thinkingOptionId);
    const thinking = claudeThinkingConfiguration(id);
    await activeQuery.applyFlagSettings(
      thinking.enabled
        ? { alwaysThinkingEnabled: true, effortLevel: thinking.effort ?? null }
        : { alwaysThinkingEnabled: false },
    );
    this.#thinkingOptionId = id;
  }

  async setPermissionMode(permissionMode: ClaudePermissionMode): Promise<void> {
    const activeQuery = this.#query;
    if (!this.#started || !activeQuery) throw new Error("Claude SDK transport is not started");
    await activeQuery.setPermissionMode(permissionMode);
    this.#permissionMode = permissionMode;
  }

  runTurn(
    text: string,
    userMessageId: string,
    onEvent: (event: ClaudeTurnEvent) => void,
  ): Promise<ClaudeTransportTurnResult> {
    if (!this.#started || !this.#query) {
      return Promise.reject(new Error("Claude SDK transport is not started"));
    }
    if (this.#active) return Promise.reject(new Error("Claude SDK transport is busy"));
    const promise = new Promise<ClaudeTransportTurnResult>((resolve, reject) => {
      this.#active = {
        accumulator: new ClaudeNativeTurnAccumulator(),
        controlRequestIds: new Set(),
        interactions: new Map(),
        onEvent,
        resolve,
        reject,
      };
    });
    this.#input.push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      session_id: this.sessionId,
      uuid: userMessageId as `${string}-${string}-${string}-${string}-${string}`,
      origin: { kind: "human" },
    });
    return promise;
  }

  respondToInteraction(response: ClaudeInteractionResponse): Promise<void> {
    const active = this.#active;
    const pending = active?.interactions.get(response.requestId);
    if (!active || !pending) {
      return Promise.reject(new Error("Claude SDK Interaction is not pending"));
    }
    if (response.type === "approval") {
      if (pending.request.type !== "approval") {
        return Promise.reject(new Error("Claude SDK Interaction response type does not match"));
      }
      let result: PermissionResult;
      if (response.decision === "deny") {
        result = denied(pending.toolUseId, "User denied the Tool request");
      } else if (response.decision === "allowOnce") {
        result = allowed(pending.toolUseId, pending.input);
      } else {
        const requestedScope = response.decision === "allowForSession" ? "session" : "always";
        if (pending.request.suggestedScope !== requestedScope || !pending.suggestions) {
          return Promise.reject(new Error("Claude SDK Approval scope is not pending"));
        }
        result = allowed(pending.toolUseId, pending.input, pending.suggestions);
      }
      this.#settleInteraction(active, pending, result, "responded");
      return Promise.resolve();
    }
    if (pending.request.type !== "question") {
      return Promise.reject(new Error("Claude SDK Interaction response type does not match"));
    }
    if ("cancelled" in response) {
      this.#settleInteraction(
        active,
        pending,
        denied(pending.toolUseId, "User cancelled the Question"),
        "cancelled",
      );
      return Promise.resolve();
    }
    const questionTexts = new Set(pending.request.questions.map(({ question }) => question));
    const answerEntries = Object.entries(response.answers);
    if (
      answerEntries.length !== questionTexts.size ||
      answerEntries.some(
        ([question, answer]) => !questionTexts.has(question) || answer.length === 0,
      )
    ) {
      return Promise.reject(new Error("Claude SDK Question answers do not match the request"));
    }
    this.#settleInteraction(
      active,
      pending,
      {
        behavior: "allow",
        updatedInput: { ...pending.input, answers: { ...response.answers } },
        toolUseID: pending.toolUseId,
        decisionClassification: "user_temporary",
      },
      "responded",
    );
    return Promise.resolve();
  }

  async abort(): Promise<void> {
    const active = this.#active;
    const activeQuery = this.#query;
    if (!active || !activeQuery) throw new Error("Claude SDK transport has no active Turn");
    active.accumulator.requestCancel();
    await activeQuery.interrupt();
  }

  close(): Promise<void> {
    if (!this.#closePromise) this.#closePromise = this.#close();
    return this.#closePromise;
  }

  #canUseTool(
    toolName: string,
    input: Record<string, unknown>,
    options: Parameters<CanUseTool>[2],
  ): Promise<PermissionResult> {
    const active = this.#active;
    const validToolName = boundedDisplayText(toolName, APPROVAL_TITLE_MAX_LENGTH);
    if (
      !active ||
      !validToolName ||
      typeof options.requestId !== "string" ||
      options.requestId.length === 0 ||
      typeof options.toolUseID !== "string" ||
      options.toolUseID.length === 0 ||
      options.signal.aborted ||
      active.controlRequestIds.has(options.requestId)
    ) {
      return Promise.resolve(
        denied(options.toolUseID, "Claude Tool permission request is invalid"),
      );
    }

    this.#interactionOrdinal += 1;
    const requestId = `claude-${toolName === "AskUserQuestion" ? "question" : "approval"}-${this.#interactionOrdinal}`;
    let request: ClaudeInteractionRequest | null;
    if (toolName === "AskUserQuestion") {
      const questions = parseQuestions(input);
      request = questions ? { type: "question", requestId, questions } : null;
    } else {
      request = parseApprovalRequest(requestId, toolName, options);
    }
    if (!request) {
      return Promise.resolve(
        denied(options.toolUseID, "Claude Tool permission request is invalid"),
      );
    }

    return new Promise<PermissionResult>((resolve) => {
      const pending: PendingInteraction = {
        controlRequestId: options.requestId,
        input,
        request,
        resolve,
        signal: options.signal,
        ...(request.type === "approval" && request.suggestedScope && options.suggestions
          ? { suggestions: options.suggestions }
          : {}),
        toolUseId: options.toolUseID,
        onAbort: () => {
          this.#settleInteraction(
            active,
            pending,
            denied(
              pending.toolUseId,
              pending.request.type === "question"
                ? "Claude Question was interrupted"
                : "Claude Tool approval was interrupted",
            ),
            "cancelled",
          );
        },
      };
      active.interactions.set(request.requestId, pending);
      active.controlRequestIds.add(options.requestId);
      options.signal.addEventListener("abort", pending.onAbort, { once: true });
      active.onEvent({ type: "interaction.requested", request });
    });
  }

  #settleInteraction(
    active: ActiveTurn,
    pending: PendingInteraction,
    result: PermissionResult,
    reason: "responded" | "cancelled" | "superseded",
  ): void {
    if (!active.interactions.delete(pending.request.requestId)) return;
    active.controlRequestIds.delete(pending.controlRequestId);
    pending.signal.removeEventListener("abort", pending.onAbort);
    active.onEvent({
      type: "interaction.closed",
      requestId: pending.request.requestId,
      reason,
    });
    pending.resolve(result);
  }

  #closeInteractions(active: ActiveTurn, reason: "cancelled" | "superseded"): void {
    for (const pending of [...active.interactions.values()]) {
      this.#settleInteraction(
        active,
        pending,
        denied(
          pending.toolUseId,
          pending.request.type === "question"
            ? "Claude Question is no longer pending"
            : "Claude Tool approval is no longer pending",
        ),
        reason,
      );
    }
  }

  async #close(): Promise<void> {
    if (this.#active) this.#closeInteractions(this.#active, "cancelled");
    this.#input.end();
    this.#query?.close();
    await Promise.race([
      this.#consumeTask?.catch(() => undefined) ?? Promise.resolve(),
      delay(this.#closeTimeoutMs),
    ]);
    for (const child of this.#children) {
      if (!processExited(child)) child.kill("SIGTERM");
    }
    await Promise.race([
      Promise.all(this.#children.map((child) => this.#waitForExit(child))),
      delay(this.#closeTimeoutMs),
    ]);
    for (const child of this.#children) {
      if (!processExited(child)) child.kill("SIGKILL");
    }
    this.#query = null;
    const active = this.#active;
    this.#active = null;
    this.#autonomous = null;
    active?.reject(new Error("Claude SDK transport closed"));
  }

  async #consume(activeQuery: Query): Promise<void> {
    try {
      for await (const message of activeQuery) {
        const permissionMode = permissionModeFromMessage(message);
        if (permissionMode && permissionMode !== this.#permissionMode) {
          this.#permissionMode = permissionMode;
          this.#onPermissionModeChanged(permissionMode);
        }
        const active = this.#active;
        if (active) {
          const interpreted = active.accumulator.consume(message);
          for (const event of interpreted.events) active.onEvent(event);
          if (interpreted.terminal) {
            this.#closeInteractions(active, "superseded");
            this.#active = null;
            active.resolve(interpreted.terminal);
          }
          continue;
        }
        if (!this.#autonomousTurnHandler) continue;
        const autonomous =
          this.#autonomous ??
          (this.#autonomous = {
            accumulator: new ClaudeNativeTurnAccumulator(),
            events: [],
            nativeTurnKey: null,
            completedSubagents: [],
          });
        if (
          autonomous.nativeTurnKey === null &&
          isRecord(message) &&
          message.type === "user" &&
          (message.parent_tool_use_id === null || message.parent_tool_use_id === undefined) &&
          typeof message.uuid === "string" &&
          message.uuid.length > 0
        ) {
          autonomous.nativeTurnKey = message.uuid;
        }
        const completedSubagent = taskNotificationSubagent(message);
        if (completedSubagent) autonomous.completedSubagents.push(completedSubagent);
        const interpreted = autonomous.accumulator.consume(message);
        autonomous.events.push(...interpreted.events);
        if (interpreted.terminal) {
          this.#autonomous = null;
          const nativeTurnKey = autonomous.nativeTurnKey ?? `autonomous-${Date.now()}`;
          this.#autonomousTurnHandler({
            nativeTurnKey,
            events: autonomous.events,
            result: interpreted.terminal,
            ...(autonomous.completedSubagents.length > 0
              ? { completedSubagents: autonomous.completedSubagents }
              : {}),
          });
        }
      }
      if (!this.#closePromise) throw new Error("Claude SDK Query ended unexpectedly");
    } catch (error) {
      const active = this.#active;
      if (active) this.#closeInteractions(active, "cancelled");
      this.#active = null;
      active?.reject(error);
      if (!this.#closePromise) this.#onFault(error);
    }
  }

  #spawn(options: SpawnOptions): ChildProcessWithoutNullStreams {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      signal: options.signal,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      this.#stderrTail = sanitizeDiagnosticTail(`${this.#stderrTail}${chunk.toString()}`);
    });
    this.#children.push(child);
    return child;
  }

  #waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
    if (processExited(child)) return Promise.resolve();
    return new Promise((resolve) => {
      child.once("exit", () => resolve());
      child.once("error", () => resolve());
    });
  }
}

export class ClaudeSdkModelInspector implements ClaudeModelInspector {
  readonly #children: ChildProcessWithoutNullStreams[] = [];
  #stderrTail = "";
  readonly #closeTimeoutMs: number;
  readonly #command: string | undefined;
  readonly #cwd: string;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #input = new PushableInput<SDKUserMessage>();
  readonly #queryFactory: typeof query;
  #closePromise: Promise<void> | null = null;
  #query: Query | null = null;

  get stderrTail(): string {
    return this.#stderrTail;
  }

  constructor(options: ClaudeSdkModelInspectorOptions) {
    this.#closeTimeoutMs = options.closeTimeoutMs;
    this.#command = options.command;
    this.#cwd = options.cwd;
    this.#environment = options.environment ?? process.env;
    this.#queryFactory = options.queryFactory ?? query;
  }

  async inspect(): Promise<ClaudeModelInspectionSnapshot> {
    if (this.#closePromise) throw new Error("Claude SDK Model inspector is closing");
    const executable = resolveClaudeCodeExecutable({
      ...(this.#command ? { command: this.#command } : {}),
      environment: this.#environment,
    });
    const activeQuery = this.#queryFactory({
      prompt: this.#input,
      options: {
        cwd: this.#cwd,
        pathToClaudeCodeExecutable: executable,
        settingSources: ["user"],
        permissionMode: "default",
        tools: [],
        persistSession: false,
        includePartialMessages: false,
        env: withNodeRuntimeOnPath({
          ...this.#environment,
          CLAUDE_AGENT_SDK_CLIENT_APP: CLIENT_APP,
        }),
        spawnClaudeCodeProcess: (options) => this.#spawn(options),
      },
    });
    this.#query = activeQuery;
    try {
      const initialized = await activeQuery.initializationResult();
      const candidate = activeQuery as unknown as Record<string, unknown>;
      const canSelectModel =
        Array.isArray(initialized.models) && typeof candidate.setModel === "function";
      const canSelectPermissionMode = typeof candidate.setPermissionMode === "function";
      return {
        models: initialized.models,
        canSelectModel,
        canSelectPermissionMode,
      };
    } finally {
      await this.close();
    }
  }

  close(): Promise<void> {
    if (!this.#closePromise) this.#closePromise = this.#close();
    return this.#closePromise;
  }

  async #close(): Promise<void> {
    this.#input.end();
    this.#query?.close();
    for (const child of this.#children) {
      if (!processExited(child)) child.kill("SIGTERM");
    }
    await Promise.race([
      Promise.all(this.#children.map((child) => this.#waitForExit(child))),
      delay(this.#closeTimeoutMs),
    ]);
    for (const child of this.#children) {
      if (!processExited(child)) child.kill("SIGKILL");
    }
    this.#query = null;
  }

  #spawn(options: SpawnOptions): ChildProcessWithoutNullStreams {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      signal: options.signal,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      this.#stderrTail = sanitizeDiagnosticTail(`${this.#stderrTail}${chunk.toString()}`);
    });
    this.#children.push(child);
    return child;
  }

  #waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
    if (processExited(child)) return Promise.resolve();
    return new Promise((resolve) => {
      child.once("exit", () => resolve());
      child.once("error", () => resolve());
    });
  }
}
