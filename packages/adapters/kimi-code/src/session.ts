import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  HarnessOutputChannel,
  validateHostInteractionResponse,
  type HarnessSession,
  type HarnessSessionState,
  type HarnessOutput,
  type HarnessResult,
  type HostCommand,
  type HostEvent,
  type HostItem,
  type HostThreadSnapshot,
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
import { type HostTurnId, type NativeSessionRef } from "@codexhost/shared-contracts";
import {
  HARNESS_ID,
  KimiError,
  failure,
  success,
  parse,
  permissionSchema,
  sessionPath,
  snapshotSchema,
  statusSchema,
  transcriptSchema,
  type KimiTransport,
  type NativeEvent,
  type NativeModel,
  type NativeSnapshot,
  type NativeTurn,
} from "./protocol.js";
import {
  capabilities,
  frameOutcome,
  modelRef,
  projectFrame,
  projectTurn,
  readTurns,
  readActiveTurn,
  sessionState,
  terminal,
  turnOutcome,
} from "./projection.js";
import { interactions, nativeAnswers, type PendingInteraction } from "./interactions.js";

type Accepted =
  | TurnStartAccepted
  | TurnCancelAccepted
  | InteractionRespondAccepted
  | ModelSelectCompleted
  | ThinkingSelectCompleted
  | PermissionModeSelectCompleted;
interface ActiveTurn {
  turnId: HostTurnId;
  promptId: string;
  accepted: boolean;
  native?: NativeTurn;
  items: Map<string, { item: HostItem; completed: boolean }>;
  pending: Map<string, PendingInteraction>;
  closedInteractions: Set<string>;
  cancelling: boolean;
}

export class KimiSession implements HarnessSession {
  readonly harnessId = HARNESS_ID;
  readonly capabilities = capabilities;
  readonly initialUsage = null;
  readonly initialState: HarnessSessionState;
  readonly outputs: AsyncIterable<HarnessOutput>;
  #channel = new HarnessOutputChannel<HarnessOutput>();
  #active: ActiveTurn | undefined;
  #closed = false;
  #closePromise: Promise<void> | undefined;
  #state: HarnessSessionState;
  #snapshot: NativeSnapshot;
  #configurationBusy = false;
  #reading = false;
  #refreshing: Promise<void> | undefined;
  #refreshTimer: NodeJS.Timeout | undefined;
  #cancelTimer: NodeJS.Timeout | undefined;
  #dirty = false;
  #recover = false;
  #seq: number;
  #epoch: string;
  #faultError: unknown;
  #offsets = new Map<string, number>();

  constructor(
    private transport: KimiTransport,
    private ref: NativeSessionRef,
    private models: NativeModel[],
    snapshot: NativeSnapshot,
    state: HarnessSessionState,
    private onClose: () => void,
  ) {
    this.#snapshot = snapshot;
    this.#state = state;
    this.initialState = state;
    this.#seq = snapshot.as_of_seq;
    this.#epoch = snapshot.epoch;
    this.outputs = this.#channel.outputs;
  }
  async initialize(): Promise<void> {
    try {
      // Kimi 2.0.2 lazily binds its transcript projector on the first GET.
      // Await that route's history backfill before a prompt can emit deltas;
      // binding mid-turn can lose the first text fragment and its frame state.
      const transcript = parse(
        transcriptSchema,
        await this.transport.request(
          `${sessionPath(this.ref.nativeSessionId)}/transcript?agent_id=main&page_size=1`,
        ),
      );
      if (transcript.agent_id !== "main")
        throw new KimiError("protocolError", "Kimi Code returned another agent's transcript");
      await this.transport.connect(
        (event) => this.#event(event),
        (error) => {
          void this.#fault(error);
        },
      );
      await this.transport.subscribe(this.ref.nativeSessionId, {
        seq: this.#seq,
        epoch: this.#epoch,
      });
    } catch (error) {
      await this.close();
      throw this.#faultError ?? error;
    }
    if (this.#closed)
      throw new KimiError("invalidState", "Kimi Code session closed during initialization");
  }
  #emit(event: HostEvent): void {
    this.#channel.emit({ kind: "event", event });
  }
  #assertOpen(): void {
    if (this.#closed) throw new KimiError("invalidState", "Kimi Code session is closed or faulted");
  }
  async #status(): Promise<HarnessSessionState> {
    const status = parse(
      statusSchema,
      await this.transport.request(`${sessionPath(this.ref.nativeSessionId)}/status`),
    );
    return sessionState(this.ref, status, this.models);
  }
  #publishState(state: HarnessSessionState): void {
    if (this.#closed) return;
    if (JSON.stringify(state) !== JSON.stringify(this.#state)) {
      this.#state = state;
      this.#emit({ type: "session.state.changed", state });
    }
  }
  #event(event: NativeEvent): void {
    if (this.#closed) return;
    if (
      event.type === "transport.reconnected" ||
      (event.type === "resync_required" && event.payload?.session_id === this.ref.nativeSessionId)
    ) {
      this.#recover = true;
      this.#schedule(0);
      return;
    }
    if (event.session_id !== this.ref.nativeSessionId) return;
    if (event.epoch && event.epoch !== this.#epoch) this.#recover = true;
    if (!event.volatile && event.seq !== undefined) {
      if (event.seq <= this.#seq && !this.#recover) return;
      if (event.seq > this.#seq + 1) this.#recover = true;
      this.#seq = Math.max(event.seq, this.#seq);
    }
    if (
      (event.type === "assistant.delta" || event.type === "thinking.delta") &&
      event.offset !== undefined
    ) {
      const key = `${String(event.payload?.agentId)}:${String(event.payload?.turnId)}:${event.type}`;
      const previous = this.#offsets.get(key) ?? 0;
      if (event.offset < previous && !this.#recover) return;
      if (event.offset > previous) this.#recover = true;
      if (typeof event.payload?.delta === "string")
        this.#offsets.set(key, event.offset + event.payload.delta.length);
    }
    // Legacy events invalidate the canonical transcript. Never invent frame IDs or replay raw deltas.
    this.#schedule(
      event.type === "turn.ended" ||
        event.type.includes("approval") ||
        event.type.includes("question")
        ? 0
        : 75,
    );
  }
  #schedule(milliseconds: number): void {
    if (this.#closed) return;
    this.#dirty = true;
    if (this.#refreshing) return;
    if (this.#refreshTimer && milliseconds !== 0) return;
    clearTimeout(this.#refreshTimer);
    this.#refreshTimer = setTimeout(() => {
      this.#refreshTimer = undefined;
      this.#refreshing = this.#refresh()
        .catch((error: unknown) => this.#fault(error))
        .finally(() => {
          this.#refreshing = undefined;
          if (!this.#closed && (this.#dirty || this.#active?.accepted))
            this.#schedule(this.#dirty ? 75 : 500);
        });
    }, milliseconds);
  }
  async #refresh(): Promise<void> {
    this.#dirty = false;
    const recover = this.#recover;
    this.#recover = false;
    const snapshot = parse(
      snapshotSchema,
      await this.transport.request(`${sessionPath(this.ref.nativeSessionId)}/snapshot`),
    );
    if (this.#closed) return;
    if (snapshot.session.id !== this.ref.nativeSessionId)
      throw new KimiError("protocolError", "Kimi Code changed session identity");
    this.#snapshot = snapshot;
    if (recover) {
      this.#seq = snapshot.as_of_seq;
      this.#epoch = snapshot.epoch;
      this.#offsets.clear();
      await this.transport.subscribe(this.ref.nativeSessionId, {
        seq: this.#seq,
        epoch: this.#epoch,
      });
    }
    const active = this.#active;
    if (!active?.accepted || this.#closed) return;
    const turn = await readActiveTurn(this.transport, this.ref.nativeSessionId, active.promptId);
    if (this.#closed || this.#active !== active) return;
    if (turn) {
      active.native = turn;
      this.#project(active, turn);
    }
    this.#interactions(active, snapshot);
    if (turn && terminal(turn) && !snapshot.session.busy && !snapshot.session.main_turn_active) {
      this.#finish(turnOutcome(turn));
      this.#publishState(await this.#status());
    }
  }
  #project(active: ActiveTurn, turn: NativeTurn): void {
    for (const step of turn.steps)
      for (const frame of step.frames) {
        const item = projectFrame(this.ref.nativeSessionId, turn, frame);
        if (!item) continue;
        const existing = active.items.get(item.itemId);
        if (existing?.completed) {
          if (JSON.stringify(existing.item) !== JSON.stringify(item))
            throw new KimiError("protocolError", "Kimi Code rewrote a completed transcript frame");
          continue;
        }
        if (!existing) this.#emit({ type: "item.started", turnId: active.turnId, item });
        else if (
          (item.type === "agentMessage" || item.type === "reasoning") &&
          (existing.item.type === "agentMessage" || existing.item.type === "reasoning")
        ) {
          if (!item.text.startsWith(existing.item.text))
            throw new KimiError("protocolError", "Kimi Code rewrote streaming transcript text");
          const text = item.text.slice(existing.item.text.length);
          if (text)
            this.#emit({
              type: "item.updated",
              turnId: active.turnId,
              itemId: item.itemId,
              update: { type: "text.append", text },
            });
        } else if (
          item.type === "toolExecution" &&
          item.output &&
          JSON.stringify(item) !== JSON.stringify(existing.item)
        ) {
          this.#emit({
            type: "item.updated",
            turnId: active.turnId,
            itemId: item.itemId,
            update: { type: "output.replace", output: item.output },
          });
        } else if (
          item.type === "commandExecution" &&
          existing.item.type === "commandExecution" &&
          item.output?.startsWith(existing.item.output ?? "")
        ) {
          const text = item.output.slice(existing.item.output?.length ?? 0);
          if (text)
            this.#emit({
              type: "item.updated",
              turnId: active.turnId,
              itemId: item.itemId,
              update: { type: "output.append", text },
            });
        }
        const completed =
          terminal(turn) ||
          (frame.kind === "tool" ? frame.state !== "running" : step.state !== "running");
        active.items.set(item.itemId, { item, completed });
        if (completed)
          this.#emit({
            type: "item.completed",
            turnId: active.turnId,
            snapshot: { item, outcome: frameOutcome(frame, turn) },
          });
      }
  }
  #interactions(active: ActiveTurn, snapshot: NativeSnapshot): void {
    const current = interactions(snapshot, active.turnId);
    const ids = new Set(current.map((pending) => pending.interaction.interactionId));
    for (const [id, pending] of active.pending) {
      if (!ids.has(pending.interaction.interactionId) && !pending.responding) {
        this.#emit({
          type: "interaction.closed",
          turnId: active.turnId,
          interactionId: pending.interaction.interactionId,
          reason: "superseded",
        });
        active.pending.delete(id);
        active.closedInteractions.add(id);
      }
    }
    for (const pending of current)
      if (
        !active.pending.has(pending.interaction.interactionId) &&
        !active.closedInteractions.has(pending.interaction.interactionId)
      ) {
        active.pending.set(pending.interaction.interactionId, pending);
        this.#channel.emit({ kind: "interaction", interaction: pending.interaction });
      }
  }
  #finish(outcome: TurnOutcome): void {
    const active = this.#active;
    if (!active) return;
    this.#active = undefined;
    clearTimeout(this.#cancelTimer);
    this.#offsets.clear();
    if (!active.accepted) return;
    for (const pending of active.pending.values())
      this.#emit({
        type: "interaction.closed",
        turnId: active.turnId,
        interactionId: pending.interaction.interactionId,
        reason: "cancelled",
      });
    for (const { item, completed } of active.items.values())
      if (!completed)
        this.#emit({ type: "item.completed", turnId: active.turnId, snapshot: { item, outcome } });
    this.#emit({
      type: "turn.completed",
      turnId: active.turnId,
      outcome,
      ...(active.native
        ? { nativeTurnRef: projectTurn(this.ref.nativeSessionId, active.native).nativeTurnRef }
        : {}),
    });
  }
  async readSnapshot(): Promise<HarnessResult<HostThreadSnapshot>> {
    let ownsRead = false;
    try {
      this.#assertOpen();
      if (this.#active || this.#configurationBusy || this.#reading)
        throw new KimiError("sessionBusy", "Kimi Code session is busy", true);
      this.#reading = true;
      ownsRead = true;
      const turns = await readTurns(this.transport, this.ref.nativeSessionId);
      const state = await this.#status();
      this.#assertOpen();
      return success({
        turns: turns.map((turn) => projectTurn(this.ref.nativeSessionId, turn)),
        state,
      });
    } catch (error) {
      return failure(error);
    } finally {
      if (ownsRead) this.#reading = false;
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
  async execute(command: HostCommand): Promise<HarnessResult<Accepted>> {
    try {
      this.#assertOpen();
      switch (command.type) {
        case "turn.start":
          return await this.#start(command);
        case "turn.cancel":
          return await this.#cancel(command);
        case "interaction.respond":
          return await this.#respond(command);
        default:
          return await this.#configure(command);
      }
    } catch (error) {
      return failure(error);
    }
  }
  async #start(command: TurnStartCommand): Promise<HarnessResult<TurnStartAccepted>> {
    if (this.#active || this.#configurationBusy || this.#reading)
      throw new KimiError("sessionBusy", "Kimi Code session is busy", true);
    if (
      !command.turnId?.trim() ||
      !command.input.length ||
      command.input.some((input) => input.type !== "text" || !input.text.trim())
    )
      throw new KimiError("invalidRequest", "Kimi Code requires a turn ID and nonempty text input");
    const active: ActiveTurn = {
      turnId: command.turnId,
      promptId: randomUUID(),
      accepted: false,
      items: new Map(),
      pending: new Map(),
      closedInteractions: new Set(),
      cancelling: false,
    };
    this.#active = active;
    let submitted = false;
    try {
      const status = parse(
        statusSchema,
        await this.transport.request(`${sessionPath(this.ref.nativeSessionId)}/status`),
      );
      if (status.busy)
        throw new KimiError("sessionBusy", "The native Kimi Code session is busy", true);
      if (!status.model || !this.models.some((model) => model.model === status.model))
        throw new KimiError(
          "invalidRequest",
          "Kimi Code session has no usable model; select a model before starting a turn",
        );
      this.#assertOpen();
      submitted = true;
      const response = parse(
        z.object({ prompt_id: z.string(), status: z.enum(["running", "queued", "blocked"]) }),
        await this.transport.request(`${sessionPath(this.ref.nativeSessionId)}/prompts`, "POST", {
          prompt_id: active.promptId,
          content: command.input,
        }),
      );
      this.#assertOpen();
      if (response.prompt_id !== active.promptId)
        throw new KimiError("protocolError", "Kimi Code changed the submitted prompt identity");
      active.accepted = true;
      this.#emit({ type: "turn.started", turnId: command.turnId });
      this.#schedule(0);
      return success({ turnId: command.turnId });
    } catch (error) {
      if (this.#active === active) this.#active = undefined;
      if (
        submitted &&
        !(
          error instanceof KimiError &&
          [
            "invalidRequest",
            "authenticationRequired",
            "sessionBusy",
            "sessionNotFound",
            "nativeFailure",
          ].includes(error.code)
        )
      )
        await this.#fault(error);
      throw error;
    }
  }
  async #cancel(command: TurnCancelCommand): Promise<HarnessResult<TurnCancelAccepted>> {
    const active = this.#active;
    if (!active?.accepted || active.turnId !== command.turnId)
      throw new KimiError("invalidState", "Cancel must reference the active Kimi Code turn");
    if (active.cancelling) return success({ cancellationRequested: true });
    active.cancelling = true;
    try {
      parse(
        z.object({ aborted: z.boolean() }),
        await this.transport.request(
          `${sessionPath(this.ref.nativeSessionId)}/prompts/${encodeURIComponent(active.promptId)}:abort`,
          "POST",
        ),
      );
      if (this.#active === active) {
        this.#cancelTimer = setTimeout(() => {
          void this.#fault(
            new KimiError(
              "unavailable",
              "Kimi Code cancellation did not reach a native terminal state",
            ),
          );
        }, 30_000);
        this.#schedule(0);
      }
      return success({ cancellationRequested: true });
    } catch (error) {
      active.cancelling = false;
      if (
        !(error instanceof KimiError) ||
        ["unavailable", "processExited", "protocolError"].includes(error.code)
      )
        await this.#fault(error);
      throw error;
    }
  }
  async #respond(
    command: InteractionRespondCommand,
  ): Promise<HarnessResult<InteractionRespondAccepted>> {
    const active = this.#active,
      pending = active?.pending.get(command.interactionId);
    const invalid = validateHostInteractionResponse(pending?.interaction, command.response);
    if (invalid) return { ok: false, error: invalid };
    if (!active || !pending || pending.responding || active.cancelling)
      throw new KimiError("invalidState", "Kimi Code interaction is no longer answerable");
    pending.responding = true;
    const route = sessionPath(this.ref.nativeSessionId);
    try {
      if (command.response.type === "approval") {
        const action = command.response.actionId;
        parse(
          z.object({ resolved: z.boolean() }).refine((value) => value.resolved),
          await this.transport.request(
            `${route}/approvals/${encodeURIComponent(pending.nativeId)}`,
            "POST",
            {
              decision: action === "deny" ? "rejected" : "approved",
              ...(action === "session" ? { scope: "session" } : {}),
            },
          ),
        );
      } else if (command.response.cancelled) {
        parse(
          z.object({ resolved: z.literal(true) }).nullable(),
          await this.transport.request(
            `${route}/questions/${encodeURIComponent(pending.nativeId)}:dismiss`,
            "POST",
          ),
        );
      } else {
        const native = this.#snapshot.pending_questions.find(
          (question) => question.question_id === pending.nativeId,
        );
        if (!native) throw new KimiError("invalidState", "Kimi Code question expired");
        parse(
          z.object({ resolved: z.literal(true) }),
          await this.transport.request(
            `${route}/questions/${encodeURIComponent(pending.nativeId)}`,
            "POST",
            { answers: nativeAnswers(native.questions, command.response) },
          ),
        );
      }
      if (this.#active === active && active.pending.delete(command.interactionId)) {
        active.closedInteractions.add(command.interactionId);
        this.#emit({
          type: "interaction.closed",
          interactionId: command.interactionId,
          turnId: active.turnId,
          reason:
            command.response.type === "question" && command.response.cancelled
              ? "cancelled"
              : "responded",
        });
      }
      this.#schedule(0);
      return success({ accepted: true });
    } finally {
      pending.responding = false;
    }
  }
  async #configure(
    command: ModelSelectCommand | ThinkingSelectCommand | PermissionModeSelectCommand,
  ): Promise<HarnessResult<ModelSelectCompleted>> {
    if (this.#configurationBusy || this.#reading)
      throw new KimiError(
        "sessionBusy",
        "A Kimi Code configuration operation is already in progress",
        true,
      );
    this.#configurationBusy = true;
    try {
      let patch: Record<string, string>;
      if (command.type === "model.select") {
        const model = this.models.find((entry) => modelRef(entry.model).id === command.model.id);
        if (!model) throw new KimiError("invalidRequest", "Unknown Kimi Code model reference");
        patch = { model: model.model };
      } else if (command.type === "thinking.select") {
        const current = await this.#status();
        const model = this.models.find(
          (entry) => modelRef(entry.model).id === current.effectiveModel?.id,
        );
        if (!model?.support_efforts?.includes(command.thinkingOptionId))
          throw new KimiError(
            "invalidRequest",
            "Thinking option is not supported by the current Kimi Code model",
          );
        patch = { thinking: command.thinkingOptionId };
      } else {
        patch = { permission_mode: parse(permissionSchema, command.permissionModeId) };
      }
      await this.transport.request(`${sessionPath(this.ref.nativeSessionId)}/profile`, "POST", {
        agent_config: patch,
      });
      const state = await this.#status();
      this.#assertOpen();
      const confirmed =
        command.type === "model.select"
          ? state.effectiveModel?.id === command.model.id
          : command.type === "thinking.select"
            ? state.effectiveThinkingOptionId === command.thinkingOptionId
            : state.effectivePermissionModeId === command.permissionModeId;
      this.#publishState(state);
      if (!confirmed)
        throw new KimiError(
          "nativeFailure",
          "Kimi Code did not confirm the requested configuration",
        );
      return success({ completed: true });
    } finally {
      this.#configurationBusy = false;
    }
  }
  async #fault(error: unknown): Promise<void> {
    if (this.#closed) return;
    this.#faultError = error;
    const normalized = failure(error).error;
    this.#finish({ status: "failed", error: normalized });
    this.#emit({ type: "session.faulted", error: normalized });
    await this.close().catch(() => {
      /* The already emitted fault remains the public terminal event. */
    });
  }
  close(): Promise<void> {
    if (!this.#closePromise) {
      this.#closePromise = this.#close().catch((error: unknown) => {
        this.#closePromise = undefined;
        throw error;
      });
    }
    return this.#closePromise;
  }
  async #close(): Promise<void> {
    this.#closed = true;
    clearTimeout(this.#refreshTimer);
    clearTimeout(this.#cancelTimer);
    try {
      await this.transport.close();
      this.onClose();
    } finally {
      this.#finish({ status: "cancelled", reason: "Session closed" });
      this.#channel.end();
    }
  }
}
