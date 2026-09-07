import type { ClientSideConnection } from "@agentclientprotocol/sdk";
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

import {
  HermesAcpTransport,
  HermesTransportError,
  withTimeout,
  type HermesOpenInput,
} from "./acp-transport.js";
import {
  catalogModelsFromInventory,
  readHermesModelInventory,
  type HermesInventory,
} from "./hermes-inventory.js";
import { listHermesSessionCandidates, resolveHermesSessionCandidate } from "./hermes-import.js";
import { decodeHermesModelRefId, hermesPermissionModeCatalog } from "./hermes-models.js";
import { HermesSession } from "./hermes-session.js";
import { resolveHermesExecutable } from "./command.js";

const hermesHarnessId: HarnessId = harnessIdSchema.parse("hermes");

export interface HermesAdapterOptions {
  command?: string;
  environment?: NodeJS.ProcessEnv;
  commandTimeoutMs?: number;
  closeTimeoutMs?: number;
}

const IMPORT_TIMEOUT_MS = 20_000;

export class HermesAdapter implements HarnessAdapter {
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
  #inspectionCacheScope: string | null = null;
  #sessions = new Set<HermesSession>();
  #warmTransports = new Map<string, Promise<HermesAcpTransport | null>>();
  #closed = false;

  constructor(options: HermesAdapterOptions = {}) {
    this.#options = options;
  }

  async inspect(input: InspectHarnessInput = {}): Promise<HarnessInspection> {
    const cwd = input.cwd ?? process.cwd();
    if (!input.refresh && this.#inspectionCache && this.#inspectionCacheScope === cwd) {
      return this.#inspectionCache;
    }
    const transport = await this.#takeTransport(cwd);
    let retainedForOpen = false;
    try {
      await transport.inspect();
      // Hermes only exposes models through a live SessionState, and every
      // created Session is persisted immediately, so the ACP probe stays
      // sessionless. The catalog instead comes from the real Hermes model
      // inventory (same substrate as `hermes model`), read via a read-only
      // one-shot against the agent virtualenv — never fabricated.
      const inventory = await this.#readInventory();
      const catalog = catalogModelsFromInventory(inventory);
      const inspection: HarnessInspection = {
        status: "ready",
        catalog: {
          models: catalog.models.map((model) => ({
            ref: model.ref,
            label: model.label,
          })),
          thinkingOptions: [],
          ...(catalog.defaultModel ? { defaultModel: catalog.defaultModel } : {}),
        },
        permissionModes: hermesPermissionModeCatalog(),
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
      this.#inspectionCache = inspection;
      this.#inspectionCacheScope = cwd;
      this.#keepWarmTransport(cwd, transport);
      retainedForOpen = true;
      return inspection;
    } catch (error) {
      return inspectionFromTransportError(error);
    } finally {
      if (!retainedForOpen) await transport.close().catch(() => undefined);
    }
  }

  async #readInventory(): Promise<HermesInventory> {
    const executable = resolveHermesExecutable({
      ...(this.#options.command ? { command: this.#options.command } : {}),
      ...(this.#options.environment ? { environment: this.#options.environment } : {}),
    });
    return readHermesModelInventory(executable);
  }

  async open(input: OpenSessionInput): Promise<HarnessResult<HarnessSession>> {
    if (this.#closed) {
      return failure("invalidState", "Hermes Adapter is closed");
    }
    const cwd = input.cwd;
    if (typeof cwd !== "string" || cwd.trim().length === 0) {
      return failure("invalidRequest", "open requires a cwd");
    }
    let transportOpen: HermesOpenInput;
    if (input.kind === "create") {
      transportOpen = { kind: "create" };
    } else if (input.kind === "resume") {
      if (!input.nativeRef || input.nativeRef.harnessId !== this.harnessId) {
        return failure("invalidRequest", "Native Ref does not belong to Hermes");
      }
      transportOpen = { kind: "resume", sessionId: input.nativeRef.nativeSessionId };
    } else {
      return failure("unsupported", `Hermes does not support ${input.kind}`);
    }

    const transport = await this.#takeTransport(cwd);
    try {
      const open = await transport.open(transportOpen);
      if (input.kind === "create" && input.model) {
        const nativeModelId = decodeHermesModelRefId(input.model.id);
        if (!nativeModelId) {
          await transport.close().catch(() => undefined);
          return failure("invalidRequest", "Model Ref does not belong to Hermes");
        }
        if (open.session.models?.currentModelId !== nativeModelId) {
          await transport.setModel(nativeModelId);
        }
        const availableModels = open.session.models?.availableModels ?? [];
        const selected = availableModels.find((model) => model.modelId === nativeModelId) ?? {
          modelId: nativeModelId,
          name: nativeModelId,
        };
        open.session.models = {
          availableModels: availableModels.some((model) => model.modelId === nativeModelId)
            ? availableModels
            : [...availableModels, selected],
          currentModelId: nativeModelId,
        };
      }
      const session = new HermesSession({
        nativeRef: {
          harnessId: hermesHarnessId,
          nativeSessionId: open.sessionId,
          formatVersion: 1,
        },
        transport,
        open,
        onSettle: (settled) => this.#sessions.delete(settled),
      });
      this.#sessions.add(session);
      this.#primeTransport(cwd);
      return { ok: true, value: session };
    } catch (error) {
      await transport.close().catch(() => undefined);
      if (error instanceof HermesTransportError) {
        if (error.kind === "notInstalled") {
          return failure("notInstalled", error.message);
        }
        if (error.kind === "authenticationRequired") {
          return failure("authenticationRequired", error.message);
        }
        return failure("unavailable", error.message, true);
      }
      return failure(
        "nativeFailure",
        error instanceof Error ? error.message : "Hermes Session open failed",
      );
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#inspectionCache = null;
    const sessions = [...this.#sessions];
    this.#sessions.clear();
    const warmTransports = [...this.#warmTransports.values()];
    this.#warmTransports.clear();
    await Promise.all([
      ...sessions.map((session) => session.close().catch(() => undefined)),
      ...warmTransports.map(async (pending) => {
        const transport = await pending;
        await transport?.close().catch(() => undefined);
      }),
    ]);
  }

  async #takeTransport(cwd: string): Promise<HermesAcpTransport> {
    const pending = this.#warmTransports.get(cwd);
    if (!pending) return this.#createTransport(cwd);
    this.#warmTransports.delete(cwd);
    return (await pending) ?? this.#createTransport(cwd);
  }

  #keepWarmTransport(cwd: string, transport: HermesAcpTransport): void {
    if (this.#closed) {
      void transport.close().catch(() => undefined);
      return;
    }
    this.#warmTransports.set(cwd, Promise.resolve(transport));
  }

  #primeTransport(cwd: string): void {
    if (this.#closed || this.#warmTransports.has(cwd)) return;
    const transport = this.#createTransport(cwd);
    const pending = transport
      .inspect()
      .then(() => transport)
      .catch(async () => {
        await transport.close().catch(() => undefined);
        return null;
      });
    this.#warmTransports.set(cwd, pending);
  }

  #createTransport(cwd: string): HermesAcpTransport {
    const { command, environment, commandTimeoutMs, closeTimeoutMs } = this.#options;
    return new HermesAcpTransport({
      cwd,
      ...(command !== undefined && command.length > 0 ? { command } : {}),
      ...(environment !== undefined ? { environment } : {}),
      ...(commandTimeoutMs !== undefined ? { commandTimeoutMs } : {}),
      ...(closeTimeoutMs !== undefined ? { closeTimeoutMs } : {}),
    });
  }

  /**
   * Run a one-shot query against a fresh Hermes ACP process (initialize +
   * session/list, no user Session creation).
   */
  async #withProbeConnection<T>(
    action: (connection: ClientSideConnection) => Promise<T>,
  ): Promise<T> {
    const transport = this.#createTransport(process.cwd());
    try {
      const connection = await transport.probeConnection();
      return await withTimeout(action(connection), IMPORT_TIMEOUT_MS, "Hermes import discovery");
    } finally {
      await transport.close().catch(() => undefined);
    }
  }

  async #listImportCandidates(): Promise<HarnessResult<readonly HarnessSessionImportCandidate[]>> {
    if (this.#closed) return failure("invalidState", "Hermes Adapter is closed");
    try {
      const candidates = await this.#withProbeConnection((connection) =>
        listHermesSessionCandidates({ connection }),
      );
      return { ok: true, value: candidates };
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
      if (!source) {
        return failure("sessionNotFound", `Hermes Session ${nativeSessionId} no longer exists`);
      }
      return { ok: true, value: source };
    } catch (error) {
      return importFailure(error);
    }
  }
}

function inspectionFromTransportError(error: unknown): HarnessInspection {
  if (error instanceof HermesTransportError) {
    if (error.kind === "notInstalled") {
      return {
        status: "notInstalled",
        error: { code: "HERMES_NOT_FOUND", message: error.message, retryable: false },
      };
    }
    if (error.kind === "authenticationRequired") {
      return {
        status: "unavailable",
        error: { code: "HERMES_AUTH_REQUIRED", message: error.message, retryable: true },
      };
    }
    return {
      status: "error",
      error: { code: "HERMES_UNAVAILABLE", message: error.message, retryable: true },
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
  if (error instanceof HermesTransportError) {
    return failure(
      error.kind === "notInstalled" ? "notInstalled" : "unavailable",
      error.message,
      error.kind !== "notInstalled",
    );
  }
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
