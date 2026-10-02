import { HERMES_COMMAND_CATALOG } from "./hermes-commands.js";
import type { ClientSideConnection } from "@agentclientprotocol/sdk";
import { createHash } from "node:crypto";
import type {
  HarnessAdapter,
  HarnessError,
  HarnessInspection,
  HarnessResult,
  HarnessSession,
  HarnessSessionImportCandidate,
  HarnessSessionImportSource,
  InspectHarnessInput,
  OpenSessionInput,
} from "@codexhost/harness-adapter";
import { harnessIdSchema, type HarnessId } from "@codexhost/shared-contracts";
import { HermesImportTransport } from "./import-transport.js";
import { HermesTransportError, withTimeout } from "./hermes-transport.js";
import {
  catalogModelsFromInventory,
  HermesInventoryTimeoutError,
  HermesConfigurationRequiredError,
  readHermesModelInventory,
  type HermesInventory,
} from "./hermes-inventory.js";
import { listHermesSessionCandidates, resolveHermesSessionCandidate } from "./hermes-import.js";
import type { HermesSession } from "./hermes-session.js";
import { HermesExecutableError, resolveHermesExecutable } from "./command.js";
import { HermesGatewayTransport } from "./gateway-transport.js";
import type { HermesPythonRuntime } from "./hermes-runtime.js";
import { HermesGatewayHistoryError } from "./gateway-history.js";
import { hermesGatewayThinkingOptions } from "./gateway-session-transport.js";
import {
  gatewayCapabilities,
  gatewayPermissionModes,
  isGatewayRef,
  openGatewaySession,
} from "./gateway-open.js";

const hermesHarnessId: HarnessId = harnessIdSchema.parse("hermes");
export interface HermesAdapterOptions {
  command?: string;
  environment?: NodeJS.ProcessEnv;
  commandTimeoutMs?: number;
  closeTimeoutMs?: number;
}
const IMPORT_TIMEOUT_MS = 20_000;

export class HermesAdapter implements HarnessAdapter {
  readonly commandCatalog = HERMES_COMMAND_CATALOG;
  readonly liveCommandCatalog = true;
  readonly harnessId: HarnessId = hermesHarnessId;
  readonly sessionImport = {
    listCandidates: (): Promise<HarnessResult<readonly HarnessSessionImportCandidate[]>> =>
      this.#listImportCandidates(),
    resolveCandidate: (
      nativeSessionId: string,
    ): Promise<HarnessResult<HarnessSessionImportSource>> =>
      this.#resolveImportCandidate(nativeSessionId),
  };
  #options: HermesAdapterOptions;
  #inspectionCache: HarnessInspection | null = null;
  #lastInventory: HermesInventory | null = null;
  #inventoryRead: Promise<HermesInventory> | null = null;
  #inspectionCacheScope: string | null = null;
  #sessions = new Set<HermesSession>();
  #importTransports = new Set<HermesImportTransport>();
  #closed = false;
  #gatewayTransports = new Set<HermesGatewayTransport>();
  #gatewayProbes = new Map<string, Promise<HermesPythonRuntime | null>>();
  #openingNativeIds = new Set<string>();
  constructor(options: HermesAdapterOptions = {}) {
    this.#options = options;
  }

  async inspect(input: InspectHarnessInput = {}): Promise<HarnessInspection> {
    const cwd = input.cwd ?? process.cwd();
    if (!input.refresh && this.#inspectionCache && this.#inspectionCacheScope === cwd)
      return this.#inspectionCache;
    if (input.refresh) this.#gatewayProbes.clear();
    try {
      if (!(await this.#gatewayRuntime(cwd, this.#effectiveEnvironment())))
        throw new HermesTransportError(
          "unavailable",
          "Hermes requires a Gateway with exclusive turn support; ACP chat fallback is not supported",
        );
      const catalog = catalogModelsFromInventory(await this.#readInventory());
      const inspection: HarnessInspection = {
        status: "ready",
        catalog: {
          models: catalog.models.map(({ ref, label }) => ({ ref, label })),
          thinkingOptions: hermesGatewayThinkingOptions,
          ...(catalog.defaultModel ? { defaultModel: catalog.defaultModel } : {}),
        },
        permissionModes: gatewayPermissionModes(),
        capabilities: gatewayCapabilities,
      };
      if (!this.#closed) {
        this.#inspectionCache = inspection;
        this.#inspectionCacheScope = cwd;
      }
      return inspection;
    } catch (error) {
      return inspectionFromTransportError(error);
    }
  }

  async #readInventory(): Promise<HermesInventory> {
    if (this.#inventoryRead) return this.#inventoryRead;
    const executable = resolveHermesExecutable({
      ...(this.#options.command ? { command: this.#options.command } : {}),
      ...(this.#options.environment ? { environment: this.#options.environment } : {}),
    });
    this.#inventoryRead = readHermesModelInventory(executable, 20_000, {
      ...(this.#options.environment ? { environment: this.#options.environment } : {}),
    })
      .then((inventory) => {
        if (inventory.configured === false) {
          this.#lastInventory = null;
          this.#inspectionCache = null;
          this.#inspectionCacheScope = null;
          throw new HermesConfigurationRequiredError();
        }
        if (!this.#closed) this.#lastInventory = inventory;
        return inventory;
      })
      .catch((error: unknown) => {
        // A slow catalog refresh does not invalidate a previously read native catalog.
        if (error instanceof HermesInventoryTimeoutError && this.#lastInventory)
          return this.#lastInventory;
        throw error;
      })
      .finally(() => {
        this.#inventoryRead = null;
      });
    return this.#inventoryRead;
  }

  async open(input: OpenSessionInput): Promise<HarnessResult<HarnessSession>> {
    if (this.#closed) return failure("invalidState", "Hermes Adapter is closed");
    if (typeof input.cwd !== "string" || input.cwd.trim().length === 0)
      return failure("invalidRequest", "open requires a cwd");
    const nativeRef =
      input.kind === "create" ? null : input.kind === "resume" ? input.nativeRef : input.sourceRef;
    if (nativeRef && nativeRef.harnessId !== this.harnessId)
      return failure("invalidRequest", "Native Ref does not belong to Hermes");
    // Import discovery still returns an unmarked native SessionDB identity.
    // Resume it through the real Gateway; never invent a Gateway locator before confirmation.
    if (nativeRef && !isGatewayRef(nativeRef) && !(input.kind === "resume" && !nativeRef.locator))
      return failure(
        "unsupported",
        "Hermes chat Sessions require a supported Gateway native reference",
      );
    const environment = this.#effectiveEnvironment(input.environment);
    try {
      const runtime = await this.#gatewayRuntime(input.cwd, environment);
      if (this.#closed) return failure("invalidState", "Hermes Adapter is closed");
      if (!runtime)
        return failure(
          "unavailable",
          "Hermes requires a Gateway with exclusive turn support; ACP chat fallback is not supported",
        );
      return this.#openGateway(input, runtime, environment);
    } catch (error) {
      if (error instanceof HermesExecutableError) return failure("notInstalled", error.message);
      return failure(
        "unavailable",
        `Hermes gateway runtime failed: ${error instanceof Error ? error.message : String(error)}`,
        true,
      );
    }
  }

  async #gatewayRuntime(
    cwd: string,
    environment: NodeJS.ProcessEnv,
  ): Promise<HermesPythonRuntime | null> {
    const serialized = JSON.stringify(
      Object.entries(environment).sort(([left], [right]) => left.localeCompare(right)),
    );
    const key = `${cwd}:${createHash("sha256").update(serialized).digest("hex")}`;
    let pending = this.#gatewayProbes.get(key);
    if (!pending) {
      pending = HermesGatewayTransport.probe(
        resolveHermesExecutable({
          ...(this.#options.command ? { command: this.#options.command } : {}),
          environment,
        }),
        cwd,
        environment,
      );
      this.#gatewayProbes.set(key, pending);
    }
    return pending;
  }
  async #openGateway(
    input: OpenSessionInput,
    runtime: HermesPythonRuntime,
    environment: NodeJS.ProcessEnv,
  ): Promise<HarnessResult<HarnessSession>> {
    if (this.#closed) return failure("invalidState", "Hermes Adapter is closed");
    const ref = input.kind === "resume" ? input.nativeRef : null;
    if (input.kind === "fork" || input.kind === "rollbackLastTurn") {
      const source = [...this.#sessions].find(
        (s) => s.initialState.nativeRef?.nativeSessionId === input.sourceRef.nativeSessionId,
      );
      if (source?.busy)
        return failure(
          "sessionBusy",
          "Cannot derive a Hermes Session while its source Turn is active",
          true,
        );
    }
    const owned = (id: string) =>
      this.#openingNativeIds.has(id) ||
      [...this.#sessions].some((session) => session.initialState.nativeRef?.nativeSessionId === id);
    if (ref && owned(ref.nativeSessionId))
      return failure("sessionBusy", "This Hermes Session already has an owner", true);
    if (ref) this.#openingNativeIds.add(ref.nativeSessionId);
    const transport = new HermesGatewayTransport(
      runtime,
      input.cwd,
      environment,
      this.#options.commandTimeoutMs,
    );
    this.#gatewayTransports.add(transport);
    try {
      let inheritedMode: string | undefined;
      if (input.kind === "fork") {
        const source = [...this.#sessions].find(
          (s) => s.initialState.nativeRef?.nativeSessionId === input.sourceRef.nativeSessionId,
        );
        const snapshot = await source?.readSnapshot();
        if (snapshot?.ok) inheritedMode = snapshot.value.state?.effectivePermissionModeId;
      }
      const session = await openGatewaySession(
        input,
        transport,
        (settled) => {
          this.#sessions.delete(settled);
          this.#gatewayTransports.delete(transport);
        },
        inheritedMode,
      );
      if (this.#closed) {
        await session.close();
        return failure("invalidState", "Hermes Adapter is closed");
      }
      this.#sessions.add(session);
      return { ok: true, value: session };
    } catch (error) {
      await transport.close().catch(() => undefined);
      this.#gatewayTransports.delete(transport);
      return failure(
        error instanceof HermesGatewayHistoryError ? error.code : "nativeFailure",
        error instanceof Error ? error.message : "Hermes gateway open failed",
      );
    } finally {
      if (ref) this.#openingNativeIds.delete(ref.nativeSessionId);
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#inspectionCache = null;
    this.#lastInventory = null;
    this.#gatewayProbes.clear();
    const sessions = [...this.#sessions];
    this.#sessions.clear();
    await Promise.all(sessions.map((session) => session.close().catch(() => undefined)));
    await Promise.all(
      [...this.#importTransports].map((transport) => transport.close().catch(() => undefined)),
    );
    this.#importTransports.clear();
    await Promise.all([...this.#gatewayTransports].map((transport) => transport.close()));
    this.#gatewayTransports.clear();
  }
  #effectiveEnvironment(environment?: Record<string, string | undefined>): NodeJS.ProcessEnv {
    return { ...(this.#options.environment ?? process.env), ...(environment ?? {}) };
  }

  /** Import discovery alone retains initialize + session/list on a fresh ACP process. */
  async #withProbeConnection<T>(
    action: (connection: ClientSideConnection) => Promise<T>,
  ): Promise<T> {
    const { command, commandTimeoutMs, closeTimeoutMs } = this.#options;
    const transport = new HermesImportTransport({
      cwd: process.cwd(),
      ...(command ? { command } : {}),
      environment: Object.fromEntries(
        Object.entries(this.#effectiveEnvironment()).filter(
          ([key]) => key !== "CODEXHOST_THREAD_ID",
        ),
      ),
      ...(commandTimeoutMs !== undefined ? { commandTimeoutMs } : {}),
      ...(closeTimeoutMs !== undefined ? { closeTimeoutMs } : {}),
    });
    this.#importTransports.add(transport);
    try {
      const connection = await transport.probeConnection();
      return await withTimeout(action(connection), IMPORT_TIMEOUT_MS, "Hermes import discovery");
    } finally {
      this.#importTransports.delete(transport);
      await transport.close().catch(() => undefined);
    }
  }
  async #listImportCandidates(): Promise<HarnessResult<readonly HarnessSessionImportCandidate[]>> {
    if (this.#closed) return failure("invalidState", "Hermes Adapter is closed");
    try {
      return {
        ok: true,
        value: await this.#withProbeConnection((connection) =>
          listHermesSessionCandidates({ connection }),
        ),
      };
    } catch (error) {
      return importFailure(error);
    }
  }
  async #resolveImportCandidate(
    nativeSessionId: string,
  ): Promise<HarnessResult<HarnessSessionImportSource>> {
    if (this.#closed) return failure("invalidState", "Hermes Adapter is closed");
    try {
      const source = await this.#withProbeConnection((connection) =>
        resolveHermesSessionCandidate({ connection, nativeSessionId }),
      );
      if (!source)
        return failure("sessionNotFound", `Hermes Session ${nativeSessionId} no longer exists`);
      return { ok: true, value: source };
    } catch (error) {
      return importFailure(error);
    }
  }
}
function inspectionFromTransportError(error: unknown): HarnessInspection {
  if (error instanceof HermesExecutableError)
    return {
      status: "notInstalled",
      error: { code: "HERMES_NOT_FOUND", message: error.message, retryable: false },
    };
  if (error instanceof HermesConfigurationRequiredError)
    return {
      status: "unavailable",
      error: { code: "configurationRequired", message: error.message, retryable: false },
    };
  if (error instanceof HermesTransportError) {
    if (error.kind === "notInstalled")
      return {
        status: "notInstalled",
        error: { code: "HERMES_NOT_FOUND", message: error.message, retryable: false },
      };
    if (error.kind === "authenticationRequired")
      return {
        status: "unavailable",
        error: { code: "HERMES_AUTH_REQUIRED", message: error.message, retryable: true },
      };
  }
  return {
    status: "error",
    error: {
      code: "HERMES_UNAVAILABLE",
      message: error instanceof Error ? error.message : "Hermes inspection failed",
      retryable: true,
    },
  };
}
function importFailure(error: unknown): HarnessResult<never> {
  if (error instanceof HermesTransportError)
    return failure(
      error.kind === "notInstalled" ? "notInstalled" : "unavailable",
      error.message,
      error.kind !== "notInstalled",
    );
  return failure(
    "nativeFailure",
    error instanceof Error ? error.message : "Hermes import discovery failed",
  );
}
function failure(
  code: HarnessError["code"],
  message: string,
  retryable = false,
): HarnessResult<never> {
  return { ok: false, error: { code, message, retryable } };
}
