import { randomUUID } from "node:crypto";

import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import type {
  HarnessAdapter,
  HarnessCommandAccepted,
  HarnessCommandCapability,
  HarnessCommandInvocation,
  HarnessInspection,
  HarnessModelCatalog,
  HarnessModelRef,
  HarnessOutput,
  HarnessResult,
  HarnessSession,
  HarnessSessionCapabilities,
  HarnessSessionState,
  HostAgentMessageItem,
  HostCommand,
  HostContextCompactionItem,
  HostFileChangeItem,
  HostItem,
  HostQuestionResponse,
  HostThreadSnapshot,
  HostUsage,
  InspectHarnessInput,
  InteractionRespondAccepted,
  InteractionRespondCommand,
  ModelSelectCommand,
  ModelSelectCompleted,
  OpenSessionInput,
  PermissionModeSelectCommand,
  PermissionModeSelectCompleted,
  ThinkingSelectCommand,
  ThinkingSelectCompleted,
  TurnCancelAccepted,
  TurnCancelCommand,
  TurnOutcome,
  TurnStartAccepted,
  TurnStartCommand,
} from "@codexhost/harness-adapter";
import {
  HarnessOutputChannel as OutputChannel,
} from "@codexhost/harness-adapter";
import {
  harnessIdSchema,
  harnessModelRefSchema,
  hostItemIdSchema,
  hostTurnIdSchema,
  nativeSessionRefSchema,
  nativeTurnRefSchema,
  type HarnessId,
  type HarnessPermissionModeId,
  type HostInteractionId,
  type HostTurnId,
  type NativeSessionRef,
  type NativeTurnRef,
} from "@codexhost/shared-contracts";

import {
  KiroAcpTransport,
  KiroTransportError,
  type KiroAcpTransportOptions,
  type KiroOpenInput,
  type KiroOpenResult,
  type KiroTransportEvent,
} from "./acp-transport.js";
import { KiroExecutableError, resolveKiroExecutable } from "./command.js";
import { KIRO_COMMAND_CATALOG } from "./commands.js";
import { projectKiroFileChanges } from "./file-diff.js";
import {
  findForkBoundary,
  findRollbackBoundary,
  locateKiroNativeSession,
  parseKiroHistory,
  readKiroNativeMessages,
  readKiroSnapshot,
  type KiroNativeSessionLocation,
} from "./history.js";
import {
  KIRO_DEFAULT_MODEL_CATALOG,
  parseKiroModelCatalog,
} from "./models.js";
import {
  KIRO_DEFAULT_PERMISSION_MODE_ID,
  KIRO_PERMISSION_MODE_CATALOG,
  decodeKiroPermissionMode,
  encodeKiroPermissionMode,
} from "./permission-modes.js";
import {
  projectKiroPermission,
  projectKiroToolCall,
  projectKiroUserInput,
  type KiroUserInputParams,
  type KiroUserInputResult,
} from "./projection.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const KIRO_SESSION_CAPABILITIES: HarnessSessionCapabilities = {
  configuration: {
    selectModel: true,
    selectThinkingOption: false,
    selectPermissionMode: true,
    permissionModeScope: "live",
  },
  history: {
    fork: true,
    forkAcrossCwd: true,
    rollbackLastTurn: true,
  },
  subagents: {
    observe: true,
    readTranscript: false,
  },
  autonomousTurns: {
    observe: false,
  },
};

export interface KiroAcpTransportLike {
  readonly sessionId: string;
  readonly stderrTail?: string | undefined;
  inspect(): Promise<unknown>;
  open(input: KiroOpenInput): Promise<KiroOpenResult>;
  setConfigOption(configId: string, value: string): Promise<unknown>;
  runTurn(
    text: string,
    onEvent: (event: KiroTransportEvent) => void,
    onPermission: (request: RequestPermissionRequest) => Promise<RequestPermissionResponse>,
    onQuestion: (params: KiroUserInputParams) => Promise<KiroUserInputResult>,
  ): Promise<unknown>;
  cancel(): Promise<void>;
  compact(): Promise<unknown>;
  sendExtensionRequest(method: string, params: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

export interface KiroAdapterOptions {
  command?: string | undefined;
  environment?: NodeJS.ProcessEnv | undefined;
  commandTimeoutMs?: number | undefined;
  closeTimeoutMs?: number | undefined;
}

export interface KiroAdapterDependencies {
  createTransport?(options: KiroAcpTransportOptions): KiroAcpTransportLike;
  randomUUID?(): string;
  locateSession?(options: { environment?: NodeJS.ProcessEnv | undefined; homeDirectory?: string | undefined }, sessionId: string): Promise<KiroNativeSessionLocation | null>;
  readSnapshot?(location: KiroNativeSessionLocation): Promise<HostThreadSnapshot>;
  inspectInstallation?(): void;
}

export class KiroAdapter implements HarnessAdapter {
  readonly harnessId: HarnessId = harnessIdSchema.parse("kiro-cli");
  readonly commandCatalog = KIRO_COMMAND_CATALOG;

  readonly #options: KiroAdapterOptions;
  readonly #deps: KiroAdapterDependencies;

  constructor(options: KiroAdapterOptions = {}, deps: KiroAdapterDependencies = {}) {
    this.#options = options;
    this.#deps = deps;
  }

  async inspect(_input: InspectHarnessInput = {}): Promise<HarnessInspection> {
    void _input;
    try {
      if (this.#deps.inspectInstallation) {
        this.#deps.inspectInstallation();
      } else {
        resolveKiroExecutable({
          ...(this.#options.command ? { command: this.#options.command } : {}),
          environment: this.#options.environment ?? process.env,
        });
      }
    } catch (error) {
      if (error instanceof KiroExecutableError) {
        return {
          status: "notInstalled",
          error: {
            code: "notInstalled",
            message: "Kiro CLI is not installed",
            retryable: false,
          },
        };
      }
    }

    const transport = this.#createTransport(process.cwd());
    try {
      const initialize = await transport.inspect();
      let modelCatalog = KIRO_DEFAULT_MODEL_CATALOG;
      if (typeof initialize === "object" && initialize !== null && "configOptions" in initialize) {
        modelCatalog = parseKiroModelCatalog((initialize as { configOptions: unknown }).configOptions);
      }
      return {
        status: "ready",
        catalog: modelCatalog,
        permissionModes: KIRO_PERMISSION_MODE_CATALOG,
        capabilities: KIRO_SESSION_CAPABILITIES,
      };
    } catch (error) {
      if (error instanceof KiroTransportError) {
        if (error.kind === "authenticationRequired") {
          return {
            status: "error",
            error: {
              code: "authenticationRequired",
              message: "Kiro CLI authentication is required",
              retryable: false,
            },
          };
        }
        if (error.kind === "notInstalled") {
          return {
            status: "notInstalled",
            error: {
              code: "notInstalled",
              message: "Kiro CLI is not installed",
              retryable: false,
            },
          };
        }
      }
      return {
        status: "unavailable",
        error: {
          code: "unavailable",
          message: error instanceof Error ? error.message : "Kiro CLI is unavailable",
          retryable: true,
        },
      };
    } finally {
      await transport.close().catch(() => undefined);
    }
  }

  async open(input: OpenSessionInput): Promise<HarnessResult<HarnessSession>> {
    if (input.kind === "create" && input.executionPolicy === "unattended-full-access") {
      return {
        ok: false,
        error: {
          code: "unsupported",
          message: "Kiro CLI does not support unattended-full-access execution policy",
          retryable: false,
        },
      };
    }

    const transport = this.#createTransport(input.cwd);
    const locateSessionFn = this.#deps.locateSession ?? locateKiroNativeSession;
    const readSnapshotFn = this.#deps.readSnapshot ?? readKiroSnapshot;

    let openResult: KiroOpenResult;
    let initialModel: HarnessModelRef =
      input.kind === "create" && input.model
        ? input.model
        : (KIRO_DEFAULT_MODEL_CATALOG.defaultModel ?? { id: "claude-haiku-4.5" as HarnessModelRef["id"] });
    let initialPermissionModeId: HarnessPermissionModeId =
      input.kind === "create" && input.permissionModeId
        ? input.permissionModeId
        : KIRO_DEFAULT_PERMISSION_MODE_ID;

    try {
      if (input.kind === "create") {
        openResult = await transport.open({
          kind: "create",
          modelId: initialModel.id,
          autopilot: decodeKiroPermissionMode(initialPermissionModeId),
        });
      } else if (input.kind === "resume") {
        const sessionId = input.nativeRef.nativeSessionId;
        openResult = await transport.open({
          kind: "resume",
          sessionId,
          autopilot: input.permissionModeId ? decodeKiroPermissionMode(input.permissionModeId) : undefined,
        });
        if (input.permissionModeId) {
          initialPermissionModeId = input.permissionModeId;
        }
      } else if (input.kind === "fork") {
        const sourceSessionId = input.sourceRef.nativeSessionId;
        const location = await locateSessionFn({ environment: this.#options.environment }, sourceSessionId);
        if (!location) {
          await transport.close().catch(() => undefined);
          return {
            ok: false,
            error: {
              code: "sessionNotFound",
              message: `Source session ${sourceSessionId} not found`,
              retryable: false,
            },
          };
        }
        const rows = await readKiroNativeMessages(location.sessionDirectory);
        const summary = parseKiroHistory(rows);
        const checkpointId = findForkBoundary(summary, input.checkpoint.checkpointId);
        if (!checkpointId) {
          await transport.close().catch(() => undefined);
          return {
            ok: false,
            error: {
              code: "checkpointNotFound",
              message: `Checkpoint ${input.checkpoint.checkpointId} not found in source history`,
              retryable: false,
            },
          };
        }

        const sourceModelId = location.sessionMeta.modelId;
        const sourceAutopilot = encodeKiroPermissionMode(location.sessionMeta.autopilot);

        openResult = await transport.open({
          kind: "fork",
          sourceSessionId,
          sourceCwd: location.cwd,
          checkpointMessageId: checkpointId,
          ...(sourceModelId ? { modelId: sourceModelId } : {}),
          autopilot: decodeKiroPermissionMode(sourceAutopilot),
        });

        if (sourceModelId) {
          initialModel = harnessModelRefSchema.parse({ id: sourceModelId });
        }
        initialPermissionModeId = sourceAutopilot;
      } else {
        // rollbackLastTurn
        const sourceSessionId = input.sourceRef.nativeSessionId;
        const location = await locateSessionFn({ environment: this.#options.environment }, sourceSessionId);
        if (!location) {
          await transport.close().catch(() => undefined);
          return {
            ok: false,
            error: {
              code: "sessionNotFound",
              message: `Source session ${sourceSessionId} not found`,
              retryable: false,
            },
          };
        }
        const rows = await readKiroNativeMessages(location.sessionDirectory);
        const summary = parseKiroHistory(rows);
        const rollbackBoundary = findRollbackBoundary(summary);
        if (!rollbackBoundary) {
          await transport.close().catch(() => undefined);
          return {
            ok: false,
            error: {
              code: "unsupported",
              message: "Cannot rollback session: no available prior boundary",
              retryable: false,
            },
          };
        }

        const sourceModelId = location.sessionMeta.modelId;
        const sourceAutopilot = encodeKiroPermissionMode(location.sessionMeta.autopilot);

        openResult = await transport.open({
          kind: "rollbackLastTurn",
          sourceSessionId,
          sourceCwd: location.cwd,
          checkpointMessageId: rollbackBoundary,
          ...(sourceModelId ? { modelId: sourceModelId } : {}),
          autopilot: decodeKiroPermissionMode(sourceAutopilot),
        });

        if (sourceModelId) {
          initialModel = harnessModelRefSchema.parse({ id: sourceModelId });
        }
        initialPermissionModeId = sourceAutopilot;
      }

      const modelCatalog = parseKiroModelCatalog(openResult.configOptions);

      const session = new KiroSession({
        harnessId: this.harnessId,
        transport,
        cwd: input.cwd,
        sessionId: openResult.sessionId,
        modelCatalog,
        initialModel,
        initialPermissionModeId,
        randomUUID: this.#deps.randomUUID ?? randomUUID,
        locateSession: locateSessionFn,
        readSnapshot: readSnapshotFn,
        environment: this.#options.environment,
      });

      return { ok: true, value: session };
    } catch (error) {
      await transport.close().catch(() => undefined);
      if (error instanceof KiroTransportError) {
        return {
          ok: false,
          error: {
            code: error.kind === "checkpointNotFound" ? "checkpointNotFound" : error.kind,
            message: error.message,
            retryable: error.kind === "unavailable",
            ...(error.diagnostic ? { diagnostic: error.diagnostic } : {}),
          },
        };
      }
      return {
        ok: false,
        error: {
          code: "unavailable",
          message: error instanceof Error ? error.message : "Failed to open Kiro session",
          retryable: false,
        },
      };
    }
  }

  async close(): Promise<void> {
    // No shared pool resources
  }

  #createTransport(cwd: string): KiroAcpTransportLike {
    const opts: KiroAcpTransportOptions = {
      cwd,
      ...(this.#options.command ? { command: this.#options.command } : {}),
      ...(this.#options.environment ? { environment: this.#options.environment } : {}),
      ...(this.#options.commandTimeoutMs !== undefined ? { commandTimeoutMs: this.#options.commandTimeoutMs } : {}),
      ...(this.#options.closeTimeoutMs !== undefined ? { closeTimeoutMs: this.#options.closeTimeoutMs } : {}),
    };
    if (this.#deps.createTransport) {
      return this.#deps.createTransport(opts);
    }
    return new KiroAcpTransport(opts);
  }
}

interface KiroSessionOptions {
  harnessId: HarnessId;
  transport: KiroAcpTransportLike;
  cwd: string;
  sessionId: string;
  modelCatalog: HarnessModelCatalog;
  initialModel: HarnessModelRef;
  initialPermissionModeId: HarnessPermissionModeId;
  randomUUID: () => string;
  locateSession: (options: { environment?: NodeJS.ProcessEnv | undefined; homeDirectory?: string | undefined }, sessionId: string) => Promise<KiroNativeSessionLocation | null>;
  readSnapshot: (location: KiroNativeSessionLocation) => Promise<HostThreadSnapshot>;
  environment?: NodeJS.ProcessEnv | undefined;
}

interface PendingApproval {
  type: "approval";
  id: HostInteractionId;
  resolve: (actionId: string, cancelled?: boolean) => void;
}

interface PendingQuestion {
  type: "question";
  id: HostInteractionId;
  resolve: (response: HostQuestionResponse) => void;
}

type PendingInteraction = PendingApproval | PendingQuestion;

export class KiroSession implements HarnessSession {
  readonly harnessId: HarnessId;
  readonly capabilities: HarnessSessionCapabilities = KIRO_SESSION_CAPABILITIES;
  readonly initialState: HarnessSessionState;
  readonly initialUsage: HostUsage | null = null;
  readonly outputs: AsyncIterable<HarnessOutput>;
  readonly commands: HarnessCommandCapability;

  readonly #channel = new OutputChannel<HarnessOutput>();
  readonly #transport: KiroAcpTransportLike;
  readonly #cwd: string;
  readonly #sessionId: string;
  readonly #randomUUID: () => string;
  readonly #locateSession: (options: { environment?: NodeJS.ProcessEnv | undefined; homeDirectory?: string | undefined }, sessionId: string) => Promise<KiroNativeSessionLocation | null>;
  readonly #readSnapshotFn: (location: KiroNativeSessionLocation) => Promise<HostThreadSnapshot>;
  readonly #environment?: NodeJS.ProcessEnv | undefined;

  #activeTurnId: HostTurnId | null = null;
  #currentModel: HarnessModelRef;
  #currentPermissionModeId: HarnessPermissionModeId;
  #modelCatalog: HarnessModelCatalog;
  #pendingInteraction: PendingInteraction | null = null;
  #closed = false;

  constructor(options: KiroSessionOptions) {
    this.harnessId = options.harnessId;
    this.#transport = options.transport;
    this.#cwd = options.cwd;
    this.#sessionId = options.sessionId;
    this.#modelCatalog = options.modelCatalog;
    this.#currentModel = options.initialModel;
    this.#currentPermissionModeId = options.initialPermissionModeId;
    this.#randomUUID = options.randomUUID;
    this.#locateSession = options.locateSession;
    this.#readSnapshotFn = options.readSnapshot;
    this.#environment = options.environment;

    const nativeRef: NativeSessionRef = nativeSessionRefSchema.parse({
      harnessId: this.harnessId,
      nativeSessionId: this.#sessionId,
      formatVersion: 1,
    });

    this.initialState = {
      nativeRef,
      effectiveModel: this.#currentModel,
      effectivePermissionModeId: this.#currentPermissionModeId,
      availableThinkingOptions: [],
    };

    this.outputs = this.#channel.outputs;

    this.commands = {
      list: async () => ({ ok: true, value: KIRO_COMMAND_CATALOG }),
      execute: async (cmd: HarnessCommandInvocation) => this.#executeHarnessCommand(cmd),
    };
  }

  async readSnapshot(): Promise<HarnessResult<HostThreadSnapshot>> {
    try {
      const location = await this.#locateSession({ environment: this.#environment }, this.#sessionId);
      if (!location) {
        return { ok: true, value: { turns: [] } };
      }
      const snapshot = await this.#readSnapshotFn(location);
      return { ok: true, value: snapshot };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "nativeFailure",
          message: error instanceof Error ? error.message : "Failed to read Kiro snapshot",
          retryable: false,
        },
      };
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

    if (command.type === "turn.start") {
      return this.#runTurn(command);
    }
    if (command.type === "turn.cancel") {
      return this.#cancelTurn(command);
    }
    if (command.type === "interaction.respond") {
      return this.#respondInteraction(command);
    }
    if (command.type === "model.select") {
      return this.#selectModel(command);
    }
    if (command.type === "thinking.select") {
      return {
        ok: false,
        error: {
          code: "unsupported",
          message: "Thinking option selection is not supported by Kiro CLI",
          retryable: false,
        },
      };
    }
    if (command.type === "permissionMode.select") {
      return this.#selectPermissionMode(command);
    }

    return {
      ok: false,
      error: { code: "invalidRequest", message: "Unknown command type", retryable: false },
    };
  }

  async #runTurn(command: TurnStartCommand): Promise<HarnessResult<TurnStartAccepted>> {
    if (this.#activeTurnId !== null) {
      return {
        ok: false,
        error: { code: "sessionBusy", message: "Session is busy with another turn", retryable: false },
      };
    }

    const turnId = command.turnId;
    this.#activeTurnId = turnId;

    this.#channel.emit({
      kind: "event",
      event: { type: "turn.started", turnId },
    });

    const userText = command.input.map((i) => i.text).join("\n");
    let agentMessageItem: HostAgentMessageItem | null = null;
    let assignedUserMessageId: string | undefined;

    // Run in background / async
    void (async () => {
      let turnOutcome: TurnOutcome = { status: "succeeded" };
      try {
        const promptResult = await this.#transport.runTurn(
          userText,
          (event: KiroTransportEvent) => {
            if (event.type === "agent.text") {
              if (!agentMessageItem) {
                const itemId = hostItemIdSchema.parse(`agent-${turnId}-${this.#randomUUID()}`);
                agentMessageItem = {
                  type: "agentMessage",
                  itemId,
                  text: "",
                };
                this.#channel.emit({
                  kind: "event",
                  event: {
                    type: "item.started",
                    turnId,
                    item: agentMessageItem,
                  },
                });
              }
              agentMessageItem.text += event.text;
              this.#channel.emit({
                kind: "event",
                event: {
                  type: "item.updated",
                  turnId,
                  itemId: agentMessageItem.itemId,
                  update: { type: "text.append", text: event.text },
                },
              });
            } else if (event.type === "tool.call") {
              const toolItem = projectKiroToolCall(event.callId, {
                toolCallId: event.callId,
                title: event.title,
                name: event.name,
                kind: event.kind,
                status: event.status,
                rawInput: event.rawInput,
                rawOutput: event.rawOutput,
                metadata: event.metadata,
              });
              this.#channel.emit({
                kind: "event",
                event: {
                  type: "item.started",
                  turnId,
                  item: toolItem as HostItem,
                },
              });
            } else if (event.type === "tool.update") {
              const toolItem = projectKiroToolCall(event.callId, {
                toolCallId: event.callId,
                title: event.title,
                name: event.name,
                kind: event.kind,
                status: event.status,
                rawInput: event.rawInput,
                rawOutput: event.rawOutput,
                metadata: event.metadata,
              });
              const changes = projectKiroFileChanges(event.content, this.#cwd);
              if (changes && changes.length > 0) {
                const fileItemId = hostItemIdSchema.parse(`file-${turnId}-${this.#randomUUID()}`);
                const fileItem: HostFileChangeItem = {
                  type: "fileChange",
                  itemId: fileItemId,
                  changes,
                };
                this.#channel.emit({
                  kind: "event",
                  event: {
                    type: "item.started",
                    turnId,
                    item: fileItem,
                  },
                });
                this.#channel.emit({
                  kind: "event",
                  event: {
                    type: "item.completed",
                    turnId,
                    snapshot: {
                      item: fileItem,
                      outcome: { status: "succeeded" },
                    },
                  },
                });
              }

              this.#channel.emit({
                kind: "event",
                event: {
                  type: "item.completed",
                  turnId,
                  snapshot: {
                    item: toolItem as HostItem,
                    outcome: { status: "succeeded" },
                  },
                },
              });
            } else if (event.type === "usage") {
              const meta = event.metadata;
              if (meta && typeof meta.userMessageId === "string") {
                assignedUserMessageId = meta.userMessageId;
              }
            } else if (event.type === "compaction.completed") {
              const compactionItemId = hostItemIdSchema.parse(`compact-${turnId}-${this.#randomUUID()}`);
              const compactionItem: HostContextCompactionItem = {
                type: "contextCompaction",
                itemId: compactionItemId,
              };
              this.#channel.emit({
                kind: "event",
                event: {
                  type: "item.started",
                  turnId,
                  item: compactionItem,
                },
              });
              this.#channel.emit({
                kind: "event",
                event: {
                  type: "item.completed",
                  turnId,
                  snapshot: {
                    item: compactionItem,
                    outcome: { status: "succeeded" },
                  },
                },
              });
            }
          },
          async (request: RequestPermissionRequest) => {
            const interactionId = this.#randomUUID();
            const projected = projectKiroPermission(interactionId, turnId, request);
            this.#channel.emit({
              kind: "interaction",
              interaction: projected.interaction,
            });

            return new Promise<RequestPermissionResponse>((resolve) => {
              this.#pendingInteraction = {
                type: "approval",
                id: projected.interaction.interactionId,
                resolve: (actionId: string, cancelled?: boolean) => {
                  resolve(projected.resolve(actionId, cancelled));
                },
              };
            });
          },
          async (params: KiroUserInputParams) => {
            const interactionId = this.#randomUUID();
            const projected = projectKiroUserInput(interactionId, turnId, params);
            this.#channel.emit({
              kind: "interaction",
              interaction: projected.interaction,
            });

            return new Promise((resolve) => {
              this.#pendingInteraction = {
                type: "question",
                id: projected.interaction.interactionId,
                resolve: (response: HostQuestionResponse) => {
                  resolve(projected.resolve(response));
                },
              };
            });
          },
        );

        if (agentMessageItem) {
          this.#channel.emit({
            kind: "event",
            event: {
              type: "item.completed",
              turnId,
              snapshot: {
                item: agentMessageItem,
                outcome: { status: "succeeded" },
              },
            },
          });
        }

        if (isRecord(promptResult) && promptResult.stopReason === "cancelled") {
          turnOutcome = { status: "cancelled", reason: "User cancelled" };
        } else {
          turnOutcome = { status: "succeeded" };
        }
      } catch (error) {
        turnOutcome = {
          status: "failed",
          error: {
            code: "nativeFailure",
            message: error instanceof Error ? error.message : "Kiro prompt failed",
            retryable: false,
          },
        };
      } finally {
        if (this.#pendingInteraction) {
          const pending = this.#pendingInteraction;
          this.#pendingInteraction = null;
          this.#channel.emit({
            kind: "event",
            event: {
              type: "interaction.closed",
              interactionId: pending.id,
              turnId,
              reason: "cancelled",
            },
          });
        }

        const nativeTurnKey = assignedUserMessageId ?? `turn-${this.#randomUUID()}`;
        const nativeTurnRef: NativeTurnRef = nativeTurnRefSchema.parse({
          harnessId: this.harnessId,
          nativeSessionId: this.#sessionId,
          nativeTurnKey,
          formatVersion: 1,
        });

        this.#channel.emit({
          kind: "event",
          event: {
            type: "turn.completed",
            turnId,
            nativeTurnRef,
            outcome: turnOutcome,
          },
        });

        this.#activeTurnId = null;
      }
    })();

    return { ok: true, value: { turnId } };
  }

  async #cancelTurn(command: TurnCancelCommand): Promise<HarnessResult<TurnCancelAccepted>> {
    if (this.#activeTurnId !== null && this.#activeTurnId === command.turnId) {
      await this.#transport.cancel();
      if (this.#pendingInteraction) {
        const pending = this.#pendingInteraction;
        this.#pendingInteraction = null;
        if (pending.type === "approval") {
          pending.resolve("", true);
        } else {
          pending.resolve({ type: "question", cancelled: true, answers: {} });
        }
        this.#channel.emit({
          kind: "event",
          event: {
            type: "interaction.closed",
            interactionId: pending.id,
            turnId: command.turnId,
            reason: "cancelled",
          },
        });
      }
    }
    return { ok: true, value: { cancellationRequested: true } };
  }

  async #respondInteraction(command: InteractionRespondCommand): Promise<HarnessResult<InteractionRespondAccepted>> {
    if (!this.#pendingInteraction || this.#pendingInteraction.id !== command.interactionId) {
      return {
        ok: false,
        error: { code: "invalidRequest", message: "No matching pending interaction", retryable: false },
      };
    }

    const pending = this.#pendingInteraction;
    this.#pendingInteraction = null;

    if (pending.type === "approval") {
      if (command.response.type !== "approval") {
        return {
          ok: false,
          error: { code: "invalidRequest", message: "Expected approval response", retryable: false },
        };
      }
      pending.resolve(command.response.actionId);
    } else {
      if (command.response.type !== "question") {
        return {
          ok: false,
          error: { code: "invalidRequest", message: "Expected question response", retryable: false },
        };
      }
      pending.resolve(command.response);
    }

    if (this.#activeTurnId) {
      this.#channel.emit({
        kind: "event",
        event: {
          type: "interaction.closed",
          interactionId: command.interactionId,
          turnId: this.#activeTurnId,
          reason: command.response.type === "question" && command.response.cancelled ? "cancelled" : "responded",
        },
      });
    }

    return { ok: true, value: { accepted: true } };
  }

  async #selectModel(command: ModelSelectCommand): Promise<HarnessResult<ModelSelectCompleted>> {
    if (this.#activeTurnId !== null) {
      return {
        ok: false,
        error: { code: "sessionBusy", message: "Cannot change model while turn is active", retryable: false },
      };
    }

    try {
      await this.#transport.setConfigOption("model", command.model.id);
      this.#currentModel = command.model;
      this.#channel.emit({
        kind: "event",
        event: {
          type: "session.state.changed",
          state: { effectiveModel: this.#currentModel },
        },
      });
      return { ok: true, value: { completed: true } };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "nativeFailure",
          message: error instanceof Error ? error.message : "Failed to select model",
          retryable: false,
        },
      };
    }
  }

  async #selectPermissionMode(
    command: PermissionModeSelectCommand,
  ): Promise<HarnessResult<PermissionModeSelectCompleted>> {
    if (this.#activeTurnId !== null) {
      return {
        ok: false,
        error: { code: "sessionBusy", message: "Cannot change permission mode while turn is active", retryable: false },
      };
    }

    try {
      const autopilot = decodeKiroPermissionMode(command.permissionModeId);
      await this.#transport.setConfigOption("autopilot", autopilot);
      this.#currentPermissionModeId = command.permissionModeId;
      this.#channel.emit({
        kind: "event",
        event: {
          type: "session.state.changed",
          state: { effectivePermissionModeId: this.#currentPermissionModeId },
        },
      });
      return { ok: true, value: { completed: true } };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "nativeFailure",
          message: error instanceof Error ? error.message : "Failed to select permission mode",
          retryable: false,
        },
      };
    }
  }

  async #executeHarnessCommand(
    command: HarnessCommandInvocation,
  ): Promise<HarnessResult<HarnessCommandAccepted>> {
    const turnId = command.turnId
      ? hostTurnIdSchema.parse(command.turnId)
      : hostTurnIdSchema.parse(`cmd-${this.#randomUUID()}`);
    this.#channel.emit({
      kind: "event",
      event: { type: "turn.started", turnId },
    });

    try {
      if (command.commandId === "kiro.compact") {
        await this.#transport.compact();
        const compactionItemId = hostItemIdSchema.parse(`compact-${turnId}-${this.#randomUUID()}`);
        const compactionItem: HostContextCompactionItem = {
          type: "contextCompaction",
          itemId: compactionItemId,
        };
        this.#channel.emit({
          kind: "event",
          event: {
            type: "item.started",
            turnId,
            item: compactionItem,
          },
        });
        this.#channel.emit({
          kind: "event",
          event: {
            type: "item.completed",
            turnId,
            snapshot: {
              item: compactionItem,
              outcome: { status: "succeeded" },
            },
          },
        });
      } else if (command.commandId === "kiro.context") {
        await this.#transport.sendExtensionRequest("_kiro/session/context", {
          sessionId: this.#sessionId,
          subcommand: "show",
        });
      } else if (command.commandId === "kiro.usage") {
        await this.#transport.sendExtensionRequest("_kiro/account/getUsage", {
          sessionId: this.#sessionId,
        });
      } else if (command.commandId === "kiro.plan") {
        await this.#transport.sendExtensionRequest("session/set_mode", {
          sessionId: this.#sessionId,
          modeId: "plan",
        });
      } else if (command.commandId === "kiro.spec") {
        await this.#transport.sendExtensionRequest("session/set_mode", {
          sessionId: this.#sessionId,
          modeId: "spec",
        });
      } else if (command.commandId === "kiro.vibe") {
        await this.#transport.sendExtensionRequest("session/set_mode", {
          sessionId: this.#sessionId,
          modeId: "vibe",
        });
      }

      this.#channel.emit({
        kind: "event",
        event: {
          type: "turn.completed",
          turnId,
          outcome: { status: "succeeded" },
        },
      });

      return { ok: true, value: { turnId } };
    } catch (error) {
      this.#channel.emit({
        kind: "event",
        event: {
          type: "turn.completed",
          turnId,
          outcome: {
            status: "failed",
            error: {
              code: "nativeFailure",
              message: error instanceof Error ? error.message : "Command execution failed",
              retryable: false,
            },
          },
        },
      });
      return {
        ok: false,
        error: {
          code: "nativeFailure",
          message: error instanceof Error ? error.message : "Command execution failed",
          retryable: false,
        },
      };
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#pendingInteraction) {
      const pending = this.#pendingInteraction;
      this.#pendingInteraction = null;
      if (pending.type === "approval") {
        pending.resolve("", true);
      } else {
        pending.resolve({ type: "question", cancelled: true, answers: {} });
      }
    }
    this.#channel.end();
    await this.#transport.close();
  }
}
