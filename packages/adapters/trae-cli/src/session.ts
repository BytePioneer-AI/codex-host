import { isDeepStrictEqual } from "node:util";
import {
  HarnessOutputChannel,
  type HarnessSession,
  type HarnessOutput,
  type HarnessResult,
  type HostCommand,
  type HostEvent,
  type HostThreadSnapshot,
  type HostTurnSnapshot,
  type HarnessSessionState,
  type TurnOutcome,
  type TurnStartCommand,
  type TurnStartAccepted,
  type TurnSteerCommand,
  type TurnSteerAccepted,
  type TurnCancelCommand,
  type TurnCancelAccepted,
  type InteractionRespondCommand,
  type InteractionRespondAccepted,
  type ModelSelectCommand,
  type ModelSelectCompleted,
  type ThinkingSelectCommand,
  type ThinkingSelectCompleted,
  type PermissionModeSelectCommand,
  type PermissionModeSelectCompleted,
  type CreateSessionInput,
} from "@codexhost/harness-adapter";
import { nativeSessionRefSchema } from "@codexhost/shared-contracts";
import { TRAE_CLI_ID, rejected, traeError, TraeCliError } from "./common.js";
import {
  capabilities,
  choices,
  modelRef,
  selector,
  state,
  thinkingRef,
  type SessionInfo,
} from "./configuration.js";
import { Interactions } from "./interactions.js";
import { history, turnKey, TurnProjection } from "./projection.js";
import type { TraeTransport } from "./transport.js";

type CommandResult =
  | TurnStartAccepted
  | TurnSteerAccepted
  | TurnCancelAccepted
  | InteractionRespondAccepted
  | ModelSelectCompleted
  | ThinkingSelectCompleted
  | PermissionModeSelectCompleted;
export class TraeSession implements HarnessSession {
  readonly harnessId = TRAE_CLI_ID;
  readonly initialUsage = null;
  readonly initialState: HarnessSessionState = {};
  readonly #channel = new HarnessOutputChannel<HarnessOutput>();
  readonly outputs = this.#channel.outputs;
  readonly #interactions = new Interactions((output) => this.#channel.emit(output));
  #info: SessionInfo = {};
  #turns: HostTurnSnapshot[] = [];
  #submitted = new Set<string>();
  #active: { command: TurnStartCommand; task: Promise<void>; cancelled: boolean } | undefined;
  #opening: Promise<void> | undefined;
  #configuring = false;
  #closed = false;
  #faulted = false;
  #closing: Promise<void> | undefined;
  constructor(
    readonly transport: TraeTransport,
    readonly draft: CreateSessionInput | undefined,
    readonly onClose: () => void,
  ) {
    transport.onConfiguration = (info) => this.#accept(info);
    transport.onFault = (error) => {
      if (!this.#closed && !this.#active) {
        this.#faulted = true;
        this.#interactions.cancel();
        this.#emit({ type: "session.faulted", error: traeError(error) });
      }
    };
  }
  get capabilities() {
    if (!this.transport.sessionId)
      return {
        ...capabilities(this.#info),
        configuration: { ...capabilities(this.#info).configuration, selectModel: true },
      };
    return capabilities(this.#info);
  }
  #emit(event: HostEvent) {
    this.#channel.emit({ kind: "event", event });
  }
  #accept(update: Partial<SessionInfo>) {
    const before = structuredClone(this.initialState);
    this.#info = { ...this.#info, ...update };
    const currentMode = update._meta?.currentModeId;
    if (typeof currentMode === "string" && this.#info.modes)
      this.#info.modes = { ...this.#info.modes, currentModeId: currentMode };
    const next = state(this.#info);
    if (this.transport.sessionId)
      next.nativeRef = nativeSessionRefSchema.parse({
        harnessId: TRAE_CLI_ID,
        nativeSessionId: this.transport.sessionId,
        formatVersion: 1,
        locator: { cwd: this.transport.cwd },
      });
    delete this.initialState.effectiveModel;
    delete this.initialState.effectiveThinkingOptionId;
    delete this.initialState.effectivePermissionModeId;
    delete this.initialState.availableThinkingOptions;
    Object.assign(this.initialState, next);
    if (!isDeepStrictEqual(before, next))
      this.#emit({ type: "session.state.changed", state: structuredClone(this.initialState) });
  }
  async restore() {
    const loaded = await this.transport.open(this.transport.sessionId);
    this.#accept(loaded.info);
    this.#turns = history(this.transport.sessionId, loaded.replay);
    return { turns: structuredClone(this.#turns), state: structuredClone(this.initialState) };
  }
  async #native() {
    if (this.#opening) return this.#opening;
    if (this.transport.sessionId) return;
    this.#opening = this.#createNative();
    try {
      await this.#opening;
    } finally {
      this.#opening = undefined;
    }
  }
  async #createNative() {
    const opened = await this.transport.open();
    this.#accept(opened.info);
    // Create hints configure this new native Session, not the user's CLI defaults.
    for (const command of [
      ...(this.draft?.model ? [{ type: "model.select" as const, model: this.draft.model }] : []),
      ...(this.draft?.thinkingOptionId
        ? [{ type: "thinking.select" as const, thinkingOptionId: this.draft.thinkingOptionId }]
        : []),
      ...(this.draft?.permissionModeId
        ? [
            {
              type: "permissionMode.select" as const,
              permissionModeId: this.draft.permissionModeId,
            },
          ]
        : []),
    ])
      await this.#configure(command);
  }
  async #configure(
    command: ModelSelectCommand | ThinkingSelectCommand | PermissionModeSelectCommand,
  ) {
    if (command.type === "permissionMode.select") {
      if (!this.#info.modes?.availableModes.some((mode) => mode.id === command.permissionModeId))
        throw new TraeCliError("unsupported", "TRAE CLI did not advertise that permission mode");
      await this.transport.mode(command.permissionModeId);
      // Empty set_mode success alone is not a state confirmation. Query native state again.
      const loaded = await this.transport.reload();
      this.#accept(loaded.info);
      if (this.initialState.effectivePermissionModeId !== command.permissionModeId)
        throw new TraeCliError("protocolError", "TRAE CLI did not confirm the permission mode");
      return;
    }
    const category = command.type === "model.select" ? "model" : "thought_level";
    const option = selector(this.#info, category);
    const choice = choices(option).find((entry) =>
      command.type === "model.select"
        ? modelRef(entry.value).id === command.model.id
        : thinkingRef(entry.value) === command.thinkingOptionId,
    );
    if (!option || !choice)
      throw new TraeCliError(
        "unsupported",
        `TRAE CLI did not advertise that ${category} selection`,
      );
    const info = await this.transport.configure(option.id, choice.value);
    this.#accept({ configOptions: info.configOptions });
    if (selector(this.#info, category)?.currentValue !== choice.value)
      throw new TraeCliError("protocolError", "TRAE CLI did not confirm configuration selection");
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
    if (this.#closed || this.#faulted || this.transport.closed)
      return rejected("invalidState", "TRAE CLI Session is closed or faulted");
    if (command.type === "interaction.respond") return this.#interactions.respond(command);
    if (command.type === "turn.steer")
      return rejected("unsupported", "TRAE CLI steering has not been verified; input was not sent");
    if (command.type === "turn.cancel") {
      if (this.#active?.command.turnId !== command.turnId)
        return rejected("invalidRequest", "Cancellation does not target the active TRAE CLI Turn");
      this.#interactions.cancel();
      this.#active.cancelled = true;
      try {
        await this.transport.cancel();
        return { ok: true, value: { cancellationRequested: true } };
      } catch (error) {
        return { ok: false, error: traeError(error) };
      }
    }
    if (command.type !== "turn.start") {
      if (this.#configuring) return rejected("sessionBusy", "TRAE CLI configuration is busy");
      if (command.type === "permissionMode.select" && this.#active)
        return rejected("unsupported", "Permission changes cannot be confirmed during a Turn");
      this.#configuring = true;
      try {
        await this.#native();
        await this.#configure(command);
        return { ok: true, value: { completed: true } };
      } catch (error) {
        return { ok: false, error: traeError(error) };
      } finally {
        this.#configuring = false;
      }
    }
    if (this.#active || this.#configuring)
      return rejected("sessionBusy", "TRAE CLI Session is busy");
    if (
      this.#submitted.has(command.turnId) ||
      !command.input.length ||
      command.input.some((part) => part.type !== "text") ||
      !command.input.some((part) => part.text.trim())
    )
      return rejected("invalidRequest", "TRAE CLI Turn has empty/invalid input or a duplicate ID");
    this.#submitted.add(command.turnId);
    const active = { command: structuredClone(command), task: Promise.resolve(), cancelled: false };
    this.#active = active;
    active.task = this.#run(active.command).finally(() => {
      if (this.#active === active) this.#active = undefined;
    });
    return { ok: true, value: { turnId: command.turnId } };
  }
  async #run(command: TurnStartCommand) {
    const text = command.input.map((part) => part.text).join("\n");
    const key = turnKey(this.#turns.length, text);
    const projection = new TurnProjection(command.turnId, key, (event) => this.#emit(event));
    this.#emit({ type: "turn.started", turnId: command.turnId });
    let outcome: TurnOutcome;
    let nativeTurnRef: HostTurnSnapshot["nativeTurnRef"] | undefined;
    try {
      await this.#native();
      if (this.#active?.cancelled || this.#closed) {
        projection.finish({ status: "cancelled" });
        this.#emit({
          type: "turn.completed",
          turnId: command.turnId,
          outcome: { status: "cancelled" },
        });
        return;
      }
      const selected = this.initialState.effectiveModel;
      const result = await this.transport.prompt(text, {
        update: (event) => projection.update(event),
        permission: (request) => this.#interactions.permission(command.turnId, request),
        question: (request) => this.#interactions.question(command.turnId, request),
      });
      outcome =
        result.stopReason === "cancelled"
          ? { status: "cancelled" }
          : result.stopReason === "end_turn"
            ? { status: "succeeded" }
            : {
                status: "failed",
                error: {
                  code: "nativeFailure",
                  message: `TRAE CLI stopped: ${result.stopReason}`,
                  retryable: false,
                },
              };
      // Only durable native replay may confirm a resumable Turn identity.
      const loaded = await this.transport.reload();
      const turns = history(this.transport.sessionId, loaded.replay);
      if (
        turns.length !== this.#turns.length + 1 ||
        turns.at(-1)?.nativeTurnRef.nativeTurnKey !== key ||
        this.#turns.some(
          (turn, index) =>
            turn.nativeTurnRef.nativeTurnKey !== turns[index]?.nativeTurnRef.nativeTurnKey,
        )
      )
        throw new TraeCliError(
          "protocolError",
          "TRAE CLI replay did not confirm the submitted Turn; do not resend it",
        );
      const last = turns.at(-1);
      if (!last)
        throw new TraeCliError("protocolError", "TRAE CLI replay omitted the completed Turn");
      last.outcome = outcome;
      if (selected) last.model = selected;
      nativeTurnRef = last.nativeTurnRef;
      this.#turns = turns;
      this.#accept(loaded.info);
    } catch (error) {
      if (this.#closed) outcome = { status: "cancelled", reason: "Session closed" };
      else {
        outcome = { status: "failed", error: traeError(error) };
        this.#faulted = true;
        this.#emit({ type: "session.faulted", error: outcome.error });
      }
    } finally {
      this.#interactions.cancel();
    }
    projection.finish(outcome);
    this.#emit({
      type: "turn.completed",
      turnId: command.turnId,
      ...(nativeTurnRef ? { nativeTurnRef } : {}),
      outcome,
    });
  }
  async readSnapshot(): Promise<HarnessResult<HostThreadSnapshot>> {
    if (this.#closed || this.#faulted)
      return rejected("invalidState", "TRAE CLI Session is closed or faulted");
    if (this.#active || this.#configuring)
      return rejected("sessionBusy", "TRAE CLI cannot reload history during an active operation");
    if (!this.transport.sessionId) return { ok: true, value: { turns: [], state: {} } };
    this.#configuring = true;
    try {
      const loaded = await this.transport.reload();
      const turns = history(this.transport.sessionId, loaded.replay);
      if (
        this.#turns.some(
          (turn, index) =>
            turn.nativeTurnRef.nativeTurnKey !== turns[index]?.nativeTurnRef.nativeTurnKey,
        )
      )
        throw new TraeCliError("protocolError", "TRAE CLI replay lost or changed a known Turn");
      // Retain confirmed outcomes only for exactly matching native history.
      for (const turn of turns) {
        const known = this.#turns.find(
          (old) => old.nativeTurnRef.nativeTurnKey === turn.nativeTurnRef.nativeTurnKey,
        );
        if (known) {
          turn.outcome = known.outcome;
          if (known.model) turn.model = known.model;
        }
      }
      this.#turns = turns;
      this.#accept(loaded.info);
      return {
        ok: true,
        value: { turns: structuredClone(turns), state: structuredClone(this.initialState) },
      };
    } catch (error) {
      return { ok: false, error: traeError(error) };
    } finally {
      this.#configuring = false;
    }
  }
  async close() {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    return (this.#closing = (async () => {
      this.#interactions.cancel();
      await this.transport.close();
      await this.#active?.task;
      this.#channel.end();
      this.onClose();
    })());
  }
}
