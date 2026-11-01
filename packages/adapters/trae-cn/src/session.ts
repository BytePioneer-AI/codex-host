import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  HarnessOutputChannel,
  type HarnessSession,
  type HarnessSessionCapabilities,
  type HarnessSessionState,
  type HarnessOutput,
  type HostEvent,
  type HostUsage,
  type HostCommand,
  type HarnessResult,
  type HostThreadSnapshot,
  type HostTurnSnapshot,
  type TurnStartCommand,
  type TurnStartAccepted,
  type TurnCancelCommand,
  type TurnCancelAccepted,
  type TurnSteerCommand,
  type TurnSteerAccepted,
  type InteractionRespondCommand,
  type InteractionRespondAccepted,
  type ModelSelectCommand,
  type ModelSelectCompleted,
  type ThinkingSelectCommand,
  type ThinkingSelectCompleted,
  type PermissionModeSelectCommand,
  type PermissionModeSelectCompleted,
} from "@codexhost/harness-adapter";
import {
  nativeSessionRefSchema,
  type HarnessModelRef,
  type HarnessThinkingOptionId,
  type HarnessPermissionModeId,
  type NativeSessionRef,
  type HarnessTurnRecovery,
  type HostTurnId,
  harnessTurnRecoverySchema,
} from "@codexhost/shared-contracts";
import type { BridgeClient } from "./bridge.js";
import type { BridgeEvent, BridgeInspection } from "./protocol.js";
import { harnessError, record, TraeError } from "./errors.js";
import {
  nativeModelId,
  confirmedModel,
  confirmedThinking,
  modelThinkingOptions,
  nativeThinkingSelection,
  type NativeThinkingSelection,
} from "./models.js";
import { projectHistory, TRAE_CN_ID, nativeTurnRef as confirmedNativeTurnRef } from "./history.js";
import { LiveItems } from "./live-items.js";
import { NativeInteractions } from "./interactions.js";
import { nativeContextUsage, contextUsageFromHistory } from "./usage.js";
import { hasFileEditHistory } from "./file-changes.js";
import { prepareSelectionChange, preparePermissionChange } from "./configuration.js";
import { nativePermissionId, permissionModeRef } from "./permissions.js";
import { validateReference } from "./reference.js";

// Older Companions do not expose model preparation or history feature flags.
// These capabilities are derived from the negotiated native bridge below.
export const SESSION_CAPABILITIES: HarnessSessionCapabilities = {
  configuration: {
    selectModel: false,
    selectThinkingOption: false,
    selectPermissionMode: false,
    permissionModeScope: "live",
  },
  history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
};

export function sessionCapabilities(
  inspection: BridgeInspection,
  hasFileEdits = false,
  turnCount = 0,
): HarnessSessionCapabilities {
  const fork = inspection.history?.forkFromMessage === true && !hasFileEdits;
  return {
    ...SESSION_CAPABILITIES,
    configuration: {
      ...SESSION_CAPABILITIES.configuration,
      selectModel: inspection.configuration?.modelSelection === "per-request",
      selectPermissionMode: !!inspection.permissions,
      selectThinkingOption:
        inspection.configuration?.thinkingSelection === "per-request" &&
        inspection.models.some((model) => !!model.thinking?.options.length),
    },
    history: {
      fork,
      forkAcrossCwd: false,
      rollbackLastTurn:
        inspection.history?.forkFromMessage === true && (!hasFileEdits || turnCount <= 1),
    },
  };
}

interface ActiveTurn {
  command: TurnStartCommand;
  model: HarnessModelRef | undefined;
  configurationRevision: number;
  thinking: NativeThinkingSelection | undefined;
  thinkingOptionId: HarnessThinkingOptionId | undefined;
  permissionModeId: string | undefined;
  permissionRevision: number;
  messageId: string;
  cancelRequested: boolean;
  admitted: boolean;
  stopRequested: boolean;
  items: LiveItems;
  interactions: NativeInteractions | undefined;
}

export interface SessionOptions {
  client: BridgeClient;
  inspection: BridgeInspection;
  cwd: string;
  model?: HarnessModelRef;
  thinkingOptionId?: HarnessThinkingOptionId;
  permissionModeId?: HarnessPermissionModeId;
  recoveringThinkingOptionId?: HarnessThinkingOptionId;
  nativeRef?: NativeSessionRef;
  initialState?: HarnessSessionState;
  initialUsage?: HostUsage | null;
  historyHasFileEdits?: boolean;
  historyTurnCount?: number;
  recoveringTurn?: HarnessTurnRecovery;
  recoverySnapshot?: HostThreadSnapshot;
  onClose?: () => void;
}

type CommandResult =
  | TurnStartAccepted
  | TurnSteerAccepted
  | TurnCancelAccepted
  | InteractionRespondAccepted
  | ModelSelectCompleted
  | ThinkingSelectCompleted
  | PermissionModeSelectCompleted;

/** A session owns its HTTP observers; the desktop owns native execution. */
export class TraeCnSession implements HarnessSession {
  readonly recoveringTurn?: HarnessTurnRecovery;
  readonly harnessId = TRAE_CN_ID;
  get capabilities(): HarnessSessionCapabilities {
    return sessionCapabilities(
      this.options.inspection,
      this.#historyHasFileEdits,
      this.#historyTurnCount,
    );
  }
  readonly initialUsage: HostUsage | null;
  readonly initialState: HarnessSessionState;
  readonly outputs: AsyncIterable<HarnessOutput>;
  #channel = new HarnessOutputChannel<HarnessOutput>();
  #state: HarnessSessionState;
  #active: ActiveTurn | undefined;
  #closed = false;
  #faulted = false;
  #detach: (() => void) | undefined;
  #observerFail: ((error: unknown) => void) | undefined;
  #recoverySnapshot: HostThreadSnapshot | undefined;
  #usage: HostUsage | null;
  #historyHasFileEdits = false;
  #historyTurnCount = 0;
  #selectedModel: HarnessModelRef | undefined;
  #selectedThinking: HarnessThinkingOptionId | undefined;
  #selectedPermission: HarnessPermissionModeId | undefined;
  #permissionRevision = 0;
  #configurationRevision = 0;
  #configuring = false;

  constructor(private readonly options: SessionOptions) {
    if (options.nativeRef) validateReference(options.nativeRef, options.inspection, options.cwd);
    this.initialState = {
      ...(options.initialState ?? {}),
      ...(options.nativeRef ? { nativeRef: options.nativeRef } : {}),
      ...(options.inspection.configuration?.thinkingSelection === "per-request"
        ? { availableThinkingOptions: modelThinkingOptions(options.inspection, options.model) }
        : {}),
    };
    this.#state = this.initialState;
    this.#selectedModel = options.model ? { ...options.model } : undefined;
    this.#selectedThinking = options.thinkingOptionId;
    this.#selectedPermission = options.permissionModeId;
    if (this.#selectedPermission) nativePermissionId(options.inspection, this.#selectedPermission);
    if (this.#selectedThinking) {
      if (!this.#selectedModel)
        throw new TraeError(
          "configurationRequired",
          "Choose a native model before selecting Thinking",
        );
      nativeThinkingSelection(options.inspection, this.#selectedModel, this.#selectedThinking);
    }
    this.initialUsage = options.initialUsage ?? null;
    this.#usage = this.initialUsage;
    this.#historyHasFileEdits = options.historyHasFileEdits === true;
    this.#historyTurnCount = options.historyTurnCount ?? 0;
    this.outputs = this.#channel.outputs;
    if (options.model) nativeModelId(options.inspection, options.model);
    if (options.recoveringTurn) {
      const recovery = harnessTurnRecoverySchema.parse(options.recoveringTurn);
      if (
        !options.nativeRef ||
        recovery.nativeTurnRef.harnessId !== this.harnessId ||
        recovery.nativeTurnRef.nativeSessionId !== options.nativeRef.nativeSessionId ||
        !options.recoverySnapshot
      )
        throw new TraeError("invalidRequest", "Recovery does not belong to this native Session");
      this.recoveringTurn = recovery;
      this.#recoverySnapshot = structuredClone(options.recoverySnapshot);
      const turn: ActiveTurn = {
        command: { type: "turn.start", turnId: recovery.turnId, input: recovery.input },
        model: options.recoverySnapshot.turns.at(-1)?.model ?? options.model,
        configurationRevision: this.#configurationRevision,
        thinking: undefined,
        thinkingOptionId: options.recoveringThinkingOptionId,
        permissionModeId: undefined,
        permissionRevision: this.#permissionRevision,
        messageId: recovery.nativeTurnRef.nativeTurnKey,
        cancelRequested: false,
        admitted: true,
        stopRequested: false,
        items: new LiveItems(recovery.turnId, (event) => this.#emit(event)),
        interactions: undefined,
      };
      this.#active = turn;
      queueMicrotask(() => {
        void this.#run(turn, true);
      });
    }
  }

  #emit(event: HostEvent): void {
    if (!this.#closed) this.#channel.emit({ kind: "event", event });
  }

  #setState(state: HarnessSessionState): void {
    this.#state = state;
    this.#emit({ type: "session.state.changed", state });
  }

  #setUsage(usage: HostUsage, turnId?: HostTurnId): void {
    if (JSON.stringify(usage) === JSON.stringify(this.#usage)) return;
    this.#usage = usage;
    this.#emit({
      type: "session.usage.changed",
      usage,
      ...(turnId ? { observedForTurnId: turnId } : {}),
    });
  }

  async refreshUsage(): Promise<void> {
    if (this.#closed || this.#active || !this.#state.nativeRef) return;
    try {
      const value = await this.options.client.call("snapshot", {
        sessionId: this.#state.nativeRef.nativeSessionId,
      });
      if (this.#closed || this.#active) return;
      const usage = contextUsageFromHistory(value);
      if (usage) this.#setUsage(usage);
    } catch {
      /* Usage refresh must not turn an otherwise usable Session into a failure. */
    }
  }

  async readSnapshot(): Promise<HarnessResult<HostThreadSnapshot>> {
    if (this.#closed) return this.#snapshot();
    if (this.#active && this.#recoverySnapshot)
      return {
        ok: true,
        value: { ...structuredClone(this.#recoverySnapshot), state: this.#state },
      };
    if (this.#active)
      return {
        ok: false,
        error: harnessError(
          new TraeError(
            "sessionBusy",
            "Native pending history is not yet a complete public snapshot",
          ),
        ),
      };
    return this.#snapshot();
  }

  async #snapshot(allowPending = false): Promise<HarnessResult<HostThreadSnapshot>> {
    if (this.#closed)
      return {
        ok: false,
        error: harnessError(new TraeError("invalidState", "TRAE CN Session is closed")),
      };
    try {
      const nativeRef = this.#state.nativeRef;
      if (!nativeRef) return { ok: true, value: { turns: [], state: this.#state } };
      const value = await this.options.client.call("snapshot", {
        sessionId: nativeRef.nativeSessionId,
      });
      if (!allowPending && record(value) && [2, 3, 8, 9, 10].includes(Number(value.status)))
        throw new TraeError("sessionBusy", "The native Session has active work");
      const usage = contextUsageFromHistory(value, this.#active?.messageId);
      this.#historyHasFileEdits ||= hasFileEditHistory(value);
      if (record(value) && Array.isArray(value.items))
        this.#historyTurnCount = value.items.filter(
          (item) => record(item) && item.role === "user",
        ).length;
      if (usage) this.#setUsage(usage, this.#active?.command.turnId);
      return {
        ok: true,
        value: {
          ...projectHistory(value, nativeRef.nativeSessionId, this.options.inspection.agentType),
          state: this.#state,
        },
      };
    } catch (error) {
      return { ok: false, error: harnessError(error) };
    }
  }

  execute(command: TurnStartCommand): Promise<HarnessResult<TurnStartAccepted>>;
  execute(command: TurnSteerCommand): Promise<HarnessResult<TurnSteerAccepted>>;
  execute(command: TurnCancelCommand): Promise<HarnessResult<TurnCancelAccepted>>;
  execute(command: InteractionRespondCommand): Promise<HarnessResult<InteractionRespondAccepted>>;
  execute(command: ModelSelectCommand): Promise<HarnessResult<ModelSelectCompleted>>;
  execute(command: ThinkingSelectCommand): Promise<HarnessResult<ThinkingSelectCompleted>>;
  execute(
    command: PermissionModeSelectCommand,
  ): Promise<HarnessResult<PermissionModeSelectCompleted>>;
  async execute(command: HostCommand): Promise<HarnessResult<CommandResult>> {
    try {
      if (this.#closed || this.#faulted)
        throw new TraeError("invalidState", "TRAE CN Session is closed or faulted");
      if (command.type === "turn.start") {
        if (this.#active || this.#configuring)
          throw new TraeError("sessionBusy", "TRAE CN Session has an active Host Turn");
        if (
          !command.turnId?.trim() ||
          !Array.isArray(command.input) ||
          !command.input.length ||
          !command.input.every((part) => part.type === "text" && typeof part.text === "string") ||
          !command.input.some((part) => part.text.trim())
        )
          throw new TraeError("invalidRequest", "Expected a non-empty text Turn and Host Turn ID");
        if (!this.#selectedModel)
          throw new TraeError(
            "configurationRequired",
            "Choose a TRAE CN model before starting this Session",
          );
        nativeModelId(this.options.inspection, this.#selectedModel);
        const turn: ActiveTurn = {
          command,
          model: this.#selectedModel,
          configurationRevision: this.#configurationRevision,
          thinking: this.#selectedThinking
            ? nativeThinkingSelection(
                this.options.inspection,
                this.#selectedModel,
                this.#selectedThinking,
              )
            : undefined,
          thinkingOptionId: this.#selectedThinking,
          permissionModeId: this.#selectedPermission
            ? nativePermissionId(this.options.inspection, this.#selectedPermission)
            : this.options.inspection.permissions?.defaultModeId,
          permissionRevision: this.#permissionRevision,
          messageId: randomUUID(),
          cancelRequested: false,
          admitted: false,
          stopRequested: false,
          items: new LiveItems(command.turnId, (event) => this.#emit(event)),
          interactions: undefined,
        };
        this.#active = turn;
        queueMicrotask(() => {
          void this.#run(turn);
        });
        return { ok: true, value: { turnId: command.turnId } };
      }
      if (command.type === "turn.cancel") {
        const turn = this.#active;
        if (!turn || turn.command.turnId !== command.turnId)
          throw new TraeError("invalidState", "Cancellation does not match an active TRAE CN Turn");
        turn.cancelRequested = true;
        if (turn.admitted) await this.#stop(turn);
        return { ok: true, value: { cancellationRequested: true } };
      }
      if (command.type === "interaction.respond") {
        const interactions = this.#active?.interactions;
        if (!interactions)
          throw new TraeError("invalidState", "No native question is currently active");
        return interactions.respond(command);
      }
      if (command.type === "model.select" || command.type === "thinking.select")
        return await this.#configure(command);
      if (command.type === "permissionMode.select") return await this.#configurePermission(command);
      throw new TraeError("unsupported", `TRAE CN operation is not implemented: ${command.type}`);
    } catch (error) {
      return { ok: false, error: harnessError(error) };
    }
  }

  async #configurePermission(
    command: PermissionModeSelectCommand,
  ): Promise<HarnessResult<PermissionModeSelectCompleted>> {
    if (!this.capabilities.configuration.selectPermissionMode)
      throw new TraeError(
        "unsupported",
        "TRAE CN permission selection requires a newer Companion and the native feature",
      );
    if (this.#configuring)
      throw new TraeError("sessionBusy", "TRAE CN configuration is already being prepared");
    this.#configuring = true;
    try {
      const inspection = await preparePermissionChange({
        client: this.options.client,
        cwd: this.options.cwd,
        nativeRef: this.#state.nativeRef,
        permissionModeId: command.permissionModeId,
      });
      if (this.#closed || this.#faulted)
        throw new TraeError("invalidState", "TRAE CN Session closed during permission preparation");
      this.options.inspection = inspection;
      this.#selectedPermission = command.permissionModeId;
      this.#permissionRevision++;
      this.#setState({ ...this.#state, effectivePermissionModeId: command.permissionModeId });
      return { ok: true, value: { completed: true } };
    } finally {
      this.#configuring = false;
    }
  }

  async #configure(
    command: ModelSelectCommand | ThinkingSelectCommand,
  ): Promise<HarnessResult<ModelSelectCompleted>> {
    if (
      !(command.type === "model.select"
        ? this.capabilities.configuration.selectModel
        : this.capabilities.configuration.selectThinkingOption)
    )
      throw new TraeError(
        "unsupported",
        "This TRAE CN Companion does not support the requested configuration",
      );
    if (this.#configuring)
      throw new TraeError("sessionBusy", "TRAE CN model configuration is already being prepared");
    this.#configuring = true;
    try {
      const { inspection, model, thinking, availableThinkingOptions } =
        await prepareSelectionChange({
          client: this.options.client,
          cwd: this.options.cwd,
          nativeRef: this.#state.nativeRef,
          currentModel: this.#selectedModel,
          currentThinking: this.#selectedThinking,
          command,
        });
      if (this.#closed || this.#faulted)
        throw new TraeError("invalidState", "TRAE CN Session closed during model configuration");
      this.options.inspection = inspection;
      this.#selectedModel = { ...model };
      this.#selectedThinking = thinking;
      this.#configurationRevision++;
      // The native interface takes this configuration on the next send. A
      // running Turn retains the model captured when it was accepted.
      const state = { ...this.#state, effectiveModel: this.#selectedModel };
      delete state.effectiveThinkingOptionId;
      if (thinking) state.effectiveThinkingOptionId = thinking;
      if (inspection.configuration?.thinkingSelection === "per-request")
        state.availableThinkingOptions = availableThinkingOptions;
      this.#setState(state);
      return { ok: true, value: { completed: true } };
    } finally {
      this.#configuring = false;
    }
  }

  async #stop(turn: ActiveTurn): Promise<void> {
    const nativeRef = this.#state.nativeRef;
    if (turn.stopRequested || !nativeRef || this.#active !== turn) return;
    turn.stopRequested = true;
    try {
      await this.options.client.call("cancel", { sessionId: nativeRef.nativeSessionId });
    } catch (error) {
      turn.stopRequested = false;
      throw error;
    }
  }

  async #run(turn: ActiveTurn, recovering = false): Promise<void> {
    this.#emit({ type: "turn.started", turnId: turn.command.turnId });
    try {
      if (!recovering) {
        if (!this.#state.nativeRef) {
          const created = await this.options.client.call("create", { cwd: this.options.cwd });
          if (
            !record(created) ||
            typeof created.sessionId !== "string" ||
            typeof created.projectId !== "string"
          )
            throw new TraeError("protocolError", "Invalid native Session creation receipt");
          const nativeRef = nativeSessionRefSchema.parse({
            harnessId: this.harnessId,
            nativeSessionId: created.sessionId,
            formatVersion: 1,
            locator: {
              applicationRoot: this.options.inspection.application.root,
              projectId: created.projectId,
              cwd: this.options.cwd,
              agentType: this.options.inspection.agentType,
            },
          });
          this.#setState({ ...this.#state, nativeRef });
        }
        if (this.#closed) return;
        const nativeRef = this.#state.nativeRef;
        if (!nativeRef)
          throw new TraeError("protocolError", "Native Session identity was not established");
        if (turn.cancelRequested) {
          this.#emit({
            type: "turn.completed",
            turnId: turn.command.turnId,
            ephemeral: true,
            outcome: { status: "cancelled" },
          });
          return;
        }
        const model = turn.model;
        if (!model) throw new TraeError("configurationRequired", "Choose a TRAE CN model");
        const receipt = await this.options.client.call("start", {
          sessionId: nativeRef.nativeSessionId,
          messageId: turn.messageId,
          modelId: nativeModelId(this.options.inspection, model),
          ...(turn.thinking ? { thinking: turn.thinking } : {}),
          ...(turn.permissionModeId ? { permissionModeId: turn.permissionModeId } : {}),
          text: turn.command.input.map((part) => part.text).join("\n"),
        });
        if (
          !record(receipt) ||
          receipt.accepted !== true ||
          receipt.messageId !== turn.messageId ||
          receipt.fromAppend === true ||
          (turn.permissionModeId !== undefined &&
            receipt.permissionModeId !== turn.permissionModeId)
        )
          throw new TraeError(
            "protocolError",
            "Native Turn admission is uncertain; read history before retrying",
          );
        turn.admitted = true;
        this.#emit({
          type: "turn.identity.confirmed",
          turnId: turn.command.turnId,
          nativeTurnRef: confirmedNativeTurnRef(nativeRef.nativeSessionId, turn.messageId),
        });
        if (turn.permissionModeId && turn.permissionRevision === this.#permissionRevision) {
          this.#selectedPermission = permissionModeRef(turn.permissionModeId);
          this.#setState({ ...this.#state, effectivePermissionModeId: this.#selectedPermission });
        }
      }
      const nativeRef = this.#state.nativeRef;
      if (!nativeRef) throw new TraeError("protocolError", "Missing native recovery identity");
      if (this.#closed) return;
      if (turn.cancelRequested) await this.#stop(turn);
      try {
        await this.#observe(turn, nativeRef.nativeSessionId);
      } catch (error) {
        if (this.#closed) return;
        // A task can finish between the read-only resume check and attaching its
        // stream. Native durable completion still proves its actual outcome.
        const snapshot = await this.#snapshot(true);
        const terminal =
          snapshot.ok &&
          snapshot.value.turns.some(
            (entry) =>
              entry.nativeTurnRef.nativeTurnKey === turn.messageId &&
              entry.outcome.status !== "unknown",
          );
        if (!terminal && (!turn.cancelRequested || !turn.stopRequested)) throw error;
      }
      if (this.#closed) return;
      const completed = await this.#readTerminal(turn.messageId);
      if (completed.outcome.status === "unknown")
        throw new TraeError("unavailable", "Native history has not confirmed completion");
      turn.items.acceptFileChanges(completed.items);
      turn.items.settle(completed.outcome);
      turn.interactions?.close(completed.outcome.status === "cancelled" ? "cancelled" : "expired");
      this.#emit({
        type: "turn.completed",
        turnId: turn.command.turnId,
        nativeTurnRef: completed.nativeTurnRef,
        outcome: completed.outcome,
      });
    } catch (error) {
      if (!this.#closed) {
        const failure = harnessError(error);
        this.#faulted = true;
        const snapshot = turn.admitted ? await this.#snapshot(true) : undefined;
        const confirmedRef = snapshot?.ok
          ? snapshot.value.turns.find(
              (entry) => entry.nativeTurnRef.nativeTurnKey === turn.messageId,
            )?.nativeTurnRef
          : undefined;
        if (this.#closed) return;
        turn.items.settle({ status: "failed", error: failure });
        turn.interactions?.close("expired");
        this.#emit({
          type: "turn.completed",
          turnId: turn.command.turnId,
          ...(confirmedRef ? { nativeTurnRef: confirmedRef } : {}),
          outcome: { status: "failed", error: failure },
        });
        this.#emit({ type: "session.faulted", error: failure });
        this.#releaseObserver();
      }
    } finally {
      this.#observerFail = undefined;
      this.#detach?.();
      this.#detach = undefined;
      if (this.#active === turn) this.#active = undefined;
      this.#recoverySnapshot = undefined;
    }
  }

  async #readTerminal(messageId: string): Promise<HostTurnSnapshot> {
    const deadline = Date.now() + 5000;
    while (!this.#closed) {
      const snapshot = await this.#snapshot(true);
      if (!snapshot.ok) throw new TraeError(snapshot.error.code, snapshot.error.message);
      const turn = snapshot.value.turns.find(
        (entry) => entry.nativeTurnRef.nativeTurnKey === messageId,
      );
      if (turn && turn.outcome.status !== "unknown") return turn;
      if (Date.now() >= deadline)
        throw new TraeError(
          "unavailable",
          "Native completion history is still pending; read the same Session before retrying",
        );
      // SSE EOF can precede the native history commit. Re-read this identity;
      // never restart the task or treat the visibility delay as native failure.
      await delay(100);
    }
    throw new TraeError("invalidState", "TRAE CN Session closed during history confirmation");
  }

  #observe(turn: ActiveTurn, sessionId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.#observerFail = reject;
      turn.interactions = new NativeInteractions(
        { sessionId, messageId: turn.messageId, turnId: turn.command.turnId },
        this.options.client,
        (output) => {
          if (!this.#closed) this.#channel.emit(output);
        },
      );
      let terminal = false;
      let nativeError: TraeError | undefined;
      void this.options.client
        .subscribe(
          { sessionId },
          {
            event: (event: BridgeEvent) => {
              try {
                const payload = record(event.payload) ? event.payload : undefined;
                if (
                  typeof payload?.reply_to_message_id === "string" &&
                  payload.reply_to_message_id !== turn.messageId
                )
                  throw new TraeError("protocolError", "Native event belongs to a different Turn");
                if (event.event === "plan_item") {
                  if (
                    record(payload?.tool_call_info) &&
                    record(payload.tool_call_info.result) &&
                    record(payload.tool_call_info.result.data) &&
                    payload.tool_call_info.result.data.can_show_diff === true
                  )
                    this.#historyHasFileEdits = true;
                  turn.interactions?.observe(payload);
                  turn.items.acceptPlan(payload);
                } else if (event.event === "metadata" || event.event === "model_config") {
                  const effectiveModel = confirmedModel(
                    event.event === "metadata" ? payload?.model : payload,
                    this.options.inspection.agentType,
                  );
                  if (
                    effectiveModel &&
                    turn.configurationRevision === this.#configurationRevision &&
                    turn.model?.id === this.#selectedModel?.id &&
                    turn.thinkingOptionId === this.#selectedThinking
                  ) {
                    // Recovery may attach before the native model was present
                    // in history. Its first confirmed event supplies it.
                    if (this.#selectedModel?.id !== effectiveModel.id) {
                      this.#selectedModel = effectiveModel;
                      turn.model = effectiveModel;
                      this.#selectedThinking = undefined;
                      turn.thinkingOptionId = undefined;
                    }
                    const thinking = confirmedThinking(
                      event.event === "metadata" ? payload?.model : payload,
                      this.options.inspection,
                    );
                    if (thinking) {
                      this.#selectedThinking = thinking;
                      turn.thinkingOptionId = thinking;
                    }
                    const state = { ...this.#state, effectiveModel };
                    if (
                      this.options.inspection.configuration?.thinkingSelection === "per-request"
                    ) {
                      state.availableThinkingOptions = modelThinkingOptions(
                        this.options.inspection,
                        effectiveModel,
                      );
                      if (thinking) state.effectiveThinkingOptionId = thinking;
                      else if (
                        !state.availableThinkingOptions.some(
                          (option) => option.id === state.effectiveThinkingOptionId,
                        )
                      )
                        delete state.effectiveThinkingOptionId;
                    }
                    this.#setState(state);
                  }
                } else if (event.event === "token_usage") {
                  const usage = nativeContextUsage(payload);
                  if (usage) this.#setUsage(usage, turn.command.turnId);
                } else if (event.event === "done") terminal = true;
                else if (event.event === "error")
                  nativeError = new TraeError(
                    "nativeFailure",
                    typeof payload?.message === "string" ? payload.message : "TRAE CN task failed",
                  );
                else if (
                  ![
                    "message_context_update",
                    "token_usage",
                    "context_usage",
                    "context_token_usage",
                    "timing_events",
                    "session_title_message",
                    "session_icon_message",
                  ].includes(event.event)
                )
                  throw new TraeError(
                    "unsupported",
                    `TRAE CN event requires an unimplemented public projection: ${event.event}`,
                  );
              } catch (error) {
                reject(error);
              }
            },
            error: reject,
            end: () =>
              terminal
                ? resolve()
                : reject(
                    nativeError ??
                      new TraeError(
                        "protocolError",
                        "Native subscription ended without a terminal event",
                      ),
                  ),
          },
        )
        .then((detach) => {
          if (this.#closed || this.#active !== turn) detach();
          else this.#detach = detach;
        })
        .catch(reject);
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    const turn = this.#active;
    if (turn) {
      const error = harnessError(
        new TraeError(
          "unavailable",
          "TRAE CN observer closed; admitted native work may still be running",
        ),
      );
      turn.interactions?.close("superseded");
      turn.items.settle({ status: "failed", error });
      this.#emit({
        type: "turn.completed",
        turnId: turn.command.turnId,
        ...(turn.admitted && this.#state.nativeRef
          ? {
              nativeTurnRef: confirmedNativeTurnRef(
                this.#state.nativeRef.nativeSessionId,
                turn.messageId,
              ),
            }
          : {}),
        outcome: { status: "failed", error },
      });
    }
    this.#releaseObserver();
  }

  #releaseObserver(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#observerFail?.(new TraeError("invalidState", "TRAE CN observer closed"));
    this.#observerFail = undefined;
    this.#detach?.();
    this.#detach = undefined;
    this.options.client.close();
    this.#channel.end();
    this.options.onClose?.();
  }
}
