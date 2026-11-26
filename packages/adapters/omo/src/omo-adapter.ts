import path from "node:path";

import type {
  HarnessAdapter,
  HarnessError,
  HarnessInspection,
  HarnessModelCatalog,
  HarnessModelRef,
  HarnessResult,
  HarnessSession,
  HarnessSessionCapabilities,
  HarnessSessionState,
  HarnessThinkingOptionId,
  InspectHarnessInput,
  OpenSessionInput,
} from "@codexhost/harness-adapter";
import { runInstallationCommand } from "@codexhost/harness-discovery";
import {
  harnessIdSchema,
  harnessModelRefSchema,
  harnessResolvedModelLabelSchema,
  nativeSessionRefSchema,
  type HarnessId,
  type NativeSessionRef,
} from "@codexhost/shared-contracts";

import {
  resolveOmoExecutable,
  type OmoExecutableDependencies,
  type OmoExecutableInput,
} from "./command.js";
import { OMO_VERSION_TIMEOUT_MS, parseOmoVersion } from "./installation.js";
import {
  createOmoInspectSession,
  type OmoInspectSession,
  type OmoInspectSessionOptions,
} from "./omo-inspect.js";
import {
  OMO_THINKING_LEVELS,
  OMO_THINKING_OPTION_IDS,
  OmoModelCatalogProtocolError,
  type OmoThinkingLevel,
} from "./omo-model-catalog.js";
import { OmoProtocolError } from "./omo-protocol.js";
import { OMO_STAGING_CAPABILITIES, OmoHarnessSession } from "./omo-session.js";
import {
  OmoRpcClosedError,
  OmoRpcCommandTimeoutError,
  OmoRpcFaultError,
  OmoRpcResponseError,
  OmoRpcSession,
  type OmoRpcProcessAdapter,
  type OmoRpcSessionOptions,
  type OmoRpcSessionState,
} from "./omo-rpc-session.js";

const omoHarnessId: HarnessId = harnessIdSchema.parse("omo");

/** Availability asks only whether the CLI runs; it must not stand in for a full inspection. */
const availabilityCatalog: HarnessModelCatalog = { models: [], thinkingOptions: [] };

export type OmoVersionReader = (
  executable: string,
  environment: NodeJS.ProcessEnv,
) => Promise<string>;

export interface OmoAdapterOptions {
  command?: string;
  environment?: NodeJS.ProcessEnv;
  resolveExecutable?: (
    input: OmoExecutableInput,
    dependencies?: OmoExecutableDependencies,
  ) => string | undefined;
  discovery?: OmoExecutableDependencies;
  /** Process boundary for opened Sessions; tests replace it with a synthetic peer. */
  processAdapter?: OmoRpcProcessAdapter;
  /** Process boundary for the short-lived inspect handshake. */
  inspectProcessAdapter?: OmoRpcProcessAdapter;
  /** Installed CLI version read used by the availability path. */
  readVersion?: OmoVersionReader;
  commandTimeoutMs?: number;
  startupTimeoutMs?: number;
  closeTimeoutMs?: number;
}

interface ReadyInspection {
  status: "ready";
  catalog: HarnessModelCatalog;
  capabilities: HarnessSessionCapabilities;
}

function invalidState(message: string): HarnessError {
  return { code: "invalidState", message, retryable: false };
}

function notInstalledError(): HarnessError {
  return {
    code: "notInstalled",
    message:
      "The omo CLI was not found. Install omo from the official guide, or set CODEXHOST_OMO_COMMAND to its executable.",
    retryable: false,
  };
}

function failure(code: HarnessError["code"], message: string): HarnessResult<never> {
  return { ok: false, error: { code, message, retryable: false } };
}

function closedInspection(): HarnessInspection {
  return { status: "unavailable", error: invalidState("OmO Adapter is closed") };
}

function notInstalledInspection(startedAt: number): HarnessInspection {
  return {
    status: "notInstalled",
    error: { ...notInstalledError(), durationMs: Date.now() - startedAt },
  };
}

/**
 * Windows-only startup guidance. Git Bash is never probed and its absence never
 * fails an inspection: OmO can run with `defaultTools`/`shellPath` configured
 * differently, and only a handshake that proves the engine cannot start is
 * reported as unavailable.
 */
function startupGuidance(detail: string): string {
  const base = `OmO could not complete its startup handshake: ${detail}`;
  if (process.platform !== "win32") return base;
  return `${base} Verify the omo installation; OmO shell tools need Git Bash on PATH unless its configuration selects another shell.`;
}

export class OmoAdapter implements HarnessAdapter {
  readonly harnessId: HarnessId = omoHarnessId;
  readonly #command: string | undefined;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #resolveExecutable: NonNullable<OmoAdapterOptions["resolveExecutable"]>;
  readonly #discovery: OmoExecutableDependencies;
  readonly #processAdapter: OmoRpcProcessAdapter | undefined;
  readonly #inspectProcessAdapter: OmoRpcProcessAdapter | undefined;
  readonly #readVersion: OmoVersionReader;
  readonly #commandTimeoutMs: number | undefined;
  readonly #startupTimeoutMs: number | undefined;
  readonly #closeTimeoutMs: number | undefined;
  readonly #inspectionCache = new Map<string, ReadyInspection>();
  readonly #inspectionInFlight = new Map<string, Promise<HarnessInspection>>();
  readonly #inspections = new Set<OmoInspectSession>();
  readonly #liveRpcs = new Set<OmoRpcSession>();
  readonly #sessions = new Set<OmoHarnessSession>();
  #inspectionGeneration = 0;
  #closePromise: Promise<void> | null = null;

  constructor(options: OmoAdapterOptions = {}) {
    this.#command = options.command;
    this.#environment = options.environment ?? process.env;
    this.#resolveExecutable = options.resolveExecutable ?? resolveOmoExecutable;
    this.#discovery = options.discovery ?? {};
    this.#processAdapter = options.processAdapter;
    this.#inspectProcessAdapter = options.inspectProcessAdapter;
    this.#readVersion = options.readVersion ?? readOmoCliVersion;
    this.#commandTimeoutMs = options.commandTimeoutMs;
    this.#startupTimeoutMs = options.startupTimeoutMs;
    this.#closeTimeoutMs = options.closeTimeoutMs;
  }

  async inspect(input: InspectHarnessInput = {}): Promise<HarnessInspection> {
    if (this.#closePromise) return closedInspection();
    const cwd = path.resolve(input.cwd ?? process.cwd());
    // The light path never reads or fills the full catalog cache.
    if (input.purpose === "availability") return this.#inspectAvailability();
    if (input.refresh) this.#invalidateInspections();
    const inFlight = this.#inspectionInFlight.get(cwd);
    if (inFlight) return inFlight;
    const cached = this.#inspectionCache.get(cwd);
    if (cached) return cached;
    return this.#startInspection(cwd);
  }

  async open(input: OpenSessionInput): Promise<HarnessResult<HarnessSession>> {
    if (this.#closePromise) return { ok: false, error: invalidState("OmO Adapter is closed") };
    if (input.cwd.trim().length === 0) {
      return failure("invalidRequest", "OmO Adapter requires cwd");
    }
    // Derivation lands in a later step; refuse before spawning anything.
    if (input.kind === "fork" || input.kind === "rollbackLastTurn") {
      return failure(
        "unsupported",
        "OmO history Fork and last-Turn rollback are not available in this build",
      );
    }
    if (input.kind === "create") {
      if (input.permissionModeId !== undefined) {
        return failure(
          "unsupported",
          "OmO Permission Mode selection is not available in this build",
        );
      }
      if (input.executionPolicy === "unattended-full-access") {
        return failure("unsupported", "OmO unattended full access is not available in this build");
      }
    }
    let nativeRef: NativeSessionRef | undefined;
    let sessionPath: string | undefined;
    if (input.kind === "resume") {
      const parsed = nativeSessionRefSchema.safeParse(input.nativeRef);
      if (!parsed.success) {
        return failure("invalidRequest", "OmO Native Session Ref is invalid");
      }
      if (parsed.data.harnessId !== this.harnessId) {
        return failure(
          "invalidRequest",
          "OmO Adapter cannot open another Harness's Native Session",
        );
      }
      nativeRef = parsed.data;
      sessionPath = omoSessionPathFromRef(parsed.data);
      if (!sessionPath) {
        return failure("invalidRequest", "OmO Native Session Ref has no Session file");
      }
    }
    // `input.environment` is a per-Thread override and wins over the factory snapshot.
    const environment = { ...this.#environment, ...(input.environment ?? {}) };
    const executable = this.#resolve(environment);
    if (!executable) return { ok: false, error: notInstalledError() };
    const cwd = path.resolve(input.cwd);
    const rpc = this.#createRpcSession({
      cwd,
      command: executable,
      environment,
      ...(sessionPath === undefined ? {} : { sessionFile: sessionPath }),
      ...(this.#commandTimeoutMs === undefined ? {} : { commandTimeoutMs: this.#commandTimeoutMs }),
      ...(this.#startupTimeoutMs === undefined ? {} : { startupTimeoutMs: this.#startupTimeoutMs }),
      ...(this.#closeTimeoutMs === undefined ? {} : { closeTimeoutMs: this.#closeTimeoutMs }),
    });
    this.#liveRpcs.add(rpc);
    const rejectOpen = async (error: HarnessError): Promise<HarnessResult<HarnessSession>> => {
      await rpc.close().catch(() => undefined);
      this.#liveRpcs.delete(rpc);
      return { ok: false, error };
    };
    try {
      await rpc.start();
      if (this.#closePromise) {
        return await rejectOpen(invalidState("OmO Adapter is closed"));
      }
      const state = rpc.state;
      if (nativeRef !== undefined && sessionPath !== undefined) {
        if (state.sessionId !== nativeRef.nativeSessionId) {
          return await rejectOpen({
            code: "sessionNotFound",
            message:
              "The resumed OmO Session identity does not match the persisted Native Session Ref",
            retryable: false,
          });
        }
        if (state.sessionFile === null || !sameNativePath(state.sessionFile, sessionPath, cwd)) {
          return await rejectOpen({
            code: "protocolError",
            message: "OmO resumed a different Session file than the persisted Native Session Ref",
            retryable: false,
          });
        }
      }
      const initialState = omoInitialState(state, cwd);
      if (!initialState.nativeRef) {
        return await rejectOpen({
          code: "protocolError",
          message: "OmO did not confirm a resumable Native Session identity",
          retryable: false,
        });
      }
      const session = new OmoHarnessSession(rpc, {
        initialState,
        ...(this.#commandTimeoutMs === undefined
          ? {}
          : { commandTimeoutMs: this.#commandTimeoutMs }),
        ...(this.#closeTimeoutMs === undefined ? {} : { closeTurnTimeoutMs: this.#closeTimeoutMs }),
        onClosed: (closed) => {
          this.#liveRpcs.delete(rpc);
          this.#sessions.delete(closed);
        },
      });
      if (this.#closePromise) {
        return await rejectOpen(invalidState("OmO Adapter is closed"));
      }
      this.#sessions.add(session);
      return { ok: true, value: session };
    } catch (error) {
      await rpc.close().catch(() => undefined);
      this.#liveRpcs.delete(rpc);
      if (this.#closePromise) return { ok: false, error: invalidState("OmO Adapter is closed") };
      return { ok: false, error: openError(error) };
    }
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#shutdown();
    return this.#closePromise;
  }

  async #shutdown(): Promise<void> {
    this.#invalidateInspections();
    const inspections = [...this.#inspections];
    this.#inspections.clear();
    const sessions = [...this.#sessions];
    this.#sessions.clear();
    const rpcs = [...this.#liveRpcs];
    this.#liveRpcs.clear();
    const outcomes = await Promise.allSettled([
      ...inspections.map((session) => session.close()),
      ...sessions.map((session) => session.close()),
      ...rpcs.map((rpc) => rpc.close()),
    ]);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    if (rejected?.status === "rejected") throw rejected.reason;
  }

  #invalidateInspections(): void {
    this.#inspectionCache.clear();
    this.#inspectionInFlight.clear();
    this.#inspectionGeneration += 1;
  }

  #startInspection(cwd: string): Promise<HarnessInspection> {
    const generation = this.#inspectionGeneration;
    const inspection = this.#inspectCwd(cwd).then((result) => {
      if (
        result.status === "ready" &&
        !this.#closePromise &&
        generation === this.#inspectionGeneration &&
        this.#inspectionInFlight.get(cwd) === inspection
      ) {
        this.#inspectionCache.set(cwd, result);
      }
      return result;
    });
    this.#inspectionInFlight.set(cwd, inspection);
    return inspection.finally(() => {
      if (this.#inspectionInFlight.get(cwd) === inspection) {
        this.#inspectionInFlight.delete(cwd);
      }
    });
  }

  async #inspectCwd(cwd: string): Promise<HarnessInspection> {
    const startedAt = Date.now();
    const executable = this.#resolve(this.#environment);
    if (!executable) return notInstalledInspection(startedAt);
    const session = this.#createInspectSession({
      cwd,
      command: executable,
      environment: this.#environment,
      ...(this.#commandTimeoutMs === undefined ? {} : { commandTimeoutMs: this.#commandTimeoutMs }),
      ...(this.#startupTimeoutMs === undefined ? {} : { startupTimeoutMs: this.#startupTimeoutMs }),
      ...(this.#closeTimeoutMs === undefined ? {} : { closeTimeoutMs: this.#closeTimeoutMs }),
    });
    this.#inspections.add(session);
    try {
      const inspected = await session.inspect();
      if (this.#closePromise) return closedInspection();
      return {
        status: "ready",
        catalog: inspected.catalog.catalog,
        capabilities: OMO_STAGING_CAPABILITIES,
      };
    } catch (error) {
      // A deliberate close is not a startup failure of the engine.
      if (this.#closePromise) return closedInspection();
      return inspectionFailure(error, startedAt);
    } finally {
      this.#inspections.delete(session);
      await session.close().catch(() => undefined);
    }
  }

  async #inspectAvailability(): Promise<HarnessInspection> {
    const startedAt = Date.now();
    const executable = this.#resolve(this.#environment);
    if (!executable) return notInstalledInspection(startedAt);
    try {
      await this.#readVersion(executable, this.#environment);
    } catch (error) {
      return {
        status: "unavailable",
        error: {
          code: "unavailable",
          message: startupGuidance(message(error)),
          retryable: true,
          stage: "version",
          durationMs: Date.now() - startedAt,
        },
      };
    }
    if (this.#closePromise) return closedInspection();
    return {
      status: "ready",
      catalog: availabilityCatalog,
      capabilities: OMO_STAGING_CAPABILITIES,
    };
  }

  #resolve(environment: NodeJS.ProcessEnv): string | undefined {
    return this.#resolveExecutable(
      {
        environment,
        ...(this.#command === undefined ? {} : { command: this.#command }),
      },
      this.#discovery,
    );
  }

  #createInspectSession(options: OmoInspectSessionOptions): OmoInspectSession {
    return this.#inspectProcessAdapter
      ? createOmoInspectSession(options, this.#inspectProcessAdapter)
      : createOmoInspectSession(options);
  }

  #createRpcSession(options: OmoRpcSessionOptions): OmoRpcSession {
    return this.#processAdapter
      ? new OmoRpcSession(options, this.#processAdapter)
      : new OmoRpcSession(options);
  }
}

function omoInitialState(state: OmoRpcSessionState, cwd: string): HarnessSessionState {
  const nativeRef = omoNativeSessionRef(state, cwd);
  const effectiveModel = omoEffectiveModelRef(state.model);
  const resolvedModelLabel = omoResolvedModelLabel(state);
  const effectiveThinkingOptionId = omoEffectiveThinkingOption(state.thinkingLevel);
  return {
    ...(nativeRef === undefined ? {} : { nativeRef }),
    ...(effectiveModel === undefined ? {} : { effectiveModel }),
    ...(resolvedModelLabel === undefined ? {} : { resolvedModelLabel }),
    ...(effectiveThinkingOptionId === undefined ? {} : { effectiveThinkingOptionId }),
  };
}

function omoNativeSessionRef(state: OmoRpcSessionState, cwd: string): NativeSessionRef | undefined {
  if (!state.sessionId || !state.sessionFile) return undefined;
  const parsed = nativeSessionRefSchema.safeParse({
    harnessId: omoHarnessId,
    nativeSessionId: state.sessionId,
    locator: { sessionPath: state.sessionFile, cwd },
    formatVersion: 1,
  });
  return parsed.success ? parsed.data : undefined;
}

/** The readable identity the Model Catalog publishes for a unique Provider/Model pair. */
function omoEffectiveModelRef(model: OmoRpcSessionState["model"]): HarnessModelRef | undefined {
  if (!model) return undefined;
  const parsed = harnessModelRefSchema.safeParse({ id: `${model.provider}/${model.id}` });
  return parsed.success ? parsed.data : undefined;
}

function omoResolvedModelLabel(state: OmoRpcSessionState): string | undefined {
  const model = state.model;
  if (!model) return undefined;
  const rawModel = state.raw.model;
  const nativeName =
    isRecord(rawModel) && typeof rawModel.name === "string" && rawModel.name.trim().length > 0
      ? rawModel.name
      : `${model.provider} / ${model.id}`;
  const parsed = harnessResolvedModelLabelSchema.safeParse(nativeName);
  return parsed.success ? parsed.data : undefined;
}

function omoEffectiveThinkingOption(level: string | null): HarnessThinkingOptionId | undefined {
  if (level === null) return undefined;
  if (!(OMO_THINKING_LEVELS as readonly string[]).includes(level)) return undefined;
  return OMO_THINKING_OPTION_IDS[level as OmoThinkingLevel];
}

function omoSessionPathFromRef(ref: NativeSessionRef): string | undefined {
  const locator = ref.locator;
  if (!isRecord(locator)) return undefined;
  const sessionPath = locator.sessionPath;
  return typeof sessionPath === "string" && sessionPath.trim().length > 0 ? sessionPath : undefined;
}

function sameNativePath(left: string, right: string, cwd: string): boolean {
  const normalizedLeft = path.resolve(cwd, left);
  const normalizedRight = path.resolve(cwd, right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function inspectionFailure(error: unknown, startedAt: number): HarnessInspection {
  const durationMs = Date.now() - startedAt;
  if (error instanceof OmoProtocolError) {
    return {
      status: "error",
      error: {
        code: "protocolError",
        message: error.message,
        retryable: false,
        stage: "protocol",
        durationMs,
      },
    };
  }
  if (error instanceof OmoModelCatalogProtocolError) {
    return {
      status: "error",
      error: {
        code: "protocolError",
        message: error.message,
        retryable: false,
        stage: "model-catalog",
        durationMs,
      },
    };
  }
  if (error instanceof OmoRpcFaultError) {
    if (error.kind === "notInstalled") {
      return {
        status: "notInstalled",
        error: { ...notInstalledError(), durationMs },
      };
    }
    if (error.kind === "protocolError") {
      return {
        status: "error",
        error: {
          code: "protocolError",
          message: error.message,
          retryable: false,
          stage: "startup",
          durationMs,
          ...(error.diagnostic ? { diagnostic: error.diagnostic } : {}),
        },
      };
    }
    return {
      status: "unavailable",
      error: {
        code: "unavailable",
        message: startupGuidance(error.message),
        retryable: true,
        stage: "startup",
        durationMs,
        ...(error.diagnostic ? { diagnostic: error.diagnostic } : {}),
      },
    };
  }
  if (error instanceof OmoRpcCommandTimeoutError) {
    return {
      status: "unavailable",
      error: {
        code: "unavailable",
        message: startupGuidance(error.message),
        retryable: true,
        stage: "startup",
        durationMs,
      },
    };
  }
  if (error instanceof OmoRpcResponseError) {
    return {
      status: "unavailable",
      error: {
        code: "nativeFailure",
        message: `OmO refused the inspect handshake: ${error.message}`,
        retryable: false,
        stage: "startup",
        durationMs,
      },
    };
  }
  if (error instanceof OmoRpcClosedError) {
    return {
      status: "unavailable",
      error: {
        code: "invalidState",
        message: error.message,
        retryable: false,
        stage: "startup",
        durationMs,
      },
    };
  }
  return {
    status: "error",
    error: {
      code: "internalError",
      message: message(error),
      retryable: false,
      stage: "startup",
      durationMs,
    },
  };
}

function openError(error: unknown): HarnessError {
  if (error instanceof OmoRpcFaultError) {
    const diagnostic = error.diagnostic ? { diagnostic: error.diagnostic } : {};
    if (error.kind === "notInstalled") {
      return { code: "notInstalled", message: error.message, retryable: false, ...diagnostic };
    }
    if (error.kind === "protocolError") {
      return { code: "protocolError", message: error.message, retryable: false, ...diagnostic };
    }
    if (error.kind === "processExited") {
      return { code: "processExited", message: error.message, retryable: true, ...diagnostic };
    }
    return { code: "unavailable", message: error.message, retryable: true, ...diagnostic };
  }
  if (error instanceof OmoRpcCommandTimeoutError) {
    return { code: "unavailable", message: error.message, retryable: true };
  }
  if (error instanceof OmoRpcResponseError) {
    if (error.category === "authentication") {
      return { code: "authenticationRequired", message: error.message, retryable: false };
    }
    if (error.category === "configuration") {
      return { code: "configurationRequired", message: error.message, retryable: false };
    }
    if (error.category === "busy") {
      return { code: "sessionBusy", message: error.message, retryable: true };
    }
    return { code: "nativeFailure", message: error.message, retryable: false };
  }
  if (error instanceof OmoRpcClosedError) {
    return { code: "invalidState", message: error.message, retryable: false };
  }
  return { code: "internalError", message: message(error), retryable: false };
}

async function readOmoCliVersion(
  executable: string,
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  return parseOmoVersion(
    await runInstallationCommand(executable, ["--version"], environment, OMO_VERSION_TIMEOUT_MS),
  );
}

function message(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
