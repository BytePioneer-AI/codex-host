import { randomUUID } from "node:crypto";

import type { RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";
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
  HostCommand,
  HostContextCompactionItem,
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
  sanitizeDiagnosticTail,
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
import { KiroTurnOutput } from "./turn-output.js";
import {
  findForkBoundary,
  findRollbackBoundary,
  locateKiroNativeSession,
  parseKiroHistory,
  readKiroNativeMessages,
  readKiroSnapshot,
  type KiroNativeSessionLocation,
} from "./history.js";
import { confirmedKiroConfig, kiroConfigValue, parseKiroModelCatalog } from "./models.js";
import {
  KIRO_PERMISSION_MODE_CATALOG,
  decodeKiroPermissionMode,
  encodeKiroPermissionMode,
} from "./permission-modes.js";
import {
  projectKiroPermission,
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
  locateSession?(
    options: { environment?: NodeJS.ProcessEnv | undefined; homeDirectory?: string | undefined },
    sessionId: string,
  ): Promise<KiroNativeSessionLocation | null>;
  readSnapshot?(location: KiroNativeSessionLocation): Promise<HostThreadSnapshot>;
  inspectInstallation?(): void;
}

export class KiroAdapter implements HarnessAdapter {
  readonly harnessId: HarnessId = harnessIdSchema.parse("kiro-cli");
  readonly commandCatalog = KIRO_COMMAND_CATALOG;

  readonly #options: KiroAdapterOptions;
  readonly #deps: KiroAdapterDependencies;
  readonly #sessions = new Set<KiroSession>();

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

    const transport = this.#createTransport(_input.cwd ?? process.cwd());
    try {
      const initialize = await transport.inspect();
      const modelCatalog =
        isRecord(initialize) && isRecord(initialize.catalog)
          ? (initialize.catalog as unknown as HarnessModelCatalog)
          : parseKiroModelCatalog(isRecord(initialize) ? initialize.configOptions : undefined);
      if (modelCatalog.models.length === 0)
        throw new Error("Kiro returned no native model catalog");
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

    const environment = { ...this.#options.environment, ...input.environment };
    let session: KiroSession | undefined;
    const transport = this.#createTransport(input.cwd, environment, (error) =>
      session?.fault(error),
    );
    const locateSessionFn = this.#deps.locateSession ?? locateKiroNativeSession;
    const readSnapshotFn = this.#deps.readSnapshot ?? readKiroSnapshot;

    let openResult: KiroOpenResult;
    let initialModel: HarnessModelRef | undefined;
    let initialPermissionModeId: HarnessPermissionModeId | undefined;

    try {
      if (input.kind === "create") {
        openResult = await transport.open({
          kind: "create",
          ...(input.model ? { modelId: input.model.id } : {}),
          ...(input.permissionModeId
            ? { autopilot: decodeKiroPermissionMode(input.permissionModeId) }
            : {}),
        });
      } else if (input.kind === "resume") {
        const sessionId = input.nativeRef.nativeSessionId;
        openResult = await transport.open({
          kind: "resume",
          sessionId,
          autopilot: input.permissionModeId
            ? decodeKiroPermissionMode(input.permissionModeId)
            : undefined,
        });
        if (input.permissionModeId) {
          initialPermissionModeId = input.permissionModeId;
        }
      } else if (input.kind === "fork") {
        const sourceSessionId = input.sourceRef.nativeSessionId;
        const location = await locateSessionFn({ environment }, sourceSessionId);
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
        const location = await locateSessionFn({ environment }, sourceSessionId);
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
      const modelId = kiroConfigValue(openResult.configOptions, "model");
      const autopilot = kiroConfigValue(openResult.configOptions, "autopilot");
      initialModel = modelId ? harnessModelRefSchema.parse({ id: modelId }) : undefined;
      initialPermissionModeId =
        autopilot === "on" || autopilot === "off" ? encodeKiroPermissionMode(autopilot) : undefined;
      if (input.kind === "create" && input.model && initialModel?.id !== input.model.id) {
        throw new Error("Kiro did not confirm the requested initial model");
      }
      if (
        (input.kind === "create" || input.kind === "resume") &&
        input.permissionModeId &&
        initialPermissionModeId !== input.permissionModeId
      ) {
        throw new Error("Kiro did not confirm the requested initial permission mode");
      }

      session = new KiroSession({
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
        environment,
        onClose: () => {
          if (session) this.#sessions.delete(session);
        },
      });

      this.#sessions.add(session);
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
    await Promise.all([...this.#sessions].map((session) => session.close()));
  }

  #createTransport(
    cwd: string,
    environment = this.#options.environment,
    onFault?: (error: KiroTransportError) => void,
  ): KiroAcpTransportLike {
    const opts: KiroAcpTransportOptions = {
      cwd,
      ...(this.#options.command ? { command: this.#options.command } : {}),
      ...(environment ? { environment } : {}),
      ...(onFault ? { onFault } : {}),
      ...(this.#options.commandTimeoutMs !== undefined
        ? { commandTimeoutMs: this.#options.commandTimeoutMs }
        : {}),
      ...(this.#options.closeTimeoutMs !== undefined
        ? { closeTimeoutMs: this.#options.closeTimeoutMs }
        : {}),
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
  initialModel: HarnessModelRef | undefined;
  initialPermissionModeId: HarnessPermissionModeId | undefined;
  onClose?: () => void;
  randomUUID: () => string;
  locateSession: (
    options: { environment?: NodeJS.ProcessEnv | undefined; homeDirectory?: string | undefined },
    sessionId: string,
  ) => Promise<KiroNativeSessionLocation | null>;
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
  readonly #locateSession: (
    options: { environment?: NodeJS.ProcessEnv | undefined; homeDirectory?: string | undefined },
    sessionId: string,
  ) => Promise<KiroNativeSessionLocation | null>;
  readonly #readSnapshotFn: (location: KiroNativeSessionLocation) => Promise<HostThreadSnapshot>;
  readonly #environment?: NodeJS.ProcessEnv | undefined;

  #activeTurnId: HostTurnId | null = null;
  #currentModel: HarnessModelRef | undefined;
  #currentPermissionModeId: HarnessPermissionModeId | undefined;
  #modelCatalog: HarnessModelCatalog;
  #pendingInteraction: PendingInteraction | null = null;
  #closed = false;
  #activeTask: Promise<void> | null = null;
  #stopTurn: (() => void) | null = null;
  #closeTask: Promise<void> | null = null;
  #faultError: KiroTransportError | null = null;
  #configBusy = false;
  readonly #onClose: (() => void) | undefined;

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
    this.#onClose = options.onClose;

    const nativeRef: NativeSessionRef = nativeSessionRefSchema.parse({
      harnessId: this.harnessId,
      nativeSessionId: this.#sessionId,
      formatVersion: 1,
    });

    this.initialState = {
      nativeRef,
      ...(this.#currentModel ? { effectiveModel: this.#currentModel } : {}),
      ...(this.#currentPermissionModeId
        ? { effectivePermissionModeId: this.#currentPermissionModeId }
        : {}),
      availableThinkingOptions: [],
    };

    this.outputs = this.#channel.outputs;

    this.commands = {
      list: async () => ({ ok: true, value: KIRO_COMMAND_CATALOG }),
      execute: async (cmd: HarnessCommandInvocation) => this.#executeHarnessCommand(cmd),
    };
  }

  async readSnapshot(): Promise<HarnessResult<HostThreadSnapshot>> {
    if (this.#activeTurnId !== null || this.#configBusy) {
      return {
        ok: false,
        error: { code: "sessionBusy", message: "Kiro is writing history", retryable: true },
      };
    }
    try {
      const location = await this.#locateSession(
        { environment: this.#environment },
        this.#sessionId,
      );
      if (!location) {
        return {
          ok: false,
          error: {
            code: "sessionNotFound",
            message: "Kiro history was not found",
            retryable: false,
          },
        };
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
    if (this.#activeTurnId !== null || this.#configBusy) {
      return {
        ok: false,
        error: {
          code: "sessionBusy",
          message: "Session is busy with another turn",
          retryable: false,
        },
      };
    }

    const turnId = command.turnId;
    this.#activeTurnId = turnId;

    this.#channel.emit({
      kind: "event",
      event: { type: "turn.started", turnId },
    });

    const userText = command.input.map((i) => i.text).join("\n");
    const output = new KiroTurnOutput(turnId, this.#cwd, (event) => this.#channel.emit(event));
    let assignedUserMessageId: string | undefined;
    const stopped = new Promise<never>((_resolve, reject) => {
      this.#stopTurn = () => reject(this.#faultError ?? new Error("Session closed"));
    });

    this.#activeTask = (async () => {
      let turnOutcome: TurnOutcome = { status: "succeeded" };
      try {
        const promptResult = await Promise.race([
          stopped,
          this.#transport.runTurn(
            userText,
            (event: KiroTransportEvent) => {
              if (this.#closed || this.#activeTurnId !== turnId) return;
              output.accept(event);
              if (event.type === "usage") {
                const meta = event.metadata?.kiro;
                if (
                  isRecord(meta) &&
                  meta.kind === "user_message_id_assigned" &&
                  typeof meta.userMessageId === "string"
                ) {
                  assignedUserMessageId = meta.userMessageId;
                }
              } else if (event.type === "compaction.completed") {
                const compactionItemId = hostItemIdSchema.parse(
                  `compact-${turnId}-${this.#randomUUID()}`,
                );
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
              if (this.#closed || this.#activeTurnId !== turnId)
                return { outcome: { outcome: "cancelled" } };
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
              if (this.#closed || this.#activeTurnId !== turnId) return { action: "dismissed" };
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
          ),
        ]);

        if (isRecord(promptResult) && promptResult.stopReason === "cancelled") {
          turnOutcome = { status: "cancelled", reason: "User cancelled" };
        } else {
          turnOutcome = { status: "succeeded" };
        }
      } catch (error) {
        turnOutcome =
          this.#closed && !this.#faultError
            ? { status: "cancelled", reason: "Session closed" }
            : {
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
          if (pending.type === "approval") pending.resolve("", true);
          else pending.resolve({ type: "question", cancelled: true, answers: {} });
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

        output.finish(turnOutcome);
        const nativeTurnRef = assignedUserMessageId
          ? nativeTurnRefSchema.parse({
              harnessId: this.harnessId,
              nativeSessionId: this.#sessionId,
              nativeTurnKey: assignedUserMessageId,
              formatVersion: 1,
            })
          : undefined;

        this.#channel.emit({
          kind: "event",
          event: {
            type: "turn.completed",
            turnId,
            ...(nativeTurnRef ? { nativeTurnRef } : {}),
            outcome: turnOutcome,
          },
        });

        this.#activeTurnId = null;
        this.#stopTurn = null;
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

  async #respondInteraction(
    command: InteractionRespondCommand,
  ): Promise<HarnessResult<InteractionRespondAccepted>> {
    if (!this.#pendingInteraction || this.#pendingInteraction.id !== command.interactionId) {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "No matching pending interaction",
          retryable: false,
        },
      };
    }

    const pending = this.#pendingInteraction;

    if (pending.type === "approval") {
      if (command.response.type !== "approval") {
        return {
          ok: false,
          error: {
            code: "invalidRequest",
            message: "Expected approval response",
            retryable: false,
          },
        };
      }
      this.#pendingInteraction = null;
      pending.resolve(command.response.actionId);
    } else {
      if (command.response.type !== "question") {
        return {
          ok: false,
          error: {
            code: "invalidRequest",
            message: "Expected question response",
            retryable: false,
          },
        };
      }
      this.#pendingInteraction = null;
      pending.resolve(command.response);
    }

    if (this.#activeTurnId) {
      this.#channel.emit({
        kind: "event",
        event: {
          type: "interaction.closed",
          interactionId: command.interactionId,
          turnId: this.#activeTurnId,
          reason:
            command.response.type === "question" && command.response.cancelled
              ? "cancelled"
              : "responded",
        },
      });
    }

    return { ok: true, value: { accepted: true } };
  }

  async #selectModel(command: ModelSelectCommand): Promise<HarnessResult<ModelSelectCompleted>> {
    if (this.#activeTurnId !== null || this.#configBusy) {
      return {
        ok: false,
        error: {
          code: "sessionBusy",
          message: "Cannot change model while turn is active",
          retryable: false,
        },
      };
    }

    this.#configBusy = true;
    try {
      const result = await this.#transport.setConfigOption("model", command.model.id);
      const options = confirmedKiroConfig(result, "model", command.model.id);
      this.#updateConfig(options);
      this.#channel.emit({
        kind: "event",
        event: {
          type: "session.state.changed",
          state: this.#state(),
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
    } finally {
      this.#configBusy = false;
    }
  }

  async #selectPermissionMode(
    command: PermissionModeSelectCommand,
  ): Promise<HarnessResult<PermissionModeSelectCompleted>> {
    if (this.#activeTurnId !== null || this.#configBusy) {
      return {
        ok: false,
        error: {
          code: "sessionBusy",
          message: "Cannot change permission mode while turn is active",
          retryable: false,
        },
      };
    }

    this.#configBusy = true;
    try {
      const autopilot = decodeKiroPermissionMode(command.permissionModeId);
      const result = await this.#transport.setConfigOption("autopilot", autopilot);
      this.#updateConfig(confirmedKiroConfig(result, "autopilot", autopilot));
      this.#channel.emit({
        kind: "event",
        event: {
          type: "session.state.changed",
          state: this.#state(),
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
    } finally {
      this.#configBusy = false;
    }
  }

  #updateConfig(options: unknown[]): void {
    if (this.#closed) throw new Error("Session closed during configuration");
    const model = kiroConfigValue(options, "model");
    const autopilot = kiroConfigValue(options, "autopilot");
    this.#currentModel = model ? harnessModelRefSchema.parse({ id: model }) : undefined;
    this.#currentPermissionModeId =
      autopilot === "on" || autopilot === "off" ? encodeKiroPermissionMode(autopilot) : undefined;
    this.#modelCatalog = parseKiroModelCatalog(options);
  }

  #state(): HarnessSessionState {
    return {
      ...(this.initialState.nativeRef ? { nativeRef: this.initialState.nativeRef } : {}),
      ...(this.#currentModel ? { effectiveModel: this.#currentModel } : {}),
      ...(this.#currentPermissionModeId
        ? { effectivePermissionModeId: this.#currentPermissionModeId }
        : {}),
      availableThinkingOptions: [],
    };
  }

  async #executeHarnessCommand(
    command: HarnessCommandInvocation,
  ): Promise<HarnessResult<HarnessCommandAccepted>> {
    if (this.#closed)
      return {
        ok: false,
        error: { code: "invalidState", message: "Session is closed", retryable: false },
      };
    if (this.#activeTurnId !== null || this.#configBusy)
      return {
        ok: false,
        error: { code: "sessionBusy", message: "Session is busy", retryable: true },
      };
    if (
      !KIRO_COMMAND_CATALOG.commands.some((entry) => entry.id === command.commandId) ||
      Object.keys(command.arguments ?? {}).length > 0
    ) {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "Unknown command or unsupported arguments",
          retryable: false,
        },
      };
    }
    const turnId = command.turnId
      ? hostTurnIdSchema.parse(command.turnId)
      : hostTurnIdSchema.parse(`cmd-${this.#randomUUID()}`);
    this.#channel.emit({
      kind: "event",
      event: { type: "turn.started", turnId },
    });
    this.#activeTurnId = turnId;
    const stopped = new Promise<never>((_resolve, reject) => {
      this.#stopTurn = () => reject(this.#faultError ?? new Error("Session closed"));
    });
    const execute = async (): Promise<HarnessResult<HarnessCommandAccepted>> => {
      try {
        let result: unknown;
        if (command.commandId === "kiro.compact") {
          await Promise.race([stopped, this.#transport.compact()]);
          const compactionItemId = hostItemIdSchema.parse(
            `compact-${turnId}-${this.#randomUUID()}`,
          );
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
          result = await Promise.race([
            stopped,
            this.#transport.sendExtensionRequest("_kiro/session/context", {
              sessionId: this.#sessionId,
              subcommand: "show",
            }),
          ]);
        } else if (command.commandId === "kiro.usage") {
          result = await Promise.race([
            stopped,
            this.#transport.sendExtensionRequest("_kiro/account/getUsage", {
              sessionId: this.#sessionId,
            }),
          ]);
        } else if (command.commandId === "kiro.plan") {
          await Promise.race([
            stopped,
            this.#transport.sendExtensionRequest("session/set_mode", {
              sessionId: this.#sessionId,
              modeId: "plan",
            }),
          ]);
        } else if (command.commandId === "kiro.spec") {
          await Promise.race([
            stopped,
            this.#transport.sendExtensionRequest("session/set_mode", {
              sessionId: this.#sessionId,
              modeId: "spec",
            }),
          ]);
        } else if (command.commandId === "kiro.vibe") {
          await Promise.race([
            stopped,
            this.#transport.sendExtensionRequest("session/set_mode", {
              sessionId: this.#sessionId,
              modeId: "vibe",
            }),
          ]);
        }

        if (result !== undefined) {
          const item = {
            type: "agentMessage" as const,
            itemId: hostItemIdSchema.parse(`query-${turnId}`),
            text: sanitizeDiagnosticTail(
              JSON.stringify(
                result,
                (key, value: unknown) =>
                  /token|password|secret|authorization|api.?key/iu.test(key) ? "[redacted]" : value,
                2,
              ),
            ),
          };
          this.#channel.emit({ kind: "event", event: { type: "item.started", turnId, item } });
          this.#channel.emit({
            kind: "event",
            event: {
              type: "item.completed",
              turnId,
              snapshot: { item, outcome: { status: "succeeded" } },
            },
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
            outcome:
              this.#closed && !this.#faultError
                ? { status: "cancelled", reason: "Session closed" }
                : {
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
      } finally {
        this.#activeTurnId = null;
        this.#stopTurn = null;
      }
    };
    const task = execute();
    this.#activeTask = task.then(() => undefined);
    return task;
  }

  fault(error: KiroTransportError): void {
    if (this.#closed) return;
    this.#faultError = error;
    void this.close().catch(() => undefined);
  }

  close(): Promise<void> {
    if (this.#closeTask) return this.#closeTask;
    this.#closed = true;
    this.#stopTurn?.();
    this.#closeTask = (async () => {
      try {
        await this.#activeTask;
        if (this.#faultError) {
          this.#channel.emit({
            kind: "event",
            event: {
              type: "session.faulted",
              error: {
                code: this.#faultError.kind,
                message: this.#faultError.message,
                retryable: false,
              },
            },
          });
        }
        await this.#transport.close();
      } finally {
        this.#channel.end();
        this.#onClose?.();
      }
    })();
    return this.#closeTask;
  }
}
