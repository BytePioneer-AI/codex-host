import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { query, qodercliAuth } from "@qoder-ai/qoder-agent-sdk";
import { withNodeRuntimeOnPath } from "@codexhost/harness-discovery";
import { sanitizeDiagnosticTail } from "@codexhost/harness-adapter";
import type { JsonValue } from "@codexhost/shared-contracts";

import { resolveQoderExecutable } from "./command.js";
import { closeQoderProcessGroup } from "./process-fence.js";
import type { QoderPermissionMode } from "./permission-modes.js";

const CLIENT_APP = "codexhost-qodercli-adapter/0.0.0";
const DEFAULT_ABORT_TIMEOUT_MS = 2_000;

class PushableInput<T> implements AsyncIterable<T> {
  #closed = false;
  #queue: T[] = [];
  #waiters: Array<(result: IteratorResult<T>) => void> = [];

  push(value: T): void {
    if (this.#closed) throw new Error("Qoder SDK input is closed");
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

export type QoderInteractionRequest =
  | {
      type: "approval";
      requestId: string;
      toolName: string;
      title: string;
      description?: string;
      input: Record<string, unknown>;
    }
  | {
      type: "question";
      requestId: string;
      questions: Array<{
        question: string;
        header: string;
        options: Array<{ label: string; description: string }>;
        multiSelect: boolean;
      }>;
    };

export type QoderInteractionResponse =
  | { type: "approval"; requestId: string; decision: "allowOnce" | "allowForSession" | "deny" }
  | { type: "question"; requestId: string; answers: Record<string, string>; cancelled?: boolean };

export type QoderTurnEvent =
  | { type: "text.delta"; itemKey: string; delta: string }
  | { type: "reasoning.delta"; itemKey: string; delta: string }
  | { type: "tool.started"; callId: string; toolName: string; arguments: JsonValue }
  | { type: "tool.completed"; callId: string; output: string; isError: boolean }
  | { type: "interaction.requested"; request: QoderInteractionRequest }
  | {
      type: "interaction.closed";
      requestId: string;
      reason: "responded" | "cancelled" | "superseded";
    };

export interface QoderTurnResult {
  status: "succeeded" | "cancelled" | "failed";
  nativeTurnKey: string;
  errorMessage?: string;
}

export interface QoderQuery {
  [Symbol.asyncIterator](): AsyncIterator<unknown>;
  initializationResult(): Promise<unknown>;
  interrupt(): Promise<unknown>;
  close(): void;
  setModel?(model: string): Promise<void>;
  setPermissionMode?(mode: QoderPermissionMode): Promise<void>;
}

export type QoderQueryFactory = (input: {
  prompt: AsyncIterable<unknown>;
  options: Record<string, unknown>;
}) => QoderQuery;

export interface QoderSdkTransportOptions {
  cwd: string;
  environment: NodeJS.ProcessEnv;
  command?: string;
  sessionId: string;
  openMode: "create" | "resume";
  model?: string;
  permissionMode: QoderPermissionMode;
  unattended?: boolean;
  closeTimeoutMs?: number;
  abortTimeoutMs?: number;
  queryFactory?: QoderQueryFactory;
  onFault(error: unknown): void;
  onIdentity?(sessionId: string): void;
}

interface PendingInteraction {
  request: QoderInteractionRequest;
  resolve(result: {
    behavior: "allow" | "deny";
    updatedInput?: Record<string, unknown>;
    updatedPermissions?: unknown;
    message?: string;
    toolUseID?: string;
  }): void;
  toolUseId: string;
  input: Record<string, unknown>;
  suggestions?: unknown;
  signal: AbortSignal;
  onAbort(): void;
}

interface ActiveTurn {
  nativeTurnKey: string;
  onEvent(event: QoderTurnEvent): void;
  resolve(result: QoderTurnResult): void;
  reject(error: unknown): void;
  interactions: Map<string, PendingInteraction>;
  streamedText: string;
  streamedReasoning: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectAfter(
  milliseconds: number,
  message: string,
): { promise: Promise<never>; cancel(): void } {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), milliseconds);
  });
  return {
    promise,
    cancel() {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    },
  };
}

function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function contentBlocks(message: Record<string, unknown>): unknown[] {
  if (Array.isArray(message.content)) return message.content;
  if (isRecord(message.message) && Array.isArray(message.message.content)) {
    return message.message.content;
  }
  return [];
}

export class QoderSdkTransport {
  sessionId: string;
  readonly #cwd: string;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #command: string | undefined;
  readonly #openMode: "create" | "resume";
  readonly #model: string | undefined;
  readonly #unattended: boolean;
  readonly #closeTimeoutMs: number;
  readonly #abortTimeoutMs: number;
  readonly #queryFactory: QoderQueryFactory;
  readonly #onFault: (error: unknown) => void;
  readonly #onIdentity: ((sessionId: string) => void) | undefined;
  readonly #input = new PushableInput<unknown>();
  readonly #children: ChildProcessWithoutNullStreams[] = [];
  #permissionMode: QoderPermissionMode;
  #query: QoderQuery | null = null;
  #started = false;
  #closePromise: Promise<void> | null = null;
  #consumeTask: Promise<void> | null = null;
  #active: ActiveTurn | null = null;
  #interactionOrdinal = 0;

  constructor(options: QoderSdkTransportOptions) {
    this.sessionId = options.sessionId;
    this.#cwd = options.cwd;
    this.#environment = options.environment;
    this.#command = options.command;
    this.#openMode = options.openMode;
    this.#model = options.model;
    this.#unattended = options.unattended === true;
    this.#permissionMode = options.permissionMode;
    this.#closeTimeoutMs = options.closeTimeoutMs ?? 8_000;
    this.#abortTimeoutMs = options.abortTimeoutMs ?? DEFAULT_ABORT_TIMEOUT_MS;
    this.#onFault = options.onFault;
    this.#onIdentity = options.onIdentity;
    this.#queryFactory = options.queryFactory ?? ((input) => query(input as never) as QoderQuery);
  }

  async start(): Promise<void> {
    if (this.#started) return;
    if (this.#closePromise) throw new Error("Qoder SDK transport is closing");
    const executable = resolveQoderExecutable({
      ...(this.#command ? { command: this.#command } : {}),
      environment: this.#environment,
    });
    const activeQuery = this.#queryFactory({
      prompt: this.#input,
      options: {
        cwd: this.#cwd,
        auth: qodercliAuth(),
        pathToQoderCLIExecutable: executable,
        persistSession: true,
        includePartialMessages: true,
        permissionMode: this.#permissionMode,
        ...(this.#unattended
          ? { allowDangerouslySkipPermissions: true, permissionMode: "bypassPermissions" }
          : {}),
        ...(this.#model ? { model: this.#model } : {}),
        ...(this.#openMode === "resume"
          ? { resume: this.sessionId }
          : { sessionId: this.sessionId }),
        env: withNodeRuntimeOnPath({
          ...this.#environment,
          QODER_AGENT_SDK_CLIENT_APP: CLIENT_APP,
        }),
        canUseTool: (
          toolName: string,
          input: Record<string, unknown>,
          context: {
            toolUseID: string;
            signal: AbortSignal;
            title?: string;
            description?: string;
            suggestions?: unknown;
          },
        ) => this.#canUseTool(toolName, input, context),
        spawnQoderCLIProcess: (spawnOptions: {
          command: string;
          args: string[];
          cwd?: string;
          env?: NodeJS.ProcessEnv;
          signal?: AbortSignal;
        }) => this.#spawn(spawnOptions),
      },
    });
    this.#query = activeQuery;
    try {
      const initialized = await activeQuery.initializationResult();
      if (isRecord(initialized) && typeof initialized.session_id === "string") {
        this.sessionId = initialized.session_id;
      }
    } catch (error) {
      activeQuery.close();
      this.#query = null;
      throw error;
    }
    this.#started = true;
    this.#consumeTask = this.#consume(activeQuery);
  }

  async setModel(model: string): Promise<void> {
    if (!this.#query?.setModel) throw new Error("Qoder SDK cannot select a Model at runtime");
    await this.#query.setModel(model);
  }

  async setPermissionMode(mode: QoderPermissionMode): Promise<void> {
    if (!this.#query?.setPermissionMode) {
      throw new Error("Qoder SDK cannot select a Permission Mode at runtime");
    }
    await this.#query.setPermissionMode(mode);
    this.#permissionMode = mode;
  }

  runTurn(
    text: string,
    nativeTurnKey: string,
    onEvent: (event: QoderTurnEvent) => void,
  ): Promise<QoderTurnResult> {
    if (this.#closePromise || !this.#started || !this.#query) {
      return Promise.reject(new Error("Qoder SDK transport is not started"));
    }
    if (this.#active) return Promise.reject(new Error("Qoder SDK transport is busy"));
    const promise = new Promise<QoderTurnResult>((resolve, reject) => {
      this.#active = {
        nativeTurnKey,
        onEvent,
        resolve,
        reject,
        interactions: new Map(),
        streamedText: "",
        streamedReasoning: "",
      };
    });
    this.#input.push({
      type: "user",
      uuid: nativeTurnKey,
      session_id: this.sessionId,
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [{ type: "text", text }],
      },
    });
    return promise;
  }

  async cancel(): Promise<void> {
    if (!this.#query || !this.#active) return;
    const timeout = rejectAfter(this.#abortTimeoutMs, "Qoder SDK interrupt timed out");
    try {
      await Promise.race([this.#query.interrupt(), timeout.promise]);
    } finally {
      timeout.cancel();
    }
  }

  respondToInteraction(response: QoderInteractionResponse): Promise<void> {
    const pending = this.#active?.interactions.get(response.requestId);
    if (!this.#active || !pending) {
      return Promise.reject(new Error("Qoder SDK Interaction is not pending"));
    }
    if (response.type === "approval") {
      if (pending.request.type !== "approval") {
        return Promise.reject(new Error("Qoder SDK Interaction response type does not match"));
      }
      if (response.decision === "deny") {
        this.#settleInteraction(
          pending,
          {
            behavior: "deny",
            message: "The user denied this operation.",
            toolUseID: pending.toolUseId,
          },
          "responded",
        );
        return Promise.resolve();
      }
      this.#settleInteraction(
        pending,
        {
          behavior: "allow",
          updatedInput: pending.input,
          toolUseID: pending.toolUseId,
          ...(response.decision === "allowForSession" && pending.suggestions
            ? { updatedPermissions: pending.suggestions }
            : {}),
        },
        "responded",
      );
      return Promise.resolve();
    }
    if (pending.request.type !== "question") {
      return Promise.reject(new Error("Qoder SDK Interaction response type does not match"));
    }
    if (response.cancelled) {
      this.#settleInteraction(
        pending,
        {
          behavior: "deny",
          message: "The user cancelled the questions.",
          toolUseID: pending.toolUseId,
        },
        "responded",
      );
      return Promise.resolve();
    }
    this.#settleInteraction(
      pending,
      {
        behavior: "allow",
        updatedInput: {
          questions: pending.request.questions,
          answers: response.answers,
        },
        toolUseID: pending.toolUseId,
      },
      "responded",
    );
    return Promise.resolve();
  }

  async close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closePromise = this.#close();
    return this.#closePromise;
  }

  #spawn(options: {
    command: string;
    args: string[];
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
  }): ChildProcessWithoutNullStreams {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd ?? this.#cwd,
      env: options.env ?? this.#environment,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      ...(process.platform === "win32" ? {} : { detached: true }),
    });
    this.#children.push(child);
    child.stderr.resume();
    return child;
  }

  #waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
      child.once("exit", () => resolve());
      child.once("error", () => resolve());
    });
  }

  #observeIdentity(message: unknown): void {
    if (!isRecord(message)) return;
    const sessionId =
      typeof message.session_id === "string"
        ? message.session_id
        : isRecord(message.message) && typeof message.message.session_id === "string"
          ? message.message.session_id
          : undefined;
    if (sessionId && sessionId !== this.sessionId) {
      this.sessionId = sessionId;
      this.#onIdentity?.(sessionId);
    }
  }

  #appendStreamed(active: ActiveTurn, kind: "text" | "reasoning", complete: string): void {
    const current = kind === "text" ? active.streamedText : active.streamedReasoning;
    if (complete.length === 0) return;
    let delta = complete;
    if (current.length > 0) {
      if (complete === current) return;
      if (!complete.startsWith(current)) return;
      delta = complete.slice(current.length);
      if (delta.length === 0) return;
    }
    if (kind === "text") active.streamedText += delta;
    else active.streamedReasoning += delta;
    active.onEvent({
      type: kind === "text" ? "text.delta" : "reasoning.delta",
      itemKey: kind === "text" ? "assistant" : "reasoning",
      delta,
    });
  }

  #canUseTool(
    toolName: string,
    input: Record<string, unknown>,
    context: {
      toolUseID: string;
      signal: AbortSignal;
      title?: string;
      description?: string;
      suggestions?: unknown;
    },
  ): Promise<{
    behavior: "allow" | "deny";
    updatedInput?: Record<string, unknown>;
    updatedPermissions?: unknown;
    message?: string;
    toolUseID?: string;
  }> {
    const active = this.#active;
    if (!active) {
      return Promise.resolve({
        behavior: "deny",
        message: "Qoder Tool request arrived with no active Turn",
        toolUseID: context.toolUseID,
      });
    }
    const requestId = `qoder-interaction-${++this.#interactionOrdinal}`;
    const request: QoderInteractionRequest =
      toolName === "AskUserQuestion"
        ? {
            type: "question",
            requestId,
            questions: Array.isArray(input.questions)
              ? input.questions.flatMap((value) => {
                  if (!isRecord(value) || typeof value.question !== "string") return [];
                  return [
                    {
                      question: value.question,
                      header: typeof value.header === "string" ? value.header : value.question,
                      options: Array.isArray(value.options)
                        ? value.options.flatMap((option) =>
                            isRecord(option) && typeof option.label === "string"
                              ? [
                                  {
                                    label: option.label,
                                    description:
                                      typeof option.description === "string"
                                        ? option.description
                                        : option.label,
                                  },
                                ]
                              : [],
                          )
                        : [],
                      multiSelect: value.multiSelect === true,
                    },
                  ];
                })
              : [],
          }
        : {
            type: "approval",
            requestId,
            toolName,
            title: context.title?.trim() || toolName,
            ...(context.description ? { description: context.description } : {}),
            input,
          };
    return new Promise((resolve) => {
      const pending: PendingInteraction = {
        request,
        resolve,
        toolUseId: context.toolUseID,
        input,
        suggestions: context.suggestions,
        signal: context.signal,
        onAbort: () => {
          this.#settleInteraction(
            pending,
            {
              behavior: "deny",
              message: "The request was cancelled.",
              toolUseID: context.toolUseID,
            },
            "cancelled",
          );
        },
      };
      active.interactions.set(requestId, pending);
      context.signal.addEventListener("abort", pending.onAbort, { once: true });
      active.onEvent({ type: "interaction.requested", request });
    });
  }

  #settleInteraction(
    pending: PendingInteraction,
    result: {
      behavior: "allow" | "deny";
      updatedInput?: Record<string, unknown>;
      updatedPermissions?: unknown;
      message?: string;
      toolUseID?: string;
    },
    reason: "responded" | "cancelled" | "superseded",
  ): void {
    const active = this.#active;
    if (!active?.interactions.delete(pending.request.requestId)) return;
    pending.signal.removeEventListener("abort", pending.onAbort);
    active.onEvent({
      type: "interaction.closed",
      requestId: pending.request.requestId,
      reason,
    });
    pending.resolve(result);
  }

  #closeInteractions(reason: "cancelled" | "superseded"): void {
    const active = this.#active;
    if (!active) return;
    for (const pending of [...active.interactions.values()]) {
      this.#settleInteraction(
        pending,
        {
          behavior: "deny",
          message: "Qoder Interaction is no longer pending",
          toolUseID: pending.toolUseId,
        },
        reason,
      );
    }
  }

  #project(message: unknown, active: ActiveTurn): QoderTurnResult | undefined {
    if (!isRecord(message)) return undefined;
    if (
      message.type === "stream_event" &&
      isRecord(message.event) &&
      isRecord(message.event.delta)
    ) {
      const delta = message.event.delta;
      if (delta.type === "text_delta" && typeof delta.text === "string") {
        this.#appendStreamed(active, "text", `${active.streamedText}${delta.text}`);
      } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
        this.#appendStreamed(active, "reasoning", `${active.streamedReasoning}${delta.thinking}`);
      }
    }
    if (message.type === "assistant") {
      for (const block of contentBlocks(message)) {
        if (!isRecord(block)) continue;
        if (block.type === "text" && typeof block.text === "string") {
          this.#appendStreamed(active, "text", block.text);
        } else if (block.type === "thinking" && typeof block.thinking === "string") {
          this.#appendStreamed(active, "reasoning", block.thinking);
        } else if (block.type === "tool_use" && typeof block.name === "string") {
          const callId = typeof block.id === "string" ? block.id : block.name;
          active.onEvent({
            type: "tool.started",
            callId,
            toolName: block.name,
            arguments: (block.input as JsonValue) ?? null,
          });
        }
      }
    }
    if (message.type === "user") {
      for (const block of contentBlocks(message)) {
        if (!isRecord(block) || block.type !== "tool_result") continue;
        const callId = typeof block.tool_use_id === "string" ? block.tool_use_id : "tool";
        active.onEvent({
          type: "tool.completed",
          callId,
          output: asText(block.content ?? block.output),
          isError: block.is_error === true,
        });
      }
    }
    if (message.type === "result") {
      const subtype = typeof message.subtype === "string" ? message.subtype : "success";
      if (subtype === "success") {
        return { status: "succeeded", nativeTurnKey: active.nativeTurnKey };
      }
      if (subtype === "error") {
        return {
          status: "failed",
          nativeTurnKey: active.nativeTurnKey,
          errorMessage: sanitizeDiagnosticTail(asText(message.errors ?? message.result)),
        };
      }
      return { status: "cancelled", nativeTurnKey: active.nativeTurnKey };
    }
    return undefined;
  }

  async #consume(activeQuery: QoderQuery): Promise<void> {
    try {
      for await (const message of activeQuery) {
        this.#observeIdentity(message);
        const active = this.#active;
        if (!active) continue;
        const terminal = this.#project(message, active);
        if (!terminal) continue;
        this.#closeInteractions("superseded");
        this.#active = null;
        active.resolve(terminal);
      }
    } catch (error) {
      this.#closeInteractions("cancelled");
      const active = this.#active;
      this.#active = null;
      active?.reject(error);
      if (!this.#closePromise) this.#onFault(error);
    }
  }

  async #close(): Promise<void> {
    this.#closeInteractions("cancelled");
    const failures: unknown[] = [];
    const stopOwnedProcesses = async (): Promise<void> => {
      const stopped = await Promise.allSettled(
        this.#children.map((child) => closeQoderProcessGroup(child, this.#closeTimeoutMs)),
      );
      for (const result of stopped) if (result.status === "rejected") failures.push(result.reason);
    };
    if (process.platform === "win32") await stopOwnedProcesses();
    this.#input.end();
    try {
      this.#query?.close();
    } catch (error) {
      failures.push(error);
    }
    if (process.platform !== "win32") await stopOwnedProcesses();
    const exitTimeout = rejectAfter(this.#closeTimeoutMs, "Qoder SDK process did not exit");
    try {
      await Promise.race([
        Promise.all(this.#children.map((child) => this.#waitForExit(child))),
        exitTimeout.promise,
      ]);
    } catch (error) {
      failures.push(error);
    } finally {
      exitTimeout.cancel();
    }
    const drainTimeout = rejectAfter(this.#closeTimeoutMs, "Qoder SDK output did not drain");
    try {
      await Promise.race([
        this.#consumeTask?.catch(() => undefined) ?? Promise.resolve(),
        drainTimeout.promise,
      ]);
    } catch (error) {
      failures.push(error);
    } finally {
      drainTimeout.cancel();
    }
    this.#query = null;
    const active = this.#active;
    this.#active = null;
    active?.reject(new Error("Qoder SDK transport closed"));
    if (failures.length > 0) {
      throw new AggregateError(failures, "Qoder SDK shutdown could not be confirmed");
    }
  }
}
