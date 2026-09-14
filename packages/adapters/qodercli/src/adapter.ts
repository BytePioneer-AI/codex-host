import { randomUUID } from "node:crypto";
import path from "node:path";
import { forkSession as forkQoderNativeSession } from "@qoder-ai/qoder-agent-sdk";
import {
  HarnessOutputChannel,
  sanitizeDiagnosticTail,
  validateHostApprovalResponse,
  validateHostQuestionResponse,
  type HarnessAdapter,
  type HarnessError,
  type HarnessInspection,
  type HarnessOutput,
  type HarnessResult,
  type HarnessSession,
  type HarnessSessionState,
  type HostApprovalInteraction,
  type HostCommand,
  type HostEvent,
  type HostInteraction,
  type HostItem,
  type HostItemOutcome,
  type HostQuestionInteraction,
  type HostThreadSnapshot,
  type InspectHarnessInput,
  type InteractionRespondAccepted,
  type InteractionRespondCommand,
  type ModelSelectCommand,
  type ModelSelectCompleted,
  type OpenSessionInput,
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
  harnessInspectionSchema,
  hostInteractionIdSchema,
  hostItemIdSchema,
  nativeSessionRefSchema,
  nativeTurnRefSchema,
  type HarnessId,
  type HostInteractionId,
  type HostItemId,
  type HostTurnId,
  type NativeSessionRef,
} from "@codexhost/shared-contracts";

import { QoderExecutableError, resolveQoderExecutable } from "./command.js";
import { readQoderSnapshot } from "./history.js";
import {
  qoderStatusRequiresAuthentication,
  readQoderListModels,
  readQoderStatus,
} from "./list-models.js";
import {
  decodeQoderModelRef,
  parseQoderListModels,
  QODER_CAPABILITIES,
  qoderModelRef,
} from "./models.js";
import {
  decodeQoderPermissionMode,
  encodeQoderPermissionMode,
  QODER_PERMISSION_MODE_CATALOG,
  type QoderPermissionMode,
} from "./permission-modes.js";
import { QoderSdkTransport, type QoderQueryFactory, type QoderTurnEvent } from "./sdk-transport.js";

const HARNESS_ID = harnessIdSchema.parse("qodercli");

export interface QoderAdapterOptions {
  environment?: NodeJS.ProcessEnv;
  command?: string;
  timeoutMs?: number;
  closeTimeoutMs?: number;
  listModels?: (cwd: string) => Promise<string>;
  readStatus?: (cwd: string) => Promise<string>;
  queryFactory?: QoderQueryFactory;
  forkSession?: (input: {
    sourceSessionId: string;
    cwd: string;
    upToMessageId?: string;
  }) => Promise<{ sessionId: string }>;
  readSnapshot?: (nativeRef: NativeSessionRef, cwd: string) => HostThreadSnapshot;
}

function rejected(
  code: HarnessError["code"],
  message: string,
  retryable = false,
): { ok: false; error: HarnessError } {
  return { ok: false, error: { code, message, retryable } };
}

export function qoderError(error: unknown): HarnessError {
  const message = sanitizeDiagnosticTail(
    error instanceof Error ? error.message : "Qoder operation failed",
  );
  if (error instanceof QoderExecutableError || /not installed/iu.test(message)) {
    return { code: "notInstalled", message, retryable: false };
  }
  if (/auth|not logged in|login|sign in/iu.test(message)) {
    return { code: "authenticationRequired", message, retryable: false };
  }
  if (/exited|closed/iu.test(message)) return { code: "processExited", message, retryable: false };
  return { code: "protocolError", message, retryable: false };
}

export class QoderAdapter implements HarnessAdapter {
  readonly harnessId: HarnessId = HARNESS_ID;
  readonly #sessions = new Set<QoderSession>();
  readonly #inspections = new Map<
    string,
    { expires: number; pending: boolean; result: Promise<HarnessInspection> }
  >();
  #closed = false;

  constructor(readonly options: QoderAdapterOptions = {}) {}

  async inspect(input: InspectHarnessInput = {}): Promise<HarnessInspection> {
    if (this.#closed) {
      return {
        status: "unavailable",
        error: { code: "unavailable", message: "Qoder adapter is closed", retryable: false },
      };
    }
    const cwd = path.resolve(input.cwd ?? process.cwd());
    const cached = this.#inspections.get(cwd);
    if (cached && (cached.pending || (!input.refresh && cached.expires > Date.now()))) {
      return cached.result;
    }
    const result = this.#inspectCwd(cwd);
    const entry = { expires: Number.POSITIVE_INFINITY, pending: true, result };
    this.#inspections.set(cwd, entry);
    void result.then((inspection) => {
      if (this.#inspections.get(cwd) !== entry) return;
      entry.pending = false;
      if (inspection.status === "ready") entry.expires = Date.now() + 5 * 60_000;
      else this.#inspections.delete(cwd);
    });
    return result;
  }

  async open(input: OpenSessionInput): Promise<HarnessResult<HarnessSession>> {
    if (this.#closed) return rejected("invalidState", "Qoder adapter is closed");
    if (input.kind === "rollbackLastTurn") {
      return rejected("unsupported", "Qoder last-Turn rollback is not verified yet");
    }
    if (input.kind === "resume" && input.nativeRef.harnessId !== this.harnessId) {
      return rejected("invalidRequest", "Session belongs to another Harness");
    }
    if (input.kind === "fork" && input.sourceRef.harnessId !== this.harnessId) {
      return rejected("invalidRequest", "Session belongs to another Harness");
    }
    let transport: QoderSdkTransport | undefined;
    try {
      resolveQoderExecutable({
        ...(this.options.command ? { command: this.options.command } : {}),
        environment: { ...(this.options.environment ?? process.env), ...input.environment },
      });
      const environment = { ...(this.options.environment ?? process.env), ...input.environment };
      const cwd = path.resolve(input.cwd);
      let sessionId: string;
      let openMode: "create" | "resume" = "create";
      if (input.kind === "create") {
        sessionId = randomUUID();
      } else if (input.kind === "resume") {
        sessionId = input.nativeRef.nativeSessionId;
        openMode = "resume";
      } else {
        const forked = await (this.options.forkSession ?? defaultForkSession)({
          sourceSessionId: input.sourceRef.nativeSessionId,
          cwd,
          upToMessageId: input.checkpoint.checkpointId,
        });
        sessionId = forked.sessionId;
        openMode = "resume";
      }
      const model =
        input.kind === "fork" || !("model" in input) || !input.model
          ? undefined
          : decodeQoderModelRef(input.model);
      const permissionMode: QoderPermissionMode =
        input.kind === "fork" || !("permissionModeId" in input) || !input.permissionModeId
          ? "default"
          : decodeQoderPermissionMode(input.permissionModeId);
      const holder: { session?: QoderSession } = {};
      transport = new QoderSdkTransport({
        cwd,
        environment,
        ...(this.options.command ? { command: this.options.command } : {}),
        sessionId,
        openMode,
        ...(model ? { model } : {}),
        permissionMode,
        unattended: input.kind === "create" && input.executionPolicy === "unattended-full-access",
        ...(this.options.closeTimeoutMs ? { closeTimeoutMs: this.options.closeTimeoutMs } : {}),
        ...(this.options.queryFactory ? { queryFactory: this.options.queryFactory } : {}),
        onFault: (error) => holder.session?.fault(qoderError(error)),
        onIdentity: (nativeSessionId) => holder.session?.updateIdentity(nativeSessionId),
      });
      await transport.start();
      const nativeRef = nativeSessionRefSchema.parse({
        harnessId: this.harnessId,
        nativeSessionId: transport.sessionId,
        formatVersion: 1,
      });
      const initialState: HarnessSessionState = {
        nativeRef,
        ...(model ? { effectiveModel: qoderModelRef(model) } : {}),
        effectivePermissionModeId: encodeQoderPermissionMode(permissionMode),
      };
      const session = new QoderSession(
        transport,
        nativeRef,
        initialState,
        cwd,
        environment,
        () => this.#sessions.delete(session),
        this.options.readSnapshot,
      );
      holder.session = session;
      this.#sessions.add(session);
      return { ok: true, value: session };
    } catch (error) {
      await transport?.close().catch(() => undefined);
      return { ok: false, error: qoderError(error) };
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    await Promise.all([...this.#sessions].map((session) => session.close()));
  }

  async #inspectCwd(cwd: string): Promise<HarnessInspection> {
    try {
      resolveQoderExecutable({
        ...(this.options.command ? { command: this.options.command } : {}),
        environment: this.options.environment ?? process.env,
      });
      const environment = this.options.environment ?? process.env;
      const status = this.options.readStatus
        ? await this.options.readStatus(cwd)
        : await readQoderStatus({
            cwd,
            environment,
            ...(this.options.command ? { command: this.options.command } : {}),
            ...(this.options.timeoutMs ? { timeoutMs: this.options.timeoutMs } : {}),
          });
      if (qoderStatusRequiresAuthentication(status)) {
        return {
          status: "error",
          error: {
            code: "authenticationRequired",
            message: "Qoder CLI authentication is required",
            retryable: false,
          },
        };
      }
      const text = this.options.listModels
        ? await this.options.listModels(cwd)
        : await readQoderListModels({
            cwd,
            environment,
            ...(this.options.command ? { command: this.options.command } : {}),
            ...(this.options.timeoutMs ? { timeoutMs: this.options.timeoutMs } : {}),
          });
      return harnessInspectionSchema.parse({
        status: "ready",
        catalog: parseQoderListModels(text),
        permissionModes: QODER_PERMISSION_MODE_CATALOG,
        capabilities: QODER_CAPABILITIES,
      });
    } catch (error) {
      const failure = qoderError(error);
      return {
        status: failure.code === "notInstalled" ? "notInstalled" : "error",
        error: failure,
      };
    }
  }
}

async function defaultForkSession(input: {
  sourceSessionId: string;
  cwd: string;
  upToMessageId?: string;
}): Promise<{ sessionId: string }> {
  return forkQoderNativeSession(input.sourceSessionId, {
    dir: input.cwd,
    ...(input.upToMessageId ? { upToMessageId: input.upToMessageId } : {}),
  });
}

class QoderSession implements HarnessSession {
  readonly harnessId: HarnessId = HARNESS_ID;
  readonly capabilities = QODER_CAPABILITIES;
  readonly initialState: HarnessSessionState;
  readonly initialUsage = null;
  readonly outputs: AsyncIterable<HarnessOutput>;
  readonly #channel = new HarnessOutputChannel<HarnessOutput>();
  readonly #transport: QoderSdkTransport;
  #nativeRef: NativeSessionRef;
  readonly #cwd: string;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #onClosed: () => void;
  readonly #readSnapshot:
    ((nativeRef: NativeSessionRef, cwd: string) => HostThreadSnapshot) | undefined;
  #state: HarnessSessionState;
  #activeTurn: {
    turnId: HostTurnId;
    items: Map<string, { itemId: HostItemId; item: HostItem }>;
    interactions: Map<HostInteractionId, HostInteraction>;
  } | null = null;
  #busy = false;
  #closed = false;
  #faulted: HarnessError | undefined;
  #itemOrdinal = 0;

  constructor(
    transport: QoderSdkTransport,
    nativeRef: NativeSessionRef,
    initialState: HarnessSessionState,
    cwd: string,
    environment: NodeJS.ProcessEnv,
    onClosed: () => void,
    readSnapshot?: (nativeRef: NativeSessionRef, cwd: string) => HostThreadSnapshot,
  ) {
    this.#transport = transport;
    this.#nativeRef = nativeRef;
    this.initialState = initialState;
    this.#state = initialState;
    this.#cwd = cwd;
    this.#environment = environment;
    this.#onClosed = onClosed;
    this.#readSnapshot = readSnapshot;
    this.outputs = this.#channel.outputs;
  }

  fault(error: HarnessError): void {
    if (this.#closed || this.#faulted) return;
    this.#faulted = error;
    this.#emit({ type: "session.faulted", error });
  }

  updateIdentity(nativeSessionId: string): void {
    if (this.#closed || this.#faulted || this.#nativeRef.nativeSessionId === nativeSessionId)
      return;
    this.#nativeRef = nativeSessionRefSchema.parse({
      harnessId: this.harnessId,
      nativeSessionId,
      formatVersion: 1,
    });
    this.#state = { ...this.#state, nativeRef: this.#nativeRef };
    this.#emit({ type: "session.state.changed", state: this.#state });
  }

  async readSnapshot(): Promise<HarnessResult<HostThreadSnapshot>> {
    if (this.#closed) return rejected("invalidState", "Qoder Session is closed");
    if (this.#busy) return rejected("sessionBusy", "Qoder Session is busy", true);
    try {
      const snapshot = this.#readSnapshot
        ? this.#readSnapshot(this.#nativeRef, this.#cwd)
        : readQoderSnapshot(this.#nativeRef, this.#cwd, this.#environment);
      return { ok: true, value: { ...snapshot, state: this.#state } };
    } catch (error) {
      return { ok: false, error: qoderError(error) };
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
    if (this.#closed || this.#faulted) {
      return rejected(
        "invalidState",
        this.#closed ? "Qoder Session is closed" : "Qoder Session has faulted",
      );
    }
    switch (command.type) {
      case "turn.start":
        return this.#startTurn(command);
      case "turn.cancel":
        return this.#cancelTurn(command);
      case "interaction.respond":
        return this.#respond(command);
      case "model.select":
        return this.#selectModel(command);
      case "thinking.select":
        return rejected("unsupported", "Qoder Thinking options are not selectable yet");
      case "permissionMode.select":
        return this.#selectPermissionMode(command);
      default: {
        const exhaustive: never = command;
        return rejected(
          "invalidRequest",
          `Unsupported command ${(exhaustive as HostCommand).type}`,
        );
      }
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#transport.close().catch(() => undefined);
    this.#channel.end();
    this.#onClosed();
  }

  #startTurn(command: TurnStartCommand): HarnessResult<TurnStartAccepted> {
    if (this.#busy || this.#activeTurn) {
      return rejected("sessionBusy", "Qoder Session already has an active Turn", true);
    }
    const text = command.input.map((chunk) => chunk.text).join("\n");
    if (text.trim().length === 0) {
      return rejected("invalidRequest", "Qoder Turn input must not be empty");
    }
    this.#busy = true;
    this.#activeTurn = { turnId: command.turnId, items: new Map(), interactions: new Map() };
    void this.#runTurn(command, text, randomUUID());
    return { ok: true, value: { turnId: command.turnId } };
  }

  async #runTurn(command: TurnStartCommand, text: string, nativeTurnKey: string): Promise<void> {
    this.#emit({ type: "turn.started", turnId: command.turnId });
    try {
      const result = await this.#transport.runTurn(text, nativeTurnKey, (event) => {
        this.#onTurnEvent(command.turnId, event);
      });
      const outcome: TurnOutcome =
        result.status === "succeeded"
          ? { status: "succeeded" }
          : result.status === "cancelled"
            ? { status: "cancelled" }
            : {
                status: "failed",
                error: {
                  code: "nativeFailure",
                  message: result.errorMessage ?? "Qoder Turn failed",
                  retryable: false,
                },
              };
      this.#completeOpenItems(command.turnId, outcome);
      this.#emit({
        type: "turn.completed",
        turnId: command.turnId,
        nativeTurnRef: nativeTurnRefSchema.parse({
          harnessId: this.harnessId,
          nativeSessionId: this.#transport.sessionId,
          nativeTurnKey: result.nativeTurnKey,
          formatVersion: 1,
        }),
        outcome,
      });
    } catch (error) {
      const failure = qoderError(error);
      this.#completeOpenItems(command.turnId, { status: "failed", error: failure });
      this.#emit({
        type: "turn.completed",
        turnId: command.turnId,
        outcome: { status: "failed", error: failure },
      });
    } finally {
      this.#activeTurn = null;
      this.#busy = false;
    }
  }

  async #cancelTurn(command: TurnCancelCommand): Promise<HarnessResult<TurnCancelAccepted>> {
    if (!this.#activeTurn || this.#activeTurn.turnId !== command.turnId) {
      return rejected("invalidRequest", "Qoder Turn is not active");
    }
    await this.#transport.cancel();
    return { ok: true, value: { cancellationRequested: true } };
  }

  async #respond(
    command: InteractionRespondCommand,
  ): Promise<HarnessResult<InteractionRespondAccepted>> {
    const pending = this.#activeTurn?.interactions.get(command.interactionId);
    if (!this.#activeTurn || !pending) {
      return rejected("invalidRequest", "Qoder Interaction is not pending");
    }
    try {
      if (command.response.type === "approval") {
        if (pending.type !== "approval") {
          return rejected("invalidRequest", "Qoder Approval is not pending");
        }
        const response = command.response;
        const invalid = validateHostApprovalResponse(pending, response);
        if (invalid) return { ok: false, error: invalid };
        const action = pending.actions.find((entry) => entry.id === response.actionId);
        await this.#transport.respondToInteraction({
          type: "approval",
          requestId: command.interactionId,
          decision:
            action?.effect === "deny"
              ? "deny"
              : action?.effect === "allowForSession"
                ? "allowForSession"
                : "allowOnce",
        });
        return { ok: true, value: { accepted: true } };
      }
      if (pending.type !== "question") {
        return rejected("invalidRequest", "Qoder Question is not pending");
      }
      const response = command.response;
      const invalid = validateHostQuestionResponse(pending, response);
      if (invalid) return { ok: false, error: invalid };
      const answers: Record<string, string> = {};
      for (const [questionId, values] of Object.entries(response.answers)) {
        answers[questionId] = values.join(", ");
      }
      await this.#transport.respondToInteraction({
        type: "question",
        requestId: command.interactionId,
        answers,
        ...(response.cancelled ? { cancelled: true } : {}),
      });
      return { ok: true, value: { accepted: true } };
    } catch (error) {
      return { ok: false, error: qoderError(error) };
    }
  }

  async #selectModel(command: ModelSelectCommand): Promise<HarnessResult<ModelSelectCompleted>> {
    if (this.#busy) return rejected("sessionBusy", "Qoder Session is busy", true);
    try {
      const native = decodeQoderModelRef(command.model);
      await this.#transport.setModel(native);
      this.#state = { ...this.#state, effectiveModel: command.model };
      this.#emit({ type: "session.state.changed", state: this.#state });
      return { ok: true, value: { completed: true } };
    } catch (error) {
      return { ok: false, error: qoderError(error) };
    }
  }

  async #selectPermissionMode(
    command: PermissionModeSelectCommand,
  ): Promise<HarnessResult<PermissionModeSelectCompleted>> {
    if (this.#busy) return rejected("sessionBusy", "Qoder Session is busy", true);
    try {
      const mode = decodeQoderPermissionMode(command.permissionModeId);
      await this.#transport.setPermissionMode(mode);
      this.#state = {
        ...this.#state,
        effectivePermissionModeId: encodeQoderPermissionMode(mode),
      };
      this.#emit({ type: "session.state.changed", state: this.#state });
      return { ok: true, value: { completed: true } };
    } catch (error) {
      return { ok: false, error: qoderError(error) };
    }
  }

  #onTurnEvent(turnId: HostTurnId, event: QoderTurnEvent): void {
    if (event.type === "text.delta") {
      this.#appendText(turnId, event.itemKey, "agentMessage", event.delta);
      return;
    }
    if (event.type === "reasoning.delta") {
      this.#appendText(turnId, event.itemKey, "reasoning", event.delta);
      return;
    }
    if (event.type === "tool.started") {
      const itemId = this.#nextItemId();
      const item: HostItem = {
        type: "toolExecution",
        itemId,
        toolName: event.toolName,
        arguments: event.arguments,
      };
      this.#activeTurn?.items.set(event.callId, { itemId, item });
      this.#emit({ type: "item.started", turnId, item });
      return;
    }
    if (event.type === "tool.completed") {
      const open = this.#activeTurn?.items.get(event.callId);
      if (!open || open.item.type !== "toolExecution") return;
      const snapshot = {
        item: {
          ...open.item,
          output: { content: [{ type: "text" as const, text: event.output }] },
        },
        outcome: (event.isError
          ? {
              status: "failed" as const,
              error: {
                code: "nativeFailure" as const,
                message: event.output || "Qoder Tool failed",
                retryable: false,
              },
            }
          : { status: "succeeded" as const }) satisfies HostItemOutcome,
      };
      this.#activeTurn?.items.delete(event.callId);
      this.#emit({ type: "item.completed", turnId, snapshot });
      return;
    }
    if (event.type === "interaction.requested") {
      const interactionId = hostInteractionIdSchema.parse(event.request.requestId);
      if (event.request.type === "approval") {
        const interaction: HostApprovalInteraction = {
          type: "approval",
          interactionId,
          turnId,
          title: event.request.title,
          ...(event.request.description ? { description: event.request.description } : {}),
          subject: { type: "nativeAction" },
          actions: [
            { id: "allow-once", label: "Allow once", effect: "allowOnce" },
            { id: "allow-session", label: "Allow for session", effect: "allowForSession" },
            { id: "deny", label: "Deny", effect: "deny" },
          ],
        };
        this.#activeTurn?.interactions.set(interactionId, interaction);
        this.#channel.emit({ kind: "interaction", interaction });
        return;
      }
      const interaction: HostQuestionInteraction = {
        type: "question",
        interactionId,
        turnId,
        questions: event.request.questions.map((question) => ({
          id: question.question,
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
      this.#activeTurn?.interactions.set(interactionId, interaction);
      this.#channel.emit({ kind: "interaction", interaction });
      return;
    }
    this.#activeTurn?.interactions.delete(hostInteractionIdSchema.parse(event.requestId));
    this.#emit({
      type: "interaction.closed",
      interactionId: hostInteractionIdSchema.parse(event.requestId),
      turnId,
      reason: event.reason,
    });
  }

  #appendText(
    turnId: HostTurnId,
    key: string,
    type: "agentMessage" | "reasoning",
    delta: string,
  ): void {
    const existing = this.#activeTurn?.items.get(key);
    if (!existing) {
      const itemId = this.#nextItemId();
      const item: HostItem =
        type === "agentMessage"
          ? { type: "agentMessage", itemId, text: delta }
          : { type: "reasoning", itemId, text: delta };
      this.#activeTurn?.items.set(key, { itemId, item });
      this.#emit({ type: "item.started", turnId, item });
      return;
    }
    if (existing.item.type !== type) return;
    existing.item = { ...existing.item, text: `${existing.item.text}${delta}` };
    this.#emit({
      type: "item.updated",
      turnId,
      itemId: existing.itemId,
      update: { type: "text.append", text: delta },
    });
  }

  #completeOpenItems(turnId: HostTurnId, outcome: TurnOutcome): void {
    const items = this.#activeTurn?.items;
    if (!items) return;
    for (const open of items.values()) {
      const itemOutcome: HostItemOutcome =
        outcome.status === "succeeded"
          ? { status: "succeeded" }
          : outcome.status === "cancelled"
            ? { status: "cancelled" }
            : { status: "failed", error: outcome.error };
      this.#emit({
        type: "item.completed",
        turnId,
        snapshot: { item: open.item, outcome: itemOutcome },
      });
    }
    items.clear();
  }

  #nextItemId(): HostItemId {
    this.#itemOrdinal += 1;
    return hostItemIdSchema.parse(`qoder-item-${this.#itemOrdinal}`);
  }

  #emit(event: HostEvent): void {
    this.#channel.emit({ kind: "event", event });
  }
}
