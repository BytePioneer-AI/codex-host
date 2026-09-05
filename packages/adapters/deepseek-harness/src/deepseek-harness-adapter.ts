import { randomUUID } from "node:crypto";

import type {
  HarnessAdapter,
  HarnessError,
  HarnessInspection,
  HarnessResult,
  HarnessSession,
  HarnessSessionImportSource,
  HarnessSessionImportCapability,
  HarnessWebUiAction,
  InspectHarnessInput,
  OpenSessionInput,
} from "@codexhost/harness-adapter";
import {
  nativeSessionRefSchema,
  harnessIdSchema,
  type DeepSeekModernSessionCandidate,
  type HarnessId,
} from "@codexhost/shared-contracts";

import {
  DeepSeekGenerationProbeError,
  hasDeepSeekModernAuthenticationFingerprint,
  parseDeepSeekLegacyEndpoint,
  probeDeepSeekExecutableGeneration,
  type DeepSeekExecutableGeneration,
  type ProbeDeepSeekGenerationOptions,
} from "./generation-selector.js";
import {
  DeepSeekHarnessAdapter as LegacyDeepSeekHarnessAdapter,
  type DeepSeekHarnessAdapterDependencies as LegacyAdapterDependencies,
  type DeepSeekHarnessAdapterOptions as LegacyAdapterOptions,
} from "./legacy/deepseek-harness-adapter.js";
import { DeepSeekHarnessTransportError, DeepSeekHostConnection } from "./legacy/host-client.js";
import {
  ModernDeepSeekHarnessAdapter,
  type ModernDeepSeekHarnessAdapterOptions,
} from "./modern/deepseek-harness-adapter.js";

const DEEPSEEK_HARNESS_ID = harnessIdSchema.parse("deepseek-harness");
const EXTERNAL_MODERN_WEB_MESSAGE =
  "检测到配置的端点上已有 DeepSeek Harness Modern Web 实例，但当前 codexhost 实例没有其认证凭据。请关闭该 DSH Web 实例，然后重新运行连接诊断。\nA DeepSeek Harness Modern Web instance is listening at the configured endpoint, but this codexhost instance does not have its authentication credentials. Close that DSH Web instance, then run connection diagnostics again.";

export interface DeepSeekHarnessAdapterOptions {
  readonly command?: string;
  readonly endpoint?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly startupTimeoutMs?: number;
  readonly commandTimeoutMs?: number;
  readonly closeTimeoutMs?: number;
  readonly toolOutputLimit?: number;
  readonly openWebUi?: (url: URL) => Promise<void>;
}

export interface DeepSeekHarnessAdapterDependencies {
  readonly randomUUID?: LegacyAdapterDependencies["randomUUID"];
  readonly createConnection?: LegacyAdapterDependencies["createConnection"];
  readonly probeExecutable?: (
    options: ProbeDeepSeekGenerationOptions,
  ) => Promise<DeepSeekExecutableGeneration>;
  readonly createLegacyAdapter?: (options: LegacyAdapterOptions) => HarnessAdapter;
  readonly createModernAdapter?: (
    options: ModernDeepSeekHarnessAdapterOptions,
  ) => ModernDelegateAdapter;
}

interface ModernDelegateAdapter extends HarnessAdapter {
  readonly sessionImport: HarnessSessionImportCapability;
}

interface DelegateOwner {
  readonly adapter: HarnessAdapter;
  readonly generation: "legacy" | "modern";
  inspection: HarnessInspection;
  closePromise?: Promise<void>;
}

interface ActiveSelection {
  readonly abort: AbortController;
  readonly promise: Promise<DelegateOwner>;
}

class DelegateSelectionError extends Error {
  constructor(readonly harnessError: HarnessError) {
    super(harnessError.message);
    this.name = "DelegateSelectionError";
  }
}

/** Public DeepSeek Adapter that selects one exact DSH protocol generation for its lifetime. */
export class DeepSeekHarnessAdapter implements HarnessAdapter {
  readonly harnessId: HarnessId = DEEPSEEK_HARNESS_ID;
  readonly sessionImport = Object.freeze({
    listCandidates: () => this.#listSessionImportCandidates(),
    resolveCandidate: async (
      nativeSessionId: string,
    ): Promise<HarnessResult<HarnessSessionImportSource>> => {
      const listed = await this.#listSessionImportCandidates();
      if (!listed.ok) return listed;
      const candidate = listed.value.find((entry) => entry.nativeSessionId === nativeSessionId);
      if (!candidate)
        return {
          ok: false,
          error: {
            code: "sessionNotFound",
            message: "DeepSeek Session is no longer available",
            retryable: false,
          },
        };
      return {
        ok: true,
        value: {
          candidate,
          nativeRef: nativeSessionRefSchema.parse({
            harnessId: this.harnessId,
            nativeSessionId,
            formatVersion: 1,
          }),
        },
      };
    },
  } satisfies HarnessSessionImportCapability);
  readonly webUi: HarnessWebUiAction = Object.freeze({
    open: () => this.#openWebUi(),
  });
  readonly #options: DeepSeekHarnessAdapterOptions;
  readonly #probeExecutable: (
    options: ProbeDeepSeekGenerationOptions,
  ) => Promise<DeepSeekExecutableGeneration>;
  readonly #createLegacyAdapter: (options: LegacyAdapterOptions) => HarnessAdapter;
  readonly #createModernAdapter: (
    options: ModernDeepSeekHarnessAdapterOptions,
  ) => ModernDelegateAdapter;
  readonly #randomUUID: NonNullable<DeepSeekHarnessAdapterDependencies["randomUUID"]>;
  #candidate: DelegateOwner | undefined;
  #cleanupFailedDuringClose = false;
  #closePromise: Promise<void> | undefined;
  #closed = false;
  #delegate: DelegateOwner | undefined;
  #failure: HarnessError | undefined;
  #selection: ActiveSelection | undefined;
  #terminalFailure: HarnessError | undefined;

  constructor(
    options: DeepSeekHarnessAdapterOptions = {},
    dependencies: DeepSeekHarnessAdapterDependencies = {},
  ) {
    this.#options = options;
    this.#randomUUID = dependencies.randomUUID ?? randomUUID;
    this.#probeExecutable =
      dependencies.probeExecutable ?? ((input) => probeDeepSeekExecutableGeneration(input));
    const legacyDependencies: LegacyAdapterDependencies = {
      randomUUID: this.#randomUUID,
      createConnection:
        dependencies.createConnection ??
        ((connectionOptions) => new DeepSeekHostConnection(connectionOptions)),
    };
    this.#createLegacyAdapter =
      dependencies.createLegacyAdapter ??
      ((legacyOptions) => new LegacyDeepSeekHarnessAdapter(legacyOptions, legacyDependencies));
    this.#createModernAdapter =
      dependencies.createModernAdapter ??
      ((modernOptions) => new ModernDeepSeekHarnessAdapter(modernOptions));
  }

  async inspect(input: InspectHarnessInput = {}): Promise<HarnessInspection> {
    if (this.#closed) return { status: "unavailable", error: closedError() };
    if (this.#delegate) return this.#delegate.adapter.inspect(input);
    try {
      return (await this.#select(input.refresh === true)).inspection;
    } catch (error) {
      const failure = this.#selectionError(error);
      return {
        status: failure.code === "notInstalled" ? "notInstalled" : "unavailable",
        error: failure,
      };
    }
  }

  async open(input: OpenSessionInput): Promise<HarnessResult<HarnessSession>> {
    try {
      const selected = await this.#select(false);
      if (this.#closed) return { ok: false, error: closedError() };
      return selected.adapter.open(input);
    } catch (error) {
      return { ok: false, error: this.#selectionError(error) };
    }
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#performClose();
    return this.#closePromise;
  }

  async #listSessionImportCandidates(): Promise<
    HarnessResult<readonly DeepSeekModernSessionCandidate[]>
  > {
    try {
      const selected = await this.#select(false);
      if (this.#closed) return { ok: false, error: closedError() };
      if (selected.generation !== "modern") {
        return {
          ok: false,
          error: {
            code: "unsupported",
            message: "DeepSeek Harness Session import requires the Modern protocol",
            retryable: false,
          },
        };
      }
      return (selected.adapter as ModernDelegateAdapter).sessionImport.listCandidates();
    } catch (error) {
      return { ok: false, error: this.#selectionError(error) };
    }
  }

  #openWebUi(): Promise<HarnessResult<void>> {
    if (this.#closed) return Promise.resolve({ ok: false, error: closedError() });
    const webUi = this.#delegate?.adapter.webUi;
    return webUi
      ? webUi.open()
      : Promise.resolve({
          ok: false,
          error: {
            code: "unsupported",
            message: "DeepSeek Harness Web is not managed by this codexhost instance",
            retryable: false,
          },
        });
  }

  #select(refresh: boolean): Promise<DelegateOwner> {
    if (this.#closed) return Promise.reject(new DelegateSelectionError(closedError()));
    if (this.#terminalFailure) {
      return Promise.reject(new DelegateSelectionError(this.#terminalFailure));
    }
    if (this.#delegate) return Promise.resolve(this.#delegate);
    if (this.#selection) return this.#selection.promise;
    if (this.#failure && !refresh) {
      return Promise.reject(new DelegateSelectionError(this.#failure));
    }
    this.#failure = undefined;
    const abort = new AbortController();
    const selection = {} as ActiveSelection;
    const promise = this.#performSelection(abort.signal)
      .then(async (selected) => {
        if (this.#closed || abort.signal.aborted) {
          await this.#closeFailedCandidate(selected);
          throw new DelegateSelectionError(closedError());
        }
        this.#candidate = undefined;
        this.#delegate = selected;
        return selected;
      })
      .catch((error: unknown) => {
        const failure = this.#selectionError(error);
        if (!this.#closed) this.#failure = failure;
        throw new DelegateSelectionError(failure);
      })
      .finally(() => {
        if (this.#selection === selection) this.#selection = undefined;
      });
    Object.assign(selection, { abort, promise });
    this.#selection = selection;
    return promise;
  }

  async #performSelection(signal: AbortSignal): Promise<DelegateOwner> {
    const startedAt = Date.now();
    let endpoint: string;
    try {
      endpoint = parseDeepSeekLegacyEndpoint(this.#options.endpoint);
    } catch (error) {
      throw new DelegateSelectionError(
        this.#withSelectionDiagnostics(error, "wire-handshake", startedAt),
      );
    }
    let executable: DeepSeekExecutableGeneration | undefined;
    let executableFailure: HarnessError | undefined;
    try {
      executable = await this.#probeExecutable({
        ...(this.#options.command ? { command: this.#options.command } : {}),
        ...(this.#options.environment ? { environment: this.#options.environment } : {}),
        signal,
      });
    } catch (error) {
      if (error instanceof DeepSeekGenerationProbeError && error.cleanupFailed) {
        const failure = {
          ...this.#selectionError(error),
          stage: "version",
          durationMs: Math.max(0, Date.now() - startedAt),
        } satisfies HarnessError;
        if (this.#closed || signal.aborted) this.#cleanupFailedDuringClose = true;
        else this.#terminalFailure ??= failure;
        throw new DelegateSelectionError(this.#terminalFailure ?? failure);
      }
      if (signal.aborted) throw new DelegateSelectionError(closedError());
      const failure = this.#selectionError(error);
      executableFailure = {
        ...failure,
        stage:
          failure.stage ?? (failure.code === "notInstalled" ? "resolve-executable" : "version"),
        durationMs: Math.max(0, Date.now() - startedAt),
      };
    }
    if (executableFailure?.code === "unsupported") {
      throw new DelegateSelectionError(executableFailure);
    }

    try {
      return await this.#legacyCandidate(endpoint, true, undefined, signal);
    } catch (error) {
      let endpointFailure = this.#withSelectionDiagnostics(error, "wire-handshake", startedAt);
      if (
        endpointFailure.code === "authenticationRequired" &&
        (await hasDeepSeekModernAuthenticationFingerprint(endpoint, signal))
      ) {
        endpointFailure = {
          ...endpointFailure,
          message: EXTERNAL_MODERN_WEB_MESSAGE,
          retryable: false,
          diagnostic: "externalModernWeb",
        };
      }
      endpointFailure = {
        ...endpointFailure,
        ...(endpointFailure.code === "authenticationRequired" ? { stage: "wire-handshake" } : {}),
        durationMs: Math.max(0, Date.now() - startedAt),
      };
      if (endpointFailure.code !== "unavailable") throw new DelegateSelectionError(endpointFailure);
    }

    if (!executable) {
      throw new DelegateSelectionError(
        executableFailure
          ? { ...executableFailure, durationMs: Math.max(0, Date.now() - startedAt) }
          : {
              code: "notInstalled",
              message: "No supported local DeepSeek Harness executable was found",
              retryable: false,
              stage: "resolve-executable",
              durationMs: Math.max(0, Date.now() - startedAt),
            },
      );
    }
    if (executable.generation === "legacy") {
      try {
        return await this.#legacyCandidate(endpoint, false, executable, signal);
      } catch (error) {
        throw new DelegateSelectionError(
          this.#withSelectionDiagnostics(error, "wire-handshake", startedAt),
        );
      }
    }
    try {
      return await this.#modernCandidate(executable, signal);
    } catch (error) {
      throw new DelegateSelectionError(this.#withSelectionDiagnostics(error, "startup", startedAt));
    }
  }

  async #legacyCandidate(
    endpoint: string,
    attachOnly: boolean,
    executable: DeepSeekExecutableGeneration | undefined,
    signal: AbortSignal,
  ): Promise<DelegateOwner> {
    const options: LegacyAdapterOptions = {
      ...legacyOptions(this.#options),
      endpoint,
      attachOnly,
      ...(executable ? { commandInvocation: executable.command } : {}),
    };
    const adapter = this.#createLegacyAdapter(options);
    const owner: DelegateOwner = {
      adapter,
      generation: "legacy",
      inspection: unavailableInspection("DeepSeek Harness Legacy selection is incomplete"),
    };
    this.#candidate = owner;
    try {
      const inspection = await raceWithAbort(adapter.inspect(), signal, () =>
        this.#closeOwner(owner),
      );
      if (inspection.status !== "ready") {
        throw new DelegateSelectionError(normalizeInspectionError(inspection.error));
      }
      owner.inspection = inspection;
      return owner;
    } catch (error) {
      await this.#closeFailedCandidate(owner);
      throw error;
    }
  }

  async #modernCandidate(
    executable: DeepSeekExecutableGeneration,
    signal: AbortSignal,
  ): Promise<DelegateOwner> {
    const adapter = this.#createModernAdapter({
      ...modernOptions(this.#options),
      command: executable.command.command,
      commandArguments: executable.command.arguments,
    });
    const owner: DelegateOwner = {
      adapter,
      generation: "modern",
      inspection: unavailableInspection("DeepSeek Harness Modern selection is incomplete"),
    };
    this.#candidate = owner;
    try {
      const inspectionPromise = adapter.inspect();
      const inspection = await raceWithAbort(inspectionPromise, signal, () =>
        this.#closeOwner(owner),
      );
      if (inspection.status !== "ready") {
        throw new DelegateSelectionError(normalizeInspectionError(inspection.error));
      }
      owner.inspection = inspection;
      return owner;
    } catch (error) {
      await this.#closeFailedCandidate(owner);
      throw error;
    }
  }

  async #performClose(): Promise<void> {
    this.#closed = true;
    let cleanupFailed = false;
    const selection = this.#selection;
    selection?.abort.abort(new Error("DeepSeek Harness generation selection closed"));
    const candidate = this.#candidate;
    if (candidate) {
      await this.#closeOwner(candidate).catch(() => {
        cleanupFailed = true;
      });
    }
    await selection?.promise.catch(() => undefined);
    const lateCandidate = this.#candidate;
    if (lateCandidate && lateCandidate !== candidate) {
      await this.#closeOwner(lateCandidate).catch(() => {
        cleanupFailed = true;
      });
    }
    const delegate = this.#delegate;
    if (delegate) {
      await this.#closeOwner(delegate).catch(() => {
        cleanupFailed = true;
      });
    }
    if (cleanupFailed || this.#cleanupFailedDuringClose) {
      throw new Error("DeepSeek Harness Adapter cleanup did not complete");
    }
  }

  #closeOwner(owner: DelegateOwner): Promise<void> {
    owner.closePromise ??= owner.adapter.close();
    return owner.closePromise;
  }

  async #closeFailedCandidate(owner: DelegateOwner): Promise<void> {
    try {
      await this.#closeOwner(owner);
    } catch {
      throw this.#recordCleanupFailure();
    } finally {
      if (this.#candidate === owner) this.#candidate = undefined;
    }
  }

  #recordCleanupFailure(): DelegateSelectionError {
    const failure: HarnessError = {
      code: "internalError",
      message: "DeepSeek Harness selection cleanup did not complete",
      retryable: false,
      stage: "cleanup",
    };
    if (this.#closed) this.#cleanupFailedDuringClose = true;
    else this.#terminalFailure ??= failure;
    return new DelegateSelectionError(this.#terminalFailure ?? failure);
  }

  #selectionError(error: unknown): HarnessError {
    if (this.#closed) return closedError();
    if (error instanceof DelegateSelectionError) return error.harnessError;
    if (error instanceof DeepSeekGenerationProbeError) {
      return {
        code: error.code === "cancelled" ? "unavailable" : error.code,
        message: error.message,
        retryable: error.retryable,
        diagnostic: error.code,
        ...(error.stderrTail ? { stderrTail: error.stderrTail } : {}),
      };
    }
    if (error instanceof DeepSeekHarnessTransportError) {
      return {
        code: error.code === "cancelled" ? "unavailable" : error.code,
        message: error.message,
        retryable: error.code === "unavailable" || error.code === "processExited",
        ...(error.nativeCode ? { diagnostic: error.nativeCode } : {}),
      };
    }
    return {
      code: "internalError",
      message: "DeepSeek Harness generation selection failed",
      retryable: false,
    };
  }

  #withSelectionDiagnostics(error: unknown, stage: string, startedAt: number): HarnessError {
    const failure = this.#selectionError(error);
    const diagnosed = {
      ...failure,
      stage: failure.stage ?? stage,
      durationMs: Math.max(0, Date.now() - startedAt),
    };
    if (this.#terminalFailure === failure) this.#terminalFailure = diagnosed;
    return diagnosed;
  }
}

async function raceWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  onAbort: () => Promise<void>,
): Promise<T> {
  if (signal.aborted) {
    await onAbort();
    throw new DelegateSelectionError(closedError());
  }
  let abortListener: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    abortListener = () => {
      void onAbort().then(() => reject(new DelegateSelectionError(closedError())), reject);
    };
    signal.addEventListener("abort", abortListener, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    if (abortListener) signal.removeEventListener("abort", abortListener);
  }
}

function legacyOptions(options: DeepSeekHarnessAdapterOptions): LegacyAdapterOptions {
  return {
    ...(options.command ? { command: options.command } : {}),
    ...(options.environment ? { environment: options.environment } : {}),
    ...(options.startupTimeoutMs === undefined
      ? {}
      : { startupTimeoutMs: options.startupTimeoutMs }),
    ...(options.commandTimeoutMs === undefined
      ? {}
      : { commandTimeoutMs: options.commandTimeoutMs }),
    ...(options.closeTimeoutMs === undefined ? {} : { closeTimeoutMs: options.closeTimeoutMs }),
    ...(options.toolOutputLimit === undefined ? {} : { toolOutputLimit: options.toolOutputLimit }),
  };
}

function modernOptions(
  options: DeepSeekHarnessAdapterOptions,
): Omit<ModernDeepSeekHarnessAdapterOptions, "command" | "commandArguments"> {
  return {
    ...(options.environment ? { environment: options.environment } : {}),
    ...(options.startupTimeoutMs === undefined
      ? {}
      : { startupTimeoutMs: options.startupTimeoutMs }),
    ...(options.closeTimeoutMs === undefined ? {} : { closeTimeoutMs: options.closeTimeoutMs }),
    ...(options.toolOutputLimit === undefined ? {} : { toolOutputLimit: options.toolOutputLimit }),
    ...(options.openWebUi ? { openWebUi: options.openWebUi } : {}),
  };
}

function unavailableInspection(message: string): HarnessInspection {
  return { status: "unavailable", error: { code: "unavailable", message, retryable: true } };
}

type FailedHarnessInspection = Extract<
  HarnessInspection,
  { status: "notInstalled" | "unavailable" | "error" }
>;

function normalizeInspectionError(error: FailedHarnessInspection["error"]): HarnessError {
  const supportedCodes = new Set<HarnessError["code"]>([
    "notInstalled",
    "unavailable",
    "authenticationRequired",
    "sessionNotFound",
    "sessionBusy",
    "checkpointNotFound",
    "unsupported",
    "invalidRequest",
    "invalidState",
    "protocolError",
    "processExited",
    "nativeFailure",
    "internalError",
  ]);
  const code = supportedCodes.has(error.code as HarnessError["code"])
    ? (error.code as HarnessError["code"])
    : "internalError";
  return {
    code,
    message: error.message,
    retryable: error.retryable,
    ...(error.diagnostic === undefined ? {} : { diagnostic: error.diagnostic }),
    ...(error.stage === undefined ? {} : { stage: error.stage }),
    ...(error.durationMs === undefined ? {} : { durationMs: error.durationMs }),
    ...(error.stderrTail === undefined ? {} : { stderrTail: error.stderrTail }),
  };
}

function closedError(): HarnessError {
  return {
    code: "invalidState",
    message: "DeepSeek Harness Adapter is closing",
    retryable: false,
  };
}

export type { DeepSeekHostConnectionLike } from "./legacy/deepseek-harness-adapter.js";
