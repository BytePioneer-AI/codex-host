import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import {
  query,
  type CanUseTool,
  type PermissionResult,
  type Query,
  type SDKUserMessage,
  type SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";

import { resolveClaudeCodeExecutable } from "./command.js";
import { ClaudeNativeTurnAccumulator } from "./native-message.js";
import type {
  ClaudeInteractionResponse,
  ClaudeQuestion,
  ClaudeQuestionRequest,
  ClaudeTransportTurnResult,
  ClaudeTurnEvent,
  ClaudeTurnTransport,
} from "./transport.js";

const CLIENT_APP = "codexhost-claude-code-adapter/0.0.0";

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
  input: Record<string, unknown>;
  onAbort(): void;
  request: ClaudeQuestionRequest;
  resolve(result: PermissionResult): void;
  signal: AbortSignal;
}

interface ActiveTurn {
  accumulator: ClaudeNativeTurnAccumulator;
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
  closeTimeoutMs: number;
  onFault(error: unknown): void;
  queryFactory?: typeof query;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function processExited(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function denied(toolUseId: string, message: string): PermissionResult {
  return {
    behavior: "deny",
    message,
    toolUseID: toolUseId,
    decisionClassification: "user_reject",
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
  readonly #onFault: (error: unknown) => void;
  readonly #queryFactory: typeof query;
  #active: ActiveTurn | null = null;
  #closePromise: Promise<void> | null = null;
  #consumeTask: Promise<void> | null = null;
  #query: Query | null = null;
  #started = false;

  constructor(options: ClaudeSdkTransportOptions) {
    this.sessionId = options.sessionId;
    this.#cwd = options.cwd;
    this.#closeTimeoutMs = options.closeTimeoutMs;
    this.#command = options.command;
    this.#environment = options.environment ?? process.env;
    this.#onFault = options.onFault;
    this.#queryFactory = options.queryFactory ?? query;
  }

  async start(): Promise<void> {
    if (this.#started) return;
    if (this.#closePromise) throw new Error("Claude SDK transport is closing");
    const executable = resolveClaudeCodeExecutable({
      ...(this.#command ? { command: this.#command } : {}),
      environment: this.#environment,
    });
    const activeQuery = this.#queryFactory({
      prompt: this.#input,
      options: {
        cwd: this.#cwd,
        sessionId: this.sessionId,
        pathToClaudeCodeExecutable: executable,
        settingSources: ["user"],
        permissionMode: "default",
        canUseTool: (toolName, input, options) => this.#canUseTool(toolName, input, options),
        persistSession: true,
        includePartialMessages: true,
        env: {
          ...this.#environment,
          CLAUDE_AGENT_SDK_CLIENT_APP: CLIENT_APP,
        },
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
    if ("cancelled" in response) {
      this.#settleInteraction(
        active,
        pending,
        denied(pending.request.toolUseId, "User cancelled the Question"),
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
        toolUseID: pending.request.toolUseId,
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
    if (toolName !== "AskUserQuestion") {
      return Promise.resolve(
        denied(options.toolUseID, "Interactive Tool permission is unsupported"),
      );
    }
    const active = this.#active;
    const questions = parseQuestions(input);
    if (
      !active ||
      !questions ||
      options.requestId.length === 0 ||
      options.toolUseID.length === 0 ||
      active.interactions.has(options.requestId)
    ) {
      return Promise.resolve(denied(options.toolUseID, "Claude Question request is invalid"));
    }
    const request: ClaudeQuestionRequest = {
      requestId: options.requestId,
      toolUseId: options.toolUseID,
      questions,
    };
    return new Promise<PermissionResult>((resolve) => {
      const pending: PendingInteraction = {
        input,
        request,
        resolve,
        signal: options.signal,
        onAbort: () => {
          this.#settleInteraction(
            active,
            pending,
            denied(request.toolUseId, "Claude Question was interrupted"),
            "cancelled",
          );
        },
      };
      active.interactions.set(request.requestId, pending);
      options.signal.addEventListener("abort", pending.onAbort, { once: true });
      if (options.signal.aborted) {
        pending.onAbort();
        return;
      }
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
        denied(pending.request.toolUseId, "Claude Question is no longer pending"),
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
    active?.reject(new Error("Claude SDK transport closed"));
  }

  async #consume(activeQuery: Query): Promise<void> {
    try {
      for await (const message of activeQuery) {
        const active = this.#active;
        if (!active) continue;
        const interpreted = active.accumulator.consume(message);
        for (const delta of interpreted.deltas) {
          active.onEvent({ type: "text.delta", delta });
        }
        if (interpreted.terminal) {
          this.#closeInteractions(active, "superseded");
          this.#active = null;
          active.resolve(interpreted.terminal);
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
    child.stderr.resume();
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
