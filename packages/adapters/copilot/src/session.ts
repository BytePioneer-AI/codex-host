import { randomUUID } from "node:crypto";
import type { CopilotClient, CopilotSession, SessionEvent } from "@github/copilot-sdk";
import {
  HarnessOutputChannel,
  unsupportedSteer,
  type HarnessSession,
  type HarnessOutput,
  type HarnessResult,
  type HarnessSessionState,
  type HostCommand,
  type HostEvent,
  type TurnOutcome,
  type CreateSessionInput,
  type ResumeSessionInput,
} from "@codexhost/harness-adapter";
import {
  hostTurnIdSchema,
  type HostTurnId,
  type HarnessSessionCapabilities,
} from "@codexhost/shared-contracts";
import { createCopilotClient } from "./client.js";
import {
  confirmedConfiguration,
  modelId,
  readModels,
  requireModel,
  selectThinking,
} from "./configuration.js";
import { bounded, failure, nativeError, sessionError, CopilotOperationError } from "./errors.js";
import { CopilotInteractions } from "./interactions.js";
import { CopilotItems, projectHistory, toolEventCallId } from "./projection.js";
import {
  copilotId,
  sessionIdFromRef,
  sessionRef,
  sessionIsUnattended,
  turnRef,
  checkpoint,
} from "./refs.js";
import type {
  TurnStartCommand,
  TurnSteerCommand,
  TurnSteerAccepted,
  TurnCancelCommand,
  InteractionRespondCommand,
  ModelSelectCommand,
  ThinkingSelectCommand,
  PermissionModeSelectCommand,
  TurnStartAccepted,
  TurnCancelAccepted,
  InteractionRespondAccepted,
  ModelSelectCompleted,
} from "@codexhost/harness-adapter";
import type { HostUsage } from "@codexhost/harness-adapter";
import { usageFromMetrics } from "./usage.js";
import { CopilotUsageTelemetry } from "./usage-telemetry.js";
import { isRootMessage, visibleInput, hiddenInput } from "./history.js";
import { CopilotBackground } from "./background.js";

export const copilotCapabilities: HarnessSessionCapabilities = {
  configuration: {
    selectModel: true,
    selectThinkingOption: true,
    selectPermissionMode: true,
    permissionModeScope: "live",
  },
  history: { fork: true, forkAcrossCwd: false, rollbackLastTurn: true },
  autonomousTurns: { observe: true },
};

interface ActiveTurn {
  id: HostTurnId;
  items: CopilotItems;
  messageId?: string;
  expectedMessageId?: string;
  error?: ReturnType<typeof nativeError>;
  cancelling: boolean;
  accepted: boolean;
  identity: PromiseWithResolvers<undefined>;
  aliases: Set<string>;
  timer?: ReturnType<typeof setTimeout>;
}

export class CopilotHarnessSession implements HarnessSession {
  readonly harnessId = copilotId;
  readonly capabilities = copilotCapabilities;
  readonly initialUsage = null;
  readonly initialState: HarnessSessionState;
  readonly nativeWriterRef;
  readonly channel = new HarnessOutputChannel<HarnessOutput>();
  readonly outputs = this.channel.outputs;
  readonly nativeId: string;
  private readonly interactions = new CopilotInteractions((output) => this.channel.emit(output));
  private client: CopilotClient | undefined;
  private session: CopilotSession | undefined;
  private initializing: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private closed = false;
  private faulted = false;
  private durable: boolean;
  private busy = false;
  private active: ActiveTurn | undefined;
  private state: HarnessSessionState;
  private monitor: ReturnType<typeof setInterval> | undefined;
  private probing = false;
  private sending: SessionEvent[] | undefined;
  private sendingBytes = 0;
  private usage: HostUsage | null = null;
  private readonly usageTelemetry = new CopilotUsageTelemetry();
  private readonly background = new CopilotBackground();
  private compacting = false;
  private readonly unattended: boolean;
  private draftCleanupNeeded = false;
  private configurationRevision = 0;
  private readonly retiredItems = new Set<string>();
  private readonly retiredMessages = new Set<string>();

  constructor(
    private readonly input: CreateSessionInput | ResumeSessionInput,
    private readonly environment: NodeJS.ProcessEnv,
    private readonly onClosed: () => void = () => {},
  ) {
    this.nativeId = input.kind === "resume" ? sessionIdFromRef(input.nativeRef) : randomUUID();
    this.unattended =
      input.kind === "create"
        ? input.executionPolicy === "unattended-full-access"
        : sessionIsUnattended(input.nativeRef);
    this.nativeWriterRef = sessionRef(this.nativeId, this.unattended);
    this.durable = input.kind === "resume";
    this.state = this.durable ? { nativeRef: this.nativeWriterRef } : {};
    this.initialState = this.state;
  }

  private emit(event: HostEvent): void {
    this.channel.emit({ kind: "event", event });
  }
  private publish(state: HarnessSessionState): void {
    this.state = { ...state, ...(this.durable ? { nativeRef: this.nativeWriterRef } : {}) };
    this.emit({ type: "session.state.changed", state: this.state });
  }

  async initialize(): Promise<void> {
    if (this.closed || this.faulted) throw new Error("Copilot session is closed");
    if (this.session) return;
    return (this.initializing ??= this.initializeNative().finally(() => {
      this.initializing = undefined;
    }));
  }

  private async initializeNative(): Promise<void> {
    const client = createCopilotClient({
      cwd: this.input.cwd,
      environment: this.environment,
      ...(this.input.environment ? { sessionEnvironment: this.input.environment } : {}),
    });
    this.client = client;
    try {
      await bounded(client.start());
      if (this.input.kind === "create" && this.input.model)
        requireModel(await readModels(client), modelId(this.input.model));
      if (this.input.kind === "resume") {
        if (
          (
            await bounded(client.rpc.sessions.checkInUse({ sessionIds: [this.nativeId] }))
          ).inUse.includes(this.nativeId)
        )
          throw new CopilotOperationError(
            "sessionBusy",
            "Copilot session is owned by another native process.",
          );
      }
      const handlers = {
        workingDirectory: this.input.cwd,
        enableConfigDiscovery: true,
        streaming: true,
        onEvent: (event: SessionEvent) => this.receive(event),
        onPermissionRequest: (request: Parameters<CopilotInteractions["permission"]>[1]) => {
          if (!this.active || this.closed || this.active.cancelling)
            return Promise.resolve({ kind: "user-not-available" as const });
          const active = this.active;
          return active.identity.promise.then(() => {
            if (this.active !== active || this.closed || active.cancelling)
              return { kind: "user-not-available" as const };
            return this.interactions.permission(active.id, request);
          });
        },
        onUserInputRequest: (request: Parameters<CopilotInteractions["question"]>[1]) => {
          if (!this.active || this.closed || this.active.cancelling)
            return Promise.reject(new Error("Copilot has no active question context"));
          const active = this.active;
          return active.identity.promise.then(() => {
            if (this.active !== active || this.closed || active.cancelling)
              throw new Error("Copilot question context ended");
            return this.interactions.question(active.id, request);
          });
        },
        onElicitationRequest: async (
          request: Parameters<CopilotInteractions["elicitation"]>[1],
        ) => {
          const active = this.active;
          if (!active || this.closed || active.cancelling) return { action: "cancel" as const };
          await active.identity.promise;
          if (this.active !== active || this.closed || active.cancelling)
            return { action: "cancel" as const };
          try {
            return await this.interactions.elicitation(active.id, request);
          } catch (error) {
            this.fault(error, "interaction");
            return { action: "cancel" as const };
          }
        },
        ...(this.unattended ? { sandboxConfig: { enabled: false } } : {}),
      };
      if (this.closed) throw new Error("Copilot session closed during initialization");
      if (this.input.kind === "create") this.draftCleanupNeeded = true;
      const session =
        this.input.kind === "resume"
          ? await bounded(
              client.resumeSession(this.nativeId, { ...handlers, allowTranscriptRecovery: false }),
            )
          : await bounded(
              client.createSession({
                ...handlers,
                sessionId: this.nativeId,
                ...(this.input.model ? { model: modelId(this.input.model) } : {}),
              }),
            );
      this.session = session;
      if (this.input.kind === "resume" && session.transcriptRecovery)
        throw new CopilotOperationError(
          "protocolError",
          "Copilot proposed transcript recovery during strict resume.",
        );
      if (this.closed) throw new Error("Copilot session closed during initialization");
      if (session.sessionId !== this.nativeId)
        throw new CopilotOperationError("protocolError", "Copilot changed the native identity.");
      if ((await session.rpc.mode.get()) !== "interactive")
        throw new CopilotOperationError(
          "unsupported",
          "Copilot currently accepts interactive sessions only.",
        );
      if (this.unattended) {
        if (this.input.kind === "create") await this.selectPermission("allow-all");
        const [permission, sandbox] = await Promise.all([
          session.rpc.permissions.getMode(),
          session.rpc.sandbox.getEnforcementStatus(),
        ]);
        if (
          (this.input.kind === "create" && permission.mode !== "allow-all") ||
          sandbox.required ||
          sandbox.blocked
        )
          throw new Error("Copilot could not confirm unattended execution");
      }
      if (this.input.kind === "create" && this.input.permissionModeId) {
        await this.selectPermission(this.input.permissionModeId);
      }
      if (this.input.kind === "create" && (this.input.model || this.input.thinkingOptionId)) {
        const current = await bounded(session.rpc.model.getCurrent());
        const requestedModel = this.input.model ? modelId(this.input.model) : current.modelId;
        if (!requestedModel)
          throw new CopilotOperationError("invalidState", "Copilot has not confirmed a Model.");
        const models = await readModels(client, session);
        requireModel(models, requestedModel);
        if (current.modelId !== requestedModel) await bounded(session.setModel(requestedModel));
        if (this.input.thinkingOptionId)
          await selectThinking(session, models, requestedModel, this.input.thinkingOptionId);
      }
      const confirmed = await this.refreshConfiguration();
      if (
        this.input.kind === "create" &&
        ((this.input.model && confirmed.effectiveModel?.id !== this.input.model.id) ||
          (this.input.thinkingOptionId &&
            confirmed.effectiveThinkingOptionId !== this.input.thinkingOptionId))
      )
        throw new CopilotOperationError(
          "nativeFailure",
          "Copilot did not confirm the requested initial configuration.",
        );
      await this.refreshUsage();
      await this.background.refresh(session);
      if (this.closed) throw new Error("Copilot session closed during initialization");
      this.monitor = setInterval(() => {
        if (this.probing || this.closed || this.faulted) return;
        this.probing = true;
        void bounded(client.ping(), 5_000)
          .catch((error) => this.fault(error))
          .finally(() => {
            this.probing = false;
          });
      }, 5_000);
      this.monitor.unref();
    } catch (error) {
      let cleanupError: unknown;
      if (this.input.kind === "create" && !this.durable) {
        try {
          await bounded(client.deleteSession(this.nativeId), 5_000);
          this.draftCleanupNeeded = false;
        } catch (failure) {
          cleanupError = failure;
        }
        this.session = undefined;
      }
      try {
        await bounded(client.forceStop(), 5_000);
      } catch (failure) {
        cleanupError ??= failure;
      }
      this.fault(error, `session.${this.input.kind}`);
      if (cleanupError) {
        const original = nativeError(error, `session.${this.input.kind}`);
        throw new CopilotOperationError(
          original.code,
          original.message,
          [original.diagnostic, "Copilot draft cleanup also failed; close can be retried."]
            .filter(Boolean)
            .join("; "),
          original.retryable,
          original.stage,
        );
      }
      throw error;
    }
  }

  private startTurn(id: HostTurnId): ActiveTurn {
    this.usageTelemetry.begin(id);
    const identity = Promise.withResolvers<undefined>();
    void identity.promise.catch(() => {});
    return {
      id,
      items: new CopilotItems(id, (event) => this.emit(event)),
      cancelling: false,
      accepted: false,
      identity,
      aliases: new Set(),
    };
  }

  private receive(event: SessionEvent): void {
    if (this.closed || this.faulted) {
      if (event.type === "user.message" && !event.agentId) {
        this.durable = true;
        this.draftCleanupNeeded = false;
      }
      return;
    }
    try {
      if (this.sending) {
        this.sendingBytes += JSON.stringify(event).length;
        if (this.sending.length >= 2048 || this.sendingBytes > 4 * 1024 * 1024)
          throw new Error("Copilot early event buffer exceeded its limit");
        this.sending.push(event);
        return;
      }
      if (
        event.type === "session.background_tasks_changed" ||
        event.type === "subagent.started" ||
        event.type === "subagent.completed" ||
        event.type === "subagent.failed"
      ) {
        this.background.invalidate();
        if (this.session)
          void this.background.refresh(this.session).catch((error) => this.fault(error));
      }
      if (event.agentId) return;
      if (event.type === "session.compaction_start") this.compacting = true;
      if (event.type === "session.compaction_complete") this.compacting = false;
      if (
        this.session &&
        (event.type === "session.model_change" ||
          event.type === "session.model_deselected" ||
          event.type === "session.permissions_changed")
      )
        void this.refreshConfiguration().catch((error) => this.fault(error));
      if (event.type === "session.mode_changed" && event.data.newMode !== "interactive")
        throw new CopilotOperationError(
          "unsupported",
          "Copilot changed to an unsupported session mode.",
        );
      if (
        (event.type === "assistant.message" || event.type === "assistant.message_delta") &&
        this.retiredItems.has(event.data.messageId)
      )
        return;
      if (
        (event.type === "assistant.reasoning" || event.type === "assistant.reasoning_delta") &&
        this.retiredItems.has(event.data.reasoningId)
      )
        return;
      const toolCallId = toolEventCallId(event);
      if (toolCallId !== undefined && this.retiredItems.has(toolCallId)) return;
      if (event.type === "user.message") {
        if (!isRootMessage(event)) {
          if (this.active && event.data.messageId && hiddenInput(event)) {
            if (this.active.aliases.size >= 2048)
              throw new Error("Copilot injected-message limit exceeded");
            this.active.aliases.add(event.data.messageId);
          } else if (!hiddenInput(event))
            throw new CopilotOperationError(
              "unsupported",
              "Native steering input is not supported; cancel the current Turn before sending.",
            );
          return;
        }
        if (!event.data.messageId) throw new Error("Copilot omitted the logical message identity");
        if (this.retiredMessages.has(event.data.messageId)) return;
        if (!this.active) {
          const id = hostTurnIdSchema.parse(randomUUID());
          this.active = this.startTurn(id);
          this.active.accepted = true;
          this.active.identity.resolve(undefined);
          this.emit({
            type: "turn.autonomous.started",
            turnId: id,
            input: visibleInput(event),
          });
        }
        if (this.active.messageId && this.active.messageId !== event.data.messageId)
          throw new Error("Concurrent Copilot root messages are not supported");
        if (this.active.expectedMessageId && this.active.expectedMessageId !== event.data.messageId)
          throw new Error("Copilot send identity mismatch");
        if (!this.active.accepted) {
          this.active.accepted = true;
          this.emit({ type: "turn.started", turnId: this.active.id });
          this.active.identity.resolve(undefined);
        }
        this.active.messageId = event.data.messageId;
        this.durable = true;
        this.draftCleanupNeeded = false;
        this.publish(this.state);
      }
      if (
        event.type === "assistant.message" &&
        event.data.originatingMessageId &&
        this.active?.messageId &&
        event.data.originatingMessageId !== this.active.messageId &&
        !this.active.aliases.has(event.data.originatingMessageId)
      )
        return;
      if (
        !this.active &&
        [
          "assistant.message",
          "assistant.message_delta",
          "assistant.reasoning",
          "assistant.reasoning_delta",
          "tool.execution_start",
        ].includes(event.type)
      )
        throw new Error("Copilot emitted content without a stable logical Turn");
      if (event.type === "session.usage_info") {
        this.usage = {
          ...this.usage,
          contextWindowTokens: event.data.tokenLimit,
          contextUsedTokens: event.data.currentTokens,
        };
        this.emit({ type: "session.usage.changed", usage: this.usage });
      }
      if (event.type === "session.error") {
        const origin = event.data.originatingMessageId;
        const current = this.active?.messageId ?? this.active?.expectedMessageId;
        if (
          origin &&
          (this.retiredMessages.has(origin) ||
            (current && origin !== current && !this.active?.aliases.has(origin)))
        )
          return;
        if (this.active) this.active.error = sessionError(event.data);
        else this.fault(new Error("Copilot session failed"));
      }
      if (this.active?.accepted) {
        const changed =
          event.type === "assistant.usage"
            ? this.usageTelemetry.receive(event.data)
            : event.type === "assistant.message"
              ? this.usageTelemetry.associate(
                  event.data.originatingMessageId ? event.data.apiCallId : undefined,
                  this.active.id,
                )
              : false;
        if (changed) {
          this.usage = { ...this.usage, ...this.usageTelemetry.snapshot() };
          this.emit({
            type: "session.usage.changed",
            usage: this.usage,
            observedForTurnId: this.active.id,
          });
        }
      }
      this.active?.items.accept(event);
      if (event.type === "session.idle" && this.active) {
        if (event.data.mode && event.data.mode !== "interactive")
          throw new CopilotOperationError(
            "unsupported",
            "Copilot changed to an unsupported session mode.",
          );
        if (this.session) {
          this.background.invalidate();
          void this.background.refresh(this.session).catch((error) => this.fault(error));
        }
        const active = this.active;
        if (!active.accepted) {
          this.active = undefined;
          active.identity.reject(new Error("Copilot stopped before accepting the user message"));
          return;
        }
        if (active.cancelling && !event.data.aborted)
          throw new Error("Copilot did not confirm cancellation");
        const outcome: TurnOutcome = event.data.aborted
          ? { status: "cancelled" }
          : active.error
            ? { status: "failed", error: active.error }
            : active.messageId
              ? { status: "succeeded", checkpoint: checkpoint(this.nativeId, active.messageId) }
              : { status: "failed", error: nativeError(new Error("Missing logical identity")) };
        this.finish(outcome);
        void this.refreshUsage().catch(() => {});
        void this.refreshConfiguration().catch((error) => this.fault(error));
      }
    } catch (error) {
      this.fault(error);
    }
  }

  private finish(outcome: TurnOutcome): void {
    const active = this.active;
    if (!active) return;
    clearTimeout(active.timer);
    this.interactions.cancel(active.id);
    if (!active.accepted) {
      active.identity.reject(new Error("Copilot did not accept the user message"));
      this.active = undefined;
      return;
    }
    active.items.finishAll(outcome);
    for (const id of active.items.completedIds()) this.retiredItems.add(id);
    if (active.messageId) this.retiredMessages.add(active.messageId);
    for (const id of active.aliases) this.retiredMessages.add(id);
    while (this.retiredItems.size > 4096)
      this.retiredItems.delete(this.retiredItems.values().next().value ?? "");
    while (this.retiredMessages.size > 128)
      this.retiredMessages.delete(this.retiredMessages.values().next().value ?? "");
    this.active = undefined;
    this.emit({
      type: "turn.completed",
      turnId: active.id,
      ...(active.messageId ? { nativeTurnRef: turnRef(this.nativeId, active.messageId) } : {}),
      outcome,
    });
  }

  private fault(error: unknown, stage = "events"): void {
    if (this.faulted || this.closed) return;
    this.faulted = true;
    this.background.close();
    const problem = nativeError(error, stage);
    this.finish({ status: "failed", error: problem });
    this.emit({ type: "session.faulted", error: problem });
    this.channel.end();
    clearInterval(this.monitor);
    void this.client?.forceStop().catch(() => {});
  }

  private async selectPermission(mode: string): Promise<void> {
    if (mode !== "manual" && mode !== "assisted" && mode !== "allow-all")
      throw new CopilotOperationError("invalidRequest", "Invalid Copilot permission mode.");
    if (!this.session) throw new Error("Copilot session is not initialized");
    const result = await this.session.rpc.permissions.setMode({ mode });
    if (!result.success || result.mode !== mode)
      throw new CopilotOperationError(
        "configurationRequired",
        "Copilot rejected the permission mode.",
      );
  }

  private async refreshConfiguration(): Promise<HarnessSessionState> {
    if (!this.session || !this.client) throw new Error("Copilot session is not initialized");
    const revision = ++this.configurationRevision;
    const state = await bounded(confirmedConfiguration(this.session, this.client));
    if (revision === this.configurationRevision && !this.closed && !this.faulted)
      this.publish(state);
    return state;
  }

  execute(command: TurnStartCommand): Promise<HarnessResult<TurnStartAccepted>>;
  execute(command: TurnSteerCommand): Promise<HarnessResult<TurnSteerAccepted>>;
  execute(command: TurnCancelCommand): Promise<HarnessResult<TurnCancelAccepted>>;
  execute(command: InteractionRespondCommand): Promise<HarnessResult<InteractionRespondAccepted>>;
  execute(
    command: ModelSelectCommand | ThinkingSelectCommand | PermissionModeSelectCommand,
  ): Promise<HarnessResult<ModelSelectCompleted>>;
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
    if (this.closed || this.faulted) return failure("invalidState", "Copilot session is closed.");
    if (command.type === "turn.steer") return unsupportedSteer("Copilot");
    if (command.type === "interaction.respond") {
      const cancel = this.interactions.cancelsTurn(command);
      const result = this.interactions.respond(command);
      if (result.ok && cancel && this.active) {
        const cancellation = await this.execute({ type: "turn.cancel", turnId: this.active.id });
        if (!cancellation.ok) return cancellation;
      }
      return result;
    }
    if (command.type === "turn.cancel") {
      if (!this.active || this.active.id !== command.turnId)
        return failure("invalidRequest", "Copilot Turn is not active.");
      if (!this.active.accepted)
        return failure("invalidState", "Copilot has not accepted this Turn yet.");
      if (this.active.cancelling) return { ok: true, value: { cancellationRequested: true } };
      const active = this.active;
      active.cancelling = true;
      active.timer = setTimeout(() => {
        if (this.active === active)
          this.fault(new Error("Copilot cancellation timed out"), "turn.cancel");
      }, 30_000);
      try {
        if (!this.session) throw new Error("Copilot session is not initialized");
        await bounded(this.session.abort());
        if (this.active === active) this.interactions.cancel(active.id);
        return { ok: true, value: { cancellationRequested: true } };
      } catch (error) {
        if (this.active === active) this.fault(error, "turn.cancel");
        return { ok: false, error: nativeError(error, "turn.cancel") };
      }
    }
    if (this.busy || (command.type === "turn.start" && this.active))
      return failure("sessionBusy", "Copilot session is busy.");
    if (
      command.type === "turn.start" &&
      (!command.input.length ||
        command.input.some((part) => part.type !== "text") ||
        !command.input.some((part) => part.text.trim()))
    )
      return failure("invalidRequest", "Copilot requires text input.");
    this.busy = true;
    try {
      await this.initialize();
      if (this.closed || this.faulted) return failure("invalidState", "Copilot session is closed.");
      const session = this.session;
      const client = this.client;
      if (!session || !client) throw new Error("Copilot session is not initialized");
      if (command.type === "turn.start") {
        const id = hostTurnIdSchema.parse(command.turnId);
        const active = this.startTurn(id);
        this.active = active;
        try {
          this.sending = [];
          this.sendingBytes = 0;
          // A submitted request may reach durable storage before its event reaches this client.
          this.draftCleanupNeeded = false;
          const messageId = await bounded(
            session.send({ prompt: command.input.map((part) => part.text).join("\n\n") }),
          );
          active.expectedMessageId = messageId;
          const buffered = this.sending;
          this.sending = undefined;
          for (const event of buffered) this.receive(event);
          await bounded(active.identity.promise);
        } catch (error) {
          this.sending = undefined;
          if (this.active === active) this.fault(error, "turn.start");
          if (!active.accepted) return { ok: false, error: nativeError(error, "turn.start") };
        }
        return { ok: true, value: { turnId: id } };
      }
      this.configurationRevision++;
      if (command.type === "model.select") {
        const id = modelId(command.model);
        requireModel(await readModels(client, session), id);
        await bounded(session.setModel(id));
      }
      if (command.type === "thinking.select") {
        const current = await session.rpc.model.getCurrent();
        await selectThinking(
          session,
          await readModels(client, session),
          current.modelId,
          command.thinkingOptionId,
        );
      }
      if (command.type === "permissionMode.select")
        await bounded(this.selectPermission(command.permissionModeId));
      const confirmed = await this.refreshConfiguration();
      if (this.closed || this.faulted)
        return failure("invalidState", "Copilot session closed during configuration.");
      if (command.type === "model.select" && confirmed.effectiveModel?.id !== command.model.id)
        throw new CopilotOperationError(
          "configurationRequired",
          "Copilot did not confirm the requested Model.",
        );
      if (
        command.type === "thinking.select" &&
        confirmed.effectiveThinkingOptionId !== command.thinkingOptionId
      )
        throw new CopilotOperationError(
          "configurationRequired",
          "Copilot did not confirm the requested Thinking option.",
        );
      return { ok: true, value: { completed: true } };
    } catch (error) {
      return { ok: false, error: nativeError(error, command.type) };
    } finally {
      this.busy = false;
    }
  }

  hasBackgroundWork(): boolean {
    return !this.closed && !this.faulted && (this.compacting || this.background.hasWork());
  }
  isBusy(): boolean {
    return this.busy || !!this.active || this.hasBackgroundWork();
  }
  currentState(): HarnessSessionState {
    return structuredClone(this.state);
  }
  async withIdleSource<T>(operation: () => Promise<HarnessResult<T>>): Promise<HarnessResult<T>> {
    if (this.closed || this.faulted) return failure("invalidState", "Copilot source is closed.");
    if (this.isBusy()) return failure("sessionBusy", "Copilot source is busy.");
    this.busy = true;
    try {
      return await operation();
    } finally {
      this.busy = false;
    }
  }
  async refreshUsage(): Promise<void> {
    if (!this.session || this.closed || this.faulted) return;
    const metrics = await bounded(this.session.rpc.usage.getMetrics());
    if (this.closed || this.faulted) return;
    this.usage = usageFromMetrics(metrics, this.usage, this.usageTelemetry.snapshot());
    this.emit({ type: "session.usage.changed", usage: this.usage });
  }

  async readSnapshot() {
    if (this.closed || this.faulted)
      return failure<ReturnType<typeof projectHistory>>(
        "invalidState",
        "Copilot session is closed.",
      );
    if (this.busy || this.active || this.compacting)
      return failure<ReturnType<typeof projectHistory>>("sessionBusy", "Copilot session is busy.");
    if (!this.session || !this.client)
      return { ok: true as const, value: { turns: [], state: this.state } };
    this.busy = true;
    try {
      const events = await bounded(this.session.getEvents());
      const state = await bounded(confirmedConfiguration(this.session, this.client));
      if (this.closed || this.faulted)
        return failure<ReturnType<typeof projectHistory>>(
          "invalidState",
          "Copilot session closed during the history read.",
        );
      if (this.active)
        return failure<ReturnType<typeof projectHistory>>(
          "sessionBusy",
          "Copilot began native work during the history read.",
        );
      return {
        ok: true as const,
        value: {
          ...projectHistory(this.nativeId, events),
          state: { ...state, ...(this.durable ? { nativeRef: this.nativeWriterRef } : {}) },
        },
      };
    } catch (error) {
      return { ok: false as const, error: nativeError(error, "history.snapshot") };
    } finally {
      this.busy = false;
    }
  }

  async close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.background.close();
    clearInterval(this.monitor);
    this.closing = this.closeNative().finally(() => {
      this.closing = undefined;
    });
    return this.closing;
  }

  private async closeNative(): Promise<void> {
    const deadline = Date.now() + 55_000;
    const remaining = (maximum: number) => Math.max(1, Math.min(maximum, deadline - Date.now()));
    try {
      if (this.initializing) await bounded(this.initializing, remaining(35_000)).catch(() => {});
      if (this.active && this.session)
        await bounded(this.session.abort(), remaining(5_000)).catch(() => {});
      this.interactions.cancel();
      if (this.client && !this.durable && this.draftCleanupNeeded) {
        if (this.session) await bounded(this.session.disconnect(), remaining(5_000));
        await bounded(this.client.ping(), remaining(1_000)).catch(() =>
          bounded(this.client?.start() ?? Promise.resolve(), remaining(5_000)),
        );
        await bounded(this.client.deleteSession(this.nativeId), remaining(5_000));
        this.draftCleanupNeeded = false;
      }
      if (this.client) {
        const errors = await bounded(this.client.stop(), remaining(10_000)).catch(() => [
          new Error("Copilot stop failed"),
        ]);
        if (errors.length) await bounded(this.client.forceStop(), remaining(5_000));
      }
      this.finish({ status: "cancelled", reason: "Session closed" });
      this.channel.end();
      this.onClosed();
    } catch (error) {
      this.finish({ status: "failed", error: nativeError(error, "session.close") });
      this.channel.end();
      if (this.client) await bounded(this.client.forceStop(), remaining(5_000)).catch(() => {});
      const problem = nativeError(error, "session.close");
      throw new CopilotOperationError(
        problem.code,
        "Copilot resource cleanup failed; close can be retried.",
        problem.diagnostic,
        true,
        "session.close",
      );
    }
  }
}
