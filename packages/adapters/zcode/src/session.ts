import { randomUUID } from "node:crypto";
import {
  HarnessOutputChannel,
  parseHostUsage,
  type HarnessCommandInvocation,
  type HarnessOutput,
  type HarnessResult,
  type HarnessSession,
  type HarnessSessionState,
  type HostCommand,
  type HostEvent,
  type HostThreadSnapshot,
  type HostUsage,
  type TurnOutcome,
  type HostItemOutcome,
  type TurnStartCommand,
  type TurnCancelCommand,
  type InteractionRespondCommand,
  type ModelSelectCommand,
  type ThinkingSelectCommand,
  type PermissionModeSelectCommand,
  type TurnStartAccepted,
  type TurnCancelAccepted,
  type InteractionRespondAccepted,
  type ModelSelectCompleted,
  type ThinkingSelectCompleted,
  type PermissionModeSelectCompleted,
} from "@codexhost/harness-adapter";
import { hostTurnIdSchema, hostItemIdSchema, type HostTurnId } from "@codexhost/shared-contracts";
import type { ZcodeConnection } from "./connection.js";
import { type RpcMessage } from "./transport.js";
import {
  eventSchema,
  snapshotSchema,
  record,
  text,
  type NativeEvent,
  type NativeSnapshot,
} from "./protocol.js";
import {
  ZCODE_ID,
  contextUsage,
  selectNativeModel,
  sessionState,
  modelCatalog,
  permissionModes,
} from "./models.js";
import { failure, nativeError, ZcodeError } from "./errors.js";
import { TurnProjection } from "./projection.js";
import { nativeTurnRef, eventOutcome } from "./history.js";
import { makeInteraction, type PendingInteraction } from "./interactions.js";
import { COMMAND_CATALOG, goalArguments } from "./commands.js";
import { readHistory } from "./read-history.js";
import { capabilitiesForConnection } from "./capabilities.js";

interface ActiveTurn {
  id: HostTurnId;
  accepted: boolean;
  nativeId?: string | undefined;
  messageId?: string | undefined;
  pending: RpcMessage[];
  projection: TurnProjection;
  terminal?: NativeEvent;
  finishing: boolean;
  timer?: ReturnType<typeof setTimeout>;
}
export function handleRuntimeRequest(transport: ZcodeConnection, message: RpcMessage): boolean {
  if (message.id === undefined || message.method !== "session/requestRuntimePreferences")
    return false;
  transport.respond(message.id, {
    nativeSearchEnhancementsEnabled: true,
    memoryEnabled: false,
    askUserQuestionAutoResolutionEnabled: false,
  });
  return true;
}
export class ZcodeSession implements HarnessSession {
  readonly harnessId = ZCODE_ID;
  readonly capabilities;
  readonly initialState: HarnessSessionState;
  readonly initialUsage: HostUsage | null;
  readonly #channel = new HarnessOutputChannel<HarnessOutput>();
  readonly outputs = this.#channel.outputs;
  readonly commands = {
    list: async () => ({ ok: true as const, value: COMMAND_CATALOG }),
    execute: (command: HarnessCommandInvocation) => this.#command(command),
  };
  #state: HarnessSessionState;
  #snapshot: NativeSnapshot;
  #active: ActiveTurn | undefined;
  #pendingInteractions = new Map<string, PendingInteraction>();
  #closed = false;
  #faulted = false;
  #configuring = false;
  #goalActive = false;
  #lastSeq = 0;
  #closePromise: Promise<void> | undefined;
  #terminalTask: Promise<void> | undefined;
  readonly catalog: ReturnType<typeof modelCatalog>;
  constructor(
    readonly transport: ZcodeConnection,
    snapshot: NativeSnapshot,
    readonly onClose: () => void,
    readonly nativeCatalog = snapshot.settings,
    readonly isLocked = () => false,
    readonly processRegistry = false,
  ) {
    this.capabilities = capabilitiesForConnection(transport);
    this.catalog = modelCatalog(
      nativeCatalog,
      transport.locator?.backend === "desktop" ? "desktop" : "stdio",
    );
    this.#snapshot = snapshot;
    this.#goalActive =
      (snapshot.target === undefined ? snapshot.projection.target : snapshot.target)?.status ===
      "active";
    this.#state = sessionState(snapshot, transport.locator);
    this.initialState = structuredClone(this.#state);
    this.initialUsage = contextUsage(snapshot);
    this.#lastSeq = typeof snapshot.runtime.eventSeq === "number" ? snapshot.runtime.eventSeq : 0;
    transport.onMessage = (message) => {
      try {
        this.#message(message);
      } catch (error) {
        this.#fault(error);
      }
    };
    transport.onFault = (error) => this.#fault(error);
  }
  get sessionId() {
    return this.#snapshot.session.sessionId;
  }
  get busy() {
    return Boolean(this.#active || this.#configuring || this.isLocked());
  }
  #emit(event: HostEvent) {
    this.#channel.emit({ kind: "event", event });
  }
  async subscribe() {
    await this.transport.request("session/subscribe", {
      sessionId: this.sessionId,
      deliveryKind: "desktop-continuous",
    });
  }
  async #readNative() {
    return snapshotSchema.parse(
      await this.transport.request("session/read", { sessionId: this.sessionId }),
    );
  }
  #apply(snapshot: NativeSnapshot) {
    if (snapshot.session.sessionId !== this.sessionId)
      throw new ZcodeError("protocolError", "ZCode changed the native session identity");
    this.#snapshot = snapshot;
    this.#goalActive =
      (snapshot.target === undefined ? snapshot.projection.target : snapshot.target)?.status ===
      "active";
    this.#state = sessionState(snapshot, this.transport.locator);
    this.#emit({ type: "session.state.changed", state: structuredClone(this.#state) });
  }
  async refreshUsage() {
    if (this.#closed || this.#faulted) return;
    try {
      const snapshot = await this.#readNative();
      const usage = record(
        await this.transport.request("session/usage", { sessionId: this.sessionId }),
      );
      const fields: HostUsage = { ...(contextUsage(snapshot) ?? {}) };
      for (const [source, target] of [
        ["inputTokens", "inputTokens"],
        ["outputTokens", "outputTokens"],
        ["totalTokens", "totalTokens"],
        ["reasoningTokens", "reasoningOutputTokens"],
        ["cacheReadTokens", "cachedInputTokens"],
        ["cacheCreationTokens", "cacheWriteInputTokens"],
      ] as const)
        if (typeof usage[source] === "number") fields[target] = usage[source];
      this.#emit({
        type: "session.usage.changed",
        usage: parseHostUsage(fields),
        ...(this.#active ? { observedForTurnId: this.#active.id } : {}),
      });
    } catch {
      /* Usage is optional; the transport separately reports fatal failures. */
    }
  }
  async readSnapshot(): Promise<HarnessResult<HostThreadSnapshot>> {
    if (this.#closed || this.#faulted) return failure("invalidState", "ZCode session is closed");
    if (this.busy) return failure("sessionBusy", "ZCode is executing an operation", true);
    try {
      const snapshot = await this.#readNative();
      const events = record(
        await this.transport.request("session/events", { sessionId: this.sessionId }),
      );
      const parsed = Array.isArray(events.events)
        ? events.events.map((event) => eventSchema.parse(event))
        : [];
      this.#apply(snapshot);
      return { ok: true, value: await readHistory(this.transport, snapshot, parsed) };
    } catch (error) {
      return { ok: false, error: nativeError(error) };
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
    if (this.#closed || this.#faulted) return failure("invalidState", "ZCode session is closed");
    try {
      if (command.type === "turn.start") {
        if (
          !hostTurnIdSchema.safeParse(command.turnId).success ||
          !command.input.length ||
          command.input.some((item) => item.type !== "text") ||
          !command.input.some((item) => item.text.trim())
        )
          return failure("invalidRequest", "ZCode requires nonempty text and a turn ID");
        const content = command.input.map((item) => item.text).join("\n\n");
        const nativeCommand = /^\/(compact|goal)(?:\s+([\s\S]*))?$/u.exec(content.trim());
        if (nativeCommand?.[1])
          return this.#command({
            commandId: nativeCommand[1],
            turnId: command.turnId,
            arguments: { text: nativeCommand[2] ?? "" },
          });
        return await this.#start(command.turnId, "session/send", {
          content,
          inputId: command.turnId,
        });
      }
      if (command.type === "turn.cancel") {
        if (this.#active?.id !== command.turnId)
          return failure("invalidRequest", "The requested ZCode turn is not active");
        await this.transport.request("session/stop", { sessionId: this.sessionId });
        return { ok: true, value: { cancellationRequested: true } };
      }
      if (command.type === "interaction.respond") {
        const pending = this.#pendingInteractions.get(command.interactionId);
        if (!pending || pending.interaction.turnId !== this.#active?.id)
          return failure("invalidRequest", "ZCode interaction is no longer pending");
        const value = pending.response(command.response);
        for (const id of pending.requestIds) await this.transport.respond(id, value);
        this.#closeInteraction(command.interactionId, "responded");
        return { ok: true, value: { accepted: true } };
      }
      if (this.#configuring || this.isLocked())
        return failure("sessionBusy", "ZCode configuration is already changing", true);
      this.#configuring = true;
      try {
        let method: string, params: Record<string, unknown>;
        if (command.type === "model.select") {
          if (!this.catalog.models.some((model) => model.ref.id === command.model.id))
            return failure("invalidRequest", "ZCode model is not available");
          method = "session/setModel";
          params = {
            model: selectNativeModel(
              command.model,
              {
                ...this.#snapshot.settings,
                model: {
                  ...this.#snapshot.settings.model,
                  available: this.nativeCatalog.model.available,
                },
              },
              this.processRegistry,
            ),
            persistAsWorkspaceLastUsed: false,
          };
        } else if (command.type === "thinking.select") {
          if (
            !this.#snapshot.settings.thoughtLevel.available.some(
              (option) => option.value === command.thinkingOptionId,
            )
          )
            return failure("invalidRequest", "ZCode thinking option is not available");
          method = "session/setThoughtLevel";
          params = { thoughtLevel: command.thinkingOptionId, persistAsWorkspaceLastUsed: false };
        } else {
          if (!permissionModes().modes.some((mode) => mode.id === command.permissionModeId))
            return failure("invalidRequest", "Unknown ZCode permission mode");
          method = "session/setMode";
          params = { mode: command.permissionModeId };
        }
        const snapshot = snapshotSchema.parse(
          await this.transport.request(method, { sessionId: this.sessionId, ...params }),
        );
        this.#apply(snapshot);
        if (
          (command.type === "thinking.select" &&
            this.#state.effectiveThinkingOptionId !== command.thinkingOptionId) ||
          (command.type === "model.select" &&
            this.#state.effectiveModel?.id !== command.model.id) ||
          (command.type === "permissionMode.select" &&
            this.#state.effectivePermissionModeId !== command.permissionModeId)
        )
          return failure("nativeFailure", "ZCode did not apply the requested configuration");
        return { ok: true, value: { completed: true } };
      } finally {
        this.#configuring = false;
      }
    } catch (error) {
      return { ok: false, error: nativeError(error) };
    }
  }
  async #command(command: HarnessCommandInvocation): Promise<HarnessResult<TurnStartAccepted>> {
    if (this.#closed || this.#faulted) return failure("invalidState", "ZCode session is closed");
    if (
      !hostTurnIdSchema.safeParse(command.turnId).success ||
      !COMMAND_CATALOG.commands.some((entry) => entry.id === command.commandId)
    )
      return failure("invalidRequest", "Unknown ZCode command or invalid turn ID");
    if (
      command.arguments &&
      (Object.keys(command.arguments).some((key) => key !== "text") ||
        (command.arguments.text !== undefined && typeof command.arguments.text !== "string"))
    )
      return failure("invalidRequest", "ZCode command arguments must contain only text");
    try {
      const argument = text(command.arguments?.text);
      return await this.#start(
        command.turnId,
        command.commandId === "compact" ? "session/compact" : "session/goal",
        command.commandId === "compact"
          ? { inputId: command.turnId, ...(argument ? { instructions: argument } : {}) }
          : { inputId: command.turnId, ...goalArguments(argument) },
      );
    } catch (error) {
      return { ok: false, error: nativeError(error) };
    }
  }
  async #start(
    id: HostTurnId,
    method: string,
    params: Record<string, unknown>,
  ): Promise<HarnessResult<TurnStartAccepted>> {
    if (this.busy) return failure("sessionBusy", "ZCode already has an active operation", true);
    const previousGoalActive = this.#goalActive;
    if (method === "session/goal" && ["set", "replace", "resume"].includes(text(params.action)))
      this.#goalActive = true;
    const active: ActiveTurn = {
      id,
      accepted: false,
      pending: [],
      finishing: false,
      projection: new TurnProjection(id, this.transport.options.cwd, (event) => this.#emit(event)),
    };
    this.#active = active;
    let result: Record<string, unknown>;
    try {
      result = record(
        await this.transport.request(method, { sessionId: this.sessionId, ...params }),
      );
    } catch (error) {
      if (this.#active === active) this.#active = undefined;
      this.#goalActive = previousGoalActive;
      throw error;
    }
    if (this.#closed || this.#faulted)
      return failure("invalidState", "ZCode closed before confirming the turn");
    active.accepted = true;
    this.#emit({ type: "turn.started", turnId: id });
    for (const message of active.pending.splice(0)) this.#message(message);
    if (method === "session/goal" && result.startedTurn !== true) {
      const response = text(result.response);
      if (response)
        active.projection.complete({
          item: {
            type: "agentMessage",
            itemId: hostItemIdSchema.parse(`command:${id}`),
            text: response,
          },
          outcome: { status: "succeeded" },
        });
      if (result.snapshot) this.#apply(snapshotSchema.parse(result.snapshot));
      this.#finish(active, { status: "succeeded" });
    }
    return { ok: true, value: { turnId: id } };
  }
  #message(message: RpcMessage) {
    if (this.#closed || this.#faulted) return;
    if (handleRuntimeRequest(this.transport, message)) return;
    const p = record(message.params);
    if (message.id !== undefined) {
      if (!this.#active || p.sessionId !== this.sessionId) {
        this.transport.reject(message.id);
        return;
      }
      if (!this.#active.accepted) {
        this.#active.pending.push(message);
        return;
      }
      if (
        !["interaction/requestPermission", "interaction/requestUserInput"].includes(message.method)
      ) {
        this.transport.reject(message.id);
        return;
      }
      const pending = makeInteraction(message.method, p, this.#active.id, message.id);
      const old = this.#pendingInteractions.get(pending.interaction.interactionId);
      if (old) {
        old.requestIds.add(message.id);
        return;
      }
      this.#pendingInteractions.set(pending.interaction.interactionId, pending);
      this.#channel.emit({ kind: "interaction", interaction: pending.interaction });
      return;
    }
    if (p.sessionId !== this.sessionId) return;
    if (this.#active && !this.#active.accepted) {
      this.#active.pending.push(message);
      return;
    }
    if (message.method === "state.updated") {
      if (
        [
          "prompt_completed",
          "prompt_failed",
          "session_compacted",
          "session_compact_failed",
          "session_compact_cancelled",
          "goal_continuation_completed",
          "goal_continuation_failed",
        ].includes(text(p.reason)) &&
        this.#active
      )
        this.#settle(this.#active, text(p.reason));
      return;
    }
    if (message.method !== "session/event") return;
    const event = eventSchema.parse(p);
    if (event.seq <= this.#lastSeq) return;
    this.#lastSeq = event.seq;
    if (event.type === "session.updated" && event.payload && Object.hasOwn(event.payload, "target"))
      this.#goalActive = record(event.payload.target).status === "active";
    if (event.type === "turn.started") {
      if (this.#active?.terminal && this.#active.nativeId !== event.turnId)
        this.#finish(this.#active, eventOutcome(this.#active.terminal) as TurnOutcome);
      if (!this.#active) {
        const id = hostTurnIdSchema.parse(`zcode-autonomous-${randomUUID()}`);
        this.#active = {
          id,
          accepted: true,
          pending: [],
          finishing: false,
          projection: new TurnProjection(id, this.transport.options.cwd, (event) =>
            this.#emit(event),
          ),
        };
        this.#emit({
          type: "turn.autonomous.started",
          turnId: id,
          input: text(event.payload?.input)
            ? [{ type: "text", text: text(event.payload?.input) }]
            : [],
        });
      }
      this.#active.nativeId = event.turnId;
      this.#active.messageId = text(event.payload?.messageId) || undefined;
      return;
    }
    if (event.type === "session.updated" && typeof event.payload?.childSessionId === "string") {
      const p = event.payload,
        status =
          p.status === "running" || p.status === "waiting" || p.status === "blocked"
            ? "running"
            : p.status === "cancelled"
              ? "interrupted"
              : p.status === "failed" || p.status === "lost"
                ? "failed"
                : "completed";
      this.#emit({
        type: "subagent.state.changed",
        nativeSubagentId: p.childSessionId as string,
        status,
      });
      this.#emit({
        type: "subagent.transcript.changed",
        nativeSubagentId: p.childSessionId as string,
      });
    }
    const active = this.#active;
    if (!active || (event.turnId && active.nativeId && event.turnId !== active.nativeId)) return;
    if (event.type === "permission.resolved" || event.type === "userInput.resolved") {
      const id = `zcode:${text(event.payload?.requestId)}`;
      this.#closeInteraction(id, "superseded");
    }
    if (event.type === "turn.completed" || event.type === "turn.failed") {
      active.terminal = event;
      if (!this.#goalActive)
        active.timer = setTimeout(
          () =>
            this.#fault(
              new ZcodeError("unavailable", "ZCode did not confirm that the turn stopped"),
            ),
          this.transport.options.timeoutMs ?? 30_000,
        );
    } else if (!active.terminal) active.projection.event(event);
  }
  #settle(active: ActiveTurn, reason: string) {
    if (active.finishing) return;
    active.finishing = true;
    this.#terminalTask = (async () => {
      const snapshot = await this.#readNative();
      if (this.#active !== active || this.#closed || this.#faulted) return;
      const turns = (
        await readHistory(this.transport, snapshot, active.terminal ? [active.terminal] : [])
      ).turns;
      const turn = turns.find((turn) => turn.nativeTurnRef.nativeTurnKey === active.messageId);
      if (turn) active.projection.reconcile(turn.items);
      this.#apply(snapshot);
      const outcome = active.terminal
        ? eventOutcome(active.terminal)
        : reason === "session_compacted"
          ? { status: "succeeded" as const }
          : reason === "session_compact_cancelled"
            ? { status: "cancelled" as const }
            : reason.endsWith("failed")
              ? {
                  status: "failed" as const,
                  error: {
                    code: "nativeFailure" as const,
                    message: "ZCode operation failed",
                    retryable: false,
                  },
                }
              : turn?.outcome;
      if (!outcome || outcome.status === "unknown")
        throw new ZcodeError("protocolError", "ZCode completed without a confirmed turn outcome");
      this.#finish(active, {
        ...outcome,
        ...(turn?.checkpoint ? { checkpoint: turn.checkpoint } : {}),
      });
      await this.refreshUsage();
    })().catch((error) => this.#fault(error));
  }
  #closeInteraction(id: string, reason: "responded" | "cancelled" | "superseded") {
    const pending = this.#pendingInteractions.get(id);
    if (!pending) return;
    this.#pendingInteractions.delete(id);
    this.#emit({
      type: "interaction.closed",
      interactionId: pending.interaction.interactionId,
      turnId: pending.interaction.turnId,
      reason,
    });
  }
  #finish(active: ActiveTurn, outcome: TurnOutcome) {
    if (this.#active !== active) return;
    clearTimeout(active.timer);
    for (const [id, pending] of this.#pendingInteractions) {
      for (const rpcId of pending.requestIds)
        void Promise.resolve(
          this.transport.respond(
            rpcId,
            pending.interaction.type === "approval" ? { decision: "deny" } : { action: "cancel" },
          ),
        ).catch(() => {});
      this.#closeInteraction(id, "cancelled");
    }
    active.projection.finish(
      outcome.status === "succeeded" ? { status: "succeeded" } : (outcome as HostItemOutcome),
    );
    this.#active = undefined;
    this.#emit({
      type: "turn.completed",
      turnId: active.id,
      ...(active.messageId
        ? { nativeTurnRef: nativeTurnRef(this.sessionId, active.messageId) }
        : {}),
      outcome,
    });
  }
  #fault(error: unknown) {
    if (this.#closed || this.#faulted) return;
    this.#faulted = true;
    const normalized = nativeError(error);
    if (this.#active?.accepted) this.#finish(this.#active, { status: "failed", error: normalized });
    this.#emit({ type: "session.faulted", error: normalized });
    this.#channel.end();
    void this.transport.close();
  }
  close(): Promise<void> {
    return (this.#closePromise ??= this.#close());
  }
  async #close() {
    if (this.#closed) return;
    if (this.#active?.accepted) {
      try {
        await this.transport.request("session/stop", { sessionId: this.sessionId });
      } catch {
        /* Closing still owns process cleanup. */
      }
    }
    this.#closed = true;
    if (!this.#faulted) {
      try {
        await this.transport.request("session/close", { sessionId: this.sessionId });
      } catch {
        /* Transport cleanup remains authoritative. */
      }
    }
    await this.transport.close();
    if (this.#active?.accepted)
      this.#finish(this.#active, { status: "cancelled", reason: "Session closed" });
    await this.#terminalTask;
    this.#channel.end();
    this.onClose();
  }
}
