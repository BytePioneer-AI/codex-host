import { randomUUID } from "node:crypto";
import {
  configureSubagentEvent,
  configureSubagentSnapshot,
  type SubagentConfiguration,
} from "@codexhost/harness-adapter";
import type {
  HarnessCommandAccepted,
  HarnessCommandCapability,
  HarnessCommandInvocation,
  HarnessOutput,
  HarnessResult,
  HarnessSession,
  HarnessSessionState,
  HostCommand,
  HostEvent,
  HostThreadSnapshot,
  HostTurnSnapshot,
  HostUsage,
  InteractionRespondAccepted,
  InteractionRespondCommand,
  ModelSelectCommand,
  ModelSelectCompleted,
  OpenSessionInput,
  PermissionModeSelectCommand,
  PermissionModeSelectCompleted,
  ThinkingSelectCommand,
  ThinkingSelectCompleted,
  TurnCancelAccepted,
  TurnCancelCommand,
  TurnOutcome,
  TurnStartAccepted,
  TurnStartCommand,
  TurnSteerAccepted,
  TurnSteerCommand,
} from "@codexhost/harness-adapter";
import { unsupportedSteer } from "@codexhost/harness-adapter";
import { HarnessOutputChannel } from "@codexhost/harness-adapter";
import {
  hostTurnIdSchema,
  nativeSessionRefSchema,
  type HarnessCommandCatalog,
  type HostTurnId,
  type NativeTurnRef,
  type NativeSessionRef,
} from "@codexhost/shared-contracts";
import type { CodeBuddyClient, CodeBuddyClientFactory } from "./acp-client.js";
import {
  CodeBuddyAutonomousTurns,
  readUnsolicitedTurn,
  requestIdOf,
  type CodeBuddyAutonomousRound,
} from "./autonomous.js";
import {
  bounded,
  CODEBUDDY_RUNTIME_PROFILE,
  CodeBuddyError,
  failure,
  nativeError,
  nativeTurnError,
  record,
  text,
  type CodeBuddyRuntimeProfile,
} from "./common.js";
import {
  capabilitiesForProfile,
  configuration,
  nativeModel,
  restoreConfiguration,
  selectConfiguration,
} from "./configuration.js";
import {
  codeBuddyCanonicalCwd,
  historyUsage,
  historyUsageRequests,
  pendingNativeHistoryRewind,
  readNativeHistory,
  snapshotFromHistory,
} from "./history.js";
import { CodeBuddyInteractions } from "./interactions.js";
import { CodeBuddyTurnOutput } from "./projection.js";
import { CodeBuddySubagents } from "./subagents.js";
import {
  commandCatalog,
  commandPrompt,
  isExcludedInvocation,
  nativeCommandsEnabled,
} from "./slash-commands.js";

type SessionInput = Extract<OpenSessionInput, { kind: "create" | "resume" }>;
export type CodeBuddyHistoryReader = typeof readNativeHistory;
interface SessionReplay {
  fault?: { error: unknown };
  commands?: HarnessCommandCatalog;
}
interface ActiveTurn {
  command: TurnStartCommand;
  output: CodeBuddyTurnOutput;
  completion: Promise<void>;
  nativeCommand: boolean;
  cancelled: boolean;
  done: boolean;
  /** The Host prompt has returned; later native Interactions belong to the next drain run. */
  promptSettled?: boolean;
  /** Present when native output, not a Host `turn.start`, owns this Turn. */
  autonomous?: { round: CodeBuddyAutonomousRound };
  settle?: () => void;
}

export class CodeBuddySession implements HarnessSession {
  readonly harnessId;
  #commands: HarnessCommandCatalog = { commands: [] };
  readonly commands?: HarnessCommandCapability;
  readonly capabilities;
  initialState: HarnessSessionState = {};
  initialUsage: HostUsage | null = null;
  readonly #channel = new HarnessOutputChannel<HarnessOutput>();
  readonly outputs = this.#channel.outputs;
  readonly #meteredRequests = new Set<string>();
  readonly subagents: CodeBuddySubagents;
  #client: CodeBuddyClient;
  #generation = 0;
  #needsResume = false;
  #replay: SessionReplay | undefined;
  readonly #interactions: CodeBuddyInteractions;
  #config: ReturnType<typeof configuration> | undefined;
  #ref: NativeSessionRef | undefined;
  #state: HarnessSessionState = {};
  #active: ActiveTurn | undefined;
  readonly #autonomous = new CodeBuddyAutonomousTurns();
  #loadedTurns: HostTurnSnapshot[] | undefined;
  #busy = false;
  #closed = false;
  #closing: Promise<void> | undefined;
  #fault: ReturnType<typeof nativeError> | undefined;
  #hasTurn = false;
  #usage: HostUsage | null = null;
  #refreshingUsage = false;
  #context: Pick<HostUsage, "contextWindowTokens" | "contextUsedTokens" | "contextUsagePercent"> =
    {};

  constructor(
    readonly input: SessionInput,
    readonly environment: NodeJS.ProcessEnv,
    readonly factory: CodeBuddyClientFactory,
    readonly readHistory: CodeBuddyHistoryReader = readNativeHistory,
    readonly onClose: () => void = () => {},
    readonly profile: CodeBuddyRuntimeProfile = CODEBUDDY_RUNTIME_PROFILE,
  ) {
    this.harnessId = profile.harnessId;
    this.capabilities = capabilitiesForProfile(profile);
    this.#commands = structuredClone(profile.staticCommandCatalog ?? { commands: [] });
    if (nativeCommandsEnabled(profile))
      this.commands = {
        list: async () =>
          this.#closed || this.#fault
            ? failure("invalidState", "Session is closed or faulted", this.profile)
            : { ok: true, value: structuredClone(this.#commands) },
        execute: (command) => this.#executeCommand(command),
      };
    this.subagents = new CodeBuddySubagents({
      parent: () => this.#ref,
      cwd: input.cwd,
      environment,
      emit: (event) => {
        // Agent Tools are routed before ordinary output, but have the same
        // parent-message boundary. Child progress/completion is not a boundary.
        if (event.type === "item.started" && event.item.type === "subagentDelegation")
          this.#active?.output.completeMessage();
        this.#emit(event);
      },
      profile,
    });
    this.#interactions = new CodeBuddyInteractions(
      (output) => this.#channel.emit(output),
      () => this.#client,
      profile,
    );
    this.#client = this.#createClient();
  }

  #createClient() {
    const generation = ++this.#generation;
    return this.factory({
      cwd: this.input.cwd,
      environment: this.environment,
      ephemeral: false,
      handlers: {
        fault: (error) => {
          if (generation !== this.#generation || this.#closed) return;
          if (this.#replay) this.#replay.fault ??= { error };
          else this.#onFault(error);
        },
        update: (notification) => {
          if (generation !== this.#generation || this.#closed || this.#fault) return;
          if (this.#ref && notification.sessionId !== this.#ref.nativeSessionId) return;
          try {
            const update = record(notification.update);
            if (
              nativeCommandsEnabled(this.profile) &&
              update.sessionUpdate === "available_commands_update"
            ) {
              // WorkBuddy deliberately exposes only its reviewed static catalog;
              // CodeBuddy keeps main's live native command discovery (including /cost).
              if (!this.profile.staticCommandCatalog) {
                const commands = commandCatalog(update.availableCommands, this.profile);
                if (this.#replay) this.#replay.commands = commands;
                else this.#commands = commands;
              }
              return;
            }
            if (!this.#replay) this.#dispatchUpdate(update);
          } catch (error) {
            if (this.#replay) this.#replay.fault ??= { error };
            else this.#onFault(error);
          }
        },
        permission: (request) =>
          generation !== this.#generation || request.sessionId !== this.#ref?.nativeSessionId
            ? Promise.resolve({ outcome: { outcome: "cancelled" as const } })
            : this.#interactionTurn((turnId) => this.#interactions.permission(turnId, request), {
                outcome: { outcome: "cancelled" as const },
              }),
        question: (params) =>
          generation !== this.#generation || params.sessionId !== this.#ref?.nativeSessionId
            ? Promise.resolve({ outcome: "cancelled" })
            : this.#interactionTurn((turnId) => this.#interactions.question(turnId, params), {
                outcome: "cancelled",
              }),
      },
    });
  }

  #assertClient(generation: number) {
    if (this.#closed || this.#fault || generation !== this.#generation)
      throw new CodeBuddyError("invalidState", "ACP client is no longer current");
    if (this.#replay?.fault) throw this.#replay.fault.error;
  }

  /** Every fresh process must restore an unanchored rewind before it can accept prompts. */
  async #openClient(): Promise<Record<string, unknown>> {
    const client = this.#client;
    const generation = this.#generation;
    let rewind: ReturnType<typeof pendingNativeHistoryRewind>;
    if (this.#ref) {
      const history = await this.#history(this.#ref);
      this.#assertClient(generation);
      const snapshot = snapshotFromHistory(history, this.#ref, this.input.cwd, this.profile);
      this.#hasTurn = snapshot.turns.length > 0;
      this.#loadedTurns = snapshot.turns;
      this.#usage = historyUsage(history);
      this.#meterHistory(history, true);
      rewind = pendingNativeHistoryRewind(history);
    } else {
      // A new Session has no native requests yet.
      this.#emit({ type: "usage.history", complete: true });
    }
    this.#assertClient(generation);
    await client.initialize();
    this.#assertClient(generation);
    const opened = await client.open(this.input.cwd, this.#ref?.nativeSessionId);
    this.#assertClient(generation);
    const sessionId = this.#ref?.nativeSessionId ?? text(opened.sessionId);
    if (!sessionId || (opened.sessionId && opened.sessionId !== sessionId))
      throw new CodeBuddyError("protocolError", "ACP returned a different Native Session identity");
    if (rewind) {
      if (!client.rollback)
        throw new CodeBuddyError("unsupported", "Native history rewind is unavailable");
      const result = await client.rollback(sessionId, rewind.forkPointId);
      this.#assertClient(generation);
      if (result.applied !== true || (result.actualForkPointId ?? null) !== rewind.forkPointId)
        throw new CodeBuddyError("nativeFailure", "Native history rewind was not confirmed");
    }
    return { ...opened, sessionId };
  }

  async initialize() {
    const saved =
      this.input.kind === "resume" && record(this.input.nativeRef.locator).codebuddyDerived === 1
        ? record(record(this.input.nativeRef.locator).configuration)
        : {};
    if (this.input.kind === "resume") this.#ref = this.input.nativeRef;
    const opened = await this.#openClient();
    // History that predates this process is behind the autonomous Turn boundary.
    this.#autonomous.reset(this.#loadedTurns ?? []);
    this.#loadedTurns = undefined;
    this.#ref = nativeSessionRefSchema.parse({
      harnessId: this.profile.harnessId,
      nativeSessionId: opened.sessionId,
      formatVersion: 1,
      ...(this.#ref?.locator || this.capabilities.history.fork
        ? {
            locator: {
              ...record(this.#ref?.locator),
              ...(this.capabilities.history.fork
                ? { boundCwd: codeBuddyCanonicalCwd(this.input.cwd) }
                : {}),
            },
          }
        : {}),
    });
    this.#apply(configuration(opened.configOptions, this.profile), false);
    if (this.input.kind === "create" && this.input.executionPolicy === "unattended-full-access") {
      // Unlike bypassPermissions, the native fullAccess option also covers HIGH/CRITICAL actions.
      await this.#configure("mode", "fullAccess");
    } else if (this.input.permissionModeId || text(saved.mode))
      await this.#configure("mode", this.input.permissionModeId ?? text(saved.mode));
    if (this.input.model || text(saved.model))
      await this.#configure(
        "model",
        this.input.model ? nativeModel(this.input.model) : text(saved.model),
      );
    if (this.input.thinkingOptionId || text(saved.thinking))
      await this.#configure("thought_level", this.input.thinkingOptionId ?? text(saved.thinking));
    if (this.#fault || this.#closed)
      throw new CodeBuddyError("invalidState", "Native Session failed while opening");
    this.initialState = { ...this.#state };
    this.initialUsage = this.#usage;
  }

  #emit(event: HostEvent) {
    event = configureSubagentEvent(event, this.#subagentConfiguration());
    this.#channel.emit({ kind: "event", event });
  }

  #emitUsage() {
    const usage = { ...this.#usage, ...this.#context };
    this.#emit({
      type: "session.usage.changed",
      usage: Object.keys(usage).length ? usage : null,
    });
  }

  /** Publishes native requests not yet metered; the first read also declares completeness. */
  #meterHistory(history: string, historical: boolean) {
    const { requests, complete } = historyUsageRequests(history, historical);
    for (const request of requests) {
      if (this.#meteredRequests.has(request.requestId)) continue;
      this.#meteredRequests.add(request.requestId);
      this.#emit({ type: "usage.request", request });
    }
    if (historical || !complete) this.#emit({ type: "usage.history", complete });
  }
  /** Routes one native frame to the Host Turn, a native drain round, or its buffer. */
  #dispatchUpdate(update: Record<string, unknown>) {
    const unsolicited = readUnsolicitedTurn(update);
    if (unsolicited) {
      this.#autonomous.announce(unsolicited.requestId);
      this.#flushAutonomous();
      return;
    }
    if (update.sessionUpdate === "session_end") {
      const round = this.#autonomous.end(requestIdOf(update));
      if (!round) return;
      if (round.started) void this.#finishAutonomous(round);
      else this.#flushAutonomous();
      return;
    }
    const route = this.#autonomous.route(update);
    if (route === "active") {
      if (!this.#replaying) this.#applyUpdate(update);
      return;
    }
    if (route) {
      route.frames.push(update);
      return;
    }
    if (this.#replaying) return;
    this.#applyUpdate(update);
  }

  /**
   * Binds a native Interaction to the Turn that requested it. A Host prompt that already
   * returned cannot own later Interactions; a drain run owns them once its public Turn
   * identity exists, and is cancelled if that run is dropped first.
   */
  #interactionTurn<T>(run: (turnId: HostTurnId) => Promise<T>, cancelled: T): Promise<T> {
    const active = this.#active;
    if (active && !active.autonomous && !active.promptSettled) return run(active.command.turnId);
    const round = this.#autonomous.owner();
    if (!round) return Promise.resolve(cancelled);
    return round.identity.then((turnId) =>
      turnId && this.#active?.autonomous?.round === round ? run(turnId) : cancelled,
    );
  }

  /** Frames of the active Turn, including a native drain Turn that now owns the Session. */
  #applyUpdate(update: Record<string, unknown>) {
    // A started Tool keeps its owner even when later fragments change its metadata.
    if (
      (text(record(update._meta)["codebuddy.ai/parentToolCallId"]) ||
        !this.#active?.output.hasItem(`tool-${text(update.toolCallId)}`)) &&
      this.subagents.update(update)
    )
      return;
    if (update.sessionUpdate === "config_option_update" && this.#config)
      this.#apply(configuration(update.configOptions, this.profile));
    if (
      update.sessionUpdate === "usage_update" &&
      typeof update.used === "number" &&
      typeof update.size === "number" &&
      update.size > 0
    ) {
      this.#context = {
        contextUsedTokens: update.used,
        contextWindowTokens: update.size,
        contextUsagePercent: (update.used / update.size) * 100,
      };
      this.#emitUsage();
      void this.refreshUsage();
    }
    this.#active?.output.update(update);
  }

  #flushAutonomous() {
    if (this.#active || this.#replaying || this.#closed || this.#fault) return;
    const round = this.#autonomous.next();
    if (!round) return;
    this.#startAutonomous(round);
    try {
      for (const frame of round.frames.drain()) this.#applyUpdate(frame);
    } catch (error) {
      this.#onFault(error);
      return;
    }
    if (round.ended) void this.#finishAutonomous(round);
  }

  #startAutonomous(round: CodeBuddyAutonomousRound) {
    const turnId = hostTurnIdSchema.parse(randomUUID());
    const completion = Promise.withResolvers<undefined>();
    const active: ActiveTurn = {
      command: { type: "turn.start", turnId, input: [] },
      output: new CodeBuddyTurnOutput(
        turnId,
        this.input.cwd,
        (event) => this.#emit(event),
        this.profile,
      ),
      completion: completion.promise,
      nativeCommand: false,
      cancelled: false,
      done: false,
      autonomous: { round },
      settle: () => completion.resolve(undefined),
    };
    this.#active = active;
    this.#autonomous.start(round, turnId);
    this.subagents.begin(turnId);
    this.#emit({ type: "turn.autonomous.started", turnId, input: [] });
    this.#emit({ type: "turn.started", turnId });
  }

  /**
   * `session_end` is the native terminal for a drain Turn; the prompt response belongs to
   * Host-requested Turns. The frame always reports `end_turn`, so the persisted Turn decides
   * success and supplies the stable native identity.
   */
  async #finishAutonomous(round: CodeBuddyAutonomousRound) {
    const active = this.#active;
    if (!active?.autonomous || active.autonomous.round !== round || active.done) return;
    try {
      const snapshot = await this.#snapshot();
      const persisted = this.#autonomous.autonomousTurn(snapshot.turns);
      if (persisted) this.#hasTurn = true;
      const outcome: TurnOutcome = active.cancelled
        ? { status: "cancelled" }
        : persisted?.outcome.status === "succeeded"
          ? { status: "succeeded" }
          : {
              status: "failed",
              error: nativeError(
                new CodeBuddyError(
                  "nativeFailure",
                  "Native autonomous Turn did not record success",
                ),
                this.profile,
              ),
            };
      if (outcome.status === "cancelled") await this.#resumeAfterCancel();
      if (active.done) return;
      this.#finish(active, outcome, persisted?.nativeTurnRef);
      if (this.#usage) this.#emitUsage();
    } catch (error) {
      if (!active.done)
        this.#finish(active, { status: "failed", error: nativeError(error, this.profile) });
    }
  }

  #apply(config: ReturnType<typeof configuration>, emit = true) {
    // Context belongs to the last confirmed Model. Reconfirming that Model must
    // preserve usage received after its config update but before the response.
    if (
      this.#state.effectiveModel &&
      this.#state.effectiveModel.id !== config.state.effectiveModel?.id
    ) {
      this.#context = {};
      this.#emitUsage();
    }
    this.#config = config;
    if (this.#ref && record(this.#ref.locator).codebuddyDerived === 1)
      this.#ref = nativeSessionRefSchema.parse({
        ...this.#ref,
        locator: {
          ...record(this.#ref.locator),
          configuration: {
            model: config.state.effectiveModel ? nativeModel(config.state.effectiveModel) : "",
            mode: config.state.effectivePermissionModeId ?? "",
            thinking: config.state.effectiveThinkingOptionId ?? "",
          },
        },
      });
    this.#state = { ...config.state, ...(this.#ref ? { nativeRef: this.#ref } : {}) };
    if (emit) this.#emit({ type: "session.state.changed", state: this.#state });
  }

  #configurationRequest() {
    const generation = this.#generation;
    const client = this.#client;
    const sessionId = this.#ref?.nativeSessionId;
    if (!sessionId) throw new CodeBuddyError("invalidState", "Session is not open");
    return async (id: string, value: string) => {
      this.#assertClient(generation);
      const result = await client.configure(sessionId, id, value);
      this.#assertClient(generation);
      return result;
    };
  }

  async #configure(id: string, value: string) {
    const generation = this.#generation;
    const confirmed = await selectConfiguration(
      this.#config,
      id,
      value,
      this.profile,
      this.#configurationRequest(),
    );
    this.#assertClient(generation);
    this.#apply(confirmed);
  }

  async #history(ref: NativeSessionRef): Promise<string> {
    try {
      return await this.readHistory(this.input.cwd, ref, this.environment, this.profile);
    } catch (error) {
      // A newly created Session may not have written anything, even after a quick Stop.
      if (
        !this.#hasTurn &&
        this.input.kind === "create" &&
        error instanceof CodeBuddyError &&
        error.code === "sessionNotFound"
      )
        return "";
      throw error;
    }
  }

  async #snapshot(historyTimeout?: number): Promise<HostThreadSnapshot> {
    if (!this.#ref) throw new CodeBuddyError("invalidState", "Session is not open");
    const read = this.#history(this.#ref);
    const history = historyTimeout
      ? await bounded(read, historyTimeout, "Native Turn history read")
      : await read;
    if (this.#closed || this.#fault)
      throw new CodeBuddyError("invalidState", "Session closed during history read");
    const snapshot = snapshotFromHistory(history, this.#ref, this.input.cwd, this.profile);
    if (snapshot.turns.length) this.#hasTurn = true;
    this.#usage = historyUsage(history);
    // Requests the last Turn added, now persisted; CodeBuddy ACP reports no per-request usage.
    this.#meterHistory(history, false);
    return { ...this.subagents.project(snapshot), state: this.#state };
  }

  /** Read persisted request usage without waiting for the ACP prompt (including tool waits). */
  async refreshUsage(): Promise<void> {
    if (this.#refreshingUsage || this.#closed || this.#fault || this.#replay || !this.#ref) return;
    this.#refreshingUsage = true;
    const active = this.#active,
      generation = this.#generation;
    try {
      const history = await this.readHistory(
        this.input.cwd,
        this.#ref,
        this.environment,
        this.profile,
      );
      if (this.#closed || this.#fault || this.#active !== active || this.#generation !== generation)
        return;
      this.#usage = historyUsage(history);
      this.#meterHistory(history, false);
      this.#emitUsage();
    } catch {
      // The native file may not exist yet or may be mid-append. Telemetry must not fail a Turn;
      // the next native usage notification, explicit refresh or terminal snapshot retries.
    } finally {
      this.#refreshingUsage = false;
    }
  }

  #subagentConfiguration(): SubagentConfiguration {
    const state = this.#state;
    const model = state.effectiveModel ? nativeModel(state.effectiveModel) : undefined;
    return {
      ...(model ? { model } : {}),
      ...(state.effectiveThinkingOptionId
        ? { reasoningEffort: state.effectiveThinkingOptionId }
        : {}),
    };
  }

  async readSnapshot(): Promise<HarnessResult<HostThreadSnapshot>> {
    const result = await this.#readSnapshot();
    return result.ok
      ? { ok: true, value: configureSubagentSnapshot(result.value, this.#subagentConfiguration()) }
      : result;
  }

  async #readSnapshot(): Promise<HarnessResult<HostThreadSnapshot>> {
    if (this.#closed || this.#fault)
      return failure("invalidState", "Session is closed or faulted", this.profile);
    if (this.#busy || this.#active)
      return failure("sessionBusy", "Session is executing an operation", this.profile);
    this.#busy = true;
    try {
      return { ok: true, value: await this.#snapshot() };
    } catch (error) {
      return { ok: false, error: nativeError(error, this.profile) };
    } finally {
      this.#busy = false;
    }
  }

  async #executeCommand(
    command: HarnessCommandInvocation,
  ): Promise<HarnessResult<HarnessCommandAccepted>> {
    const result = await this.#execute({ ...command, type: "command.execute" });
    return result.ok ? { ok: true, value: { turnId: command.turnId } } : result;
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
  async execute(
    command: HostCommand,
  ): Promise<
    HarnessResult<
      | TurnStartAccepted
      | TurnSteerAccepted
      | TurnCancelAccepted
      | InteractionRespondAccepted
      | ModelSelectCompleted
    >
  > {
    const invocation =
      command.type === "turn.start"
        ? command.input
            .map((item) => item.text)
            .join("\n")
            .trim()
            .split(/\s/u)[0]
        : undefined;
    if (nativeCommandsEnabled(this.profile) && isExcludedInvocation(invocation))
      return failure("unsupported", "Command is not available in this Session", this.profile);
    return this.#execute(command, invocation);
  }

  async #execute(
    command: HostCommand | (HarnessCommandInvocation & { type: "command.execute" }),
    invocation?: string,
  ): Promise<
    HarnessResult<
      | TurnStartAccepted
      | TurnSteerAccepted
      | TurnCancelAccepted
      | InteractionRespondAccepted
      | ModelSelectCompleted
    >
  > {
    if (this.#closed || this.#fault)
      return failure("invalidState", "Session is closed or faulted", this.profile);
    if (command.type === "turn.steer") return unsupportedSteer(this.profile.displayName);
    if (command.type === "interaction.respond") return this.#interactions.respond(command);
    if (command.type === "turn.cancel") {
      const active = this.#active;
      if (!active || active.command.turnId !== command.turnId || !this.#ref)
        return failure("invalidRequest", "Turn is not active", this.profile);
      if (!active.cancelled) {
        active.cancelled = true;
        const generation = this.#generation;
        try {
          const requested = this.#client.cancel(this.#ref.nativeSessionId);
          this.#interactions.close();
          await requested;
        } catch (error) {
          // The prompt may have returned and retired its process while cancel was in flight.
          if (generation === this.#generation) {
            if (this.#active === active) this.#onFault(error);
            return { ok: false, error: nativeError(error, this.profile) };
          }
        }
        if (this.#active === active && !this.#closed) {
          void bounded(active.completion, 30_000, "ACP cancel acknowledgement").catch((error) => {
            // Once the process has exited, only best-effort history remains.
            if (this.#active === active && !this.#needsResume) this.#onFault(error);
          });
        }
      }
      return { ok: true, value: { cancellationRequested: true } };
    }
    if (
      this.#busy ||
      (this.#active &&
        (this.#active.cancelled ||
          (command.type !== "model.select" && command.type !== "thinking.select")))
    )
      return failure("sessionBusy", "Session is executing an operation", this.profile);
    this.#busy = true;
    try {
      if (command.type === "turn.start" || command.type === "command.execute") {
        if (
          !command.turnId.trim() ||
          (command.type === "turn.start" &&
            (!command.input.length ||
              command.input.some((item) => item.type !== "text") ||
              !command.input
                .map((item) => item.text)
                .join("")
                .trim()))
        )
          return failure("invalidRequest", "A nonempty text prompt is required", this.profile);
        if (this.#needsResume) await this.#resumeClient();
        const nativeCommand =
          command.type === "command.execute" ||
          (nativeCommandsEnabled(this.profile) &&
            this.#commands.commands.some((entry) => entry.invocation === invocation));
        if (command.type === "command.execute") {
          const parsed = commandPrompt(command, this.#commands, this.profile);
          if (!parsed.ok) return parsed;
          command = {
            type: "turn.start",
            turnId: command.turnId,
            input: [{ type: "text", text: parsed.value }],
          };
        }
        // Reading history also yields to native notifications, so a drain announced during
        // admission is visible before the Host prompt would reach the native process.
        await this.#snapshot();
        if (this.#closed || this.#fault)
          return failure("invalidState", "Session closed before Turn start", this.profile);
        if (this.#active)
          return failure("sessionBusy", "Session is executing an operation", this.profile);
        const active: ActiveTurn = {
          command,
          output: new CodeBuddyTurnOutput(
            command.turnId,
            this.input.cwd,
            (event) => this.#emit(event),
            this.profile,
          ),
          nativeCommand,
          cancelled: false,
          done: false,
          completion: Promise.resolve(),
        };
        this.#active = active;
        this.subagents.begin(command.turnId);
        this.#emit({ type: "turn.started", turnId: command.turnId });
        active.completion = this.#run(active);
        return { ok: true, value: { turnId: command.turnId } };
      }
      if (this.#needsResume) await this.#resumeClient();
      await this.#configure(
        command.type === "model.select"
          ? "model"
          : command.type === "thinking.select"
            ? "thought_level"
            : "mode",
        command.type === "model.select"
          ? nativeModel(command.model)
          : command.type === "thinking.select"
            ? command.thinkingOptionId
            : command.permissionModeId,
      );
      return { ok: true, value: { completed: true } };
    } catch (error) {
      return { ok: false, error: nativeError(error, this.profile) };
    } finally {
      this.#busy = false;
    }
  }

  async #run(active: ActiveTurn) {
    let cancellationConfirmed = false;
    try {
      if (!this.#ref) throw new CodeBuddyError("invalidState", "Session is not open");
      const response = await this.#client
        .prompt(this.#ref.nativeSessionId, active.command.input.map((item) => item.text).join("\n"))
        .finally(() => {
          // Once the native run has returned, later Interactions belong to the next run.
          active.promptSettled = true;
        });
      if (active.done || this.#closed) return;
      const stop = response.stopReason,
        meta = record(response._meta);
      const outcome: TurnOutcome =
        stop === "cancelled" || meta["codebuddy.ai/outcome"] === "CANCELLED"
          ? { status: "cancelled" }
          : stop === "end_turn" &&
              // Native PARTIAL_SUCCESS means a final answer with recorded model/tool errors.
              // Those remain visible on individual Items; they do not fail the completed Turn.
              (!meta["codebuddy.ai/outcome"] ||
                meta["codebuddy.ai/outcome"] === "SUCCESS" ||
                meta["codebuddy.ai/outcome"] === "PARTIAL_SUCCESS")
            ? { status: "succeeded" }
            : {
                status: "failed",
                error: nativeTurnError(stop, meta, this.profile),
              };
      if (outcome.status === "cancelled") {
        active.cancelled = true;
        ++this.#generation;
        this.#interactions.close();
        try {
          await this.#client.close();
        } catch (error) {
          this.#onFault(error);
          return;
        }
        if (active.done || this.#closed) return;
        this.#needsResume = true;
        cancellationConfirmed = true;
      }
      // After shutdown, history can enrich cancellation but cannot change its outcome.
      const snapshot = await this.#snapshot(cancellationConfirmed ? 1_000 : undefined);
      if (active.done || this.#closed) return;
      // The prompt response names this Turn; drain Turns persisted before this snapshot
      // remain for their own autonomous Turns instead of counting as Host additions.
      const userMessageId = text(response.userMessageId) || undefined;
      const persisted = this.#autonomous.ownHostTurn(snapshot.turns, userMessageId);
      if (!persisted && !active.nativeCommand && outcome.status === "succeeded")
        throw new CodeBuddyError(
          "protocolError",
          "Could not identify exactly one persisted Native Turn",
        );
      active.output.confirmCompaction(persisted?.items ?? []);
      if (active.nativeCommand)
        active.output.replayCommandResult(
          (persisted?.items ?? []).filter(({ item }) => !this.subagents.hasItem(item.itemId)),
        );
      const nativeTurnRef = persisted?.nativeTurnRef;
      if (nativeTurnRef) this.#hasTurn = true;
      const compactCommand =
        outcome.status !== "cancelled" &&
        active.nativeCommand &&
        /^\/compact(?:\s|$)/u.test(
          active.command.input
            .map((item) => item.text)
            .join("\n")
            .trim(),
        );
      const persistedOutcome = compactCommand ? persisted?.outcome : undefined;
      if (compactCommand && (!persistedOutcome || persistedOutcome.status === "unknown"))
        throw new CodeBuddyError(
          "protocolError",
          "Native compaction terminal outcome was not persisted",
        );
      const terminalOutcome: TurnOutcome =
        persistedOutcome && persistedOutcome.status !== "unknown" ? persistedOutcome : outcome;
      this.#finish(
        active,
        {
          ...terminalOutcome,
          ...(persisted?.checkpoint ? { checkpoint: persisted.checkpoint } : {}),
        },
        nativeTurnRef,
      );
      if (this.#usage) this.#emitUsage();
    } catch (error) {
      if (!active.done && !this.#closed)
        this.#finish(
          active,
          cancellationConfirmed
            ? { status: "cancelled" }
            : { status: "failed", error: nativeError(error, this.profile) },
        );
    }
  }

  /** Runs only under the native operation gate, after the old process has exited. */
  async #resumeClient() {
    const replay: SessionReplay = {};
    this.#replay = replay;
    let candidate: CodeBuddyClient | undefined;
    try {
      this.#client = candidate = this.#createClient();
      const generation = this.#generation;
      const loaded = await this.#openClient();
      const restored = await restoreConfiguration(
        configuration(loaded.configOptions, this.profile),
        this.#state,
        this.profile,
        this.#configurationRequest(),
      );
      this.#assertClient(generation);
      this.#apply(restored);
      if (!this.profile.staticCommandCatalog) this.#commands = replay.commands ?? { commands: [] };
      this.#needsResume = false;
    } catch (error) {
      ++this.#generation;
      try {
        await candidate?.close();
      } catch (closeError) {
        // Do not open a successor if this process could still own the Native Session.
        this.#onFault(closeError);
      }
      throw error;
    } finally {
      this.#replay = undefined;
    }
  }

  #finish(active: ActiveTurn, outcome: TurnOutcome, nativeTurnRef?: NativeTurnRef) {
    if (active.done) return;
    active.done = true;
    active.settle?.();
    if (active.autonomous) this.#autonomous.finish(active.autonomous.round);
    this.subagents.finish(outcome);
    this.#interactions.close();
    active.output.finish(outcome.status, outcome.status === "failed" ? outcome.error : undefined);
    this.#emit({
      type: "turn.completed",
      turnId: active.command.turnId,
      outcome,
      ...(nativeTurnRef ? { nativeTurnRef } : {}),
    });
    if (this.#active === active) this.#active = undefined;
    this.#flushAutonomous();
  }

  #onFault(error: unknown) {
    if (this.#fault || this.#closed) return;
    this.#fault = nativeError(error, this.profile);
    this.#autonomous.close();
    if (this.#active) this.#finish(this.#active, { status: "failed", error: this.#fault });
    this.#interactions.close();
    this.#emit({ type: "session.faulted", error: this.#fault });
    void this.#client?.close().catch(() => {});
    this.#channel.end();
  }

  close(): Promise<void> {
    this.#closing ??= this.#close();
    return this.#closing;
  }
  async #close() {
    this.#closed = true;
    this.#autonomous.close();
    this.#interactions.close();
    try {
      await this.#client.close();
      if (this.#active)
        this.#finish(this.#active, { status: "cancelled", reason: "Session closed" });
    } catch (error) {
      if (this.#active)
        this.#finish(this.#active, { status: "failed", error: nativeError(error, this.profile) });
      throw error;
    } finally {
      this.subagents.close();
      this.#channel.end();
      this.onClose();
    }
  }
}
