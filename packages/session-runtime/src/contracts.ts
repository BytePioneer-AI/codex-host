import type { HarnessCommandCatalog } from "@codexhost/shared-contracts";
interface ModelRef {
  id: string;
}

interface CatalogModel {
  ref: ModelRef;
  label: string;
  resolvedModelLabel?: string;
  supportedThinkingOptionIds?: string[];
}

interface ModelCatalog {
  models: CatalogModel[];
  defaultModel?: ModelRef;
  thinkingOptions: Array<{ id: string; label: string }>;
  defaultThinkingOptionId?: string;
}

export interface PermissionModeCatalog {
  modes: Array<{ id: string; label: string; description?: string; dangerous?: boolean }>;
  defaultModeId: string;
}

export type Inspection =
  | {
      status: "ready";
      catalog: ModelCatalog;
      permissionModes?: PermissionModeCatalog;
      capabilities: {
        configuration: {
          selectModel: boolean;
          selectThinkingOption: boolean;
          selectPermissionMode: boolean;
          permissionModeScope?: "live" | "atCreate";
        };
        history: { fork: boolean; forkAcrossCwd: boolean; rollbackLastTurn: boolean };
      };
    }
  | { status: "notInstalled" | "unavailable" | "error"; error: { code?: string; message: string } };

/** Structural subset of the codexhost HarnessAdapter used by the server. */
export interface Adapter {
  readonly harnessId: string;
  readonly commandCatalog?: HarnessCommandCatalog;
  inspect(input?: { cwd?: string; refresh?: boolean }): Promise<Inspection>;
  open(
    input: Record<string, unknown> & { kind: string; cwd: string },
  ): Promise<
    | { ok: true; value: HarnessSessionLike }
    | { ok: false; error: { code: string; message: string } }
  >;
  close(): Promise<void>;
}

export interface HarnessSessionLike {
  readonly harnessId: string;
  readonly capabilities: {
    configuration?: { selectPermissionMode: boolean; permissionModeScope?: "live" | "atCreate" };
    steering?: { native?: boolean };
  };
  readonly initialState: {
    nativeRef?: unknown;
    effectiveModel?: ModelRef;
    effectiveThinkingOptionId?: string;
    effectivePermissionModeId?: string;
    resolvedModelLabel?: string;
  };
  readonly initialUsage: unknown;
  readonly outputs: AsyncIterable<
    | { kind: "event"; event: Record<string, unknown> & { type: string } }
    | { kind: "interaction"; interaction: Record<string, unknown> & { type: string } }
  >;
  readonly commands?: {
    list(): Promise<unknown>;
    execute(command: {
      turnId: string;
      commandId: string;
      arguments?: unknown;
    }): Promise<{ ok: boolean; error?: { message: string } }>;
  };
  hasBackgroundWork?(): boolean;
  readSnapshot(): Promise<
    | { ok: true; value: { turns: unknown[]; state?: unknown } }
    | { ok: false; error: { code: string; message: string } }
  >;
  execute(
    command: Record<string, unknown>,
  ): Promise<
    { ok: true; value: unknown } | { ok: false; error: { code: string; message: string } }
  >;
  close(): Promise<void>;
}

export interface SessionDataStore {
  path(...parts: string[]): string;
  readJson<T>(relative: string, fallback: T): T;
  writeJson(relative: string, value: unknown): void;
  readLines<T>(relative: string): T[];
  writeLines(relative: string, values: readonly unknown[]): void;
  appendLine(relative: string, value: unknown): void;
}
export interface SessionSink {
  readonly id: string;
  readonly closed: boolean;
  push(value: unknown): void;
  end(): void;
  fail(code: string, message: string): void;
  onClose(listener: () => void): void;
}
export class SessionRuntimeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: object = {},
  ) {
    super(message);
  }
}
export function requestOf<T>(args: Record<string, unknown>): T {
  return ("request" in args ? args.request : "_request" in args ? args._request : args) as T;
}
export interface SessionOrganization {
  get(id: string): { workspaceId: string; path: string } | undefined;
  ownerOf(id: string): { workspaceId: string } | undefined;
  attachSession(id: string, workspaceId: string | undefined, cwd: string): void;
}
export interface SessionObserver {
  changed(kind: string, ...args: unknown[]): void;
  interaction(
    sessionId: string,
    interaction: Record<string, unknown> & { type: string },
  ): { result: Promise<unknown>; cancel(): void };
}
export interface SessionHarnesses {
  ids(): string[];
  manifest(id: string): { name: string } | undefined;
  adapter(id: string): Promise<Adapter>;
  inspect(id: string): Promise<Inspection>;
  preferredSelection: { provider: string; model: string; reasoningEffort?: string } | undefined;
  modelCatalog(): Promise<{
    default: { provider: string; model: string; reasoningEffort?: string };
    groups: Array<{ id: string; models: Array<{ id: string }> }>;
    routableProviders: string[];
    failures: Array<{ id: string; name: string; message: string }>;
  }>;
  preferences?:
    | {
        configuration(id: string): Promise<
          | {
              permissionModeId?: string | undefined;
              model?: { id: string } | undefined;
              thinkingOptionId?: string | undefined;
            }
          | undefined
        >;
        remember(
          id: string,
          configuration: {
            model?: { id: string };
            thinkingOptionId?: string | undefined;
            permissionModeId?: string | undefined;
          },
        ): Promise<void>;
      }
    | undefined;
}
