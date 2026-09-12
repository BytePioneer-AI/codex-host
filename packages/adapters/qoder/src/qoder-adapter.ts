import { randomUUID } from "node:crypto";
import type {
  HarnessAdapter,
  HarnessInspection,
  HarnessResult,
  HarnessSession,
  InspectHarnessInput,
  OpenSessionInput,
} from "@codexhost/harness-adapter";
import { harnessIdSchema, type HarnessId } from "@codexhost/shared-contracts";
import { accessTokenFromEnv, qodercliAuth, query as sdkQuery } from "@qoder-ai/qoder-agent-sdk";

import {
  CODEXHOST_QODER_COMMAND,
  qoderEnvironment,
  resolveQoderExecutable,
} from "./qoder-command.js";
import { parseQoderModelCatalog } from "./qoder-models.js";
import { QODER_PERMISSION_MODE_CATALOG } from "./qoder-permission-modes.js";
import type { QoderModelInfo, QoderQueryFactory } from "./qoder-sdk-types.js";
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
  getAvailableModels?: () => Promise<QoderModelInfo[]>;
  resolveExecutable?: typeof resolveQoderExecutable;
}

export class QoderAdapter implements HarnessAdapter {
  readonly harnessId: HarnessId = harnessIdSchema.parse("qoder");

  readonly #commandOverride: string | undefined;
  readonly #environment: Record<string, string | undefined>;
  readonly #platform: NodeJS.Platform;
  readonly #queryFactory: QoderQueryFactory;
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

        const result: Extract<HarnessInspection, { status: "ready" }> = {
          status: "ready",
          catalog: parseQoderModelCatalog(rawModels),
          permissionModes: QODER_PERMISSION_MODE_CATALOG,
          capabilities: {
            configuration: {
              selectModel: true,
              selectThinkingOption: false,
              selectPermissionMode: true,
              permissionModeScope: "live",
            },
            history: {
              fork: false,
              forkAcrossCwd: false,
              rollbackLastTurn: false,
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
    if (input.kind === "fork" || input.kind === "rollbackLastTurn") {
      return {
        ok: false,
        error: {
          code: "unsupported",
          message: `Qoder does not support session ${input.kind}`,
          retryable: false,
        },
      };
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

    const session = new QoderSession({
      sessionId,
      cwd: input.cwd,
      environment,
      ...(input.model ? { model: input.model } : {}),
      ...(input.permissionModeId ? { permissionModeId: input.permissionModeId } : {}),
      ...(input.kind === "resume" ? { resume: sessionId } : {}),
      queryFactory: this.#queryFactory,
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
