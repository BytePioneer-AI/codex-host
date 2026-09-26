import { setTimeout as delay } from "node:timers/promises";

import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  AvailableCommand,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import {
  HarnessOutputChannel,
  validateHostApprovalResponse,
  validateHostQuestionResponse,
  type HarnessCommandCapability,
  type HarnessCommandInvocation,
  type HarnessError,
  type HarnessOutput,
  type HarnessResult,
  type HarnessSession,
  type HarnessSessionCapabilities,
  type HarnessSessionState,
  type HostAgentMessageItem,
  type HostApprovalInteraction,
  type HostCommand,
  type HostItemOutcome,
  type HostItemSnapshot,
  type HostQuestionInteraction,
  type HostReasoningItem,
  type HostThreadSnapshot,
  type HostUsage,
  type InteractionRespondAccepted,
  type InteractionRespondCommand,
  type ModelSelectCompleted,
  type ModelSelectCommand,
  type PermissionModeSelectCompleted,
  type PermissionModeSelectCommand,
  type ThinkingSelectCompleted,
  type ThinkingSelectCommand,
  type TurnCancelAccepted,
  type TurnCancelCommand,
  type TurnOutcome,
  type TurnStartAccepted,
  type TurnStartCommand,
} from "@codexhost/harness-adapter";
import {
  harnessIdSchema,
  harnessPermissionModeIdSchema,
  hostItemIdSchema,
  type HarnessCommandCatalog,
  type HarnessId,
  type HostInteractionId,
  type HostTurnId,
  type NativeSessionRef,
} from "@codexhost/shared-contracts";

import type {
  ActivePromptHandler,
  KimiTransportEvent,
  KimiTransportError,
} from "./acp-transport.js";
import type { KimiAcpTransportLike } from "./kimi-adapter.js";
import { appendKimiCommandHistory, readKimiCommandHistory } from "./command-history.js";
import {
  createKimiNativeSessionRef,
  createKimiNativeTurnRef,
  readKimiSessionSnapshot,
  readKimiSessionUsage,
  type KimiTurnSnapshot,
} from "./history.js";
import {
  decodeKimiModelRefId,
  encodeKimiModelRef,
  isKimiModeId,
  readKimiEffectiveConfig,
  readKimiThinkingOptions,
  KimiThinkingSelectionError,
} from "./models.js";
import {
  canonicalizeKimiToolName,
  createHostItemFromToolState,
  formatElicitationResponse,
  KimiToolCallAccumulator,
  parseKimiUsage,
  projectKimiApprovalRequest,
  projectKimiElicitationRequest,
  readAcpToolContentText,
} from "./projection.js";
import {
  buildKimiCommandCatalog,
  formatKimiCommandPrompt,
  formatKimiCommandOutput,
  stripAnsi,
  KIMI_DEFAULT_COMMANDS,
} from "./slash-commands.js";

const kimiHarnessId: HarnessId = harnessIdSchema.parse("kimi-code");
const defaultNativeTurnFlushTimeoutMs = 6_000;
const nativeTurnFlushPollMs = 50;

export const kimiSessionCapabilities: HarnessSessionCapabilities = {
  configuration: {
    selectModel: true,
    selectThinkingOption: true,
    selectPermissionMode: true,
    permissionModeScope: "live",
  },
  history: {
    fork: true,
    forkAcrossCwd: false,
    rollbackLastTurn: true,
  },
  subagents: {
    observe: false,
    readTranscript: false,
  },
  autonomousTurns: {
    observe: false,
  },
};

function ok<T>(value: T): HarnessResult<T> {
  return { ok: true, value };
}

function err<T>(code: HarnessError["code"], message: string, retryable = false): HarnessResult<T> {
  return { ok: false, error: { code, message, retryable } };
}

interface ActiveInteraction {
  id: HostInteractionId;
  type: "approval" | "question";
  interaction: HostApprovalInteraction | HostQuestionInteraction;
  resolve: (value: unknown) => void;
  metadata?: unknown;
}

export interface KimiSessionOptions {
  transport: KimiAcpTransportLike;
  sessionId: string;
  cwd: string;
  initialState: HarnessSessionState;
  initialUsage?: HostUsage | null;
  contextWindowTokens?: number;
  homeDirectory?: string;
  kimiCodeHome?: string;
  readNativeSnapshot?: () => Promise<{ turns: KimiTurnSnapshot[] }>;
  nativeTurnFlushTimeoutMs?: number;
  onCommandsUpdate?: (catalog: HarnessCommandCatalog) => void;
}

export class KimiSession implements HarnessSession {
  readonly harnessId: HarnessId = kimiHarnessId;
  readonly capabilities: HarnessSessionCapabilities = kimiSessionCapabilities;
  readonly outputs: AsyncIterable<HarnessOutput>;

  #channel = new HarnessOutputChannel<HarnessOutput>();
  #transport: KimiAcpTransportLike;
  #sessionId: string;
  #cwd: string;
  #state: HarnessSessionState;
  #usage: HostUsage | null = null;
  #contextWindowTokens: number;
  #homeDirectory: string | undefined;
  #kimiCodeHome: string | undefined;
  #readNativeSnapshot: () => Promise<{ turns: KimiTurnSnapshot[] }>;
  #nativeTurnFlushTimeoutMs: number;
  #closed = false;
  #faulted = false;
  #transportFault: KimiTransportError | null = null;
  #activeTurn: {
    turnId: HostTurnId;
    cancellationRequested: boolean;
  } | null = null;
  #activeTurnPromise: Promise<void> | null = null;
  #activeInteractions = new Map<HostInteractionId, ActiveInteraction>();
  #availableCommands: AvailableCommand[] = [...KIMI_DEFAULT_COMMANDS];
  #onCommandsUpdate: ((catalog: HarnessCommandCatalog) => void) | undefined;

  constructor(options: KimiSessionOptions) {
    this.#transport = options.transport;
    this.#sessionId = options.sessionId;
    this.#cwd = options.cwd;
    this.#state = { ...options.initialState };
    this.#usage = options.initialUsage ?? null;
    this.#contextWindowTokens = options.contextWindowTokens ?? 200_000;
    this.#homeDirectory = options.homeDirectory;
    this.#kimiCodeHome = options.kimiCodeHome;
    this.#nativeTurnFlushTimeoutMs =
      options.nativeTurnFlushTimeoutMs ?? defaultNativeTurnFlushTimeoutMs;
    this.#readNativeSnapshot =
      options.readNativeSnapshot ??
      (() =>
        readKimiSessionSnapshot(options.sessionId, {
          ...(options.homeDirectory ? { homeDirectory: options.homeDirectory } : {}),
          ...(options.kimiCodeHome ? { kimiCodeHome: options.kimiCodeHome } : {}),
        }));
    this.#onCommandsUpdate = options.onCommandsUpdate;
    this.outputs = this.#channel.outputs;
    this.#transport.setSessionEventHandler((event) => this.#handleSessionEvent(event));
  }

  get initialState(): HarnessSessionState {
    return { ...this.#state };
  }

  get initialUsage(): HostUsage | null {
    return this.#usage ? { ...this.#usage } : null;
  }

  async refreshUsage(): Promise<void> {
    await this.#refreshUsage();
  }

  async #refreshUsage(observedForTurnId?: HostTurnId): Promise<HostUsage | null> {
    try {
      const usage = await readKimiSessionUsage(this.#sessionId, {
        ...(this.#homeDirectory ? { homeDirectory: this.#homeDirectory } : {}),
        ...(this.#kimiCodeHome ? { kimiCodeHome: this.#kimiCodeHome } : {}),
        contextWindowTokens: this.#contextWindowTokens,
      });
      if (usage) {
        this.#usage = { ...(this.#usage ?? {}), ...usage };
        this.#channel.emit({
          kind: "event",
          event: {
            type: "session.usage.changed",
            ...(observedForTurnId ? { observedForTurnId } : {}),
            usage: { ...this.#usage },
          },
        });
      }
      return usage;
    } catch {
      return null;
    }
  }

  get nativeSessionRef(): NativeSessionRef {
    return createKimiNativeSessionRef(this.#sessionId, this.#cwd);
  }

  get commands(): HarnessCommandCapability {
    return {
      list: async () => ok(buildKimiCommandCatalog(this.#availableCommands)),
      execute: async (invocation: HarnessCommandInvocation) => {
        const commandId = invocation.commandId.trim().replace(/^\/+/, "");
        if (
          !this.#availableCommands.some(
            (command) => command.name.trim().replace(/^\/+/, "") === commandId,
          )
        ) {
          return err("invalidRequest", `Unknown Kimi command: ${invocation.commandId}`);
        }
        const formatted = formatKimiCommandPrompt(invocation);
        if (!formatted.ok) return formatted;

        const startAccepted = await this.execute({
          type: "turn.start",
          turnId: invocation.turnId,
          input: [{ type: "text", text: formatted.value }],
        });

        if (!startAccepted.ok) return startAccepted;
        return ok({ turnId: invocation.turnId });
      },
    };
  }

  async readSnapshot(): Promise<HarnessResult<HostThreadSnapshot>> {
    if (this.#activeTurn) {
      return err("sessionBusy", "Cannot read snapshot while a turn is active");
    }
    try {
      const snapshot = await this.#readNativeSnapshot();
      const commands = await readKimiCommandHistory(this.#sessionId, {
        ...(this.#homeDirectory ? { homeDirectory: this.#homeDirectory } : {}),
        ...(this.#kimiCodeHome ? { kimiCodeHome: this.#kimiCodeHome } : {}),
      });
      return ok({
        ...snapshot,
        turns: [...snapshot.turns, ...commands].sort(
          (a, b) => (a.startedAtMs ?? 0) - (b.startedAtMs ?? 0),
        ),
        state: { ...this.#state },
      });
    } catch (error) {
      return err(
        "nativeFailure",
        `Failed to read snapshot: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
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
    if (this.#closed || this.#faulted) {
      return err("invalidState", "Kimi session is closed");
    }

    switch (command.type) {
      case "turn.start":
        return this.#handleTurnStart(command);
      case "turn.cancel":
        return this.#handleTurnCancel(command);
      case "interaction.respond":
        return this.#handleInteractionRespond(command);
      case "model.select":
        return this.#handleModelSelect(command);
      case "thinking.select":
        return this.#handleThinkingSelect(command);
      case "permissionMode.select":
        return this.#handlePermissionModeSelect(command);
      default:
        return err("unsupported", `Unsupported command type`);
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#transport.setSessionEventHandler(null);

    this.#closeActiveInteractions("cancelled");

    if (this.#activeTurn) {
      this.#activeTurn.cancellationRequested = true;
      await this.#transport.cancel().catch(() => undefined);
    }

    await this.#transport.close().catch(() => undefined);

    if (this.#activeTurnPromise) {
      await this.#activeTurnPromise.catch(() => undefined);
      this.#activeTurnPromise = null;
    }

    this.#channel.end();
  }

  handleTransportFault(error: KimiTransportError): void {
    if (this.#closed || this.#faulted) return;
    this.#faulted = true;
    this.#transportFault = error;
    this.#closeActiveInteractions("cancelled");
    void this.#finishTransportFault(error);
  }

  async #finishTransportFault(error: KimiTransportError): Promise<void> {
    await this.#transport.close().catch(() => undefined);
    await this.#activeTurnPromise?.catch(() => undefined);
    this.#channel.emit({
      kind: "event",
      event: {
        type: "session.faulted",
        error: {
          code: error.kind,
          message: error.message,
          retryable: false,
          ...(error.diagnostic ? { diagnostic: error.diagnostic } : {}),
        },
      },
    });
    this.#channel.end();
  }

  #applyConfigOptions(configOptions: unknown[]): void {
    const effective = readKimiEffectiveConfig(configOptions);
    const state = {
      ...this.#state,
      availableThinkingOptions: readKimiThinkingOptions(configOptions),
    };
    delete state.effectiveModel;
    delete state.effectiveThinkingOptionId;
    delete state.effectivePermissionModeId;
    if (effective.modelAlias) state.effectiveModel = encodeKimiModelRef(effective.modelAlias);
    if (effective.thinkingOptionId) state.effectiveThinkingOptionId = effective.thinkingOptionId;
    if (effective.permissionModeId)
      state.effectivePermissionModeId = harnessPermissionModeIdSchema.parse(
        effective.permissionModeId,
      );
    this.#state = state;
    this.#channel.emit({
      kind: "event",
      event: { type: "session.state.changed", state: { ...this.#state } },
    });
  }

  #handleSessionEvent(
    event: Extract<
      KimiTransportEvent,
      {
        type: "config.update" | "mode.update" | "commands.update";
      }
    >,
  ): void {
    if (event.type === "commands.update") {
      this.#availableCommands = [...event.commands];
      const catalog = buildKimiCommandCatalog(this.#availableCommands);
      this.#onCommandsUpdate?.(catalog);
    } else if (event.type === "config.update") {
      this.#applyConfigOptions(event.configOptions);
    } else if (isKimiModeId(event.currentModeId)) {
      this.#state.effectivePermissionModeId = harnessPermissionModeIdSchema.parse(
        event.currentModeId,
      );
      this.#channel.emit({
        kind: "event",
        event: { type: "session.state.changed", state: { ...this.#state } },
      });
    }
  }

  async #readNativeTurns(): Promise<KimiTurnSnapshot[]> {
    return (await this.#readNativeSnapshot()).turns;
  }

  async #handleTurnStart(command: TurnStartCommand): Promise<HarnessResult<TurnStartAccepted>> {
    if (this.#activeTurn) {
      return err("sessionBusy", "Another turn is already in progress");
    }
    if (!command.input.some((input) => input.text.trim())) {
      return err("invalidRequest", "Kimi prompt cannot be empty");
    }

    const turnId = command.turnId;
    this.#activeTurn = {
      turnId,
      cancellationRequested: false,
    };

    // Asynchronously drive the turn on outputs
    this.#activeTurnPromise = this.#runTurn(command);

    return ok({ turnId });
  }

  async #runTurn(command: TurnStartCommand): Promise<void> {
    try {
      this.#channel.emit(await this.#runTurnBody(command));
    } catch (error) {
      this.#channel.emit({
        kind: "event",
        event: {
          type: "turn.completed",
          turnId: command.turnId,
          outcome: {
            status: "failed",
            error: {
              code: "nativeFailure",
              message: error instanceof Error ? error.message : String(error),
              retryable: false,
            },
          },
        },
      });
    } finally {
      this.#closeActiveInteractions("cancelled");
      this.#activeTurn = null;
      this.#activeTurnPromise = null;
    }
  }

  async #runTurnBody(command: TurnStartCommand): Promise<HarnessOutput> {
    const turnId = command.turnId;
    const startedAtMs = Date.now();
    this.#channel.emit({ kind: "event", event: { type: "turn.started", turnId } });

    const inputText = command.input.map((i) => i.text).join("\n");
    const isCommandTurn = inputText.trim().startsWith("/");
    let commandOutput = "";
    const completedItems: HostItemSnapshot[] = [];
    const completeItem = (snapshot: HostItemSnapshot) => {
      completedItems.push(snapshot);
      this.#channel.emit({ kind: "event", event: { type: "item.completed", turnId, snapshot } });
    };
    const accumulator = new KimiToolCallAccumulator();
    let previousNativeTurnKeys: Set<string> | null = null;
    let identityError: Error | null = null;

    try {
      previousNativeTurnKeys = new Set(
        (await this.#readNativeTurns()).map((turn) => turn.nativeTurnRef.nativeTurnKey),
      );
    } catch (error) {
      identityError = error instanceof Error ? error : new Error(String(error));
    }

    let currentReasoning: HostReasoningItem | null = null;
    let reasoningIndex = 0;

    const ensureReasoning = () => {
      if (!currentReasoning) {
        currentReasoning = {
          type: "reasoning",
          itemId: hostItemIdSchema.parse(`item:${turnId}:reasoning:${reasoningIndex++}`),
          text: "",
        };
        this.#channel.emit({
          kind: "event",
          event: {
            type: "item.started",
            turnId,
            item: { ...currentReasoning },
          },
        });
      }
      return currentReasoning;
    };

    const appendReasoningText = (text: string) => {
      if (!text) return;
      const reasoning = ensureReasoning();
      reasoning.text += text;
      this.#channel.emit({
        kind: "event",
        event: {
          type: "item.updated",
          turnId,
          itemId: reasoning.itemId,
          update: { type: "text.append", text },
        },
      });
    };

    const completeReasoning = () => {
      if (currentReasoning) {
        if (currentReasoning.text.length > 0) {
          const item: HostReasoningItem = {
            type: "reasoning",
            itemId: currentReasoning.itemId,
            text: currentReasoning.text,
          };
          completeItem({ item, outcome: { status: "succeeded" } });
        }
        currentReasoning = null;
      }
    };

    let currentAgentMessage: HostAgentMessageItem | null = null;
    let messageIndex = 0;
    let hasHadToolCallsInTurn = false;

    const appendAgentText = (text: string, phase?: "commentary" | "final_answer") => {
      if (!text) return;
      if (!currentAgentMessage) {
        currentAgentMessage = {
          type: "agentMessage",
          itemId: hostItemIdSchema.parse(`item:${turnId}:agent:${messageIndex++}`),
          text: "",
          ...(phase ? { phase } : {}),
        };
        this.#channel.emit({
          kind: "event",
          event: {
            type: "item.started",
            turnId,
            item: { ...currentAgentMessage },
          },
        });
      }
      currentAgentMessage.text += text;
      this.#channel.emit({
        kind: "event",
        event: {
          type: "item.updated",
          turnId,
          itemId: currentAgentMessage.itemId,
          update: { type: "text.append", text },
        },
      });
    };

    const completeAgentMessage = (phase?: "commentary" | "final_answer") => {
      if (currentAgentMessage) {
        const resolvedPhase = phase ?? currentAgentMessage.phase;
        const item: HostAgentMessageItem = {
          type: "agentMessage",
          itemId: currentAgentMessage.itemId,
          text: currentAgentMessage.text,
          ...(resolvedPhase ? { phase: resolvedPhase } : {}),
        };
        completeItem({ item, outcome: { status: "succeeded" } });
        currentAgentMessage = null;
      }
    };

    const handler: ActivePromptHandler = {
      onEvent: (event: KimiTransportEvent) => {
        if (this.#closed || this.#faulted || this.#activeTurn?.turnId !== turnId) return;

        switch (event.type) {
          case "agent.text": {
            completeReasoning();
            if (isCommandTurn) commandOutput += event.text;
            else appendAgentText(stripAnsi(event.text));
            break;
          }
          case "agent.thought": {
            if (currentAgentMessage) {
              completeAgentMessage("commentary");
            }
            appendReasoningText(stripAnsi(event.text));
            break;
          }
          case "tool.call": {
            hasHadToolCallsInTurn = true;
            completeReasoning();
            if (currentAgentMessage) {
              completeAgentMessage("commentary");
            }
            const state = accumulator.getOrCreate(event.toolCallId, turnId, event.name, event.kind);
            state.name = canonicalizeKimiToolName(event.name, event.kind, event.args);
            if (event.kind) state.kind = event.kind;
            if (event.args !== undefined) state.rawInput = event.args;
            if (!state.itemStartedEmitted && state.rawInput) {
              state.itemStartedEmitted = true;
              const item = createHostItemFromToolState(state, this.#cwd);
              this.#channel.emit({
                kind: "event",
                event: { type: "item.started", turnId, item },
              });
            }
            break;
          }
          case "tool.update": {
            completeReasoning();
            if (currentAgentMessage) {
              completeAgentMessage("commentary");
            }
            const state = accumulator.getOrCreate(event.toolCallId, turnId, event.name, event.kind);
            if (state.name === "Tool" && event.name) {
              state.name = canonicalizeKimiToolName(
                event.name,
                event.kind ?? state.kind,
                event.rawInput ?? state.rawInput,
              );
            }
            if (event.kind) state.kind = event.kind;
            if (event.rawInput !== undefined) state.rawInput = event.rawInput;
            if (event.rawOutput !== undefined) state.rawOutput = event.rawOutput;
            if (event.content !== undefined)
              state.contentAccumulator = readAcpToolContentText(event.content);

            if (!state.itemStartedEmitted && (state.rawInput || state.contentAccumulator)) {
              state.itemStartedEmitted = true;
              const item = createHostItemFromToolState(state, this.#cwd);
              this.#channel.emit({
                kind: "event",
                event: { type: "item.started", turnId, item },
              });
            }

            if (event.status === "completed" || event.status === "failed") {
              state.status = event.status;
              if (!state.itemStartedEmitted) {
                state.itemStartedEmitted = true;
                const item = createHostItemFromToolState(state, this.#cwd);
                this.#channel.emit({
                  kind: "event",
                  event: { type: "item.started", turnId, item },
                });
              }
              const item = createHostItemFromToolState(state, this.#cwd);
              const outcome: HostItemOutcome =
                event.status === "completed"
                  ? { status: "succeeded" }
                  : {
                      status: "failed",
                      error: {
                        code: "nativeFailure",
                        message: "Tool execution failed",
                        retryable: false,
                      },
                    };

              completeItem({ item, outcome });
            }
            break;
          }
          case "usage": {
            const parsedUsage = parseKimiUsage(event.update, this.#contextWindowTokens);
            if (parsedUsage) {
              this.#usage = { ...this.#usage, ...parsedUsage };
              this.#channel.emit({
                kind: "event",
                event: {
                  type: "session.usage.changed",
                  usage: { ...this.#usage },
                },
              });
            }
            break;
          }
          case "commands.update": {
            this.#handleSessionEvent(event);
            break;
          }
          case "config.update": {
            this.#handleSessionEvent(event);
            break;
          }
          case "mode.update": {
            this.#handleSessionEvent(event);
            break;
          }
        }
      },
      onPermission: async (
        request: RequestPermissionRequest,
      ): Promise<RequestPermissionResponse> => {
        completeReasoning();
        if (currentAgentMessage) {
          completeAgentMessage("commentary");
        }
        const projected = projectKimiApprovalRequest(turnId, request);
        return new Promise<RequestPermissionResponse>((resolve) => {
          this.#activeInteractions.set(projected.interaction.interactionId, {
            id: projected.interaction.interactionId,
            type: "approval",
            interaction: projected.interaction,
            metadata: projected.optionIdByActionId,
            resolve: (val) => resolve(val as RequestPermissionResponse),
          });
          this.#channel.emit({
            kind: "interaction",
            interaction: projected.interaction,
          });
        });
      },
      onElicitation: async (
        request: CreateElicitationRequest,
      ): Promise<CreateElicitationResponse> => {
        completeReasoning();
        if (currentAgentMessage) {
          completeAgentMessage("commentary");
        }
        const projected = projectKimiElicitationRequest(turnId, request);
        return new Promise<CreateElicitationResponse>((resolve) => {
          this.#activeInteractions.set(projected.interaction.interactionId, {
            id: projected.interaction.interactionId,
            type: "question",
            interaction: projected.interaction,
            metadata: projected.schemaProperties,
            resolve: (val) => resolve(val as CreateElicitationResponse),
          });
          this.#channel.emit({
            kind: "interaction",
            interaction: projected.interaction,
          });
        });
      },
    };

    let promptResponse: PromptResponse | null = null;
    let promptError: Error | null = null;

    try {
      if (this.#closed || this.#activeTurn?.cancellationRequested) {
        promptResponse = { stopReason: "cancelled" };
      } else if (this.#transportFault) {
        throw this.#transportFault;
      } else {
        promptResponse = await this.#transport.prompt(inputText, handler);
      }
    } catch (error) {
      promptError = error instanceof Error ? error : new Error(String(error));
    }

    this.#closeActiveInteractions("cancelled");

    for (const state of accumulator.values()) {
      if (state.status === "completed" || state.status === "failed") continue;
      state.status = "failed";
      if (!state.itemStartedEmitted) {
        state.itemStartedEmitted = true;
        this.#channel.emit({
          kind: "event",
          event: {
            type: "item.started",
            turnId,
            item: createHostItemFromToolState(state, this.#cwd),
          },
        });
      }
      completeItem({
        item: createHostItemFromToolState(state, this.#cwd),
        outcome: {
          status: "failed",
          error: {
            code: "nativeFailure",
            message: promptError?.message ?? "Tool execution did not complete",
            retryable: false,
          },
        },
      });
    }

    // Complete any open reasoning or message items immediately
    completeReasoning();
    if (isCommandTurn) appendAgentText(formatKimiCommandOutput(commandOutput));
    completeAgentMessage(hasHadToolCallsInTurn ? "final_answer" : undefined);

    let currentNativeTurn: KimiTurnSnapshot | null = null;
    if (isCommandTurn) {
      const outcome: TurnOutcome = promptError
        ? {
            status: "failed",
            error: { code: "nativeFailure", message: promptError.message, retryable: false },
          }
        : promptResponse?.stopReason === "cancelled"
          ? { status: "cancelled", reason: "Native command cancelled" }
          : { status: "succeeded" };
      const commandTurn: KimiTurnSnapshot = {
        nativeTurnRef: createKimiNativeTurnRef(this.#sessionId, `command:${turnId}`),
        input: command.input,
        items: completedItems,
        outcome,
        startedAtMs,
        completedAtMs: Date.now(),
      };
      try {
        await appendKimiCommandHistory(commandTurn, {
          ...(this.#homeDirectory ? { homeDirectory: this.#homeDirectory } : {}),
          ...(this.#kimiCodeHome ? { kimiCodeHome: this.#kimiCodeHome } : {}),
        });
        currentNativeTurn = commandTurn;
      } catch (error) {
        identityError = error instanceof Error ? error : new Error(String(error));
      }
    } else if (this.#activeTurn?.cancellationRequested) {
      try {
        if (previousNativeTurnKeys) {
          const quickTurns = (await this.#readNativeTurns()).filter(
            (turn) =>
              !previousNativeTurnKeys.has(turn.nativeTurnRef.nativeTurnKey) &&
              turn.input
                .map((input) => input.text)
                .join("\n")
                .trim() === inputText.trim(),
          );
          currentNativeTurn = quickTurns.length === 1 ? (quickTurns[0] ?? null) : null;
        }
      } catch {
        // Non-blocking quick check
      }
    } else if (previousNativeTurnKeys && !promptError) {
      const correlated = await this.#waitForNativeTurn(previousNativeTurnKeys, inputText);
      currentNativeTurn = correlated.turn;
      identityError = correlated.error;
    }

    if (currentNativeTurn) {
      for (const itemSnap of currentNativeTurn.items) {
        if (itemSnap.item.type !== "fileChange") continue;
        this.#channel.emit({
          kind: "event",
          event: { type: "item.started", turnId, item: itemSnap.item },
        });
        this.#channel.emit({
          kind: "event",
          event: { type: "item.completed", turnId, snapshot: itemSnap },
        });
      }
    }

    // Refresh and emit usage for this turn
    const responseUsage = promptResponse?.usage;
    if (responseUsage && typeof responseUsage === "object" && !Array.isArray(responseUsage)) {
      const promptUsage = parseKimiUsage(
        responseUsage as Record<string, unknown>,
        this.#contextWindowTokens,
      );
      if (promptUsage) {
        this.#usage = { ...(this.#usage ?? {}), ...promptUsage };
      }
    }
    await this.#refreshUsage(turnId);

    // Determine Turn Outcome
    let turnOutcome: TurnOutcome;
    if (
      promptResponse?.stopReason === "cancelled" ||
      currentNativeTurn?.outcome.status === "cancelled"
    ) {
      turnOutcome = {
        status: "cancelled",
        reason: "Turn was cancelled",
      };
    } else if (promptError || currentNativeTurn?.outcome.status === "failed") {
      turnOutcome = {
        status: "failed",
        error: {
          code: "nativeFailure",
          message: promptError
            ? promptError.message
            : currentNativeTurn?.outcome.status === "failed"
              ? currentNativeTurn.outcome.error.message
              : "Native turn reported failure",
          retryable: false,
        },
      };
    } else if (!currentNativeTurn) {
      turnOutcome = {
        status: "failed",
        error: {
          code: "protocolError",
          message: identityError?.message ?? "Kimi did not persist a unique Native Turn identity",
          retryable: false,
        },
      };
    } else if (currentNativeTurn.outcome.status === "unknown") {
      turnOutcome = {
        status: "failed",
        error: {
          code: "protocolError",
          message: currentNativeTurn.outcome.reason,
          retryable: false,
        },
      };
    } else {
      turnOutcome = {
        status: "succeeded",
      };
    }

    const completedOutcome: TurnOutcome = currentNativeTurn?.checkpoint
      ? { ...turnOutcome, checkpoint: currentNativeTurn.checkpoint }
      : turnOutcome;

    return {
      kind: "event",
      event: {
        type: "turn.completed",
        turnId,
        ...(currentNativeTurn ? { nativeTurnRef: currentNativeTurn.nativeTurnRef } : {}),
        outcome: completedOutcome,
      },
    };
  }

  async #waitForNativeTurn(
    previousKeys: ReadonlySet<string>,
    inputText: string,
  ): Promise<{ turn: KimiTurnSnapshot | null; error: Error | null }> {
    const deadline = Date.now() + this.#nativeTurnFlushTimeoutMs;
    const normalizedInput = inputText.trim();
    let lastError: Error | null = null;
    let pollInterval = nativeTurnFlushPollMs;
    let lastCandidateTurn: KimiTurnSnapshot | null = null;

    do {
      try {
        const added = (await this.#readNativeTurns()).filter(
          (turn) => !previousKeys.has(turn.nativeTurnRef.nativeTurnKey),
        );
        const matching = added.filter(
          (turn) =>
            turn.input
              .map((input) => input.text)
              .join("\n")
              .trim() === normalizedInput,
        );
        if (matching.length > 1) {
          return {
            turn: null,
            error: new Error("Multiple Native Turns appeared while correlating the Kimi prompt"),
          };
        }
        const turn = matching[0];
        if (turn) {
          lastCandidateTurn = turn;
          if (turn.outcome.status !== "unknown") return { turn, error: null };
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
      if (Date.now() >= deadline) break;
      await delay(pollInterval);
      pollInterval = Math.min(pollInterval + 25, 200);
    } while (true);

    if (lastCandidateTurn) {
      return {
        turn: lastCandidateTurn,
        error: null,
      };
    }

    return {
      turn: null,
      error: lastError ?? new Error("Timed out waiting for Kimi to persist the Native Turn"),
    };
  }

  #closeActiveInteractions(reason: "cancelled" | "expired" | "superseded"): void {
    for (const interaction of this.#activeInteractions.values()) {
      this.#activeInteractions.delete(interaction.id);
      interaction.resolve(
        interaction.type === "approval"
          ? { outcome: { outcome: "cancelled" } }
          : { action: "cancel" },
      );
      this.#channel.emit({
        kind: "event",
        event: {
          type: "interaction.closed",
          interactionId: interaction.id,
          turnId: interaction.interaction.turnId,
          reason,
        },
      });
    }
  }

  async #handleTurnCancel(command: TurnCancelCommand): Promise<HarnessResult<TurnCancelAccepted>> {
    if (!this.#activeTurn || this.#activeTurn.turnId !== command.turnId) {
      return err("invalidRequest", "No active turn matches the cancellation request");
    }

    this.#activeTurn.cancellationRequested = true;
    try {
      await this.#transport.cancel();
    } catch (error) {
      if (this.#activeTurn?.turnId === command.turnId)
        this.#activeTurn.cancellationRequested = false;
      return err(
        "unavailable",
        `Kimi cancellation failed: ${error instanceof Error ? error.message : String(error)}`,
        true,
      );
    }

    this.#closeActiveInteractions("cancelled");

    return ok({ cancellationRequested: true });
  }

  async #handleInteractionRespond(
    command: InteractionRespondCommand,
  ): Promise<HarnessResult<InteractionRespondAccepted>> {
    const active = this.#activeInteractions.get(command.interactionId);
    if (!active) {
      return err("invalidRequest", `No active interaction matches ID ${command.interactionId}`);
    }

    const turnId = (active.interaction as { turnId: HostTurnId }).turnId;

    if (active.type === "approval") {
      if (command.response.type !== "approval") {
        return err(
          "invalidRequest",
          `Expected approval response for interaction ${command.interactionId}`,
        );
      }

      const validation = validateHostApprovalResponse(
        active.interaction as HostApprovalInteraction,
        command.response,
      );
      if (validation) {
        return err(validation.code, validation.message);
      }

      this.#activeInteractions.delete(command.interactionId);
      const optionIdMap = active.metadata as ReadonlyMap<string, string>;
      const selectedOptionId =
        optionIdMap?.get(command.response.actionId) || command.response.actionId;

      this.#channel.emit({
        kind: "event",
        event: {
          type: "interaction.closed",
          interactionId: active.id,
          turnId,
          reason: "responded",
        },
      });

      active.resolve({
        outcome: {
          outcome: "selected",
          optionId: selectedOptionId,
        },
      });

      return ok({ accepted: true });
    }

    if (active.type === "question") {
      if (command.response.type !== "question") {
        return err(
          "invalidRequest",
          `Expected question response for interaction ${command.interactionId}`,
        );
      }

      const validation = validateHostQuestionResponse(
        active.interaction as HostQuestionInteraction,
        command.response,
      );
      if (validation) {
        return err(validation.code, validation.message);
      }

      this.#activeInteractions.delete(command.interactionId);
      const schemaProps = active.metadata as Record<string, { type: "string" | "array" }>;
      const elicitationResponse = formatElicitationResponse(command.response, schemaProps);

      this.#channel.emit({
        kind: "event",
        event: {
          type: "interaction.closed",
          interactionId: active.id,
          turnId,
          reason: command.response.cancelled ? "cancelled" : "responded",
        },
      });

      active.resolve(elicitationResponse);
      return ok({ accepted: true });
    }

    return err("invalidRequest", `Interaction type mismatch for ${command.interactionId}`);
  }

  async #handleModelSelect(
    command: ModelSelectCommand,
  ): Promise<HarnessResult<ModelSelectCompleted>> {
    let alias: string;
    try {
      alias = decodeKimiModelRefId(command.model.id);
    } catch {
      return err("invalidRequest", `Invalid model reference: ${command.model.id}`);
    }

    try {
      const confirmed = await this.#transport.setConfigOption("model", alias);
      this.#applyConfigOptions(confirmed);
      if (this.#state.effectiveModel?.id !== command.model.id) {
        return err("unavailable", `Kimi did not confirm model ${alias}`);
      }
      return ok({ completed: true });
    } catch (error) {
      return err(
        "unavailable",
        `Failed to select model ${alias}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async #handleThinkingSelect(
    command: ThinkingSelectCommand,
  ): Promise<HarnessResult<ThinkingSelectCompleted>> {
    if (!this.#state.availableThinkingOptions?.some(({ id }) => id === command.thinkingOptionId)) {
      return err(
        "invalidRequest",
        new KimiThinkingSelectionError(command.thinkingOptionId).message,
      );
    }
    try {
      const confirmed = await this.#transport.setConfigOption("thinking", command.thinkingOptionId);
      this.#applyConfigOptions(confirmed);
      if (this.#state.effectiveThinkingOptionId !== command.thinkingOptionId) {
        return err(
          "unavailable",
          `Kimi did not confirm thinking option ${command.thinkingOptionId}`,
        );
      }
      return ok({ completed: true });
    } catch (error) {
      return err(
        "unavailable",
        `Failed to set thinking option: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async #handlePermissionModeSelect(
    command: PermissionModeSelectCommand,
  ): Promise<HarnessResult<PermissionModeSelectCompleted>> {
    if (!isKimiModeId(command.permissionModeId)) {
      return err("unsupported", `Unsupported permission mode: ${command.permissionModeId}`);
    }

    try {
      const confirmed = await this.#transport.setConfigOption("mode", command.permissionModeId);
      this.#applyConfigOptions(confirmed);
      if (this.#state.effectivePermissionModeId !== command.permissionModeId) {
        return err(
          "unavailable",
          `Kimi did not confirm permission mode ${command.permissionModeId}`,
        );
      }
      return ok({ completed: true });
    } catch (error) {
      return err(
        "unavailable",
        `Failed to set permission mode: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
