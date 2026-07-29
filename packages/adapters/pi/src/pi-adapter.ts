import { parsePatch } from "diff";
import { randomUUID } from "node:crypto";

import {
  HarnessOutputChannel,
  validateHostQuestionResponse,
  type CreateSessionInput,
  type HarnessAdapter,
  type HarnessError,
  type HarnessOutput,
  type HarnessResult,
  type HarnessSession,
  type HarnessSessionState,
  type HostAgentMessageItem,
  type HostCommand,
  type HostCommandExecutionItem,
  type HostEvent,
  type HostFileChange,
  type HostItem,
  type HostItemOutcome,
  type HostQuestionInteraction,
  type HostToolExecutionItem,
  type HostToolOutput,
  type InteractionRespondAccepted,
  type InteractionRespondCommand,
  type TurnCancelAccepted,
  type TurnCancelCommand,
  type TurnOutcome,
  type TurnStartAccepted,
  type TurnStartCommand,
} from "@codexhost/harness-adapter";
import {
  harnessIdSchema,
  hostInteractionIdSchema,
  hostItemIdSchema,
  type HarnessId,
  type HostInteractionId,
  type HostItemId,
  type JsonValue,
} from "@codexhost/shared-contracts";

import {
  PiRpcFaultError,
  PiRpcSession,
  type PiInteractionRequest,
  type PiInteractionResponse,
  type PiRpcSessionOptions,
  type PiSessionState,
  type PiTurnEvent,
  type PiTurnResult,
} from "./pi-rpc-session.js";

export interface PiAdapterOptions {
  command?: string;
  environment?: NodeJS.ProcessEnv;
  commandTimeoutMs?: number;
  turnTimeoutMs?: number;
  closeTimeoutMs?: number;
  toolOutputLimit?: number;
}

export interface PiTurnTransport {
  readonly state: PiSessionState;
  start(): Promise<unknown>;
  runTurn(text: string, onEvent: (event: PiTurnEvent) => void): Promise<PiTurnResult>;
  respondToInteraction(response: PiInteractionResponse): Promise<void>;
  abort(): Promise<void>;
  close(): Promise<void>;
}

export interface PiAdapterDependencies {
  createTransport(options: PiRpcSessionOptions): PiTurnTransport;
}

interface ActiveTool {
  item: HostCommandExecutionItem | HostToolExecutionItem;
  nativeName: string;
  startedAtMs: number;
}

interface ActiveInteraction {
  interaction: HostQuestionInteraction;
  nativeRequest: PiInteractionRequest;
}

interface ActiveTurn {
  command: TurnStartCommand;
  agentItem: HostAgentMessageItem;
  tools: Map<string, ActiveTool>;
  interactions: Map<HostInteractionId, ActiveInteraction>;
  interactionByNativeId: Map<string, HostInteractionId>;
  cancellationRequested: boolean;
  completion: Promise<void>;
  resolveCompletion(): void;
}

type SessionPhase = "open" | "closing" | "closed" | "faulted";

const piHarnessId = harnessIdSchema.parse("pi");
const DEFAULT_TOOL_OUTPUT_LIMIT = 64_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizedError(error: unknown, fallbackCode: HarnessError["code"]): HarnessError {
  if (error instanceof PiRpcFaultError) {
    return {
      code: error.kind,
      message: error.message,
      retryable: error.kind !== "notInstalled",
    };
  }
  return {
    code: fallbackCode,
    message: errorMessage(error),
    retryable: fallbackCode === "unavailable" || fallbackCode === "nativeFailure",
  };
}

function invalidState(message: string): HarnessError {
  return { code: "invalidState", message, retryable: false };
}

function toolFailure(toolName: string): HarnessError {
  return {
    code: "nativeFailure",
    message: `Pi Tool '${toolName}' failed`,
    retryable: false,
  };
}

function nativeText(value: JsonValue): string {
  if (typeof value === "string") return value;
  if (!isRecord(value) || !Array.isArray(value.content)) return "";
  return value.content
    .filter(
      (content): content is Record<string, JsonValue> =>
        isRecord(content) && content.type === "text" && typeof content.text === "string",
    )
    .map(({ text }) => text as string)
    .join("");
}

function boundedOutput(value: JsonValue, limit: number): HostToolOutput | undefined {
  const text = nativeText(value);
  if (text.length === 0) return undefined;
  const truncated = text.length > limit;
  return {
    content: [{ type: "text", text: truncated ? text.slice(0, limit) : text }],
    ...(truncated ? { truncated: true } : {}),
  };
}

function outputText(output: HostToolOutput | undefined): string {
  return (
    output?.content
      .filter(
        (content): content is Extract<(typeof output.content)[number], { type: "text" }> =>
          content.type === "text",
      )
      .map(({ text }) => text)
      .join("") ?? ""
  );
}

function stringField(value: JsonValue, key: string): string | undefined {
  return isRecord(value) && typeof value[key] === "string" ? value[key] : undefined;
}

function numberField(value: JsonValue, key: string): number | null | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === "number" || field === null ? field : undefined;
}

function stripDiffPrefix(path: string): string {
  return path.startsWith("a/") || path.startsWith("b/") ? path.slice(2) : path;
}

function reliableFileChange(result: JsonValue): HostFileChange[] | null {
  if (!isRecord(result) || !isRecord(result.details) || typeof result.details.patch !== "string") {
    return null;
  }
  const patch = result.details.patch;
  let parsed: ReturnType<typeof parsePatch>;
  try {
    parsed = parsePatch(patch);
  } catch {
    return null;
  }
  const file = parsed[0];
  if (parsed.length !== 1 || !file) return null;
  const oldFile = file.oldFileName;
  const newFile = file.newFileName;
  const kind = oldFile === "/dev/null" ? "add" : newFile === "/dev/null" ? "delete" : "update";
  const path = stripDiffPrefix(kind === "delete" ? oldFile : newFile);
  if (!path || path === "/dev/null") return null;
  return [{ path, kind, unifiedDiff: patch }];
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

class PiHarnessSession implements HarnessSession {
  readonly harnessId: HarnessId = piHarnessId;
  readonly initialState: HarnessSessionState = {};
  readonly outputs: AsyncIterable<HarnessOutput>;
  readonly #channel = new HarnessOutputChannel<HarnessOutput>();
  readonly #closeTimeoutMs: number;
  readonly #createTransport: PiAdapterDependencies["createTransport"];
  readonly #cwd: string;
  readonly #onClosed: () => void;
  readonly #toolOutputLimit: number;
  #acceptingTurn = false;
  #active: ActiveTurn | null = null;
  #closePromise: Promise<void> | null = null;
  #phase: SessionPhase = "open";
  #starting: Promise<PiTurnTransport> | null = null;
  #state: HarnessSessionState = {};
  #transport: PiTurnTransport | null = null;

  constructor(
    cwd: string,
    createTransport: PiAdapterDependencies["createTransport"],
    onClosed: () => void,
    options: { closeTimeoutMs: number; toolOutputLimit: number },
  ) {
    this.#cwd = cwd;
    this.#createTransport = createTransport;
    this.#onClosed = onClosed;
    this.#closeTimeoutMs = options.closeTimeoutMs;
    this.#toolOutputLimit = options.toolOutputLimit;
    this.outputs = this.#channel.outputs;
  }

  execute(command: TurnStartCommand): Promise<HarnessResult<TurnStartAccepted>>;
  execute(command: TurnCancelCommand): Promise<HarnessResult<TurnCancelAccepted>>;
  execute(command: InteractionRespondCommand): Promise<HarnessResult<InteractionRespondAccepted>>;
  async execute(
    command: HostCommand,
  ): Promise<HarnessResult<TurnStartAccepted | TurnCancelAccepted | InteractionRespondAccepted>> {
    if (this.#phase !== "open") {
      return { ok: false, error: invalidState("Pi Session is not open") };
    }
    if (command.type === "turn.cancel") return this.#cancel(command);
    if (command.type === "interaction.respond") return this.#respond(command);
    if (this.#acceptingTurn || this.#active) {
      return {
        ok: false,
        error: {
          code: "sessionBusy",
          message: "Pi Session already has an active Turn",
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
          message: "Pi text Turn must not be empty",
          retryable: false,
        },
      };
    }

    this.#acceptingTurn = true;
    try {
      let transport: PiTurnTransport;
      try {
        transport = await this.#ensureTransport();
      } catch (error) {
        return { ok: false, error: normalizedError(error, "unavailable") };
      }
      if (this.#phase !== "open") {
        return { ok: false, error: invalidState("Pi Session became unavailable during startup") };
      }

      let resolveCompletion = (): void => undefined;
      const completion = new Promise<void>((resolve) => {
        resolveCompletion = resolve;
      });
      const item: HostAgentMessageItem = {
        type: "agentMessage",
        itemId: this.#newItemId(),
        text: "",
      };
      const active: ActiveTurn = {
        command,
        agentItem: item,
        tools: new Map(),
        interactions: new Map(),
        interactionByNativeId: new Map(),
        cancellationRequested: false,
        completion,
        resolveCompletion,
      };
      this.#active = active;
      this.#event({ type: "turn.started", turnId: command.turnId });
      this.#event({ type: "item.started", turnId: command.turnId, item });

      void transport
        .runTurn(text, (event) => this.#handleTurnEvent(active, event))
        .then((result) => {
          this.#completeTurn(
            active,
            result.cancelled
              ? { status: "cancelled", reason: "Cancelled by user" }
              : { status: "succeeded" },
            result.text,
          );
        })
        .catch((error: unknown) => {
          this.#completeTurn(active, {
            status: "failed",
            error: normalizedError(error, "nativeFailure"),
          });
        });

      return { ok: true, value: { turnId: command.turnId } };
    } finally {
      this.#acceptingTurn = false;
    }
  }

  close(): Promise<void> {
    if (!this.#closePromise) {
      this.#closePromise = this.#close().finally(this.#onClosed);
    }
    return this.#closePromise;
  }

  async #respond(
    command: InteractionRespondCommand,
  ): Promise<HarnessResult<InteractionRespondAccepted>> {
    const active = this.#active;
    const pending = active?.interactions.get(command.interactionId);
    if (!active || !pending) {
      return {
        ok: false,
        error: invalidState("Pi Interaction Response must reference a pending Question"),
      };
    }
    const validationError = validateHostQuestionResponse(pending.interaction, command.response);
    if (validationError) return { ok: false, error: validationError };
    const transport = this.#transport;
    if (!transport) return { ok: false, error: invalidState("Pi transport is unavailable") };
    const answers = command.response.answers.answer ?? [];
    let response: PiInteractionResponse;
    if (command.response.cancelled) {
      response = { requestId: pending.nativeRequest.requestId, cancelled: true };
    } else if (pending.nativeRequest.method === "confirm") {
      response = {
        requestId: pending.nativeRequest.requestId,
        confirmed: answers[0] === "yes",
      };
    } else {
      const value = answers[0];
      if (value === undefined) {
        return {
          ok: false,
          error: {
            code: "invalidRequest",
            message: "Pi Question Response has no answer",
            retryable: false,
          },
        };
      }
      response = { requestId: pending.nativeRequest.requestId, value };
    }
    try {
      await transport.respondToInteraction(response);
      return { ok: true, value: { accepted: true } };
    } catch (error) {
      return { ok: false, error: normalizedError(error, "nativeFailure") };
    }
  }

  async #cancel(command: TurnCancelCommand): Promise<HarnessResult<TurnCancelAccepted>> {
    const active = this.#active;
    if (!active || active.command.turnId !== command.turnId) {
      return {
        ok: false,
        error: invalidState("Pi Turn Cancel must reference the active Turn"),
      };
    }
    if (active.cancellationRequested) {
      return { ok: true, value: { cancellationRequested: true } };
    }
    const transport = this.#transport;
    if (!transport) return { ok: false, error: invalidState("Pi transport is unavailable") };
    active.cancellationRequested = true;
    try {
      await transport.abort();
      return { ok: true, value: { cancellationRequested: true } };
    } catch (error) {
      if (this.#active === active) active.cancellationRequested = false;
      return { ok: false, error: normalizedError(error, "nativeFailure") };
    }
  }

  async #ensureTransport(): Promise<PiTurnTransport> {
    if (this.#transport) return this.#transport;
    if (this.#starting) return this.#starting;
    const transport = this.#createTransport({
      cwd: this.#cwd,
      onFault: (error) => queueMicrotask(() => this.#fault(error)),
    });
    const starting = transport
      .start()
      .then(() => {
        if (this.#phase !== "open") throw new Error("Pi Session closed during startup");
        this.#transport = transport;
        const state = transport.state;
        this.#state = {
          nativeRef: {
            harnessId: this.harnessId,
            nativeSessionId: state.sessionId,
            ...(state.sessionFile ? { locator: { sessionFile: state.sessionFile } } : {}),
            formatVersion: 1,
          },
        };
        this.#event({ type: "session.state.changed", state: this.#state });
        return transport;
      })
      .catch(async (error: unknown) => {
        await transport.close().catch(() => undefined);
        if (this.#phase === "open") this.#fault(error);
        throw error;
      })
      .finally(() => {
        if (this.#starting === starting) this.#starting = null;
      });
    this.#starting = starting;
    return starting;
  }

  #handleTurnEvent(active: ActiveTurn, event: PiTurnEvent): void {
    if (this.#active !== active || this.#phase === "closed" || this.#phase === "faulted") return;
    switch (event.type) {
      case "text.delta":
        this.#appendText(active, event.delta);
        return;
      case "interaction.requested":
        this.#startInteraction(active, event.request);
        return;
      case "interaction.closed":
        this.#closeInteraction(active, event.requestId, event.reason);
        return;
      case "tool.started":
        this.#startTool(active, event);
        return;
      case "tool.updated":
        this.#updateTool(active, event);
        return;
      case "tool.completed":
        this.#completeTool(active, event);
    }
  }

  #startInteraction(active: ActiveTurn, request: PiInteractionRequest): void {
    if (active.interactionByNativeId.has(request.requestId)) {
      throw new Error("Pi Interaction started more than once");
    }
    const interactionId = hostInteractionIdSchema.parse(randomUUID());
    const question =
      request.method === "select"
        ? {
            id: "answer",
            type: "choice" as const,
            prompt: request.title,
            options: request.options.map((option) => ({ value: option, label: option })),
            multiple: false,
            allowOther: false,
            optional: false,
          }
        : request.method === "confirm"
          ? {
              id: "answer",
              type: "choice" as const,
              prompt: request.message || request.title,
              options: [
                { value: "yes", label: "Yes" },
                { value: "no", label: "No" },
              ],
              multiple: false,
              allowOther: false,
              optional: false,
            }
          : {
              id: "answer",
              type: "text" as const,
              prompt: request.title,
              multiline: request.method === "editor",
              secret: false,
              optional: false,
              ...(request.method === "input" && request.placeholder
                ? { placeholder: request.placeholder }
                : {}),
              ...(request.method === "editor" && request.prefill
                ? { prefill: request.prefill }
                : {}),
            };
    const associatedTool = active.tools.size === 1 ? [...active.tools.values()][0] : undefined;
    const interaction: HostQuestionInteraction = {
      type: "question",
      interactionId,
      turnId: active.command.turnId,
      ...(associatedTool ? { itemId: associatedTool.item.itemId } : {}),
      title: "Pi",
      questions: [question],
      ...(request.timeoutMs !== undefined
        ? { expiresAt: new Date(Date.now() + request.timeoutMs).toISOString() }
        : {}),
    };
    active.interactions.set(interactionId, { interaction, nativeRequest: request });
    active.interactionByNativeId.set(request.requestId, interactionId);
    this.#channel.emit({ kind: "interaction", interaction });
  }

  #closeInteraction(
    active: ActiveTurn,
    nativeRequestId: string,
    reason: "responded" | "cancelled" | "expired" | "superseded",
  ): void {
    const interactionId = active.interactionByNativeId.get(nativeRequestId);
    if (!interactionId) throw new Error("Pi Interaction close references an unknown request");
    active.interactionByNativeId.delete(nativeRequestId);
    active.interactions.delete(interactionId);
    this.#event({
      type: "interaction.closed",
      interactionId,
      turnId: active.command.turnId,
      reason,
    });
  }

  #appendText(active: ActiveTurn, text: string): void {
    active.agentItem = { ...active.agentItem, text: active.agentItem.text + text };
    this.#event({
      type: "item.updated",
      turnId: active.command.turnId,
      itemId: active.agentItem.itemId,
      update: { type: "text.append", text },
    });
  }

  #startTool(active: ActiveTurn, event: Extract<PiTurnEvent, { type: "tool.started" }>): void {
    if (active.tools.has(event.callId)) throw new Error("Pi Tool started more than once");
    const command = event.toolName === "bash" ? stringField(event.arguments, "command") : undefined;
    const item: HostCommandExecutionItem | HostToolExecutionItem = command
      ? {
          type: "commandExecution",
          itemId: this.#newItemId(),
          command,
          cwd: stringField(event.arguments, "cwd") ?? this.#cwd,
        }
      : {
          type: "toolExecution",
          itemId: this.#newItemId(),
          toolName: event.toolName,
          arguments: event.arguments,
        };
    active.tools.set(event.callId, {
      item,
      nativeName: event.toolName,
      startedAtMs: Date.now(),
    });
    this.#event({ type: "item.started", turnId: active.command.turnId, item });
  }

  #updateTool(active: ActiveTurn, event: Extract<PiTurnEvent, { type: "tool.updated" }>): void {
    const tool = active.tools.get(event.callId);
    if (!tool) throw new Error("Pi Tool update references an unknown Tool Call");
    const output = boundedOutput(event.output, this.#toolOutputLimit);
    if (!output) return;
    if (tool.item.type === "commandExecution") {
      const previous = tool.item.output ?? "";
      const next = outputText(output);
      tool.item = {
        ...tool.item,
        output: next,
        outputTruncated: output.truncated === true,
      };
      if (next.startsWith(previous)) {
        const delta = next.slice(previous.length);
        if (delta.length > 0) {
          this.#event({
            type: "item.updated",
            turnId: active.command.turnId,
            itemId: tool.item.itemId,
            update: { type: "output.append", text: delta },
          });
        }
      }
      return;
    }
    tool.item = { ...tool.item, output };
    this.#event({
      type: "item.updated",
      turnId: active.command.turnId,
      itemId: tool.item.itemId,
      update: { type: "output.replace", output },
    });
  }

  #completeTool(active: ActiveTurn, event: Extract<PiTurnEvent, { type: "tool.completed" }>): void {
    const tool = active.tools.get(event.callId);
    if (!tool || tool.nativeName !== event.toolName) {
      throw new Error("Pi Tool completion references an unknown Tool Call");
    }
    active.tools.delete(event.callId);
    const durationMs = Math.max(0, Date.now() - tool.startedAtMs);
    const output = boundedOutput(event.result, this.#toolOutputLimit);
    if (tool.item.type === "commandExecution") {
      const exitCode = numberField(event.result, "exitCode");
      tool.item = {
        ...tool.item,
        ...(output
          ? {
              output: outputText(output),
              outputTruncated: output.truncated === true,
            }
          : {}),
        ...(exitCode !== undefined ? { exitCode } : {}),
        durationMs,
      };
    } else {
      tool.item = { ...tool.item, ...(output ? { output } : {}), durationMs };
    }
    const outcome: HostItemOutcome = active.cancellationRequested
      ? { status: "cancelled", reason: "Cancelled by user" }
      : event.isError
        ? { status: "failed", error: toolFailure(event.toolName) }
        : { status: "succeeded" };
    this.#completeItem(active, tool.item, outcome);

    if (!event.isError && event.toolName === "edit") {
      const changes = reliableFileChange(event.result);
      if (changes) {
        const fileItem: HostItem = { type: "fileChange", itemId: this.#newItemId(), changes };
        this.#event({ type: "item.started", turnId: active.command.turnId, item: fileItem });
        this.#completeItem(active, fileItem, { status: "succeeded" });
      }
    }
  }

  #completeItem(active: ActiveTurn, item: HostItem, outcome: HostItemOutcome): void {
    this.#event({
      type: "item.completed",
      turnId: active.command.turnId,
      snapshot: { item, outcome },
    });
  }

  #closeActiveInteractions(
    active: ActiveTurn,
    reason: "cancelled" | "expired" | "superseded",
  ): void {
    for (const [interactionId, pending] of active.interactions) {
      active.interactions.delete(interactionId);
      active.interactionByNativeId.delete(pending.nativeRequest.requestId);
      this.#event({
        type: "interaction.closed",
        interactionId,
        turnId: active.command.turnId,
        reason,
      });
    }
  }

  #completeTurn(active: ActiveTurn, outcome: TurnOutcome, finalText?: string): void {
    if (this.#active !== active) return;
    this.#closeActiveInteractions(
      active,
      outcome.status === "succeeded" ? "superseded" : "cancelled",
    );
    this.#active = null;
    const itemOutcome: HostItemOutcome =
      outcome.status === "failed"
        ? { status: "failed", error: outcome.error }
        : outcome.status === "cancelled"
          ? { status: "cancelled", ...(outcome.reason ? { reason: outcome.reason } : {}) }
          : { status: "succeeded" };
    for (const tool of active.tools.values()) this.#completeItem(active, tool.item, itemOutcome);
    active.tools.clear();
    if (finalText !== undefined) active.agentItem = { ...active.agentItem, text: finalText };
    this.#completeItem(active, active.agentItem, itemOutcome);
    this.#event({ type: "turn.completed", turnId: active.command.turnId, outcome });
    active.resolveCompletion();
  }

  #fault(error: unknown): void {
    if (this.#phase === "closed" || this.#phase === "faulted") return;
    const normalized = normalizedError(error, "internalError");
    if (this.#active) {
      this.#completeTurn(this.#active, { status: "failed", error: normalized });
    }
    this.#phase = "faulted";
    this.#event({ type: "session.faulted", error: normalized });
    this.#channel.end();
  }

  async #close(): Promise<void> {
    if (this.#phase === "closed") return;
    const wasFaulted = this.#phase === "faulted";
    if (!wasFaulted) this.#phase = "closing";
    const transport =
      this.#transport ?? (this.#starting ? await this.#starting.catch(() => null) : null);
    const active = this.#active;
    if (transport && active) {
      active.cancellationRequested = true;
      await transport.abort().catch(() => undefined);
      await Promise.race([active.completion, delay(this.#closeTimeoutMs)]);
    }
    try {
      if (transport) await transport.close();
    } catch (error) {
      this.#fault(error);
      throw error;
    }
    if (this.#active) {
      const error = invalidState("Pi Session closed before active Turn cancellation settled");
      this.#completeTurn(this.#active, { status: "failed", error });
    }
    if (!wasFaulted) {
      this.#phase = "closed";
      this.#channel.end();
    }
  }

  #event(event: HostEvent): void {
    this.#channel.emit({ kind: "event", event });
  }

  #newItemId(): HostItemId {
    return hostItemIdSchema.parse(randomUUID());
  }
}

export class PiAdapter implements HarnessAdapter {
  readonly harnessId: HarnessId = piHarnessId;
  readonly #closeTimeoutMs: number;
  readonly #createTransport: PiAdapterDependencies["createTransport"];
  readonly #sessions = new Set<PiHarnessSession>();
  readonly #toolOutputLimit: number;
  #closePromise: Promise<void> | null = null;

  constructor(
    options: PiAdapterOptions = {},
    dependencies: PiAdapterDependencies = {
      createTransport: (sessionOptions) => new PiRpcSession({ ...options, ...sessionOptions }),
    },
  ) {
    this.#createTransport = dependencies.createTransport;
    this.#closeTimeoutMs = options.closeTimeoutMs ?? 2_000;
    this.#toolOutputLimit = options.toolOutputLimit ?? DEFAULT_TOOL_OUTPUT_LIMIT;
  }

  async open(input: CreateSessionInput): Promise<HarnessResult<HarnessSession>> {
    if (this.#closePromise) {
      return { ok: false, error: invalidState("Pi Adapter is closed") };
    }
    if (input.kind !== "create" || input.cwd.length === 0) {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "Pi Adapter requires a create input with cwd",
          retryable: false,
        },
      };
    }
    const session = new PiHarnessSession(
      input.cwd,
      this.#createTransport,
      () => {
        this.#sessions.delete(session);
      },
      {
        closeTimeoutMs: this.#closeTimeoutMs,
        toolOutputLimit: this.#toolOutputLimit,
      },
    );
    this.#sessions.add(session);
    return { ok: true, value: session };
  }

  close(): Promise<void> {
    if (!this.#closePromise) {
      this.#closePromise = Promise.all([...this.#sessions].map((session) => session.close())).then(
        () => undefined,
      );
    }
    return this.#closePromise;
  }
}
