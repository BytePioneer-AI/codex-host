import { randomBytes } from "node:crypto";
import type { Event, Message, Part, Session } from "@mimo-ai/sdk/v2/client";
import {
  HarnessOutputChannel,
  validateHostInteractionResponse,
  type HarnessSession,
  type HarnessSessionState,
  type HarnessOutput,
  type HarnessResult,
  type HostCommand,
  type HostEvent,
  type HostInteraction,
  type HostItemSnapshot,
  type HostThreadSnapshot,
  type InteractionRespondCommand,
  type TurnOutcome,
} from "@codexhost/harness-adapter";
import {
  hostInteractionIdSchema,
  type HarnessModelRef,
  type HostItemId,
  type HostTurnId,
} from "@codexhost/shared-contracts";
import {
  bounded,
  capabilities,
  checked,
  decodeModel,
  encodeModel,
  errorOf,
  failure,
  MIMO_ID,
  MimoError,
} from "./protocol.js";
import { projectHistory, projectPart, readMessages, turnRef } from "./history.js";
import type { MimoConnection } from "./server.js";
import { validateModel } from "./models.js";
import type {
  TurnStartCommand,
  TurnStartAccepted,
  TurnCancelCommand,
  TurnCancelAccepted,
  InteractionRespondAccepted,
  ModelSelectCommand,
  ModelSelectCompleted,
  ThinkingSelectCommand,
  ThinkingSelectCompleted,
  PermissionModeSelectCommand,
  PermissionModeSelectCompleted,
} from "@codexhost/harness-adapter";

interface ActiveTurn {
  id: HostTurnId;
  messageID: string;
  persisted: boolean;
  cancelling: boolean;
  abortSent: boolean;
  nativeBusy: boolean;
  abortPromise?: Promise<void>;
  messages: Map<string, Message>;
  parts: Map<string, Part>;
  items: Map<HostItemId, HostItemSnapshot>;
  completed: Set<HostItemId>;
  cancelTimer?: NodeJS.Timeout;
}
interface PendingInteraction {
  nativeID: string;
  interaction: HostInteraction;
  responding: boolean;
}

export class MimoSession implements HarnessSession {
  readonly harnessId = MIMO_ID;
  readonly capabilities = capabilities;
  readonly initialUsage = null;
  readonly initialState: HarnessSessionState;
  readonly #channel = new HarnessOutputChannel<HarnessOutput>();
  readonly outputs = this.#channel.outputs;
  readonly #streamAbort = new AbortController();
  readonly #interactions = new Map<string, PendingInteraction>();
  #active: ActiveTurn | undefined;
  #closed = false;
  #closePromise: Promise<void> | undefined;
  #reading = false;
  #configuring = false;
  #state: HarnessSessionState;

  constructor(
    readonly connection: MimoConnection,
    readonly native: Session,
    state: HarnessSessionState,
    private model?: HarnessModelRef,
    readonly onClose?: () => void,
  ) {
    this.initialState = structuredClone({ ...state, ...(model ? { effectiveModel: model } : {}) });
    this.#state = structuredClone(this.initialState);
  }

  async startEvents(): Promise<void> {
    let connected!: () => void;
    let rejectReady!: (reason: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => {
      connected = resolve;
      rejectReady = reject;
    });
    const { stream } = await this.connection.client.event.subscribe(
      {},
      { signal: this.#streamAbort.signal, sseMaxRetryAttempts: 1 },
    );
    void (async () => {
      try {
        for await (const event of stream) {
          if (this.#closed) break;
          if (event.type === "server.connected") connected();
          else this.#event(event);
        }
        if (!this.#closed)
          throw new MimoError("unavailable", "MiMo event stream ended unexpectedly");
      } catch (error) {
        rejectReady(error);
        await this.#fault(error);
      }
    })().catch(() => {
      /* cleanup errors remain observable through close() */
    });
    void this.connection.exited.then(() => {
      if (!this.#closed)
        void this.#fault(new MimoError("processExited", "MiMo service exited")).catch(() => {});
    });
    await bounded(ready, 20_000, "MiMo event subscription timed out");
    if (this.#closed) throw new MimoError("unavailable", "MiMo session closed while subscribing");
  }

  async readSnapshot(): Promise<HarnessResult<HostThreadSnapshot>> {
    if (this.#closed) return failure("invalidState", "MiMo session is closed");
    if (this.#active || this.#reading || this.#configuring)
      return failure("sessionBusy", "MiMo session is busy");
    this.#reading = true;
    try {
      const native = checked(
        await this.connection.client.session.get({ sessionID: this.native.id }),
      );
      const snapshot = projectHistory(
        native,
        await readMessages(this.connection.client, this.native.id),
      );
      if (this.model) snapshot.state = { ...snapshot.state, effectiveModel: this.model };
      return { ok: true, value: snapshot };
    } catch (error) {
      return { ok: false, error: errorOf(error) };
    } finally {
      this.#reading = false;
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
  execute(command: HostCommand): Promise<HarnessResult<unknown>> {
    return this.#execute(command);
  }

  async #execute(command: HostCommand): Promise<HarnessResult<unknown>> {
    if (this.#closed) return failure("invalidState", "MiMo session is closed");
    if (command.type === "turn.start") {
      if (this.#active || this.#reading || this.#configuring)
        return failure("sessionBusy", "MiMo session is busy");
      if (
        !command.turnId.trim() ||
        !command.input.length ||
        command.input.some((part) => part.type !== "text" || typeof part.text !== "string") ||
        !command.input.some((part) => part.text.trim())
      )
        return failure("invalidRequest", "MiMo requires nonempty text input");
      // Same ascending v2 shape as native Identifier.create; counter zero sorts
      // before the native assistant generated in the same millisecond.
      const messageID = `msg_g${(BigInt(Date.now()) * 4096n).toString(16).padStart(16, "0")}${randomBytes(9).toString("hex").slice(0, 9)}`;
      const active: ActiveTurn = {
        id: command.turnId,
        messageID,
        persisted: false,
        cancelling: false,
        abortSent: false,
        nativeBusy: false,
        messages: new Map(),
        parts: new Map(),
        items: new Map(),
        completed: new Set(),
      };
      this.#active = active;
      this.#emit({ type: "turn.started", turnId: active.id });
      void this.#run(active, command.input)
        .catch((error) => this.#fault(error))
        .catch(() => {});
      return { ok: true, value: { turnId: command.turnId } };
    }
    if (command.type === "turn.cancel") {
      const active = this.#active;
      if (!active || active.id !== command.turnId)
        return failure("invalidState", "MiMo cancellation does not match the active turn");
      if (!active.cancelling) {
        active.cancelling = true;
        active.cancelTimer = setTimeout(() => {
          void this.#fault(
            new MimoError("unavailable", "MiMo cancellation terminal result timed out"),
          ).catch(() => {});
        }, 20_000);
        this.#requestAbort(active);
      }
      return { ok: true, value: { cancellationRequested: true } };
    }
    if (command.type === "interaction.respond") return this.#respond(command);
    if (command.type === "permissionMode.select") {
      // Native update appends rules and cannot restore native-default. Do not
      // expose a partially reversible live selector as a complete mode switch.
      return failure("unsupported", "MiMo Permission Mode is selected at creation");
    }
    if (command.type === "model.select") {
      if (this.#reading || this.#configuring) return failure("sessionBusy", "MiMo session is busy");
      this.#configuring = true;
      try {
        await validateModel(this.connection.client, command.model);
        if (this.#closed) return failure("invalidState", "MiMo session is closed");
        this.model = structuredClone(command.model);
        this.#state = { ...this.#state, effectiveModel: this.model };
        // Even an unchanged selection acknowledges the Host's state observer.
        this.#emit({ type: "session.state.changed", state: structuredClone(this.#state) });
        return { ok: true, value: { completed: true } };
      } catch (error) {
        return { ok: false, error: errorOf(error) };
      } finally {
        this.#configuring = false;
      }
    }
    return failure("unsupported", "MiMo Thinking selection is not verified");
  }

  async #run(active: ActiveTurn, input: Array<{ type: "text"; text: string }>): Promise<void> {
    try {
      // This native request resolves only when svc.prompt has finished. SSE idle
      // and abort HTTP acknowledgements never unlock the public turn.
      const response = checked(
        await this.connection.client.session.prompt({
          sessionID: this.native.id,
          messageID: active.messageID,
          parts: input,
          ...(this.model ? { model: decodeModel(this.model) } : {}),
        }),
      );
      // An in-flight abort must not arrive after the next prompt is admitted.
      if (active.abortPromise) await active.abortPromise;
      if (this.#closed || this.#active !== active) return;
      if (response.info && response.info.sessionID !== this.native.id)
        throw new MimoError("protocolError", "MiMo prompt returned a foreign session");
      const messages = await readMessages(this.connection.client, this.native.id);
      if (this.#closed || this.#active !== active) return;
      active.persisted = messages.some((message) => message.info.id === active.messageID);
      const native = checked(
        await this.connection.client.session.get({ sessionID: this.native.id }),
      );
      const snapshot = projectHistory(native, messages);
      const status = checked(await this.connection.client.session.status());
      if (status[this.native.id] && status[this.native.id]?.type !== "idle")
        throw new MimoError(
          "protocolError",
          "MiMo prompt returned before its native terminal state",
        );
      const turn = snapshot.turns.find(
        (turn) => turn.nativeTurnRef.nativeTurnKey === active.messageID,
      );
      if (!turn)
        throw new MimoError("protocolError", "MiMo prompt result is missing from native history");
      for (const item of turn.items) this.#publishItem(active, item, true);
      if (snapshot.state) this.#updateState(snapshot.state);
      const outcome =
        turn.outcome.status === "unknown"
          ? {
              status: "failed" as const,
              error: errorOf(new MimoError("protocolError", turn.outcome.reason)),
            }
          : turn.outcome;
      this.#finish(active, outcome);
    } catch (error) {
      if (this.#closed || this.#active !== active) return;
      // A failed HTTP stream may leave native work running. Fault and kill this
      // owned service instead of accepting another turn on an uncertain session.
      await this.#fault(error);
    }
  }

  #requestAbort(active: ActiveTurn): void {
    if (
      !active.cancelling ||
      !active.persisted ||
      !active.nativeBusy ||
      active.abortSent ||
      this.#active !== active
    )
      return;
    active.abortSent = true;
    active.abortPromise = this.connection.client.session
      .abort({ sessionID: this.native.id })
      .then((result) => {
        if (checked(result) !== true)
          throw new MimoError("nativeFailure", "MiMo rejected cancellation");
      });
    void active.abortPromise
      .catch((error) => {
        if (this.#active === active) return this.#fault(error);
      })
      .catch(() => {});
  }

  #event(event: Event): void {
    const active = this.#active;
    if (event.type === "server.instance.disposed")
      throw new MimoError("unavailable", "MiMo instance was disposed");
    if (!active) return;
    if (event.type === "session.status" && event.properties.sessionID === this.native.id) {
      if (event.properties.status.type === "busy" || event.properties.status.type === "retry") {
        active.nativeBusy = true;
        this.#requestAbort(active);
      }
      return;
    }
    if (event.type === "message.updated") {
      const info = event.properties.info;
      if (info.sessionID !== this.native.id || (info.agentID && info.agentID !== "main")) return;
      if (
        info.id !== active.messageID &&
        !(info.role === "assistant" && info.parentID === active.messageID)
      )
        return;
      active.messages.set(info.id, info);
      if (info.id === active.messageID) {
        active.persisted = true;
        this.#requestAbort(active);
      }
      if (info.role === "assistant") {
        this.#updateState({ ...this.#state, effectiveModel: encodeModel(info) });
        for (const part of active.parts.values())
          if (part.messageID === info.id) this.#part(active, part);
      }
      return;
    }
    if (event.type === "message.part.updated") {
      const part = event.properties.part;
      if (part.sessionID !== this.native.id || part.messageID === active.messageID) return;
      // Parts may precede their assistant metadata on SSE. Retain until parent is known.
      active.parts.set(part.id, part);
      this.#part(active, part);
      return;
    }
    if (event.type === "message.part.delta") {
      const delta = event.properties;
      if (delta.sessionID !== this.native.id || delta.field !== "text") return;
      const part = active.parts.get(delta.partID);
      if (
        part &&
        part.messageID === delta.messageID &&
        (part.type === "text" || part.type === "reasoning")
      ) {
        const next = { ...part, text: part.text + delta.delta };
        active.parts.set(part.id, next);
        this.#part(active, next);
      }
      return;
    }
    if (event.type === "permission.asked" || event.type === "question.asked") {
      const request = event.properties;
      if (request.sessionID !== this.native.id) return;
      // Permission may precede message.updated. Session ownership is sufficient
      // while this adapter holds its single-writer reservation; never drop it.
      const owner = request.tool && active.messages.get(request.tool.messageID);
      if (owner?.role === "assistant" && owner.parentID !== active.messageID) return;
      const interactionId = hostInteractionIdSchema.parse(`mimo:${this.native.id}:${request.id}`);
      if (this.#interactions.has(interactionId)) return;
      const interaction: HostInteraction =
        event.type === "permission.asked"
          ? {
              type: "approval",
              interactionId,
              turnId: active.id,
              title: event.properties.permission,
              description: event.properties.patterns.join("\n"),
              subject: { type: "nativeAction" },
              actions: [
                { id: "once", label: "Allow once", effect: "allowOnce" },
                { id: "reject", label: "Deny", effect: "deny" },
              ],
            }
          : {
              type: "question",
              interactionId,
              turnId: active.id,
              questions: event.properties.questions.map((question, index) => ({
                id: String(index),
                type: "choice",
                prompt: question.question,
                options: question.options.map((option) => ({
                  value: option.label,
                  label: option.label,
                  description: option.description,
                })),
                multiple: question.multiple ?? false,
                allowOther: question.custom ?? true,
                optional: false,
              })),
            };
      this.#interactions.set(interactionId, {
        nativeID: request.id,
        interaction,
        responding: false,
      });
      this.#channel.emit({ kind: "interaction", interaction });
      return;
    }
    if (
      event.type === "permission.replied" ||
      event.type === "question.replied" ||
      event.type === "question.rejected"
    ) {
      if (event.properties.sessionID === this.native.id)
        this.#closeInteraction(
          `mimo:${this.native.id}:${event.properties.requestID}`,
          event.type === "question.rejected" ? "cancelled" : "responded",
        );
    }
  }

  #part(active: ActiveTurn, part: Part): void {
    const info = active.messages.get(part.messageID);
    if (info?.role !== "assistant" || info.parentID !== active.messageID) return;
    const complete =
      part.type === "tool"
        ? ["completed", "error"].includes(part.state.status)
        : part.type === "text" || part.type === "reasoning"
          ? part.time?.end !== undefined
          : info.time.completed !== undefined;
    const item = projectPart(part, complete);
    if (item) this.#publishItem(active, item, complete);
  }

  #publishItem(active: ActiveTurn, snapshot: HostItemSnapshot, complete: boolean): void {
    const id = snapshot.item.itemId;
    if (active.completed.has(id)) return;
    const previous = active.items.get(id);
    if (!previous)
      this.#emit({
        type: "item.started",
        turnId: active.id,
        item:
          snapshot.item.type === "agentMessage" || snapshot.item.type === "reasoning"
            ? { ...snapshot.item, text: "" }
            : snapshot.item,
      });
    if (snapshot.item.type === "agentMessage" || snapshot.item.type === "reasoning") {
      const oldText =
        previous && (previous.item.type === "agentMessage" || previous.item.type === "reasoning")
          ? previous.item.text
          : "";
      if (!snapshot.item.text.startsWith(oldText))
        throw new MimoError("protocolError", "MiMo replaced already streamed text");
      const delta = snapshot.item.text.slice(oldText.length);
      if (delta)
        this.#emit({
          type: "item.updated",
          turnId: active.id,
          itemId: id,
          update: { type: "text.append", text: delta },
        });
    }
    active.items.set(id, snapshot);
    if (complete) {
      active.completed.add(id);
      this.#emit({ type: "item.completed", turnId: active.id, snapshot });
    }
  }

  async #respond(command: InteractionRespondCommand): Promise<HarnessResult<unknown>> {
    const pending = this.#interactions.get(command.interactionId);
    const error = validateHostInteractionResponse(pending?.interaction, command.response);
    if (error) return { ok: false, error };
    if (!pending || pending.responding || this.#active?.cancelling)
      return failure("invalidState", "MiMo interaction is no longer accepting responses");
    pending.responding = true;
    try {
      let accepted: boolean | undefined;
      if (command.response.type === "approval")
        accepted = checked(
          await this.connection.client.permission.reply({
            requestID: pending.nativeID,
            reply: command.response.actionId === "once" ? "once" : "reject",
          }),
        );
      else if (command.response.cancelled)
        accepted = checked(
          await this.connection.client.question.reject({ requestID: pending.nativeID }),
        );
      else if (pending.interaction.type === "question") {
        const answers = command.response.answers;
        accepted = checked(
          await this.connection.client.question.reply({
            requestID: pending.nativeID,
            answers: pending.interaction.questions.map((question) => answers[question.id] ?? []),
          }),
        );
      }
      if (accepted !== true)
        throw new MimoError("nativeFailure", "MiMo did not accept the interaction response");
      this.#closeInteraction(
        command.interactionId,
        command.response.type === "question" && command.response.cancelled
          ? "cancelled"
          : "responded",
      );
      return { ok: true, value: { accepted: true } };
    } catch (error) {
      pending.responding = false;
      return { ok: false, error: errorOf(error) };
    }
  }

  #closeInteraction(id: string, reason: "responded" | "cancelled"): void {
    const pending = this.#interactions.get(id);
    if (!pending) return;
    this.#interactions.delete(id);
    this.#emit({
      type: "interaction.closed",
      interactionId: pending.interaction.interactionId,
      turnId: pending.interaction.turnId,
      reason,
    });
  }
  #updateState(state: HarnessSessionState): void {
    // A previous turn's observed model must not overwrite a later selection.
    if (this.model) state = { ...state, effectiveModel: this.model };
    if (JSON.stringify(state) === JSON.stringify(this.#state)) return;
    this.#state = state;
    this.#emit({ type: "session.state.changed", state: structuredClone(state) });
  }
  #emit(event: HostEvent): void {
    this.#channel.emit({ kind: "event", event });
  }
  #finish(active: ActiveTurn, outcome: TurnOutcome): void {
    if (this.#active !== active) return;
    clearTimeout(active.cancelTimer);
    for (const id of this.#interactions.keys()) this.#closeInteraction(id, "cancelled");
    for (const [id, snapshot] of active.items)
      if (!active.completed.has(id))
        this.#emit({
          type: "item.completed",
          turnId: active.id,
          snapshot: {
            item: snapshot.item,
            outcome: outcome.status === "succeeded" ? snapshot.outcome : outcome,
          },
        });
    this.#active = undefined;
    this.#emit({
      type: "turn.completed",
      turnId: active.id,
      ...(active.persisted ? { nativeTurnRef: turnRef(this.native.id, active.messageID) } : {}),
      outcome,
    });
  }
  async #fault(error: unknown): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#active) this.#finish(this.#active, { status: "failed", error: errorOf(error) });
    this.#emit({ type: "session.faulted", error: errorOf(error) });
    this.#channel.end();
    this.#streamAbort.abort();
    await this.close();
  }
  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    this.#streamAbort.abort();
    this.#closePromise = (async () => {
      try {
        await this.connection.close();
        this.onClose?.();
      } catch {
        const error = new MimoError(
          "unavailable",
          "MiMo service cleanup failed; an owned process may still be running",
        );
        if (this.#active) this.#finish(this.#active, { status: "failed", error: errorOf(error) });
        throw error;
      } finally {
        if (this.#active)
          this.#finish(this.#active, { status: "cancelled", reason: "MiMo session closed" });
        this.#channel.end();
      }
    })().catch((error) => {
      this.#closePromise = undefined;
      throw error;
    });
    return this.#closePromise;
  }
}
