import { randomUUID } from "node:crypto";
import type {
  HarnessError,
  HarnessOutput,
  HarnessResult,
  HarnessSession,
  HarnessSessionCapabilities,
  HarnessSessionState,
  HostApprovalAction,
  HostApprovalInteraction,
  HostApprovalResponse,
  HostCommand,
  HostEvent,
  HostItem,
  HostItemOutcome,
  HostItemSnapshot,
  HostQuestion,
  HostQuestionInteraction,
  HostQuestionResponse,
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
  harnessIdSchema,
  hostInteractionIdSchema,
  hostItemIdSchema,
  hostTurnIdSchema,
  nativeSessionRefSchema,
  type HarnessId,
  type HarnessModelRef,
  type HarnessPermissionModeId,
  type HostInteractionId,
  type HostItemId,
  type HostTurnId,
  type JsonValue,
  type NativeSessionRef,
} from "@codexhost/shared-contracts";

import { mapQoderException, mapQoderResultError } from "./qoder-errors.js";
import { decodeQoderModelRef, encodeQoderModelRef, QODER_DEFAULT_MODEL_REF } from "./qoder-models.js";
import type {
  CanUseTool,
  CanUseToolContext,
  PermissionResult,
  QoderOptions,
  QoderQuery,
  QoderQueryFactory,
  SDKAssistantContent,
  SDKAssistantMessage,
  SDKMessage,
  SDKResultMessage,
  SDKStreamEvent,
  SDKSystemMessage,
  SDKUserMessage,
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
  activeStreamingItemId?: HostItemId | undefined;
  accumulatedStreamingText: string;
}

interface PendingInteraction {
  id: HostInteractionId;
  interaction: HostApprovalInteraction | HostQuestionInteraction;
  resolve: (result: PermissionResult) => void;
  questionPrompts?: string[];
}

export interface QoderSessionOptions {
  sessionId: string;
  cwd: string;
  environment?: Record<string, string | undefined>;
  model?: HarnessModelRef;
  permissionModeId?: HarnessPermissionModeId;
  queryFactory: QoderQueryFactory;
  pathToQoderCLIExecutable?: string;
  onClosed?: () => void;
}

export class QoderSession implements HarnessSession {
  readonly harnessId: HarnessId = harnessIdSchema.parse("qoder");
  readonly capabilities: HarnessSessionCapabilities = {
    configuration: {
      selectModel: true,
      selectThinkingOption: false,
      selectPermissionMode: false,
      permissionModeScope: "atCreate",
    },
    history: {
      fork: false,
      forkAcrossCwd: false,
      rollbackLastTurn: false,
    },
  };
  readonly initialState: HarnessSessionState;
  readonly initialUsage: HostUsage | null = null;
  readonly outputs: AsyncIterable<HarnessOutput>;

  readonly #channel = new HarnessOutputChannel<HarnessOutput>();
  readonly #pushableInput = new PushableInput<SDKUserMessage>();
  readonly #usageTracker = new QoderUsageTracker();
  readonly #pendingInteractions = new Map<string, PendingInteraction>();
  readonly #query: QoderQuery;
  readonly #onClosed: (() => void) | undefined;

  #state: HarnessSessionState;
  #activeTurn: ActiveTurnState | null = null;
  #closed = false;
  #consumerLoopDone: Promise<void>;

  constructor(options: QoderSessionOptions) {
    this.outputs = this.#channel.outputs;
    this.#onClosed = options.onClosed;

    const nativeRef: NativeSessionRef = nativeSessionRefSchema.parse({
      harnessId: "qoder",
      nativeSessionId: options.sessionId,
      formatVersion: 1,
    });

    this.#state = {
      nativeRef,
      effectiveModel: options.model ?? QODER_DEFAULT_MODEL_REF,
      ...(options.permissionModeId ? { effectivePermissionModeId: options.permissionModeId } : {}),
    };
    this.initialState = { ...this.#state };

    const qoderOptions: QoderOptions = {
      cwd: options.cwd,
      sessionId: options.sessionId,
      ...(options.pathToQoderCLIExecutable
        ? { pathToQoderCLIExecutable: options.pathToQoderCLIExecutable }
        : {}),
      includePartialMessages: true,
      canUseTool: this.#handleCanUseTool.bind(this),
    };

    this.#query = options.queryFactory({
      prompt: this.#pushableInput,
      options: qoderOptions,
    });

    this.#consumerLoopDone = this.#consumeMessages();
  }

  #emitEvent(event: HostEvent): void {
    this.#channel.emit({ kind: "event", event });
  }

  #emitInteraction(interaction: HostApprovalInteraction | HostQuestionInteraction): void {
    this.#channel.emit({ kind: "interaction", interaction });
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
          this.#emitEvent({
            type: "turn.completed",
            turnId: this.#activeTurn.turnId,
            outcome: { status: "failed", error: harnessError },
          });
          this.#activeTurn = null;
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
        this.#handleStreamEvent(message as SDKStreamEvent);
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

  #handleSystemMessage(message: SDKSystemMessage): void {
    if (message.subtype === "init" && message.session_id) {
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
  }

  #handleStreamEvent(event: SDKStreamEvent): void {
    if (!this.#activeTurn) return;

    const delta =
      event.text_delta ||
      event.event?.delta?.text ||
      event.event?.delta?.thinking;

    if (delta && delta.length > 0) {
      let itemId = this.#activeTurn.activeStreamingItemId;
      if (!itemId) {
        itemId = hostItemIdSchema.parse(`item-${randomUUID()}`);
        this.#activeTurn.activeStreamingItemId = itemId;
        this.#activeTurn.accumulatedStreamingText = "";
        this.#emitEvent({
          type: "item.started",
          turnId: this.#activeTurn.turnId,
          item: {
            type: "agentMessage",
            itemId,
            text: "",
          },
        });
      }

      this.#activeTurn.accumulatedStreamingText += delta;
      this.#emitEvent({
        type: "item.updated",
        turnId: this.#activeTurn.turnId,
        itemId,
        update: {
          type: "text.append",
          text: delta,
        },
      });
    }
  }

  #handleAssistantMessage(message: SDKAssistantMessage): void {
    if (!this.#activeTurn) return;

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

    for (const block of content) {
      this.#projectAssistantBlock(block);
    }
  }

  #projectAssistantBlock(block: SDKAssistantContent): void {
    if (!this.#activeTurn) return;
    const turnId = this.#activeTurn.turnId;

    if (block.type === "text") {
      const activeStreamingId = this.#activeTurn.activeStreamingItemId;
      const accumulated = this.#activeTurn.accumulatedStreamingText;

      if (activeStreamingId && block.text.startsWith(accumulated)) {
        // Delta deduplication: append only the difference if any
        const remaining = block.text.slice(accumulated.length);
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
              text: block.text,
            },
            outcome: { status: "succeeded" },
          },
        });
        this.#activeTurn.activeStreamingItemId = undefined;
        this.#activeTurn.accumulatedStreamingText = "";
      } else {
        const itemId = hostItemIdSchema.parse(`item-${randomUUID()}`);
        this.#emitEvent({
          type: "item.started",
          turnId,
          item: {
            type: "agentMessage",
            itemId,
            text: block.text,
          },
        });
        this.#emitEvent({
          type: "item.completed",
          turnId,
          snapshot: {
            item: {
              type: "agentMessage",
              itemId,
              text: block.text,
            },
            outcome: { status: "succeeded" },
          },
        });
      }
    } else if (block.type === "thinking") {
      const itemId = hostItemIdSchema.parse(`item-${randomUUID()}`);
      this.#emitEvent({
        type: "item.started",
        turnId,
        item: {
          type: "reasoning",
          itemId,
          text: block.thinking,
        },
      });
      this.#emitEvent({
        type: "item.completed",
        turnId,
        snapshot: {
          item: {
            type: "reasoning",
            itemId,
            text: block.thinking,
          },
          outcome: { status: "succeeded" },
        },
      });
    } else if (block.type === "tool_use") {
      const itemId = hostItemIdSchema.parse(block.id || `tool-${randomUUID()}`);
      this.#emitEvent({
        type: "item.started",
        turnId,
        item: {
          type: "toolExecution",
          itemId,
          toolName: block.name,
          arguments: (block.input as JsonValue) ?? {},
        },
      });
      this.#emitEvent({
        type: "item.completed",
        turnId,
        snapshot: {
          item: {
            type: "toolExecution",
            itemId,
            toolName: block.name,
            arguments: (block.input as JsonValue) ?? {},
          },
          outcome: { status: "succeeded" },
        },
      });
    }
  }

  #handleResultMessage(result: SDKResultMessage): void {
    if (!this.#activeTurn) return;

    this.#usageTracker.observeResult(result);
    const usage = this.#usageTracker.snapshot();
    if (usage) {
      this.#emitEvent({
        type: "session.usage.changed",
        usage,
        observedForTurnId: this.#activeTurn.turnId,
      });
    }

    // Close any active streaming item
    if (this.#activeTurn.activeStreamingItemId) {
      this.#emitEvent({
        type: "item.completed",
        turnId: this.#activeTurn.turnId,
        snapshot: {
          item: {
            type: "agentMessage",
            itemId: this.#activeTurn.activeStreamingItemId,
            text: this.#activeTurn.accumulatedStreamingText,
          },
          outcome: { status: "succeeded" },
        },
      });
      this.#activeTurn.activeStreamingItemId = undefined;
      this.#activeTurn.accumulatedStreamingText = "";
    }

    const turnId = this.#activeTurn.turnId;
    this.#activeTurn = null;

    if (result.subtype === "success") {
      this.#emitEvent({
        type: "turn.completed",
        turnId,
        outcome: { status: "succeeded" },
      });
    } else {
      const error = mapQoderResultError(result);
      this.#emitEvent({
        type: "turn.completed",
        turnId,
        outcome: { status: "failed", error },
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
      const qObj = (typeof qItem === "object" && qItem !== null ? qItem : {}) as Record<string, unknown>;
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
        resolve({ behavior: "deny", message: "Question interaction aborted" });
      };

      context.signal.addEventListener("abort", onAbort, { once: true });

      this.#pendingInteractions.set(interactionId, {
        id: interactionId,
        interaction,
        questionPrompts,
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
      description: typeof input === "object" && input !== null ? JSON.stringify(input) : String(input),
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
        resolve: (result) => {
          cleanup();
          resolve(result);
        },
      });

      this.#emitInteraction(interaction);
    });
  }

  async readSnapshot(): Promise<HarnessResult<HostThreadSnapshot>> {
    return {
      ok: false,
      error: {
        code: "unsupported",
        message: "Qoder does not provide native transcript snapshot reading",
        retryable: false,
      },
    };
  }

  async refreshUsage(): Promise<void> {
    if (this.#query.getContextUsage) {
      try {
        const usage = await this.#query.getContextUsage();
        if (usage) {
          this.#usageTracker.observeContextUsage(usage);
          const snapshot = this.#usageTracker.snapshot();
          if (snapshot) {
            this.#emitEvent({
              type: "session.usage.changed",
              usage: snapshot,
              ...(this.#activeTurn ? { observedForTurnId: this.#activeTurn.turnId } : {}),
            });
          }
        }
      } catch {
        // Diagnostic failure only, never fails turn
      }
    }
  }

  async execute(command: TurnStartCommand): Promise<HarnessResult<TurnStartAccepted>>;
  async execute(command: TurnCancelCommand): Promise<HarnessResult<TurnCancelAccepted>>;
  async execute(command: InteractionRespondCommand): Promise<HarnessResult<InteractionRespondAccepted>>;
  async execute(command: ModelSelectCommand): Promise<HarnessResult<ModelSelectCompleted>>;
  async execute(command: ThinkingSelectCommand): Promise<HarnessResult<ThinkingSelectCompleted>>;
  async execute(command: PermissionModeSelectCommand): Promise<HarnessResult<PermissionModeSelectCompleted>>;
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

        try {
          await this.#query.interrupt();
        } catch {
          // Interrupt call may fail if query has already completed
        }

        if (this.#activeTurn) {
          this.#emitEvent({
            type: "turn.completed",
            turnId: this.#activeTurn.turnId,
            outcome: { status: "cancelled", reason: "User cancelled turn" },
          });
          this.#activeTurn = null;
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
            pending.resolve({ behavior: "allow" });
          } else {
            pending.resolve({ behavior: "deny", message: "User denied permission" });
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
            pending.resolve({ behavior: "deny", message: "User cancelled question" });
          } else {
            // Qoder requires answers keyed by full question prompt text!
            const answers: Record<string, string> = {};
            for (const prompt of pending.questionPrompts ?? []) {
              const answerList = command.response.answers[prompt];
              if (Array.isArray(answerList) && answerList.length > 0) {
                answers[prompt] = answerList.join(", ");
              }
            }

            pending.resolve({
              behavior: "allow",
              updatedInput: {
                answers,
              },
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

        if (this.#query.setModel) {
          try {
            await this.#query.setModel(nativeModel);
          } catch (err) {
            return {
              ok: false,
              error: mapQoderException(err),
            };
          }
        }

        this.#state = {
          ...this.#state,
          effectiveModel: command.model,
        };
        this.#emitEvent({
          type: "session.state.changed",
          state: { ...this.#state },
        });

        return { ok: true, value: { completed: true } };
      }

      case "thinking.select":
        return {
          ok: false,
          error: {
            code: "unsupported",
            message: "Thinking option selection is not supported for Qoder",
            retryable: false,
          },
        };

      case "permissionMode.select":
        return {
          ok: false,
          error: {
            code: "unsupported",
            message: "Live permission mode selection is not supported for Qoder",
            retryable: false,
          },
        };

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
      this.#emitEvent({
        type: "turn.completed",
        turnId: this.#activeTurn.turnId,
        outcome: { status: "cancelled", reason: "Session closed" },
      });
      this.#activeTurn = null;
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
