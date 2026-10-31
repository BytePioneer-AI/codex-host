/**
 * Codex CLI Harness plugin for the codexhost Adapter contract.
 *
 * It runs the local `codex app-server` as an ordinary external Harness. Desktop's
 * official Codex route is separate and never passes through this plugin.
 */

import { createCodexSessionUsage } from "@codexhost/adapter-codex-usage/session-usage";
import { listCodexImportCandidates, readCodexImportCandidate } from "./codex-session-import.js";

import { projectCodexAccountCredits } from "./account-usage.ts";
import {
  codexChildEnvironment,
  codexHome,
  resolveCodexExecutable,
  type CodexExecutable,
} from "./command.ts";
import { CodexAppServer } from "./rpc.ts";
import { codexFastModel, readCodexModels } from "./model-selection.ts";
import { CODEX_COMMANDS, CodexSession, HARNESS_ID } from "./session.ts";
import { DEFAULT_PERMISSION_MODE, PERMISSION_MODES } from "./permission-modes.ts";

import type {
  HarnessAdapter,
  HarnessError,
  HarnessInspection,
  HarnessResult,
  OpenSessionInput,
  InspectHarnessInput,
  HarnessSessionImportCapability,
} from "@codexhost/harness-adapter";
import type { HarnessPluginContext } from "@codexhost/harness-adapter/plugin";
import {
  harnessAccountSnapshotSchema,
  harnessInspectionSchema,
  nativeSessionRefSchema,
  type AccountCreditsSnapshot,
  type HarnessAccountSnapshot,
} from "@codexhost/shared-contracts";
type Result<T> = HarnessResult<T>;

const EFFORT_LABELS: Record<string, string> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  ultra: "Ultra",
};

const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

/** The resolved executable is the shared installation check; nothing spawns to probe it. */
function executableFailure(executable: CodexExecutable): HarnessError {
  return executable.status === "notInstalled"
    ? { code: "notInstalled", message: "Codex CLI is not installed", retryable: false }
    : {
        code: "unavailable",
        message: "Codex CLI must be a local CLI, not a Desktop proxy or shim",
        retryable: false,
      };
}

class CodexAdapter implements HarnessAdapter {
  readonly harnessId = HARNESS_ID;
  readonly commandCatalog = { commands: [...CODEX_COMMANDS], source: "static" as const };
  private control: Promise<CodexAppServer> | undefined;
  private readonly inspections = new Set<CodexAppServer>();
  private readonly inspectionInFlight = new Map<string | undefined, Promise<HarnessInspection>>();
  private closed = false;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly childEnvironment: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private readonly launchCommand: string | undefined;
  private readonly usageAbort = new AbortController();
  private account: HarnessAccountSnapshot | null = null;
  private accountRefresh: Promise<HarnessAccountSnapshot | null> | undefined;
  private accountObservedAt = 0;
  readonly sessionUsage;

  constructor(context: HarnessPluginContext) {
    this.platform = context.platform as NodeJS.Platform;
    this.launchCommand = context.launchCommand;
    this.environment = { ...process.env, ...context.environment };
    const home = codexHome(this.environment);
    this.childEnvironment = codexChildEnvironment(this.environment, home);
    this.sessionUsage = createCodexSessionUsage(this.childEnvironment, this.usageAbort.signal);
  }

  /** The persisted launch setting or generic discovery decides; the Host forces no path. */
  private executable(): CodexExecutable {
    return resolveCodexExecutable({
      ...(this.launchCommand ? { command: this.launchCommand } : {}),
      environment: this.environment,
      platform: this.platform,
    });
  }

  private nativeSessionId(nativeRef: unknown): Result<string> {
    const ref =
      nativeRef !== null && typeof nativeRef === "object"
        ? (nativeRef as Record<string, unknown>)
        : undefined;
    if (
      ref?.harnessId !== HARNESS_ID ||
      typeof ref.nativeSessionId !== "string" ||
      !ref.nativeSessionId.trim()
    ) {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "A Codex CLI native session reference is required",
          retryable: false,
        },
      };
    }
    return { ok: true, value: ref.nativeSessionId };
  }

  /** Shared process for read-only thread listing. */
  private async controlServer(): Promise<CodexAppServer> {
    if (this.closed) throw new Error("Codex CLI Adapter is closed");
    if (this.control !== undefined) {
      const previous = this.control;
      const server = await previous.catch(() => undefined);
      if (this.closed) throw new Error("Codex CLI Adapter is closed");
      if (server !== undefined && !server.closed) return server;
      if (this.control !== previous) return this.controlServer();
    }
    this.control = (async () => {
      const executable = this.executable();
      if (executable.status !== "ready") throw new Error(executableFailure(executable).message);
      const server = new CodexAppServer({
        command: executable.command,
        environment: this.childEnvironment,
        sensitive: true,
        requestTimeoutMs: 15_000,
      });
      try {
        await server.initialize();
      } catch (error) {
        await server.close();
        throw error;
      }
      return server;
    })();
    return this.control;
  }

  async inspect(input: InspectHarnessInput = {}): Promise<HarnessInspection> {
    const current = this.inspectionInFlight.get(input.cwd);
    if (current) return current;
    const pending = this.inspectNative(input);
    this.inspectionInFlight.set(input.cwd, pending);
    try {
      return await pending;
    } finally {
      if (this.inspectionInFlight.get(input.cwd) === pending)
        this.inspectionInFlight.delete(input.cwd);
    }
  }

  credits(): AccountCreditsSnapshot | null {
    return !this.closed && Date.now() - this.accountObservedAt < 60_000
      ? (this.account?.credits ?? null)
      : null;
  }

  async refreshCredits(): Promise<AccountCreditsSnapshot | null> {
    if (this.closed) return null;
    if (Date.now() - this.accountObservedAt < 30_000) return this.credits();
    return (await this.inspectAccount())?.credits ?? null;
  }

  async inspectAccount(): Promise<HarnessAccountSnapshot | null> {
    if (this.closed) return null;
    this.accountRefresh ??= this.readAccount()
      .then((account) => {
        this.account = this.closed ? null : account;
        this.accountObservedAt = Date.now();
        return this.account;
      })
      .finally(() => {
        this.accountRefresh = undefined;
      });
    return this.accountRefresh;
  }

  private async readAccount(): Promise<HarnessAccountSnapshot | null> {
    const executable = this.executable();
    if (executable.status !== "ready") return null;
    // A fresh process reads current native authentication instead of a previous login's cache.
    const server = new CodexAppServer({
      command: executable.command,
      environment: this.childEnvironment,
      sensitive: true,
      requestTimeoutMs: 4_000,
    });
    this.inspections.add(server);
    try {
      await server.initialize();
      const identity = await server.request<{
        account: { type: string; email?: string | null; planType?: string } | null;
        requiresOpenaiAuth: boolean;
      }>("account/read", { refreshToken: false });
      if (
        this.closed ||
        identity.requiresOpenaiAuth === false ||
        identity.account?.type !== "chatgpt"
      )
        return null;
      const response = await server.request<unknown>("account/rateLimits/read", {});
      if (this.closed) return null;
      const credits = projectCodexAccountCredits(response);
      if (!credits) return null;
      const account = harnessAccountSnapshotSchema.safeParse({
        ...(identity.account.email ? { email: identity.account.email } : {}),
        ...(identity.account.planType ? { plan: identity.account.planType } : {}),
        credits,
      });
      return account.success ? account.data : null;
    } catch {
      return null;
    } finally {
      await server.close();
      this.inspections.delete(server);
    }
  }

  private async inspectNative(input: InspectHarnessInput): Promise<HarnessInspection> {
    if (this.closed)
      return {
        status: "unavailable",
        error: { code: "invalidState", message: "Codex CLI Adapter is closed", retryable: false },
      };
    const executable = this.executable();
    if (executable.status !== "ready")
      return {
        status: executable.status === "notInstalled" ? "notInstalled" : "unavailable",
        error: executableFailure(executable),
      };
    const server = new CodexAppServer({
      command: executable.command,
      environment: this.childEnvironment,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      sensitive: true,
      requestTimeoutMs: 15_000,
    });
    this.inspections.add(server);
    try {
      await server.initialize();
      const models = await readCodexModels(server);
      const efforts = new Set<string>();
      for (const model of models)
        for (const option of model.supportedReasoningEfforts) efforts.add(option.reasoningEffort);
      const thinkingOptions = [...efforts]
        .sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b))
        .map((id) => ({ id, label: EFFORT_LABELS[id] ?? id }));
      const defaultModel = models.find((model) => model.isDefault) ?? models[0];
      return harnessInspectionSchema.parse({
        status: "ready",
        catalog: {
          models: models.map((model) => ({
            ref: { id: model.id },
            ...(codexFastModel(model) ? { fastModel: codexFastModel(model) } : {}),
            label: model.displayName,
            supportedThinkingOptionIds: model.supportedReasoningEfforts.map(
              (option) => option.reasoningEffort,
            ),
          })),
          ...(defaultModel === undefined
            ? {}
            : {
                defaultModel: (defaultModel.defaultServiceTier === "priority"
                  ? codexFastModel(defaultModel)
                  : undefined) ?? { id: defaultModel.id },
              }),
          thinkingOptions,
          ...(defaultModel !== undefined && efforts.has(defaultModel.defaultReasoningEffort)
            ? { defaultThinkingOptionId: defaultModel.defaultReasoningEffort }
            : {}),
        },
        permissionModes: {
          modes: PERMISSION_MODES.map((mode) => ({
            id: mode.id,
            label: mode.label,
            description: mode.description,
            ...(mode.dangerous === true ? { dangerous: true } : {}),
          })),
          defaultModeId: DEFAULT_PERMISSION_MODE,
        },
        capabilities: {
          configuration: {
            selectModel: true,
            selectThinkingOption: true,
            selectPermissionMode: true,
            permissionModeScope: "live",
          },
          history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
        },
      });
    } catch (error) {
      return {
        status: "unavailable",
        error: {
          code: "unavailable",
          retryable: true,
          message: error instanceof Error ? error.message : String(error),
        },
      };
    } finally {
      await server.close();
      this.inspections.delete(server);
    }
  }

  async open(input: OpenSessionInput): Promise<Result<CodexSession>> {
    if (input.kind !== "create" && input.kind !== "resume") {
      return {
        ok: false,
        error: {
          code: "unsupported",
          message: `Codex CLI sessions cannot ${input.kind}`,
          retryable: false,
        },
      };
    }
    const nativeSessionId =
      input.kind === "resume" ? this.nativeSessionId(input.nativeRef) : undefined;
    if (nativeSessionId && !nativeSessionId.ok) return nativeSessionId;
    try {
      if (this.closed)
        return {
          ok: false,
          error: { code: "invalidState", message: "Codex CLI Adapter is closed", retryable: false },
        };
      const executable = this.executable();
      if (executable.status !== "ready") return { ok: false, error: executableFailure(executable) };
      const result = await CodexSession.open({
        usage: this.sessionUsage,
        command: executable.command,
        environment: this.childEnvironment,
        cwd: input.cwd,
        ...(nativeSessionId?.ok ? { threadId: nativeSessionId.value } : {}),
        ...(typeof (input.model as { id?: unknown } | undefined)?.id === "string"
          ? { model: (input.model as { id: string }).id }
          : {}),
        ...(typeof input.thinkingOptionId === "string" ? { effort: input.thinkingOptionId } : {}),
        ...(typeof input.permissionModeId === "string"
          ? { permissionModeId: input.permissionModeId }
          : {}),
      });
      if (this.closed && result.ok) {
        await result.value.close();
        return {
          ok: false,
          error: { code: "invalidState", message: "Codex CLI Adapter is closed", retryable: false },
        };
      }
      return result;
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

  readonly sessionImport: Required<HarnessSessionImportCapability> = {
    listCandidates: async () => {
      const executable = this.executable();
      if (executable.status !== "ready") return { ok: false, error: executableFailure(executable) };
      try {
        const server = await this.controlServer();
        return { ok: true, value: await listCodexImportCandidates(server, this.usageAbort.signal) };
      } catch (error) {
        return {
          ok: false,
          error: {
            code: "unavailable",
            message: error instanceof Error ? error.message : String(error),
            retryable: true,
          },
        };
      }
    },
    resolveCandidate: async (nativeSessionId: string) => {
      const list = await this.sessionImport.listCandidates();
      if (!list.ok) return list;
      try {
        const candidate = list.value.some((entry) => entry.nativeSessionId === nativeSessionId)
          ? await readCodexImportCandidate(
              await this.controlServer(),
              nativeSessionId,
              this.usageAbort.signal,
            )
          : null;
        if (!candidate)
          return {
            ok: false,
            error: {
              code: "sessionNotFound",
              message: "Codex CLI thread not found or no longer importable",
              retryable: false,
            },
          };
        return {
          ok: true,
          value: {
            candidate,
            nativeRef: nativeSessionRefSchema.parse({
              formatVersion: 1,
              harnessId: HARNESS_ID,
              nativeSessionId,
            }),
          },
        };
      } catch (error) {
        return {
          ok: false,
          error: {
            code: "unavailable",
            message: error instanceof Error ? error.message : String(error),
            retryable: true,
          },
        };
      }
    },
  };

  async close(): Promise<void> {
    this.closed = true;
    this.account = null;
    this.usageAbort.abort();
    const control = this.control;
    this.control = undefined;
    await Promise.all([
      ...[...this.inspections].map((server) => server.close()),
      control?.catch(() => undefined).then((server) => server?.close()),
    ]);
  }
}

export function createHarnessAdapter(context: HarnessPluginContext): CodexAdapter {
  return new CodexAdapter(context);
}
