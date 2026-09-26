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
import { HarnessOutputChannel } from "@codexhost/harness-adapter";
import {
  nativeSessionRefSchema,
  type HarnessCommandCatalog,
  type NativeTurnRef,
  type NativeSessionRef,
} from "@codexhost/shared-contracts";
import type { CodeBuddyClient, CodeBuddyClientFactory } from "./acp-client.js";
import {
  bounded,
  CODEBUDDY_RUNTIME_PROFILE,
  CodeBuddyError,
  failure,
  nativeError,
  record,
  text,
  type CodeBuddyRuntimeProfile,
} from "./common.js";
import {
  capabilitiesForProfile,
  configuration,
  confirmedConfiguration,
  nativeModel,
} from "./configuration.js";
import {
  codeBuddyCanonicalCwd,
  historyUsage,
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
import { codeBuddySupportsSteer } from "./steer.js";

type SessionInput = Extract<OpenSessionInput, { kind: "create" | "resume" }>;
export type CodeBuddyHistoryReader = typeof readNativeHistory;
interface ActiveTurn {
  command: TurnStartCommand;
  output: CodeBuddyTurnOutput;
  before: Set<string>;
  beforeItems: Set<string>;
  completion: Promise<void>;
  nativeCommand: boolean;
  cancelled: boolean;
  done: boolean;
  /** Steers this Turn's native process has already accepted. Not persisted. */
  acceptedSteers: number;
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
  readonly subagents: CodeBuddySubagents;
  #client: CodeBuddyClient;
  #generation = 0;
  #replaying = false;
  readonly #interactions: CodeBuddyInteractions;
  #config: ReturnType<typeof configuration> | undefined;
  #ref: NativeSessionRef | undefined;
  #state: HarnessSessionState = {};
  #active: ActiveTurn | undefined;
  #busy = false;
  #closed = false;
  #closing: Promise<void> | undefined;
  #fault: ReturnType<typeof nativeError> | undefined;
  #hasTurn = false;
  #usage: HostUsage | null = null;
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
      emit: (event) => this.#emit(event),
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
          if (generation === this.#generation) this.#onFault(error);
        },
        update: (notification) => {
          if (generation !== this.#generation || this.#closed) return;
          if (this.#ref && notification.sessionId !== this.#ref.nativeSessionId) return;
          try {
            const update = record(notification.update);
            if (
              nativeCommandsEnabled(this.profile) &&
              update.sessionUpdate === "available_commands_update"
            ) {
              // WorkBuddy deliberately exposes only its reviewed static catalog;
              // CodeBuddy keeps main's live native command discovery (including /cost).
              if (!this.profile.staticCommandCatalog)
                this.#commands = commandCatalog(update.availableCommands, this.profile);
              return;
            }
            if (this.#replaying) return;
            if (this.subagents.update(update)) return;
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
              this.#emit({
                type: "session.usage.changed",
                usage: { ...this.#usage, ...this.#context },
              });
            }
            this.#active?.output.update(update);
          } catch (error) {
            this.#onFault(error);
          }
        },
        permission: (request) =>
          generation === this.#generation &&
          !this.#replaying &&
          this.#active &&
          request.sessionId === this.#ref?.nativeSessionId
            ? this.#interactions.permission(this.#active.command.turnId, request)
            : Promise.resolve({ outcome: { outcome: "cancelled" } }),
        question: (params) =>
          generation === this.#generation &&
          !this.#replaying &&
          this.#active &&
          params.sessionId === this.#ref?.nativeSessionId
            ? this.#interactions.question(this.#active.command.turnId, params)
            : Promise.resolve({ outcome: "cancelled" }),
      },
    });
  }

  /** Every fresh process must restore an unanchored rewind before it can accept prompts. */
  async #openClient(): Promise<Record<string, unknown>> {
    let rewind: ReturnType<typeof pendingNativeHistoryRewind>;
    if (this.#ref) {
      const history = await this.readHistory(
        this.input.cwd,
        this.#ref,
        this.environment,
        this.profile,
      );
      this.#hasTurn =
        snapshotFromHistory(history, this.#ref, this.input.cwd, this.profile).turns.length > 0;
      this.#usage = historyUsage(history);
      rewind = pendingNativeHistoryRewind(history);
    }
    await this.#client.initialize();
    if (codeBuddySupportsSteer(this.#client.nativeVersion)) this.capabilities.steer = true;
    else delete this.capabilities.steer;
    const opened = await this.#client.open(this.input.cwd, this.#ref?.nativeSessionId);
    const sessionId = this.#ref?.nativeSessionId ?? text(opened.sessionId);
    if (!sessionId || (opened.sessionId && opened.sessionId !== sessionId))
      throw new CodeBuddyError("protocolError", "ACP returned a different Native Session identity");
    if (rewind) {
      if (!this.#client.rollback)
        throw new CodeBuddyError("unsupported", "Native history rewind is unavailable");
      const result = await this.#client.rollback(sessionId, rewind.forkPointId);
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
    this.#channel.emit({ kind: "event", event });
  }
  #apply(config: ReturnType<typeof configuration>, emit = true) {
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

  async #configure(id: string, value: string) {
    const option = this.#config?.options.find((option) => option.id === id);
    const listed =
      Array.isArray(option?.options) &&
      option.options.some((option) => record(option).value === value);
    const allowedProductModel = id === "model" && this.profile.allowUnlistedModelSelection;
    if (!listed && !allowedProductModel)
      throw new CodeBuddyError(
        "invalidRequest",
        `Unavailable ${this.profile.displayName} ${id} selection`,
      );
    if (!this.#ref) throw new CodeBuddyError("invalidState", "Session is not open");
    const result = await this.#client.configure(this.#ref.nativeSessionId, id, value);
    if (this.#closed || this.#fault)
      throw new CodeBuddyError("invalidState", "Session closed during configuration");
    this.#apply(confirmedConfiguration(result, id, value, this.profile));
  }

  async #snapshot(): Promise<HostThreadSnapshot> {
    if (!this.#ref) throw new CodeBuddyError("invalidState", "Session is not open");
    try {
      const history = await this.readHistory(
        this.input.cwd,
        this.#ref,
        this.environment,
        this.profile,
      );
      this.#usage = historyUsage(history);
      return {
        ...this.subagents.project(
          snapshotFromHistory(history, this.#ref, this.input.cwd, this.profile),
        ),
        state: this.#state,
      };
    } catch (error) {
      if (
        !this.#hasTurn &&
        this.input.kind === "create" &&
        error instanceof CodeBuddyError &&
        error.code === "sessionNotFound"
      )
        return { turns: [], state: this.#state };
      throw error;
    }
  }

  async readSnapshot(): Promise<HarnessResult<HostThreadSnapshot>> {
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
    const parsed = commandPrompt(command, this.#commands, this.profile);
    if (!parsed.ok) return parsed;
    const result = await this.#execute(
      { type: "turn.start", turnId: command.turnId, input: [{ type: "text", text: parsed.value }] },
      true,
    );
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
    return this.#execute(
      command,
      nativeCommandsEnabled(this.profile) &&
        this.#commands.commands.some((entry) => entry.invocation === invocation),
    );
  }

  async #execute(
    command: HostCommand,
    nativeCommand = false,
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
    if (command.type === "interaction.respond") return this.#interactions.respond(command);
    if (command.type === "turn.steer") return this.#steer(command);
    if (command.type === "turn.cancel") {
      const active = this.#active;
      if (!active || active.command.turnId !== command.turnId || !this.#ref)
        return failure("invalidRequest", "Turn is not active", this.profile);
      if (!active.cancelled) {
        active.cancelled = true;
        try {
          await this.#client.cancel(this.#ref.nativeSessionId);
        } catch (error) {
          this.#onFault(error);
          return { ok: false, error: nativeError(error, this.profile) };
        }
        this.#interactions.close();
        void bounded(active.completion, 30_000, "ACP cancel acknowledgement").catch((error) =>
          this.#onFault(error),
        );
      }
      return { ok: true, value: { cancellationRequested: true } };
    }
    if (
      this.#busy ||
      (this.#active && command.type !== "model.select" && command.type !== "thinking.select")
    )
      return failure("sessionBusy", "Session is executing an operation", this.profile);
    this.#busy = true;
    try {
      if (command.type === "turn.start") {
        if (
          !command.turnId.trim() ||
          !command.input.length ||
          command.input.some((item) => item.type !== "text") ||
          !command.input
            .map((item) => item.text)
            .join("")
            .trim()
        )
          return failure("invalidRequest", "A nonempty text prompt is required", this.profile);
        const snapshot = await this.#snapshot();
        const before = new Set(snapshot.turns.map((turn) => turn.nativeTurnRef.nativeTurnKey));
        const beforeItems = new Set(
          snapshot.turns.flatMap((turn) => turn.items.map((snapshot) => snapshot.item.itemId)),
        );
        if (this.#closed || this.#fault)
          return failure("invalidState", "Session closed before Turn start", this.profile);
        const active: ActiveTurn = {
          command,
          before,
          beforeItems,
          output: new CodeBuddyTurnOutput(
            command.turnId,
            this.input.cwd,
            (event) => this.#emit(event),
            this.profile,
          ),
          nativeCommand,
          cancelled: false,
          done: false,
          acceptedSteers: 0,
          completion: Promise.resolve(),
        };
        this.#active = active;
        this.subagents.begin(command.turnId);
        if (!nativeCommand) this.#hasTurn = true;
        this.#emit({ type: "turn.started", turnId: command.turnId });
        active.completion = this.#run(active);
        return { ok: true, value: { turnId: command.turnId } };
      }
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

  async #steer(command: TurnSteerCommand): Promise<HarnessResult<TurnSteerAccepted>> {
    const steer = this.#client.steer?.bind(this.#client);
    if (!this.capabilities.steer || !steer)
      return failure(
        "unsupported",
        "This CodeBuddy build cannot steer the active Turn",
        this.profile,
      );
    const active = this.#active;
    if (!active || active.done || active.command.turnId !== command.turnId || !this.#ref)
      return failure("invalidState", "Steer target is not the active Turn", this.profile);
    const body = command.input.map((item) => item.text).join("\n");
    if (!body.trim())
      return failure("invalidRequest", "Steer requires nonempty text", this.profile);
    let result;
    try {
      result = await steer(this.#ref.nativeSessionId, body);
    } catch (error) {
      return { ok: false, error: nativeError(error, this.profile) };
    }
    if (!result.steered)
      return failure(
        "invalidState",
        result.reason === "stale"
          ? "CodeBuddy rejected steer for a different request"
          : "CodeBuddy is not accepting steer",
        this.profile,
      );
    if (this.#active === active) active.acceptedSteers += 1;
    return { ok: true, value: { accepted: true } };
  }

  async #run(active: ActiveTurn) {
    try {
      if (!this.#ref) throw new CodeBuddyError("invalidState", "Session is not open");
      const response = await this.#client.prompt(
        this.#ref.nativeSessionId,
        active.command.input.map((item) => item.text).join("\n"),
      );
      if (active.done) return;
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
                error: nativeError(
                  new CodeBuddyError(
                    "nativeFailure",
                    `Native Turn stopped: ${text(stop) || "unknown"} (${text(meta["codebuddy.ai/outcome"]) || "no native outcome"})`,
                  ),
                  this.profile,
                ),
              };
      const snapshot = await this.#snapshot();
      const added = snapshot.turns.filter(
        (turn) => !active.before.has(turn.nativeTurnRef.nativeTurnKey),
      );
      // Each persisted user row is already its own native Turn. An accepted steer adds one.
      const expectedNativeTurns = 1 + active.acceptedSteers;
      if (
        added.length > expectedNativeTurns ||
        (!active.nativeCommand &&
          outcome.status === "succeeded" &&
          added.length !== expectedNativeTurns)
      )
        throw new CodeBuddyError(
          "protocolError",
          "Could not identify exactly one persisted Native Turn",
        );
      active.output.confirmCompaction(
        snapshot.turns
          .flatMap((turn) => turn.items)
          .filter((snapshot) => !active.beforeItems.has(snapshot.item.itemId)),
      );
      if (active.nativeCommand) active.output.replayCommandResult(added[0]?.items ?? []);
      const nativeTurnRef = added[0]?.nativeTurnRef;
      if (nativeTurnRef) this.#hasTurn = true;
      if (response.userMessageId && nativeTurnRef?.nativeTurnKey !== response.userMessageId)
        throw new CodeBuddyError(
          "protocolError",
          "ACP terminal and native history disagree on Turn identity",
        );
      if (outcome.status === "cancelled") await this.#resumeAfterCancel();
      const compactCommand =
        active.nativeCommand &&
        /^\/compact(?:\s|$)/u.test(
          active.command.input
            .map((item) => item.text)
            .join("\n")
            .trim(),
        );
      const persisted = compactCommand ? added[0]?.outcome : undefined;
      if (compactCommand && (!persisted || persisted.status === "unknown"))
        throw new CodeBuddyError(
          "protocolError",
          "Native compaction terminal outcome was not persisted",
        );
      const terminalOutcome: TurnOutcome =
        persisted && persisted.status !== "unknown" ? persisted : outcome;
      this.#finish(
        active,
        {
          ...terminalOutcome,
          ...(added[0]?.checkpoint ? { checkpoint: added[0].checkpoint } : {}),
        },
        nativeTurnRef,
      );
      if (this.#usage)
        this.#emit({ type: "session.usage.changed", usage: { ...this.#usage, ...this.#context } });
    } catch (error) {
      if (!active.done)
        this.#finish(active, { status: "failed", error: nativeError(error, this.profile) });
    }
  }

  async #resumeAfterCancel() {
    if (!this.#ref)
      throw new CodeBuddyError("invalidState", "Missing Native Session after cancellation");
    const saved = this.#state;
    this.#interactions.close();
    this.#replaying = true;
    ++this.#generation;
    try {
      await this.#client.close();
      if (this.#closed) return;
      this.#client = this.#createClient();
      const loaded = await this.#openClient();
      this.#apply(configuration(loaded.configOptions, this.profile));
      if (saved.effectiveModel) await this.#configure("model", nativeModel(saved.effectiveModel));
      if (saved.effectiveThinkingOptionId)
        await this.#configure("thought_level", saved.effectiveThinkingOptionId);
      if (saved.effectivePermissionModeId)
        await this.#configure("mode", saved.effectivePermissionModeId);
    } catch (error) {
      this.#onFault(error);
      throw error;
    } finally {
      this.#replaying = false;
    }
  }

  #finish(active: ActiveTurn, outcome: TurnOutcome, nativeTurnRef?: NativeTurnRef) {
    if (active.done) return;
    active.done = true;
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
  }

  #onFault(error: unknown) {
    if (this.#fault || this.#closed) return;
    this.#fault = nativeError(error, this.profile);
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
    this.subagents.close();
    if (this.#active) this.#finish(this.#active, { status: "cancelled", reason: "Session closed" });
    this.#interactions.close();
    try {
      await this.#client.close();
    } finally {
      this.#channel.end();
      this.onClose();
    }
  }
}
