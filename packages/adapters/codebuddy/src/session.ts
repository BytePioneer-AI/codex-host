import type {
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
} from "@codexhost/harness-adapter";
import { HarnessOutputChannel } from "@codexhost/harness-adapter";
import {
  nativeSessionRefSchema,
  type NativeTurnRef,
  type NativeSessionRef,
} from "@codexhost/shared-contracts";
import type { CodeBuddyClient, CodeBuddyClientFactory } from "./acp-client.js";
import {
  bounded,
  CODEBUDDY_ID,
  CodeBuddyError,
  failure,
  nativeError,
  record,
  text,
} from "./common.js";
import {
  CODEBUDDY_CAPABILITIES,
  configuration,
  confirmedConfiguration,
  nativeModel,
} from "./configuration.js";
import { historyUsage, readNativeHistory, snapshotFromHistory } from "./history.js";
import { CodeBuddyInteractions } from "./interactions.js";
import { CodeBuddyTurnOutput } from "./projection.js";
import { CodeBuddySubagents } from "./subagents.js";

type SessionInput = Extract<OpenSessionInput, { kind: "create" | "resume" }>;
export type CodeBuddyHistoryReader = typeof readNativeHistory;
interface ActiveTurn {
  command: TurnStartCommand;
  output: CodeBuddyTurnOutput;
  before: Set<string>;
  completion: Promise<void>;
  cancelled: boolean;
  done: boolean;
}

export class CodeBuddySession implements HarnessSession {
  readonly harnessId = CODEBUDDY_ID;
  readonly capabilities = CODEBUDDY_CAPABILITIES;
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
  ) {
    this.subagents = new CodeBuddySubagents({
      parent: () => this.#ref,
      cwd: input.cwd,
      environment,
      emit: (event) => this.#emit(event),
    });
    this.#interactions = new CodeBuddyInteractions(
      (output) => this.#channel.emit(output),
      () => this.#client,
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
          if (generation !== this.#generation || this.#replaying || this.#closed) return;
          if (this.#ref && notification.sessionId !== this.#ref.nativeSessionId) return;
          try {
            const update = record(notification.update);
            if (this.subagents.update(update)) return;
            if (update.sessionUpdate === "config_option_update" && this.#config)
              this.#apply(configuration(update.configOptions));
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

  async initialize() {
    if (this.input.kind === "resume") {
      this.#ref = this.input.nativeRef;
      const history = await this.readHistory(this.input.cwd, this.#ref, this.environment);
      this.#hasTurn = snapshotFromHistory(history, this.#ref, this.input.cwd).turns.length > 0;
      this.#usage = historyUsage(history);
    }
    await this.#client.initialize();
    const opened = await this.#client.open(this.input.cwd, this.#ref?.nativeSessionId);
    const sessionId = this.#ref?.nativeSessionId ?? text(opened.sessionId);
    if (!sessionId || (opened.sessionId && opened.sessionId !== sessionId))
      throw new CodeBuddyError("protocolError", "ACP returned a different Native Session identity");
    this.#ref = nativeSessionRefSchema.parse({
      harnessId: CODEBUDDY_ID,
      nativeSessionId: sessionId,
      formatVersion: 1,
    });
    this.#apply(configuration(opened.configOptions), false);
    if (this.input.kind === "create" && this.input.executionPolicy === "unattended-full-access") {
      // Unlike bypassPermissions, the native fullAccess option also covers HIGH/CRITICAL actions.
      await this.#configure("mode", "fullAccess");
    } else if (this.input.permissionModeId)
      await this.#configure("mode", this.input.permissionModeId);
    if (this.input.model) await this.#configure("model", nativeModel(this.input.model));
    if (this.input.thinkingOptionId)
      await this.#configure("thought_level", this.input.thinkingOptionId);
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
    this.#state = { ...config.state, ...(this.#ref ? { nativeRef: this.#ref } : {}) };
    if (emit) this.#emit({ type: "session.state.changed", state: this.#state });
  }

  async #configure(id: string, value: string) {
    const option = this.#config?.options.find((option) => option.id === id);
    if (
      !Array.isArray(option?.options) ||
      !option.options.some((option) => record(option).value === value)
    )
      throw new CodeBuddyError("invalidRequest", `Unavailable CodeBuddy ${id} selection`);
    if (!this.#ref) throw new CodeBuddyError("invalidState", "Session is not open");
    const result = await this.#client.configure(this.#ref.nativeSessionId, id, value);
    if (this.#closed || this.#fault)
      throw new CodeBuddyError("invalidState", "Session closed during configuration");
    this.#apply(confirmedConfiguration(result, id, value));
  }

  async #snapshot(): Promise<HostThreadSnapshot> {
    if (!this.#ref) throw new CodeBuddyError("invalidState", "Session is not open");
    try {
      const history = await this.readHistory(this.input.cwd, this.#ref, this.environment);
      this.#usage = historyUsage(history);
      return {
        ...this.subagents.project(snapshotFromHistory(history, this.#ref, this.input.cwd)),
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
    if (this.#closed || this.#fault) return failure("invalidState", "Session is closed or faulted");
    if (this.#busy || this.#active)
      return failure("sessionBusy", "Session is executing an operation");
    this.#busy = true;
    try {
      return { ok: true, value: await this.#snapshot() };
    } catch (error) {
      return { ok: false, error: nativeError(error) };
    } finally {
      this.#busy = false;
    }
  }

  execute(command: TurnStartCommand): Promise<HarnessResult<TurnStartAccepted>>;
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
      TurnStartAccepted | TurnCancelAccepted | InteractionRespondAccepted | ModelSelectCompleted
    >
  > {
    if (this.#closed || this.#fault) return failure("invalidState", "Session is closed or faulted");
    if (command.type === "interaction.respond") return this.#interactions.respond(command);
    if (command.type === "turn.cancel") {
      const active = this.#active;
      if (!active || active.command.turnId !== command.turnId || !this.#ref)
        return failure("invalidRequest", "Turn is not active");
      if (!active.cancelled) {
        active.cancelled = true;
        try {
          await this.#client.cancel(this.#ref.nativeSessionId);
        } catch (error) {
          this.#onFault(error);
          return { ok: false, error: nativeError(error) };
        }
        this.#interactions.close();
        void bounded(active.completion, 30_000, "ACP cancel acknowledgement").catch((error) =>
          this.#onFault(error),
        );
      }
      return { ok: true, value: { cancellationRequested: true } };
    }
    if (this.#busy || this.#active)
      return failure("sessionBusy", "Session is executing an operation");
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
          return failure("invalidRequest", "A nonempty text prompt is required");
        const before = new Set(
          (await this.#snapshot()).turns.map((turn) => turn.nativeTurnRef.nativeTurnKey),
        );
        if (this.#closed || this.#fault)
          return failure("invalidState", "Session closed before Turn start");
        const active: ActiveTurn = {
          command,
          before,
          output: new CodeBuddyTurnOutput(command.turnId, this.input.cwd, (event) =>
            this.#emit(event),
          ),
          cancelled: false,
          done: false,
          completion: Promise.resolve(),
        };
        this.#active = active;
        this.subagents.begin(command.turnId);
        this.#hasTurn = true;
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
      return { ok: false, error: nativeError(error) };
    } finally {
      this.#busy = false;
    }
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
                ),
              };
      const snapshot = await this.#snapshot();
      const added = snapshot.turns.filter(
        (turn) => !active.before.has(turn.nativeTurnRef.nativeTurnKey),
      );
      if (added.length > 1 || (outcome.status === "succeeded" && added.length !== 1))
        throw new CodeBuddyError(
          "protocolError",
          "Could not identify exactly one persisted Native Turn",
        );
      const nativeTurnRef = added[0]?.nativeTurnRef;
      if (response.userMessageId && nativeTurnRef?.nativeTurnKey !== response.userMessageId)
        throw new CodeBuddyError(
          "protocolError",
          "ACP terminal and native history disagree on Turn identity",
        );
      if (outcome.status === "cancelled") await this.#resumeAfterCancel();
      this.#finish(active, outcome, nativeTurnRef);
      if (this.#usage)
        this.#emit({ type: "session.usage.changed", usage: { ...this.#usage, ...this.#context } });
    } catch (error) {
      if (!active.done) this.#finish(active, { status: "failed", error: nativeError(error) });
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
      await this.#client.initialize();
      const loaded = await this.#client.open(this.input.cwd, this.#ref.nativeSessionId);
      if (loaded.sessionId && loaded.sessionId !== this.#ref.nativeSessionId)
        throw new CodeBuddyError(
          "protocolError",
          "Cancellation recovery changed Native Session identity",
        );
      this.#apply(configuration(loaded.configOptions));
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
    this.#fault = nativeError(error);
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
