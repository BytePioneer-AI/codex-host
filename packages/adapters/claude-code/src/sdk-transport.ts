import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import {
  query,
  type Query,
  type SDKUserMessage,
  type SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";

import { resolveClaudeCodeExecutable } from "./command.js";
import { ClaudeNativeTurnAccumulator } from "./native-message.js";
import type { ClaudeTransportTurnResult, ClaudeTurnTransport } from "./transport.js";

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

interface ActiveTurn {
  accumulator: ClaudeNativeTurnAccumulator;
  onTextDelta(delta: string): void;
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
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function processExited(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode !== null || child.signalCode !== null;
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
  }

  async start(): Promise<void> {
    if (this.#started) return;
    if (this.#closePromise) throw new Error("Claude SDK transport is closing");
    const executable = resolveClaudeCodeExecutable({
      ...(this.#command ? { command: this.#command } : {}),
      environment: this.#environment,
    });
    const activeQuery = query({
      prompt: this.#input,
      options: {
        cwd: this.#cwd,
        sessionId: this.sessionId,
        pathToClaudeCodeExecutable: executable,
        settingSources: ["user"],
        permissionMode: "dontAsk",
        tools: [],
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
    onTextDelta: (delta: string) => void,
  ): Promise<ClaudeTransportTurnResult> {
    if (!this.#started || !this.#query) {
      return Promise.reject(new Error("Claude SDK transport is not started"));
    }
    if (this.#active) return Promise.reject(new Error("Claude SDK transport is busy"));
    const promise = new Promise<ClaudeTransportTurnResult>((resolve, reject) => {
      this.#active = {
        accumulator: new ClaudeNativeTurnAccumulator(),
        onTextDelta,
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

  async #close(): Promise<void> {
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
  }

  async #consume(activeQuery: Query): Promise<void> {
    try {
      for await (const message of activeQuery) {
        const active = this.#active;
        if (!active) continue;
        const interpreted = active.accumulator.consume(message);
        for (const delta of interpreted.deltas) active.onTextDelta(delta);
        if (interpreted.terminal) {
          this.#active = null;
          active.resolve(interpreted.terminal);
        }
      }
      if (!this.#closePromise) throw new Error("Claude SDK Query ended unexpectedly");
    } catch (error) {
      const active = this.#active;
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
