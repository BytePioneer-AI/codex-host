import { randomUUID } from "node:crypto";
import path from "node:path";
import type {
  HarnessAdapter,
  HarnessInspection,
  HarnessResult,
  HarnessSession,
  InspectHarnessInput,
  OpenSessionInput,
} from "@codexhost/harness-adapter";
import {
  harnessIdSchema,
  harnessPermissionModeIdSchema,
  nativeCheckpointRefSchema,
  nativeSessionRefSchema,
  type HarnessId,
} from "@codexhost/shared-contracts";
import { qoderEnvironment, resolveQoderExecutable } from "./qoder-command.js";
import { mapQoderException } from "./qoder-errors.js";
import { mapQoderSnapshot } from "./qoder-history.js";
import { decodeQoderModelRef, parseQoderModelCatalog } from "./qoder-models.js";
import {
  mapToQoderPermissionMode,
  QODER_PERMISSION_MODE_CATALOG,
} from "./qoder-permission-modes.js";
import { QODER_FALLBACK_COMMAND_CATALOG } from "./qoder-slash-commands.js";
import type {
  ForkSessionOptions,
  ForkSessionResult,
  GetSessionInfoOptions,
  GetSessionMessagesOptions,
  QoderModelInfo,
  QoderQueryFactory,
  SDKSessionInfo,
  SessionMessage,
} from "./qoder-sdk-types.js";
import { QoderSession } from "./qoder-sdk-transport.js";

import { QODER_RUNTIMES, qoderAuthForEnvironment, type QoderVariant } from "./qoder-runtime.js";

export interface QoderAdapterOptions {
  variant?: QoderVariant;
  commandOverride?: string;
  environment?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  queryFactory?: QoderQueryFactory;
  forkSession?: (sessionId: string, options?: ForkSessionOptions) => Promise<ForkSessionResult>;
  getSessionMessages?: (
    sessionId: string,
    options?: GetSessionMessagesOptions,
  ) => Promise<SessionMessage[]>;
  getSessionInfo?: (
    sessionId: string,
    options?: GetSessionInfoOptions,
  ) => Promise<SDKSessionInfo | undefined>;
  getAvailableModels?: () => Promise<QoderModelInfo[]>;
  resolveExecutable?: typeof resolveQoderExecutable;
}

export class QoderAdapter implements HarnessAdapter {
  readonly harnessId: HarnessId;
  readonly #variant: QoderVariant;
  readonly commandCatalog = QODER_FALLBACK_COMMAND_CATALOG;
  readonly liveCommandCatalog = true;

  readonly #commandOverride: string | undefined;
  readonly #environment: Record<string, string | undefined>;
  readonly #platform: NodeJS.Platform;
  readonly #queryFactory: QoderQueryFactory;
  readonly #forkSession: (
    sessionId: string,
    options?: ForkSessionOptions,
  ) => Promise<ForkSessionResult>;
  readonly #getSessionMessages: (
    sessionId: string,
    options?: GetSessionMessagesOptions,
  ) => Promise<SessionMessage[]>;
  readonly #getSessionInfo: (
    sessionId: string,
    options?: GetSessionInfoOptions,
  ) => Promise<SDKSessionInfo | undefined>;
  readonly #getAvailableModels: (() => Promise<QoderModelInfo[]>) | undefined;
  readonly #resolveExecutable: typeof resolveQoderExecutable;

  readonly #sessions = new Set<HarnessSession>();
  readonly #inspections = new Map<string, Extract<HarnessInspection, { status: "ready" }>>();
  readonly #inFlightInspections = new Map<string, Promise<HarnessInspection>>();

  constructor(options: QoderAdapterOptions = {}) {
    this.#variant = options.variant ?? "global";
    const runtime = QODER_RUNTIMES[this.#variant];
    this.harnessId = harnessIdSchema.parse(runtime.harnessId);
    this.#commandOverride =
      options.commandOverride ?? options.environment?.[runtime.commandEnvironmentVariable];
    this.#environment = qoderEnvironment(options.environment);
    this.#platform = options.platform ?? process.platform;
    this.#queryFactory = options.queryFactory ?? ((input) => runtime.sdk.query(input));
    this.#forkSession = options.forkSession ?? runtime.sdk.forkSession;
    this.#getSessionMessages = options.getSessionMessages ?? runtime.sdk.getSessionMessages;
    this.#getSessionInfo = options.getSessionInfo ?? runtime.sdk.getSessionInfo;
    this.#getAvailableModels = options.getAvailableModels;
    this.#resolveExecutable =
      options.resolveExecutable ??
      ((input, dependencies) =>
        resolveQoderExecutable({ ...input, variant: this.#variant }, dependencies));
  }

  async inspect(input?: InspectHarnessInput): Promise<HarnessInspection> {
    const cacheKey = input?.cwd ?? "";

    if (input?.refresh) {
      this.#inspections.delete(cacheKey);
      this.#inFlightInspections.delete(cacheKey);
    } else {
      const cached = this.#inspections.get(cacheKey);
      if (cached) return cached;

      const inFlight = this.#inFlightInspections.get(cacheKey);
      if (inFlight) return inFlight;
    }

    const task = Promise.resolve().then(async () => {
      try {
        const executable = this.#resolveExecutable({
          ...(this.#commandOverride ? { command: this.#commandOverride } : {}),
          environment: this.#environment as NodeJS.ProcessEnv,
          platform: this.#platform,
        });

        let rawModels: QoderModelInfo[] | undefined;
        if (this.#getAvailableModels) {
          try {
            rawModels = await this.#getAvailableModels();
          } catch {
            // Keep fallback catalog on error
          }
        } else {
          try {
            const probeQuery = this.#queryFactory({
              prompt: "",
              options: {
                cwd: input?.cwd ?? process.cwd(),
                pathToQoderCLIExecutable: executable,
                ...(this.#environment ? { env: this.#environment } : {}),
                auth: qoderAuthForEnvironment(this.#variant, this.#environment),
              },
            });
            try {
              if (probeQuery.getAvailableModels) {
                rawModels = await probeQuery.getAvailableModels({ fetchStrategy: "cache" });
              }
            } finally {
              try {
                await probeQuery.close();
              } catch {
                // Ignore query close error
              }
            }
          } catch (error) {
            const result: HarnessInspection = {
              status: "unavailable",
              error: mapQoderException(error),
            };
            return result;
          }
        }

        const catalog = parseQoderModelCatalog(rawModels);
        const result: Extract<HarnessInspection, { status: "ready" }> = {
          status: "ready",
          catalog,
          permissionModes: QODER_PERMISSION_MODE_CATALOG,
          capabilities: {
            configuration: {
              selectModel: true,
              selectThinkingOption: catalog.thinkingOptions.length > 0,
              selectPermissionMode: true,
              permissionModeScope: "live",
            },
            history: {
              fork: true,
              forkAcrossCwd: false,
              rollbackLastTurn: true,
            },
          },
        };

        this.#inspections.set(cacheKey, result);
        return result;
      } catch {
        const errorResult: HarnessInspection = {
          status: "notInstalled",
          error: {
            code: "notInstalled",
            message: "Qoder CLI is not installed",
            retryable: false,
          },
        };
        return errorResult;
      } finally {
        if (this.#inFlightInspections.get(cacheKey) === task) {
          this.#inFlightInspections.delete(cacheKey);
        }
      }
    });

    this.#inFlightInspections.set(cacheKey, task);
    return task;
  }

  async open(input: OpenSessionInput): Promise<HarnessResult<HarnessSession>> {
    if ("model" in input && input.model && !decodeQoderModelRef(input.model)) {
      return {
        ok: false,
        error: { code: "invalidRequest", message: "Invalid Qoder Model Ref", retryable: false },
      };
    }
    if (
      "permissionModeId" in input &&
      input.permissionModeId &&
      !mapToQoderPermissionMode(input.permissionModeId)
    ) {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "Invalid Qoder permission mode",
          retryable: false,
        },
      };
    }
    let permissionModeId = "permissionModeId" in input ? input.permissionModeId : undefined;
    if (input.kind === "create" && input.executionPolicy === "unattended-full-access") {
      if (permissionModeId && !["bypassPermissions", "yolo"].includes(permissionModeId)) {
        return {
          ok: false,
          error: {
            code: "invalidRequest",
            message: "unattended-full-access requires Qoder bypassPermissions",
            retryable: false,
          },
        };
      }
      permissionModeId = harnessPermissionModeIdSchema.parse("bypassPermissions");
    }
    const environment = qoderEnvironment(input.environment ?? this.#environment);
    let pathToQoderCLIExecutable: string | undefined;
    try {
      pathToQoderCLIExecutable = this.#resolveExecutable({
        ...(this.#commandOverride ? { command: this.#commandOverride } : {}),
        environment: environment as NodeJS.ProcessEnv,
        platform: this.#platform,
      });
    } catch {
      // Ignored if queryFactory is injected
    }

    let sessionId: string;
    let openResumeId: string | undefined;
    if (input.kind === "create") {
      sessionId = randomUUID();
    } else if (input.kind === "resume") {
      const id = input.nativeRef?.nativeSessionId;
      if (!id || typeof id !== "string" || input.nativeRef.harnessId !== this.harnessId) {
        return {
          ok: false,
          error: {
            code: "invalidRequest",
            message: "Native session ref missing nativeSessionId or belongs to another Harness",
            retryable: false,
          },
        };
      }
      sessionId = id;
      openResumeId = id;
    } else if (input.kind === "fork") {
      const sourceRef = nativeSessionRefSchema.safeParse(input.sourceRef);
      const checkpoint = nativeCheckpointRefSchema.safeParse(input.checkpoint);
      if (
        !sourceRef.success ||
        sourceRef.data.harnessId !== this.harnessId ||
        !checkpoint.success ||
        checkpoint.data.harnessId !== this.harnessId ||
        checkpoint.data.nativeSessionId !== sourceRef.data.nativeSessionId
      ) {
        return {
          ok: false,
          error: {
            code: "invalidRequest",
            message: "Qoder Fork identity does not belong to the source Session",
            retryable: false,
          },
        };
      }

      let sourceInfo: SDKSessionInfo | undefined;
      try {
        sourceInfo = await this.#getSessionInfo(sourceRef.data.nativeSessionId, { dir: input.cwd });
      } catch {
        // Ignore info lookup failure
      }
      if (sourceInfo?.cwd && path.resolve(sourceInfo.cwd) !== path.resolve(input.cwd)) {
        return {
          ok: false,
          error: {
            code: "unsupported",
            message: "Qoder cannot Fork across working directories",
            retryable: false,
          },
        };
      }

      let derivedSessionId: string;
      try {
        const forked = await this.#forkSession(sourceRef.data.nativeSessionId, {
          dir: input.cwd,
          upToMessageId: checkpoint.data.checkpointId,
        });
        derivedSessionId = forked.sessionId;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const isNotFound =
          message.toLowerCase().includes("not found") ||
          message.toLowerCase().includes("cannot find");
        return {
          ok: false,
          error: {
            code: isNotFound ? "checkpointNotFound" : "nativeFailure",
            message: `Qoder native fork failed: ${message}`,
            retryable: false,
          },
        };
      }

      sessionId = derivedSessionId;
      openResumeId = derivedSessionId;
    } else if (input.kind === "rollbackLastTurn") {
      const sourceRef = nativeSessionRefSchema.safeParse(input.sourceRef);
      if (!sourceRef.success || sourceRef.data.harnessId !== this.harnessId) {
        return {
          ok: false,
          error: {
            code: "invalidRequest",
            message: "Native session ref missing or invalid for Qoder rollbackLastTurn",
            retryable: false,
          },
        };
      }

      let sourceMessages: SessionMessage[];
      try {
        sourceMessages = await this.#getSessionMessages(sourceRef.data.nativeSessionId, {
          dir: input.cwd,
          view: "historical",
        });
      } catch (error) {
        return {
          ok: false,
          error: {
            code: "nativeFailure",
            message:
              error instanceof Error ? error.message : "Failed to read Qoder session history",
            retryable: false,
          },
        };
      }

      const snapshot = mapQoderSnapshot(
        sourceMessages,
        sourceRef.data.nativeSessionId,
        this.harnessId,
      );
      if (snapshot.turns.length === 0) {
        return {
          ok: false,
          error: {
            code: "invalidRequest",
            message: "Qoder session has no turn to roll back",
            retryable: false,
          },
        };
      }

      if (snapshot.turns.length === 1) {
        sessionId = randomUUID();
        openResumeId = undefined;
      } else {
        const retainedTurn = snapshot.turns[snapshot.turns.length - 2];
        const checkpointId =
          retainedTurn?.checkpoint?.checkpointId ?? retainedTurn?.nativeTurnRef?.nativeTurnKey;
        if (!checkpointId) {
          return {
            ok: false,
            error: {
              code: "checkpointNotFound",
              message: "Qoder rollback checkpoint is unavailable",
              retryable: false,
            },
          };
        }

        let derivedSessionId: string;
        try {
          const forked = await this.#forkSession(sourceRef.data.nativeSessionId, {
            dir: input.cwd,
            upToMessageId: checkpointId,
          });
          derivedSessionId = forked.sessionId;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const isNotFound =
            message.toLowerCase().includes("not found") ||
            message.toLowerCase().includes("cannot find");
          return {
            ok: false,
            error: {
              code: isNotFound ? "checkpointNotFound" : "nativeFailure",
              message: `Qoder native rollback fork failed: ${message}`,
              retryable: false,
            },
          };
        }

        sessionId = derivedSessionId;
        openResumeId = derivedSessionId;
      }
    } else {
      return {
        ok: false,
        error: {
          code: "unsupported",
          message: "Unsupported session kind",
          retryable: false,
        },
      };
    }

    const cachedInspection = this.#inspections.get(input.cwd) ?? [...this.#inspections.values()][0];
    const catalog = cachedInspection?.catalog;

    let session: QoderSession;
    try {
      session = new QoderSession({
        variant: this.#variant,
        sessionId,
        cwd: input.cwd,
        environment,
        ...("model" in input && input.model ? { model: input.model } : {}),
        ...(permissionModeId ? { permissionModeId } : {}),
        ...("thinkingOptionId" in input && input.thinkingOptionId
          ? { thinkingOptionId: input.thinkingOptionId }
          : {}),
        ...(catalog ? { catalog } : {}),
        ...(openResumeId ? { resume: openResumeId } : {}),
        queryFactory: this.#queryFactory,
        getSessionMessages: this.#getSessionMessages,
        ...(pathToQoderCLIExecutable ? { pathToQoderCLIExecutable } : {}),
        onClosed: () => {
          this.#sessions.delete(session);
        },
      });
    } catch (error) {
      return { ok: false, error: mapQoderException(error) };
    }

    this.#sessions.add(session);
    return { ok: true, value: session };
  }

  async close(): Promise<void> {
    const sessions = [...this.#sessions];
    this.#sessions.clear();
    this.#inspections.clear();
    this.#inFlightInspections.clear();
    await Promise.all(sessions.map((s) => s.close()));
  }
}
