/**
 * Codex Harness plugin for the codexhost Adapter contract.
 *
 * In codexhost (the Codex Desktop host) Codex is the host itself; the standalone Web server
 * treats it as one more Harness, driven through `codex app-server` over stdio.
 */

import { execFileSync } from "node:child_process";

import { nativeCodexLaunch } from "./native-launch.ts";
import { CodexAppServer } from "./rpc.ts";
import {
  CODEX_COMMANDS,
  CodexSession,
  DEFAULT_PERMISSION_MODE,
  HARNESS_ID,
  PERMISSION_MODES,
  snapshotTurn,
} from "./session.ts";
import type { CodexItem } from "./items.ts";

export { CODEX_COMMAND_ENV, CODEX_HOME_ENV } from "./native-launch.ts";

type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string; retryable: boolean } };

interface PluginContext {
  environment: Readonly<Record<string, string | undefined>>;
}

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

function installed(command: string, environment: NodeJS.ProcessEnv): boolean {
  try {
    execFileSync(command, ["--version"], { env: environment, stdio: "ignore", timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

class CodexAdapter {
  readonly harnessId = HARNESS_ID;
  readonly commandCatalog = { commands: [...CODEX_COMMANDS], source: "static" as const };
  private control: Promise<CodexAppServer> | undefined;
  private readonly command: string;
  private readonly home: string;
  private readonly environment: NodeJS.ProcessEnv;

  constructor(context: PluginContext) {
    const launch = nativeCodexLaunch({ ...process.env, ...context.environment });
    this.environment = launch.environment;
    this.command = launch.command;
    this.home = launch.home;
  }

  /** A native Thread ID is meaningful only inside the home that issued it. */
  private threadId(nativeRef: unknown): Result<string> {
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
          message: "A Codex native session reference is required",
          retryable: false,
        },
      };
    }
    const locator =
      ref.locator !== null && typeof ref.locator === "object"
        ? (ref.locator as Record<string, unknown>)
        : undefined;
    if (locator?.codexHome !== this.home) {
      return {
        ok: false,
        error: {
          code: "sessionScopeMismatch",
          message:
            "This Codex session reference is not bound to the configured Web home. Import a session from this home explicitly.",
          retryable: false,
        },
      };
    }
    return { ok: true, value: ref.nativeSessionId };
  }

  /** Shared process for read-only calls (models, thread listing). */
  private async controlServer(): Promise<CodexAppServer> {
    if (this.control !== undefined) {
      const server = await this.control.catch(() => undefined);
      if (server !== undefined && !server.closed) return server;
    }
    this.control = (async () => {
      const server = new CodexAppServer({ command: this.command, environment: this.environment });
      await server.initialize();
      return server;
    })();
    return this.control;
  }

  async inspect(): Promise<Record<string, unknown>> {
    if (!installed(this.command, this.environment)) {
      return {
        status: "notInstalled",
        error: { code: "notInstalled", message: "Codex CLI is not installed" },
      };
    }
    try {
      const server = await this.controlServer();
      const response = await server.request<{
        data: Array<{
          id: string;
          displayName: string;
          description: string;
          hidden: boolean;
          isDefault: boolean;
          supportedReasoningEfforts: Array<{ reasoningEffort: string }>;
          defaultReasoningEffort: string;
        }>;
      }>("model/list", { limit: 100 });
      const models = response.data.filter(
        (model) => !model.hidden && /^[A-Za-z0-9._~-]+$/u.test(model.id),
      );
      const efforts = new Set<string>();
      for (const model of models)
        for (const option of model.supportedReasoningEfforts) efforts.add(option.reasoningEffort);
      const thinkingOptions = [...efforts]
        .sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b))
        .map((id) => ({ id, label: EFFORT_LABELS[id] ?? id }));
      const defaultModel = models.find((model) => model.isDefault) ?? models[0];
      return {
        status: "ready",
        catalog: {
          models: models.map((model) => ({
            ref: { id: model.id },
            label: model.displayName,
            supportedThinkingOptionIds: model.supportedReasoningEfforts.map(
              (option) => option.reasoningEffort,
            ),
          })),
          ...(defaultModel === undefined ? {} : { defaultModel: { id: defaultModel.id } }),
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
      };
    } catch (error) {
      return {
        status: "unavailable",
        error: {
          code: "unavailable",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  async open(
    input: Record<string, unknown> & { kind: string; cwd: string },
  ): Promise<Result<CodexSession>> {
    if (input.kind !== "create" && input.kind !== "resume") {
      return {
        ok: false,
        error: {
          code: "unsupported",
          message: `Codex sessions cannot ${input.kind}`,
          retryable: false,
        },
      };
    }
    const threadId = input.kind === "resume" ? this.threadId(input.nativeRef) : undefined;
    if (threadId && !threadId.ok) return threadId;
    try {
      const session = await CodexSession.open({
        command: this.command,
        codexHome: this.home,
        environment: this.environment,
        cwd: input.cwd,
        ...(threadId?.ok ? { threadId: threadId.value } : {}),
        ...(typeof (input.model as { id?: unknown } | undefined)?.id === "string"
          ? { model: (input.model as { id: string }).id }
          : {}),
        ...(typeof input.thinkingOptionId === "string" ? { effort: input.thinkingOptionId } : {}),
        ...(typeof input.permissionModeId === "string"
          ? { permissionModeId: input.permissionModeId }
          : {}),
      });
      return { ok: true, value: session };
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

  readonly sessionImport = {
    listCandidates: async (): Promise<
      Result<
        Array<{
          nativeSessionId: string;
          title: string | null;
          updatedAt: number;
          cwd: string;
          running: boolean | null;
        }>
      >
    > => {
      try {
        const server = await this.controlServer();
        const response = await server.request<{
          data: Array<{
            id: string;
            name: string | null;
            preview: string;
            cwd: string;
            updatedAt: number;
            ephemeral: boolean;
            parentThreadId: string | null;
          }>;
        }>("thread/list", { limit: 200, sortKey: "updated_at" });
        return {
          ok: true,
          value: response.data
            .filter((thread) => !thread.ephemeral && thread.parentThreadId === null)
            .map((thread) => ({
              nativeSessionId: thread.id,
              title:
                (
                  thread.name ??
                  thread.preview
                    .split("\n")
                    .find((line) => line.trim() !== "" && !line.startsWith("#")) ??
                  ""
                )
                  .trim()
                  .slice(0, 200) || null,
              updatedAt: thread.updatedAt * 1000,
              cwd: thread.cwd,
              running: null,
            })),
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
    resolveCandidate: async (
      nativeSessionId: string,
    ): Promise<
      Result<{ candidate: Record<string, unknown>; nativeRef: Record<string, unknown> }>
    > => {
      const list = await this.sessionImport.listCandidates();
      if (!list.ok) return list;
      const candidate = list.value.find((entry) => entry.nativeSessionId === nativeSessionId);
      if (candidate === undefined)
        return {
          ok: false,
          error: { code: "sessionNotFound", message: "Codex thread not found", retryable: false },
        };
      return {
        ok: true,
        value: {
          candidate,
          nativeRef: { harnessId: HARNESS_ID, nativeSessionId, locator: { codexHome: this.home } },
        },
      };
    },
  };

  /** Read a thread from the isolated Web home without loading it for execution. */
  async readHistory(nativeRef: unknown): Promise<Result<{ turns: unknown[] }>> {
    const threadId = this.threadId(nativeRef);
    if (!threadId.ok) return threadId;
    try {
      const server = await this.controlServer();
      const response = await server.request<{
        thread: {
          turns: Array<{
            id: string;
            items: CodexItem[];
            status: string;
            error: { message?: string } | null;
            startedAt: number | null;
            completedAt: number | null;
          }>;
        };
      }>("thread/read", { threadId: threadId.value, includeTurns: true });
      return {
        ok: true,
        value: { turns: response.thread.turns.map((turn) => snapshotTurn(threadId.value, turn)) },
      };
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

  async close(): Promise<void> {
    const control = this.control;
    this.control = undefined;
    if (control !== undefined) await (await control.catch(() => undefined))?.close();
  }
}

export function createHarnessAdapter(context: PluginContext): CodexAdapter {
  return new CodexAdapter(context);
}
