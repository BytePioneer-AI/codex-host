/**
 * One codexhost Harness Session backed by a Codex app-server thread.
 *
 * Each Session owns its own `codex app-server` process. Host Turn ids map onto Codex turn ids,
 * Codex notifications become Host events, and Codex server requests (command / file / permission
 * approvals, `requestUserInput`) become Host interactions answered through `interaction.respond`.
 */

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
import { CodexModelSelection, CodexSettingsUnconfirmedError } from "./model-selection.ts";
import { CodexUsage } from "./usage.ts";
import {
  confirmedPermissionMode,
  permissionMode,
  sandboxPolicy,
  type PermissionMode,
} from "./permission-modes.ts";
import type { HarnessSessionUsageCapability } from "@codexhost/harness-adapter/plugin";

export const HARNESS_ID = harnessIdSchema.parse("codex-cli");

import {
  HarnessOutputChannel,
  unsupportedSteer,
  type HarnessOutput,
  type HostEvent,
  type HarnessSession,
  type HarnessSessionState,
  type HarnessResult,
  type HostCommand,
  type HostThreadSnapshot,
  type HostTurnSnapshot,
  type HarnessCommandCapability,
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
  type TurnOutcome,
  type HostUsage,
} from "@codexhost/harness-adapter";
import {
  harnessIdSchema,
  harnessCommandCatalogSchema,
  harnessThinkingOptionIdSchema,
  harnessPermissionModeIdSchema,
  hostTurnIdSchema,
  hostInteractionIdSchema,
  hostItemIdSchema,
  nativeSessionRefSchema,
  nativeTurnRefSchema,
  type HostTurnId,
  type HostInteractionId,
} from "@codexhost/shared-contracts";
type Result<T> = HarnessResult<T>;

export const CODEX_COMMANDS = harnessCommandCatalogSchema.parse({
  commands: [
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
  ],
}).commands;

interface PendingRequest {
  rpcId: number | string;
  method: string;
  params: Record<string, unknown>;
  turnId: HostTurnId;
}

export interface CodexSessionOptions {
  usage: HarnessSessionUsageCapability;
  command: string;
  environment: NodeJS.ProcessEnv;
  cwd: string;
  threadId?: string;
  model?: string;
  effort?: string;
  permissionModeId?: string;
}

export class CodexSession implements HarnessSession {
  readonly harnessId = HARNESS_ID;
  readonly capabilities = {
    steer: false,
    configuration: {
      selectModel: true,
      selectThinkingOption: true,
      selectPermissionMode: true,
      permissionModeScope: "live" as const,
    },
    history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
  };
  initialState: HarnessSessionState = {};
  initialUsage: HostUsage | null = null;
  private readonly usage: CodexUsage;
  private readonly channel = new HarnessOutputChannel<HarnessOutput>();
  readonly outputs = this.channel.outputs;
  private readonly server: CodexAppServer;
  private threadId = "";
  private readonly modelSelection: CodexModelSelection;
  private effort: string | undefined;
  private mode: PermissionMode | undefined;
  private effectivePermissionModeId: string | undefined;
  /** Codex turn id → Host turn id. */
  private readonly turns = new Map<string, HostTurnId>();
  private pendingHostTurn: HostTurnId | undefined;
  private activeCodexTurn: string | undefined;
  private readonly requests = new Map<string, PendingRequest>();
  private readonly reasoningParts = new Map<string, number>();
  private readonly activeItems = new Map<HostTurnId, Map<string, HostItem>>();
  private closed = false;

  private constructor(private readonly options: CodexSessionOptions) {
    this.server = new CodexAppServer({
      command: options.command,
      cwd: options.cwd,
      environment: options.environment,
    });
    this.modelSelection = new CodexModelSelection(this.server);
    this.effort = options.effort;
    this.mode = permissionMode(options.permissionModeId);
    this.usage = new CodexUsage(
      options.usage,
      () => this.threadId,
      () => this.modelSelection.model,
      (event) => this.emit(event),
      options.threadId === undefined,
    );
  }

  static async open(options: CodexSessionOptions): Promise<Result<CodexSession>> {
    const session = new CodexSession(options);
    try {
      await session.start();
    } catch (error) {
      await session.close();
      throw error;
    }
    return { ok: true, value: session };
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
    const modelSettings = await this.modelSelection.initialize(this.options.model);
    const common = {
      cwd: this.options.cwd,
      ...(this.mode === undefined
        ? {}
        : { approvalPolicy: this.mode.approvalPolicy, sandbox: this.mode.sandbox }),
      ...modelSettings,
    };
    const response =
      this.options.threadId === undefined
        ? await this.server.request<{
            thread: { id: string };
            model: string;
            reasoningEffort: string | null;
            serviceTier?: string | null;
            approvalPolicy?: unknown;
            sandbox?: unknown;
          }>("thread/start", { ...common, experimentalRawEvents: true })
        : await this.server.request<{
            thread: { id: string };
            model: string;
            reasoningEffort: string | null;
            serviceTier?: string | null;
            approvalPolicy?: unknown;
            sandbox?: unknown;
          }>("thread/resume", { threadId: this.options.threadId, ...common });
    if (this.options.threadId !== undefined && response.thread.id !== this.options.threadId)
      throw new Error("Codex CLI resumed a different native Session");
    this.threadId = response.thread.id;
    if (modelSettings.serviceTier === "priority" && response.serviceTier !== "priority")
      throw new Error("Codex did not confirm the requested Fast service tier");
    this.modelSelection.confirm(response);
    const confirmedMode = confirmedPermissionMode(response.approvalPolicy, response.sandbox);
    if (this.mode && confirmedMode?.id !== this.mode.id)
      throw new Error("Codex did not confirm the requested Permission Mode");
    this.effectivePermissionModeId = confirmedMode?.id;
    this.effort ??= response.reasoningEffort ?? undefined;
    this.initialState = this.state();
    await this.usage.refresh();
    this.initialUsage = this.usage.current;
  }

  private state(): HarnessSessionState {
    return {
      nativeRef: nativeSessionRefSchema.parse({
        formatVersion: 1,
        harnessId: HARNESS_ID,
        nativeSessionId: this.threadId,
      }),
      ...this.modelSelection.state(),
      ...(this.effort === undefined
        ? {}
        : { effectiveThinkingOptionId: harnessThinkingOptionIdSchema.parse(this.effort) }),
      ...(this.effectivePermissionModeId === undefined
        ? {}
        : {
            effectivePermissionModeId: harnessPermissionModeIdSchema.parse(
              this.effectivePermissionModeId,
            ),
          }),
    };
  }

  private emit(event: HostEvent): void {
    if (event.type === "item.started") {
      let items = this.activeItems.get(event.turnId);
      if (!items) this.activeItems.set(event.turnId, (items = new Map()));
      items.set(event.item.itemId, event.item);
    } else if (event.type === "item.updated") {
      const items = this.activeItems.get(event.turnId);
      const item = items?.get(event.itemId);
      if (
        item &&
        event.update.type === "text.append" &&
        (item.type === "agentMessage" || item.type === "reasoning")
      )
        items?.set(event.itemId, { ...item, text: item.text + event.update.text });
      else if (item?.type === "commandExecution" && event.update.type === "output.append")
        items?.set(event.itemId, { ...item, output: (item.output ?? "") + event.update.text });
    } else if (event.type === "item.completed") {
      this.activeItems.get(event.turnId)?.delete(event.snapshot.item.itemId);
    } else if (event.type === "turn.completed") {
      // Codex may omit Item completion notifications when a Turn is interrupted or fails.
      // Its terminal outcome settles those Items without inferring successful execution.
      if (event.outcome.status !== "succeeded") {
        for (const item of this.activeItems.get(event.turnId)?.values() ?? [])
          this.emit({
            type: "item.completed",
            turnId: event.turnId,
            snapshot: { item, outcome: event.outcome },
          });
      }
      this.activeItems.delete(event.turnId);
    }
    this.channel.emit({ kind: "event", event });
  }

  private hostTurn(codexTurnId: string | undefined): HostTurnId | undefined {
    if (codexTurnId === undefined) return undefined;
    const known = this.turns.get(codexTurnId);
    if (known !== undefined) return known;
    // A turn we started may announce itself before `turn/start` answers.
    const hostTurnId = this.pendingHostTurn ?? hostTurnIdSchema.parse(`codex-turn-${codexTurnId}`);
    const autonomous = this.pendingHostTurn === undefined;
    this.pendingHostTurn = undefined;
    this.turns.set(codexTurnId, hostTurnId);
    if (autonomous) this.emit({ type: "turn.autonomous.started", turnId: hostTurnId, input: [] });
    return hostTurnId;
  }

  private onNotification(method: string, params: Record<string, unknown>): void {
    if (typeof params.threadId === "string" && params.threadId !== this.threadId) return;
    this.usage.observe(method, params);
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
          itemId: hostItemIdSchema.parse(params.itemId),
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
            itemId: hostItemIdSchema.parse(params.itemId),
            update: { type: "text.append", text: "\n\n" },
          });
        return;
      }
      case "turn/completed": {
        const turn = params.turn as {
          id: string;
          status: string;
          error: { message?: string; codexErrorInfo?: unknown } | null;
        };
        const turnId = this.hostTurn(turn.id);
        if (this.activeCodexTurn === turn.id) this.activeCodexTurn = undefined;
        for (const [key, request] of this.requests) {
          if (request.turnId === turnId) {
            this.requests.delete(key);
            this.emit({
              type: "interaction.closed",
              interactionId: hostInteractionIdSchema.parse(key),
              turnId,
              reason: "cancelled",
            });
          }
        }
        if (turnId === undefined) return;
        const outcome: TurnOutcome =
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
          nativeTurnRef: nativeTurnRefSchema.parse({
            formatVersion: 1,
            harnessId: HARNESS_ID,
            nativeSessionId: this.threadId,
            nativeTurnKey: turn.id,
          }),
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
          interactionId: hostInteractionIdSchema.parse(key),
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
    const interactionId = hostInteractionIdSchema.parse(`codex-request-${String(rpcId)}`);
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
    interactionId: HostInteractionId,
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

  execute(command: TurnStartCommand): Promise<Result<TurnStartAccepted>>;
  execute(command: TurnSteerCommand): Promise<Result<TurnSteerAccepted>>;
  execute(command: TurnCancelCommand): Promise<Result<TurnCancelAccepted>>;
  execute(command: InteractionRespondCommand): Promise<Result<InteractionRespondAccepted>>;
  execute(command: ModelSelectCommand): Promise<Result<ModelSelectCompleted>>;
  execute(command: ThinkingSelectCommand): Promise<Result<ThinkingSelectCompleted>>;
  execute(command: PermissionModeSelectCommand): Promise<Result<PermissionModeSelectCompleted>>;
  async execute(
    command: HostCommand,
  ): Promise<
    Result<
      TurnStartAccepted | TurnCancelAccepted | InteractionRespondAccepted | ModelSelectCompleted
    >
  > {
    if (this.closed)
      return {
        ok: false,
        error: { code: "invalidState", message: "Codex CLI Session is closed", retryable: false },
      };
    try {
      switch (command.type) {
        case "turn.steer":
          return unsupportedSteer("Codex CLI");
        case "turn.start": {
          const hostTurnId = command.turnId;
          const input = (command.input as Array<{ type: string; text: string }>).map((part) => ({
            type: "text",
            text: part.text,
            text_elements: [],
          }));
          this.pendingHostTurn = hostTurnId;
          const response = await this.server.request<{ turn: { id: string } }>("turn/start", {
            threadId: this.threadId,
            input,
            ...(this.mode === undefined
              ? {}
              : {
                  approvalPolicy: this.mode.approvalPolicy,
                  sandboxPolicy: sandboxPolicy(this.mode),
                }),
            ...this.modelSelection.turnParameters(),
            ...(this.effort === undefined ? {} : { effort: this.effort }),
          });
          if (!this.turns.has(response.turn.id)) {
            this.turns.set(response.turn.id, hostTurnId);
            this.pendingHostTurn = undefined;
          }
          this.activeCodexTurn = response.turn.id;
          return { ok: true, value: { turnId: hostTurnId } };
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
          return this.respondInteraction(command.interactionId, command.response);
        case "model.select": {
          const settings = await this.modelSelection.select(
            this.threadId,
            command.model.id,
            this.effort,
          );
          if (settings.effort !== undefined) this.effort = settings.effort ?? undefined;
          this.emit({ type: "session.state.changed", state: this.state() });
          return { ok: true, value: { completed: true } };
        }
        case "thinking.select":
          this.effort = String(command.thinkingOptionId);
          this.emit({ type: "session.state.changed", state: this.state() });
          return { ok: true, value: { completed: true } };
        case "permissionMode.select": {
          const mode = permissionMode(String(command.permissionModeId));
          if (mode === undefined)
            return {
              ok: false,
              error: {
                code: "invalidRequest",
                message: "Unknown Permission Mode",
                retryable: false,
              },
            };
          this.mode = mode;
          this.effectivePermissionModeId = mode.id;
          this.emit({ type: "session.state.changed", state: this.state() });
          return { ok: true, value: { completed: true } };
        }
        default:
          return {
            ok: false,
            error: {
              code: "unsupported",
              message: "Unsupported command",
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
      if (error instanceof CodexSettingsUnconfirmedError) {
        this.emit({
          type: "session.faulted",
          error: { code: "protocolError", message, retryable: true },
        });
        await this.close();
      }
      return {
        ok: false,
        error: {
          code: "nativeFailure",
          message,
          retryable: false,
        },
      };
    }
  }

  async readSnapshot(): Promise<Result<HostThreadSnapshot>> {
    try {
      const response = await this.server.request<{
        thread: {
          id: string;
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
      if (response.thread.id !== this.threadId)
        throw new Error("Codex CLI returned history for a different native Session");
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
  readonly commands: HarnessCommandCapability = {
    list: async () => ({ ok: true, value: { commands: [...CODEX_COMMANDS], source: "static" } }),
    execute: async (command) => {
      try {
        this.pendingHostTurn = command.turnId;
        if (command.commandId === "compact") {
          await this.server.request("thread/compact/start", { threadId: this.threadId });
        } else if (command.commandId === "review") {
          const instructions =
            typeof command.arguments?.text === "string" ? command.arguments.text.trim() : undefined;
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
    this.usage.close();
    await this.server.close();
    this.activeCodexTurn = undefined;
    this.activeItems.clear();
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
): HostTurnSnapshot {
  const input = turn.items
    .filter((item) => item.type === "userMessage")
    .map((item) => ({ type: "text" as const, text: userText(item) }));
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
    nativeTurnRef: nativeTurnRefSchema.parse({
      formatVersion: 1,
      harnessId: HARNESS_ID,
      nativeSessionId: threadId,
      nativeTurnKey: turn.id,
    }),
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
