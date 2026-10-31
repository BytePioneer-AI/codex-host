import { randomUUID } from "node:crypto";
import {
  HarnessOutputChannel,
  type HarnessSession,
  type HarnessSessionCapabilities,
  type HarnessSessionState,
  type HarnessOutput,
  type HostEvent,
  type HostCommand,
  type HarnessResult,
  type HostThreadSnapshot,
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
  type NativeSessionRef,
} from "@codexhost/shared-contracts";
import type { BridgeClient } from "./bridge.js";
import type { BridgeEvent, BridgeInspection } from "./protocol.js";
import { harnessError, record, TraeError } from "./errors.js";
import { nativeModelId, confirmedModel } from "./models.js";
import { projectHistory, TRAE_CN_ID } from "./history.js";
import { LiveItems } from "./live-items.js";
import { sameDirectory } from "./discovery.js";

// This initial core deliberately does not advertise configuration writes or
// history derivation before those native operations have their own acceptance.
export const SESSION_CAPABILITIES: HarnessSessionCapabilities = {
  configuration: {
    selectModel: false,
    selectThinkingOption: false,
    selectPermissionMode: false,
    permissionModeScope: "live",
  },
  history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
};

interface ActiveTurn {
  command: TurnStartCommand;
  messageId: string;
  cancelRequested: boolean;
  admitted: boolean;
  stopRequested: boolean;
  items: LiveItems;
}

export interface SessionOptions {
  client: BridgeClient;
  inspection: BridgeInspection;
  cwd: string;
  model?: HarnessModelRef;
  nativeRef?: NativeSessionRef;
  initialState?: HarnessSessionState;
  onClose?: () => void;
}

export function validateReference(
  reference: NativeSessionRef,
  inspection: BridgeInspection,
  cwd: string,
): void {
  const parsed = nativeSessionRefSchema.safeParse(reference);
  const locator = parsed.success ? parsed.data.locator : undefined;
  if (
    !parsed.success ||
    parsed.data.harnessId !== TRAE_CN_ID ||
    !record(locator) ||
    typeof locator.applicationRoot !== "string" ||
    !sameDirectory(locator.applicationRoot, inspection.application.root) ||
    typeof locator.cwd !== "string" ||
    !sameDirectory(locator.cwd, cwd) ||
    locator.agentType !== inspection.agentType ||
    typeof locator.projectId !== "string" ||
    !locator.projectId
  )
    throw new TraeError(
      "invalidRequest",
      "TRAE CN reference belongs to a different application, Agent or workspace",
    );
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
  readonly harnessId = TRAE_CN_ID;
  readonly capabilities = SESSION_CAPABILITIES;
  readonly initialUsage = null;
  readonly initialState: HarnessSessionState;
  readonly outputs: AsyncIterable<HarnessOutput>;
  #channel = new HarnessOutputChannel<HarnessOutput>();
  #state: HarnessSessionState;
  #active: ActiveTurn | undefined;
  #closed = false;
  #faulted = false;
  #detach: (() => void) | undefined;
  #observerFail: ((error: unknown) => void) | undefined;

  constructor(private readonly options: SessionOptions) {
    if (options.nativeRef) validateReference(options.nativeRef, options.inspection, options.cwd);
    this.initialState = {
      ...(options.initialState ?? {}),
      ...(options.nativeRef ? { nativeRef: options.nativeRef } : {}),
    };
    this.#state = this.initialState;
    this.outputs = this.#channel.outputs;
    if (options.model) nativeModelId(options.inspection, options.model);
  }

  #emit(event: HostEvent): void {
    if (!this.#closed) this.#channel.emit({ kind: "event", event });
  }

  #setState(state: HarnessSessionState): void {
    this.#state = state;
    this.#emit({ type: "session.state.changed", state });
  }

  async readSnapshot(): Promise<HarnessResult<HostThreadSnapshot>> {
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
        if (this.#active)
          throw new TraeError("sessionBusy", "TRAE CN Session has an active Host Turn");
        if (
          !command.turnId?.trim() ||
          !Array.isArray(command.input) ||
          !command.input.length ||
          !command.input.every((part) => part.type === "text" && typeof part.text === "string") ||
          !command.input.some((part) => part.text.trim())
        )
          throw new TraeError("invalidRequest", "Expected a non-empty text Turn and Host Turn ID");
        if (!this.options.model)
          throw new TraeError(
            "configurationRequired",
            "Choose a TRAE CN model before starting this Session",
          );
        nativeModelId(this.options.inspection, this.options.model);
        const turn: ActiveTurn = {
          command,
          messageId: randomUUID(),
          cancelRequested: false,
          admitted: false,
          stopRequested: false,
          items: new LiveItems(command.turnId, (event) => this.#emit(event)),
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
      throw new TraeError("unsupported", `TRAE CN operation is not implemented: ${command.type}`);
    } catch (error) {
      return { ok: false, error: harnessError(error) };
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

  async #run(turn: ActiveTurn): Promise<void> {
    this.#emit({ type: "turn.started", turnId: turn.command.turnId });
    try {
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
      const model = this.options.model;
      if (!model) throw new TraeError("configurationRequired", "Choose a TRAE CN model");
      const receipt = await this.options.client.call("start", {
        sessionId: nativeRef.nativeSessionId,
        messageId: turn.messageId,
        modelId: nativeModelId(this.options.inspection, model),
        text: turn.command.input.map((part) => part.text).join("\n"),
      });
      if (
        !record(receipt) ||
        receipt.accepted !== true ||
        receipt.messageId !== turn.messageId ||
        receipt.fromAppend === true
      )
        throw new TraeError(
          "protocolError",
          "Native Turn admission is uncertain; read history before retrying",
        );
      turn.admitted = true;
      if (this.#closed) return;
      if (turn.cancelRequested) await this.#stop(turn);
      try {
        await this.#observe(turn, nativeRef.nativeSessionId);
      } catch (error) {
        if (!turn.cancelRequested || !turn.stopRequested) throw error;
      }
      if (this.#closed) return;
      const snapshot = await this.readSnapshot();
      if (!snapshot.ok) throw new TraeError(snapshot.error.code, snapshot.error.message);
      const completed = snapshot.value.turns.find(
        (entry) => entry.nativeTurnRef.nativeTurnKey === turn.messageId,
      );
      if (!completed || completed.outcome.status === "unknown")
        throw new TraeError("protocolError", "Native stream ended without a durable terminal Turn");
      turn.items.settle(completed.outcome);
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
        const snapshot = turn.admitted ? await this.readSnapshot() : undefined;
        const confirmedRef = snapshot?.ok
          ? snapshot.value.turns.find(
              (entry) => entry.nativeTurnRef.nativeTurnKey === turn.messageId,
            )?.nativeTurnRef
          : undefined;
        if (this.#closed) return;
        turn.items.settle({ status: "failed", error: failure });
        this.#emit({
          type: "turn.completed",
          turnId: turn.command.turnId,
          ...(confirmedRef ? { nativeTurnRef: confirmedRef } : {}),
          outcome: { status: "failed", error: failure },
        });
        this.#emit({ type: "session.faulted", error: failure });
      }
    } finally {
      this.#observerFail = undefined;
      this.#detach?.();
      this.#detach = undefined;
      if (this.#active === turn) this.#active = undefined;
    }
  }

  #observe(turn: ActiveTurn, sessionId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.#observerFail = reject;
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
                if (event.event === "plan_item") turn.items.acceptPlan(payload);
                else if (event.event === "metadata" || event.event === "model_config") {
                  const effectiveModel = confirmedModel(
                    event.event === "metadata" ? payload?.model : payload,
                    this.options.inspection.agentType,
                  );
                  if (effectiveModel) this.#setState({ ...this.#state, effectiveModel });
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
