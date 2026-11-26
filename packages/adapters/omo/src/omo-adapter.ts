import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import path from "node:path";

import type {
  ForkSessionInput,
  HarnessAdapter,
  HarnessError,
  HarnessInspection,
  HarnessModelCatalog,
  HarnessResult,
  HarnessSession,
  HarnessSessionCapabilities,
  HarnessSessionState,
  InspectHarnessInput,
  OpenSessionInput,
  RollbackLastTurnSessionInput,
} from "@codexhost/harness-adapter";
import { runInstallationCommand } from "@codexhost/harness-discovery";
import {
  harnessIdSchema,
  nativeCheckpointRefSchema,
  nativeSessionRefSchema,
  type HarnessId,
  type NativeCheckpointRef,
  type NativeSessionRef,
} from "@codexhost/shared-contracts";

import {
  resolveOmoExecutable,
  type OmoExecutableDependencies,
  type OmoExecutableInput,
} from "./command.js";
import {
  OMO_FULL_ACCESS_PRESET,
  OMO_PERMISSION_MODE_CATALOG,
  applyOmoPermissionMode,
  omoConfirmedConfigurationState,
  omoNativePermissionPreset,
  selectOmoModel,
  selectOmoPermissionMode,
  selectOmoThinking,
} from "./omo-configuration.js";
import { OMO_VERSION_TIMEOUT_MS, parseOmoVersion } from "./installation.js";
import {
  mapOmoSnapshot,
  omoHistoryTurnKey,
  readOmoHistory,
  resolveOmoForkBoundary,
  resolveOmoLastTurnBoundary,
  OmoHistoryProtocolError,
} from "./omo-history.js";
import {
  createOmoInspectSession,
  type OmoInspectSession,
  type OmoInspectSessionOptions,
} from "./omo-inspect.js";
import { OmoModelCatalogProtocolError } from "./omo-model-catalog.js";
import { OmoProtocolError } from "./omo-protocol.js";
import { OMO_SESSION_CAPABILITIES, OmoHarnessSession } from "./omo-session.js";
import {
  OmoRpcClosedError,
  OmoRpcCommandTimeoutError,
  OmoRpcFaultError,
  OmoRpcForkCancelledError,
  OmoRpcResponseError,
  OmoRpcSession,
  type OmoNativeModelRef,
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
    if (input.kind === "create") {
      const requestedPreset =
        input.permissionModeId === undefined
          ? undefined
          : omoNativePermissionPreset(input.permissionModeId);
      if (input.permissionModeId !== undefined && requestedPreset === null) {
        return failure(
          "invalidRequest",
          `OmO does not offer Permission Mode '${input.permissionModeId}'`,
        );
      }
      if (
        input.executionPolicy === "unattended-full-access" &&
        requestedPreset !== undefined &&
        requestedPreset !== OMO_FULL_ACCESS_PRESET
      ) {
        return failure(
          "invalidRequest",
          `OmO unattended full access cannot be combined with Permission Mode '${input.permissionModeId}'`,
        );
      }
    }
    let nativeRef: NativeSessionRef | undefined;
    let sessionPath: string | undefined;
    let sourceRef: NativeSessionRef | undefined;
    let checkpoint: NativeCheckpointRef | undefined;
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
    } else if (input.kind === "fork" || input.kind === "rollbackLastTurn") {
      const parsed = nativeSessionRefSchema.safeParse(input.sourceRef);
      if (!parsed.success) {
        return failure("invalidRequest", "OmO source Native Session Ref is invalid");
      }
      if (parsed.data.harnessId !== this.harnessId) {
        return failure(
          "invalidRequest",
          "OmO Adapter cannot derive from another Harness's Native Session",
        );
      }
      sourceRef = parsed.data;
      sessionPath = omoSessionPathFromRef(parsed.data);
      if (!sessionPath) {
        return failure("invalidRequest", "OmO source Native Session Ref has no Session file");
      }
      if (input.kind === "fork") {
        const parsedCheckpoint = nativeCheckpointRefSchema.safeParse(input.checkpoint);
        if (!parsedCheckpoint.success) {
          return failure("checkpointNotFound", "OmO Fork Checkpoint is invalid");
        }
        if (
          parsedCheckpoint.data.harnessId !== this.harnessId ||
          parsedCheckpoint.data.nativeSessionId !== parsed.data.nativeSessionId
        ) {
          return failure(
            "checkpointNotFound",
            "OmO Fork Checkpoint does not belong to the source Native Session",
          );
        }
        checkpoint = parsedCheckpoint.data;
      }
    }
    // `input.environment` is a per-Thread override and wins over the factory snapshot.
    const environment = { ...this.#environment, ...(input.environment ?? {}) };
    const executable = this.#resolve(environment);
    if (!executable) return { ok: false, error: notInstalledError() };
    const cwd = path.resolve(input.cwd);
    let rpc = this.#createRpcSession({
      cwd,
      command: executable,
      environment,
      ...(sessionPath === undefined
        ? {}
        : input.kind === "resume"
          ? { sessionFile: sessionPath }
          : { forkSessionFile: sessionPath }),
      ...(this.#commandTimeoutMs === undefined ? {} : { commandTimeoutMs: this.#commandTimeoutMs }),
      ...(this.#startupTimeoutMs === undefined ? {} : { startupTimeoutMs: this.#startupTimeoutMs }),
      ...(this.#closeTimeoutMs === undefined ? {} : { closeTimeoutMs: this.#closeTimeoutMs }),
    });
    this.#liveRpcs.add(rpc);
    // Native Session files this open creates (the --fork startup copy and any
    // derived fork). A failed open removes them; success keeps them.
    const createdSessionFiles: string[] = [];
    const rejectOpen = async (error: HarnessError): Promise<HarnessResult<HarnessSession>> => {
      await rpc.close().catch(() => undefined);
      this.#liveRpcs.delete(rpc);
      await removeOmoSessionFiles(createdSessionFiles);
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
      let initialState = omoInitialState(state, cwd);
      if (!initialState.nativeRef) {
        return await rejectOpen({
          code: "protocolError",
          message: "OmO did not confirm a resumable Native Session identity",
          retryable: false,
        });
      }
      if (input.kind === "fork" || input.kind === "rollbackLastTurn") {
        if (!sourceRef)
          return await rejectOpen(invalidState("OmO source Native Session is missing"));
        const derived = await openDerivedOmoSession(rpc, input, sourceRef, checkpoint, cwd, {
          ...(this.#commandTimeoutMs === undefined
            ? {}
            : { commandTimeoutMs: this.#commandTimeoutMs }),
          trackCreatedSessionFile: (file) => {
            if (file === null) return;
            if (sessionPath !== undefined && sameAbsolutePath(file, sessionPath)) return;
            if (!createdSessionFiles.some((known) => sameAbsolutePath(known, file))) {
              createdSessionFiles.push(file);
            }
          },
          discardRpc: async (discarded) => {
            await discarded.close().catch(() => undefined);
            this.#liveRpcs.delete(discarded);
          },
          reopenSession: async (file) => {
            const reopened = this.#createRpcSession({
              cwd,
              command: executable,
              environment,
              sessionFile: file,
              ...(this.#commandTimeoutMs === undefined
                ? {}
                : { commandTimeoutMs: this.#commandTimeoutMs }),
              ...(this.#startupTimeoutMs === undefined
                ? {}
                : { startupTimeoutMs: this.#startupTimeoutMs }),
              ...(this.#closeTimeoutMs === undefined
                ? {}
                : { closeTimeoutMs: this.#closeTimeoutMs }),
            });
            this.#liveRpcs.add(reopened);
            try {
              await reopened.start();
            } catch (error) {
              await reopened.close().catch(() => undefined);
              this.#liveRpcs.delete(reopened);
              throw error;
            }
            return reopened;
          },
        });
        if (!derived.ok) return await rejectOpen(derived.error);
        if (derived.value.rpc !== rpc) {
          rpc = derived.value.rpc;
        }
        initialState = omoInitialState(derived.value.state, cwd);
        if (!initialState.nativeRef) {
          return await rejectOpen({
            code: "protocolError",
            message: "OmO derived Session did not confirm a resumable Native Session identity",
            retryable: false,
          });
        }
      }
      // B4: the unattended policy maps to the native full-access preset; an
      // explicit mode at create is applied the same way. Both wait for the
      // engine's applied confirmation and are rejected without a Session
      // when it does not arrive; the published state is rebuilt from the
      // post-application native state.
      const targetPreset =
        input.kind === "create"
          ? input.permissionModeId !== undefined
            ? omoNativePermissionPreset(input.permissionModeId)
            : input.executionPolicy === "unattended-full-access"
              ? OMO_FULL_ACCESS_PRESET
              : undefined
          : undefined;
      if (targetPreset) {
        const applied = await applyOmoPermissionMode(rpc, targetPreset, {
          ...(this.#commandTimeoutMs === undefined ? {} : { timeoutMs: this.#commandTimeoutMs }),
        });
        if (!applied.ok) {
          return await rejectOpen(applied.error);
        }
        initialState = omoInitialState(rpc.state, cwd);
      }
      const session = new OmoHarnessSession(rpc, {
        initialState,
        // Real 5.1.83 keeps an empty session file after a no-conversation close
        // (task-9 evidence); only a create-kind Session this adapter opened may
        // remove it, and only while no Turn was ever accepted.
        ...(input.kind === "create" && state.sessionFile !== null
          ? { prewarmSessionFile: state.sessionFile }
          : {}),
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
      await removeOmoSessionFiles(createdSessionFiles);
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
        permissionModes: OMO_PERMISSION_MODE_CATALOG,
        capabilities: OMO_SESSION_CAPABILITIES,
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
      capabilities: OMO_SESSION_CAPABILITIES,
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
  return {
    ...(nativeRef === undefined ? {} : { nativeRef }),
    ...omoConfirmedConfigurationState(state),
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

function sameAbsolutePath(left: string, right: string): boolean {
  return sameNativePath(path.resolve(left), path.resolve(right), process.cwd());
}

function omoStateCwd(state: OmoRpcSessionState): string | null {
  const cwd = state.raw.cwd;
  return typeof cwd === "string" && cwd.trim().length > 0 ? cwd : null;
}

function sameOmoModel(left: OmoNativeModelRef | null, right: OmoNativeModelRef): boolean {
  return left !== null && left.provider === right.provider && left.id === right.id;
}

async function removeOmoSessionFiles(files: readonly string[]): Promise<void> {
  for (const file of new Set(files)) {
    await unlink(file).catch(() => undefined);
  }
}

interface OmoDerivationOptions {
  commandTimeoutMs?: number;
  trackCreatedSessionFile(file: string | null): void;
  /** Closes an intermediate RPC and removes it from the adapter's live set. */
  discardRpc(rpc: OmoRpcSession): Promise<void>;
  /** Starts a new RPC on an already written Session file. */
  reopenSession(file: string): Promise<OmoRpcSession>;
}

type OpenDerivedOmoSession = HarnessResult<{
  rpc: OmoRpcSession;
  state: OmoRpcSessionState;
}>;

/**
 * Derivation shared by Fork and last-Turn rollback. The engine is started with
 * `--fork <source>` (a full copy of the source branch under a new identity),
 * then `fork(boundary)` cuts that copy back to the retained prefix. `fork`
 * excludes its boundary entry, so a boundary is the next Turn's user entry; a
 * Checkpoint at the branch tip keeps the startup copy, which is the same
 * state `clone` would produce. The source Session is only read by the engine
 * and never receives a navigation command.
 */
async function openDerivedOmoSession(
  rpc: OmoRpcSession,
  input: ForkSessionInput | RollbackLastTurnSessionInput,
  sourceRef: NativeSessionRef,
  checkpoint: NativeCheckpointRef | undefined,
  cwd: string,
  options: OmoDerivationOptions,
): Promise<OpenDerivedOmoSession> {
  const commandOptions =
    options.commandTimeoutMs === undefined ? {} : { timeoutMs: options.commandTimeoutMs };
  const startup = rpc.state;
  if (!startup.sessionId || !startup.sessionFile) {
    return {
      ok: false,
      error: {
        code: "protocolError",
        message: "OmO --fork did not open a persisted Native Session",
        retryable: false,
      },
    };
  }
  // Never delete the source: prove the startup file is a new file before
  // tracking it for failure cleanup.
  const sourcePath = omoSessionPathFromRef(sourceRef);
  if (sourcePath !== undefined && sameAbsolutePath(startup.sessionFile, sourcePath)) {
    return {
      ok: false,
      error: {
        code: "protocolError",
        message: "OmO --fork reopened the source Session file",
        retryable: false,
      },
    };
  }
  options.trackCreatedSessionFile(startup.sessionFile);
  if (startup.sessionId === sourceRef.nativeSessionId) {
    return {
      ok: false,
      error: {
        code: "protocolError",
        message: "OmO --fork did not create a distinct Native Session identity",
        retryable: false,
      },
    };
  }
  const startupCwd = omoStateCwd(startup);
  if (startupCwd === null || !sameAbsolutePath(startupCwd, cwd)) {
    return {
      ok: false,
      error: {
        code: "protocolError",
        message: "OmO --fork did not bind the derived Session to the requested cwd",
        retryable: false,
      },
    };
  }

  const copiedHistory = await readOmoHistory(rpc, commandOptions);
  let derived = startup;
  let forkedFromStartup = false;
  let retainedTurnKeys: string[];
  let checkpointId: string | undefined;
  if (input.kind === "fork") {
    if (!checkpoint) {
      return {
        ok: false,
        error: {
          code: "checkpointNotFound",
          message: "OmO Fork Checkpoint is missing",
          retryable: false,
        },
      };
    }
    checkpointId = checkpoint.checkpointId;
    let plan;
    try {
      plan = resolveOmoForkBoundary(copiedHistory, checkpointId);
    } catch {
      return {
        ok: false,
        error: {
          code: "checkpointNotFound",
          message: "OmO Checkpoint is not on the source Session's active branch",
          retryable: false,
        },
      };
    }
    retainedTurnKeys = plan.retainedTurnKeys;
    if (plan.boundaryEntryId !== null) {
      const forked = await forkOmoBoundary(
        rpc,
        plan.boundaryEntryId,
        "fork",
        startup.sessionId,
        sourceRef.nativeSessionId,
      );
      if (!forked.ok) return forked;
      derived = forked.value;
      forkedFromStartup = true;
      options.trackCreatedSessionFile(derived.sessionFile);
    }
  } else {
    const plan = resolveOmoLastTurnBoundary(copiedHistory);
    if (!plan) {
      return {
        ok: false,
        error: {
          code: "invalidState",
          message: "OmO Native Session has no Turn to roll back",
          retryable: false,
        },
      };
    }
    retainedTurnKeys = plan.retainedTurnKeys;
    const forked = await forkOmoBoundary(
      rpc,
      plan.boundaryEntryId,
      "rollbackLastTurn",
      startup.sessionId,
      sourceRef.nativeSessionId,
    );
    if (!forked.ok) return forked;
    derived = forked.value;
    forkedFromStartup = true;
    options.trackCreatedSessionFile(derived.sessionFile);
  }

  if (!derived.sessionId || !derived.sessionFile) {
    return {
      ok: false,
      error: {
        code: "protocolError",
        message: "OmO derivation did not confirm a persisted Native Session",
        retryable: false,
      },
    };
  }
  if (derived.sessionId === sourceRef.nativeSessionId) {
    return {
      ok: false,
      error: {
        code: "protocolError",
        message: "OmO derivation returned the source Native Session identity",
        retryable: false,
      },
    };
  }
  if (derived.sessionId === startup.sessionId && forkedFromStartup) {
    return {
      ok: false,
      error: {
        code: "protocolError",
        message: "OmO Fork did not switch to a derived Native Session identity",
        retryable: false,
      },
    };
  }

  // A one-Turn source has no prefix to derive: `fork(rootUserEntry)` yields an
  // in-memory blank Session that 5.1.83 never writes (probed: it survives neither
  // a config write nor close). Persist the same identity the engine minted and
  // resume it, then verify the blank history natively. This is the same recovery
  // the Pi adapter performs for an unpersisted empty fork.
  if (
    input.kind === "rollbackLastTurn" &&
    retainedTurnKeys.length === 0 &&
    !existsSync(derived.sessionFile)
  ) {
    return persistBlankOmoSession(rpc, derived, input, startup, cwd, options, commandOptions);
  }

  const derivedHistory = await readOmoHistory(rpc, commandOptions);
  const snapshot = mapOmoSnapshot(derivedHistory, {
    sessionId: derived.sessionId,
    model: derived.model,
  });
  const actualTurnKeys = snapshot.turns.map((turn) => turn.nativeTurnRef.nativeTurnKey);
  if (
    actualTurnKeys.length !== retainedTurnKeys.length ||
    actualTurnKeys.some((key, index) => key !== retainedTurnKeys[index])
  ) {
    return {
      ok: false,
      error: {
        code: "protocolError",
        message: "OmO derived history does not preserve the exact retained Turn prefix",
        retryable: false,
      },
    };
  }
  if (checkpointId !== undefined && actualTurnKeys.at(-1) !== omoHistoryTurnKey(checkpointId)) {
    return {
      ok: false,
      error: {
        code: "protocolError",
        message: "OmO Fork derived history does not end at the requested Checkpoint",
        retryable: false,
      },
    };
  }

  const restored = await restoreDerivedConfiguration(rpc, input, startup, commandOptions);
  if (!restored.ok) return restored;
  return { ok: true, value: { rpc, state: rpc.state } };
}

/**
 * Persists and reopens the blank Session a one-Turn rollback derived. The
 * engine mints the identity and path but writes nothing until a conversation
 * entry exists; the session format accepts a header-only file under that id,
 * and the engine appends its own setup entries when it resumes. The written
 * header records the startup copy as `parentSession`, keeping the derivation
 * chain. The caller owns cleanup of the file on failure.
 */
async function persistBlankOmoSession(
  previous: OmoRpcSession,
  derived: OmoRpcSessionState,
  input: RollbackLastTurnSessionInput,
  startup: OmoRpcSessionState,
  cwd: string,
  options: OmoDerivationOptions,
  commandOptions: { timeoutMs?: number },
): Promise<OpenDerivedOmoSession> {
  const file = derived.sessionFile;
  const id = derived.sessionId;
  if (!file || !id) {
    return {
      ok: false,
      error: {
        code: "protocolError",
        message: "OmO blank rollback has no derived Session identity",
        retryable: false,
      },
    };
  }
  await options.discardRpc(previous);
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id,
        timestamp: new Date().toISOString(),
        cwd,
        ...(startup.sessionFile ? { parentSession: startup.sessionFile } : {}),
      })}\n`,
      "utf8",
    );
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "invalidState",
        message: `OmO could not persist the blank derived Session: ${message(error)}`,
        retryable: false,
      },
    };
  }
  options.trackCreatedSessionFile(file);

  let reopened: OmoRpcSession;
  try {
    reopened = await options.reopenSession(file);
  } catch (error) {
    return { ok: false, error: openError(error) };
  }
  const state = reopened.state;
  const rejectReopened = async (error: HarnessError): Promise<OpenDerivedOmoSession> => {
    await options.discardRpc(reopened);
    return { ok: false, error };
  };
  if (state.sessionId !== id) {
    return rejectReopened({
      code: "protocolError",
      message: "OmO resumed the written blank Session under a different identity",
      retryable: false,
    });
  }
  const stateFile = state.sessionFile;
  if (stateFile === null || !sameAbsolutePath(stateFile, file)) {
    return rejectReopened({
      code: "protocolError",
      message: "OmO resumed a different Session file than the written blank Session",
      retryable: false,
    });
  }
  const stateCwd = omoStateCwd(state);
  if (stateCwd === null || !sameAbsolutePath(stateCwd, cwd)) {
    return rejectReopened({
      code: "protocolError",
      message: "OmO did not bind the blank derived Session to the requested cwd",
      retryable: false,
    });
  }
  const history = await readOmoHistory(reopened, commandOptions);
  if (resolveOmoLastTurnBoundary(history) !== null) {
    return rejectReopened({
      code: "protocolError",
      message: "OmO resumed the blank derived Session with conversation Turns",
      retryable: false,
    });
  }
  const restored = await restoreDerivedConfiguration(reopened, input, startup, commandOptions);
  if (!restored.ok) return rejectReopened(restored.error);
  return { ok: true, value: { rpc: reopened, state: reopened.state } };
}

async function forkOmoBoundary(
  rpc: OmoRpcSession,
  entryId: string,
  kind: "fork" | "rollbackLastTurn",
  startupSessionId: string,
  sourceSessionId: string,
): Promise<HarnessResult<OmoRpcSessionState>> {
  let derived: OmoRpcSessionState;
  try {
    derived = await rpc.fork(entryId);
  } catch (error) {
    if (error instanceof OmoRpcForkCancelledError) {
      return {
        ok: false,
        error: { code: "nativeFailure", message: error.message, retryable: false },
      };
    }
    if (
      error instanceof OmoRpcResponseError &&
      (error.errorCode === "not_found" ||
        error.errorCode === "not_user" ||
        error.errorCode === "stale_leaf")
    ) {
      return {
        ok: false,
        error:
          kind === "fork"
            ? {
                code: "checkpointNotFound",
                message: `OmO Fork boundary is no longer on the active branch: ${error.message}`,
                retryable: false,
              }
            : {
                code: "invalidState",
                message: `OmO Session changed while rolling back the last Turn: ${error.message}`,
                retryable: false,
              },
      };
    }
    throw error;
  }
  if (derived.sessionId === sourceSessionId || derived.sessionId === startupSessionId) {
    return {
      ok: false,
      error: {
        code: "protocolError",
        message: "OmO Fork did not create the required distinct Native Session",
        retryable: false,
      },
    };
  }
  return { ok: true, value: derived };
}

/**
 * Restores the source Session's Model, Thinking, and Permission Mode on the
 * derived Session. Rollback hints (the caller's current configuration) win
 * over the startup snapshot; both are applied natively and confirmed through
 * `get_state`, never published as requested-only values.
 */
async function restoreDerivedConfiguration(
  rpc: OmoRpcSession,
  input: ForkSessionInput | RollbackLastTurnSessionInput,
  startup: OmoRpcSessionState,
  commandOptions: { timeoutMs?: number },
): Promise<HarnessResult<void>> {
  const hints: Pick<
    RollbackLastTurnSessionInput,
    "model" | "thinkingOptionId" | "permissionModeId"
  > = input.kind === "rollbackLastTurn" ? input : {};
  if (hints.model) {
    const current = omoConfirmedConfigurationState(rpc.state).effectiveModel;
    if (!current || current.id !== hints.model.id) {
      const selected = await selectOmoModel(rpc, hints.model, commandOptions);
      if (!selected.ok) return selected;
    }
  } else if (startup.model && !sameOmoModel(rpc.state.model, startup.model)) {
    const failure = await restoreNativeModel(rpc, startup.model, commandOptions);
    if (failure) return { ok: false, error: failure };
  }

  if (hints.thinkingOptionId) {
    if (rpc.state.thinkingLevel !== hints.thinkingOptionId) {
      const selected = await selectOmoThinking(rpc, hints.thinkingOptionId, commandOptions);
      if (!selected.ok) return selected;
    }
  } else if (startup.thinkingLevel !== null && rpc.state.thinkingLevel !== startup.thinkingLevel) {
    const failure = await restoreNativeThinking(rpc, startup.thinkingLevel, commandOptions);
    if (failure) return { ok: false, error: failure };
  }

  if (hints.permissionModeId) {
    const target = omoNativePermissionPreset(hints.permissionModeId);
    const current = rpc.state.effectivePermissionPreset ?? rpc.state.permissionPreset;
    if (target !== current) {
      const selected = await selectOmoPermissionMode(rpc, hints.permissionModeId, commandOptions);
      if (!selected.ok) return selected;
    }
  } else {
    const target = startup.effectivePermissionPreset ?? startup.permissionPreset;
    const current = rpc.state.effectivePermissionPreset ?? rpc.state.permissionPreset;
    if (target !== null && target !== current) {
      const applied = await applyOmoPermissionMode(rpc, target, commandOptions);
      if (!applied.ok) return applied;
    }
  }
  return { ok: true, value: undefined };
}

async function restoreNativeModel(
  rpc: OmoRpcSession,
  model: OmoNativeModelRef,
  commandOptions: { timeoutMs?: number },
): Promise<HarnessError | null> {
  try {
    await rpc.send(
      "set_model",
      { provider: model.provider, modelId: model.id, scope: "session" },
      commandOptions,
    );
  } catch (error) {
    return derivedRestoreError("Model", error);
  }
  const state = await rpc.refreshState(commandOptions);
  return sameOmoModel(state.model, model)
    ? null
    : {
        code: "nativeFailure",
        message: "OmO did not restore the source Session's Model",
        retryable: false,
      };
}

async function restoreNativeThinking(
  rpc: OmoRpcSession,
  level: string,
  commandOptions: { timeoutMs?: number },
): Promise<HarnessError | null> {
  try {
    await rpc.send("set_thinking_level", { level, scope: "turn" }, commandOptions);
  } catch (error) {
    return derivedRestoreError("Thinking level", error);
  }
  const state = await rpc.refreshState(commandOptions);
  return state.thinkingLevel === level
    ? null
    : {
        code: "nativeFailure",
        message: "OmO did not restore the source Session's Thinking level",
        retryable: false,
      };
}

function derivedRestoreError(subject: string, error: unknown): HarnessError {
  if (error instanceof OmoRpcResponseError) {
    if (error.errorCode === "model_not_found") {
      return {
        code: "invalidRequest",
        message: `OmO cannot restore the source Session's ${subject}: ${error.message}`,
        retryable: false,
      };
    }
    if (error.category === "authentication") {
      return {
        code: "authenticationRequired",
        message: `OmO has no credentials for the source Session's ${subject}: ${error.message}`,
        retryable: false,
      };
    }
    if (error.category === "busy") {
      return { code: "sessionBusy", message: error.message, retryable: true };
    }
    if (error.category === "configuration") {
      return { code: "configurationRequired", message: error.message, retryable: false };
    }
  }
  return {
    code: "nativeFailure",
    message: `OmO could not restore the source Session's ${subject}: ${message(error)}`,
    retryable: false,
  };
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
  if (error instanceof OmoHistoryProtocolError) {
    return { code: "protocolError", message: error.message, retryable: false };
  }
  if (error instanceof OmoRpcForkCancelledError) {
    return { code: "nativeFailure", message: error.message, retryable: false };
  }
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
