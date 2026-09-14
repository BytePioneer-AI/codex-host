import path from "node:path";
import {
  HarnessOutputChannel,
  sanitizeDiagnosticTail,
  type HarnessAdapter,
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
  type TurnOutcome,
  type TurnStartCommand,
  type TurnStartAccepted,
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
} from "@codexhost/harness-adapter";
import {
  harnessIdSchema,
  harnessPermissionModeIdSchema,
  harnessThinkingOptionIdSchema,
  nativeSessionRefSchema,
  nativeTurnRefSchema,
} from "@codexhost/shared-contracts";
import {
  CURSOR_MODES,
  cursorCapabilities,
  cursorConfigOptions,
  cursorThinkingSelectionsAvailable,
  cursorModelRef,
  cursorNativeModel,
  cursorParameterGroups,
  cursorSessionConfiguration,
  cursorThinkingFromNativeModelId,
  decodeCursorModelRef,
  decodeGroupedThinkingOptionId,
  cursorModels,
} from "./models.js";
import {
  CursorTransport,
  type CursorSessionInfo,
  type CursorTransportOptions,
} from "./transport.js";
import { readCursorNativeTurns, type CursorNativeTurn } from "./native-history.js";
import { CursorTurnOutput, cursorSnapshot } from "./projection.js";
import { CursorInteractions } from "./interactions.js";
import { type CursorSubagents, cursorTaskAddress } from "./subagents.js";
import type { HarnessSubagentCapability } from "@codexhost/harness-adapter";
import {
  parseCursorListModelId,
  parseCursorListModels,
  readCursorListModels,
} from "./list-models.js";

export interface CursorAdapterOptions {
  environment?: NodeJS.ProcessEnv;
  command?: string;
  timeoutMs?: number;
  listModels?: () => Promise<string>;
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
        replay = new CursorTransport(options);
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
  readonly #inspections = new Map<
    string,
    { expires: number; pending: boolean; result: Promise<HarnessInspection> }
  >();
  #variants = new Map<string, string>();
  #warm: CursorTransport | undefined;
  #warming: Promise<void> | undefined;
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
    if (cached && (cached.pending || (!input.refresh && cached.expires > Date.now()))) {
      void this.#prewarm(cwd);
      return cached.result;
    }
    const result = (async (): Promise<HarnessInspection> => {
      try {
        const text = this.options.listModels
          ? await this.options.listModels()
          : await readCursorListModels(this.transportOptions(cwd));
        const parsed = parseCursorListModels(text);
        this.#variants = parsed.variants;
        return {
          status: "ready",
          catalog: parsed.catalog,
          capabilities: cursorCapabilities(parsed.catalog.thinkingOptions.length > 0),
          permissionModes: CURSOR_MODES,
        };
      } catch (error) {
        const failure = cursorError(error);
        return {
          status: failure.code === "notInstalled" ? "notInstalled" : "unavailable",
          error: failure,
        };
      }
    })();
    // Cache negative results as well; discovery never starts a polling/retry timer.
    const entry = { expires: Number.POSITIVE_INFINITY, pending: true, result };
    this.#inspections.set(cwd, entry);
    void result.finally(() => {
      entry.pending = false;
      entry.expires = Date.now() + 5 * 60_000;
    });
    void this.#prewarm(cwd);
    return result;
  }
  #takeIdleWarm(): CursorTransport | undefined {
    const transport = this.#warm;
    if (!transport?.idle) return undefined;
    this.#warm = undefined;
    return transport;
  }
  async #prewarm(cwd: string): Promise<void> {
    if (this.#closed || this.#warm?.idle || this.#warming) return;
    const warming = (async () => {
      const transport = new CursorTransport(this.transportOptions(cwd));
      await transport.ensureAgent();
      if (this.#closed) {
        await transport.close();
        return;
      }
      this.#warm = transport;
    })();
    this.#warming = warming;
    try {
      await warming;
    } catch {
      // Catalog inspect still succeeds if ACP prewarm fails.
    } finally {
      if (this.#warming === warming) this.#warming = undefined;
    }
  }
  async open(input: OpenSessionInput): Promise<HarnessResult<HarnessSession>> {
    if (this.#closed) return rejected("invalidState", "Cursor adapter is closed");
    if (input.kind !== "create" && input.kind !== "resume")
      return rejected("unsupported", "Cursor fork and rollback are not supported");
    if (input.kind === "create" && input.executionPolicy === "unattended-full-access")
      return rejected("unsupported", "Cursor ACP does not expose this execution policy");
    if (input.kind === "resume" && input.nativeRef.harnessId !== this.harnessId)
      return rejected("invalidRequest", "Session belongs to another Harness");
    const options = this.transportOptions(input.cwd, input.environment);
    if (this.#warming) await this.#warming;
    const transport = this.#takeIdleWarm() ?? new CursorTransport(options);
    void this.#prewarm(options.cwd);
    try {
      if (input.kind === "resume")
        readCursorNativeTurns(input.nativeRef.nativeSessionId, options.cwd, options.environment);
      const info = await transport.open(
        input.kind === "resume" ? input.nativeRef.nativeSessionId : undefined,
        options.cwd,
      );
      const session = new CursorSession(
        transport,
        info,
        () => {
          this.#sessions.delete(session);
        },
        input.kind === "create",
        this.#variants,
      );
      if (input.kind === "resume") {
        const native = readCursorNativeTurns(transport.sessionId, options.cwd, options.environment);
        cursorSnapshot(transport.sessionId, native, transport.replay);
        if (
          input.knownTurnRefs?.some(
            (ref) =>
              ref.harnessId !== this.harnessId ||
              ref.nativeSessionId !== transport.sessionId ||
              !native.some((turn) => turn.id === ref.nativeTurnKey),
          )
        )
          throw new Error("Saved Cursor turn identity no longer exists in native history");
      }
      if (input.model) {
        const selected = await session.execute({ type: "model.select", model: input.model });
        if (!selected.ok) throw new Error(selected.error.message);
      }
      const legacyModelId = input.model ? decodeCursorModelRef(input.model.id) : "";
      const requestedThinking =
        input.thinkingOptionId ??
        (legacyModelId.includes("[")
          ? cursorThinkingFromNativeModelId(
              cursorParameterGroups(cursorConfigOptions({ configOptions: session.configOptions })),
              legacyModelId,
            )
          : undefined);
      if (
        requestedThinking &&
        requestedThinking !== session.initialState.effectiveThinkingOptionId
      ) {
        const selected = await session.execute({
          type: "thinking.select",
          thinkingOptionId: harnessThinkingOptionIdSchema.parse(requestedThinking),
        });
        if (!selected.ok && input.thinkingOptionId) throw new Error(selected.error.message);
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
  async close() {
    this.#closed = true;
    await Promise.allSettled([...this.#sessions].map((session) => session.close()));
    const warm = this.#warm;
    this.#warm = undefined;
    await Promise.allSettled([
      this.#warming,
      warm?.close(),
      ...[...this.#inspections.values()].map((inspection) => inspection.result),
    ]);
  }
}

export class CursorSession implements HarnessSession {
  readonly harnessId = harnessIdSchema.parse("cursor-cli");
  readonly capabilities: ReturnType<typeof cursorCapabilities>;
  readonly initialUsage = null;
  readonly initialState: HarnessSessionState;
  readonly #channel = new HarnessOutputChannel<HarnessOutput>();
  readonly outputs = this.#channel.outputs;
  readonly #interactions = new CursorInteractions((output) => this.#channel.emit(output));
  readonly #submitted = new Set<string>();
  #active: { command: TurnStartCommand; cancelled: boolean; task: Promise<void> } | undefined;
  #configuring = false;
  #closed = false;
  #fresh: boolean;
  #configOptions: unknown;
  get configOptions() {
    return this.#configOptions;
  }
  #subagentOutput: CursorSubagents | undefined;
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
    readonly variants = new Map<string, string>(),
  ) {
    this.#fresh = created;
    this.#configOptions = info.configOptions;
    const model = cursorModelRef(cursorModels(info).current);
    this.capabilities = cursorCapabilities(
      cursorParameterGroups(cursorConfigOptions(info)).length > 0 ||
        cursorModels(info).models.some((entry) => !entry.value.includes("[")),
    );
    this.initialState = {
      nativeRef: nativeSessionRefSchema.parse({
        harnessId: "cursor-cli",
        nativeSessionId: transport.sessionId,
        formatVersion: 1,
      }),
      ...cursorSessionConfiguration(info, model),
      effectivePermissionModeId: harnessPermissionModeIdSchema.parse(
        info.modes?.currentModeId ?? "agent",
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
    const replay = new CursorTransport(this.transport.options);
    try {
      const before = this.#native(this.#fresh);
      if (before.length === 0 && this.#fresh)
        return { ok: true, value: { turns: [], state: structuredClone(this.initialState) } };
      await replay.open(this.transport.sessionId);
      const after = this.#native();
      if (JSON.stringify(before) !== JSON.stringify(after))
        throw new Error("Cursor native history changed during snapshot read");
      return {
        ok: true,
        value: {
          ...cursorSnapshot(this.transport.sessionId, after, replay.replay),
          state: structuredClone(this.initialState),
        },
      };
    } catch (error) {
      return { ok: false, error: cursorError(error) };
    } finally {
      await replay.close();
      this.#configuring = false;
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
      | TurnStartAccepted
      | TurnCancelAccepted
      | InteractionRespondAccepted
      | ModelSelectCompleted
      | ThinkingSelectCompleted
      | PermissionModeSelectCompleted
    >
  > {
    if (this.#closed) return rejected("invalidState", "Cursor session is closed");
    if (command.type === "interaction.respond") return this.#interactions.respond(command);
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
    if (this.#active || this.#configuring) return rejected("sessionBusy", "Cursor session is busy");
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
      const active = { command, cancelled: false, task: Promise.resolve() };
      this.#active = active;
      active.task = this.#run(command, before);
      return { ok: true, value: { turnId: command.turnId } };
    }
    if (command.type === "thinking.select") {
      const selections = decodeGroupedThinkingOptionId(command.thinkingOptionId);
      if (!this.capabilities.configuration.selectThinkingOption || !selections) {
        return rejected(
          "unsupported",
          "Cursor ACP exposes model variants, not an independent thinking selector",
        );
      }
    }
    this.#configuring = true;
    try {
      if (command.type === "thinking.select") {
        const selections = decodeGroupedThinkingOptionId(command.thinkingOptionId);
        if (!selections) return rejected("invalidRequest", "Unknown Cursor Thinking option");
        const applicable = selections.filter((selection) =>
          cursorThinkingSelectionsAvailable([selection], { configOptions: this.#configOptions }),
        );
        if (applicable.length === 0)
          return rejected("invalidRequest", "Unknown Cursor Thinking option");
        let options = cursorConfigOptions({ configOptions: this.#configOptions });
        for (const selection of applicable) {
          const result = await this.transport.configure(selection.groupId, selection.optionId);
          options = cursorConfigOptions(result);
          if (
            !options.some(
              (option) =>
                option.id === selection.groupId && option.currentValue === selection.optionId,
            )
          )
            throw new Error("Cursor did not confirm configuration selection");
        }
        this.#syncConfiguration(options, this.initialState.effectiveModel);
      } else {
        const value =
          command.type === "model.select"
            ? this.#nativeSelectValue(command.model.id)
            : command.permissionModeId;
        const configId = command.type === "model.select" ? "model" : "mode";
        if (configId === "mode" && !CURSOR_MODES.modes.some((mode) => mode.id === value))
          return rejected("invalidRequest", "Unknown Cursor execution mode");
        const result = await this.transport.configure(configId, value);
        const options = cursorConfigOptions(result);
        const current = options.find((option) => option.id === configId)?.currentValue;
        if (
          current !== value &&
          !(
            configId === "model" &&
            parseCursorListModelId(current ?? "").base === parseCursorListModelId(value).base
          )
        )
          throw new Error("Cursor did not confirm configuration selection");
        if (command.type === "model.select") this.#syncConfiguration(options, command.model);
        else {
          this.#configOptions = result.configOptions;
          this.initialState.effectivePermissionModeId = command.permissionModeId;
        }
      }
      this.#channel.emit({
        kind: "event",
        event: { type: "session.state.changed", state: { ...this.initialState } },
      });
      return { ok: true, value: { completed: true } };
    } catch (error) {
      return { ok: false, error: cursorError(error) };
    } finally {
      this.#configuring = false;
    }
  }
  #nativeSelectValue(ref: string): string {
    try {
      return cursorNativeModel({ configOptions: this.#configOptions }, ref);
    } catch {
      return decodeCursorModelRef(ref);
    }
  }
  #syncConfiguration(
    options: ReturnType<typeof cursorConfigOptions>,
    model = this.initialState.effectiveModel,
  ) {
    this.#configOptions = options;
    if (!model) return;
    const next = cursorSessionConfiguration({ configOptions: options }, model);
    this.initialState.effectiveModel = next.effectiveModel;
    if (next.resolvedModelLabel) this.initialState.resolvedModelLabel = next.resolvedModelLabel;
    else delete this.initialState.resolvedModelLabel;
    if (next.effectiveThinkingOptionId) {
      this.initialState.effectiveThinkingOptionId = next.effectiveThinkingOptionId;
    } else delete this.initialState.effectiveThinkingOptionId;
    if (next.availableThinkingOptions) {
      this.initialState.availableThinkingOptions = next.availableThinkingOptions;
    } else delete this.initialState.availableThinkingOptions;
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
      const after = this.#native();
      const added = after.filter((turn) => !before.some((old) => old.id === turn.id));
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
