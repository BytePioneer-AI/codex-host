import { randomUUID } from "node:crypto";
import path from "node:path";

import { getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import {
  HarnessOutputChannel,
  parseHostUsage,
  validateHostApprovalResponse,
  validateHostQuestionResponse,
  type HarnessAdapter,
  type HarnessError,
  type HarnessInspection,
  type HarnessModelRef,
  type HarnessPermissionModeId,
  type HarnessOutput,
  type HarnessResult,
  type HarnessSession,
  type HarnessSessionCapabilities,
  type HarnessSessionState,
  type HostAgentMessageItem,
  type HostApprovalInteraction,
  type HostCommand,
  type HostEvent,
  type HostItemOutcome,
  type HostQuestionInteraction,
  type InspectHarnessInput,
  type InteractionRespondAccepted,
  type InteractionRespondCommand,
  type ModelSelectCommand,
  type ModelSelectCompleted,
  type OpenSessionInput,
  type PermissionModeSelectCommand,
  type PermissionModeSelectCompleted,
  type HostThreadSnapshot,
  type ThinkingSelectCommand,
  type ThinkingSelectCompleted,
  type TurnCancelAccepted,
  type TurnCancelCommand,
  type TurnOutcome,
  type TurnStartAccepted,
  type TurnStartCommand,
} from "@codexhost/harness-adapter";
import {
  harnessIdSchema,
  harnessResolvedModelLabelSchema,
  hostInteractionIdSchema,
  hostItemIdSchema,
  nativeSessionRefSchema,
  nativeTurnRefSchema,
  type HarnessId,
  type HostInteractionId,
  type NativeSessionRef,
  type NativeTurnRef,
} from "@codexhost/shared-contracts";

import { ClaudeCodeExecutableError, resolveClaudeCodeExecutable } from "./command.js";
import { mapClaudeSnapshot } from "./claude-history.js";
import {
  CLAUDE_DEFAULT_MODEL_REF,
  decodeClaudeModelRef,
  normalizeClaudeModelCatalog,
} from "./model-catalog.js";
import {
  CLAUDE_DEFAULT_PERMISSION_MODE_ID,
  CLAUDE_PERMISSION_MODE_CATALOG,
  decodeClaudePermissionModeId,
  encodeClaudePermissionModeId,
  type ClaudePermissionMode,
} from "./permission-modes.js";
import { ClaudeSdkModelInspector, ClaudeSdkTransport } from "./sdk-transport.js";
import type {
  ClaudeAdapterDependencies,
  ClaudeApprovalRequest,
  ClaudeInteractionRequest,
  ClaudeInteractionResponse,
  ClaudeModelInspector,
  ClaudeQuestionRequest,
  ClaudeTransportFailureKind,
  ClaudeTransportTurnResult,
  ClaudeTurnEvent,
  ClaudeTurnTransport,
} from "./transport.js";

export interface ClaudeCodeAdapterOptions {
  command?: string;
  environment?: NodeJS.ProcessEnv;
  closeTimeoutMs?: number;
}

type SessionPhase = "open" | "closing" | "closed" | "faulted";

type ActiveInteraction =
  | {
      type: "approval";
      interaction: HostApprovalInteraction;
      request: ClaudeApprovalRequest;
    }
  | {
      type: "question";
      interaction: HostQuestionInteraction;
      request: ClaudeQuestionRequest;
    };

interface ActiveTurn {
  command: TurnStartCommand;
  item: HostAgentMessageItem;
  interactions: Map<HostInteractionId, ActiveInteraction>;
  interactionByRequestId: Map<string, HostInteractionId>;
  nativeTurnRef: NativeTurnRef | null;
  cancellationRequested: boolean;
  completion: Promise<void>;
  resolveCompletion(): void;
}

const claudeCodeHarnessId = harnessIdSchema.parse("claude-code");
const DEFAULT_CLOSE_TIMEOUT_MS = 7_000;

function invalidState(message: string): HarnessError {
  return { code: "invalidState", message, retryable: false };
}

function transportFailure(kind: ClaudeTransportFailureKind): HarnessError {
  if (kind === "authentication") {
    return {
      code: "authenticationRequired",
      message: "Claude Code authentication is required",
      retryable: true,
    };
  }
  return {
    code: "nativeFailure",
    message:
      kind === "textConflict"
        ? "Claude Code returned inconsistent streamed text"
        : kind === "cancellationUnproven"
          ? "Claude Code cancellation could not be proven"
          : "Claude Code Turn failed",
    retryable: kind !== "textConflict",
  };
}

function startupFailure(error: unknown): HarnessError {
  if (error instanceof ClaudeCodeExecutableError) {
    return { code: "notInstalled", message: error.message, retryable: false };
  }
  const text = error instanceof Error ? error.message.toLowerCase() : "";
  if (
    text.includes("not logged in") ||
    text.includes("authentication") ||
    text.includes("api key")
  ) {
    return {
      code: "authenticationRequired",
      message: "Claude Code authentication is required",
      retryable: true,
    };
  }
  return {
    code: "unavailable",
    message: "Claude Code could not start",
    retryable: true,
  };
}

function faultError(): HarnessError {
  return {
    code: "processExited",
    message: "Claude Code Session became unavailable",
    retryable: true,
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

class ClaudeHarnessSession implements HarnessSession {
  readonly harnessId: HarnessId = claudeCodeHarnessId;
  readonly capabilities: HarnessSessionCapabilities = {
    configuration: {
      selectModel: true,
      selectThinkingOption: false,
      selectPermissionMode: true,
    },
    history: { fork: false, forkAcrossCwd: false },
  };
  readonly initialState: HarnessSessionState;
  readonly initialUsage = null;
  readonly outputs: AsyncIterable<HarnessOutput>;
  readonly #channel = new HarnessOutputChannel<HarnessOutput>();
  readonly #closeTimeoutMs: number;
  readonly #createTransport: ClaudeAdapterDependencies["createTransport"];
  readonly #cwd: string;
  readonly #nativeRef: NativeSessionRef;
  readonly #onClosed: () => void;
  readonly #openMode: "create" | "resume";
  readonly #randomUUID: () => string;
  #requestedModel: HarnessModelRef | undefined;
  #requestedPermissionModeId: HarnessPermissionModeId;
  readonly #readSessionMessages: ClaudeAdapterDependencies["readSessionMessages"];
  readonly #sessionId: string;
  #acceptingTurn = false;
  #active: ActiveTurn | null = null;
  #closePromise: Promise<void> | null = null;
  #configurationTask: Promise<void> | null = null;
  #phase: SessionPhase = "open";
  #readingHistory = false;
  #state: HarnessSessionState;
  #statePublished = false;
  #transport: ClaudeTurnTransport | null = null;
  #usageGeneration = 0;

  constructor(
    cwd: string,
    dependencies: ClaudeAdapterDependencies,
    closeTimeoutMs: number,
    onClosed: () => void,
    options: {
      openMode: "create" | "resume";
      sessionId: string;
      requestedModel?: HarnessModelRef;
      requestedPermissionModeId: HarnessPermissionModeId;
    },
  ) {
    this.#cwd = cwd;
    this.#createTransport = dependencies.createTransport;
    this.#randomUUID = dependencies.randomUUID;
    this.#readSessionMessages = dependencies.readSessionMessages;
    this.#closeTimeoutMs = closeTimeoutMs;
    this.#onClosed = onClosed;
    this.#openMode = options.openMode;
    this.#requestedModel = options.requestedModel;
    this.#requestedPermissionModeId = options.requestedPermissionModeId;
    this.#sessionId = options.sessionId;
    this.#nativeRef = nativeSessionRefSchema.parse({
      harnessId: this.harnessId,
      nativeSessionId: this.#sessionId,
      formatVersion: 1,
    });
    this.initialState = this.#openMode === "resume" ? { nativeRef: this.#nativeRef } : {};
    this.#state = this.initialState;
    this.#statePublished = this.#openMode === "resume";
    this.outputs = this.#channel.outputs;
  }

  async readSnapshot(): Promise<HarnessResult<HostThreadSnapshot>> {
    if (this.#phase !== "open") {
      return { ok: false, error: invalidState("Claude Code Session is not open") };
    }
    if (this.#active || this.#acceptingTurn || this.#configurationTask || this.#readingHistory) {
      return {
        ok: false,
        error: {
          code: "sessionBusy",
          message: "Claude Code Session cannot read history during another operation",
          retryable: true,
        },
      };
    }
    if (!this.#statePublished) return { ok: true, value: { turns: [] } };

    this.#readingHistory = true;
    try {
      let messages: unknown[];
      try {
        messages = await this.#readSessionMessages({ cwd: this.#cwd, sessionId: this.#sessionId });
      } catch {
        return {
          ok: false,
          error: {
            code: "nativeFailure",
            message: "Claude Code history could not be read",
            retryable: true,
          },
        };
      }
      if (messages.length === 0) {
        return {
          ok: false,
          error: {
            code: "sessionNotFound",
            message: "Claude Code Native Session is unavailable",
            retryable: false,
          },
        };
      }
      try {
        return { ok: true, value: mapClaudeSnapshot(messages, this.#sessionId) };
      } catch {
        return {
          ok: false,
          error: {
            code: "protocolError",
            message: "Claude Code history is invalid",
            retryable: false,
          },
        };
      }
    } finally {
      this.#readingHistory = false;
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
    if (this.#phase !== "open") {
      return { ok: false, error: invalidState("Claude Code Session is not open") };
    }
    if (command.type === "turn.cancel") return this.#cancel(command);
    if (command.type === "interaction.respond") return this.#respond(command);
    if (command.type === "model.select") return this.#selectModel(command);
    if (command.type === "permissionMode.select") return this.#selectPermissionMode(command);
    if (command.type === "thinking.select") {
      return {
        ok: false,
        error: {
          code: "unsupported",
          message: "Claude Code Thinking selection is not supported",
          retryable: false,
        },
      };
    }
    if (this.#acceptingTurn || this.#active || this.#configurationTask || this.#readingHistory) {
      return {
        ok: false,
        error: {
          code: "sessionBusy",
          message: "Claude Code Session already has an active Turn",
          retryable: true,
        },
      };
    }
    const text = command.input.map((input) => input.text).join("\n");
    if (text.length === 0) {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "Claude Code text Turn must not be empty",
          retryable: false,
        },
      };
    }

    this.#acceptingTurn = true;
    const startingTransport = this.#transport === null;
    let transport: ClaudeTurnTransport;
    try {
      transport = await this.#ensureTransport();
    } catch (error) {
      this.#acceptingTurn = false;
      return { ok: false, error: startupFailure(error) };
    }
    this.#acceptingTurn = false;
    if (this.#phase !== "open") {
      return { ok: false, error: invalidState("Claude Code Session closed during startup") };
    }
    if (startingTransport) this.#publishState();
    this.#usageGeneration += 1;
    let resolveCompletion = (): void => undefined;
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    const item: HostAgentMessageItem = {
      type: "agentMessage",
      itemId: hostItemIdSchema.parse(this.#randomUUID()),
      text: "",
    };
    const active: ActiveTurn = {
      command,
      item,
      interactions: new Map(),
      interactionByRequestId: new Map(),
      nativeTurnRef: null,
      cancellationRequested: false,
      completion,
      resolveCompletion,
    };
    this.#active = active;
    this.#event({ type: "turn.started", turnId: command.turnId });
    this.#event({ type: "item.started", turnId: command.turnId, item });
    try {
      const nativeTurnRef = nativeTurnRefSchema.parse({
        harnessId: this.harnessId,
        nativeSessionId: this.#sessionId,
        nativeTurnKey: this.#randomUUID(),
        formatVersion: 1,
      });
      const running = transport.runTurn(text, nativeTurnRef.nativeTurnKey, (event) => {
        this.#handleTurnEvent(active, event);
      });
      // Claude preserves caller-assigned User Message UUIDs in native history.
      active.nativeTurnRef = nativeTurnRef;
      void running.then(
        (result) => this.#finishResult(active, result),
        () => this.#fault(faultError()),
      );
    } catch {
      this.#finishFailed(active, faultError());
    }
    return { ok: true, value: { turnId: command.turnId } };
  }

  close(): Promise<void> {
    if (!this.#closePromise) this.#closePromise = this.#close();
    return this.#closePromise;
  }

  async #selectModel(command: ModelSelectCommand): Promise<HarnessResult<ModelSelectCompleted>> {
    if (this.#acceptingTurn || this.#active || this.#configurationTask || this.#readingHistory) {
      return {
        ok: false,
        error: {
          code: "sessionBusy",
          message: "Claude Code Session cannot select a Model during another operation",
          retryable: true,
        },
      };
    }
    let model: string | undefined;
    try {
      model = decodeClaudeModelRef(command.model);
    } catch {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "Claude Code Model Ref is invalid",
          retryable: false,
        },
      };
    }
    let resolveConfiguration = (): void => undefined;
    this.#configurationTask = new Promise<void>((resolve) => {
      resolveConfiguration = resolve;
    });
    try {
      let transport = this.#transport;
      if (!transport) {
        try {
          transport = await this.#ensureTransport();
        } catch (error) {
          return { ok: false, error: startupFailure(error) };
        }
      }
      try {
        await transport.setModel(model);
      } catch {
        return {
          ok: false,
          error: {
            code: "nativeFailure",
            message: "Claude Code rejected the Model selection",
            retryable: true,
          },
        };
      }
      let resolvedModelLabel: string;
      try {
        const context = await transport.getContextUsage();
        if (!context) throw new Error("Claude Code Model readback is unavailable");
        resolvedModelLabel = harnessResolvedModelLabelSchema.parse(context.model);
      } catch {
        const error: HarnessError = {
          code: "protocolError",
          message: "Claude Code Model state could not be confirmed",
          retryable: false,
        };
        this.#fault(error);
        return { ok: false, error };
      }
      this.#requestedModel = command.model;
      this.#publishState({
        ...this.#state,
        effectiveModel: command.model,
        resolvedModelLabel,
      });
      return { ok: true, value: { completed: true } };
    } finally {
      resolveConfiguration();
      this.#configurationTask = null;
    }
  }

  async #selectPermissionMode(
    command: PermissionModeSelectCommand,
  ): Promise<HarnessResult<PermissionModeSelectCompleted>> {
    if (this.#configurationTask) {
      return {
        ok: false,
        error: {
          code: "sessionBusy",
          message: "Claude Code Session is already selecting Permission Mode",
          retryable: true,
        },
      };
    }
    let permissionMode: ClaudePermissionMode;
    try {
      permissionMode = decodeClaudePermissionModeId(command.permissionModeId);
    } catch {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "Claude Code Permission Mode is invalid",
          retryable: false,
        },
      };
    }
    let resolveConfiguration = (): void => undefined;
    this.#configurationTask = new Promise<void>((resolve) => {
      resolveConfiguration = resolve;
    });
    try {
      const startingTransport = this.#transport === null;
      let transport = this.#transport;
      if (!transport) {
        try {
          transport = await this.#ensureTransport();
          if (startingTransport) this.#publishState();
        } catch (error) {
          return { ok: false, error: startupFailure(error) };
        }
      }
      try {
        await transport.setPermissionMode(permissionMode);
      } catch (error) {
        const nativeMessage = error instanceof Error ? error.message.toLowerCase() : "";
        return {
          ok: false,
          error: {
            code: "nativeFailure",
            message:
              permissionMode === "auto" && nativeMessage.includes("auto mode unavailable")
                ? "Auto mode is unavailable for the current Claude Code Model"
                : "Claude Code rejected the Permission Mode selection",
            retryable: true,
          },
        };
      }
      const effectivePermissionModeId = encodeClaudePermissionModeId(transport.getPermissionMode());
      this.#requestedPermissionModeId = effectivePermissionModeId;
      this.#publishState({
        ...this.#state,
        effectivePermissionModeId,
      });
      return { ok: true, value: { completed: true } };
    } finally {
      resolveConfiguration();
      this.#configurationTask = null;
    }
  }

  async #respond(
    command: InteractionRespondCommand,
  ): Promise<HarnessResult<InteractionRespondAccepted>> {
    const active = this.#active;
    const pending = active?.interactions.get(command.interactionId);
    if (!active || !pending) {
      return {
        ok: false,
        error: invalidState(
          "Claude Code Interaction Response must reference a pending Interaction",
        ),
      };
    }
    const transport = this.#transport;
    if (!transport) {
      return { ok: false, error: invalidState("Claude Code transport is unavailable") };
    }

    let response: ClaudeInteractionResponse;
    if (pending.type === "approval") {
      if (command.response.type !== "approval") {
        return {
          ok: false,
          error: {
            code: "invalidRequest",
            message: "Claude Code Approval requires an Approval Response",
            retryable: false,
          },
        };
      }
      const validationError = validateHostApprovalResponse(pending.interaction, command.response);
      if (validationError) return { ok: false, error: validationError };
      const actionId = command.response.actionId;
      const action = pending.interaction.actions.find(({ id }) => id === actionId);
      if (!action) {
        return {
          ok: false,
          error: {
            code: "invalidRequest",
            message: "Claude Code Approval action is unavailable",
            retryable: false,
          },
        };
      }
      response = {
        type: "approval",
        requestId: pending.request.requestId,
        decision: action.effect,
      };
    } else {
      if (command.response.type !== "question") {
        return {
          ok: false,
          error: {
            code: "invalidRequest",
            message: "Claude Code Question requires a Question Response",
            retryable: false,
          },
        };
      }
      const validationError = validateHostQuestionResponse(pending.interaction, command.response);
      if (validationError) return { ok: false, error: validationError };
      if (command.response.cancelled) {
        response = {
          type: "question",
          requestId: pending.request.requestId,
          cancelled: true,
        };
      } else {
        const answers: Record<string, string> = {};
        for (const [index, question] of pending.request.questions.entries()) {
          answers[question.question] =
            command.response.answers[`question-${index + 1}`]?.join(", ") ?? "";
        }
        response = {
          type: "question",
          requestId: pending.request.requestId,
          answers,
        };
      }
    }
    try {
      await transport.respondToInteraction(response);
      return { ok: true, value: { accepted: true } };
    } catch {
      return {
        ok: false,
        error: {
          code: "nativeFailure",
          message: "Claude Code Interaction response failed",
          retryable: false,
        },
      };
    }
  }

  async #cancel(command: TurnCancelCommand): Promise<HarnessResult<TurnCancelAccepted>> {
    const active = this.#active;
    if (!active || active.command.turnId !== command.turnId) {
      return {
        ok: false,
        error: invalidState("Claude Code Turn Cancel must reference the active Turn"),
      };
    }
    if (active.cancellationRequested) {
      return { ok: true, value: { cancellationRequested: true } };
    }
    active.cancellationRequested = true;
    try {
      await this.#transport?.abort();
      return { ok: true, value: { cancellationRequested: true } };
    } catch {
      this.#finishFailed(active, transportFailure("cancellationUnproven"));
      return {
        ok: false,
        error: transportFailure("cancellationUnproven"),
      };
    }
  }

  async #close(): Promise<void> {
    if (this.#phase === "closed") return;
    this.#usageGeneration += 1;
    if (this.#phase !== "faulted") this.#phase = "closing";
    const configurationTask = this.#configurationTask;
    if (configurationTask) {
      await Promise.race([configurationTask, delay(this.#closeTimeoutMs)]);
    }
    let transportClosed = false;
    const active = this.#active;
    if (active) {
      active.cancellationRequested = true;
      await this.#transport?.abort().catch(() => undefined);
      await Promise.race([active.completion, delay(this.#closeTimeoutMs)]);
      if (this.#active === active) {
        await this.#transport?.close().catch(() => undefined);
        transportClosed = true;
        this.#finishFailed(active, invalidState("Claude Code Session closed during active Turn"));
      }
    }
    if (!transportClosed) await this.#transport?.close().catch(() => undefined);
    this.#phase = "closed";
    this.#channel.end();
    this.#onClosed();
  }

  async #ensureTransport(): Promise<ClaudeTurnTransport> {
    if (this.#transport) return this.#transport;
    const selectedModel =
      this.#openMode === "create" ? (this.#requestedModel ?? CLAUDE_DEFAULT_MODEL_REF) : undefined;
    const model = selectedModel ? decodeClaudeModelRef(selectedModel) : undefined;
    const permissionMode = decodeClaudePermissionModeId(this.#requestedPermissionModeId);
    const transport = this.#createTransport({
      cwd: this.#cwd,
      sessionId: this.#sessionId,
      openMode: this.#openMode,
      ...(model ? { model } : {}),
      permissionMode,
      onPermissionModeChanged: (mode) => this.#handlePermissionModeChanged(mode),
      onFault: () => this.#fault(faultError()),
    });
    try {
      await transport.start();
      const context = await transport.getContextUsage();
      if (!context) throw new Error("Claude Code Model readback is unavailable");
      this.#state = {
        nativeRef: this.#nativeRef,
        ...(selectedModel ? { effectiveModel: selectedModel } : {}),
        resolvedModelLabel: harnessResolvedModelLabelSchema.parse(context.model),
        effectivePermissionModeId: encodeClaudePermissionModeId(transport.getPermissionMode()),
      };
    } catch (error) {
      await transport.close().catch(() => undefined);
      throw error;
    }
    this.#transport = transport;
    return transport;
  }

  #publishState(state: HarnessSessionState = this.#state): void {
    this.#state = state;
    this.#statePublished = true;
    this.#event({ type: "session.state.changed", state });
  }

  #handlePermissionModeChanged(permissionMode: ClaudePermissionMode): void {
    if (this.#phase !== "open") return;
    const effectivePermissionModeId = encodeClaudePermissionModeId(permissionMode);
    if (this.#state.effectivePermissionModeId === effectivePermissionModeId) return;
    this.#requestedPermissionModeId = effectivePermissionModeId;
    this.#publishState({ ...this.#state, effectivePermissionModeId });
  }

  #handleTurnEvent(active: ActiveTurn, event: ClaudeTurnEvent): void {
    if (this.#active !== active || this.#phase === "closed" || this.#phase === "faulted") return;
    if (event.type === "text.delta") {
      this.#appendText(active, event.delta);
    } else if (event.type === "interaction.requested") {
      this.#startInteraction(active, event.request);
    } else {
      this.#closeInteraction(active, event.requestId, event.reason);
    }
  }

  #startInteraction(active: ActiveTurn, request: ClaudeInteractionRequest): void {
    if (active.interactionByRequestId.has(request.requestId)) {
      throw new Error("Claude Code Interaction started more than once");
    }
    const interactionId = hostInteractionIdSchema.parse(this.#randomUUID());
    let pending: ActiveInteraction;
    if (request.type === "approval") {
      const interaction: HostApprovalInteraction = {
        type: "approval",
        interactionId,
        turnId: active.command.turnId,
        title: request.title,
        ...(request.description ? { description: request.description } : {}),
        subject: { type: "nativeAction" },
        actions: [
          { id: "allowOnce", label: "Allow once", effect: "allowOnce" },
          ...(request.suggestedScope === "session"
            ? [
                {
                  id: "allowForSession",
                  label: "Allow this conversation",
                  effect: "allowForSession" as const,
                },
              ]
            : request.suggestedScope === "always"
              ? [
                  {
                    id: "allowAlways",
                    label: "Always allow",
                    effect: "allowAlways" as const,
                  },
                ]
              : []),
          { id: "deny", label: "Deny", effect: "deny" },
        ],
      };
      pending = { type: "approval", interaction, request };
    } else {
      const firstQuestion = request.questions[0];
      if (!firstQuestion) throw new Error("Claude Code Question request is empty");
      const interaction: HostQuestionInteraction = {
        type: "question",
        interactionId,
        turnId: active.command.turnId,
        title: request.questions.length === 1 ? firstQuestion.header : "Claude Code",
        questions: request.questions.map((question, index) => ({
          id: `question-${index + 1}`,
          type: "choice",
          prompt: question.question,
          options: question.options.map((option) => ({
            value: option.label,
            label: option.label,
            description: option.description,
          })),
          multiple: question.multiSelect,
          allowOther: true,
          optional: false,
        })),
      };
      pending = { type: "question", interaction, request };
    }
    active.interactions.set(interactionId, pending);
    active.interactionByRequestId.set(request.requestId, interactionId);
    this.#channel.emit({ kind: "interaction", interaction: pending.interaction });
  }

  #closeInteraction(
    active: ActiveTurn,
    requestId: string,
    reason: "responded" | "cancelled" | "superseded",
  ): void {
    const interactionId = active.interactionByRequestId.get(requestId);
    if (!interactionId)
      throw new Error("Claude Code Interaction close references an unknown request");
    active.interactionByRequestId.delete(requestId);
    active.interactions.delete(interactionId);
    this.#event({
      type: "interaction.closed",
      interactionId,
      turnId: active.command.turnId,
      reason,
    });
  }

  #closeActiveInteractions(active: ActiveTurn, reason: "cancelled" | "superseded"): void {
    for (const [interactionId, pending] of active.interactions) {
      active.interactions.delete(interactionId);
      active.interactionByRequestId.delete(pending.request.requestId);
      this.#event({
        type: "interaction.closed",
        interactionId,
        turnId: active.command.turnId,
        reason,
      });
    }
  }

  #appendText(active: ActiveTurn, delta: string): void {
    if (this.#active !== active || delta.length === 0) return;
    active.item = { ...active.item, text: active.item.text + delta };
    this.#event({
      type: "item.updated",
      turnId: active.command.turnId,
      itemId: active.item.itemId,
      update: { type: "text.append", text: delta },
    });
  }

  #finishResult(active: ActiveTurn, result: ClaudeTransportTurnResult): void {
    if (this.#active !== active) return;
    const transport = this.#transport;
    if (result.status === "succeeded") {
      this.#finish(active, { status: "succeeded" });
    } else if (result.status === "cancelled") {
      this.#finish(active, { status: "cancelled", reason: result.reason });
    } else {
      this.#finishFailed(active, transportFailure(result.kind));
    }
    if (transport && this.#phase === "open") {
      this.#refreshUsage(transport, active.command.turnId);
    }
  }

  #refreshUsage(transport: ClaudeTurnTransport, turnId: TurnStartCommand["turnId"]): void {
    const generation = ++this.#usageGeneration;
    void transport
      .getContextUsage()
      .then((context) => {
        if (
          context === null ||
          this.#phase !== "open" ||
          this.#transport !== transport ||
          this.#usageGeneration !== generation
        ) {
          return;
        }
        const usage = parseHostUsage({
          contextUsedTokens: context.usedTokens,
          contextWindowTokens: context.maxTokens,
        });
        this.#event({ type: "session.usage.changed", observedForTurnId: turnId, usage });
      })
      .catch(() => undefined);
  }

  #finishFailed(active: ActiveTurn, error: HarnessError): void {
    this.#finish(active, { status: "failed", error });
  }

  #finish(active: ActiveTurn, outcome: TurnOutcome): void {
    if (this.#active !== active) return;
    this.#closeActiveInteractions(
      active,
      outcome.status === "succeeded" ? "superseded" : "cancelled",
    );
    const itemOutcome: HostItemOutcome = outcome;
    this.#event({
      type: "item.completed",
      turnId: active.command.turnId,
      snapshot: { item: active.item, outcome: itemOutcome },
    });
    this.#event({
      type: "turn.completed",
      turnId: active.command.turnId,
      ...(active.nativeTurnRef ? { nativeTurnRef: active.nativeTurnRef } : {}),
      outcome,
    });
    this.#active = null;
    active.resolveCompletion();
  }

  #fault(error: HarnessError): void {
    if (this.#phase === "closed" || this.#phase === "closing" || this.#phase === "faulted") return;
    this.#usageGeneration += 1;
    const active = this.#active;
    if (active) this.#finishFailed(active, error);
    this.#phase = "faulted";
    this.#event({ type: "session.faulted", error });
    this.#channel.end();
    void this.#transport?.close();
    this.#onClosed();
  }

  #event(event: HostEvent): void {
    this.#channel.emit({ kind: "event", event });
  }
}

export class ClaudeCodeAdapter implements HarnessAdapter {
  readonly harnessId: HarnessId = claudeCodeHarnessId;
  readonly #closeTimeoutMs: number;
  readonly #dependencies: ClaudeAdapterDependencies;
  readonly #inspectionCache = new Map<string, HarnessInspection>();
  readonly #inspectionInFlight = new Map<string, Promise<HarnessInspection>>();
  readonly #inspectors = new Set<ClaudeModelInspector>();
  readonly #sessions = new Set<ClaudeHarnessSession>();
  #closePromise: Promise<void> | null = null;

  constructor(options: ClaudeCodeAdapterOptions = {}, dependencies?: ClaudeAdapterDependencies) {
    this.#closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
    this.#dependencies = dependencies ?? {
      randomUUID,
      inspectInstallation: () => {
        resolveClaudeCodeExecutable({
          ...(options.command ? { command: options.command } : {}),
          environment: options.environment ?? process.env,
        });
      },
      createInspector: (input) =>
        new ClaudeSdkModelInspector({
          ...input,
          ...(options.command ? { command: options.command } : {}),
          environment: options.environment ?? process.env,
          closeTimeoutMs: this.#closeTimeoutMs,
        }),
      createTransport: (input) =>
        new ClaudeSdkTransport({
          ...input,
          ...(options.command ? { command: options.command } : {}),
          environment: options.environment ?? process.env,
          closeTimeoutMs: this.#closeTimeoutMs,
        }),
      readSessionMessages: ({ cwd, sessionId }) => getSessionMessages(sessionId, { dir: cwd }),
    };
  }

  async inspect(input: InspectHarnessInput = {}): Promise<HarnessInspection> {
    if (this.#closePromise) {
      return {
        status: "unavailable",
        error: invalidState("Claude Code Adapter is closing"),
      };
    }
    const cwd = path.resolve(input.cwd ?? process.cwd());
    if (!input.refresh) {
      const cached = this.#inspectionCache.get(cwd);
      if (cached) return cached;
    }
    const current = this.#inspectionInFlight.get(cwd);
    if (current) return current;
    const inspection = this.#inspectModels(cwd).then((result) => {
      if (result.status === "ready") this.#inspectionCache.set(cwd, result);
      return result;
    });
    this.#inspectionInFlight.set(cwd, inspection);
    void inspection.finally(() => {
      if (this.#inspectionInFlight.get(cwd) === inspection) {
        this.#inspectionInFlight.delete(cwd);
      }
    });
    return inspection;
  }

  async #inspectModels(cwd: string): Promise<HarnessInspection> {
    let inspector: ClaudeModelInspector | null = null;
    try {
      this.#dependencies.inspectInstallation();
      inspector = this.#dependencies.createInspector({ cwd });
      this.#inspectors.add(inspector);
      const snapshot = await inspector.inspect();
      if (!snapshot.canSelectModel) {
        return {
          status: "ready",
          catalog: { models: [], thinkingOptions: [] },
          ...(snapshot.canSelectPermissionMode
            ? { permissionModes: CLAUDE_PERMISSION_MODE_CATALOG }
            : {}),
          capabilities: {
            configuration: {
              selectModel: false,
              selectThinkingOption: false,
              selectPermissionMode: snapshot.canSelectPermissionMode,
            },
            history: { fork: false, forkAcrossCwd: false },
          },
        };
      }
      const { catalog } = normalizeClaudeModelCatalog(snapshot);
      return {
        status: "ready",
        catalog,
        ...(snapshot.canSelectPermissionMode
          ? { permissionModes: CLAUDE_PERMISSION_MODE_CATALOG }
          : {}),
        capabilities: {
          configuration: {
            selectModel: true,
            selectThinkingOption: false,
            selectPermissionMode: snapshot.canSelectPermissionMode,
          },
          history: { fork: false, forkAcrossCwd: false },
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const normalized =
        message.startsWith("Claude Code Model") || message.startsWith("Claude SDK context Usage")
          ? ({
              code: "protocolError",
              message: "Claude Code returned an invalid Model catalog",
              retryable: false,
            } satisfies HarnessError)
          : startupFailure(error);
      return {
        status: normalized.code === "notInstalled" ? "notInstalled" : "error",
        error: normalized,
      };
    } finally {
      if (inspector) {
        await inspector.close().catch(() => undefined);
        this.#inspectors.delete(inspector);
      }
    }
  }

  async open(input: OpenSessionInput): Promise<HarnessResult<HarnessSession>> {
    if (this.#closePromise) {
      return {
        ok: false,
        error: invalidState("Claude Code Adapter is closing"),
      };
    }
    if (input.cwd.length === 0) {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "Claude Code Adapter requires cwd",
          retryable: false,
        },
      };
    }
    if (input.kind === "fork") {
      return {
        ok: false,
        error: {
          code: "unsupported",
          message: "Claude Code fork is not implemented",
          retryable: false,
        },
      };
    }
    if (input.kind === "create" && input.thinkingOptionId) {
      return {
        ok: false,
        error: {
          code: "unsupported",
          message: "Claude Code Thinking selection is not supported",
          retryable: false,
        },
      };
    }
    if (input.kind === "create" && input.model) {
      try {
        decodeClaudeModelRef(input.model);
      } catch {
        return {
          ok: false,
          error: {
            code: "invalidRequest",
            message: "Claude Code create Model Ref is invalid",
            retryable: false,
          },
        };
      }
    }
    const requestedPermissionModeId =
      input.kind === "create"
        ? (input.permissionModeId ?? CLAUDE_DEFAULT_PERMISSION_MODE_ID)
        : CLAUDE_DEFAULT_PERMISSION_MODE_ID;
    try {
      decodeClaudePermissionModeId(requestedPermissionModeId);
    } catch {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "Claude Code create Permission Mode is invalid",
          retryable: false,
        },
      };
    }
    const nativeRef =
      input.kind === "resume" ? nativeSessionRefSchema.safeParse(input.nativeRef) : null;
    if (nativeRef && (!nativeRef.success || nativeRef.data.harnessId !== this.harnessId)) {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "Claude Code Adapter cannot resume another Harness's Native Session",
          retryable: false,
        },
      };
    }
    const session = new ClaudeHarnessSession(
      input.cwd,
      this.#dependencies,
      this.#closeTimeoutMs,
      () => this.#sessions.delete(session),
      {
        openMode: input.kind,
        sessionId: nativeRef?.success
          ? nativeRef.data.nativeSessionId
          : this.#dependencies.randomUUID(),
        ...(input.kind === "create" && input.model ? { requestedModel: input.model } : {}),
        requestedPermissionModeId,
      },
    );
    this.#sessions.add(session);
    return { ok: true, value: session };
  }

  close(): Promise<void> {
    if (!this.#closePromise) {
      this.#inspectionCache.clear();
      this.#closePromise = Promise.all([
        ...[...this.#inspectors].map((inspector) => inspector.close()),
        ...[...this.#sessions].map((session) => session.close()),
        ...this.#inspectionInFlight.values(),
      ]).then(() => undefined);
    }
    return this.#closePromise;
  }
}
