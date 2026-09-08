import {
  HarnessOutputChannel,
  validateHostApprovalResponse,
  validateHostQuestionResponse,
  type HarnessError,
  type HarnessModelRef,
  type HarnessOutput,
  type HarnessPermissionModeId,
  type HarnessResult,
  type HarnessSession,
  type HarnessSessionCapabilities,
  type HarnessSessionState,
  type HarnessThinkingOptionId,
  type HostAgentMessageItem,
  type HostApprovalInteraction,
  type HostItem,
  type HostItemOutcome,
  type HostQuestionInteraction,
  type HostSubagentDelegationItem,
  type HostThreadSnapshot,
  type HostToolExecutionItem,
  type InteractionRespondAccepted,
  type InteractionRespondCommand,
  type ModelSelectCommand,
  type ModelSelectCompleted,
  type PermissionModeSelectCommand,
  type PermissionModeSelectCompleted,
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
  harnessSessionCapabilitiesSchema,
  hostInteractionIdSchema,
  hostItemIdSchema,
  nativeCheckpointRefSchema,
  nativeSessionRefSchema,
  nativeTurnRefSchema,
  type NativeSessionRef,
} from "@codexhost/shared-contracts";

import {
  mapMuseApprovalActions,
  museApprovalDescription,
  museApprovalProjectionReady,
  museApprovalTitle,
  parseMuseRequirementRef,
  type MuseRequirementRef,
} from "./approval.js";
import {
  mapMuseHostItem,
  museHistoryItemOutcome,
  museItemText,
  museSubagentIsRecovering,
  museSubagentIsTerminal,
  readMuseHistory,
  snapshotFromMuseHistory,
} from "./history.js";
import { mapMuseUserInputQuestions, museUserInputAnswers } from "./user-input.js";
import {
  decodeMuseThinkingOptionId,
  MUSE_DEFAULT_THINKING_OPTION_ID,
  museModelRef,
  museThinkingOptionId,
  MUSE_THINKING_OPTIONS,
} from "./model-catalog.js";
import type { JsonObject, MuseRpc, MuseRpcNotification } from "./msp-client.js";
import { MuseProcessError, MuseRpcError } from "./msp-client.js";
import {
  decodeMusePermissionModeId,
  MUSE_DEFAULT_PERMISSION_MODE_ID,
  type MuseApprovalMode,
} from "./permission-modes.js";
import { uuidv7 } from "./uuid.js";

export const MUSE_HARNESS_ID = harnessIdSchema.parse("muse");

export const MUSE_SESSION_CAPABILITIES: HarnessSessionCapabilities =
  harnessSessionCapabilitiesSchema.parse({
    configuration: {
      selectModel: true,
      selectThinkingOption: true,
      selectPermissionMode: true,
      permissionModeScope: "live",
    },
    history: { fork: true, forkAcrossCwd: false, rollbackLastTurn: false },
    subagents: { observe: true, readTranscript: true },
  });

export interface MuseNativeSession {
  sessionId: string;
  modelId?: string;
  approvalMode?: MuseApprovalMode;
}

interface ActiveTurn {
  command: TurnStartCommand;
  nativeTurnId: string;
  agentItem: HostAgentMessageItem | null;
  items: Map<string, HostItem>;
}

interface PendingMuseApproval {
  interaction: HostApprovalInteraction;
  nativeApprovalId: string;
  requirementId: MuseRequirementRef;
}

interface TrackedMuseSubagent {
  item: HostSubagentDelegationItem;
  nativeTurnId: string;
  revision: number;
  turnId: TurnStartCommand["turnId"];
  hostCompleted: boolean;
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolvePermissionModeId(
  requested: HarnessPermissionModeId | undefined,
  native: MuseApprovalMode | undefined,
): HarnessPermissionModeId {
  if (requested) {
    decodeMusePermissionModeId(requested);
    return requested;
  }
  if (native) {
    decodeMusePermissionModeId(native as HarnessPermissionModeId);
    return native as HarnessPermissionModeId;
  }
  return MUSE_DEFAULT_PERMISSION_MODE_ID;
}

function museTurnError(params: JsonObject): HarnessError {
  const error = isRecord(params.error) ? params.error : undefined;
  const message =
    (error && typeof error.message === "string" && error.message) ||
    (typeof params.reason === "string" && params.reason) ||
    (typeof params.message === "string" && params.message) ||
    "Muse Turn failed";
  return {
    code: "nativeFailure",
    message,
    retryable: error && typeof error.retryable === "boolean" ? error.retryable : false,
  };
}

function toolOutputText(item: HostToolExecutionItem): string {
  return (item.output?.content ?? [])
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("");
}

function asError(error: unknown): HarnessError {
  if (error instanceof MuseProcessError) return error.harnessError;
  if (error instanceof MuseRpcError) {
    if (error.data && isRecord(error.data) && error.data.kind === "sessionNotFound") {
      return { code: "sessionNotFound", message: error.message, retryable: false };
    }
    return { code: "nativeFailure", message: error.message, retryable: false };
  }
  return {
    code: "internalError",
    message: error instanceof Error ? error.message : "Muse session failed",
    retryable: false,
  };
}

export class MuseHarnessSession implements HarnessSession {
  readonly harnessId = MUSE_HARNESS_ID;
  readonly capabilities = MUSE_SESSION_CAPABILITIES;
  readonly initialState: HarnessSessionState;
  readonly initialUsage = null;
  readonly outputs: AsyncIterable<HarnessOutput>;
  readonly nativeRef: NativeSessionRef;

  #rpc: MuseRpc;
  #unsubscribe: () => void;
  #unsubscribeFailure: () => void;
  #closePromise: Promise<void> | null = null;
  #channel = new HarnessOutputChannel<HarnessOutput>();
  #closed = false;
  #busy = false;
  #active: ActiveTurn | null = null;
  #pendingApprovals = new Map<string, PendingMuseApproval>();
  #pendingQuestions = new Map<string, HostQuestionInteraction>();
  #inbox: MuseRpcNotification[] | null = null;
  #seenCursors = new Set<string>();
  #startedItemIds = new Set<string>();
  #itemRevisions = new Map<string, number>();
  #subagents = new Map<string, TrackedMuseSubagent>();
  #resumedSubagents = new Set<string>();
  #model: HarnessModelRef | undefined;
  #thinkingOptionId: HarnessThinkingOptionId;
  #permissionModeId: HarnessPermissionModeId;
  #native: MuseNativeSession;

  constructor(input: {
    rpc: MuseRpc;
    native: MuseNativeSession;
    model?: HarnessModelRef;
    thinkingOptionId?: HarnessThinkingOptionId;
    permissionModeId?: HarnessPermissionModeId;
  }) {
    this.#rpc = input.rpc;
    this.#native = input.native;
    this.nativeRef = nativeSessionRefSchema.parse({
      harnessId: MUSE_HARNESS_ID,
      nativeSessionId: input.native.sessionId,
      formatVersion: 1,
    });
    this.#model =
      input.model ?? (input.native.modelId ? museModelRef(input.native.modelId) : undefined);
    this.#thinkingOptionId = input.thinkingOptionId ?? MUSE_DEFAULT_THINKING_OPTION_ID;
    this.#permissionModeId = resolvePermissionModeId(
      input.permissionModeId,
      input.native.approvalMode,
    );
    this.initialState = this.#state();
    this.outputs = this.#channel.outputs;
    this.#unsubscribe = this.#rpc.subscribe((notification) => this.#onNotification(notification));
    this.#unsubscribeFailure = this.#rpc.subscribeFailure((error) =>
      this.#fault(error.harnessError),
    );
  }

  async readSnapshot(): Promise<HarnessResult<HostThreadSnapshot>> {
    if (this.#closed)
      return {
        ok: false,
        error: { code: "invalidState", message: "Session closed", retryable: false },
      };
    if (this.#busy)
      return {
        ok: false,
        error: { code: "sessionBusy", message: "Muse Session is busy", retryable: true },
      };
    try {
      const history = await readMuseHistory(this.#rpc, this.#native.sessionId);
      const snapshot = snapshotFromMuseHistory(this.nativeRef, history);
      return { ok: true, value: { ...snapshot, state: this.#state() } };
    } catch (error) {
      return { ok: false, error: asError(error) };
    }
  }

  async execute(command: TurnStartCommand): Promise<HarnessResult<TurnStartAccepted>>;
  async execute(command: TurnCancelCommand): Promise<HarnessResult<TurnCancelAccepted>>;
  async execute(
    command: InteractionRespondCommand,
  ): Promise<HarnessResult<InteractionRespondAccepted>>;
  async execute(command: ModelSelectCommand): Promise<HarnessResult<ModelSelectCompleted>>;
  async execute(command: ThinkingSelectCommand): Promise<HarnessResult<ThinkingSelectCompleted>>;
  async execute(
    command: PermissionModeSelectCommand,
  ): Promise<HarnessResult<PermissionModeSelectCompleted>>;
  async execute(
    command:
      | TurnStartCommand
      | TurnCancelCommand
      | InteractionRespondCommand
      | ModelSelectCommand
      | ThinkingSelectCommand
      | PermissionModeSelectCommand,
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
    if (this.#closed) {
      return {
        ok: false,
        error: { code: "invalidState", message: "Session closed", retryable: false },
      };
    }
    try {
      if (command.type === "turn.start") return await this.#startTurn(command);
      if (command.type === "turn.cancel") return await this.#cancelTurn(command);
      if (command.type === "interaction.respond") return await this.#respond(command);
      if (command.type === "model.select") return await this.#selectModel(command);
      if (command.type === "thinking.select") return await this.#selectThinking(command);
      return await this.#selectPermission(command);
    } catch (error) {
      if (error instanceof MuseProcessError) this.#fault(error.harnessError);
      return { ok: false, error: asError(error) };
    }
  }

  async close(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true;
      this.#unsubscribe();
      this.#unsubscribeFailure();
      if (this.#active) this.#completeTurn({ status: "cancelled", reason: "Session closed" });
      this.#channel.end();
      this.#closePromise = this.#rpc.close();
    }
    await this.#closePromise;
  }

  #fault(error: HarnessError): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#unsubscribe();
    this.#unsubscribeFailure();
    this.#completeTurn({ status: "failed", error });
    this.#emit({ kind: "event", event: { type: "session.faulted", error } });
    this.#channel.end();
    this.#closePromise = this.#rpc.close();
    void this.#closePromise.catch(() => undefined);
  }

  async #startTurn(command: TurnStartCommand): Promise<HarnessResult<TurnStartAccepted>> {
    if (this.#busy || this.#active) return this.#sessionBusy();
    this.#busy = true;
    this.#inbox = [];
    const text = command.input.map((part) => part.text).join("\n");
    const commandId = uuidv7();
    try {
      const current = await this.#rpc.request("session/read", {
        sessionId: this.#native.sessionId,
        excludeItems: true,
      });
      const nativeSession = isRecord(current.session) ? current.session : {};
      if (
        nativeSession.activeTurnId ||
        nativeSession.status === "running" ||
        (Array.isArray(current.pendingRequests) && current.pendingRequests.length > 0)
      ) {
        return this.#sessionBusy();
      }
      this.#requireOpen();
      const result = await this.#rpc.request("turn/start", {
        commandId,
        sessionId: this.#native.sessionId,
        input: [{ type: "text", text }],
        reasoningEffort: decodeMuseThinkingOptionId(this.#thinkingOptionId),
      });
      this.#requireOpen();
      this.#validateAck(result, commandId, "turn/start");
      const nativeTurnId = result.turnId as string;
      if (result.disposition === "queued") {
        // The native default queues on a race with another foreground owner. Reclaim
        // this exact submission before rejecting it; no Host Turn has started yet.
        const reclaimCommandId = uuidv7();
        try {
          const reclaimed = await this.#rpc.request("turn/unqueue", {
            commandId: reclaimCommandId,
            sessionId: this.#native.sessionId,
            turnId: nativeTurnId,
          });
          this.#validateAck(reclaimed, reclaimCommandId, "turn/unqueue", nativeTurnId);
        } catch (error) {
          if (error instanceof MuseProcessError) throw error;
          throw this.#protocolError(
            `Muse could not reclaim queued Turn: ${asError(error).message}`,
          );
        }
        return this.#sessionBusy();
      }
      if (result.disposition !== "started" || result.startedNewTurn !== true) {
        throw this.#protocolError("Muse turn/start did not acknowledge a fresh started Turn");
      }
      this.#active = { command, nativeTurnId, agentItem: null, items: new Map() };
      const buffered = this.#inbox ?? [];
      this.#inbox = null;
      this.#emit({ kind: "event", event: { type: "turn.started", turnId: command.turnId } });
      for (const notification of buffered) this.#onNotification(notification);
      return { ok: true, value: { turnId: command.turnId } };
    } catch (error) {
      if (error instanceof MuseProcessError) this.#fault(error.harnessError);
      throw error;
    } finally {
      this.#inbox = null;
      if (!this.#active) this.#busy = false;
    }
  }

  #sessionBusy(): HarnessResult<never> {
    return {
      ok: false,
      error: { code: "sessionBusy", message: "Muse Session is busy", retryable: true },
    };
  }

  #requireOpen(): void {
    if (this.#closed) {
      throw new MuseProcessError({
        code: "invalidState",
        message: "Muse Session closed",
        retryable: false,
      });
    }
  }

  #protocolError(message: string): MuseProcessError {
    return new MuseProcessError({ code: "protocolError", message, retryable: false });
  }

  #validateAck(result: JsonObject, commandId: string, method: string, turnId?: string): void {
    if (
      result.status !== "accepted" ||
      result.commandId !== commandId ||
      typeof result.turnId !== "string" ||
      !result.turnId.trim() ||
      (turnId !== undefined && result.turnId !== turnId)
    ) {
      throw this.#protocolError(`Muse ${method} returned an invalid acknowledgement`);
    }
  }

  async #cancelTurn(command: TurnCancelCommand): Promise<HarnessResult<TurnCancelAccepted>> {
    if (!this.#active || this.#active.command.turnId !== command.turnId) {
      return {
        ok: false,
        error: { code: "invalidRequest", message: "No matching Muse Turn", retryable: false },
      };
    }
    const nativeTurnId = this.#active.nativeTurnId;
    const commandId = uuidv7();
    const result = await this.#rpc.request("turn/cancel", {
      commandId,
      sessionId: this.#native.sessionId,
      turnId: nativeTurnId,
    });
    this.#validateAck(result, commandId, "turn/cancel", nativeTurnId);
    return { ok: true, value: { cancellationRequested: true } };
  }

  async #respond(command: InteractionRespondCommand): Promise<HarnessResult<{ accepted: true }>> {
    const pending = this.#pendingApprovals.get(command.interactionId);
    if (pending) {
      if (command.response.type !== "approval") {
        return {
          ok: false,
          error: {
            code: "invalidRequest",
            message: "Approval response required",
            retryable: false,
          },
        };
      }
      const approvalError = validateHostApprovalResponse(pending.interaction, command.response);
      if (approvalError) return { ok: false, error: approvalError };
      const decided = await this.#rpc.request("approval/decide", {
        commandId: uuidv7(),
        sessionId: this.#native.sessionId,
        approvalId: pending.nativeApprovalId,
        choiceId: command.response.actionId,
        requirementId: pending.requirementId,
      });
      if (decided.terminal === false) return { ok: true, value: { accepted: true } };
      this.#closeApproval(command.interactionId, "responded");
      return { ok: true, value: { accepted: true } };
    }
    const question = this.#pendingQuestions.get(command.interactionId);
    if (!question) {
      return {
        ok: false,
        error: { code: "invalidRequest", message: "Unknown Muse interaction", retryable: false },
      };
    }
    if (command.response.type !== "question") {
      return {
        ok: false,
        error: { code: "invalidRequest", message: "Question response required", retryable: false },
      };
    }
    if (command.response.cancelled) {
      const questionError = validateHostQuestionResponse(question, command.response);
      if (questionError) return { ok: false, error: questionError };
      await this.#rpc.request("userInput/cancel", {
        commandId: uuidv7(),
        sessionId: this.#native.sessionId,
        userInputId: command.interactionId,
      });
      this.#closeQuestion(command.interactionId, "cancelled");
      return { ok: true, value: { accepted: true } };
    }
    const questionError = validateHostQuestionResponse(question, command.response);
    if (questionError) return { ok: false, error: questionError };
    await this.#rpc.request("userInput/answer", {
      commandId: uuidv7(),
      sessionId: this.#native.sessionId,
      userInputId: command.interactionId,
      answers: museUserInputAnswers(question, command.response),
    });
    this.#closeQuestion(command.interactionId, "responded");
    return { ok: true, value: { accepted: true } };
  }

  async #selectModel(command: ModelSelectCommand): Promise<HarnessResult<{ completed: true }>> {
    if (this.#busy) {
      return {
        ok: false,
        error: { code: "sessionBusy", message: "Muse Session is busy", retryable: true },
      };
    }
    await this.#rpc.request("session/setModel", {
      commandId: uuidv7(),
      sessionId: this.#native.sessionId,
      model: { modelId: command.model.id },
    });
    this.#model = command.model;
    this.#native = { ...this.#native, modelId: command.model.id };
    this.#emit({ kind: "event", event: { type: "session.state.changed", state: this.#state() } });
    return { ok: true, value: { completed: true } };
  }

  async #selectThinking(
    command: ThinkingSelectCommand,
  ): Promise<HarnessResult<{ completed: true }>> {
    if (this.#busy) {
      return {
        ok: false,
        error: { code: "sessionBusy", message: "Muse Session is busy", retryable: true },
      };
    }
    decodeMuseThinkingOptionId(command.thinkingOptionId);
    this.#thinkingOptionId = command.thinkingOptionId;
    this.#emit({ kind: "event", event: { type: "session.state.changed", state: this.#state() } });
    return { ok: true, value: { completed: true } };
  }

  async #selectPermission(
    command: PermissionModeSelectCommand,
  ): Promise<HarnessResult<{ completed: true }>> {
    const mode = decodeMusePermissionModeId(command.permissionModeId);
    const commandId = uuidv7();
    const result = await this.#rpc.request("session/setApprovalMode", {
      commandId,
      sessionId: this.#native.sessionId,
      mode,
    });
    const effectiveMode = isRecord(result.effectiveMode) ? result.effectiveMode.mode : undefined;
    if (result.status !== "accepted" || result.commandId !== commandId || effectiveMode !== mode) {
      throw this.#protocolError("Muse session/setApprovalMode did not confirm the requested mode");
    }
    this.#permissionModeId = command.permissionModeId;
    this.#native = { ...this.#native, approvalMode: mode };
    this.#emit({ kind: "event", event: { type: "session.state.changed", state: this.#state() } });
    return { ok: true, value: { completed: true } };
  }

  #onNotification(notification: MuseRpcNotification): void {
    if (this.#closed || notification.params?.sessionId !== this.#native.sessionId) return;
    if (this.#inbox) {
      this.#inbox.push(notification);
      return;
    }
    try {
      const params = notification.params ?? {};
      if (!this.#ownsNotification(notification.method, params)) return;
      const cursor = typeof params.viewCursor === "string" ? params.viewCursor : "";
      if (cursor && notification.method !== "view/gap") {
        if (this.#seenCursors.has(cursor)) return;
        this.#seenCursors.add(cursor);
      }
      if (notification.method === "turn/completed") {
        this.#finishTurn(params);
        return;
      }
      if (notification.method === "item/started") this.#startItem(params);
      else if (notification.method === "item/delta") this.#deltaItem(params);
      else if (notification.method === "item/updated") this.#updateItem(params);
      else if (notification.method === "item/completed") this.#completeItem(params);
      else if (notification.method === "approval/requested") this.#requestApproval(params);
      else if (notification.method === "approval/updated") this.#updateApproval(params);
      else if (notification.method === "approval/resolved") this.#resolveApproval(params);
      else if (notification.method === "userInput/requested") this.#requestQuestion(params);
      else if (notification.method === "userInput/settled") this.#settleUserInput(params);
      else if (notification.method === "view/gap") void this.#fillViewGap(params);
      else if (notification.method === "session/approvalModeChanged") {
        this.#applyApprovalMode(params);
      }
    } catch {
      // A malformed item must not drop later turn/approval notifications.
    }
  }

  #ownsNotification(method: string, params: JsonObject): boolean {
    if (method === "item/delta") {
      return typeof params.itemId === "string" && this.#active?.items.has(params.itemId) === true;
    }
    if (method.startsWith("item/")) {
      if (!isRecord(params.item)) return false;
      const item = params.item;
      if (this.#active && item.turnId === this.#active.nativeTurnId) return true;
      // A known background child may change state after its foreground Turn ends.
      return (
        typeof item.itemId === "string" &&
        this.#subagents.get(item.itemId)?.nativeTurnId === item.turnId
      );
    }
    if (method === "approval/updated") {
      // MSP refreshes a registered approval by approvalId; unlike requested and
      // resolved, this event carries no turnId.
      return (
        this.#active !== null &&
        [...this.#pendingApprovals.values()].some(
          (pending) =>
            pending.nativeApprovalId === params.approvalId &&
            pending.interaction.turnId === this.#active?.command.turnId,
        )
      );
    }
    if (method === "userInput/settled") {
      const pending =
        typeof params.userInputId === "string"
          ? this.#pendingQuestions.get(params.userInputId)
          : undefined;
      return pending !== undefined && pending.turnId === this.#active?.command.turnId;
    }
    if (
      method.startsWith("turn/") ||
      method === "approval/requested" ||
      method === "approval/resolved" ||
      method === "userInput/requested"
    ) {
      return this.#active !== null && params.turnId === this.#active.nativeTurnId;
    }
    return true;
  }

  #startItem(params: JsonObject): void {
    const item = isRecord(params.item) ? params.item : params;
    const itemId = hostItemIdSchema.parse(
      typeof item.itemId === "string" && item.itemId ? item.itemId : uuidv7(),
    );
    if (
      this.#subagents.has(itemId) ||
      (typeof item.kind === "string" && (item.kind === "subagent" || item.kind === "workflow"))
    ) {
      this.#projectSubagent(item, itemId, "start");
      return;
    }
    const active = this.#active;
    if (!active) return;
    if (this.#startedItemIds.has(itemId) || active.items.has(itemId)) {
      if (active.items.has(itemId)) this.#updateItem(params);
      return;
    }
    this.#startedItemIds.add(itemId);
    if (typeof item.revision === "number") this.#itemRevisions.set(itemId, item.revision);
    const hostItem = mapMuseHostItem({ ...item, itemId }, itemId);
    if (!hostItem) return;
    if (hostItem.type === "agentMessage") active.agentItem = hostItem;
    active.items.set(itemId, hostItem);
    this.#emit({
      kind: "event",
      event: { type: "item.started", turnId: active.command.turnId, item: hostItem },
    });
    this.#emitSubagentLifecycle(hostItem);
  }

  #deltaItem(params: JsonObject): void {
    const active = this.#active;
    if (!active) return;
    const itemId = typeof params.itemId === "string" ? params.itemId : "";
    const item = active.items.get(itemId);
    const text = typeof params.delta === "string" ? params.delta : "";
    if (!item || !text) return;
    const field = typeof params.field === "string" && params.field ? params.field : "text";
    const asOutput = field === "output";
    if (item.type === "commandExecution" && (asOutput || field === "text")) {
      const suffix = text;
      item.output = `${item.output ?? ""}${suffix}`;
      this.#emit({
        kind: "event",
        event: {
          type: "item.updated",
          turnId: active.command.turnId,
          itemId: item.itemId,
          update: { type: "output.append", text: suffix },
        },
      });
      return;
    }
    if (item.type === "toolExecution" && (asOutput || field === "text")) {
      const suffix = text;
      const next = `${toolOutputText(item)}${suffix}`;
      item.output = { content: [{ type: "text", text: next }] };
      this.#emit({
        kind: "event",
        event: {
          type: "item.updated",
          turnId: active.command.turnId,
          itemId: item.itemId,
          update: { type: "output.replace", output: item.output },
        },
      });
      return;
    }
    if (item.type === "agentMessage" || item.type === "reasoning") {
      if (item.type === "agentMessage" && field !== "text") return;
      const suffix = text;
      item.text += suffix;
      this.#emit({
        kind: "event",
        event: {
          type: "item.updated",
          turnId: active.command.turnId,
          itemId: item.itemId,
          update: { type: "text.append", text: suffix },
        },
      });
    }
  }

  #updateItem(params: JsonObject): void {
    const item = isRecord(params.item) ? params.item : params;
    const itemId = typeof item.itemId === "string" ? item.itemId : "";
    if (typeof item.revision === "number") {
      if (item.revision <= (this.#itemRevisions.get(itemId) ?? 0)) return;
      this.#itemRevisions.set(itemId, item.revision);
    }
    if (
      this.#subagents.has(itemId) ||
      (typeof item.kind === "string" && (item.kind === "subagent" || item.kind === "workflow"))
    ) {
      this.#projectSubagent(item, itemId || hostItemIdSchema.parse(uuidv7()), "update");
      return;
    }
    const active = this.#active;
    if (!active) return;
    if (!active.items.has(itemId)) this.#startItem(params);
    const hostItem = active.items.get(itemId);
    if (!hostItem) return;
    const mapped = mapMuseHostItem(item, hostItem.itemId);
    if (hostItem.type === "subagentDelegation" && mapped?.type === "subagentDelegation") {
      this.#projectSubagent(item, hostItem.itemId, "update");
      return;
    }
    const text = museItemText(item);
    if (!text) return;
    if (hostItem.type === "agentMessage" || hostItem.type === "reasoning") {
      const previous = hostItem.text;
      hostItem.text = text;
      const suffix = text.startsWith(previous) ? text.slice(previous.length) : previous ? "" : text;
      if (!suffix) return;
      this.#emit({
        kind: "event",
        event: {
          type: "item.updated",
          turnId: active.command.turnId,
          itemId: hostItem.itemId,
          update: { type: "text.append", text: suffix },
        },
      });
    } else if (hostItem.type === "commandExecution") {
      const previous = hostItem.output ?? "";
      hostItem.output = text;
      const suffix = text.startsWith(previous) ? text.slice(previous.length) : previous ? "" : text;
      if (!suffix) return;
      this.#emit({
        kind: "event",
        event: {
          type: "item.updated",
          turnId: active.command.turnId,
          itemId: hostItem.itemId,
          update: { type: "output.append", text: suffix },
        },
      });
    } else if (hostItem.type === "toolExecution") {
      hostItem.output = { content: [{ type: "text", text }] };
      this.#emit({
        kind: "event",
        event: {
          type: "item.updated",
          turnId: active.command.turnId,
          itemId: hostItem.itemId,
          update: { type: "output.replace", output: hostItem.output },
        },
      });
    }
  }

  #completeItem(params: JsonObject): void {
    const item = isRecord(params.item) ? params.item : params;
    const itemId = typeof item.itemId === "string" ? item.itemId : "";
    if (
      this.#subagents.has(itemId) ||
      (typeof item.kind === "string" && (item.kind === "subagent" || item.kind === "workflow"))
    ) {
      this.#projectSubagent(item, itemId || hostItemIdSchema.parse(uuidv7()), "complete");
      return;
    }
    const active = this.#active;
    if (!active) return;
    if (!active.items.has(itemId)) this.#startItem(params);
    const hostItem = active.items.get(itemId);
    if (!hostItem) return;
    if (hostItem.type === "subagentDelegation") {
      this.#projectSubagent(item, hostItem.itemId, "complete");
      return;
    }
    const mapped = mapMuseHostItem(item, hostItem.itemId);
    let completedItem: HostItem = hostItem;
    if (hostItem.type === "agentMessage" || hostItem.type === "reasoning") {
      this.#alignStreamedText(hostItem, museItemText(item), active.command.turnId);
      completedItem = hostItem;
    } else if (mapped && mapped.type === hostItem.type) {
      completedItem = mapped;
      if (completedItem.type === "commandExecution") {
        const output = museItemText(item);
        if (output) completedItem.output = output;
      } else if (completedItem.type === "toolExecution") {
        const output = museItemText(item);
        if (output) completedItem.output = { content: [{ type: "text", text: output }] };
      }
    }
    active.items.delete(itemId);
    if (active.agentItem?.itemId === completedItem.itemId) active.agentItem = null;
    this.#emit({
      kind: "event",
      event: {
        type: "item.completed",
        turnId: active.command.turnId,
        snapshot: { item: completedItem, outcome: museHistoryItemOutcome(item) },
      },
    });
  }

  #requestApproval(params: JsonObject): void {
    const active = this.#active;
    if (!active) return;
    const approvalId =
      (typeof params.approvalId === "string" && params.approvalId.trim()) ||
      (typeof params.id === "string" && params.id.trim()) ||
      "";
    const requirementId = parseMuseRequirementRef(params.currentRequirementId);
    const actions = mapMuseApprovalActions(params.availableChoices);
    if (!approvalId || !requirementId || !museApprovalProjectionReady(actions)) return;
    const description = museApprovalDescription(params);
    const interaction: HostApprovalInteraction = {
      type: "approval",
      interactionId: hostInteractionIdSchema.parse(`${approvalId}:${requirementId.sourceIndex}`),
      turnId: active.command.turnId,
      title: museApprovalTitle(params),
      ...(description ? { description } : {}),
      subject: { type: "nativeAction" },
      actions,
    };
    this.#pendingApprovals.set(interaction.interactionId, {
      interaction,
      nativeApprovalId: approvalId,
      requirementId,
    });
    this.#emit({ kind: "interaction", interaction });
  }

  #updateApproval(params: JsonObject): void {
    const approvalId = typeof params.approvalId === "string" ? params.approvalId : "";
    if (!approvalId) return;
    this.#closeApprovals(approvalId, "superseded");
    this.#requestApproval(params);
  }

  #resolveApproval(params: JsonObject): void {
    const approvalId = typeof params.approvalId === "string" ? params.approvalId : "";
    if (!approvalId) return;
    const decision = typeof params.decision === "string" ? params.decision : "";
    const reason =
      decision === "denied" ||
      decision === "deniedPolicyAmendment" ||
      decision === "abort" ||
      decision === "timedOut"
        ? "cancelled"
        : "responded";
    this.#closeApprovals(approvalId, reason);
  }

  #closeApprovals(approvalId: string, reason: "responded" | "cancelled" | "superseded"): void {
    for (const [interactionId, pending] of this.#pendingApprovals) {
      if (pending.nativeApprovalId !== approvalId) continue;
      this.#closeApproval(interactionId, reason);
    }
  }

  #closeApproval(
    interactionId: string,
    reason: "responded" | "cancelled" | "expired" | "superseded",
  ): void {
    const pending = this.#pendingApprovals.get(interactionId);
    if (!pending) return;
    this.#pendingApprovals.delete(interactionId);
    this.#emit({
      kind: "event",
      event: {
        type: "interaction.closed",
        interactionId: pending.interaction.interactionId,
        turnId: pending.interaction.turnId,
        reason,
      },
    });
  }

  #closeQuestion(
    interactionId: string,
    reason: "responded" | "cancelled" | "expired" | "superseded",
  ): void {
    const question = this.#pendingQuestions.get(interactionId);
    if (!question) return;
    this.#pendingQuestions.delete(interactionId);
    this.#emit({
      kind: "event",
      event: {
        type: "interaction.closed",
        interactionId: question.interactionId,
        turnId: question.turnId,
        reason,
      },
    });
  }

  #requestQuestion(params: JsonObject): void {
    const active = this.#active;
    if (!active) return;
    const userInputId =
      (typeof params.userInputId === "string" && params.userInputId.trim()) ||
      (typeof params.id === "string" && params.id.trim()) ||
      uuidv7();
    const questions = mapMuseUserInputQuestions(params.questions);
    const interaction: HostQuestionInteraction = {
      type: "question",
      interactionId: hostInteractionIdSchema.parse(userInputId),
      turnId: active.command.turnId,
      title:
        (typeof params.toolName === "string" && params.toolName.trim()) ||
        (typeof params.title === "string" && params.title.trim()) ||
        "Muse question",
      questions:
        questions.length > 0
          ? questions
          : [
              {
                id: "answer",
                type: "text",
                prompt: typeof params.prompt === "string" ? params.prompt : "Answer",
                multiline: false,
                secret: false,
                optional: false,
              },
            ],
    };
    this.#pendingQuestions.set(interaction.interactionId, interaction);
    this.#emit({ kind: "interaction", interaction });
  }

  #settleUserInput(params: JsonObject): void {
    const userInputId = typeof params.userInputId === "string" ? params.userInputId : "";
    if (!userInputId) return;
    const outcome = typeof params.outcome === "string" ? params.outcome : "";
    this.#closeQuestion(userInputId, outcome === "answered" ? "responded" : "cancelled");
  }

  #alignStreamedText(
    hostItem: HostAgentMessageItem | Extract<HostItem, { type: "reasoning" }>,
    nativeText: string,
    turnId: TurnStartCommand["turnId"],
  ): void {
    if (!nativeText || nativeText === hostItem.text) return;
    if (!nativeText.startsWith(hostItem.text)) return;
    const suffix = nativeText.slice(hostItem.text.length);
    if (!suffix) return;
    hostItem.text = nativeText;
    this.#emit({
      kind: "event",
      event: {
        type: "item.updated",
        turnId,
        itemId: hostItem.itemId,
        update: { type: "text.append", text: suffix },
      },
    });
  }

  #finishTurn(params: JsonObject): void {
    if (!this.#active || params.turnId !== this.#active.nativeTurnId) return;
    if (params.terminal === "cancelled") this.#completeTurn({ status: "cancelled" });
    else if (params.terminal === "failed")
      this.#completeTurn({ status: "failed", error: museTurnError(params) });
    else if (params.terminal === "completed") this.#completeTurn({ status: "succeeded" });
    else
      this.#completeTurn({
        status: "failed",
        error: this.#protocolError("Muse returned an unknown Turn terminal").harnessError,
      });
  }

  #completeTurn(outcome: TurnOutcome): void {
    const active = this.#active;
    if (!active) return;
    for (const item of active.items.values()) {
      if (item.type === "subagentDelegation") {
        const tracked = this.#subagents.get(item.itemId);
        if (tracked?.hostCompleted) continue;
        this.#completeSubagentHostItem(item, active.command.turnId, outcome);
        continue;
      }
      this.#emit({
        kind: "event",
        event: {
          type: "item.completed",
          turnId: active.command.turnId,
          snapshot: {
            item,
            outcome: outcome.status === "failed" ? outcome : { status: outcome.status },
          },
        },
      });
    }
    for (const pending of this.#pendingApprovals.values()) {
      this.#emit({
        kind: "event",
        event: {
          type: "interaction.closed",
          interactionId: pending.interaction.interactionId,
          turnId: pending.interaction.turnId,
          reason: "cancelled",
        },
      });
    }
    for (const interaction of this.#pendingQuestions.values()) {
      this.#emit({
        kind: "event",
        event: {
          type: "interaction.closed",
          interactionId: interaction.interactionId,
          turnId: interaction.turnId,
          reason: "cancelled",
        },
      });
    }
    this.#pendingApprovals.clear();
    this.#pendingQuestions.clear();
    this.#seenCursors.clear();
    this.#startedItemIds.clear();
    this.#itemRevisions.clear();
    this.#active = null;
    this.#busy = false;
    const nativeTurnRef = nativeTurnRefSchema.parse({
      harnessId: MUSE_HARNESS_ID,
      nativeSessionId: this.#native.sessionId,
      nativeTurnKey: active.nativeTurnId,
      formatVersion: 1,
    });
    const checkpoint = nativeCheckpointRefSchema.parse({
      harnessId: MUSE_HARNESS_ID,
      nativeSessionId: this.#native.sessionId,
      checkpointId: active.nativeTurnId,
      formatVersion: 1,
    });
    this.#emit({
      kind: "event",
      event: {
        type: "turn.completed",
        turnId: active.command.turnId,
        nativeTurnRef,
        outcome: { ...outcome, checkpoint: outcome.checkpoint ?? checkpoint },
      },
    });
    void this.#reconcileSubagents();
  }

  #state(): HarnessSessionState {
    return {
      nativeRef: this.nativeRef,
      ...(this.#model ? { effectiveModel: this.#model, resolvedModelLabel: this.#model.id } : {}),
      effectiveThinkingOptionId: this.#thinkingOptionId,
      availableThinkingOptions: MUSE_THINKING_OPTIONS.map((option) => ({
        id: museThinkingOptionId(option.id),
        label: option.label,
      })),
      effectivePermissionModeId: this.#permissionModeId,
    };
  }

  #applyApprovalMode(params: JsonObject): void {
    const mode = typeof params.mode === "string" ? params.mode : "";
    if (!mode) return;
    try {
      decodeMusePermissionModeId(mode as HarnessPermissionModeId);
    } catch {
      return;
    }
    this.#permissionModeId = mode as HarnessPermissionModeId;
    this.#native = { ...this.#native, approvalMode: mode as MuseApprovalMode };
    this.#emit({ kind: "event", event: { type: "session.state.changed", state: this.#state() } });
  }

  async #fillViewGap(params: JsonObject): Promise<void> {
    const after = typeof params.after === "string" ? params.after : "";
    const next = typeof params.next === "string" ? params.next : "";
    const sessionId =
      typeof params.sessionId === "string" ? params.sessionId : this.#native.sessionId;
    if (!after || !next) return;
    let cursor: string | undefined = after;
    const seen = new Set<string>([after, next]);
    try {
      for (let pageIndex = 0; pageIndex < 32 && cursor; pageIndex += 1) {
        const page = await this.#rpc.request("view/page", {
          sessionId,
          cursor,
          direction: "forward",
          limit: 1000,
        });
        const events = Array.isArray(page.events) ? page.events.filter(isRecord) : [];
        let reachedNext = false;
        for (const event of events) {
          const method = typeof event.method === "string" ? event.method : "";
          const eventParams = isRecord(event.params) ? event.params : {};
          const viewCursor =
            typeof eventParams.viewCursor === "string" ? eventParams.viewCursor : "";
          if (viewCursor === next) {
            reachedNext = true;
            continue;
          }
          if (!method || method === "view/gap" || seen.has(viewCursor)) continue;
          if (viewCursor) seen.add(viewCursor);
          this.#onNotification({ method, params: eventParams });
        }
        const nextCursor = typeof page.nextCursor === "string" ? page.nextCursor : "";
        if (reachedNext || !nextCursor || nextCursor === next || nextCursor === cursor) break;
        cursor = nextCursor;
      }
    } catch {
      // Gap fill is best-effort; a missed page must not fault the Session.
    }
  }

  #projectSubagent(
    museItem: JsonObject,
    itemId: string,
    source: "start" | "update" | "complete",
  ): void {
    const mapped = mapMuseHostItem({ ...museItem, itemId }, itemId);
    if (!mapped || mapped.type !== "subagentDelegation") return;
    const existing = this.#subagents.get(itemId);
    const revision = typeof museItem.revision === "number" ? museItem.revision : 0;
    if (existing && revision > 0 && revision <= existing.revision) return;
    const turnId = existing?.turnId ?? this.#active?.command.turnId;
    const active = this.#active?.command.turnId === turnId ? this.#active : null;
    if (!turnId) return;
    const item: HostSubagentDelegationItem = existing
      ? { ...existing.item, ...mapped, itemId: existing.item.itemId, subagents: mapped.subagents }
      : mapped;
    const tracked: TrackedMuseSubagent = existing ?? {
      item,
      turnId,
      nativeTurnId: String(museItem.turnId ?? active?.nativeTurnId ?? ""),
      revision,
      hostCompleted: false,
    };
    tracked.revision = revision;
    tracked.item = item;
    tracked.turnId = turnId;
    this.#subagents.set(item.itemId, tracked);
    if (active && !tracked.hostCompleted) active.items.set(item.itemId, item);

    const recovering = museSubagentIsRecovering(museItem);
    if (recovering) void this.#resumeSubagent(item);
    const terminal = museSubagentIsTerminal(museItem);
    const finishHost = source === "complete" ? terminal : false;

    if (!tracked.hostCompleted && active) {
      if (!existing) {
        this.#startedItemIds.add(item.itemId);
        this.#emit({
          kind: "event",
          event: { type: "item.started", turnId, item },
        });
      } else {
        this.#emit({
          kind: "event",
          event: {
            type: "item.updated",
            turnId,
            itemId: item.itemId,
            update: { type: "subagents.replace", subagents: item.subagents },
          },
        });
      }
    }
    this.#emitSubagentLifecycle(item);
    if (finishHost && !tracked.hostCompleted && active) {
      this.#completeSubagentHostItem(item, turnId, this.#subagentOutcome(item));
    }
  }

  #completeSubagentHostItem(
    item: HostSubagentDelegationItem,
    turnId: TurnStartCommand["turnId"],
    outcome: TurnOutcome | HostItemOutcome,
  ): void {
    const tracked = this.#subagents.get(item.itemId);
    if (tracked?.hostCompleted) return;
    const hostOutcome: HostItemOutcome =
      outcome.status === "failed"
        ? outcome
        : outcome.status === "cancelled"
          ? { status: "cancelled", reason: "reason" in outcome ? outcome.reason : "Cancelled" }
          : this.#subagentOutcome(item);
    if (tracked) tracked.hostCompleted = true;
    this.#active?.items.delete(item.itemId);
    this.#emit({
      kind: "event",
      event: {
        type: "item.completed",
        turnId,
        snapshot: { item, outcome: hostOutcome },
      },
    });
    this.#emitSubagentLifecycle(item);
  }

  #subagentOutcome(item: HostSubagentDelegationItem): HostItemOutcome {
    if (
      item.subagents.some(
        (subagent) => subagent.status === "running" || subagent.status === "pending",
      )
    ) {
      return { status: "succeeded" };
    }
    if (item.subagents.every((subagent) => subagent.status === "failed")) {
      const message =
        item.subagents.find((subagent) => subagent.resultSummary)?.resultSummary ??
        "Muse Subagent failed";
      return {
        status: "failed",
        error: { code: "nativeFailure", message, retryable: false },
      };
    }
    if (item.subagents.some((subagent) => subagent.status === "interrupted")) {
      return { status: "cancelled", reason: "Muse Subagent interrupted" };
    }
    return { status: "succeeded" };
  }

  #resumeSubagent(item: HostSubagentDelegationItem): void {
    if (this.#closed) return;
    for (const subagent of item.subagents) {
      const subagentId = subagent.nativeSubagentId ?? subagent.subagentId;
      if (!subagentId || this.#resumedSubagents.has(subagentId)) continue;
      this.#resumedSubagents.add(subagentId);
      void this.#rpc
        .request("subagent/resume", {
          commandId: uuidv7(),
          sessionId: this.#native.sessionId,
          subagentId,
        })
        .then(() => this.#reconcileSubagents())
        .catch(() => undefined);
    }
  }

  async #reconcileSubagents(): Promise<void> {
    if (this.#closed) return;
    try {
      const history = await readMuseHistory(this.#rpc, this.#native.sessionId);
      if (this.#closed) return;
      const items = Array.isArray(history?.items) ? history.items.filter(isRecord) : [];
      for (const item of items) {
        const kind = typeof item.kind === "string" ? item.kind : "";
        if (kind !== "subagent" && kind !== "workflow") continue;
        if (item.turnId !== this.#active?.nativeTurnId && !this.#subagents.has(String(item.itemId)))
          continue;
        const itemId =
          typeof item.itemId === "string" && item.itemId
            ? item.itemId
            : hostItemIdSchema.parse(uuidv7());
        this.#projectSubagent(item, itemId, museSubagentIsTerminal(item) ? "complete" : "update");
      }
    } catch {
      // History reconcile is best-effort; live notifications remain authoritative.
    }
  }

  #emitSubagentLifecycle(item: HostItem): void {
    if (item.type !== "subagentDelegation") return;
    for (const subagent of item.subagents) {
      const nativeSubagentId = subagent.nativeSubagentId ?? subagent.subagentId;
      this.#emit({
        kind: "event",
        event: {
          type: "subagent.state.changed",
          nativeSubagentId,
          status: subagent.status,
          ...(subagent.resultSummary ? { resultSummary: subagent.resultSummary } : {}),
        },
      });
      this.#emit({
        kind: "event",
        event: { type: "subagent.transcript.changed", nativeSubagentId },
      });
    }
  }

  #emit(output: HarnessOutput): void {
    // The channel is asynchronous. Later native deltas must not mutate an Item
    // already queued as item.started, or the Desktop projector appends it twice.
    this.#channel.emit(structuredClone(output));
  }
}

export function nativeSessionFromResult(result: JsonObject): MuseNativeSession {
  const session = isRecord(result.session) ? result.session : result;
  const approval = isRecord(session.approvalMode)
    ? session.approvalMode.mode
    : session.approvalMode;
  return {
    sessionId: String(session.sessionId ?? ""),
    ...(typeof session.modelId === "string" ? { modelId: session.modelId } : {}),
    ...(typeof approval === "string" ? { approvalMode: approval as MuseApprovalMode } : {}),
  };
}
