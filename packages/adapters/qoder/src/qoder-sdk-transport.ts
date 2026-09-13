import { randomUUID } from "node:crypto";
import type {
  HarnessOutput,
  HarnessResult,
  HarnessSession,
  HarnessSessionCapabilities,
  HarnessSessionState,
  HostApprovalAction,
  HostApprovalInteraction,
  HostCommand,
  HostEvent,
  HostQuestion,
  HostQuestionInteraction,
  HostThreadSnapshot,
  HostUsage,
  InteractionRespondAccepted,
  InteractionRespondCommand,
  ModelSelectCommand,
  ModelSelectCompleted,
  PermissionModeSelectCommand,
  PermissionModeSelectCompleted,
  ThinkingSelectCommand,
  ThinkingSelectCompleted,
  HarnessCommandAccepted,
  HarnessCommandCapability,
  HarnessCommandInvocation,
  TurnCancelAccepted,
  TurnCancelCommand,
  TurnStartAccepted,
  TurnStartCommand,
} from "@codexhost/harness-adapter";
import {
  HarnessOutputChannel,
  validateHostApprovalResponse,
  validateHostQuestionResponse,
} from "@codexhost/harness-adapter";
import {
  QODER_FALLBACK_COMMAND_CATALOG,
  mapQoderSlashCommands,
  parseQoderCommandInvocation,
} from "./qoder-slash-commands.js";
import {
  harnessIdSchema,
  hostInteractionIdSchema,
  hostItemIdSchema,
  hostTurnIdSchema,
  nativeCheckpointRefSchema,
  nativeSessionRefSchema,
  nativeTurnRefSchema,
  type HarnessCommandCatalog,
  type HarnessId,
  type HarnessModelCatalog,
  type HarnessModelRef,
  type HarnessPermissionModeId,
  type HarnessThinkingOptionId,
  type HostInteractionId,
  type HostItemId,
  type HostTurnId,
  type JsonValue,
  type NativeCheckpointRef,
  type NativeSessionRef,
  type NativeTurnRef,
} from "@codexhost/shared-contracts";

import {
  accessTokenFromEnv,
  getSessionMessages as defaultGetSessionMessages,
  qodercliAuth,
} from "@qoder-ai/qoder-agent-sdk";

import { mapQoderException, mapQoderResultError } from "./qoder-errors.js";
import { qoderEnvironment } from "./qoder-command.js";
import { mapQoderSnapshot } from "./qoder-history.js";
import {
  decodeQoderModelRef,
  QODER_DEFAULT_MODEL_REF,
  qoderAvailableThinkingOptions,
} from "./qoder-models.js";
import { mapToQoderPermissionMode } from "./qoder-permission-modes.js";
import type {
  CanUseToolContext,
  GetSessionMessagesOptions,
  PermissionResult,
  QoderContextUsage,
  QoderOptions,
  QoderQuery,
  QoderQueryFactory,
  QoderSlashCommand,
  SDKAssistantMessage,
  SDKCommandsChangedMessage,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKResultMessage,
  SDKSystemMessage,
  SDKUserMessage,
  SessionMessage,
} from "./qoder-sdk-types.js";
import { QoderUsageTracker } from "./qoder-usage.js";

export class PushableInput<T> implements AsyncIterable<T> {
  #queue: T[] = [];
  #waiters: Array<(result: IteratorResult<T>) => void> = [];
  #closed = false;

  push(value: T): void {
    if (this.#closed) throw new Error("Input queue is closed");
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter({ done: false, value });
    } else {
      this.#queue.push(value);
    }
  }

  end(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter({ done: true, value: undefined });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.#queue.shift();
        if (value !== undefined) return Promise.resolve({ done: false, value });
        if (this.#closed) return Promise.resolve({ done: true, value: undefined });
        return new Promise<IteratorResult<T>>((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

interface ActiveTurnState {
  turnId: HostTurnId;
  userMessageUuid: string;
  lastAssistantMessageUuid?: string | undefined;
  activeStreamingMessageItemId?: HostItemId | undefined;
  accumulatedStreamingText: string;
  activeStreamingReasoningItemId?: HostItemId | undefined;
  accumulatedStreamingReasoning: string;
}

interface ActiveTool {
  itemId: HostItemId;
  toolName: string;
  arguments: JsonValue;
  startedAtMs: number;
}

interface PendingInteraction {
  id: HostInteractionId;
  interaction: HostApprovalInteraction | HostQuestionInteraction;
  resolve: (result: PermissionResult) => void;
  questionPrompts?: string[];
  rawInput?: unknown;
  toolUseID?: string;
}

export interface QoderSessionOptions {
  sessionId: string;
  cwd: string;
  environment?: Record<string, string | undefined>;
  model?: HarnessModelRef;
  permissionModeId?: HarnessPermissionModeId;
  thinkingOptionId?: HarnessThinkingOptionId;
  catalog?: HarnessModelCatalog;
  resume?: string;
  queryFactory: QoderQueryFactory;
  getSessionMessages?: (
    sessionId: string,
    options?: GetSessionMessagesOptions,
  ) => Promise<SessionMessage[]>;
  pathToQoderCLIExecutable?: string;
  onClosed?: () => void;
}

export class QoderSession implements HarnessSession {
  readonly harnessId: HarnessId = harnessIdSchema.parse("qoder");
  readonly capabilities: HarnessSessionCapabilities;
  readonly commands: HarnessCommandCapability;
  readonly initialState: HarnessSessionState;
  readonly initialUsage: HostUsage | null = null;
  readonly outputs: AsyncIterable<HarnessOutput>;

  readonly #channel = new HarnessOutputChannel<HarnessOutput>();
  readonly #pushableInput = new PushableInput<SDKUserMessage>();
  readonly #usageTracker: QoderUsageTracker;
  readonly #pendingInteractions = new Map<string, PendingInteraction>();
  readonly #activeTools = new Map<string, ActiveTool>();
  readonly #query: QoderQuery;
  readonly #sessionId: string;
  readonly #cwd: string;
  readonly #catalog: HarnessModelCatalog | undefined;
  readonly #getSessionMessages: (
    sessionId: string,
    options?: GetSessionMessagesOptions,
  ) => Promise<SessionMessage[]>;
  readonly #onClosed: (() => void) | undefined;

  #commandCatalog: HarnessCommandCatalog = QODER_FALLBACK_COMMAND_CATALOG;
  #state: HarnessSessionState;
  #activeTurn: ActiveTurnState | null = null;
  #closed = false;
  #consumerLoopDone: Promise<void>;

  constructor(options: QoderSessionOptions) {
    this.outputs = this.#channel.outputs;
    this.commands = {
      list: async () => ({ ok: true, value: this.#commandCatalog }),
      execute: (command) => this.#executeHarnessCommand(command),
    };
    this.#sessionId = options.sessionId;
    this.#cwd = options.cwd;
    this.#catalog = options.catalog;
    this.#getSessionMessages = options.getSessionMessages ?? defaultGetSessionMessages;
    this.#onClosed = options.onClosed;

    const nativeRef: NativeSessionRef = nativeSessionRefSchema.parse({
      harnessId: "qoder",
      nativeSessionId: options.sessionId,
      formatVersion: 1,
    });

    const effectiveModel = options.model ?? QODER_DEFAULT_MODEL_REF;
    const availableThinkingOptions = qoderAvailableThinkingOptions(options.catalog, effectiveModel);
    let effectiveThinkingOptionId: HarnessThinkingOptionId | undefined;
    if (options.thinkingOptionId) {
      if (
        !availableThinkingOptions ||
        availableThinkingOptions.some((o) => o.id === options.thinkingOptionId)
      ) {
        effectiveThinkingOptionId = options.thinkingOptionId;
      }
    } else if (availableThinkingOptions && availableThinkingOptions.length > 0) {
      if (
        options.catalog?.defaultThinkingOptionId &&
        availableThinkingOptions.some((o) => o.id === options.catalog?.defaultThinkingOptionId)
      ) {
        effectiveThinkingOptionId = options.catalog.defaultThinkingOptionId;
      } else {
        effectiveThinkingOptionId =
          availableThinkingOptions.find((o) => o.id === "medium")?.id ??
          availableThinkingOptions[0]?.id;
      }
    }

    this.capabilities = {
      configuration: {
        selectModel: true,
        selectThinkingOption: options.catalog
          ? options.catalog.thinkingOptions.length > 0
          : Boolean(effectiveThinkingOptionId || options.thinkingOptionId),
        selectPermissionMode: true,
        permissionModeScope: "live",
      },
      history: {
        fork: true,
        forkAcrossCwd: false,
        rollbackLastTurn: true,
      },
    };

    this.#state = {
      nativeRef,
      effectiveModel,
      ...(options.permissionModeId ? { effectivePermissionModeId: options.permissionModeId } : {}),
      ...(effectiveThinkingOptionId ? { effectiveThinkingOptionId } : {}),
      ...(availableThinkingOptions && availableThinkingOptions.length > 0
        ? { availableThinkingOptions }
        : {}),
    };
    this.initialState = { ...this.#state };

    const nativeModel = options.model ? decodeQoderModelRef(options.model) : undefined;
    this.#usageTracker = new QoderUsageTracker(nativeModel ? { modelId: nativeModel } : undefined);
    const permissionMode = mapToQoderPermissionMode(options.permissionModeId);

    const environment = qoderEnvironment(options.environment);
    const auth = environment.QODER_PERSONAL_ACCESS_TOKEN ? accessTokenFromEnv() : qodercliAuth();

    const extraArgs: Record<string, string | null> = {};
    if (effectiveThinkingOptionId) {
      extraArgs["reasoning-effort"] = effectiveThinkingOptionId;
    }

    const qoderOptions: QoderOptions = {
      cwd: options.cwd,
      ...(options.resume ? {} : { sessionId: options.sessionId }),
      ...(options.pathToQoderCLIExecutable
        ? { pathToQoderCLIExecutable: options.pathToQoderCLIExecutable }
        : {}),
      env: environment,
      ...(nativeModel ? { model: nativeModel } : {}),
      ...(permissionMode ? { permissionMode } : {}),
      ...(permissionMode === "bypassPermissions" || permissionMode === "yolo"
        ? { allowDangerouslySkipPermissions: true }
        : {}),
      ...(Object.keys(extraArgs).length > 0 ? { extraArgs } : {}),
      ...(options.resume ? { resume: options.resume } : {}),
      auth,
      includePartialMessages: true,
      canUseTool: this.#handleCanUseTool.bind(this),
    };

    this.#query = options.queryFactory({
      prompt: this.#pushableInput,
      options: qoderOptions,
    });

    void this.#initSupportedCommands();
    this.#consumerLoopDone = this.#consumeMessages();
    void this.refreshUsage();
  }

  async #initSupportedCommands(): Promise<void> {
    if (typeof this.#query.supportedCommands === "function") {
      try {
        const commands = await this.#query.supportedCommands();
        if (Array.isArray(commands) && commands.length > 0 && !this.#closed) {
          this.#commandCatalog = mapQoderSlashCommands(commands);
        }
      } catch {
        // Keep fallback or existing catalog on error
      }
    }
  }

  #emitEvent(event: HostEvent): void {
    this.#channel.emit({ kind: "event", event });
  }

  #emitInteraction(interaction: HostApprovalInteraction | HostQuestionInteraction): void {
    this.#channel.emit({ kind: "interaction", interaction });
  }

  #createNativeTurnRef(nativeTurnKey: string): NativeTurnRef {
    return nativeTurnRefSchema.parse({
      harnessId: "qoder",
      nativeSessionId: this.#state.nativeRef?.nativeSessionId ?? this.#sessionId,
      nativeTurnKey,
      formatVersion: 1,
    });
  }

  async #consumeMessages(): Promise<void> {
    try {
      for await (const message of this.#query) {
        if (this.#closed) break;
        await this.#dispatchMessage(message);
      }
    } catch (error) {
      if (!this.#closed) {
        const harnessError = mapQoderException(error);
        if (this.#activeTurn) {
          const turnId = this.#activeTurn.turnId;
          const nativeTurnRef = this.#createNativeTurnRef(this.#activeTurn.userMessageUuid);
          this.#activeTurn = null;
          this.#emitEvent({
            type: "turn.completed",
            turnId,
            nativeTurnRef,
            outcome: { status: "failed", error: harnessError },
          });
        }
      }
    }
  }

  async #dispatchMessage(message: SDKMessage): Promise<void> {
    switch (message.type) {
      case "system":
        this.#handleSystemMessage(message as SDKSystemMessage);
        break;
      case "assistant":
        this.#handleAssistantMessage(message as SDKAssistantMessage);
        break;
      case "stream_event":
        this.#handleStreamEvent(message as SDKPartialAssistantMessage);
        break;
      case "user":
        this.#handleUserMessage(message as SDKUserMessage);
        break;
      case "result":
        this.#handleResultMessage(message as SDKResultMessage);
        break;
      default:
        // Diagnostic or progress events (model_queue_status, status, hook_*, task_*, files_persisted, mirror_error, etc.)
        // Never terminate the turn.
        break;
    }
  }

  #handleSystemMessage(message: SDKSystemMessage | SDKCommandsChangedMessage): void {
    const subtype = (message as { subtype?: string }).subtype;
    if (subtype === "init") {
      if (message.session_id) {
        this.#state = {
          ...this.#state,
          nativeRef: nativeSessionRefSchema.parse({
            harnessId: "qoder",
            nativeSessionId: message.session_id,
            formatVersion: 1,
          }),
        };
        this.#emitEvent({
          type: "session.state.changed",
          state: { ...this.#state },
        });
      }
      const rawCommands = (message as { commands?: unknown }).commands;
      if (Array.isArray(rawCommands)) {
        this.#commandCatalog = mapQoderSlashCommands(rawCommands as QoderSlashCommand[]);
      }
    } else if (subtype === "commands_changed") {
      const rawCommands = (message as { commands?: unknown }).commands;
      if (Array.isArray(rawCommands)) {
        this.#commandCatalog = mapQoderSlashCommands(rawCommands as QoderSlashCommand[]);
      }
    }
  }

  #handleStreamEvent(event: SDKPartialAssistantMessage): void {
    if (!this.#activeTurn) return;

    const rawEvent = (event as Record<string, unknown>).event as
      Record<string, unknown> | undefined;
    const rawDelta = (rawEvent?.delta ?? (event as Record<string, unknown>).delta) as
      Record<string, unknown> | undefined;

    let thinkingDelta: string | undefined;
    if (typeof rawDelta?.thinking === "string") {
      thinkingDelta = rawDelta.thinking;
    } else if (typeof (event as Record<string, unknown>).thinking_delta === "string") {
      thinkingDelta = (event as Record<string, unknown>).thinking_delta as string;
    } else if (rawDelta?.type === "thinking_delta" && typeof rawDelta.thinking === "string") {
      thinkingDelta = rawDelta.thinking as string;
    }

    if (thinkingDelta && thinkingDelta.length > 0) {
      let itemId = this.#activeTurn.activeStreamingReasoningItemId;
      if (!itemId) {
        itemId = hostItemIdSchema.parse(`reasoning-${randomUUID()}`);
        this.#activeTurn.activeStreamingReasoningItemId = itemId;
        this.#activeTurn.accumulatedStreamingReasoning = "";
        this.#emitEvent({
          type: "item.started",
          turnId: this.#activeTurn.turnId,
          item: {
            type: "reasoning",
            itemId,
            text: "",
          },
        });
      }

      this.#activeTurn.accumulatedStreamingReasoning += thinkingDelta;
      this.#emitEvent({
        type: "item.updated",
        turnId: this.#activeTurn.turnId,
        itemId,
        update: {
          type: "text.append",
          text: thinkingDelta,
        },
      });
      return;
    }

    let textDelta: string | undefined;
    if (typeof rawDelta?.text === "string") {
      textDelta = rawDelta.text;
    } else if (typeof (event as Record<string, unknown>).text_delta === "string") {
      textDelta = (event as Record<string, unknown>).text_delta as string;
    } else if (rawDelta?.type === "text_delta" && typeof rawDelta.text === "string") {
      textDelta = rawDelta.text as string;
    }

    if (textDelta && textDelta.length > 0) {
      let itemId = this.#activeTurn.activeStreamingMessageItemId;
      if (!itemId) {
        itemId = hostItemIdSchema.parse(`item-${randomUUID()}`);
        this.#activeTurn.activeStreamingMessageItemId = itemId;
        this.#activeTurn.accumulatedStreamingText = "";
        this.#emitEvent({
          type: "item.started",
          turnId: this.#activeTurn.turnId,
          item: {
            type: "agentMessage",
            itemId,
            text: "",
            phase: "commentary",
          },
        });
      }

      this.#activeTurn.accumulatedStreamingText += textDelta;
      this.#emitEvent({
        type: "item.updated",
        turnId: this.#activeTurn.turnId,
        itemId,
        update: {
          type: "text.append",
          text: textDelta,
        },
      });
    }
  }

  #handleAssistantMessage(message: SDKAssistantMessage): void {
    if (!this.#activeTurn) return;

    if (message.uuid) {
      this.#activeTurn.lastAssistantMessageUuid = message.uuid;
    }

    this.#usageTracker.observeAssistant(message);
    const usage = this.#usageTracker.snapshot();
    if (usage) {
      this.#emitEvent({
        type: "session.usage.changed",
        usage,
        observedForTurnId: this.#activeTurn.turnId,
      });
    }

    const content = message.message?.content;
    if (!Array.isArray(content)) return;

    const hasToolUseInMessage = content.some(
      (block) =>
        typeof block === "object" &&
        block !== null &&
        (block as Record<string, unknown>).type === "tool_use",
    );

    for (const block of content) {
      this.#projectAssistantBlock(block, hasToolUseInMessage);
    }
  }

  #projectAssistantBlock(block: unknown, hasToolUseInMessage = false): void {
    if (!this.#activeTurn || typeof block !== "object" || block === null) return;
    const turnId = this.#activeTurn.turnId;
    const rawBlock = block as Record<string, unknown>;

    if (rawBlock.type === "text" && typeof rawBlock.text === "string") {
      const activeStreamingId = this.#activeTurn.activeStreamingMessageItemId;
      const accumulated = this.#activeTurn.accumulatedStreamingText;
      const phase: "commentary" | "final_answer" = hasToolUseInMessage
        ? "commentary"
        : "final_answer";

      if (activeStreamingId && rawBlock.text.startsWith(accumulated)) {
        const remaining = rawBlock.text.slice(accumulated.length);
        if (remaining.length > 0) {
          this.#emitEvent({
            type: "item.updated",
            turnId,
            itemId: activeStreamingId,
            update: {
              type: "text.append",
              text: remaining,
            },
          });
        }
        this.#emitEvent({
          type: "item.completed",
          turnId,
          snapshot: {
            item: {
              type: "agentMessage",
              itemId: activeStreamingId,
              text: rawBlock.text,
              phase,
            },
            outcome: { status: "succeeded" },
          },
        });
        this.#activeTurn.activeStreamingMessageItemId = undefined;
        this.#activeTurn.accumulatedStreamingText = "";
      } else {
        const itemId = hostItemIdSchema.parse(`item-${randomUUID()}`);
        this.#emitEvent({
          type: "item.started",
          turnId,
          item: {
            type: "agentMessage",
            itemId,
            text: rawBlock.text,
            phase,
          },
        });
        this.#emitEvent({
          type: "item.completed",
          turnId,
          snapshot: {
            item: {
              type: "agentMessage",
              itemId,
              text: rawBlock.text,
              phase,
            },
            outcome: { status: "succeeded" },
          },
        });
      }
    } else if (rawBlock.type === "thinking" && typeof rawBlock.thinking === "string") {
      const activeStreamingId = this.#activeTurn.activeStreamingReasoningItemId;
      const accumulated = this.#activeTurn.accumulatedStreamingReasoning;

      if (activeStreamingId && rawBlock.thinking.startsWith(accumulated)) {
        const remaining = rawBlock.thinking.slice(accumulated.length);
        if (remaining.length > 0) {
          this.#emitEvent({
            type: "item.updated",
            turnId,
            itemId: activeStreamingId,
            update: {
              type: "text.append",
              text: remaining,
            },
          });
        }
        this.#emitEvent({
          type: "item.completed",
          turnId,
          snapshot: {
            item: {
              type: "reasoning",
              itemId: activeStreamingId,
              text: rawBlock.thinking,
            },
            outcome: { status: "succeeded" },
          },
        });
        this.#activeTurn.activeStreamingReasoningItemId = undefined;
        this.#activeTurn.accumulatedStreamingReasoning = "";
      } else {
        const itemId = hostItemIdSchema.parse(`reasoning-${randomUUID()}`);
        this.#emitEvent({
          type: "item.started",
          turnId,
          item: {
            type: "reasoning",
            itemId,
            text: rawBlock.thinking,
          },
        });
        this.#emitEvent({
          type: "item.completed",
          turnId,
          snapshot: {
            item: {
              type: "reasoning",
              itemId,
              text: rawBlock.thinking,
            },
            outcome: { status: "succeeded" },
          },
        });
      }
    } else if (rawBlock.type === "tool_use") {
      if (this.#activeTurn.activeStreamingMessageItemId) {
        this.#emitEvent({
          type: "item.completed",
          turnId,
          snapshot: {
            item: {
              type: "agentMessage",
              itemId: this.#activeTurn.activeStreamingMessageItemId,
              text: this.#activeTurn.accumulatedStreamingText,
              phase: "commentary",
            },
            outcome: { status: "succeeded" },
          },
        });
        this.#activeTurn.activeStreamingMessageItemId = undefined;
        this.#activeTurn.accumulatedStreamingText = "";
      }

      const toolId = typeof rawBlock.id === "string" ? rawBlock.id : `tool-${randomUUID()}`;
      const itemId = hostItemIdSchema.parse(toolId);
      const toolName = typeof rawBlock.name === "string" ? rawBlock.name : "unknown";
      const toolArgs = (rawBlock.input as JsonValue) ?? {};

      this.#activeTools.set(toolId, {
        itemId,
        toolName,
        arguments: toolArgs,
        startedAtMs: Date.now(),
      });

      this.#emitEvent({
        type: "item.started",
        turnId,
        item: {
          type: "toolExecution",
          itemId,
          toolName,
          arguments: toolArgs,
        },
      });
    }
  }

  #handleUserMessage(message: SDKUserMessage): void {
    const content = message.message?.content;
    if (!Array.isArray(content)) return;

    for (const block of content) {
      if (
        typeof block === "object" &&
        block !== null &&
        (block as Record<string, unknown>).type === "tool_result"
      ) {
        const toolResult = block as {
          type: "tool_result";
          tool_use_id: string;
          content: string | unknown[];
          is_error?: boolean;
        };

        const activeTool = this.#activeTools.get(toolResult.tool_use_id);
        if (activeTool) {
          const isError = toolResult.is_error === true;
          const outputText =
            typeof toolResult.content === "string"
              ? toolResult.content
              : JSON.stringify(toolResult.content);

          const durationMs = Math.max(0, Date.now() - activeTool.startedAtMs);
          this.#emitEvent({
            type: "item.completed",
            turnId: this.#activeTurn?.turnId ?? hostTurnIdSchema.parse("turn-fallback"),
            snapshot: {
              item: {
                type: "toolExecution",
                itemId: activeTool.itemId,
                toolName: activeTool.toolName,
                arguments: activeTool.arguments,
                output: {
                  content: [{ type: "text", text: outputText }],
                },
                durationMs,
              },
              outcome: isError
                ? {
                    status: "failed",
                    error: {
                      code: "nativeFailure",
                      message: outputText || `Tool '${activeTool.toolName}' failed`,
                      retryable: false,
                    },
                  }
                : { status: "succeeded" },
            },
          });
          this.#activeTools.delete(toolResult.tool_use_id);
        }
      }
    }
  }

  #handleResultMessage(result: SDKResultMessage): void {
    if (!this.#activeTurn) return;

    const turnId = this.#activeTurn.turnId;
    this.#usageTracker.observeResult(result);
    const usage = this.#usageTracker.snapshot();
    if (usage) {
      this.#emitEvent({
        type: "session.usage.changed",
        usage,
        observedForTurnId: turnId,
      });
    }
    void this.refreshUsage(turnId);

    // Complete any open tools
    for (const activeTool of this.#activeTools.values()) {
      this.#emitEvent({
        type: "item.completed",
        turnId: this.#activeTurn.turnId,
        snapshot: {
          item: {
            type: "toolExecution",
            itemId: activeTool.itemId,
            toolName: activeTool.toolName,
            arguments: activeTool.arguments,
            durationMs: Math.max(0, Date.now() - activeTool.startedAtMs),
          },
          outcome:
            result.subtype === "success"
              ? { status: "succeeded" }
              : {
                  status: "failed",
                  error: {
                    code: "nativeFailure",
                    message: "Tool incomplete on result",
                    retryable: false,
                  },
                },
        },
      });
    }
    this.#activeTools.clear();

    // Close any active streaming text message item
    if (this.#activeTurn.activeStreamingMessageItemId) {
      this.#emitEvent({
        type: "item.completed",
        turnId: this.#activeTurn.turnId,
        snapshot: {
          item: {
            type: "agentMessage",
            itemId: this.#activeTurn.activeStreamingMessageItemId,
            text: this.#activeTurn.accumulatedStreamingText,
            phase: result.subtype === "success" ? "final_answer" : "commentary",
          },
          outcome: { status: "succeeded" },
        },
      });
      this.#activeTurn.activeStreamingMessageItemId = undefined;
      this.#activeTurn.accumulatedStreamingText = "";
    }

    // Close any active streaming reasoning item
    if (this.#activeTurn.activeStreamingReasoningItemId) {
      this.#emitEvent({
        type: "item.completed",
        turnId: this.#activeTurn.turnId,
        snapshot: {
          item: {
            type: "reasoning",
            itemId: this.#activeTurn.activeStreamingReasoningItemId,
            text: this.#activeTurn.accumulatedStreamingReasoning,
          },
          outcome: { status: "succeeded" },
        },
      });
      this.#activeTurn.activeStreamingReasoningItemId = undefined;
      this.#activeTurn.accumulatedStreamingReasoning = "";
    }

    const userMessageUuid = this.#activeTurn.userMessageUuid;
    const lastAssistantMessageUuid = this.#activeTurn.lastAssistantMessageUuid;
    this.#activeTurn = null;

    const nativeTurnRef = this.#createNativeTurnRef(result.uuid || userMessageUuid);
    const checkpoint: NativeCheckpointRef | undefined = lastAssistantMessageUuid
      ? nativeCheckpointRefSchema.parse({
          harnessId: "qoder",
          nativeSessionId: this.#state.nativeRef?.nativeSessionId ?? this.#sessionId,
          checkpointId: lastAssistantMessageUuid,
          formatVersion: 1,
        })
      : undefined;

    if (result.subtype === "success") {
      this.#emitEvent({
        type: "turn.completed",
        turnId,
        nativeTurnRef,
        outcome: checkpoint ? { status: "succeeded", checkpoint } : { status: "succeeded" },
      });
    } else {
      const error = mapQoderResultError(result);
      this.#emitEvent({
        type: "turn.completed",
        turnId,
        nativeTurnRef,
        outcome: checkpoint ? { status: "failed", error, checkpoint } : { status: "failed", error },
      });
    }
  }

  async #handleCanUseTool(
    toolName: string,
    input: unknown,
    context: CanUseToolContext,
  ): Promise<PermissionResult> {
    if (this.#closed || !this.#activeTurn) {
      return { behavior: "deny", message: "Session is not active", interrupt: true };
    }

    const interactionId = hostInteractionIdSchema.parse(randomUUID());
    const turnId = this.#activeTurn.turnId;

    if (toolName === "AskUserQuestion") {
      return this.#bridgeAskUserQuestion(interactionId, turnId, input, context);
    }

    return this.#bridgeToolApproval(interactionId, turnId, toolName, input, context);
  }

  async #bridgeAskUserQuestion(
    interactionId: HostInteractionId,
    turnId: HostTurnId,
    input: unknown,
    context: CanUseToolContext,
  ): Promise<PermissionResult> {
    const raw = input as Record<string, unknown> | undefined;
    const rawQuestions = Array.isArray(raw?.questions) ? raw.questions : [];

    const questionPrompts: string[] = [];
    const questions: HostQuestion[] = rawQuestions.map((qItem, idx) => {
      const qObj = (typeof qItem === "object" && qItem !== null ? qItem : {}) as Record<
        string,
        unknown
      >;
      const promptText = typeof qObj.question === "string" ? qObj.question : `Question ${idx + 1}`;
      questionPrompts.push(promptText);

      const options = Array.isArray(qObj.options)
        ? qObj.options.map((opt) => {
            if (typeof opt === "string") return { value: opt, label: opt };
            const optObj = (opt ?? {}) as Record<string, unknown>;
            const val = String(optObj.label ?? optObj.value ?? "");
            const desc = typeof optObj.description === "string" ? optObj.description : undefined;
            return {
              value: val,
              label: val,
              ...(desc ? { description: desc } : {}),
            };
          })
        : [];

      if (options.length > 0) {
        return {
          id: promptText,
          type: "choice" as const,
          prompt: promptText,
          options,
          multiple: Boolean(qObj.multiSelect),
          allowOther: false,
          optional: false,
        };
      }

      return {
        id: promptText,
        type: "text" as const,
        prompt: promptText,
        multiline: false,
        secret: false,
        optional: false,
      };
    });

    const interaction: HostQuestionInteraction = {
      type: "question",
      interactionId,
      turnId,
      title: "Question from Qoder",
      questions,
    };

    return new Promise<PermissionResult>((resolve) => {
      const cleanup = () => {
        this.#pendingInteractions.delete(interactionId);
        context.signal.removeEventListener("abort", onAbort);
      };

      const onAbort = () => {
        cleanup();
        this.#emitEvent({
          type: "interaction.closed",
          interactionId,
          turnId,
          reason: "cancelled",
        });
        resolve({
          behavior: "deny",
          message: "Question interaction aborted",
          ...(context.toolUseID ? { toolUseID: context.toolUseID } : {}),
        });
      };

      context.signal.addEventListener("abort", onAbort, { once: true });

      this.#pendingInteractions.set(interactionId, {
        id: interactionId,
        interaction,
        questionPrompts,
        rawInput: input,
        toolUseID: context.toolUseID,
        resolve: (result) => {
          cleanup();
          resolve(result);
        },
      });

      this.#emitInteraction(interaction);
    });
  }

  async #bridgeToolApproval(
    interactionId: HostInteractionId,
    turnId: HostTurnId,
    toolName: string,
    input: unknown,
    context: CanUseToolContext,
  ): Promise<PermissionResult> {
    const actions: HostApprovalAction[] = [
      { id: "allowOnce", label: "Allow", effect: "allowOnce" },
      { id: "deny", label: "Deny", effect: "deny" },
    ];

    const interaction: HostApprovalInteraction = {
      type: "approval",
      interactionId,
      turnId,
      title: `Approve tool: ${toolName}`,
      description:
        typeof input === "object" && input !== null ? JSON.stringify(input) : String(input),
      subject: { type: "nativeAction" },
      actions,
    };

    return new Promise<PermissionResult>((resolve) => {
      const cleanup = () => {
        this.#pendingInteractions.delete(interactionId);
        context.signal.removeEventListener("abort", onAbort);
      };

      const onAbort = () => {
        cleanup();
        this.#emitEvent({
          type: "interaction.closed",
          interactionId,
          turnId,
          reason: "cancelled",
        });
        resolve({
          behavior: "deny",
          message: "Approval aborted",
          ...(context.toolUseID ? { toolUseID: context.toolUseID } : {}),
        });
      };

      context.signal.addEventListener("abort", onAbort, { once: true });

      this.#pendingInteractions.set(interactionId, {
        id: interactionId,
        interaction,
        rawInput: input,
        toolUseID: context.toolUseID,
        resolve: (result) => {
          cleanup();
          resolve(result);
        },
      });

      this.#emitInteraction(interaction);
    });
  }

  async readSnapshot(): Promise<HarnessResult<HostThreadSnapshot>> {
    if (this.#activeTurn) {
      return {
        ok: false,
        error: {
          code: "sessionBusy",
          message: "Qoder session cannot read history during an active turn",
          retryable: true,
        },
      };
    }
    try {
      const messages = await this.#getSessionMessages(this.#sessionId, {
        dir: this.#cwd,
        view: "historical",
      });
      const snapshot = mapQoderSnapshot(messages, this.#sessionId);
      return { ok: true, value: snapshot };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isNotFound =
        message.toLowerCase().includes("not found") ||
        message.toLowerCase().includes("cannot find") ||
        message.toLowerCase().includes("no such file") ||
        message.toLowerCase().includes("enoent");
      if (isNotFound) {
        return { ok: true, value: { turns: [] } };
      }
      return {
        ok: false,
        error: {
          code: "nativeFailure",
          message: error instanceof Error ? error.message : "Failed to read Qoder session history",
          retryable: false,
        },
      };
    }
  }

  async refreshUsage(forTurnId?: HostTurnId): Promise<void> {
    let changed = false;
    if (this.#query.getContextUsage) {
      try {
        const usage = await this.#query.getContextUsage();
        if (usage) {
          this.#usageTracker.observeContextUsage(usage as QoderContextUsage);
          changed = true;
        }
      } catch {
        // Diagnostic failure only, never fails turn
      }
    }
    if (this.#query.getUsageInfo) {
      try {
        const info = await this.#query.getUsageInfo();
        if (info) {
          this.#usageTracker.observeUsageInfo(info);
          changed = true;
        }
      } catch {
        // Diagnostic failure only, never fails turn
      }
    }
    if (changed) {
      const snapshot = this.#usageTracker.snapshot();
      if (snapshot) {
        const targetTurnId = forTurnId ?? this.#activeTurn?.turnId;
        this.#emitEvent({
          type: "session.usage.changed",
          usage: snapshot,
          ...(targetTurnId ? { observedForTurnId: targetTurnId } : {}),
        });
      }
    }
  }

  async execute(command: TurnStartCommand): Promise<HarnessResult<TurnStartAccepted>>;
  async execute(command: TurnCancelCommand): Promise<HarnessResult<TurnCancelAccepted>>;
  async execute(
    command: InteractionRespondCommand,
  ): Promise<HarnessResult<InteractionRespondAccepted>>;
  async execute(command: ModelSelectCommand): Promise<HarnessResult<ModelSelectCompleted>>;
  async execute(command: ThinkingSelectCommand): Promise<HarnessResult<ThinkingSelectCompleted>>;
  async execute(
    command: PermissionModeSelectCommand,
  ): Promise<HarnessResult<PermissionModeSelectCompleted>>;
  async execute(command: HostCommand): Promise<HarnessResult<unknown>> {
    if (this.#closed) {
      return {
        ok: false,
        error: { code: "invalidState", message: "Session is closed", retryable: false },
      };
    }

    switch (command.type) {
      case "turn.start": {
        if (this.#activeTurn) {
          return {
            ok: false,
            error: {
              code: "sessionBusy",
              message: "Another turn is currently running",
              retryable: true,
            },
          };
        }

        const userMessageUuid = `qoder-msg-${randomUUID()}`;
        this.#activeTurn = {
          turnId: command.turnId,
          userMessageUuid,
          accumulatedStreamingText: "",
          accumulatedStreamingReasoning: "",
        };

        this.#emitEvent({
          type: "turn.started",
          turnId: command.turnId,
        });

        const textContent = command.input.map((item) => item.text).join("\n");
        const sdkMessage: SDKUserMessage = {
          type: "user",
          uuid: userMessageUuid,
          ...(this.#state.nativeRef?.nativeSessionId
            ? { session_id: this.#state.nativeRef.nativeSessionId }
            : {}),
          parent_tool_use_id: null,
          message: {
            role: "user",
            content: [{ type: "text", text: textContent }],
          },
        };

        this.#pushableInput.push(sdkMessage);
        return { ok: true, value: { turnId: command.turnId } };
      }

      case "turn.cancel": {
        if (!this.#activeTurn || this.#activeTurn.turnId !== command.turnId) {
          return { ok: true, value: { cancellationRequested: true } };
        }

        this.#cancelPendingInteractions(command.turnId, "Turn cancelled by user");

        for (const activeTool of this.#activeTools.values()) {
          this.#emitEvent({
            type: "item.completed",
            turnId: command.turnId,
            snapshot: {
              item: {
                type: "toolExecution",
                itemId: activeTool.itemId,
                toolName: activeTool.toolName,
                arguments: activeTool.arguments,
                durationMs: Math.max(0, Date.now() - activeTool.startedAtMs),
              },
              outcome: {
                status: "failed",
                error: {
                  code: "nativeFailure",
                  message: "Tool cancelled by user",
                  retryable: false,
                },
              },
            },
          });
        }
        this.#activeTools.clear();

        // Close any active streaming text message item
        if (this.#activeTurn.activeStreamingMessageItemId) {
          this.#emitEvent({
            type: "item.completed",
            turnId: this.#activeTurn.turnId,
            snapshot: {
              item: {
                type: "agentMessage",
                itemId: this.#activeTurn.activeStreamingMessageItemId,
                text: this.#activeTurn.accumulatedStreamingText,
              },
              outcome: { status: "cancelled", reason: "Turn cancelled by user" },
            },
          });
          this.#activeTurn.activeStreamingMessageItemId = undefined;
          this.#activeTurn.accumulatedStreamingText = "";
        }

        // Close any active streaming reasoning item
        if (this.#activeTurn.activeStreamingReasoningItemId) {
          this.#emitEvent({
            type: "item.completed",
            turnId: this.#activeTurn.turnId,
            snapshot: {
              item: {
                type: "reasoning",
                itemId: this.#activeTurn.activeStreamingReasoningItemId,
                text: this.#activeTurn.accumulatedStreamingReasoning,
              },
              outcome: { status: "cancelled", reason: "Turn cancelled by user" },
            },
          });
          this.#activeTurn.activeStreamingReasoningItemId = undefined;
          this.#activeTurn.accumulatedStreamingReasoning = "";
        }

        try {
          await this.#query.interrupt();
        } catch {
          // Interrupt call may fail if query has already completed
        }

        if (this.#activeTurn) {
          const turnId = this.#activeTurn.turnId;
          const nativeTurnRef = this.#createNativeTurnRef(this.#activeTurn.userMessageUuid);
          this.#activeTurn = null;
          this.#emitEvent({
            type: "turn.completed",
            turnId,
            nativeTurnRef,
            outcome: { status: "cancelled", reason: "User cancelled turn" },
          });
        }

        return { ok: true, value: { cancellationRequested: true } };
      }

      case "interaction.respond": {
        const pending = this.#pendingInteractions.get(command.interactionId);
        if (!pending) {
          return {
            ok: false,
            error: {
              code: "invalidRequest",
              message: `No pending interaction with ID '${command.interactionId}'`,
              retryable: false,
            },
          };
        }

        if (pending.interaction.type === "approval") {
          if (command.response.type !== "approval") {
            return {
              ok: false,
              error: {
                code: "invalidRequest",
                message: "Expected approval response for approval interaction",
                retryable: false,
              },
            };
          }

          const validationError = validateHostApprovalResponse(
            pending.interaction,
            command.response,
          );
          if (validationError) {
            return { ok: false, error: validationError };
          }

          this.#emitEvent({
            type: "interaction.closed",
            interactionId: command.interactionId,
            turnId: pending.interaction.turnId,
            reason: "responded",
          });

          if (command.response.actionId === "allowOnce") {
            const rawInputObj =
              typeof pending.rawInput === "object" && pending.rawInput !== null
                ? (pending.rawInput as Record<string, unknown>)
                : {};
            pending.resolve({
              behavior: "allow",
              updatedInput: rawInputObj,
              ...(pending.toolUseID !== undefined ? { toolUseID: pending.toolUseID } : {}),
            });
          } else {
            pending.resolve({
              behavior: "deny",
              message: "User denied permission",
              ...(pending.toolUseID !== undefined ? { toolUseID: pending.toolUseID } : {}),
            });
          }

          return { ok: true, value: { accepted: true } };
        }

        if (pending.interaction.type === "question") {
          if (command.response.type !== "question") {
            return {
              ok: false,
              error: {
                code: "invalidRequest",
                message: "Expected question response for question interaction",
                retryable: false,
              },
            };
          }

          const validationError = validateHostQuestionResponse(
            pending.interaction,
            command.response,
          );
          if (validationError) {
            return { ok: false, error: validationError };
          }

          this.#emitEvent({
            type: "interaction.closed",
            interactionId: command.interactionId,
            turnId: pending.interaction.turnId,
            reason: "responded",
          });

          if (command.response.cancelled) {
            pending.resolve({
              behavior: "deny",
              message: "User cancelled question",
              ...(pending.toolUseID !== undefined ? { toolUseID: pending.toolUseID } : {}),
            });
          } else {
            // Qoder requires answers keyed by full question prompt text!
            const answers: Record<string, string> = {};
            for (const prompt of pending.questionPrompts ?? []) {
              const answerList = command.response.answers[prompt];
              if (Array.isArray(answerList) && answerList.length > 0) {
                answers[prompt] = answerList.join(", ");
              }
            }

            const rawInputObj =
              typeof pending.rawInput === "object" && pending.rawInput !== null
                ? (pending.rawInput as Record<string, unknown>)
                : {};

            pending.resolve({
              behavior: "allow",
              updatedInput: {
                ...rawInputObj,
                answers,
              },
              ...(pending.toolUseID !== undefined ? { toolUseID: pending.toolUseID } : {}),
            });
          }

          return { ok: true, value: { accepted: true } };
        }

        return {
          ok: false,
          error: {
            code: "invalidRequest",
            message: "Unsupported interaction type",
            retryable: false,
          },
        };
      }

      case "model.select": {
        if (this.#activeTurn) {
          return {
            ok: false,
            error: {
              code: "sessionBusy",
              message: "Cannot switch model during active turn",
              retryable: true,
            },
          };
        }

        const nativeModel = decodeQoderModelRef(command.model);
        if (!nativeModel) {
          return {
            ok: false,
            error: {
              code: "invalidRequest",
              message: "Invalid Qoder model ref",
              retryable: false,
            },
          };
        }

        const availableThinkingOptions = this.#catalog
          ? qoderAvailableThinkingOptions(this.#catalog, command.model)
          : this.#state.availableThinkingOptions;

        let effectiveThinkingOptionId = this.#state.effectiveThinkingOptionId;
        if (availableThinkingOptions && availableThinkingOptions.length > 0) {
          if (
            !effectiveThinkingOptionId ||
            !availableThinkingOptions.some((o) => o.id === effectiveThinkingOptionId)
          ) {
            effectiveThinkingOptionId =
              availableThinkingOptions.find((o) => o.id === "medium")?.id ??
              availableThinkingOptions[0]?.id;
          }
        } else {
          effectiveThinkingOptionId = undefined;
        }

        if (typeof this.#query.request === "function") {
          try {
            await this.#query.request({
              type: "set_model",
              model: nativeModel,
              ...(effectiveThinkingOptionId ? { reasoningEffort: effectiveThinkingOptionId } : {}),
            });
          } catch (err) {
            return {
              ok: false,
              error: mapQoderException(err),
            };
          }
        } else if (this.#query.setModel) {
          try {
            await this.#query.setModel(nativeModel);
          } catch (err) {
            return {
              ok: false,
              error: mapQoderException(err),
            };
          }
        }

        const nextState: HarnessSessionState = {
          ...this.#state,
          effectiveModel: command.model,
        };
        if (effectiveThinkingOptionId) {
          nextState.effectiveThinkingOptionId = effectiveThinkingOptionId;
        } else {
          delete nextState.effectiveThinkingOptionId;
        }
        if (availableThinkingOptions && availableThinkingOptions.length > 0) {
          nextState.availableThinkingOptions = availableThinkingOptions;
        } else {
          delete nextState.availableThinkingOptions;
        }
        this.#state = nextState;
        this.#usageTracker.setModel(nativeModel);
        void this.refreshUsage();
        this.#emitEvent({
          type: "session.state.changed",
          state: { ...this.#state },
        });

        return { ok: true, value: { completed: true } };
      }

      case "thinking.select": {
        if (this.#activeTurn) {
          return {
            ok: false,
            error: {
              code: "sessionBusy",
              message: "Cannot switch thinking option during active turn",
              retryable: true,
            },
          };
        }

        const thinkingOptionId = command.thinkingOptionId;
        if (this.#catalog) {
          const available = qoderAvailableThinkingOptions(
            this.#catalog,
            this.#state.effectiveModel,
          );
          if (available && !available.some((o) => o.id === thinkingOptionId)) {
            return {
              ok: false,
              error: {
                code: "invalidRequest",
                message: `Thinking option '${thinkingOptionId}' is not supported by current model`,
                retryable: false,
              },
            };
          }
        }

        const nativeModel = this.#state.effectiveModel
          ? decodeQoderModelRef(this.#state.effectiveModel)
          : undefined;

        if (typeof this.#query.request === "function") {
          try {
            await this.#query.request({
              type: "set_model",
              ...(nativeModel ? { model: nativeModel } : {}),
              reasoningEffort: thinkingOptionId,
            });
          } catch (err) {
            return {
              ok: false,
              error: mapQoderException(err),
            };
          }
        }

        this.#state = {
          ...this.#state,
          effectiveThinkingOptionId: thinkingOptionId,
        };
        this.#emitEvent({
          type: "session.state.changed",
          state: { ...this.#state },
        });

        return { ok: true, value: { completed: true } };
      }

      case "permissionMode.select": {
        if (this.#activeTurn) {
          return {
            ok: false,
            error: {
              code: "sessionBusy",
              message: "Cannot switch permission mode during active turn",
              retryable: true,
            },
          };
        }

        const mode = mapToQoderPermissionMode(command.permissionModeId);
        if (!mode) {
          return {
            ok: false,
            error: {
              code: "invalidRequest",
              message: `Unknown permission mode '${command.permissionModeId}'`,
              retryable: false,
            },
          };
        }

        if (this.#query.setPermissionMode) {
          try {
            await this.#query.setPermissionMode(mode);
          } catch (err) {
            return {
              ok: false,
              error: mapQoderException(err),
            };
          }
        }

        this.#state = {
          ...this.#state,
          effectivePermissionModeId: command.permissionModeId,
        };
        this.#emitEvent({
          type: "session.state.changed",
          state: { ...this.#state },
        });

        return { ok: true, value: { completed: true } };
      }

      default:
        return {
          ok: false,
          error: {
            code: "unsupported",
            message: "Command not supported",
            retryable: false,
          },
        };
    }
  }

  async #executeHarnessCommand(
    command: HarnessCommandInvocation,
  ): Promise<HarnessResult<HarnessCommandAccepted>> {
    if (this.#closed) {
      return {
        ok: false,
        error: {
          code: "invalidState",
          message: "Qoder Session is closed",
          retryable: false,
        },
      };
    }
    if (this.#activeTurn) {
      return {
        ok: false,
        error: {
          code: "sessionBusy",
          message: "Another turn is currently running",
          retryable: true,
        },
      };
    }

    const parsed = parseQoderCommandInvocation(command, this.#commandCatalog);
    if (!parsed.ok) {
      return parsed;
    }

    const userMessageUuid = `qoder-msg-${randomUUID()}`;
    this.#activeTurn = {
      turnId: command.turnId,
      userMessageUuid,
      accumulatedStreamingText: "",
      accumulatedStreamingReasoning: "",
    };

    this.#emitEvent({
      type: "turn.started",
      turnId: command.turnId,
    });

    const sdkMessage: SDKUserMessage = {
      type: "user",
      uuid: userMessageUuid,
      ...(this.#state.nativeRef?.nativeSessionId
        ? { session_id: this.#state.nativeRef.nativeSessionId }
        : {}),
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [{ type: "text", text: parsed.value.prompt }],
      },
    };

    this.#pushableInput.push(sdkMessage);
    return { ok: true, value: { turnId: command.turnId } };
  }

  #cancelPendingInteractions(turnId: HostTurnId, reason: string): void {
    for (const [id, pending] of this.#pendingInteractions) {
      this.#emitEvent({
        type: "interaction.closed",
        interactionId: pending.id,
        turnId,
        reason: "cancelled",
      });
      pending.resolve({ behavior: "deny", message: reason });
      this.#pendingInteractions.delete(id);
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;

    if (this.#activeTurn) {
      this.#cancelPendingInteractions(this.#activeTurn.turnId, "Session closed");
      for (const activeTool of this.#activeTools.values()) {
        this.#emitEvent({
          type: "item.completed",
          turnId: this.#activeTurn.turnId,
          snapshot: {
            item: {
              type: "toolExecution",
              itemId: activeTool.itemId,
              toolName: activeTool.toolName,
              arguments: activeTool.arguments,
              durationMs: Math.max(0, Date.now() - activeTool.startedAtMs),
            },
            outcome: {
              status: "failed",
              error: { code: "nativeFailure", message: "Session closed", retryable: false },
            },
          },
        });
      }
      this.#activeTools.clear();

      // Close any active streaming text message item
      if (this.#activeTurn.activeStreamingMessageItemId) {
        this.#emitEvent({
          type: "item.completed",
          turnId: this.#activeTurn.turnId,
          snapshot: {
            item: {
              type: "agentMessage",
              itemId: this.#activeTurn.activeStreamingMessageItemId,
              text: this.#activeTurn.accumulatedStreamingText,
            },
            outcome: { status: "cancelled", reason: "Session closed" },
          },
        });
        this.#activeTurn.activeStreamingMessageItemId = undefined;
        this.#activeTurn.accumulatedStreamingText = "";
      }

      // Close any active streaming reasoning item
      if (this.#activeTurn.activeStreamingReasoningItemId) {
        this.#emitEvent({
          type: "item.completed",
          turnId: this.#activeTurn.turnId,
          snapshot: {
            item: {
              type: "reasoning",
              itemId: this.#activeTurn.activeStreamingReasoningItemId,
              text: this.#activeTurn.accumulatedStreamingReasoning,
            },
            outcome: { status: "cancelled", reason: "Session closed" },
          },
        });
        this.#activeTurn.activeStreamingReasoningItemId = undefined;
        this.#activeTurn.accumulatedStreamingReasoning = "";
      }

      const turnId = this.#activeTurn.turnId;
      const nativeTurnRef = this.#createNativeTurnRef(this.#activeTurn.userMessageUuid);
      this.#activeTurn = null;
      this.#emitEvent({
        type: "turn.completed",
        turnId,
        nativeTurnRef,
        outcome: { status: "cancelled", reason: "Session closed" },
      });
    } else {
      for (const [id, pending] of this.#pendingInteractions) {
        this.#emitEvent({
          type: "interaction.closed",
          interactionId: pending.id,
          turnId: pending.interaction.turnId,
          reason: "cancelled",
        });
        pending.resolve({ behavior: "deny", message: "Session closed" });
        this.#pendingInteractions.delete(id);
      }
    }

    this.#pushableInput.end();

    try {
      await this.#query.close();
    } catch {
      // Ignored during shutdown
    }

    this.#channel.end();
    this.#onClosed?.();
  }
}
