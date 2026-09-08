import { randomUUID } from "node:crypto";
import path from "node:path";

import type { RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";
import type {
  HarnessAdapter,
  HarnessCommandAccepted,
  HarnessCommandCapability,
  HarnessCommandInvocation,
  HarnessError,
  HarnessInspection,
  HarnessModelCatalog,
  HarnessModelRef,
  HarnessOutput,
  HarnessResult,
  HarnessSession,
  HarnessSessionCapabilities,
  HarnessSessionState,
  HostCommand,
  HostApprovalInteraction,
  HostContextCompactionItem,
  HostQuestionResponse,
  HostQuestionInteraction,
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
  validateHostApprovalResponse,
  validateHostQuestionResponse,
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
import { KIRO_COMMAND_CATALOG, formatKiroCommandResult } from "./commands.js";
import { KiroTurnOutput } from "./turn-output.js";
import { KiroUsage } from "./usage.js";
import {
  findForkBoundary,
  findRollbackBoundary,
  locateKiroNativeSession,
  parseKiroHistory,
  readKiroNativeMessages,
  readKiroSessionMessages,
  readKiroSnapshot,
  type KiroNativeSessionLocation,
} from "./history.js";
import {
  confirmedKiroConfig,
  kiroConfigValue,
  kiroThinkingState,
  parseKiroModelCatalog,
} from "./models.js";
import {
  KIRO_PERMISSION_MODE_CATALOG,
  decodeKiroPermissionMode,
  encodeKiroPermissionMode,
} from "./permission-modes.js";
import {
  projectKiroPermission,
  projectKiroRequirementQuestion,
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
    selectThinkingOption: true,
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
  readonly #inspectionCache = new Map<
    string,
    { result: Extract<HarnessInspection, { status: "ready" }>; refreshAfter: number }
  >();
  readonly #inspectionInFlight = new Map<string, Promise<HarnessInspection>>();

  constructor(options: KiroAdapterOptions = {}, deps: KiroAdapterDependencies = {}) {
    this.#options = options;
    this.#deps = deps;
  }

  async inspect(input: InspectHarnessInput = {}): Promise<HarnessInspection> {
    const cwd = path.resolve(input.cwd ?? process.cwd());
    const cached = this.#inspectionCache.get(cwd);
    if (!input.refresh && cached) {
      if (cached.refreshAfter <= Date.now()) {
        void this.#refreshInspection(cwd).catch(() => undefined);
      }
      return cached.result;
    }
    return this.#refreshInspection(cwd);
  }

  #refreshInspection(cwd: string): Promise<HarnessInspection> {
    const inFlight = this.#inspectionInFlight.get(cwd);
    if (inFlight) return inFlight;
    const cached = this.#inspectionCache.get(cwd);
    if (cached) cached.refreshAfter = Date.now() + 5 * 60_000;

    const inspection = this.#inspectCwd(cwd)
      .then((result) => {
        if (result.status === "ready") {
          const now = Date.now();
          const date = new Date(now);
          const nextMonth = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
          // ponytail: daily/month-boundary revalidation is demand-driven, not a polling timer.
          this.#inspectionCache.set(cwd, {
            result,
            refreshAfter: Math.min(now + 24 * 60 * 60_000, nextMonth),
          });
        } else if (
          result.status === "notInstalled" ||
          result.error.code === "authenticationRequired"
        ) {
          this.#inspectionCache.delete(cwd);
        }
        return result;
      })
      .finally(() => {
        this.#inspectionInFlight.delete(cwd);
      });
    this.#inspectionInFlight.set(cwd, inspection);
    return inspection;
  }

  async #inspectCwd(cwd: string): Promise<HarnessInspection> {
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

    const transport = this.#createTransport(cwd);
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
    const usage = new KiroUsage();
    const transport = this.#createTransport(
      input.cwd,
      environment,
      (error) => session?.fault(error),
      (event) => {
        if (session) session.observeUsage(event);
        else usage.observe(event.metadata?.kiro);
      },
    );
    const locateSessionFn = this.#deps.locateSession ?? locateKiroNativeSession;
    const readSnapshotFn = this.#deps.readSnapshot ?? readKiroSnapshot;

    let openResult: KiroOpenResult;
    let createdEmptySession = input.kind === "create";
    let initialModel: HarnessModelRef | undefined;
    let initialPermissionModeId: HarnessPermissionModeId | undefined;

    try {
      if (input.kind === "create") {
        openResult = await transport.open({
          kind: "create",
          ...(input.model ? { modelId: input.model.id } : {}),
          ...(input.thinkingOptionId ? { effortLevel: input.thinkingOptionId } : {}),
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
        const rows = await readKiroSessionMessages(location);
        const summary = parseKiroHistory(rows);
        const checkpointId = findForkBoundary(summary, input.checkpoint.checkpointId);
        if (!checkpointId) {
          await transport.close().catch(() => undefined);
          return {
            ok: false,
            error: {
              code: "checkpointNotFound",
              message:
                "This Kiro history position is no longer forkable after compaction or rewind. Fork from the latest retained position.",
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
          ...(location.sessionMeta.effortLevel && sourceModelId !== "auto"
            ? { effortLevel: location.sessionMeta.effortLevel }
            : {}),
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
        const rows = await readKiroSessionMessages(location);
        const summary = parseKiroHistory(rows);
        const rollbackBoundary = findRollbackBoundary(summary);
        if (!rollbackBoundary && summary.turns.length !== 1) {
          await transport.close().catch(() => undefined);
          return {
            ok: false,
            error: {
              code: "unsupported",
              message:
                "Kiro cannot edit this message because the preceding history boundary was removed by compaction.",
              retryable: false,
            },
          };
        }

        const sourceModelId = location.sessionMeta.modelId;
        const sourceAutopilot = encodeKiroPermissionMode(location.sessionMeta.autopilot);

        // Removing the sole Turn needs an empty Session, even when compaction removed its bootstrap.
        createdEmptySession = !rollbackBoundary;
        openResult = await transport.open({
          ...(rollbackBoundary
            ? {
                kind: "rollbackLastTurn" as const,
                sourceSessionId,
                sourceCwd: location.cwd,
                checkpointMessageId: rollbackBoundary,
              }
            : {
                kind: "create" as const,
                ...(location.sessionMeta.agentMode
                  ? { modeId: location.sessionMeta.agentMode }
                  : {}),
              }),
          ...(sourceModelId ? { modelId: sourceModelId } : {}),
          ...(location.sessionMeta.effortLevel && sourceModelId !== "auto"
            ? { effortLevel: location.sessionMeta.effortLevel }
            : {}),
          autopilot: decodeKiroPermissionMode(sourceAutopilot),
        });

        if (sourceModelId) {
          initialModel = harnessModelRefSchema.parse({ id: sourceModelId });
        }
        initialPermissionModeId = sourceAutopilot;
      }

      const modelCatalog = parseKiroModelCatalog(openResult.configOptions);
      const thinking = kiroThinkingState(openResult.configOptions);
      const modelId = kiroConfigValue(openResult.configOptions, "model");
      const autopilot = kiroConfigValue(openResult.configOptions, "autopilot");
      initialModel = modelId ? harnessModelRefSchema.parse({ id: modelId }) : undefined;
      initialPermissionModeId =
        autopilot === "on" || autopilot === "off" ? encodeKiroPermissionMode(autopilot) : undefined;
      if (input.kind === "create" && input.model && initialModel?.id !== input.model.id) {
        throw new Error("Kiro did not confirm the requested initial model");
      }
      if (
        input.kind === "create" &&
        input.thinkingOptionId &&
        thinking.effectiveThinkingOptionId !== input.thinkingOptionId
      ) {
        throw new KiroTransportError(
          "invalidRequest",
          "Kiro did not confirm the requested effort level",
        );
      }
      if (
        (input.kind === "create" || input.kind === "resume") &&
        input.permissionModeId &&
        initialPermissionModeId !== input.permissionModeId
      ) {
        throw new Error("Kiro did not confirm the requested initial permission mode");
      }

      try {
        const location = await locateSessionFn({ environment }, openResult.sessionId);
        if (location) usage.load(await readKiroNativeMessages(location.sessionDirectory));
      } catch {
        // Usage is optional; an unreadable ledger must not prevent opening a writable Session.
      }
      for (const event of openResult.replay ?? []) {
        if (event.type === "usage") usage.observe(event.metadata?.kiro);
      }
      session = new KiroSession({
        harnessId: this.harnessId,
        transport,
        cwd: input.cwd,
        sessionId: openResult.sessionId,
        modelCatalog,
        thinking,
        createdEmptySession,
        usage,
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
    try {
      await Promise.all([
        ...this.#inspectionInFlight.values(),
        ...[...this.#sessions].map((session) => session.close()),
      ]);
    } finally {
      this.#inspectionCache.clear();
    }
  }

  #createTransport(
    cwd: string,
    environment = this.#options.environment,
    onFault?: (error: KiroTransportError) => void,
    onUsage?: (event: Extract<KiroTransportEvent, { type: "usage" }>) => void,
  ): KiroAcpTransportLike {
    const opts: KiroAcpTransportOptions = {
      cwd,
      ...(this.#options.command ? { command: this.#options.command } : {}),
      ...(environment ? { environment } : {}),
      ...(onFault ? { onFault } : {}),
      ...(onUsage ? { onUsage } : {}),
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
  usage?: KiroUsage;
  createdEmptySession?: boolean;
  thinking?: Pick<HarnessSessionState, "effectiveThinkingOptionId" | "availableThinkingOptions">;
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
  interaction: HostApprovalInteraction;
  resolve: (actionId: string, cancelled?: boolean) => void;
}

interface PendingQuestion {
  type: "question";
  id: HostInteractionId;
  interaction: HostQuestionInteraction;
  resolve: (response: HostQuestionResponse) => void;
}

type PendingInteraction = PendingApproval | PendingQuestion;

export class KiroSession implements HarnessSession {
  readonly harnessId: HarnessId;
  readonly capabilities: HarnessSessionCapabilities = KIRO_SESSION_CAPABILITIES;
  readonly initialState: HarnessSessionState;
  readonly initialUsage: HostUsage | null;
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
  #thinking: Pick<HarnessSessionState, "effectiveThinkingOptionId" | "availableThinkingOptions">;
  #modelCatalog: HarnessModelCatalog;
  readonly #pendingInteractions = new Map<HostInteractionId, PendingInteraction>();
  #closed = false;
  #activeTask: Promise<void> | null = null;
  #stopTurn: (() => void) | null = null;
  #closeTask: Promise<void> | null = null;
  #faultError: KiroTransportError | null = null;
  #configBusy = false;
  readonly #onClose: (() => void) | undefined;
  readonly #usage: KiroUsage;
  #publishedUsage: string;
  #usageRefresh: Promise<void> | null = null;
  #newSessionWithoutTurn: boolean;

  constructor(options: KiroSessionOptions) {
    this.harnessId = options.harnessId;
    this.#transport = options.transport;
    this.#cwd = options.cwd;
    this.#sessionId = options.sessionId;
    this.#modelCatalog = options.modelCatalog;
    this.#currentModel = options.initialModel;
    this.#currentPermissionModeId = options.initialPermissionModeId;
    this.#thinking = options.thinking ?? { availableThinkingOptions: [] };
    this.#randomUUID = options.randomUUID;
    this.#locateSession = options.locateSession;
    this.#readSnapshotFn = options.readSnapshot;
    this.#environment = options.environment;
    this.#onClose = options.onClose;
    this.#usage = options.usage ?? new KiroUsage();
    this.#newSessionWithoutTurn = options.createdEmptySession ?? false;
    this.initialUsage = this.#usage.snapshot();
    this.#publishedUsage = JSON.stringify(this.initialUsage);

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
      ...this.#thinking,
    };

    this.outputs = this.#channel.outputs;

    this.commands = {
      list: async () => ({ ok: true, value: KIRO_COMMAND_CATALOG }),
      execute: async (cmd: HarnessCommandInvocation) => this.#executeHarnessCommand(cmd),
    };
  }

  observeUsage(event: Extract<KiroTransportEvent, { type: "usage" }>): void {
    if (this.#closed) return;
    this.#usage.observe(event.metadata?.kiro);
    this.#publishUsage();
  }

  #publishUsage(): void {
    if (this.#closed) return;
    const usage = this.#usage.snapshot();
    const serialized = JSON.stringify(usage);
    if (serialized === this.#publishedUsage) return;
    this.#publishedUsage = serialized;
    this.#channel.emit({ kind: "event", event: { type: "session.usage.changed", usage } });
  }

  refreshUsage(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    if (this.#usageRefresh) return this.#usageRefresh;
    this.#usageRefresh = (async () => {
      try {
        const location = await this.#locateSession(
          { environment: this.#environment },
          this.#sessionId,
        );
        if (location) this.#usage.load(await readKiroNativeMessages(location.sessionDirectory));
      } catch {
        /* Keep known usage when optional history is unavailable. */
      }
      this.#publishUsage();
      if (!this.#closed && this.#activeTurnId === null && !this.#configBusy) {
        try {
          const result = await this.#transport.sendExtensionRequest("_kiro/session/context", {
            sessionId: this.#sessionId,
            subcommand: "show",
          });
          if (!this.#closed) this.#usage.context(result);
        } catch {
          /* A Usage refresh must not fault a working Session. */
        }
        this.#publishUsage();
      }
    })().finally(() => {
      this.#usageRefresh = null;
    });
    return this.#usageRefresh;
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
      return {
        ok: true,
        value: {
          ...snapshot,
          state: {
            ...this.#state(),
            ...(snapshot.state?.nativeRef ? { nativeRef: snapshot.state.nativeRef } : {}),
          },
        },
      };
    } catch (error) {
      if (this.#newSessionWithoutTurn && isRecord(error) && error.code === "ENOENT") {
        return { ok: true, value: { turns: [], state: this.#state() } };
      }
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
      return this.#selectThinking(command);
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
    this.#newSessionWithoutTurn = false;
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
                this.observeUsage(event);
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
                      outcome:
                        event.outcome === "succeeded"
                          ? { status: "succeeded" }
                          : {
                              status: "failed",
                              error: {
                                code: "nativeFailure",
                                message: "Kiro context compaction failed",
                                retryable: false,
                              },
                            },
                    },
                  },
                });
              }
            },
            async (request: RequestPermissionRequest) => {
              if (this.#closed || this.#activeTurnId !== turnId)
                return { outcome: { outcome: "cancelled" } };
              const interactionId = this.#randomUUID();
              const question = projectKiroRequirementQuestion(interactionId, turnId, request);
              if (question) {
                return new Promise<RequestPermissionResponse>((resolve) => {
                  this.#pendingInteractions.set(question.interaction.interactionId, {
                    type: "question",
                    id: question.interaction.interactionId,
                    interaction: question.interaction,
                    resolve: (response) => resolve(question.resolve(response)),
                  });
                  this.#channel.emit({ kind: "interaction", interaction: question.interaction });
                });
              }
              const projected = projectKiroPermission(interactionId, turnId, request);
              return new Promise<RequestPermissionResponse>((resolve) => {
                this.#pendingInteractions.set(projected.interaction.interactionId, {
                  type: "approval",
                  id: projected.interaction.interactionId,
                  interaction: projected.interaction,
                  resolve: (actionId: string, cancelled?: boolean) => {
                    resolve(projected.resolve(actionId, cancelled));
                  },
                });
                this.#channel.emit({ kind: "interaction", interaction: projected.interaction });
              });
            },
            async (params: KiroUserInputParams) => {
              if (this.#closed || this.#activeTurnId !== turnId) return { action: "dismissed" };
              const interactionId = this.#randomUUID();
              const projected = projectKiroUserInput(interactionId, turnId, params);
              return new Promise((resolve) => {
                this.#pendingInteractions.set(projected.interaction.interactionId, {
                  type: "question",
                  id: projected.interaction.interactionId,
                  interaction: projected.interaction,
                  resolve: (response: HostQuestionResponse) => {
                    resolve(projected.resolve(response));
                  },
                });
                this.#channel.emit({ kind: "interaction", interaction: projected.interaction });
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
        this.#cancelInteractions(turnId);

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
        if (!this.#closed) void this.refreshUsage();
      }
    })();

    return { ok: true, value: { turnId } };
  }

  async #cancelTurn(command: TurnCancelCommand): Promise<HarnessResult<TurnCancelAccepted>> {
    if (this.#activeTurnId !== null && this.#activeTurnId === command.turnId) {
      await this.#transport.cancel();
      // The native cancellation notification can settle the Prompt before it returns.
      if (this.#activeTurnId === command.turnId) this.#cancelInteractions(command.turnId);
    }
    return { ok: true, value: { cancellationRequested: true } };
  }

  #cancelInteractions(turnId: HostTurnId): void {
    const interactions = [...this.#pendingInteractions.values()];
    this.#pendingInteractions.clear();
    for (const pending of interactions) {
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
  }

  async #respondInteraction(
    command: InteractionRespondCommand,
  ): Promise<HarnessResult<InteractionRespondAccepted>> {
    const pending = this.#pendingInteractions.get(command.interactionId);
    if (!pending) {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "No matching pending interaction",
          retryable: false,
        },
      };
    }

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
      const error = validateHostApprovalResponse(pending.interaction, command.response);
      if (error) return { ok: false, error };
      this.#pendingInteractions.delete(command.interactionId);
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
      const error = validateHostQuestionResponse(pending.interaction, command.response);
      if (error) return { ok: false, error };
      this.#pendingInteractions.delete(command.interactionId);
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

  #thinkingSelectionError(value: string): HarnessError | undefined {
    const available = this.#thinking.availableThinkingOptions ?? [];
    if (available.some(({ id }) => id === value)) return undefined;
    return {
      code: available.length === 0 ? "unsupported" : "invalidRequest",
      message:
        available.length === 0
          ? "The current Kiro model does not expose an effort setting"
          : "The requested effort level is not available for the current Kiro model",
      retryable: false,
    };
  }

  async #applyThinking(value: string): Promise<void> {
    const result = await this.#transport.setConfigOption("effortLevel", value);
    const options = confirmedKiroConfig(result, "effortLevel", value);
    if (kiroThinkingState(options).effectiveThinkingOptionId !== value) {
      throw new Error("Kiro did not confirm an available effort level");
    }
    this.#updateConfig(options);
    this.#channel.emit({
      kind: "event",
      event: { type: "session.state.changed", state: this.#state() },
    });
  }

  async #selectThinking(
    command: ThinkingSelectCommand,
  ): Promise<HarnessResult<ThinkingSelectCompleted>> {
    if (this.#activeTurnId !== null || this.#configBusy) {
      return {
        ok: false,
        error: { code: "sessionBusy", message: "Session is busy", retryable: true },
      };
    }
    const error = this.#thinkingSelectionError(command.thinkingOptionId);
    if (error) return { ok: false, error };
    this.#configBusy = true;
    try {
      await this.#applyThinking(command.thinkingOptionId);
      return { ok: true, value: { completed: true } };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "nativeFailure",
          message: error instanceof Error ? error.message : "Failed to select effort",
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
    this.#thinking = kiroThinkingState(options);
  }

  #state(): HarnessSessionState {
    return {
      ...(this.initialState.nativeRef ? { nativeRef: this.initialState.nativeRef } : {}),
      ...(this.#currentModel ? { effectiveModel: this.#currentModel } : {}),
      ...(this.#currentPermissionModeId
        ? { effectivePermissionModeId: this.#currentPermissionModeId }
        : {}),
      ...this.#thinking,
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
    let compactionItem: HostContextCompactionItem | undefined;
    const execute = async (): Promise<void> => {
      try {
        let result: unknown;
        if (command.commandId === "kiro.compact") {
          const compactionItemId = hostItemIdSchema.parse(
            `compact-${turnId}-${this.#randomUUID()}`,
          );
          compactionItem = {
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
          const result = await Promise.race([stopped, this.#transport.compact()]);
          if (isRecord(result) && result.success === false) {
            throw new Error("Kiro context compaction did not complete");
          }
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
          compactionItem = undefined;
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
        } else if (["kiro.plan", "kiro.spec", "kiro.vibe"].includes(command.commandId)) {
          const modeId = command.commandId.slice("kiro.".length);
          await Promise.race([
            stopped,
            this.#transport.sendExtensionRequest("session/set_mode", {
              sessionId: this.#sessionId,
              modeId,
            }),
          ]);
          result = modeId;
        }

        if (result !== undefined) {
          const item = {
            type: "agentMessage" as const,
            itemId: hostItemIdSchema.parse(`query-${turnId}`),
            text: formatKiroCommandResult(command.commandId, result),
            phase: "final_answer" as const,
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
      } catch (error) {
        const outcome: TurnOutcome =
          this.#closed && !this.#faultError
            ? { status: "cancelled", reason: "Session closed" }
            : {
                status: "failed",
                error: {
                  code: "nativeFailure",
                  message: error instanceof Error ? error.message : "Command execution failed",
                  retryable: false,
                },
              };
        if (compactionItem) {
          this.#channel.emit({
            kind: "event",
            event: {
              type: "item.completed",
              turnId,
              snapshot: { item: compactionItem, outcome },
            },
          });
        }
        this.#channel.emit({
          kind: "event",
          event: {
            type: "turn.completed",
            turnId,
            outcome,
          },
        });
      } finally {
        this.#activeTurnId = null;
        this.#stopTurn = null;
        if (!this.#closed) void this.refreshUsage();
      }
    };
    this.#activeTask = execute();
    return { ok: true, value: { turnId } };
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
