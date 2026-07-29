import { parsePatch } from "diff";
import { randomUUID } from "node:crypto";

import {
  HarnessOutputChannel,
  type CreateSessionInput,
  type HarnessAdapter,
  type HarnessError,
  type HarnessInspection,
  type HarnessModelRef,
  type HarnessOutput,
  type HarnessResult,
  type HarnessSession,
  type HarnessSessionCapabilities,
  type HarnessSessionState,
  type InspectHarnessInput,
  type HostAgentMessageItem,
  type HostCommand,
  type HostCommandExecutionItem,
  type HostFileChange,
  type HostItem,
  type HostItemOutcome,
  type HostToolExecutionItem,
  type HostToolOutput,
  type ModelSelectCommand,
  type ModelSelectCompleted,
  type TurnCancelAccepted,
  type TurnCancelCommand,
  type TurnOutcome,
  type TurnStartAccepted,
  type TurnStartCommand,
} from "@codexhost/harness-adapter";
import {
  harnessIdSchema,
  hostItemIdSchema,
  type HarnessId,
  type HostItemId,
  type JsonValue,
} from "@codexhost/shared-contracts";

import {
  PiRpcFaultError,
  PiRpcSession,
  type PiRpcSessionOptions,
  type PiSessionState,
  type PiTurnEvent,
  type PiTurnResult,
} from "./pi-rpc-session.js";
import {
  decodePiModelRef,
  encodePiModelRef,
  normalizePiModelCatalog,
  samePiModel,
  type PiNativeModelRef,
} from "./pi-model-catalog.js";

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
  getAvailableModels(): Promise<PiNativeModelRef[]>;
  selectModel(model: PiNativeModelRef): Promise<PiSessionState>;
  runTurn(text: string, onEvent: (event: PiTurnEvent) => void): Promise<PiTurnResult>;
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

interface ActiveTurn {
  command: TurnStartCommand;
  agentItem: HostAgentMessageItem;
  tools: Map<string, ActiveTool>;
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

function nativeModelFromState(state: PiSessionState): PiNativeModelRef | null {
  if (state.provider === null && state.modelId === null) return null;
  if (state.provider === null || state.modelId === null) {
    throw new PiRpcFaultError("protocolError", "Pi state contains a partial Model identity");
  }
  return { provider: state.provider, id: state.modelId };
}

function effectiveModelFromState(state: PiSessionState): HarnessModelRef | undefined {
  const model = nativeModelFromState(state);
  return model ? encodePiModelRef(model) : undefined;
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
  readonly capabilities: HarnessSessionCapabilities = {
    configuration: { selectModel: true },
  };
  readonly initialState: HarnessSessionState = {};
  readonly outputs: AsyncIterable<HarnessOutput>;
  readonly #channel = new HarnessOutputChannel<HarnessOutput>();
  readonly #closeTimeoutMs: number;
  readonly #createTransport: PiAdapterDependencies["createTransport"];
  readonly #cwd: string;
  readonly #onClosed: () => void;
  readonly #requestedModel: HarnessModelRef | undefined;
  readonly #toolOutputLimit: number;
  #acceptingTurn = false;
  #active: ActiveTurn | null = null;
  #closePromise: Promise<void> | null = null;
  #configuring = false;
  #phase: SessionPhase = "open";
  #starting: Promise<PiTurnTransport> | null = null;
  #state: HarnessSessionState = {};
  #transport: PiTurnTransport | null = null;

  constructor(
    cwd: string,
    createTransport: PiAdapterDependencies["createTransport"],
    onClosed: () => void,
    options: {
      closeTimeoutMs: number;
      model?: HarnessModelRef;
      toolOutputLimit: number;
    },
  ) {
    this.#cwd = cwd;
    this.#createTransport = createTransport;
    this.#onClosed = onClosed;
    this.#closeTimeoutMs = options.closeTimeoutMs;
    this.#requestedModel = options.model;
    this.#toolOutputLimit = options.toolOutputLimit;
    this.outputs = this.#channel.outputs;
  }

  execute(command: TurnStartCommand): Promise<HarnessResult<TurnStartAccepted>>;
  execute(command: TurnCancelCommand): Promise<HarnessResult<TurnCancelAccepted>>;
  execute(command: ModelSelectCommand): Promise<HarnessResult<ModelSelectCompleted>>;
  async execute(
    command: HostCommand,
  ): Promise<HarnessResult<TurnStartAccepted | TurnCancelAccepted | ModelSelectCompleted>> {
    if (this.#phase !== "open") {
      return { ok: false, error: invalidState("Pi Session is not open") };
    }
    if (command.type === "turn.cancel") return this.#cancel(command);
    if (command.type === "model.select") return this.#selectModel(command);
    if (this.#acceptingTurn || this.#active || this.#configuring) {
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

  async #selectModel(command: ModelSelectCommand): Promise<HarnessResult<ModelSelectCompleted>> {
    if (this.#acceptingTurn || this.#active || this.#configuring) {
      return {
        ok: false,
        error: {
          code: "sessionBusy",
          message: "Pi Session cannot select a Model while another operation is active",
          retryable: true,
        },
      };
    }
    const transport = this.#transport;
    if (!transport) {
      return {
        ok: false,
        error: invalidState("Pi Model selection requires a started Native Session"),
      };
    }
    let requested: PiNativeModelRef;
    try {
      requested = decodePiModelRef(command.model);
    } catch (error) {
      return { ok: false, error: normalizedError(error, "invalidRequest") };
    }

    this.#configuring = true;
    try {
      let state: PiSessionState;
      try {
        state = await transport.selectModel(requested);
      } catch (error) {
        if (error instanceof PiRpcFaultError) this.#fault(error);
        return { ok: false, error: normalizedError(error, "nativeFailure") };
      }
      this.#publishTransportState(state);
      const actual = nativeModelFromState(state);
      if (!samePiModel(actual, requested)) {
        return {
          ok: false,
          error: {
            code: "nativeFailure",
            message: "Pi did not activate the requested Model",
            retryable: false,
          },
        };
      }
      return { ok: true, value: { completed: true } };
    } finally {
      this.#configuring = false;
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
      .then(async () => {
        if (this.#phase !== "open") throw new Error("Pi Session closed during startup");
        let state = transport.state;
        if (this.#requestedModel) {
          const requested = decodePiModelRef(this.#requestedModel);
          const current = nativeModelFromState(state);
          if (!samePiModel(current, requested)) state = await transport.selectModel(requested);
          if (!samePiModel(nativeModelFromState(state), requested)) {
            this.#publishTransportState(state);
            throw new Error("Pi did not activate the requested create Model");
          }
        }
        this.#transport = transport;
        this.#publishTransportState(state);
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

  #publishTransportState(state: PiSessionState): void {
    const effectiveModel = effectiveModelFromState(state);
    this.#state = {
      nativeRef: {
        harnessId: this.harnessId,
        nativeSessionId: state.sessionId,
        ...(state.sessionFile ? { locator: { sessionFile: state.sessionFile } } : {}),
        formatVersion: 1,
      },
      ...(effectiveModel ? { effectiveModel } : {}),
    };
    this.#event({ type: "session.state.changed", state: this.#state });
  }

  #handleTurnEvent(active: ActiveTurn, event: PiTurnEvent): void {
    if (this.#active !== active || this.#phase === "closed" || this.#phase === "faulted") return;
    switch (event.type) {
      case "text.delta":
        this.#appendText(active, event.delta);
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

  #completeTurn(active: ActiveTurn, outcome: TurnOutcome, finalText?: string): void {
    if (this.#active !== active) return;
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

  #event(event: HarnessOutput["event"]): void {
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
  readonly #inspections = new Set<PiTurnTransport>();
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

  async inspect(input: InspectHarnessInput = {}): Promise<HarnessInspection> {
    if (this.#closePromise) {
      return {
        status: "unavailable",
        error: {
          code: "invalidState",
          message: "Pi Adapter is closed",
          retryable: false,
        },
      };
    }
    const transport = this.#createTransport({
      cwd: input.cwd ?? process.cwd(),
      onFault: () => undefined,
    });
    this.#inspections.add(transport);
    try {
      await transport.start();
      const models = await transport.getAvailableModels();
      const catalog = normalizePiModelCatalog(models, nativeModelFromState(transport.state));
      await transport.close();
      return {
        status: "ready",
        catalog,
        capabilities: { configuration: { selectModel: true } },
      };
    } catch (error) {
      await transport.close().catch(() => undefined);
      const normalized = normalizedError(error, "unavailable");
      return {
        status: normalized.code === "notInstalled" ? "notInstalled" : "error",
        error: normalized,
      };
    } finally {
      this.#inspections.delete(transport);
    }
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
    if (input.model) {
      try {
        decodePiModelRef(input.model);
      } catch (error) {
        return { ok: false, error: normalizedError(error, "invalidRequest") };
      }
    }
    const session = new PiHarnessSession(
      input.cwd,
      this.#createTransport,
      () => {
        this.#sessions.delete(session);
      },
      {
        closeTimeoutMs: this.#closeTimeoutMs,
        ...(input.model ? { model: input.model } : {}),
        toolOutputLimit: this.#toolOutputLimit,
      },
    );
    this.#sessions.add(session);
    return { ok: true, value: session };
  }

  close(): Promise<void> {
    if (!this.#closePromise) {
      this.#closePromise = Promise.all([
        ...[...this.#inspections].map((transport) => transport.close()),
        ...[...this.#sessions].map((session) => session.close()),
      ]).then(() => undefined);
    }
    return this.#closePromise;
  }
}
