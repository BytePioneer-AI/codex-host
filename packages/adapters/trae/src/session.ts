import { randomUUID } from "node:crypto";
import {
  HarnessOutputChannel,
  unsupportedSteer,
  type HarnessSession,
  type HarnessSessionState,
  type HarnessModelCatalog,
  type HarnessOutput,
  type HarnessResult,
  type HostEvent,
  type HostCommand,
  type HostThreadSnapshot,
  type OpenSessionInput,
  type TurnStartCommand,
  type TurnSteerCommand,
  type TurnCancelCommand,
  type InteractionRespondCommand,
  type ModelSelectCommand,
  type ThinkingSelectCommand,
  type PermissionModeSelectCommand,
  type TurnStartAccepted,
  type TurnSteerAccepted,
  type TurnCancelAccepted,
  type InteractionRespondAccepted,
  type ModelSelectCompleted,
  type ThinkingSelectCompleted,
  type PermissionModeSelectCompleted,
} from "@codexhost/harness-adapter";
import { hostTurnIdSchema, type HostTurnId } from "@codexhost/shared-contracts";
import {
  CAPABILITIES,
  HARNESS_ID,
  decodeModel,
  permissionParams,
  stateFrom,
} from "./configuration.js";
import { openHistory } from "./history.js";
import { TraeInteractions } from "./interactions.js";
import {
  checkpoint,
  historyFrom,
  outcome,
  turnRef,
  TurnProjection,
  usageFrom,
} from "./projection.js";
import { array, errorOf, fail, record, requiredText, text, TraeError } from "./protocol.js";
import type { NativeHandler, TraeTransport } from "./transport.js";

type Selection = {
  [K in "effectiveModel" | "effectiveThinkingOptionId" | "effectivePermissionModeId"]?:
    HarnessSessionState[K] | undefined;
};
type Active = { hostId: HostTurnId; nativeId: string; projection: TurnProjection };
type Frame = Parameters<NativeHandler>;

export class TraeSession implements HarnessSession {
  readonly harnessId = HARNESS_ID;
  readonly capabilities = CAPABILITIES;
  readonly outputs;
  readonly initialState: HarnessSessionState;
  readonly initialUsage;
  #channel = new HarnessOutputChannel<HarnessOutput>();
  #interactions: TraeInteractions;
  #state: HarnessSessionState;
  #selection: Selection;
  #active: Active | undefined;
  #buffer: Frame[] | undefined;
  #seen = new Set<string>();
  #hostTurns = new Set<HostTurnId>();
  #unattended = false;
  #busy = false;
  #closed = false;
  #faulted = false;
  #closePromise: Promise<void> | undefined;

  private constructor(
    readonly transport: TraeTransport,
    readonly cwd: string,
    readonly catalog: HarnessModelCatalog,
    selection: Selection,
    response?: unknown,
    readonly onClosed: (session: TraeSession) => void = () => {},
  ) {
    this.#selection = selection;
    this.#state = response ? stateFrom(response, cwd, catalog) : {};
    this.initialState = structuredClone(this.#state);
    this.initialUsage = usageFrom(record(response).tokenUsage);
    this.outputs = this.#channel.outputs;
    this.#interactions = new TraeInteractions(
      transport,
      (e) => this.#emit(e),
      (i) => this.#channel.emit({ kind: "interaction", interaction: i }),
    );
    transport.onMessage = (...frame) => this.#receive(...frame);
    transport.onFault = (error) => this.#fault(error);
  }
  static async open(
    transport: TraeTransport,
    input: OpenSessionInput,
    catalog: HarnessModelCatalog,
    onClosed: (session: TraeSession) => void = () => {},
  ): Promise<TraeSession> {
    let selection: Selection = {};
    let response: unknown;
    if (input.kind === "create") {
      if (
        input.executionPolicy === "unattended-full-access" &&
        input.permissionModeId &&
        input.permissionModeId !== "full-access"
      )
        throw new TraeError(
          "invalidRequest",
          "Trae permission mode conflicts with unattended full access",
        );
      selection = {
        effectiveModel: input.model,
        effectiveThinkingOptionId: input.thinkingOptionId,
        effectivePermissionModeId: (input.executionPolicy === "unattended-full-access"
          ? "full-access"
          : (input.permissionModeId ??
            "workspace-write")) as Selection["effectivePermissionModeId"],
      };
    } else response = await openHistory(transport, input, input.cwd);
    const session = new TraeSession(transport, input.cwd, catalog, selection, response, onClosed);
    session.#unattended =
      input.kind === "create" && input.executionPolicy === "unattended-full-access";
    session.#validate(selection);
    if (response) {
      // Native resume is authoritative. Do not replay Host's persisted configuration hints.
      session.#selection = {
        effectiveModel: session.#state.effectiveModel,
        effectiveThinkingOptionId: session.#state.effectiveThinkingOptionId,
        effectivePermissionModeId: session.#state.effectivePermissionModeId,
      };
      const history = historyFrom(
        await transport.call("thread/read", { threadId: session.#id(), includeTurns: true }),
        session.#id(),
      );
      for (const turn of history.turns) {
        if (turn.outcome.status === "unknown")
          throw new TraeError("sessionBusy", "Trae Session already has an active Turn", true);
        session.#seen.add(turn.nativeTurnRef.nativeTurnKey);
      }
    }
    return session;
  }
  #emit(event: HostEvent): void {
    this.#channel.emit({ kind: "event", event });
  }
  #id(): string {
    return this.#state.nativeRef?.nativeSessionId ?? "";
  }
  #validate(selection: Selection): void {
    const selected = selection.effectiveModel ?? this.catalog.defaultModel;
    if (selection.effectiveModel && !this.catalog.models.some((m) => m.ref.id === selected?.id))
      throw new TraeError("invalidRequest", "Model is absent from Trae's available catalog");
    if (
      selection.effectiveThinkingOptionId &&
      !this.catalog.models
        .find((m) => m.ref.id === selected?.id)
        ?.supportedThinkingOptionIds?.includes(selection.effectiveThinkingOptionId)
    )
      throw new TraeError(
        "invalidRequest",
        "Thinking option is not supported by the selected Trae Model",
      );
    if (selection.effectivePermissionModeId) permissionParams(selection.effectivePermissionModeId);
  }
  #params(selection: Selection): Record<string, unknown> {
    return {
      ...(selection.effectiveModel ? decodeModel(selection.effectiveModel) : {}),
      ...(selection.effectiveThinkingOptionId
        ? { config: { model_reasoning_effort: selection.effectiveThinkingOptionId } }
        : {}),
      ...(selection.effectivePermissionModeId
        ? permissionParams(selection.effectivePermissionModeId)
        : {}),
    };
  }
  #confirm(response: unknown, requested: Selection): void {
    if (this.#closed || this.#faulted)
      throw new TraeError("invalidState", "Trae Session closed during configuration");
    const next = stateFrom(response, this.cwd, this.catalog);
    if (this.#id() && next.nativeRef?.nativeSessionId !== this.#id())
      throw new TraeError("protocolError", "Trae changed the Session identity");
    this.#state = next;
    this.#selection = {
      effectiveModel: next.effectiveModel,
      effectiveThinkingOptionId: next.effectiveThinkingOptionId,
      effectivePermissionModeId: next.effectivePermissionModeId,
    };
    this.#emit({ type: "session.state.changed", state: structuredClone(next) });
    if (
      (requested.effectiveModel && next.effectiveModel?.id !== requested.effectiveModel.id) ||
      (requested.effectiveThinkingOptionId &&
        next.effectiveThinkingOptionId !== requested.effectiveThinkingOptionId) ||
      (requested.effectivePermissionModeId &&
        next.effectivePermissionModeId !== requested.effectivePermissionModeId)
    )
      throw new TraeError(
        "configurationRequired",
        "Trae did not confirm the requested configuration; native state was retained",
      );
  }
  async readSnapshot(): Promise<HarnessResult<HostThreadSnapshot>> {
    if (this.#closed || this.#faulted)
      return fail("invalidState", "Trae Session is closed or faulted");
    if (this.#busy)
      return fail("sessionBusy", "Trae configuration or Turn admission is in progress", true);
    if (!this.#id()) return { ok: true, value: { turns: [] } };
    this.#busy = true;
    try {
      const result = historyFrom(
        await this.transport.call("thread/read", { threadId: this.#id(), includeTurns: true }),
        this.#id(),
      );
      if (this.#closed || this.#faulted)
        throw new TraeError("invalidState", "Trae Session closed during history read");
      return { ok: true, value: { ...result, state: structuredClone(this.#state) } };
    } catch (e) {
      return { ok: false, error: errorOf(e) };
    } finally {
      this.#busy = false;
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
    >
  > {
    if (this.#closed || this.#faulted)
      return fail("invalidState", "Trae Session is closed or faulted");
    if (command.type === "interaction.respond") return this.#interactions.respond(command);
    if (command.type === "turn.steer") return unsupportedSteer(HARNESS_ID);
    if (command.type === "turn.cancel") {
      if (!this.#active || this.#active.hostId !== command.turnId)
        return fail("invalidRequest", "No matching active Trae Turn");
      try {
        await this.transport.call("turn/interrupt", {
          threadId: this.#id(),
          turnId: this.#active.nativeId,
        });
        return { ok: true, value: { cancellationRequested: true } };
      } catch (e) {
        return { ok: false, error: errorOf(e) };
      }
    }
    if (this.#busy)
      return fail("sessionBusy", "Trae configuration or Turn admission is in progress", true);
    if (command.type === "turn.start") return this.#start(command);
    if (command.type === "permissionMode.select" && this.#active)
      return fail("sessionBusy", "Cannot change Trae permissions during a Turn", true);
    this.#busy = true;
    try {
      const next: Selection = { ...this.#selection };
      if (command.type === "model.select") {
        next.effectiveModel = command.model;
        delete next.effectiveThinkingOptionId;
      } else if (command.type === "thinking.select")
        next.effectiveThinkingOptionId = command.thinkingOptionId;
      else if (command.type === "permissionMode.select")
        next.effectivePermissionModeId = command.permissionModeId;
      else throw new TraeError("unsupported", "Unsupported Trae command");
      this.#validate(next);
      if (this.#unattended && next.effectivePermissionModeId !== "full-access")
        throw new TraeError(
          "invalidRequest",
          "Permission mode conflicts with unattended Trae execution",
        );
      if (!this.#id()) {
        // Draft selection is admitted against the native catalog, but has no effective state yet.
        this.#selection = next;
      } else {
        const response = await this.transport.call("thread/resume", {
          threadId: this.#id(),
          cwd: this.cwd,
          ...this.#params(next),
        });
        this.#confirm(response, next);
      }
      return { ok: true, value: { completed: true } };
    } catch (e) {
      return { ok: false, error: errorOf(e) };
    } finally {
      this.#busy = false;
    }
  }
  async #start(command: TurnStartCommand): Promise<HarnessResult<TurnStartAccepted>> {
    if (this.#active) return fail("sessionBusy", "Trae already has an active Turn", true);
    if (this.#hostTurns.has(command.turnId))
      return fail("invalidRequest", "Trae Turn ID was already used in this Session");
    if (
      !hostTurnIdSchema.safeParse(command.turnId).success ||
      !command.input.length ||
      !command.input.every((i) => i.type === "text" && typeof i.text === "string") ||
      !command.input.some((i) => i.text.trim())
    )
      return fail("invalidRequest", "Trae requires a Turn ID and nonempty text input");
    this.#busy = true;
    try {
      if (!this.#id()) {
        const selection = { ...this.#selection };
        const response = await this.transport.call("thread/start", {
          cwd: this.cwd,
          ...this.#params(selection),
        });
        this.#confirm(response, selection);
      }
      if (this.#unattended && this.#state.effectivePermissionModeId !== "full-access")
        throw new TraeError(
          "configurationRequired",
          "Trae full access has not been confirmed for unattended execution",
        );
      this.#buffer = [];
      const response = record(
        await this.transport.call("turn/start", {
          threadId: this.#id(),
          input: command.input.map((i) => ({ type: "text", text: i.text, text_elements: [] })),
        }),
      );
      const nativeId = requiredText(record(response.turn).id, "turn.id");
      if (this.#seen.has(nativeId))
        throw new TraeError("protocolError", "Trae reused a settled Turn identity");
      this.#active = {
        nativeId,
        hostId: command.turnId,
        projection: new TurnProjection(command.turnId, (e) => this.#emit(e)),
      };
      this.#hostTurns.add(command.turnId);
      this.#emit({ type: "turn.started", turnId: command.turnId });
      const buffered = this.#buffer;
      this.#buffer = undefined;
      for (const frame of buffered) this.#receive(...frame);
      if (this.#faulted || this.#closed)
        this.#finishFault(new TraeError("processExited", "Trae closed during Turn admission"));
      return { ok: true, value: { turnId: command.turnId } };
    } catch (e) {
      for (const frame of this.#buffer ?? [])
        if (frame[2] !== undefined) this.transport.reject(frame[2]);
      this.#buffer = undefined;
      return { ok: false, error: errorOf(e) };
    } finally {
      this.#busy = false;
    }
  }
  #receive(method: string, params: Record<string, unknown>, requestId?: string | number): void {
    if (this.#closed || this.#faulted) return;
    if (this.#buffer) {
      if (this.#buffer.length >= 8192) {
        this.#fault(
          new TraeError("protocolError", "Trae admission notification buffer exceeded its limit"),
        );
        return;
      }
      this.#buffer.push([method, params, requestId]);
      return;
    }
    if (!this.#id() || params.threadId !== this.#id()) {
      if (requestId !== undefined) this.transport.reject(requestId);
      return;
    }
    try {
      if (method === "serverRequest/resolved") {
        this.#interactions.resolved(params.requestId);
        return;
      }
      if (method === "thread/tokenUsage/updated") {
        this.#emit({
          type: "session.usage.changed",
          usage: usageFrom(params.tokenUsage),
          ...(this.#active ? { observedForTurnId: this.#active.hostId } : {}),
        });
        return;
      }
      if (method === "thread/settings/updated") {
        const s = record(params.threadSettings);
        this.#confirm(
          { ...s, thread: { id: this.#id() }, sandbox: s.sandboxPolicy, reasoningEffort: s.effort },
          {},
        );
        return;
      }
      const turn = record(params.turn);
      const nativeId = text(params.turnId) || text(turn.id);
      if (method === "turn/started" && !this.#active && !this.#seen.has(nativeId) && nativeId) {
        const hostId = hostTurnIdSchema.parse(`trae-${randomUUID()}`);
        this.#active = {
          nativeId,
          hostId,
          projection: new TurnProjection(hostId, (e) => this.#emit(e)),
        };
        this.#emit({ type: "turn.autonomous.started", turnId: hostId, input: [] });
      }
      const active = this.#active;
      if (!active || active.nativeId !== nativeId) {
        if (requestId !== undefined) this.transport.reject(requestId);
        return;
      }
      if (requestId !== undefined) {
        this.#interactions.request(method, params, requestId, active.hostId);
        return;
      }
      if (method === "item/started" || method === "item/completed")
        active.projection.item(params.item, method === "item/completed");
      else if (method.startsWith("item/")) active.projection.delta(method, params);
      else if (method === "turn/completed") {
        if (!["completed", "interrupted", "failed"].includes(text(turn.status)))
          throw new TraeError("protocolError", "Trae sent a nonterminal Turn completion");
        for (const item of array(turn.items)) active.projection.item(item, true);
        const result = { ...outcome(turn.status), checkpoint: checkpoint(this.#id(), nativeId) };
        this.#interactions.cancel(active.hostId);
        active.projection.finish(result);
        this.#active = undefined;
        this.#seen.add(nativeId);
        this.#emit({
          type: "turn.completed",
          turnId: active.hostId,
          nativeTurnRef: turnRef(this.#id(), nativeId),
          outcome: result,
        });
      }
    } catch (e) {
      this.#fault(e);
    }
  }
  #finishFault(error: unknown): void {
    const active = this.#active;
    if (!active) return;
    this.#interactions.cancel(active.hostId);
    const result = { status: "failed" as const, error: errorOf(error) };
    active.projection.finish(result);
    this.#active = undefined;
    this.#seen.add(active.nativeId);
    this.#emit({
      type: "turn.completed",
      turnId: active.hostId,
      nativeTurnRef: turnRef(this.#id(), active.nativeId),
      outcome: result,
    });
  }
  #fault(error: unknown): void {
    if (this.#faulted || this.#closed) return;
    this.#faulted = true;
    this.#finishFault(error);
    this.#emit({ type: "session.faulted", error: errorOf(error) });
    this.#channel.end();
    this.onClosed(this);
    void this.transport.close();
  }
  close(): Promise<void> {
    return (this.#closePromise ??= this.#close());
  }
  async #close(): Promise<void> {
    this.#closed = true;
    this.#finishFault(new TraeError("invalidState", "Trae Session closed"));
    await this.transport.close();
    this.#channel.end();
    this.onClosed(this);
  }
}
