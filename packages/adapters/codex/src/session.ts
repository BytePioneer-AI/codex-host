/**
 * One codexhost Harness Session backed by a Codex app-server thread.
 *
 * Each Session owns its own `codex app-server` process. Host Turn ids map onto Codex turn ids,
 * Codex notifications become Host events, and Codex server requests (command / file / permission
 * approvals, `requestUserInput`) become Host interactions answered through `interaction.respond`.
 */

import { randomUUID } from "node:crypto";

import {
  displayCommand,
  itemOutcome,
  reasoningText,
  toHostItem,
  userText,
  type CodexItem,
  type HostItem,
} from "./items.ts";
import { CodexAppServer, CodexRpcError } from "./rpc.ts";

export const HARNESS_ID = "codex";

type HostEvent = Record<string, unknown> & { type: string };
type HostInteraction = Record<string, unknown> & { type: "approval" | "question" };
type Output =
  { kind: "event"; event: HostEvent } | { kind: "interaction"; interaction: HostInteraction };
type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string; retryable: boolean } };

export interface PermissionMode {
  id: string;
  label: string;
  description: string;
  dangerous?: boolean;
  approvalPolicy: "untrusted" | "on-request" | "never";
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
}

/** Mode ids reuse Codex's sandbox names, which the Web UI already labels and guards. */
export const PERMISSION_MODES: readonly PermissionMode[] = [
  {
    id: "read-only",
    label: "Read only",
    description: "Codex can read files; edits and commands need approval.",
    approvalPolicy: "on-request",
    sandbox: "read-only",
  },
  {
    id: "workspace-write",
    label: "Auto",
    description: "Codex works in the workspace and asks before leaving it.",
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
  },
  {
    id: "danger-full-access",
    label: "Full access",
    description: "No sandbox and no approvals.",
    dangerous: true,
    approvalPolicy: "never",
    sandbox: "danger-full-access",
  },
];

export const DEFAULT_PERMISSION_MODE = "workspace-write";

export const CODEX_COMMANDS = [
  {
    id: "compact",
    invocation: "/compact",
    label: "Compact",
    description: "Summarize the conversation to free up context",
    argumentMode: "none",
  },
  {
    id: "review",
    invocation: "/review",
    label: "Review",
    description: "Review uncommitted changes, or follow your review instructions",
    argumentMode: "text",
  },
] as const;

function permissionMode(id: string | undefined): PermissionMode {
  return (
    PERMISSION_MODES.find((mode) => mode.id === id) ??
    (PERMISSION_MODES.find((mode) => mode.id === DEFAULT_PERMISSION_MODE) as PermissionMode)
  );
}

function sandboxPolicy(mode: PermissionMode, cwd: string): Record<string, unknown> {
  switch (mode.sandbox) {
    case "read-only":
      return { type: "readOnly", networkAccess: false };
    case "danger-full-access":
      return { type: "dangerFullAccess" };
    default:
      return {
        type: "workspaceWrite",
        writableRoots: [cwd],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      };
  }
}

class OutputChannel {
  private readonly values: Output[] = [];
  private readonly waiters: Array<(result: IteratorResult<Output>) => void> = [];
  private ended = false;

  readonly outputs: AsyncIterable<Output> = {
    [Symbol.asyncIterator]: () => ({
      next: () => {
        const value = this.values.shift();
        if (value !== undefined) return Promise.resolve({ done: false, value });
        if (this.ended) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    }),
  };

  emit(value: Output): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter !== undefined) waiter({ done: false, value });
    else this.values.push(value);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    if (this.values.length > 0) return;
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined });
  }
}

interface PendingRequest {
  rpcId: number | string;
  method: string;
  params: Record<string, unknown>;
  turnId: string;
}

export interface CodexSessionOptions {
  command: string;
  environment: NodeJS.ProcessEnv;
  cwd: string;
  threadId?: string;
  model?: string;
  effort?: string;
  permissionModeId?: string;
}

export class CodexSession {
  readonly harnessId = HARNESS_ID;
  readonly capabilities = {
    configuration: {
      selectModel: true,
      selectThinkingOption: true,
      selectPermissionMode: true,
      permissionModeScope: "live" as const,
    },
    history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
    /** Codex accepts input into a running turn (`turn/steer`). */
    steering: { native: true },
  };
  initialState: Record<string, unknown> = {};
  readonly initialUsage = null;
  private readonly channel = new OutputChannel();
  readonly outputs = this.channel.outputs;
  private readonly server: CodexAppServer;
  private threadId = "";
  private model: string | undefined;
  private effort: string | undefined;
  private mode: PermissionMode;
  /** Codex turn id → Host turn id. */
  private readonly turns = new Map<string, string>();
  private pendingHostTurn: string | undefined;
  private activeCodexTurn: string | undefined;
  private readonly requests = new Map<string, PendingRequest>();
  private readonly reasoningParts = new Map<string, number>();
  private closed = false;

  private constructor(private readonly options: CodexSessionOptions) {
    this.server = new CodexAppServer({
      command: options.command,
      cwd: options.cwd,
      environment: options.environment,
    });
    this.model = options.model;
    this.effort = options.effort;
    this.mode = permissionMode(options.permissionModeId);
  }

  static async open(options: CodexSessionOptions): Promise<CodexSession> {
    const session = new CodexSession(options);
    try {
      await session.start();
    } catch (error) {
      await session.server.close();
      throw error;
    }
    return session;
  }

  private async start(): Promise<void> {
    await this.server.initialize();
    this.server.onNotification((method, params) => this.onNotification(method, params));
    this.server.onServerRequest((id, method, params) => this.onServerRequest(id, method, params));
    this.server.onExit((error) => {
      if (this.closed) return;
      this.emit({
        type: "session.faulted",
        error: { code: "processExited", message: error.message, retryable: true },
      });
      this.channel.end();
    });
    const common = {
      cwd: this.options.cwd,
      approvalPolicy: this.mode.approvalPolicy,
      sandbox: this.mode.sandbox,
      ...(this.model === undefined ? {} : { model: this.model }),
    };
    const response =
      this.options.threadId === undefined
        ? await this.server.request<{
            thread: { id: string };
            model: string;
            reasoningEffort: string | null;
          }>("thread/start", common)
        : await this.server.request<{
            thread: { id: string };
            model: string;
            reasoningEffort: string | null;
          }>("thread/resume", { threadId: this.options.threadId, ...common });
    this.threadId = response.thread.id;
    this.model ??= response.model;
    this.effort ??= response.reasoningEffort ?? undefined;
    this.initialState = this.state();
  }

  private state(): Record<string, unknown> {
    return {
      nativeRef: { harnessId: HARNESS_ID, nativeSessionId: this.threadId },
      ...(this.model === undefined
        ? {}
        : { effectiveModel: { id: this.model }, resolvedModelLabel: this.model }),
      ...(this.effort === undefined ? {} : { effectiveThinkingOptionId: this.effort }),
      effectivePermissionModeId: this.mode.id,
    };
  }

  private emit(event: HostEvent): void {
    this.channel.emit({ kind: "event", event });
  }

  private hostTurn(codexTurnId: string | undefined): string | undefined {
    if (codexTurnId === undefined) return undefined;
    const known = this.turns.get(codexTurnId);
    if (known !== undefined) return known;
    // A turn we started may announce itself before `turn/start` answers.
    const hostTurnId = this.pendingHostTurn ?? `codex-turn-${codexTurnId}`;
    const autonomous = this.pendingHostTurn === undefined;
    this.pendingHostTurn = undefined;
    this.turns.set(codexTurnId, hostTurnId);
    if (autonomous) this.emit({ type: "turn.autonomous.started", turnId: hostTurnId, input: [] });
    return hostTurnId;
  }

  private onNotification(method: string, params: Record<string, unknown>): void {
    if (typeof params.threadId === "string" && params.threadId !== this.threadId) return;
    const codexTurnId =
      typeof params.turnId === "string"
        ? params.turnId
        : typeof (params.turn as { id?: unknown } | undefined)?.id === "string"
          ? (params.turn as { id: string }).id
          : undefined;
    switch (method) {
      case "turn/started": {
        const turnId = this.hostTurn(codexTurnId);
        this.activeCodexTurn = codexTurnId;
        if (turnId !== undefined) this.emit({ type: "turn.started", turnId });
        return;
      }
      case "item/started": {
        const item = toHostItem(params.item as CodexItem);
        const turnId = this.hostTurn(codexTurnId);
        if (item !== undefined && turnId !== undefined)
          this.emit({ type: "item.started", turnId, item });
        return;
      }
      case "item/completed": {
        const raw = params.item as CodexItem;
        const item = toHostItem(raw);
        const turnId = this.hostTurn(codexTurnId);
        if (item !== undefined && turnId !== undefined)
          this.emit({
            type: "item.completed",
            turnId,
            snapshot: { item, outcome: itemOutcome(raw) },
          });
        return;
      }
      case "item/agentMessage/delta":
      case "item/reasoning/summaryTextDelta":
      case "item/commandExecution/outputDelta": {
        const turnId = this.hostTurn(codexTurnId);
        if (
          turnId === undefined ||
          typeof params.itemId !== "string" ||
          typeof params.delta !== "string"
        )
          return;
        this.emit({
          type: "item.updated",
          turnId,
          itemId: params.itemId,
          update:
            method === "item/commandExecution/outputDelta"
              ? { type: "output.append", text: params.delta }
              : { type: "text.append", text: params.delta },
        });
        return;
      }
      case "item/reasoning/summaryPartAdded": {
        const turnId = this.hostTurn(codexTurnId);
        if (turnId === undefined || typeof params.itemId !== "string") return;
        const parts = (this.reasoningParts.get(params.itemId) ?? 0) + 1;
        this.reasoningParts.set(params.itemId, parts);
        if (parts > 1)
          this.emit({
            type: "item.updated",
            turnId,
            itemId: params.itemId,
            update: { type: "text.append", text: "\n\n" },
          });
        return;
      }
      case "thread/tokenUsage/updated": {
        const usage = params.tokenUsage as
          | {
              total?: Record<string, number>;
              last?: Record<string, number>;
              modelContextWindow?: number | null;
            }
          | undefined;
        if (usage?.total === undefined) return;
        this.emit({
          type: "session.usage.changed",
          ...(codexTurnId === undefined || this.turns.get(codexTurnId) === undefined
            ? {}
            : { observedForTurnId: this.turns.get(codexTurnId) }),
          usage: {
            inputTokens: usage.total.inputTokens ?? 0,
            cachedInputTokens: usage.total.cachedInputTokens ?? 0,
            outputTokens: usage.total.outputTokens ?? 0,
            reasoningOutputTokens: usage.total.reasoningOutputTokens ?? 0,
            totalTokens: usage.total.totalTokens ?? 0,
            ...(typeof usage.modelContextWindow === "number"
              ? {
                  contextWindowTokens: usage.modelContextWindow,
                  contextUsedTokens: usage.last?.inputTokens ?? 0,
                }
              : {}),
          },
        });
        return;
      }
      case "turn/completed": {
        const turn = params.turn as {
          id: string;
          status: string;
          error: { message?: string } | null;
        };
        const turnId = this.hostTurn(turn.id);
        if (this.activeCodexTurn === turn.id) this.activeCodexTurn = undefined;
        for (const [key, request] of this.requests) {
          if (request.turnId === turnId) {
            this.requests.delete(key);
            this.emit({
              type: "interaction.closed",
              interactionId: key,
              turnId,
              reason: "cancelled",
            });
          }
        }
        if (turnId === undefined) return;
        const outcome =
          turn.status === "completed"
            ? { status: "succeeded" }
            : turn.status === "interrupted"
              ? { status: "cancelled" }
              : {
                  status: "failed",
                  error: {
                    code: "nativeFailure",
                    message: turn.error?.message ?? "Codex turn failed",
                    retryable: false,
                  },
                };
        this.emit({
          type: "turn.completed",
          turnId,
          nativeTurnRef: {
            harnessId: HARNESS_ID,
            nativeSessionId: this.threadId,
            nativeTurnKey: turn.id,
          },
          outcome,
        });
        return;
      }
      case "serverRequest/resolved": {
        const key = `codex-request-${String(params.requestId ?? params.id ?? "")}`;
        const request = this.requests.get(key);
        if (request === undefined) return;
        this.requests.delete(key);
        this.emit({
          type: "interaction.closed",
          interactionId: key,
          turnId: request.turnId,
          reason: "responded",
        });
        return;
      }
      default:
        return;
    }
  }

  private onServerRequest(
    rpcId: number | string,
    method: string,
    params: Record<string, unknown>,
  ): void {
    if (typeof params.threadId === "string" && params.threadId !== this.threadId) return;
    const turnId = this.hostTurn(
      typeof params.turnId === "string" ? params.turnId : this.activeCodexTurn,
    );
    if (turnId === undefined) {
      this.server.respondError(rpcId, -32603, "No active turn");
      return;
    }
    const interactionId = `codex-request-${String(rpcId)}`;
    const reason =
      typeof params.reason === "string" && params.reason !== "" ? params.reason : undefined;
    if (
      method === "item/commandExecution/requestApproval" ||
      method === "item/fileChange/requestApproval" ||
      method === "item/permissions/requestApproval"
    ) {
      this.requests.set(interactionId, { rpcId, method, params, turnId });
      const title =
        method === "item/commandExecution/requestApproval"
          ? `Run ${typeof params.command === "string" ? displayCommand(params.command) : "command"}`
          : method === "item/fileChange/requestApproval"
            ? "Apply file changes"
            : "Grant additional permissions";
      this.channel.emit({
        kind: "interaction",
        interaction: {
          type: "approval",
          interactionId,
          turnId,
          title,
          ...(reason === undefined ? {} : { description: reason }),
          subject: { type: "nativeAction" },
          actions: [
            { id: "accept", label: "Allow once", effect: "allowOnce" },
            { id: "acceptForSession", label: "Allow for this session", effect: "allowForSession" },
            { id: "decline", label: "Deny", effect: "deny" },
          ],
        },
      });
      return;
    }
    if (method === "item/tool/requestUserInput") {
      this.requests.set(interactionId, { rpcId, method, params, turnId });
      const questions =
        (params.questions as
          | Array<{
              id: string;
              header: string;
              question: string;
              isOther: boolean;
              isSecret: boolean;
              options: Array<{ label: string; description: string }> | null;
            }>
          | undefined) ?? [];
      this.channel.emit({
        kind: "interaction",
        interaction: {
          type: "question",
          interactionId,
          turnId,
          ...(questions[0]?.header ? { title: questions[0].header } : {}),
          questions: questions.map((question) =>
            question.options !== null && question.options.length > 0
              ? {
                  id: question.id,
                  type: "choice",
                  prompt: question.question,
                  options: question.options.map((option) => ({
                    value: option.label,
                    label: option.label,
                    description: option.description,
                  })),
                  multiple: false,
                  allowOther: question.isOther,
                  optional: false,
                }
              : {
                  id: question.id,
                  type: "text",
                  prompt: question.question,
                  multiline: false,
                  secret: question.isSecret,
                  optional: false,
                },
          ),
        },
      });
      return;
    }
    // Unsupported requests (MCP elicitations, dynamic tool calls) must not hang the turn.
    this.server.respondError(rpcId, -32601, `codexhost does not handle ${method}`);
  }

  private respondInteraction(
    interactionId: string,
    response: {
      type: string;
      actionId?: string;
      answers?: Record<string, string[]>;
      cancelled?: boolean;
    },
  ): Result<{ accepted: true }> {
    const request = this.requests.get(interactionId);
    if (request === undefined)
      return {
        ok: false,
        error: {
          code: "invalidState",
          message: "The interaction is no longer pending",
          retryable: false,
        },
      };
    this.requests.delete(interactionId);
    if (request.method === "item/tool/requestUserInput") {
      const answers: Record<string, { answers: string[] }> = {};
      for (const [id, values] of Object.entries(response.answers ?? {}))
        answers[id] = { answers: values };
      this.server.respond(request.rpcId, { answers });
    } else if (request.method === "item/permissions/requestApproval") {
      const granted = response.actionId === "accept" || response.actionId === "acceptForSession";
      this.server.respond(request.rpcId, {
        permissions: granted ? (request.params.permissions ?? {}) : {},
        scope: response.actionId === "acceptForSession" ? "session" : "turn",
      });
    } else {
      const decision =
        response.actionId === "accept" || response.actionId === "acceptForSession"
          ? response.actionId
          : "decline";
      this.server.respond(request.rpcId, { decision });
    }
    this.emit({
      type: "interaction.closed",
      interactionId,
      turnId: request.turnId,
      reason: "responded",
    });
    return { ok: true, value: { accepted: true } };
  }

  async execute(command: Record<string, unknown> & { type: string }): Promise<Result<unknown>> {
    try {
      switch (command.type) {
        case "turn.start": {
          const hostTurnId = String(command.turnId);
          const input = (command.input as Array<{ type: string; text: string }>).map((part) => ({
            type: "text",
            text: part.text,
            text_elements: [],
          }));
          this.pendingHostTurn = hostTurnId;
          const response = await this.server.request<{ turn: { id: string } }>("turn/start", {
            threadId: this.threadId,
            input,
            approvalPolicy: this.mode.approvalPolicy,
            sandboxPolicy: sandboxPolicy(this.mode, this.options.cwd),
            ...(this.model === undefined ? {} : { model: this.model }),
            ...(this.effort === undefined ? {} : { effort: this.effort }),
          });
          if (!this.turns.has(response.turn.id)) {
            this.turns.set(response.turn.id, hostTurnId);
            this.pendingHostTurn = undefined;
          }
          this.activeCodexTurn = response.turn.id;
          return { ok: true, value: { turnId: hostTurnId } };
        }
        case "turn.steer": {
          const codexTurnId =
            [...this.turns].find(([, host]) => host === command.turnId)?.[0] ??
            this.activeCodexTurn;
          if (codexTurnId === undefined)
            return {
              ok: false,
              error: {
                code: "invalidState",
                message: "No running turn to steer",
                retryable: false,
              },
            };
          const input = (command.input as Array<{ type: string; text: string }>).map((part) => ({
            type: "text",
            text: part.text,
            text_elements: [],
          }));
          await this.server.request("turn/steer", {
            threadId: this.threadId,
            input,
            expectedTurnId: codexTurnId,
          });
          return { ok: true, value: { accepted: true } };
        }
        case "turn.cancel": {
          const codexTurnId =
            [...this.turns].find(([, host]) => host === command.turnId)?.[0] ??
            this.activeCodexTurn;
          if (codexTurnId !== undefined)
            await this.server.request("turn/interrupt", {
              threadId: this.threadId,
              turnId: codexTurnId,
            });
          return { ok: true, value: { cancellationRequested: true } };
        }
        case "interaction.respond":
          return this.respondInteraction(
            String(command.interactionId),
            command.response as { type: string },
          );
        case "model.select":
          this.model = (command.model as { id: string }).id;
          this.emit({ type: "session.state.changed", state: this.state() });
          return { ok: true, value: { completed: true } };
        case "thinking.select":
          this.effort = String(command.thinkingOptionId);
          this.emit({ type: "session.state.changed", state: this.state() });
          return { ok: true, value: { completed: true } };
        case "permissionMode.select":
          this.mode = permissionMode(String(command.permissionModeId));
          this.emit({ type: "session.state.changed", state: this.state() });
          return { ok: true, value: { completed: true } };
        default:
          return {
            ok: false,
            error: {
              code: "unsupported",
              message: `Unsupported command ${command.type}`,
              retryable: false,
            },
          };
      }
    } catch (error) {
      if (command.type === "turn.start") this.pendingHostTurn = undefined;
      const message =
        error instanceof CodexRpcError
          ? error.error.message
          : error instanceof Error
            ? error.message
            : String(error);
      return { ok: false, error: { code: "nativeFailure", message, retryable: false } };
    }
  }

  async readSnapshot(): Promise<Result<{ turns: unknown[]; state: Record<string, unknown> }>> {
    try {
      const response = await this.server.request<{
        thread: {
          turns: Array<{
            id: string;
            items: CodexItem[];
            status: string;
            error: { message?: string } | null;
            startedAt: number | null;
            completedAt: number | null;
          }>;
        };
      }>("thread/read", { threadId: this.threadId, includeTurns: true });
      return {
        ok: true,
        value: {
          turns: response.thread.turns.map((turn) => snapshotTurn(this.threadId, turn)),
          state: this.state(),
        },
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "nativeFailure",
          message: error instanceof Error ? error.message : String(error),
          retryable: true,
        },
      };
    }
  }

  /** Codex slash commands that run as turns: context compaction and inline code review. */
  readonly commands = {
    list: async (): Promise<Result<{ commands: readonly unknown[]; source: "static" }>> => ({
      ok: true,
      value: { commands: CODEX_COMMANDS, source: "static" },
    }),
    execute: async (command: {
      turnId: string;
      commandId: string;
      arguments?: { text?: string };
    }): Promise<Result<{ turnId: string }>> => {
      try {
        this.pendingHostTurn = command.turnId;
        if (command.commandId === "compact") {
          await this.server.request("thread/compact/start", { threadId: this.threadId });
        } else if (command.commandId === "review") {
          const instructions = command.arguments?.text?.trim();
          const response = await this.server.request<{ turn: { id: string } }>("review/start", {
            threadId: this.threadId,
            target:
              instructions === undefined || instructions === ""
                ? { type: "uncommittedChanges" }
                : { type: "custom", instructions },
            delivery: "inline",
          });
          if (!this.turns.has(response.turn.id)) {
            this.turns.set(response.turn.id, command.turnId);
            this.pendingHostTurn = undefined;
          }
        } else {
          this.pendingHostTurn = undefined;
          return {
            ok: false,
            error: {
              code: "unsupported",
              message: `Unknown Codex command ${command.commandId}`,
              retryable: false,
            },
          };
        }
        return { ok: true, value: { turnId: command.turnId } };
      } catch (error) {
        this.pendingHostTurn = undefined;
        return {
          ok: false,
          error: {
            code: "nativeFailure",
            message: error instanceof Error ? error.message : String(error),
            retryable: false,
          },
        };
      }
    },
  };

  hasBackgroundWork(): boolean {
    return this.activeCodexTurn !== undefined;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.server.close();
    this.channel.end();
  }
}

/** One historical Codex turn in Host snapshot form. */
export function snapshotTurn(
  threadId: string,
  turn: {
    id: string;
    items: CodexItem[];
    status: string;
    error: { message?: string } | null;
    startedAt: number | null;
    completedAt: number | null;
  },
): Record<string, unknown> {
  const input = turn.items
    .filter((item) => item.type === "userMessage")
    .map((item) => ({ type: "text", text: userText(item) }));
  const items = turn.items
    .map((raw) => {
      const item: HostItem | undefined = toHostItem(raw);
      return item === undefined
        ? undefined
        : {
            item: item.type === "reasoning" ? { ...item, text: reasoningText(raw) } : item,
            outcome: itemOutcome(raw),
          };
    })
    .filter((entry) => entry !== undefined);
  return {
    nativeTurnRef: { harnessId: HARNESS_ID, nativeSessionId: threadId, nativeTurnKey: turn.id },
    input: input.length > 0 ? input : [{ type: "text", text: "" }],
    items,
    outcome:
      turn.status === "completed"
        ? { status: "succeeded" }
        : turn.status === "interrupted"
          ? { status: "cancelled" }
          : turn.status === "failed"
            ? {
                status: "failed",
                error: {
                  code: "nativeFailure",
                  message: turn.error?.message ?? "Turn failed",
                  retryable: false,
                },
              }
            : { status: "unknown", reason: turn.status },
    ...(turn.startedAt === null ? {} : { startedAtMs: turn.startedAt * 1000 }),
    ...(turn.completedAt === null ? {} : { completedAtMs: turn.completedAt * 1000 }),
  };
}

export function newTurnId(): string {
  return `turn-${randomUUID()}`;
}
