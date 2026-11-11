import type {
  HarnessAdapter,
  HarnessInspection,
  HarnessResult,
  HarnessSession,
  HostUsage,
  InspectHarnessInput,
  OpenSessionInput,
  HostTurnSnapshot,
} from "@codexhost/harness-adapter";
import { type HarnessModelRef, type HarnessThinkingOptionId } from "@codexhost/shared-contracts";
import { BridgeClient } from "./bridge.js";
import { sameDirectory, type BridgeOptions } from "./discovery.js";
import { harnessError, record, TraeError } from "./errors.js";
import { projectHistory, TRAE_CN_ID } from "./history.js";
import { modelCatalog, historyThinking } from "./models.js";
import { contextUsageFromHistory } from "./usage.js";
import { TraeCnSession, sessionCapabilities } from "./session.js";
import { validateReference } from "./reference.js";
import { deriveSession } from "./derivation.js";
import { hasFileEditHistory } from "./file-changes.js";
import { prepareModelSelection } from "./configuration.js";
import { permissionCatalog, preparePermissionSelection } from "./permissions.js";
import { hasBackgroundCommandHistory } from "./commands.js";

export type TraeCnAdapterOptions = Omit<BridgeOptions, "cwd"> & { cwd?: string };

export class TraeCnAdapter implements HarnessAdapter {
  readonly harnessId = TRAE_CN_ID;
  #closed = false;
  #sessions = new Set<TraeCnSession>();
  constructor(private readonly options: TraeCnAdapterOptions = {}) {}

  #bridgeOptions(cwd?: string, environment?: Record<string, string | undefined>): BridgeOptions {
    return {
      ...this.options,
      cwd: cwd ?? this.options.cwd ?? process.cwd(),
      environment: { ...(this.options.environment ?? process.env), ...environment },
    };
  }

  async inspect(input: InspectHarnessInput = {}): Promise<HarnessInspection> {
    let client: BridgeClient | undefined;
    try {
      if (this.#closed) throw new TraeError("invalidState", "TRAE CN Adapter is closed");
      const options = this.#bridgeOptions(input.cwd);
      const connected = await BridgeClient.connect(options);
      client = connected.client;
      const inspection = input.refresh ? await client.inspect(true) : connected.inspection;
      if (this.#closed)
        throw new TraeError("invalidState", "TRAE CN Adapter closed during inspection");
      return {
        status: "ready",
        catalog: modelCatalog(inspection),
        ...(permissionCatalog(inspection)
          ? { permissionModes: permissionCatalog(inspection) }
          : {}),
        capabilities: sessionCapabilities(inspection),
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
      if (input.kind === "fork" || input.kind === "rollbackLastTurn") {
        const options = this.#bridgeOptions(input.cwd, input.environment);
        const connected = await BridgeClient.connect(options);
        client = connected.client;
        const derived = await deriveSession(client, connected.inspection, input);
        const opened = await this.open({
          kind: "resume",
          nativeRef: derived.nativeRef,
          cwd: input.cwd,
          model: derived.model,
          ...(derived.thinkingOptionId ? { thinkingOptionId: derived.thinkingOptionId } : {}),
          ...(derived.permissionModeId ? { permissionModeId: derived.permissionModeId } : {}),
          ...(input.environment ? { environment: input.environment } : {}),
        });
        client.close();
        if (!opened.ok)
          throw new TraeError(
            opened.error.code,
            `Derived Session ${derived.nativeRef.nativeSessionId} was preserved: ${opened.error.message}`,
          );
        return opened;
      }
      if (input.kind === "create" && input.executionPolicy === "unattended-full-access")
        throw new TraeError("unsupported", "TRAE CN unattended permissions have not been verified");
      if (input.kind === "create" && input.thinkingOptionId && !input.model)
        throw new TraeError(
          "configurationRequired",
          "Choose a native model before selecting Thinking",
        );
      const options = this.#bridgeOptions(input.cwd, input.environment);
      const connected = await BridgeClient.connect(options);
      client = connected.client;
      const inspection = connected.inspection;
      let effectiveModel: HarnessModelRef | undefined;
      let effectiveThinking: HarnessThinkingOptionId | undefined;
      let recoveringThinking: HarnessThinkingOptionId | undefined;
      let pendingTurn: HostTurnSnapshot | undefined;
      let initialTurns: HostTurnSnapshot[] = [];
      let initialUsage: HostUsage | null = null;
      let historyHasFileEdits = false;
      let historyHasBackgroundCommands = false;
      let historyTurnCount = 0;
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
        initialUsage = contextUsageFromHistory(native);
        historyHasFileEdits = hasFileEditHistory(native);
        historyHasBackgroundCommands = hasBackgroundCommandHistory(native);
        const snapshot = projectHistory(
          native,
          input.nativeRef.nativeSessionId,
          inspection.agentType,
        );
        const pending = snapshot.turns.filter((turn) => turn.outcome.status === "unknown");
        historyTurnCount = snapshot.turns.length;
        const lastPending = pending[0];
        if (
          [3, 8, 10].includes(Number(native.status)) &&
          pending.length === 1 &&
          lastPending &&
          lastPending === snapshot.turns.at(-1)
        ) {
          pendingTurn = lastPending;
          initialTurns = snapshot.turns.slice(0, -1);
        } else if ([2, 3, 8, 9, 10].includes(Number(native.status)) || pending.length)
          throw new TraeError(
            "sessionBusy",
            "Native pending work is not ready for safe reattachment",
          );
        effectiveModel = snapshot.turns.at(-1)?.model;
        effectiveThinking = historyThinking(native, inspection);
        recoveringThinking = effectiveThinking;
      }
      if (this.#closed) throw new TraeError("invalidState", "TRAE CN Adapter closed during open");
      const selected = input.model ?? effectiveModel;
      const selectedThinking =
        input.model || input.thinkingOptionId ? input.thinkingOptionId : effectiveThinking;
      // A saved Host selection is configuration for the next native request,
      // not a relabeling of the historical Turn that used the previous model.
      if (selected && (input.thinkingOptionId || (input.model && input.kind === "resume"))) {
        if (
          input.thinkingOptionId ||
          (input.model &&
            input.model.id !== effectiveModel?.id &&
            (inspection.configuration?.modelSelection === "per-request" || effectiveModel))
        )
          await prepareModelSelection(
            client,
            inspection,
            selected,
            input.kind === "resume" ? input.nativeRef.nativeSessionId : undefined,
            selectedThinking,
          );
        effectiveModel = selected;
        effectiveThinking = selectedThinking;
      }
      if (this.#closed)
        throw new TraeError("invalidState", "TRAE CN Adapter closed during configuration");
      if (input.permissionModeId)
        await preparePermissionSelection(
          client,
          inspection,
          input.permissionModeId,
          input.kind === "resume" ? input.nativeRef.nativeSessionId : undefined,
        );
      if (this.#closed)
        throw new TraeError("invalidState", "TRAE CN Adapter closed during permission preparation");
      const session = new TraeCnSession({
        client,
        inspection,
        cwd: input.cwd,
        ...(selected ? { model: selected } : {}),
        ...(selectedThinking ? { thinkingOptionId: selectedThinking } : {}),
        ...(recoveringThinking ? { recoveringThinkingOptionId: recoveringThinking } : {}),
        ...(input.permissionModeId ? { permissionModeId: input.permissionModeId } : {}),
        ...(input.kind === "resume" ? { nativeRef: input.nativeRef } : {}),
        initialState: {
          ...(effectiveModel ? { effectiveModel } : {}),
          ...(effectiveThinking ? { effectiveThinkingOptionId: effectiveThinking } : {}),
          ...(input.permissionModeId ? { effectivePermissionModeId: input.permissionModeId } : {}),
        },
        initialUsage,
        historyHasFileEdits,
        historyHasBackgroundCommands,
        historyTurnCount,
        ...(pendingTurn ? { pendingTurn, initialTurns } : {}),
        onClose: () => this.#sessions.delete(session),
      });
      this.#sessions.add(session);
      return { ok: true, value: session };
    } catch (error) {
      client?.close();
      return { ok: false, error: harnessError(error) };
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await Promise.allSettled([...this.#sessions].map((session) => session.close()));
    this.#sessions.clear();
  }
}
