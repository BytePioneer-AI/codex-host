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
  DEVIN_CAPABILITIES,
  devinCatalog,
  devinModelRef,
  devinModels,
  devinModes,
  devinNativeModel,
} from "./models.js";
import { DevinTransport, type DevinSessionInfo, type DevinTransportOptions } from "./transport.js";
import { DevinTurnOutput, devinPromptTurnKey, devinSnapshot } from "./projection.js";
import { DevinInteractions } from "./interactions.js";

export interface DevinAdapterOptions {
  environment?: NodeJS.ProcessEnv;
  command?: string;
  timeoutMs?: number;
}
export function devinError(error: unknown): HarnessError {
  const message = sanitizeDiagnosticTail(
    error instanceof Error ? error.message : "Devin operation failed",
  );
  const code = /not installed/iu.test(message)
    ? "notInstalled"
    : /auth|not logged in|login|unauthorized|credential/iu.test(message)
      ? "authenticationRequired"
      : /session not found/iu.test(message)
        ? "sessionNotFound"
        : /already open in another process/iu.test(message)
          ? "sessionBusy"
          : /exited|closed/iu.test(message)
            ? "processExited"
            : "protocolError";
  return { code, message, retryable: false };
}
function rejected(code: HarnessError["code"], message: string): { ok: false; error: HarnessError } {
  return { ok: false, error: { code, message, retryable: false } };
}
export class DevinAdapter implements HarnessAdapter {
  readonly harnessId = harnessIdSchema.parse("devin");
  readonly #sessions = new Set<DevinSession>();
  readonly #inspections = new Map<
    string,
    { pending: boolean; result: Promise<HarnessInspection> }
  >();
  #closed = false;
  constructor(readonly options: DevinAdapterOptions = {}) {}
  transportOptions(cwd: string, environment?: NodeJS.ProcessEnv): DevinTransportOptions {
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
        error: { code: "unavailable", message: "Devin adapter is closed", retryable: false },
      };
    const cwd = path.resolve(input.cwd ?? process.cwd());
    const cached = this.#inspections.get(cwd);
    if (cached && (cached.pending || !input.refresh)) return cached.result;
    const result = (async (): Promise<HarnessInspection> => {
      const transport = new DevinTransport(this.transportOptions(cwd));
      try {
        const info = await transport.open();
        return {
          status: "ready",
          catalog: devinCatalog(info),
          capabilities: DEVIN_CAPABILITIES,
          permissionModes: devinModes(info),
        };
      } catch (error) {
        const failure = devinError(error);
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
    if (this.#closed) return rejected("invalidState", "Devin adapter is closed");
    if (input.kind !== "create" && input.kind !== "resume")
      return rejected("unsupported", "Devin fork and rollback are not supported");
    if (input.thinkingOptionId)
      return rejected("unsupported", "Devin ACP has no independent thinking selector");
    if (input.kind === "resume" && input.nativeRef.harnessId !== this.harnessId)
      return rejected("invalidRequest", "Session belongs to another Harness");
    const options = this.transportOptions(input.cwd, input.environment);
    const transport = new DevinTransport(options);
    try {
      const info = await transport.open(
        input.kind === "resume" ? input.nativeRef.nativeSessionId : undefined,
      );
      if (input.kind === "resume") {
        const known = new Set(
          devinSnapshot(transport.sessionId, transport.replay).turns.map(
            (turn) => turn.nativeTurnRef.nativeTurnKey,
          ),
        );
        if (
          input.knownTurnRefs?.some(
            (ref) =>
              ref.harnessId !== this.harnessId ||
              ref.nativeSessionId !== transport.sessionId ||
              !known.has(ref.nativeTurnKey),
          )
        )
          throw new Error("Saved Devin turn identity no longer exists in native history");
      }
      const session = new DevinSession(
        transport,
        info,
        () => {
          this.#sessions.delete(session);
        },
        input.kind === "create",
      );
      if (input.model) {
        const selected = await session.execute({ type: "model.select", model: input.model });
        if (!selected.ok) throw new Error(selected.error.message);
      }
      const permissionModeId =
        input.permissionModeId ??
        (input.kind === "create" && input.executionPolicy === "unattended-full-access"
          ? harnessPermissionModeIdSchema.parse("bypass")
          : undefined);
      if (permissionModeId) {
        const selected = await session.execute({
          type: "permissionMode.select",
          permissionModeId,
        });
        if (!selected.ok) throw new Error(selected.error.message);
      }
      if (this.#closed) {
        await session.close();
        return rejected("invalidState", "Devin adapter closed during session startup");
      }
      this.#sessions.add(session);
      return { ok: true, value: session };
    } catch (error) {
      await transport.close();
      return { ok: false, error: devinError(error) };
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

export class DevinSession implements HarnessSession {
  readonly harnessId = harnessIdSchema.parse("devin");
  readonly capabilities = DEVIN_CAPABILITIES;
  readonly initialUsage = null;
  readonly initialState: HarnessSessionState;
  readonly #channel = new HarnessOutputChannel<HarnessOutput>();
  readonly outputs = this.#channel.outputs;
  readonly #interactions = new DevinInteractions((output) => this.#channel.emit(output));
  readonly #submitted = new Set<string>();
  #active: { command: TurnStartCommand; cancelled: boolean; task: Promise<void> } | undefined;
  #configuring = false;
  #closed = false;
  #fresh: boolean;
  #turns = 0;
  constructor(
    readonly transport: DevinTransport,
    readonly info: DevinSessionInfo,
    readonly onClose: () => void,
    created = true,
  ) {
    this.#fresh = created;
    const current = devinModels(info).current;
    this.initialState = {
      nativeRef: nativeSessionRefSchema.parse({
        harnessId: "devin",
        nativeSessionId: transport.sessionId,
        formatVersion: 1,
      }),
      ...(current ? { effectiveModel: devinModelRef(current) } : {}),
      effectivePermissionModeId: harnessPermissionModeIdSchema.parse(
        info.modes?.currentModeId ?? "accept-edits",
      ),
    };
  }
  async readSnapshot(): Promise<HarnessResult<HostThreadSnapshot>> {
    if (this.#closed) return rejected("invalidState", "Devin session is closed");
    if (this.#active || this.#configuring) return rejected("sessionBusy", "Devin session is busy");
    if (this.#fresh && this.#turns === 0)
      return { ok: true, value: { turns: [], state: structuredClone(this.initialState) } };
    this.#configuring = true;
    try {
      const replay = await this.transport.reload();
      return {
        ok: true,
        value: {
          ...devinSnapshot(this.transport.sessionId, replay),
          state: structuredClone(this.initialState),
        },
      };
    } catch (error) {
      return { ok: false, error: devinError(error) };
    } finally {
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
    if (this.#closed) return rejected("invalidState", "Devin session is closed");
    if (command.type === "interaction.respond") return this.#interactions.respond(command);
    if (command.type === "turn.cancel") {
      if (!this.#active || this.#active.command.turnId !== command.turnId)
        return rejected("invalidState", "Devin turn is not active");
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
    if (this.#active || this.#configuring) return rejected("sessionBusy", "Devin session is busy");
    if (command.type === "turn.start") {
      if (this.#submitted.has(command.turnId))
        return rejected("invalidState", "Devin turn was already submitted");
      if (
        !command.input.length ||
        command.input.some((part) => part.type !== "text") ||
        !command.input.some((part) => part.text.trim())
      )
        return rejected("invalidRequest", "Devin requires nonempty text input");
      this.#submitted.add(command.turnId);
      const active = { command, cancelled: false, task: Promise.resolve() };
      this.#active = active;
      active.task = this.#run(command);
      return { ok: true, value: { turnId: command.turnId } };
    }
    if (command.type === "thinking.select")
      return rejected(
        "unsupported",
        "Devin ACP exposes model variants, not an independent thinking selector",
      );
    this.#configuring = true;
    try {
      const value =
        command.type === "model.select"
          ? devinNativeModel(this.info, command.model.id)
          : command.permissionModeId;
      const configId = command.type === "model.select" ? "model" : "mode";
      if (
        configId === "mode" &&
        !(this.info.modes?.availableModes ?? []).some((mode) => mode.id === value)
      )
        return rejected("invalidRequest", "Unknown Devin permission mode");
      const result = await this.transport.configure(configId, value);
      if (
        !result.configOptions.some(
          (option) => option.id === configId && option.currentValue === value,
        )
      )
        throw new Error("Devin did not confirm configuration selection");
      if (command.type === "model.select") this.initialState.effectiveModel = command.model;
      else this.initialState.effectivePermissionModeId = command.permissionModeId;
      this.#channel.emit({
        kind: "event",
        event: { type: "session.state.changed", state: { ...this.initialState } },
      });
      return { ok: true, value: { completed: true } };
    } catch (error) {
      return { ok: false, error: devinError(error) };
    } finally {
      this.#configuring = false;
    }
  }
  async #run(command: TurnStartCommand) {
    let fault: HarnessError | undefined;
    const output = new DevinTurnOutput(command.turnId, (event) =>
      this.#channel.emit({ kind: "event", event }),
    );
    this.#channel.emit({ kind: "event", event: { type: "turn.started", turnId: command.turnId } });
    let outcome: TurnOutcome = {
      status: "failed",
      error: { code: "nativeFailure", message: "Devin turn failed", retryable: false },
    };
    let nativeTurnRef: ReturnType<typeof nativeTurnRefSchema.parse> | undefined;
    try {
      const result = await this.transport.prompt(
        command.input.map((part) => part.text).join("\n"),
        {
          update: (event) => {
            if (event.update.sessionUpdate === "current_mode_update") {
              this.initialState.effectivePermissionModeId = harnessPermissionModeIdSchema.parse(
                event.update.currentModeId,
              );
              this.#channel.emit({
                kind: "event",
                event: {
                  type: "session.state.changed",
                  state: { ...this.initialState },
                },
              });
            }
            output.update(event);
          },
          permission: (request) => this.#interactions.permission(command.turnId, request),
          extension: () => this.#interactions.extension(),
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
                  message: `Devin stopped: ${result.stopReason}`,
                  retryable: false,
                },
              };
      const key = devinPromptTurnKey(result);
      if (key) {
        nativeTurnRef = nativeTurnRefSchema.parse({
          harnessId: "devin",
          nativeSessionId: this.transport.sessionId,
          nativeTurnKey: key,
          formatVersion: 1,
        });
        this.#turns += 1;
        this.#fresh = false;
      } else if (outcome.status === "succeeded") {
        // Never publish a success terminal with guessed identity.
        outcome = {
          status: "failed",
          error: {
            code: "protocolError",
            message: "Devin terminal has no verified native turn identity",
            retryable: false,
          },
        };
      }
    } catch (error) {
      fault = devinError(error);
      outcome = this.#active?.cancelled
        ? { status: "cancelled" }
        : { status: "failed", error: devinError(error) };
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
