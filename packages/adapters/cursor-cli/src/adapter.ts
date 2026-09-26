import path from "node:path";
import {
  HarnessOutputChannel,
  sanitizeDiagnosticTail,
  type HarnessAdapter,
  type HarnessCommandCapability,
  type HarnessError,
  type HarnessInspection,
  type HarnessOutput,
  type HarnessResult,
  type HarnessSession,
  type HarnessSessionState,
  type HostCommand,
  type HostThreadSnapshot,
  type InspectHarnessInput,
  type OpenSessionInput,
  type ForkSessionInput,
  type RollbackLastTurnSessionInput,
  type TurnOutcome,
  type TurnStartCommand,
  type TurnStartAccepted,
  type TurnCancelCommand,
  type TurnSteerAccepted,
  type TurnSteerCommand,
  type TurnCancelAccepted,
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
  harnessIdSchema,
  harnessPermissionModeIdSchema,
  nativeSessionRefSchema,
  nativeTurnRefSchema,
} from "@codexhost/shared-contracts";
import {
  cursorCapabilities,
  CURSOR_MODES,
  cursorCatalog,
  cursorConfiguredModelRef,
  cursorModelSelection,
  cursorModels,
} from "./models.js";
import {
  CursorTransport,
  type CursorSessionInfo,
  type CursorTransportOptions,
} from "./transport.js";
import {
  cursorSameWorkspace,
  readCursorNativeTurns,
  readCursorNativeHistory,
  type CursorNativeTurn,
} from "./native-history.js";
import { CursorTurnOutput, cursorSnapshot } from "./projection.js";
import { cursorThinking, cursorThinkingState } from "./thinking.js";
import { CURSOR_COMMAND_CATALOG, cursorCommands, cursorCommandPrompt } from "./slash-commands.js";
import { CursorInteractions } from "./interactions.js";
import { forkCursorSession, validateCursorFork } from "./fork.js";
import { cursorForkAvailable, cursorCheckpoint } from "./fork-support.js";
import { type CursorSubagents, cursorTaskAddress } from "./subagents.js";
import type { HarnessSubagentCapability } from "@codexhost/harness-adapter";

export interface CursorAdapterOptions {
  environment?: NodeJS.ProcessEnv;
  command?: string;
  timeoutMs?: number;
}
export function cursorError(error: unknown): HarnessError {
  const message = sanitizeDiagnosticTail(
    error instanceof Error ? error.message : "Cursor operation failed",
  );
  const code = /not installed/iu.test(message)
    ? "notInstalled"
    : /auth|not logged in|login/iu.test(message)
      ? "authenticationRequired"
      : /exited|closed/iu.test(message)
        ? "processExited"
        : "protocolError";
  return { code, message, retryable: false };
}
function rejected(code: HarnessError["code"], message: string): { ok: false; error: HarnessError } {
  return { ok: false, error: { code, message, retryable: false } };
}
export class CursorAdapter implements HarnessAdapter {
  readonly commandCatalog = CURSOR_COMMAND_CATALOG;
  readonly liveCommandCatalog = true;
  readonly subagents: HarnessSubagentCapability = {
    readSnapshot: async ({ parent, nativeSubagentId, cwd }) => {
      if (parent.harnessId !== this.harnessId || this.#closed)
        return rejected("invalidRequest", "Invalid Cursor parent");
      let replay: CursorTransport | undefined;
      try {
        cursorTaskAddress(nativeSubagentId);
        const session = [...this.#sessions].find(
          (s) => s.transport.sessionId === parent.nativeSessionId,
        );
        if (session && path.resolve(session.transport.options.cwd) !== path.resolve(cwd))
          return rejected("invalidRequest", "Cursor parent workspace does not match");
        const active = session?.subagentSnapshot(nativeSubagentId);
        if (active) return { ok: true, value: active };
        const options = session?.transport.options ?? this.transportOptions(cwd);
        const before = readCursorNativeTurns(parent.nativeSessionId, cwd, options.environment);
        replay = new CursorTransport({ ...options, delegation: false, loadModelCatalog: false });
        await replay.open(parent.nativeSessionId);
        const after = readCursorNativeTurns(parent.nativeSessionId, cwd, options.environment);
        if (JSON.stringify(before) !== JSON.stringify(after))
          throw new Error("Cursor native history changed during child read");
        return {
          ok: true,
          value: cursorSnapshot(parent.nativeSessionId, after, replay.replay, nativeSubagentId),
        };
      } catch (error) {
        return { ok: false, error: cursorError(error) };
      } finally {
        await replay?.close();
      }
    },
  };
  readonly harnessId = harnessIdSchema.parse("cursor-cli");
  readonly #sessions = new Set<CursorSession>();
  readonly #forks = new Map<AbortController, Promise<HarnessResult<HarnessSession>>>();
  readonly #inspections = new Map<
    string,
    { pending: boolean; result: Promise<HarnessInspection> }
  >();
  #closed = false;
  constructor(readonly options: CursorAdapterOptions = {}) {}
  transportOptions(cwd: string, environment?: NodeJS.ProcessEnv): CursorTransportOptions {
    return {
      cwd: path.resolve(cwd),
      environment: { ...(this.options.environment ?? process.env), ...environment },
      ...(this.options.command ? { command: this.options.command } : {}),
      ...(this.options.timeoutMs ? { timeoutMs: this.options.timeoutMs } : {}),
    };
  }
  async inspect(input: InspectHarnessInput = {}): Promise<HarnessInspection> {
    if (this.#closed)
      return {
        status: "unavailable",
        error: { code: "unavailable", message: "Cursor adapter is closed", retryable: false },
      };
    const cwd = path.resolve(input.cwd ?? process.cwd());
    const cached = this.#inspections.get(cwd);
    if (cached && (cached.pending || !input.refresh)) return cached.result;
    const result = (async (): Promise<HarnessInspection> => {
      const transport = new CursorTransport(this.transportOptions(cwd));
      try {
        const info = await transport.open();
        return {
          status: "ready",
          catalog: cursorCatalog(info),
          capabilities: cursorCapabilities(info),
          permissionModes: CURSOR_MODES,
        };
      } catch (error) {
        const failure = cursorError(error);
        return {
          status: failure.code === "notInstalled" ? "notInstalled" : "unavailable",
          error: failure,
        };
      } finally {
        await transport.close();
      }
    })();
    // Keep results, including failures, until explicit refresh or Adapter shutdown.
    const entry = { pending: true, result };
    this.#inspections.set(cwd, entry);
    void result.finally(() => {
      entry.pending = false;
    });
    return result;
  }
  async open(input: OpenSessionInput): Promise<HarnessResult<HarnessSession>> {
    if (this.#closed) return rejected("invalidState", "Cursor adapter is closed");
    if (input.kind === "fork" || input.kind === "rollbackLastTurn") {
      const controller = new AbortController();
      const pending = this.#fork(input, controller);
      this.#forks.set(controller, pending);
      try {
        return await pending;
      } finally {
        this.#forks.delete(controller);
      }
    }
    return this.#openSession(input);
  }
  async #openSession(
    input: Exclude<OpenSessionInput, ForkSessionInput | RollbackLastTurnSessionInput>,
    prepared?: CursorTransport,
  ): Promise<HarnessResult<HarnessSession>> {
    if (input.kind === "create" && input.executionPolicy === "unattended-full-access")
      return rejected(
        "unsupported",
        "Cursor ACP cannot confirm unattended full access under native team policy",
      );
    if (input.kind === "resume" && input.nativeRef.harnessId !== this.harnessId)
      return rejected("invalidRequest", "Session belongs to another Harness");
    const options = { ...this.transportOptions(input.cwd, input.environment), delegation: true };
    const transport = prepared ?? new CursorTransport(options);
    try {
      const before =
        input.kind === "resume"
          ? readCursorNativeHistory(
              input.nativeRef.nativeSessionId,
              options.cwd,
              options.environment,
            )
          : undefined;
      const info = await transport.open(
        input.kind === "resume" ? input.nativeRef.nativeSessionId : undefined,
      );
      let loadedSnapshot: CursorLoadedSnapshot | undefined;
      if (input.kind === "resume") {
        const native = readCursorNativeHistory(
          transport.sessionId,
          options.cwd,
          options.environment,
        );
        const snapshot = cursorSnapshot(transport.sessionId, native.turns, transport.replay);
        if (
          input.knownTurnRefs?.some(
            (ref) =>
              ref.harnessId !== this.harnessId ||
              ref.nativeSessionId !== transport.sessionId ||
              !native.turns.some((turn) => turn.id === ref.nativeTurnKey),
          )
        )
          throw new Error("Saved Cursor turn identity no longer exists in native history");
        if (native.revision && before?.revision === native.revision)
          loadedSnapshot = { revision: native.revision, snapshot };
      }
      const session = new CursorSession(
        transport,
        info,
        () => {
          this.#sessions.delete(session);
        },
        input.kind === "create",
        loadedSnapshot,
      );
      if (input.model) {
        const selected = await session.execute({ type: "model.select", model: input.model });
        if (!selected.ok) throw new Error(selected.error.message);
      }
      if (input.thinkingOptionId) {
        const selected = await session.execute({
          type: "thinking.select",
          thinkingOptionId: input.thinkingOptionId,
        });
        if (!selected.ok) throw new Error(selected.error.message);
      }
      if (input.permissionModeId) {
        const selected = await session.execute({
          type: "permissionMode.select",
          permissionModeId: input.permissionModeId,
        });
        if (!selected.ok) throw new Error(selected.error.message);
      }
      if (this.#closed) {
        await session.close();
        return rejected("invalidState", "Cursor adapter closed during session startup");
      }
      this.#sessions.add(session);
      return { ok: true, value: session };
    } catch (error) {
      await transport.close();
      return { ok: false, error: cursorError(error) };
    }
  }
  async #fork(
    input: ForkSessionInput | RollbackLastTurnSessionInput,
    controller: AbortController,
  ): Promise<HarnessResult<HarnessSession>> {
    const signal = controller.signal;
    if (!cursorForkAvailable())
      return rejected("unsupported", "Cursor Fork requires macOS/Linux with /usr/bin/script");
    try {
      if (input.kind === "fork") validateCursorFork(input.sourceRef, input.checkpoint);
      else if (input.sourceRef.harnessId !== this.harnessId || input.sourceRef.formatVersion !== 1)
        return rejected("invalidRequest", "Invalid Cursor rollback source");
    } catch {
      return rejected("invalidRequest", "Invalid Cursor fork checkpoint");
    }
    const source = [...this.#sessions].find(
      (session) => session.transport.sessionId === input.sourceRef.nativeSessionId,
    );
    if (source && !cursorSameWorkspace(source.transport.options.cwd, input.cwd))
      return rejected("unsupported", "Cursor Fork does not support changing workspace");
    const release = source?.lockForFork();
    if (source && !release) return rejected("sessionBusy", "Cursor source session is busy");
    let derived: Awaited<ReturnType<typeof forkCursorSession>> | undefined;
    let session: HarnessSession | undefined;
    let transport: CursorTransport | undefined;
    const cancel = () => {
      void transport?.close();
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      const options = source
        ? {
            ...source.transport.options,
            environment: { ...source.transport.options.environment, ...input.environment },
          }
        : this.transportOptions(input.cwd, input.environment);
      const native = readCursorNativeTurns(
        input.sourceRef.nativeSessionId,
        input.cwd,
        options.environment,
      );
      const retained =
        input.kind === "fork"
          ? native.findIndex((turn) => turn.id === input.checkpoint.checkpointId) + 1
          : native.length - 1;
      if (!native.length || (input.kind === "fork" && retained === 0))
        return rejected("checkpointNotFound", "Cursor derivation boundary no longer exists");
      if (native[retained] && !native[retained]?.rewindRoot)
        return rejected("unsupported", "Cursor target has no native rewind checkpoint");
      signal.throwIfAborted();
      const sourceEnvironment = source?.transport.options.environment;
      const sameEnvironment =
        sourceEnvironment &&
        [
          ...new Set([...Object.keys(sourceEnvironment), ...Object.keys(options.environment)]),
        ].every((key) => sourceEnvironment[key] === options.environment[key]);
      transport = new CursorTransport(
        { ...options, delegation: true },
        sameEnvironment ? source?.info.nativeModels : undefined,
      );
      // Authentication needs no target ID; overlap it with the native CLI transaction.
      // Join both operations before cleanup, including a target returned after cancellation.
      const abort = (error: unknown): never => {
        controller.abort(error);
        throw error;
      };
      const [staged, ready] = await Promise.allSettled([
        forkCursorSession(
          input.sourceRef,
          input.kind === "fork" ? input.checkpoint : undefined,
          options,
          signal,
        ).catch(abort),
        transport.prepare().catch(abort),
      ]);
      if (staged.status === "fulfilled") derived = staged.value;
      signal.throwIfAborted();
      if (ready.status === "rejected") throw ready.reason;
      if (staged.status === "rejected") throw staged.reason;
      if (!derived) throw new Error("Cursor native fork did not return a target");
      const model =
        input.kind === "rollbackLastTurn"
          ? (input.model ?? source?.initialState.effectiveModel)
          : source?.initialState.effectiveModel;
      const thinking =
        input.kind === "rollbackLastTurn"
          ? (input.thinkingOptionId ?? source?.initialState.effectiveThinkingOptionId)
          : source?.initialState.effectiveThinkingOptionId;
      const mode =
        input.kind === "rollbackLastTurn"
          ? (input.permissionModeId ?? source?.initialState.effectivePermissionModeId)
          : source?.initialState.effectivePermissionModeId;
      const opened = await this.#openSession(
        {
          kind: "resume",
          cwd: input.cwd,
          environment: options.environment,
          nativeRef: nativeSessionRefSchema.parse({
            harnessId: this.harnessId,
            nativeSessionId: derived.sessionId,
            formatVersion: 1,
          }),
          ...(model ? { model } : {}),
          ...(thinking ? { thinkingOptionId: thinking } : {}),
          ...(mode ? { permissionModeId: mode } : {}),
        },
        transport,
      );
      if (!opened.ok) throw new Error(opened.error.message);
      session = opened.value;
      // Resume verifies ACP replay against native IDs. Check the derived prefix again after load.
      if (
        JSON.stringify(readCursorNativeTurns(derived.sessionId, input.cwd, options.environment)) !==
        JSON.stringify(derived.expected)
      )
        throw new Error("Cursor derived history changed during ACP adoption");
      if (
        JSON.stringify(
          readCursorNativeTurns(input.sourceRef.nativeSessionId, input.cwd, options.environment),
        ) !== JSON.stringify(derived.sourceTurns)
      )
        throw new Error("Cursor source changed before fork adoption");
      derived.commit();
      return { ok: true, value: session };
    } catch (error) {
      await session?.close();
      await transport?.close();
      await derived?.discard();
      return { ok: false, error: cursorError(error) };
    } finally {
      signal.removeEventListener("abort", cancel);
      release?.();
    }
  }
  async close() {
    this.#closed = true;
    for (const controller of this.#forks.keys()) controller.abort();
    await Promise.allSettled(this.#forks.values());
    await Promise.allSettled([...this.#sessions].map((session) => session.close()));
    await Promise.allSettled(
      [...this.#inspections.values()].map((inspection) => inspection.result),
    );
  }
}

interface CursorLoadedSnapshot {
  revision: string;
  snapshot: HostThreadSnapshot;
}

export class CursorSession implements HarnessSession {
  readonly harnessId = harnessIdSchema.parse("cursor-cli");
  get capabilities() {
    return cursorCapabilities(this.info);
  }
  readonly initialUsage = null;
  readonly commands: HarnessCommandCapability = {
    list: async () =>
      this.#closed
        ? rejected("invalidState", "Cursor session is closed")
        : { ok: true, value: cursorCommands(this.transport.availableCommands) },
    execute: async (command) => {
      if (this.#closed) return rejected("invalidState", "Cursor session is closed");
      const prompt = cursorCommandPrompt(command, cursorCommands(this.transport.availableCommands));
      if (!prompt.ok) return prompt;
      return this.execute({
        type: "turn.start",
        turnId: command.turnId,
        input: [{ type: "text", text: prompt.value }],
      });
    },
  };
  readonly initialState: HarnessSessionState;
  readonly #channel = new HarnessOutputChannel<HarnessOutput>();
  readonly outputs = this.#channel.outputs;
  readonly #interactions = new CursorInteractions((output) => this.#channel.emit(output));
  readonly #submitted = new Set<string>();
  #active: { command: TurnStartCommand; cancelled: boolean; task: Promise<void> } | undefined;
  #configuring = false;
  #closed = false;
  #fresh: boolean;
  #snapshot: CursorLoadedSnapshot | undefined;
  #subagentOutput: CursorSubagents | undefined;
  lockForFork(): (() => void) | undefined {
    if (this.#closed || this.#active || this.#configuring) return;
    this.#configuring = true;
    return () => {
      this.#configuring = false;
    };
  }
  subagentSnapshot(callId: string): HostThreadSnapshot | undefined {
    try {
      return this.#subagentOutput?.snapshot(this.transport.sessionId, callId);
    } catch {
      return undefined;
    }
  }
  constructor(
    readonly transport: CursorTransport,
    readonly info: CursorSessionInfo,
    readonly onClose: () => void,
    created = true,
    loadedSnapshot?: CursorLoadedSnapshot,
  ) {
    this.info = structuredClone(info);
    this.#fresh = created;
    this.#snapshot = loadedSnapshot;
    this.initialState = {
      nativeRef: nativeSessionRefSchema.parse({
        harnessId: "cursor-cli",
        nativeSessionId: transport.sessionId,
        formatVersion: 1,
      }),
      effectiveModel: cursorConfiguredModelRef(cursorModels(info).current, info.configOptions),
      ...cursorThinkingState(info),
      effectivePermissionModeId: harnessPermissionModeIdSchema.parse(
        info.configOptions?.find((option) => option.id === "mode")?.currentValue ??
          info.modes?.currentModeId ??
          "agent",
      ),
    };
  }
  #native(allowMissing = false) {
    return readCursorNativeTurns(
      this.transport.sessionId,
      this.transport.options.cwd,
      this.transport.options.environment,
      allowMissing,
    );
  }
  async readSnapshot(): Promise<HarnessResult<HostThreadSnapshot>> {
    if (this.#closed) return rejected("invalidState", "Cursor session is closed");
    if (this.#active || this.#configuring) return rejected("sessionBusy", "Cursor session is busy");
    this.#configuring = true;
    let replay: CursorTransport | undefined;
    try {
      const history = () =>
        readCursorNativeHistory(
          this.transport.sessionId,
          this.transport.options.cwd,
          this.transport.options.environment,
          this.#fresh,
        );
      const before = history();
      if (before.turns.length === 0 && this.#fresh)
        return { ok: true, value: { turns: [], state: structuredClone(this.initialState) } };
      if (!this.#snapshot || !before.revision || this.#snapshot.revision !== before.revision) {
        replay = new CursorTransport({
          ...this.transport.options,
          delegation: false,
          loadModelCatalog: false,
        });
        await replay.open(this.transport.sessionId);
        const after = history();
        if (JSON.stringify(before) !== JSON.stringify(after) || !after.revision)
          throw new Error("Cursor native history changed during snapshot read");
        this.#snapshot = {
          revision: after.revision,
          snapshot: cursorSnapshot(this.transport.sessionId, after.turns, replay.replay),
        };
      }
      return {
        ok: true,
        value: {
          ...structuredClone(this.#snapshot.snapshot),
          state: structuredClone(this.initialState),
        },
      };
    } catch (error) {
      return { ok: false, error: cursorError(error) };
    } finally {
      await replay?.close();
      this.#configuring = false;
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
  async execute(
    command: HostCommand,
  ): Promise<
    HarnessResult<
      | TurnStartAccepted
      | TurnSteerAccepted
      | TurnCancelAccepted
      | InteractionRespondAccepted
      | ModelSelectCompleted
      | ThinkingSelectCompleted
      | PermissionModeSelectCompleted
    >
  > {
    if (this.#closed) return rejected("invalidState", "Cursor session is closed");
    if (command.type === "interaction.respond") return this.#interactions.respond(command);
    // Cursor ACP cancels the running prompt on a second session/prompt; it has no native steer.
    if (command.type === "turn.steer") return rejected("unsupported", "Cursor ACP cannot steer");
    if (command.type === "turn.cancel") {
      if (!this.#active || this.#active.command.turnId !== command.turnId)
        return rejected("invalidState", "Cursor turn is not active");
      const active = this.#active;
      active.cancelled = true;
      this.#interactions.cancel();
      try {
        await this.transport.cancel();
      } catch {
        await this.transport.close();
      }
      const timer = setTimeout(() => {
        if (this.#active === active) void this.transport.close();
      }, 5_000);
      void active.task.finally(() => clearTimeout(timer));
      return { ok: true, value: { cancellationRequested: true } };
    }
    if (
      this.#configuring ||
      (this.#active && command.type !== "model.select" && command.type !== "thinking.select")
    )
      return rejected("sessionBusy", "Cursor session is busy");
    if (command.type === "turn.start") {
      if (this.#submitted.has(command.turnId))
        return rejected("invalidState", "Cursor turn was already submitted");
      if (
        !command.input.length ||
        command.input.some((part) => part.type !== "text") ||
        !command.input.some((part) => part.text.trim())
      )
        return rejected("invalidRequest", "Cursor requires nonempty text input");
      let before: CursorNativeTurn[];
      try {
        before = this.#native(this.#fresh);
      } catch (error) {
        return { ok: false, error: cursorError(error) };
      }
      this.#submitted.add(command.turnId);
      this.#snapshot = undefined;
      const active = { command, cancelled: false, task: Promise.resolve() };
      this.#active = active;
      active.task = this.#run(command, before);
      return { ok: true, value: { turnId: command.turnId } };
    }
    this.#configuring = true;
    try {
      let selections: Array<[string, string]>;
      if (command.type === "thinking.select") {
        const option = cursorThinking(this.info.configOptions).find(
          ({ id }) => id === command.thinkingOptionId,
        );
        if (!option)
          return rejected("unsupported", "Thinking option is not available for this Cursor model");
        selections = option.values;
      } else if (command.type === "model.select") {
        selections = cursorModelSelection(this.info, command.model.id);
      } else {
        if (!CURSOR_MODES.modes.some((mode) => mode.id === command.permissionModeId))
          return rejected("invalidRequest", "Unknown Cursor execution mode");
        selections = [["mode", command.permissionModeId]];
      }
      for (const [configId, value] of selections) {
        // Recheck after each response: selecting a model may change other configuration values.
        if (
          this.info.configOptions?.some(
            (option) => option.id === configId && option.currentValue === value,
          )
        )
          continue;
        const result = await this.transport.configure(configId, value);
        if (
          !result.configOptions.some(
            (option) => option.id === configId && option.currentValue === value,
          )
        )
          throw new Error("Cursor did not confirm configuration selection");
        // Apply the complete confirmed configuration, including changes caused by selecting a model.
        this.info.configOptions = result.configOptions;
        const model = result.configOptions.find((option) => option.id === "model");
        if (model?.type === "select")
          this.initialState.effectiveModel = cursorConfiguredModelRef(
            model.currentValue,
            result.configOptions,
          );
        const mode = result.configOptions.find((option) => option.id === "mode");
        if (mode)
          this.initialState.effectivePermissionModeId = harnessPermissionModeIdSchema.parse(
            mode.currentValue,
          );
        delete this.initialState.effectiveThinkingOptionId;
        Object.assign(this.initialState, cursorThinkingState(this.info));
        this.#channel.emit({
          kind: "event",
          event: { type: "session.state.changed", state: structuredClone(this.initialState) },
        });
      }
      return { ok: true, value: { completed: true } };
    } catch (error) {
      return { ok: false, error: cursorError(error) };
    } finally {
      this.#configuring = false;
    }
  }
  async #run(command: TurnStartCommand, before: CursorNativeTurn[]) {
    let fault: HarnessError | undefined;
    const output = new CursorTurnOutput(
      command.turnId,
      (event) => this.#channel.emit({ kind: "event", event }),
      before.length,
    );
    this.#subagentOutput = output.subagents;
    this.#channel.emit({ kind: "event", event: { type: "turn.started", turnId: command.turnId } });
    let outcome: TurnOutcome = {
      status: "failed",
      error: { code: "nativeFailure", message: "Cursor turn failed", retryable: false },
    };
    let nativeTurnRef: ReturnType<typeof nativeTurnRefSchema.parse> | undefined;
    try {
      const result = await this.transport.prompt(
        command.input.map((part) => part.text).join("\n"),
        {
          update: (event) => output.update(event),
          permission: (request) => this.#interactions.permission(command.turnId, request),
          extension: (method, params) =>
            Promise.resolve(
              output.subagents.extension(method, params) ??
                this.#interactions.extension(command.turnId, method, params),
            ),
          notification: (method, params) => {
            output.subagents.extension(method, params);
          },
        },
      );
      outcome =
        this.#active?.cancelled || result.stopReason === "cancelled"
          ? { status: "cancelled" }
          : result.stopReason === "end_turn"
            ? { status: "succeeded" }
            : {
                status: "failed",
                error: {
                  code: "nativeFailure",
                  message: `Cursor stopped: ${result.stopReason}`,
                  retryable: false,
                },
              };
    } catch (error) {
      fault = cursorError(error);
      outcome = this.#active?.cancelled
        ? { status: "cancelled" }
        : { status: "failed", error: cursorError(error) };
    }
    try {
      const after = this.#native(this.#fresh);
      const added = after.filter((turn) => !before.some((old) => old.id === turn.id));
      const administrative =
        command.input
          .map((part) => part.text)
          .join("\n")
          .trim()
          .toLowerCase() === "/copy-request-id";
      if (administrative && JSON.stringify(before) === JSON.stringify(after)) {
        // This native command returns a local message without persisting a user Turn.
      } else {
        if (
          added.length !== 1 ||
          after.length !== before.length + 1 ||
          before.some((turn, index) => after[index]?.id !== turn.id) ||
          added[0]?.text !== command.input.map((part) => part.text).join("\n")
        )
          throw new Error("Cursor terminal has no unique, verified native turn identity");
        nativeTurnRef = nativeTurnRefSchema.parse({
          harnessId: "cursor-cli",
          nativeSessionId: this.transport.sessionId,
          nativeTurnKey: added[0].id,
          formatVersion: 1,
        });
        this.#fresh = false;
        if (outcome.status === "succeeded" && cursorForkAvailable())
          outcome = {
            ...outcome,
            checkpoint: cursorCheckpoint(this.transport.sessionId, added[0].id),
          };
      }
    } catch (error) {
      if (outcome.status === "succeeded") outcome = { status: "failed", error: cursorError(error) };
    }
    this.#interactions.cancel();
    output.finish(outcome);
    this.#active = undefined;
    this.#channel.emit({
      kind: "event",
      event: {
        type: "turn.completed",
        turnId: command.turnId,
        outcome,
        ...(nativeTurnRef ? { nativeTurnRef } : {}),
      },
    });
    if (fault && !this.#closed) {
      this.#channel.emit({ kind: "event", event: { type: "session.faulted", error: fault } });
      void this.close().catch(() => {});
    }
  }
  async close() {
    if (this.#closed) return;
    this.#closed = true;
    const active = this.#active;
    if (active) active.cancelled = true;
    this.#interactions.cancel();
    try {
      await this.transport.close();
      await active?.task;
    } finally {
      this.#channel.end();
      this.onClose();
    }
  }
}
