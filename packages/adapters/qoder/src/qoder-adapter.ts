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
  nativeCheckpointRefSchema,
  nativeSessionRefSchema,
  type HarnessId,
} from "@codexhost/shared-contracts";
import {
  accessTokenFromEnv,
  forkSession as defaultForkSession,
  getSessionInfo as defaultGetSessionInfo,
  getSessionMessages as defaultGetSessionMessages,
  qodercliAuth,
  query as sdkQuery,
} from "@qoder-ai/qoder-agent-sdk";

import {
  CODEXHOST_QODER_COMMAND,
  qoderEnvironment,
  resolveQoderExecutable,
} from "./qoder-command.js";
import { mapQoderSnapshot } from "./qoder-history.js";
import { parseQoderModelCatalog } from "./qoder-models.js";
import { QODER_PERMISSION_MODE_CATALOG } from "./qoder-permission-modes.js";
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

const defaultQueryFactory: QoderQueryFactory = (input) => sdkQuery(input);

function qoderAuthForEnvironment(environment: Record<string, string | undefined>) {
  return environment.QODER_PERSONAL_ACCESS_TOKEN ? accessTokenFromEnv() : qodercliAuth();
}

export interface QoderAdapterOptions {
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
  readonly harnessId: HarnessId = harnessIdSchema.parse("qoder");
  readonly commandCatalog = QODER_FALLBACK_COMMAND_CATALOG;

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
  readonly #inspections = new Map<string, { result: HarnessInspection; refreshAfter: number }>();
  readonly #inFlightInspections = new Map<string, Promise<HarnessInspection>>();

  constructor(options: QoderAdapterOptions = {}) {
    this.#commandOverride =
      options.commandOverride ?? options.environment?.[CODEXHOST_QODER_COMMAND];
    this.#environment = qoderEnvironment(options.environment);
    this.#platform = options.platform ?? process.platform;
    this.#queryFactory = options.queryFactory ?? defaultQueryFactory;
    this.#forkSession = options.forkSession ?? defaultForkSession;
    this.#getSessionMessages = options.getSessionMessages ?? defaultGetSessionMessages;
    this.#getSessionInfo = options.getSessionInfo ?? defaultGetSessionInfo;
    this.#getAvailableModels = options.getAvailableModels;
    this.#resolveExecutable = options.resolveExecutable ?? resolveQoderExecutable;
  }

  async inspect(input?: InspectHarnessInput): Promise<HarnessInspection> {
    const cacheKey = input?.cwd ?? "";
    const now = Date.now();

    if (input?.refresh) {
      this.#inspections.delete(cacheKey);
      this.#inFlightInspections.delete(cacheKey);
    } else {
      const cached = this.#inspections.get(cacheKey);
      if (cached && cached.refreshAfter > now) {
        return cached.result;
      }

      const inFlight = this.#inFlightInspections.get(cacheKey);
      if (inFlight) return inFlight;
    }

    const task = (async () => {
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
                auth: qoderAuthForEnvironment(this.#environment),
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
          } catch {
            // Keep empty catalog on error
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

        this.#inspections.set(cacheKey, { result, refreshAfter: now + 30_000 });
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
        this.#inspections.set(cacheKey, { result: errorResult, refreshAfter: now + 5_000 });
        return errorResult;
      } finally {
        this.#inFlightInspections.delete(cacheKey);
      }
    })();

    this.#inFlightInspections.set(cacheKey, task);
    return task;
  }

  async open(input: OpenSessionInput): Promise<HarnessResult<HarnessSession>> {
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
      if (!id || typeof id !== "string") {
        return {
          ok: false,
          error: {
            code: "invalidRequest",
            message: "Native session ref missing nativeSessionId",
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

      const snapshot = mapQoderSnapshot(sourceMessages, sourceRef.data.nativeSessionId);
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

    const cachedInspection =
      this.#inspections.get(input.cwd)?.result ?? [...this.#inspections.values()][0]?.result;
    const catalog =
      cachedInspection && cachedInspection.status === "ready"
        ? cachedInspection.catalog
        : undefined;

    const session = new QoderSession({
      sessionId,
      cwd: input.cwd,
      environment,
      ...("model" in input && input.model ? { model: input.model } : {}),
      ...("permissionModeId" in input && input.permissionModeId
        ? { permissionModeId: input.permissionModeId }
        : {}),
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
