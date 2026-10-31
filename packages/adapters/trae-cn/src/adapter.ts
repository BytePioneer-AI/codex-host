import type {
  HarnessAdapter,
  HarnessInspection,
  HarnessResult,
  HarnessSession,
  InspectHarnessInput,
  OpenSessionInput,
} from "@codexhost/harness-adapter";
import type { HarnessModelRef } from "@codexhost/shared-contracts";
import { BridgeClient } from "./bridge.js";
import { bridgeDirectory, sameDirectory, type BridgeOptions } from "./discovery.js";
import { harnessError, record, TraeError } from "./errors.js";
import { projectHistory, TRAE_CN_ID } from "./history.js";
import { modelCatalog } from "./models.js";
import type { BridgeInspection } from "./protocol.js";
import { TraeCnSession, SESSION_CAPABILITIES, validateReference } from "./session.js";

export type TraeCnAdapterOptions = Omit<BridgeOptions, "cwd"> & { cwd?: string };

export class TraeCnAdapter implements HarnessAdapter {
  readonly harnessId = TRAE_CN_ID;
  #closed = false;
  #sessions = new Set<TraeCnSession>();
  #catalogs = new Map<string, BridgeInspection>();
  constructor(private readonly options: TraeCnAdapterOptions = {}) {}

  #bridgeOptions(cwd?: string, environment?: Record<string, string | undefined>): BridgeOptions {
    return {
      ...this.options,
      cwd: cwd ?? this.options.cwd ?? process.cwd(),
      environment: { ...(this.options.environment ?? process.env), ...environment },
    };
  }

  #catalogKey(options: BridgeOptions): string {
    return JSON.stringify([
      options.cwd,
      bridgeDirectory(options.environment ?? process.env),
      options.app,
    ]);
  }

  async inspect(input: InspectHarnessInput = {}): Promise<HarnessInspection> {
    let client: BridgeClient | undefined;
    try {
      if (this.#closed) throw new TraeError("invalidState", "TRAE CN Adapter is closed");
      const options = this.#bridgeOptions(input.cwd);
      const key = this.#catalogKey(options);
      let inspection = input.refresh ? undefined : this.#catalogs.get(key);
      if (!inspection) {
        const connected = await BridgeClient.connect(options);
        client = connected.client;
        inspection = input.refresh ? await client.inspect(true) : connected.inspection;
        if (this.#closed)
          throw new TraeError("invalidState", "TRAE CN Adapter closed during inspection");
        this.#catalogs.set(key, inspection);
      }
      return {
        status: "ready",
        catalog: modelCatalog(inspection),
        capabilities: SESSION_CAPABILITIES,
      };
    } catch (error) {
      return { status: "unavailable", error: harnessError(error) };
    } finally {
      client?.close();
    }
  }

  async open(input: OpenSessionInput): Promise<HarnessResult<HarnessSession>> {
    let client: BridgeClient | undefined;
    try {
      if (this.#closed) throw new TraeError("invalidState", "TRAE CN Adapter is closed");
      if (input.kind === "fork" || input.kind === "rollbackLastTurn")
        throw new TraeError("unsupported", "TRAE CN history derivation is not implemented");
      if (input.kind === "create" && input.executionPolicy === "unattended-full-access")
        throw new TraeError("unsupported", "TRAE CN unattended permissions have not been verified");
      if (input.thinkingOptionId || input.permissionModeId)
        throw new TraeError(
          "unsupported",
          "TRAE CN Thinking and permission selection are not implemented",
        );
      const options = this.#bridgeOptions(input.cwd, input.environment);
      const connected = await BridgeClient.connect(options);
      client = connected.client;
      const inspection = connected.inspection;
      let effectiveModel: HarnessModelRef | undefined;
      if (input.kind === "resume") {
        validateReference(input.nativeRef, inspection, input.cwd);
        if (
          input.knownTurnRefs?.some(
            (reference) =>
              reference.harnessId !== TRAE_CN_ID ||
              reference.nativeSessionId !== input.nativeRef.nativeSessionId,
          )
        )
          throw new TraeError(
            "invalidRequest",
            "Known Turn reference belongs to a different Session",
          );
        const native = await client.call("snapshot", {
          sessionId: input.nativeRef.nativeSessionId,
        });
        const locator = input.nativeRef.locator;
        if (
          !record(native) ||
          !record(locator) ||
          native.projectId !== locator.projectId ||
          !Array.isArray(native.workspaceFolders) ||
          native.workspaceFolders.length !== 1 ||
          typeof native.workspaceFolders[0] !== "string" ||
          !sameDirectory(native.workspaceFolders[0], input.cwd)
        )
          throw new TraeError(
            "configurationRequired",
            "Native Session Project or workspace does not match its persisted reference",
          );
        const snapshot = projectHistory(
          native,
          input.nativeRef.nativeSessionId,
          inspection.agentType,
        );
        if (snapshot.turns.some((turn) => turn.outcome.status === "unknown"))
          throw new TraeError("sessionBusy", "Native pending Turn recovery is not implemented yet");
        effectiveModel = snapshot.turns.at(-1)?.model;
      }
      if (this.#closed) throw new TraeError("invalidState", "TRAE CN Adapter closed during open");
      this.#catalogs.set(this.#catalogKey(options), inspection);
      const selected = input.model ?? effectiveModel;
      const session = new TraeCnSession({
        client,
        inspection,
        cwd: input.cwd,
        ...(selected ? { model: selected } : {}),
        ...(input.kind === "resume" ? { nativeRef: input.nativeRef } : {}),
        initialState: { ...(effectiveModel ? { effectiveModel } : {}) },
        onClose: () => this.#sessions.delete(session),
      });
      this.#sessions.add(session);
      return { ok: true, value: session };
    } catch (error) {
      client?.close();
      this.#catalogs.clear();
      return { ok: false, error: harnessError(error) };
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await Promise.allSettled([...this.#sessions].map((session) => session.close()));
    this.#sessions.clear();
    this.#catalogs.clear();
  }
}
