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
  nativeSessionRefSchema,
  nativeTurnRefSchema,
} from "@codexhost/shared-contracts";
import {
  CURSOR_CAPABILITIES,
  CURSOR_MODES,
  cursorCatalog,
  cursorModelRef,
  cursorNativeModel,
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
import { type CursorSubagents, cursorTaskAddress, cursorChildSnapshot } from "./subagents.js";
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
  readonly subagents: HarnessSubagentCapability = {
    readSnapshot: async ({ parent, nativeSubagentId, cwd }) => {
      if (parent.harnessId !== this.harnessId || this.#closed)
        return rejected("invalidRequest", "Invalid Cursor parent");
      let replay: CursorTransport | undefined;
      try {
        const address = cursorTaskAddress(nativeSubagentId);
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
        const parentHistory = cursorSnapshot(parent.nativeSessionId, after, replay.replay);
        const task = parentHistory.turns[address.turnIndex]?.items.find(
          ({ item }) =>
            item.type === "subagentDelegation" &&
            item.subagents[0]?.nativeSubagentId === nativeSubagentId,
        );
        if (!task || task.item.type !== "subagentDelegation")
          throw new Error("Native Cursor Task not found in this parent");
        return {
          ok: true,
          value: cursorChildSnapshot(
            parent.nativeSessionId,
            task.item,
            task.outcome,
            task.item.subagents[0]?.resultSummary,
          ),
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
    if (cached && (cached.pending || (!input.refresh && cached.expires > Date.now())))
      return cached.result;
    const result = (async (): Promise<HarnessInspection> => {
      const transport = new CursorTransport(this.transportOptions(cwd));
      try {
        const info = await transport.open();
        return {
          status: "ready",
          catalog: cursorCatalog(info),
          capabilities: CURSOR_CAPABILITIES,
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
    // Cache negative results as well; discovery never starts a polling/retry timer.
    const entry = { expires: Date.now() + 5 * 60_000, pending: true, result };
    this.#inspections.set(cwd, entry);
    void result.finally(() => {
      entry.pending = false;
    });
    return result;
  }
  async open(input: OpenSessionInput): Promise<HarnessResult<HarnessSession>> {
    if (this.#closed) return rejected("invalidState", "Cursor adapter is closed");
    if (input.kind !== "create" && input.kind !== "resume")
      return rejected("unsupported", "Cursor fork and rollback are not supported");
    if (
      input.thinkingOptionId ||
      (input.kind === "create" && input.executionPolicy === "unattended-full-access")
    )
      return rejected(
        "unsupported",
        "Cursor ACP does not expose this execution policy or thinking selection",
      );
    if (input.kind === "resume" && input.nativeRef.harnessId !== this.harnessId)
      return rejected("invalidRequest", "Session belongs to another Harness");
    const options = this.transportOptions(input.cwd, input.environment);
    const transport = new CursorTransport(options);
    try {
      if (input.kind === "resume")
        readCursorNativeTurns(input.nativeRef.nativeSessionId, options.cwd, options.environment);
      const info = await transport.open(
        input.kind === "resume" ? input.nativeRef.nativeSessionId : undefined,
      );
      const session = new CursorSession(
        transport,
        info,
        () => {
          this.#sessions.delete(session);
        },
        input.kind === "create",
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
    await Promise.allSettled(
      [...this.#inspections.values()].map((inspection) => inspection.result),
    );
  }
}

export class CursorSession implements HarnessSession {
  readonly harnessId = harnessIdSchema.parse("cursor-cli");
  readonly capabilities = CURSOR_CAPABILITIES;
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
  ) {
    this.#fresh = created;
    this.initialState = {
      nativeRef: nativeSessionRefSchema.parse({
        harnessId: "cursor-cli",
        nativeSessionId: transport.sessionId,
        formatVersion: 1,
      }),
      effectiveModel: cursorModelRef(cursorModels(info).current),
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
        return { ok: true, value: { turns: [], state: this.initialState } };
      await replay.open(this.transport.sessionId);
      const after = this.#native();
      if (JSON.stringify(before) !== JSON.stringify(after))
        throw new Error("Cursor native history changed during snapshot read");
      return {
        ok: true,
        value: {
          ...cursorSnapshot(this.transport.sessionId, after, replay.replay),
          state: this.initialState,
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
    if (command.type === "thinking.select")
      return rejected(
        "unsupported",
        "Cursor ACP exposes model variants, not an independent thinking selector",
      );
    this.#configuring = true;
    try {
      const value =
        command.type === "model.select"
          ? cursorNativeModel(this.info, command.model.id)
          : command.permissionModeId;
      const configId = command.type === "model.select" ? "model" : "mode";
      if (configId === "mode" && !CURSOR_MODES.modes.some((mode) => mode.id === value))
        return rejected("invalidRequest", "Unknown Cursor execution mode");
      const result = await this.transport.configure(configId, value);
      if (
        !result.configOptions.some(
          (option) => option.id === configId && option.currentValue === value,
        )
      )
        throw new Error("Cursor did not confirm configuration selection");
      if (command.type === "model.select") this.initialState.effectiveModel = command.model;
      else this.initialState.effectivePermissionModeId = command.permissionModeId;
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
  async #run(command: TurnStartCommand, before: CursorNativeTurn[]) {
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
  }
  async close() {
    if (this.#closed) return;
    this.#closed = true;
    const active = this.#active;
    if (active) active.cancelled = true;
    this.#interactions.cancel();
    await this.transport.close();
    await active?.task;
    this.#channel.end();
    this.onClose();
  }
}
