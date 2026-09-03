import { randomUUID } from "node:crypto";
import path from "node:path";

import {
  sanitizeDiagnosticTail,
  type HarnessAdapter,
  type HarnessError,
  type HarnessInspection,
  type HarnessResult,
  type HarnessSession,
  type HarnessWebUiAction,
  type InspectHarnessInput,
  type OpenSessionInput,
} from "@codexhost/harness-adapter";
import {
  harnessPermissionModeIdSchema,
  harnessIdSchema,
  nativeCheckpointRefSchema,
  nativeSessionRefSchema,
  type HarnessId,
  type HarnessPermissionModeCatalog,
  type HarnessPermissionModeId,
} from "@codexhost/shared-contracts";

import type { DeepSeekModelSelection } from "../model-catalog.js";

import {
  loadModernModelCatalog,
  ModernModelCatalogError,
  type ModernModelCatalogSnapshot,
} from "./catalog.js";
import {
  modernConfigurationHarnessError,
  modernSelectionForModel,
  ModernConfigurationError,
  readModernConfigurationSnapshot,
  selectModernModel,
  selectModernPermissionMode,
} from "./configuration.js";
import { ModernControlStore, ModernControlStoreError } from "./control-store.js";
import { ModernEventGateway, ModernEventGatewayError } from "./event-gateway.js";
import {
  matchesModernForkHistory,
  ModernHistoryError,
  projectModernHistory,
  resolveModernForkBoundary,
} from "./history.js";
import {
  openModernJournal,
  ModernJournalError,
  type ModernJournal,
  type ModernJournalEvent,
  type ModernJournalOptions,
  type ModernJournalRemote,
} from "./journal.js";
import { loadModernPermissionModeCatalog, ModernPermissionModeError } from "./permission-modes.js";
import {
  ModernRemoteConnection,
  ModernRemoteConnectionError,
  type ModernRemoteCallOptions,
  type ModernRemoteConnectionOptions,
} from "./remote-connection.js";
import { modernSessionCapabilities, ModernHarnessSession } from "./session.js";
import {
  redactModernCredential,
  sanitizeModernRemoteFailure,
  type ModernRemoteFailure,
  type ModernRemoteResult,
} from "./wire.js";

const DEEPSEEK_HARNESS_ID = harnessIdSchema.parse("deepseek-harness");
const DELEGATION_PERMISSION_PRESET = "danger-full-access";
const FORK_ORPHAN_MESSAGE =
  "DeepSeek Harness created the Fork child, but codexhost did not adopt it because post-Fork verification failed";

interface ParsedModernForkInput {
  readonly sourceSessionId: string;
  readonly checkpointId: string;
}

interface ModernForkExpectation extends ParsedModernForkInput {
  readonly childSessionId: string;
  readonly atSeq: number;
  readonly minimumSeedLength: number;
  readonly exactSeedLength?: number;
}

export interface ModernDeepSeekHarnessAdapterOptions extends ModernRemoteConnectionOptions {
  readonly toolOutputLimit?: number;
  readonly maxEvents?: number;
  readonly maxHistoryBytes?: number;
  readonly maxBufferedLiveBytes?: number;
  readonly recoveryOpenTimeoutMs?: number;
  readonly promptCorrelationGraceMs?: number;
  readonly acceptedCorrelationTimeoutMs?: number;
}

export interface ModernConnectionLike extends ModernJournalRemote {
  readonly stderrTail?: string;
  call<T>(
    endpoint: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
    options?: ModernRemoteCallOptions,
  ): Promise<ModernRemoteResult<T>>;
  connect(): Promise<void>;
  onFault(listener: (error: ModernRemoteConnectionError) => void): () => void;
  openWebUi?(): Promise<void>;
  close(): Promise<void>;
}

export interface ModernDeepSeekHarnessAdapterDependencies {
  randomUUID(): string;
  now(): number;
  createConnection(options: ModernRemoteConnectionOptions): ModernConnectionLike;
}

const DEFAULT_DEPENDENCIES: ModernDeepSeekHarnessAdapterDependencies = {
  randomUUID,
  now: Date.now,
  createConnection: (options) => new ModernRemoteConnection(options),
};

/** Exact Modern Adapter assembly over the managed Web Remote. */
export class ModernDeepSeekHarnessAdapter implements HarnessAdapter {
  readonly harnessId: HarnessId = DEEPSEEK_HARNESS_ID;
  readonly webUi?: HarnessWebUiAction;
  readonly #connection: ModernConnectionLike;
  readonly #control: ModernControlStore;
  readonly #events: ModernEventGateway;
  readonly #dependencies: ModernDeepSeekHarnessAdapterDependencies;
  readonly #options: ModernDeepSeekHarnessAdapterOptions;
  readonly #inflight = new Set<Promise<unknown>>();
  readonly #sessionIds = new Set<string>();
  readonly #sessions = new Set<ModernHarnessSession>();
  readonly #removeConnectionFaultListener: () => void;
  readonly #lifetime = new AbortController();
  #accepting = true;
  #catalog: ModernModelCatalogSnapshot | undefined;
  #catalogPromise: Promise<ModernModelCatalogSnapshot> | undefined;
  #permissionModes: Awaited<ReturnType<typeof loadModernPermissionModeCatalog>> | undefined;
  #permissionModesLoaded = false;
  #permissionModesPromise:
    Promise<Awaited<ReturnType<typeof loadModernPermissionModeCatalog>>> | undefined;
  #closePromise: Promise<void> | undefined;
  #fault: HarnessError | undefined;
  #declaredEventFailure: HarnessError | undefined;
  #normalClose = false;
  #eventRecovery: Promise<void> | undefined;
  #eventReplacementUsed = false;

  constructor(
    options: ModernDeepSeekHarnessAdapterOptions,
    dependencies: Partial<ModernDeepSeekHarnessAdapterDependencies> = {},
  ) {
    this.#options = options;
    this.#dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencies };
    this.#connection = this.#dependencies.createConnection(options);
    if (options.openWebUi && this.#connection.openWebUi) {
      this.webUi = Object.freeze({
        open: () => this.#track(this.#openWebUi()),
      });
    }
    this.#events = new ModernEventGateway(this.#connection, {
      onGenerationLost: (error) => this.#recoverEvents(error),
      onFailureDeclared: (error) => this.#sealEventFailure(toHarnessError(error, "unavailable")),
      onFault: (error) => this.#fail(toHarnessError(error, "unavailable")),
    });
    this.#control = new ModernControlStore(this.#connection, {
      onFault: (error) => this.#fail(toHarnessError(error, "unavailable")),
    });
    this.#removeConnectionFaultListener = this.#connection.onFault((error) => {
      this.#fail(toHarnessError(error, "unavailable"));
    });
  }

  inspect(input: InspectHarnessInput = {}): Promise<HarnessInspection> {
    return this.#track(this.#inspect(input.refresh === true));
  }

  open(input: OpenSessionInput): Promise<HarnessResult<HarnessSession>> {
    if (!this.#accepting) return Promise.resolve({ ok: false, error: this.#stoppedError() });
    const rejected = validateOpen(input);
    if (rejected) return Promise.resolve({ ok: false, error: rejected });
    return this.#track(this.#open(input));
  }

  close(): Promise<void> {
    if (!this.#closePromise) {
      this.#accepting = false;
      const failure = this.#declaredEventFailure;
      if (failure) {
        this.#closePromise = (async () => {
          await this.#events.fail(failure).catch(() => undefined);
          await this.#performClose(this.#fault ?? failure);
        })();
      } else {
        this.#normalClose = true;
        this.#closePromise = this.#performClose();
      }
    }
    return this.#closePromise;
  }

  async #inspect(refresh: boolean): Promise<HarnessInspection> {
    if (!this.#accepting) {
      return { status: "unavailable", error: this.#stoppedError() };
    }
    const startedAt = this.#dependencies.now();
    let stage = "startup";
    try {
      await this.#connection.connect();
      this.#assertAccepting();
      stage = "model-catalog";
      const catalog = await this.#loadCatalog(refresh);
      this.#assertAccepting();
      stage = "permission-catalog";
      const permissionModes = await this.#loadPermissionModes(refresh);
      this.#assertAccepting();
      return {
        status: "ready",
        catalog: catalog.catalog,
        ...(permissionModes ? { permissionModes } : {}),
        capabilities: modernSessionCapabilities(permissionModes),
        ...(this.webUi ? { webUi: { open: true as const } } : {}),
      };
    } catch (error) {
      const failure = this.#inspectionError(error, stage, startedAt);
      return {
        status: failure.code === "notInstalled" ? "notInstalled" : "unavailable",
        error: failure,
      };
    }
  }

  async #open(input: OpenSessionInput): Promise<HarnessResult<HarnessSession>> {
    let detachControl: (() => void) | undefined;
    let journal: ModernJournal | undefined;
    let reservedSessionId: string | undefined;
    let session: ModernHarnessSession | undefined;
    let forkExpectation: ModernForkExpectation | undefined;
    try {
      const cwd = path.resolve(input.cwd);
      const forkInput = input.kind === "fork" ? parseModernForkInput(input) : undefined;
      let sessionId =
        input.kind === "create"
          ? `session-${this.#dependencies.randomUUID()}`
          : input.kind === "resume"
            ? resumeSessionId(input)
            : undefined;
      if (sessionId) {
        if (this.#sessionIds.has(sessionId)) {
          throw new AdapterOperationError({
            code: "sessionBusy",
            message: "DeepSeek Harness Session is already loaded",
            retryable: true,
          });
        }
        this.#sessionIds.add(sessionId);
        reservedSessionId = sessionId;
        detachControl = this.#control.attach(sessionId);
      }

      await this.#connection.connect();
      this.#assertAccepting();
      const catalog = await this.#loadCatalog(false);
      this.#assertAccepting();
      const permissionModes = await this.#loadPermissionModes(false);
      this.#assertAccepting();
      const createConfiguration =
        input.kind === "create"
          ? resolveCreateConfiguration(input, catalog, permissionModes)
          : undefined;
      try {
        await this.#control.start();
      } catch (error) {
        const failure = toHarnessError(error, "unavailable");
        this.#fail(failure);
        throw new AdapterOperationError(failure);
      }
      this.#assertAccepting();

      if (forkInput) {
        forkExpectation = await this.#forkSession(forkInput, cwd);
        sessionId = forkExpectation.childSessionId;
        if (this.#sessionIds.has(sessionId)) {
          throw forkProtocolError();
        }
        this.#sessionIds.add(sessionId);
        reservedSessionId = sessionId;
        detachControl = this.#control.attach(sessionId);
        this.#assertAccepting();
      }
      if (!sessionId) throw new Error("unreachable Session open mode");

      if (input.kind === "create") {
        await this.#createSession(sessionId, cwd);
        this.#assertAccepting();
        if (createConfiguration?.model) {
          await selectModernModel(
            this.#connection,
            this.#control,
            sessionId,
            catalog,
            createConfiguration.model,
            this.#lifetime.signal,
            {
              allowMissingInitialProjection: true,
            },
          );
          this.#assertAccepting();
        }
        if (createConfiguration?.permissionModeId) {
          await selectModernPermissionMode(
            this.#connection,
            this.#control,
            sessionId,
            permissionModes,
            createConfiguration.permissionModeId,
            this.#lifetime.signal,
          );
          this.#assertAccepting();
        }
      }

      journal = await openModernJournal(
        this.#connection,
        { sessionId, cwd },
        this.#journalOptions(),
      );
      this.#assertAccepting();
      if (forkExpectation) await this.#verifyForkJournal(forkExpectation, journal, cwd);
      this.#control.seed(sessionId, journal.projections);
      this.#assertAccepting();
      const openedConfiguration = readModernConfigurationSnapshot({
        control: this.#control,
        sessionId,
        nativeRef: nativeSessionRefSchema.parse({
          harnessId: this.harnessId,
          nativeSessionId: sessionId,
          formatVersion: 1,
        }),
        modelCatalog: catalog,
        permissionModes,
      });
      verifyCreateConfiguration(createConfiguration, openedConfiguration);
      if (createConfiguration?.unattended && !delegationPermissionIsApplied(journal.events)) {
        throw new AdapterOperationError({
          code: "nativeFailure",
          message: "DeepSeek Harness did not confirm danger-full-access with approval policy never",
          retryable: false,
        });
      }

      const openedSession = new ModernHarnessSession({
        remote: this.#connection,
        journal,
        control: this.#control,
        eventGateway: this.#events,
        modelCatalog: catalog,
        permissionModes,
        sessionId,
        randomUUID: this.#dependencies.randomUUID,
        now: this.#dependencies.now,
        ...(this.#options.toolOutputLimit === undefined
          ? {}
          : { toolOutputLimit: this.#options.toolOutputLimit }),
        ...(this.#options.maxEvents === undefined ? {} : { maxEvents: this.#options.maxEvents }),
        ...(this.#options.maxHistoryBytes === undefined
          ? {}
          : { maxHistoryBytes: this.#options.maxHistoryBytes }),
        ...(this.#options.maxBufferedLiveBytes === undefined
          ? {}
          : { maxBufferedLiveBytes: this.#options.maxBufferedLiveBytes }),
        ...(this.#options.recoveryOpenTimeoutMs === undefined
          ? {}
          : { recoveryOpenTimeoutMs: this.#options.recoveryOpenTimeoutMs }),
        ...(this.#options.promptCorrelationGraceMs === undefined
          ? {}
          : { promptCorrelationGraceMs: this.#options.promptCorrelationGraceMs }),
        ...(this.#options.acceptedCorrelationTimeoutMs === undefined
          ? {}
          : { acceptedCorrelationTimeoutMs: this.#options.acceptedCorrelationTimeoutMs }),
        onClosed: () => {
          detachControl?.();
          detachControl = undefined;
          this.#sessionIds.delete(sessionId);
          this.#sessions.delete(openedSession);
        },
      });
      session = openedSession;
      journal = undefined;
      this.#sessions.add(openedSession);
      await this.#startEvents();
      this.#assertAccepting();
      return { ok: true, value: openedSession };
    } catch (error) {
      await session?.close().catch(() => undefined);
      await journal?.close().catch(() => undefined);
      detachControl?.();
      if (reservedSessionId) this.#sessionIds.delete(reservedSessionId);
      const failure = toHarnessError(error, "nativeFailure");
      if (forkExpectation) {
        return {
          ok: false,
          error: { code: failure.code, message: FORK_ORPHAN_MESSAGE, retryable: false },
        };
      }
      return {
        ok: false,
        error: input.kind === "fork" ? { ...failure, retryable: false } : failure,
      };
    }
  }

  async #openWebUi(): Promise<HarnessResult<void>> {
    if (!this.#accepting || !this.#connection.openWebUi) {
      return { ok: false, error: this.#stoppedError() };
    }
    try {
      await this.#connection.openWebUi();
      this.#assertAccepting();
      return { ok: true, value: undefined };
    } catch (error) {
      return { ok: false, error: toHarnessError(error, "unavailable") };
    }
  }

  async #createSession(requestedSessionId: string, cwd: string): Promise<void> {
    const result = await this.#connection.call<unknown>("session/create", {
      request: { sessionId: requestedSessionId, cwd },
    });
    if (!result.ok) throw new AdapterOperationError(remoteFailure("session/create", result.error));
    if (
      !isRecord(result.value) ||
      !hasExactOptionalKeys(result.value, ["sessionId"], ["agentPreset"]) ||
      result.value.sessionId !== requestedSessionId ||
      (Object.hasOwn(result.value, "agentPreset") && typeof result.value.agentPreset !== "string")
    ) {
      throw new AdapterOperationError({
        code: "protocolError",
        message: "DeepSeek Harness session/create returned an invalid Session identity",
        retryable: false,
      });
    }
  }

  async #forkSession(input: ParsedModernForkInput, cwd: string): Promise<ModernForkExpectation> {
    const source = await openModernJournal(
      this.#connection,
      {
        sessionId: input.sourceSessionId,
        cwd,
      },
      this.#journalOptions(),
    );
    let atSeq: number;
    let minimumSeedLength: number;
    let exactSeedLength: number | undefined;
    try {
      const boundary = resolveModernForkBoundary(source.events, input.checkpointId);
      if (!boundary) throw forkCheckpointError();
      const projected = projectModernHistory({
        harnessId: this.harnessId,
        sessionId: input.sourceSessionId,
        events: boundary.events,
        ...(this.#options.toolOutputLimit === undefined
          ? {}
          : { toolOutputLimit: this.#options.toolOutputLimit }),
        ...(this.#options.maxEvents === undefined ? {} : { maxEvents: this.#options.maxEvents }),
      });
      if (
        projected.incompleteTurn ||
        projected.snapshot.turns.at(-1)?.checkpoint?.checkpointId !== input.checkpointId
      ) {
        throw forkCheckpointError();
      }
      atSeq = boundary.atSeq;
      minimumSeedLength = boundary.events.length;
      if (boundary.events.length < source.events.length) {
        exactSeedLength = boundary.events.length;
      }
    } finally {
      await source.close();
    }

    this.#assertAccepting();
    const result = await this.#connection.call<unknown>(
      "session/fork",
      { request: { sessionId: input.sourceSessionId, atSeq } },
      this.#lifetime.signal,
    );
    if (!result.ok) throw new AdapterOperationError(forkRemoteFailure(result.error));
    if (
      !isRecord(result.value) ||
      !hasExactOptionalKeys(result.value, ["sessionId"], []) ||
      typeof result.value.sessionId !== "string" ||
      result.value.sessionId.trim() === "" ||
      result.value.sessionId === input.sourceSessionId
    ) {
      throw forkProtocolError();
    }
    return {
      ...input,
      childSessionId: result.value.sessionId,
      atSeq,
      minimumSeedLength,
      ...(exactSeedLength === undefined ? {} : { exactSeedLength }),
    };
  }

  async #verifyForkJournal(
    expected: ModernForkExpectation,
    child: ModernJournal,
    cwd: string,
  ): Promise<void> {
    const seedLength = child.header.seedLength;
    if (
      child.header.parentSession !== expected.sourceSessionId ||
      child.header.cwd !== cwd ||
      seedLength === undefined ||
      seedLength < expected.minimumSeedLength ||
      (expected.exactSeedLength !== undefined && seedLength !== expected.exactSeedLength)
    ) {
      throw forkProtocolError();
    }

    const source = await openModernJournal(
      this.#connection,
      {
        sessionId: expected.sourceSessionId,
        cwd,
      },
      this.#journalOptions(),
    );
    try {
      if (source.events.length < seedLength) throw forkProtocolError();
      const inherited = source.events.slice(0, seedLength);
      const boundary = resolveModernForkBoundary(inherited, expected.checkpointId);
      if (!boundary || boundary.atSeq !== expected.atSeq || boundary.events.length !== seedLength) {
        throw forkProtocolError();
      }
      const expectedProjection = projectModernHistory({
        harnessId: this.harnessId,
        sessionId: expected.sourceSessionId,
        events: inherited,
        ...(this.#options.toolOutputLimit === undefined
          ? {}
          : { toolOutputLimit: this.#options.toolOutputLimit }),
        ...(this.#options.maxEvents === undefined ? {} : { maxEvents: this.#options.maxEvents }),
      });
      const childProjection = projectModernHistory({
        harnessId: this.harnessId,
        sessionId: expected.childSessionId,
        events: child.events,
        ...(this.#options.toolOutputLimit === undefined
          ? {}
          : { toolOutputLimit: this.#options.toolOutputLimit }),
        ...(this.#options.maxEvents === undefined ? {} : { maxEvents: this.#options.maxEvents }),
      });
      const turns = childProjection.snapshot.turns;
      if (
        expectedProjection.incompleteTurn !== undefined ||
        expectedProjection.snapshot.turns.at(-1)?.checkpoint?.checkpointId !==
          expected.checkpointId ||
        !matchesModernForkHistory(inherited, child.events) ||
        childProjection.incompleteTurn !== undefined ||
        turns.length !== expectedProjection.snapshot.turns.length ||
        turns.at(-1)?.checkpoint?.checkpointId !== expected.checkpointId ||
        turns.some(
          (turn) =>
            turn.nativeTurnRef.nativeSessionId !== expected.childSessionId ||
            turn.checkpoint?.nativeSessionId !== expected.childSessionId,
        )
      ) {
        throw forkProtocolError();
      }
    } finally {
      await source.close();
    }
  }

  #journalOptions(): ModernJournalOptions {
    return {
      ...(this.#options.maxEvents === undefined ? {} : { maxEvents: this.#options.maxEvents }),
      ...(this.#options.maxHistoryBytes === undefined
        ? {}
        : { maxHistoryBytes: this.#options.maxHistoryBytes }),
      ...(this.#options.maxBufferedLiveBytes === undefined
        ? {}
        : { maxBufferedLiveBytes: this.#options.maxBufferedLiveBytes }),
      ...(this.#options.recoveryOpenTimeoutMs === undefined
        ? {}
        : { openingTimeoutMs: this.#options.recoveryOpenTimeoutMs }),
      signal: this.#lifetime.signal,
    };
  }

  #loadCatalog(refresh: boolean): Promise<ModernModelCatalogSnapshot> {
    if (this.#catalog && !refresh) return Promise.resolve(this.#catalog);
    if (this.#catalogPromise) return this.#catalogPromise;
    const operation = loadModernModelCatalog(this.#connection)
      .then((catalog) => {
        this.#catalog = catalog;
        return catalog;
      })
      .finally(() => {
        if (this.#catalogPromise === operation) this.#catalogPromise = undefined;
      });
    this.#catalogPromise = operation;
    return operation;
  }

  #loadPermissionModes(
    refresh: boolean,
  ): Promise<Awaited<ReturnType<typeof loadModernPermissionModeCatalog>>> {
    if (this.#permissionModesLoaded && !refresh) {
      return Promise.resolve(this.#permissionModes ?? null);
    }
    if (this.#permissionModesPromise) return this.#permissionModesPromise;
    const operation = loadModernPermissionModeCatalog(this.#connection)
      .then((catalog) => {
        this.#permissionModes = catalog;
        this.#permissionModesLoaded = true;
        return catalog;
      })
      .finally(() => {
        if (this.#permissionModesPromise === operation) this.#permissionModesPromise = undefined;
      });
    this.#permissionModesPromise = operation;
    return operation;
  }

  #track<T>(operation: Promise<T>): Promise<T> {
    const tracked = operation.finally(() => this.#inflight.delete(tracked));
    this.#inflight.add(tracked);
    return tracked;
  }

  #assertAccepting(): void {
    if (!this.#accepting) throw new AdapterOperationError(this.#stoppedError());
  }

  #stoppedError(): HarnessError {
    return (
      this.#fault ??
      this.#declaredEventFailure ?? {
        code: "invalidState",
        message: "DeepSeek Harness Adapter is closing",
        retryable: false,
      }
    );
  }

  #inspectionError(error: unknown, stage: string, startedAt: number): HarnessError {
    const normalized = toHarnessError(error, "unavailable");
    const stderrTail = this.#connection.stderrTail;
    return sanitizedHarnessError({
      ...normalized,
      stage,
      durationMs: Math.max(0, this.#dependencies.now() - startedAt),
      ...(normalized.stderrTail || !stderrTail
        ? {}
        : { stderrTail: sanitizeDiagnosticTail(stderrTail) }),
    });
  }

  #fail(error: HarnessError): void {
    if (this.#fault || this.#normalClose) return;
    const failure = sanitizedHarnessError(error);
    this.#fault = failure;
    this.#accepting = false;
    this.#lifetime.abort(new Error("DeepSeek Harness Adapter faulted"));
    for (const session of this.#sessions) session.fault(failure);
    this.#closePromise ??= this.#performClose(failure);
  }

  #sealEventFailure(error: HarnessError): void {
    if (this.#fault || this.#normalClose || this.#declaredEventFailure) return;
    this.#declaredEventFailure = sanitizedHarnessError(error);
    this.#accepting = false;
    this.#lifetime.abort(new Error("DeepSeek Harness event gateway failed"));
  }

  #recoverEvents(error: ModernEventGatewayError): void {
    if (!this.#accepting || this.#eventRecovery) return;
    if (this.#eventReplacementUsed) {
      void this.#events.fail(error).catch(() => undefined);
      return;
    }
    this.#eventReplacementUsed = true;
    const recovery = this.#events
      .replace()
      .catch(async (replacementError: unknown) => {
        await this.#events.fail(replacementError).catch(() => undefined);
      })
      .finally(() => {
        if (this.#eventRecovery === recovery) this.#eventRecovery = undefined;
      });
    this.#eventRecovery = recovery;
    void recovery;
  }

  async #startEvents(): Promise<void> {
    while (this.#eventRecovery) await this.#eventRecovery;
    this.#assertAccepting();
    await this.#events.start();
  }

  async #performClose(failure?: HarnessError): Promise<void> {
    this.#lifetime.abort(new Error("DeepSeek Harness Adapter closed"));
    this.#removeConnectionFaultListener();
    const sessions = [...this.#sessions];
    const sessionClosures = sessions.map((session) => {
      if (failure) session.fault(failure);
      return session.close();
    });
    await Promise.allSettled(sessionClosures);
    await this.#events.close().catch(() => undefined);
    await this.#control.close().catch(() => undefined);
    const connectionClose = this.#connection.close();
    const [connectionResult] = await Promise.allSettled([connectionClose]);
    await Promise.allSettled([...this.#inflight, this.#eventRecovery]);
    if (connectionResult.status === "rejected") throw connectionResult.reason;
  }
}

class AdapterOperationError extends Error {
  constructor(readonly harnessError: HarnessError) {
    super(harnessError.message);
    this.name = "AdapterOperationError";
  }
}

function validateOpen(input: OpenSessionInput): HarnessError | undefined {
  if (typeof input.cwd !== "string" || input.cwd.trim() === "") {
    return {
      code: "invalidRequest",
      message: "DeepSeek Harness requires cwd",
      retryable: false,
    };
  }
  if (input.kind !== "create" && input.kind !== "resume" && input.kind !== "fork") {
    return unsupported(`DeepSeek Harness Modern does not support '${input.kind}'`);
  }
  if (
    input.kind === "create" &&
    input.permissionModeId &&
    input.executionPolicy === "unattended-full-access"
  ) {
    return {
      code: "invalidRequest",
      message: "DeepSeek Harness cannot combine an explicit Permission Mode with delegation",
      retryable: false,
    };
  }
  return undefined;
}

interface ResolvedCreateConfiguration {
  readonly model?: DeepSeekModelSelection;
  readonly permissionModeId?: HarnessPermissionModeId;
  readonly unattended: boolean;
}

function verifyCreateConfiguration(
  requested: ResolvedCreateConfiguration | undefined,
  observed: ReturnType<typeof readModernConfigurationSnapshot>,
): void {
  if (!requested) return;
  if (
    requested.model &&
    (observed.model.selection.provider !== requested.model.provider ||
      observed.model.selection.model !== requested.model.model ||
      (requested.model.reasoningEffort !== undefined &&
        observed.model.selection.reasoningEffort !== requested.model.reasoningEffort))
  ) {
    throw new AdapterOperationError({
      code: "nativeFailure",
      message: "DeepSeek Harness did not preserve the requested Model configuration",
      retryable: false,
    });
  }
  if (
    requested.permissionModeId &&
    observed.state.effectivePermissionModeId !== requested.permissionModeId
  ) {
    throw new AdapterOperationError({
      code: "nativeFailure",
      message: "DeepSeek Harness did not preserve the requested Permission Mode",
      retryable: false,
    });
  }
}

function resolveCreateConfiguration(
  input: Extract<OpenSessionInput, { kind: "create" }>,
  modelCatalog: ModernModelCatalogSnapshot,
  permissionModes: HarnessPermissionModeCatalog | null,
): ResolvedCreateConfiguration {
  let model: DeepSeekModelSelection | undefined;
  if (input.model || input.thinkingOptionId) {
    const requestedModel = input.model ?? modelCatalog.catalog.defaultModel;
    if (!requestedModel) {
      throw new AdapterOperationError({
        code: "invalidRequest",
        message: "DeepSeek Harness has no default Model for the requested Thinking option",
        retryable: false,
      });
    }
    model = modernSelectionForModel(modelCatalog, requestedModel, input.thinkingOptionId);
  }

  const unattended = input.executionPolicy === "unattended-full-access";
  const permissionModeId =
    input.permissionModeId ??
    (unattended ? harnessPermissionModeIdSchema.parse(DELEGATION_PERMISSION_PRESET) : undefined);
  if (permissionModeId && !permissionModes?.modes.some(({ id }) => id === permissionModeId)) {
    throw new AdapterOperationError({
      code: permissionModes ? "invalidRequest" : "unsupported",
      message: unattended
        ? "DeepSeek Harness does not expose the required danger-full-access Permission Mode"
        : "DeepSeek Harness Permission Mode is unavailable",
      retryable: false,
    });
  }
  return {
    ...(model ? { model } : {}),
    ...(permissionModeId ? { permissionModeId } : {}),
    unattended,
  };
}

function delegationPermissionIsApplied(events: readonly ModernJournalEvent[]): boolean {
  let preset: string | undefined;
  let sandboxMode: string | undefined;
  let approvalPolicy: string | undefined;
  for (const event of events) {
    if (!isRecord(event.data)) continue;
    if (event.type === "permission/preset" && typeof event.data.preset === "string") {
      preset = event.data.preset;
    } else if (event.type === "sandbox/mode" && typeof event.data.mode === "string") {
      sandboxMode = event.data.mode;
    } else if (event.type === "approval/policy" && typeof event.data.policy === "string") {
      approvalPolicy = event.data.policy;
    }
  }
  return (
    preset === DELEGATION_PERMISSION_PRESET &&
    sandboxMode === DELEGATION_PERMISSION_PRESET &&
    approvalPolicy === "never"
  );
}

function resumeSessionId(input: Extract<OpenSessionInput, { kind: "resume" }>): string {
  const parsed = nativeSessionRefSchema.safeParse(input.nativeRef);
  if (
    !parsed.success ||
    parsed.data.harnessId !== DEEPSEEK_HARNESS_ID ||
    parsed.data.locator !== undefined
  ) {
    throw new AdapterOperationError({
      code: "invalidRequest",
      message: "DeepSeek Harness cannot resume this Native Session Ref",
      retryable: false,
    });
  }
  return parsed.data.nativeSessionId;
}

function parseModernForkInput(
  input: Extract<OpenSessionInput, { kind: "fork" }>,
): ParsedModernForkInput {
  const source = nativeSessionRefSchema.safeParse(input.sourceRef);
  const checkpoint = nativeCheckpointRefSchema.safeParse(input.checkpoint);
  if (
    !source.success ||
    !checkpoint.success ||
    source.data.harnessId !== DEEPSEEK_HARNESS_ID ||
    checkpoint.data.harnessId !== DEEPSEEK_HARNESS_ID ||
    source.data.locator !== undefined ||
    checkpoint.data.locator !== undefined ||
    checkpoint.data.nativeSessionId !== source.data.nativeSessionId
  ) {
    throw new AdapterOperationError({
      code: "invalidRequest",
      message: "DeepSeek Harness Fork references do not identify one Modern Native Session",
      retryable: false,
    });
  }
  return {
    sourceSessionId: source.data.nativeSessionId,
    checkpointId: checkpoint.data.checkpointId,
  };
}

function forkCheckpointError(): AdapterOperationError {
  return new AdapterOperationError({
    code: "checkpointNotFound",
    message: "DeepSeek Harness Fork Checkpoint is unavailable",
    retryable: false,
  });
}

function forkProtocolError(): AdapterOperationError {
  return new AdapterOperationError({
    code: "protocolError",
    message: "DeepSeek Harness Fork did not reproduce the requested Native history prefix",
    retryable: false,
  });
}

function forkRemoteFailure(failure: ModernRemoteFailure): HarnessError {
  if (failure.code === "session/fork-unavailable") {
    return {
      code: "checkpointNotFound",
      message: "DeepSeek Harness Fork Checkpoint is unavailable",
      retryable: false,
      diagnostic: "session/fork-unavailable",
    };
  }
  if (failure.code === "session/workspace-attach-failed") {
    return {
      code: "nativeFailure",
      message:
        "DeepSeek Harness created the Fork child, but codexhost did not adopt it after workspace attachment failed",
      retryable: false,
      diagnostic: "session/workspace-attach-failed",
    };
  }
  const knownCode = [
    "session/not-found",
    "session/agent-busy",
    "gateway/bad-request",
    "gateway/internal",
    "session/conflict",
    "agent-preset/conflict",
    "authenticationRequired",
    "notInstalled",
    "processExited",
  ].includes(failure.code)
    ? failure.code
    : "session/fork-error";
  return {
    ...nativeFailure(knownCode, "DeepSeek Harness Fork failed"),
    retryable: false,
  };
}

function unsupported(message: string): HarnessError {
  return { code: "unsupported", message, retryable: false };
}

function remoteFailure(endpoint: string, failure: ModernRemoteFailure): HarnessError {
  const safe = sanitizeModernRemoteFailure(failure);
  return nativeFailure(safe.code, `DeepSeek Harness ${endpoint} failed: ${safe.message}`);
}

function nativeFailure(nativeCode: string, message: string): HarnessError {
  const code =
    nativeCode === "session/not-found"
      ? "sessionNotFound"
      : nativeCode === "session/agent-busy"
        ? "sessionBusy"
        : nativeCode === "gateway/bad-request" ||
            nativeCode === "session/conflict" ||
            nativeCode === "agent-preset/conflict"
          ? "invalidRequest"
          : nativeCode === "authenticationRequired" || nativeCode.includes("auth")
            ? "authenticationRequired"
            : nativeCode === "notInstalled"
              ? "notInstalled"
              : nativeCode === "processExited"
                ? "processExited"
                : "nativeFailure";
  return sanitizedHarnessError({
    code,
    message,
    retryable: code === "sessionBusy" || code === "processExited",
    diagnostic: nativeCode,
  });
}

function toHarnessError(error: unknown, fallback: HarnessError["code"]): HarnessError {
  if (error instanceof AdapterOperationError) return sanitizedHarnessError(error.harnessError);
  if (error instanceof ModernEventGatewayError) {
    const code =
      error.code === "closed"
        ? "invalidState"
        : error.code === "protocolError" || error.code === "resourceLimit"
          ? "protocolError"
          : error.code === "remoteError"
            ? "nativeFailure"
            : "unavailable";
    return sanitizedHarnessError({
      code,
      message: error.message,
      retryable: code === "unavailable",
      diagnostic: error.nativeCode ?? error.code,
    });
  }
  if (error instanceof ModernRemoteConnectionError) {
    if (error.code === "cancelled") {
      return sanitizedHarnessError({
        code: "unavailable",
        message: error.message,
        retryable: true,
        diagnostic: error.nativeCode ?? error.code,
      });
    }
    return sanitizedHarnessError({
      code: error.code,
      message: error.message,
      retryable: error.code === "unavailable" || error.code === "processExited",
      diagnostic: error.nativeCode ?? error.code,
    });
  }
  if (error instanceof ModernControlStoreError) {
    const code =
      error.code === "authenticationRequired" ||
      error.code === "notInstalled" ||
      error.code === "processExited" ||
      error.code === "protocolError" ||
      error.code === "unavailable"
        ? error.code
        : error.code === "closed" || error.code === "detached"
          ? "invalidState"
          : error.code === "resourceLimit"
            ? "protocolError"
            : "unavailable";
    return sanitizedHarnessError({
      code,
      message: error.message,
      retryable: code === "unavailable" || code === "processExited",
      diagnostic: error.code,
    });
  }
  if (
    error instanceof ModernJournalError ||
    error instanceof ModernModelCatalogError ||
    error instanceof ModernPermissionModeError
  ) {
    const code =
      error.code === "authenticationRequired" ||
      error.code === "notInstalled" ||
      error.code === "processExited"
        ? error.code
        : error.code === "protocolError" || error.code === "limitExceeded"
          ? "protocolError"
          : "unavailable";
    if (error.code === "remoteError" && error.nativeCode) {
      return nativeFailure(error.nativeCode, error.message);
    }
    return sanitizedHarnessError({
      code,
      message: error.message,
      retryable: code === "unavailable" || code === "processExited",
      diagnostic: error.code,
    });
  }
  if (error instanceof ModernHistoryError) {
    return sanitizedHarnessError({
      code: "protocolError",
      message: error.message,
      retryable: false,
      diagnostic: error.code,
    });
  }
  if (error instanceof ModernConfigurationError) {
    return sanitizedHarnessError(modernConfigurationHarnessError(error));
  }
  return {
    code: fallback,
    message: "DeepSeek Harness operation failed",
    retryable: fallback === "unavailable" || fallback === "nativeFailure",
  };
}

function sanitizedHarnessError(error: HarnessError): HarnessError {
  return {
    ...error,
    message: redactModernCredential(error.message),
    ...(error.diagnostic
      ? { diagnostic: sanitizeDiagnosticTail(redactModernCredential(error.diagnostic)) }
      : {}),
    ...(error.stderrTail
      ? { stderrTail: sanitizeDiagnosticTail(redactModernCredential(error.stderrTail)) }
      : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactOptionalKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Reflect.ownKeys(value).every((key) => typeof key === "string" && allowed.has(key))
  );
}
