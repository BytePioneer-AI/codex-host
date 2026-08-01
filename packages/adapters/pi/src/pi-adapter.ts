import { parsePatch } from "diff";
import { randomUUID } from "node:crypto";

import {
  HarnessOutputChannel,
  validateHostQuestionResponse,
  type HarnessAdapter,
  type HarnessError,
  type HarnessInspection,
  type HarnessModelRef,
  type HarnessOutput,
  type HarnessResult,
  type HarnessSession,
  type HarnessSessionCapabilities,
  type HarnessSessionState,
  type HarnessThinkingOptionId,
  type InspectHarnessInput,
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
  type ModelSelectCommand,
  type ModelSelectCompleted,
  type OpenSessionInput,
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
  harnessThinkingOptionIdSchema,
  hostInteractionIdSchema,
  hostItemIdSchema,
  nativeCheckpointRefSchema,
  nativeSessionRefSchema,
  type HarnessId,
  type HostInteractionId,
  type HostItemId,
  type JsonValue,
  type NativeCheckpointRef,
  type NativeSessionRef,
  type NativeTurnRef,
} from "@codexhost/shared-contracts";

import { mapPiSnapshot, resolvePiForkBoundary, type PiSessionHistory } from "./pi-history.js";
import {
  PiRpcFaultError,
  PiRpcSession,
  PiRpcUnsupportedCommandError,
  type PiInteractionRequest,
  type PiInteractionResponse,
  type PiRpcSessionOptions,
  type PiSessionState,
  type PiTurnEvent,
  type PiTurnResult,
} from "./pi-rpc-session.js";
import {
  decodePiModelRef,
  encodePiModelRef,
  normalizePiModelCatalog,
  normalizePiThinkingOptions,
  samePiModel,
  type PiNativeModel,
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
  getAvailableModels(): Promise<PiNativeModel[]>;
  getAvailableThinkingLevels(): Promise<HarnessThinkingOptionId[] | null>;
  getEntries(): Promise<PiSessionHistory>;
  fork(entryId: string): Promise<PiSessionState>;
  clone(): Promise<PiSessionState>;
  verifySessionCwd(expectedCwd: string): Promise<void>;
  selectModel(model: PiNativeModelRef): Promise<PiSessionState>;
  selectThinkingOption(thinkingOptionId: HarnessThinkingOptionId): Promise<PiSessionState>;
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
  beforeNativeTurnKeys: Set<string>;
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

class PiAdapterFaultError extends Error {
  constructor(readonly harnessError: HarnessError) {
    super(harnessError.message);
    this.name = "PiAdapterFaultError";
  }
}

function normalizedError(error: unknown, fallbackCode: HarnessError["code"]): HarnessError {
  if (error instanceof PiAdapterFaultError) return error.harnessError;
  if (error instanceof PiRpcUnsupportedCommandError) {
    return {
      code: "unsupported",
      message: error.message,
      retryable: false,
    };
  }
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

function harnessStateFromPi(
  state: PiSessionState,
  thinkingLevels: readonly HarnessThinkingOptionId[] | null,
): HarnessSessionState {
  const effectiveModel = effectiveModelFromState(state);
  const availableThinkingOptions = thinkingLevels
    ? normalizePiThinkingOptions(thinkingLevels)
    : undefined;
  if (
    availableThinkingOptions &&
    (!state.thinkingLevel || !thinkingLevels?.includes(state.thinkingLevel))
  ) {
    throw new PiRpcFaultError(
      "protocolError",
      "Pi effective Thinking level is absent from its available levels",
    );
  }
  return {
    nativeRef: nativeSessionRefSchema.parse({
      harnessId: piHarnessId,
      nativeSessionId: state.sessionId,
      ...(state.sessionFile ? { locator: { sessionFile: state.sessionFile } } : {}),
      formatVersion: 1,
    }) as NativeSessionRef,
    ...(effectiveModel ? { effectiveModel } : {}),
    ...(state.thinkingLevel ? { effectiveThinkingOptionId: state.thinkingLevel } : {}),
    ...(availableThinkingOptions ? { availableThinkingOptions } : {}),
  };
}

function nativeModelForHistory(state: PiSessionState): PiNativeModelRef | null {
  return nativeModelFromState(state);
}

function sessionFileFromRef(ref: NativeSessionRef): string {
  if (
    ref.harnessId !== piHarnessId ||
    !isRecord(ref.locator) ||
    typeof ref.locator.sessionFile !== "string" ||
    ref.locator.sessionFile.length === 0
  ) {
    throw new Error("Pi Native Session Ref has no resumable Session file");
  }
  return ref.locator.sessionFile;
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
  readonly capabilities: HarnessSessionCapabilities;
  readonly initialState: HarnessSessionState;
  readonly outputs: AsyncIterable<HarnessOutput>;
  readonly #channel = new HarnessOutputChannel<HarnessOutput>();
  readonly #closeTimeoutMs: number;
  readonly #createTransport: PiAdapterDependencies["createTransport"];
  readonly #cwd: string;
  readonly #onClosed: () => void;
  readonly #requestedModel: HarnessModelRef | undefined;
  readonly #requestedThinkingOptionId: HarnessThinkingOptionId | undefined;
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
      thinkingOptionId?: HarnessThinkingOptionId;
      toolOutputLimit: number;
      supportsThinkingSelection: boolean;
      startedTransport?: PiTurnTransport;
      startedThinkingLevels?: HarnessThinkingOptionId[] | null;
    },
  ) {
    this.#cwd = cwd;
    this.#createTransport = createTransport;
    this.#onClosed = onClosed;
    this.#closeTimeoutMs = options.closeTimeoutMs;
    this.#requestedModel = options.model;
    this.#requestedThinkingOptionId = options.thinkingOptionId;
    this.#toolOutputLimit = options.toolOutputLimit;
    this.capabilities = {
      configuration: {
        selectModel: true,
        selectThinkingOption: options.supportsThinkingSelection,
      },
      history: { fork: true, forkAcrossCwd: true },
    };
    this.#transport = options.startedTransport ?? null;
    this.initialState = options.startedTransport
      ? harnessStateFromPi(options.startedTransport.state, options.startedThinkingLevels ?? null)
      : {};
    this.#state = this.initialState;
    this.outputs = this.#channel.outputs;
  }

  handleTransportFault(error: PiRpcFaultError): void {
    queueMicrotask(() => this.#fault(error));
  }

  async readSnapshot(): Promise<HarnessResult<HostThreadSnapshot>> {
    if (this.#phase !== "open") {
      return { ok: false, error: invalidState("Pi Session is not open") };
    }
    if (this.#active || this.#acceptingTurn || this.#configuring) {
      return {
        ok: false,
        error: {
          code: "sessionBusy",
          message: "Pi Session cannot read history while another operation is active",
          retryable: true,
        },
      };
    }
    try {
      const transport = await this.#ensureTransport();
      const history = await transport.getEntries();
      return {
        ok: true,
        value: mapPiSnapshot(history, {
          sessionId: transport.state.sessionId,
          model: nativeModelForHistory(transport.state),
        }),
      };
    } catch (error) {
      return { ok: false, error: normalizedError(error, "nativeFailure") };
    }
  }

  execute(command: TurnStartCommand): Promise<HarnessResult<TurnStartAccepted>>;
  execute(command: TurnCancelCommand): Promise<HarnessResult<TurnCancelAccepted>>;
  execute(command: InteractionRespondCommand): Promise<HarnessResult<InteractionRespondAccepted>>;
  execute(command: ModelSelectCommand): Promise<HarnessResult<ModelSelectCompleted>>;
  execute(command: ThinkingSelectCommand): Promise<HarnessResult<ThinkingSelectCompleted>>;
  async execute(
    command: HostCommand,
  ): Promise<
    HarnessResult<
      | TurnStartAccepted
      | TurnCancelAccepted
      | InteractionRespondAccepted
      | ModelSelectCompleted
      | ThinkingSelectCompleted
    >
  > {
    if (this.#phase !== "open") {
      return { ok: false, error: invalidState("Pi Session is not open") };
    }
    if (command.type === "turn.cancel") return this.#cancel(command);
    if (command.type === "interaction.respond") return this.#respond(command);
    if (command.type === "model.select") return this.#selectModel(command);
    if (command.type === "thinking.select") return this.#selectThinking(command);
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

      let beforeHistory: HostThreadSnapshot;
      try {
        beforeHistory = mapPiSnapshot(await transport.getEntries(), {
          sessionId: transport.state.sessionId,
          model: nativeModelForHistory(transport.state),
        });
      } catch (error) {
        return { ok: false, error: normalizedError(error, "protocolError") };
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
        beforeNativeTurnKeys: new Set(
          beforeHistory.turns.map((turn) => turn.nativeTurnRef.nativeTurnKey),
        ),
        completion,
        resolveCompletion,
      };
      this.#active = active;
      this.#event({ type: "turn.started", turnId: command.turnId });
      this.#event({ type: "item.started", turnId: command.turnId, item });

      void transport
        .runTurn(text, (event) => this.#handleTurnEvent(active, event))
        .then(async (result) => {
          try {
            const identity = await this.#completedTurnIdentity(active, transport);
            this.#completeTurn(
              active,
              result.cancelled
                ? {
                    status: "cancelled",
                    reason: "Cancelled by user",
                    checkpoint: identity.checkpoint,
                  }
                : { status: "succeeded", checkpoint: identity.checkpoint },
              result.text,
              identity.nativeTurnRef,
            );
          } catch (error) {
            this.#completeTurn(active, {
              status: "failed",
              error: normalizedError(error, "protocolError"),
            });
          }
        })
        .catch(async (error: unknown) => {
          let identity:
            { nativeTurnRef: NativeTurnRef; checkpoint: NativeCheckpointRef } | undefined;
          try {
            identity = await this.#completedTurnIdentity(active, transport);
          } catch {
            // A failed native Turn may not have persisted a stable User Entry.
          }
          this.#completeTurn(
            active,
            {
              status: "failed",
              error: normalizedError(error, "nativeFailure"),
              ...(identity ? { checkpoint: identity.checkpoint } : {}),
            },
            undefined,
            identity?.nativeTurnRef,
          );
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
      let thinkingLevels: HarnessThinkingOptionId[] | null;
      try {
        state = await transport.selectModel(requested);
        thinkingLevels = await transport.getAvailableThinkingLevels();
        this.#publishTransportState(state, thinkingLevels);
      } catch (error) {
        if (error instanceof PiRpcFaultError) this.#fault(error);
        return { ok: false, error: normalizedError(error, "nativeFailure") };
      }
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

  async #selectThinking(
    command: ThinkingSelectCommand,
  ): Promise<HarnessResult<ThinkingSelectCompleted>> {
    if (!this.capabilities.configuration.selectThinkingOption) {
      return {
        ok: false,
        error: {
          code: "unsupported",
          message: "Pi Thinking selection is unavailable",
          retryable: false,
        },
      };
    }
    if (this.#acceptingTurn || this.#active || this.#configuring) {
      return {
        ok: false,
        error: {
          code: "sessionBusy",
          message: "Pi Session cannot select Thinking while another operation is active",
          retryable: true,
        },
      };
    }
    const transport = this.#transport;
    if (!transport) {
      return {
        ok: false,
        error: invalidState("Pi Thinking selection requires a started Native Session"),
      };
    }
    const parsedThinkingOptionId = harnessThinkingOptionIdSchema.safeParse(
      command.thinkingOptionId,
    );
    if (!parsedThinkingOptionId.success) {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "Pi Thinking option is invalid",
          retryable: false,
        },
      };
    }
    const thinkingOptionId = parsedThinkingOptionId.data;
    this.#configuring = true;
    try {
      let state: PiSessionState;
      let thinkingLevels: HarnessThinkingOptionId[] | null;
      try {
        state = await transport.selectThinkingOption(thinkingOptionId);
        thinkingLevels = await transport.getAvailableThinkingLevels();
      } catch (error) {
        if (error instanceof PiRpcFaultError) this.#fault(error);
        return { ok: false, error: normalizedError(error, "nativeFailure") };
      }
      if (!thinkingLevels) {
        return {
          ok: false,
          error: {
            code: "unsupported",
            message: "Pi Thinking discovery became unavailable",
            retryable: false,
          },
        };
      }
      try {
        this.#publishTransportState(state, thinkingLevels);
      } catch (error) {
        if (error instanceof PiRpcFaultError) this.#fault(error);
        return { ok: false, error: normalizedError(error, "protocolError") };
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
        let thinkingLevels = await transport.getAvailableThinkingLevels();
        if (this.#requestedModel) {
          const requested = decodePiModelRef(this.#requestedModel);
          const current = nativeModelFromState(state);
          if (!samePiModel(current, requested)) state = await transport.selectModel(requested);
          thinkingLevels = await transport.getAvailableThinkingLevels();
          if (!samePiModel(nativeModelFromState(state), requested)) {
            this.#publishTransportState(state, thinkingLevels);
            throw new Error("Pi did not activate the requested create Model");
          }
        }
        if (this.#requestedThinkingOptionId) {
          if (!thinkingLevels) {
            throw new PiAdapterFaultError({
              code: "unsupported",
              message: "Installed Pi does not support Thinking selection",
              retryable: false,
            });
          }
          state = await transport.selectThinkingOption(this.#requestedThinkingOptionId);
          thinkingLevels = await transport.getAvailableThinkingLevels();
        }
        this.#transport = transport;
        this.#publishTransportState(state, thinkingLevels);
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

  #publishTransportState(
    state: PiSessionState,
    thinkingLevels: readonly HarnessThinkingOptionId[] | null,
  ): void {
    this.#state = harnessStateFromPi(state, thinkingLevels);
    this.#event({ type: "session.state.changed", state: this.#state });
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

  async #completedTurnIdentity(
    active: ActiveTurn,
    transport: PiTurnTransport,
  ): Promise<{ nativeTurnRef: NativeTurnRef; checkpoint: NativeCheckpointRef }> {
    const snapshot = mapPiSnapshot(await transport.getEntries(), {
      sessionId: transport.state.sessionId,
      model: nativeModelForHistory(transport.state),
    });
    const created = snapshot.turns.filter(
      (turn) => !active.beforeNativeTurnKeys.has(turn.nativeTurnRef.nativeTurnKey),
    );
    if (created.length !== 1) {
      throw new Error(
        `Pi Turn persisted ${created.length} new User Entries; exactly one is required`,
      );
    }
    const turn = created[0];
    if (!turn?.checkpoint) throw new Error("Pi Turn has no terminal Checkpoint identity");
    return { nativeTurnRef: turn.nativeTurnRef, checkpoint: turn.checkpoint };
  }

  #completeTurn(
    active: ActiveTurn,
    outcome: TurnOutcome,
    finalText?: string,
    nativeTurnRef?: NativeTurnRef,
  ): void {
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
    this.#event({
      type: "turn.completed",
      turnId: active.command.turnId,
      outcome,
      ...(nativeTurnRef ? { nativeTurnRef } : {}),
    });
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
  readonly #inspectionCache = new Map<string, Extract<HarnessInspection, { status: "ready" }>>();
  readonly #inspectionInFlight = new Map<string, Promise<HarnessInspection>>();
  readonly #inspections = new Set<PiTurnTransport>();
  readonly #sessions = new Set<PiHarnessSession>();
  readonly #toolOutputLimit: number;
  #closePromise: Promise<void> | null = null;
  #thinkingSelectionSupported: boolean | null = null;

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
    const cwd = input.cwd ?? process.cwd();
    const inFlight = this.#inspectionInFlight.get(cwd);
    if (inFlight) return inFlight;
    if (!input.refresh) {
      const cached = this.#inspectionCache.get(cwd);
      if (cached) return cached;
    }

    const inspection = this.#inspectCwd(cwd).then((result) => {
      if (result.status === "ready") this.#inspectionCache.set(cwd, result);
      return result;
    });
    this.#inspectionInFlight.set(cwd, inspection);
    return inspection.finally(() => {
      if (this.#inspectionInFlight.get(cwd) === inspection) {
        this.#inspectionInFlight.delete(cwd);
      }
    });
  }

  async #inspectCwd(cwd: string): Promise<HarnessInspection> {
    const transport = this.#createTransport({ cwd, onFault: () => undefined });
    this.#inspections.add(transport);
    try {
      await transport.start();
      const models = await transport.getAvailableModels();
      const thinkingLevels = await transport.getAvailableThinkingLevels();
      this.#thinkingSelectionSupported = thinkingLevels !== null;
      const catalog = normalizePiModelCatalog(
        models,
        nativeModelFromState(transport.state),
        thinkingLevels,
        transport.state.thinkingLevel,
      );
      await transport.close();
      return {
        status: "ready",
        catalog,
        capabilities: {
          configuration: {
            selectModel: true,
            selectThinkingOption: thinkingLevels !== null,
          },
          history: { fork: true, forkAcrossCwd: true },
        },
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

  async open(input: OpenSessionInput): Promise<HarnessResult<HarnessSession>> {
    if (this.#closePromise) {
      return { ok: false, error: invalidState("Pi Adapter is closed") };
    }
    if (input.cwd.length === 0) {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "Pi Adapter requires cwd",
          retryable: false,
        },
      };
    }
    if (input.kind === "create") {
      if (input.model) {
        try {
          decodePiModelRef(input.model);
        } catch (error) {
          return { ok: false, error: normalizedError(error, "invalidRequest") };
        }
      }
      const thinkingOptionId = input.thinkingOptionId
        ? harnessThinkingOptionIdSchema.safeParse(input.thinkingOptionId)
        : null;
      if (thinkingOptionId && !thinkingOptionId.success) {
        return {
          ok: false,
          error: {
            code: "invalidRequest",
            message: "Pi create Thinking option is invalid",
            retryable: false,
          },
        };
      }
      return {
        ok: true,
        value: this.#trackSession(input.cwd, {
          ...(input.model ? { model: input.model } : {}),
          ...(thinkingOptionId?.success ? { thinkingOptionId: thinkingOptionId.data } : {}),
          supportsThinkingSelection: this.#thinkingSelectionSupported === true,
        }),
      };
    }

    const sourceRef = nativeSessionRefSchema.parse(
      input.kind === "resume" ? input.nativeRef : input.sourceRef,
    ) as NativeSessionRef;
    let session: PiHarnessSession | undefined;
    let transport: PiTurnTransport | undefined;
    try {
      if (sourceRef.harnessId !== this.harnessId) {
        return {
          ok: false,
          error: {
            code: "invalidRequest",
            message: "Pi Adapter cannot open another Harness's Native Session",
            retryable: false,
          },
        };
      }
      const sourceSessionFile = sessionFileFromRef(sourceRef);
      if (input.kind === "fork") {
        const checkpoint = nativeCheckpointRefSchema.parse(input.checkpoint);
        if (
          checkpoint.harnessId !== this.harnessId ||
          checkpoint.nativeSessionId !== sourceRef.nativeSessionId
        ) {
          throw new PiAdapterFaultError({
            code: "checkpointNotFound",
            message: "Pi Checkpoint does not belong to the source Native Session",
            retryable: false,
          });
        }
      }
      transport = this.#createTransport({
        cwd: input.cwd,
        ...(input.kind === "resume"
          ? { sessionFile: sourceSessionFile }
          : { forkSessionFile: sourceSessionFile }),
        onFault: (error) => session?.handleTransportFault(error),
      });
      await transport.start();

      if (input.kind === "resume") {
        if (transport.state.sessionId !== sourceRef.nativeSessionId) {
          throw new PiAdapterFaultError({
            code: "sessionNotFound",
            message: "Pi resumed Session identity does not match the persisted Native Session Ref",
            retryable: false,
          });
        }
      } else {
        const checkpoint = nativeCheckpointRefSchema.parse(input.checkpoint);
        const startupSessionId = transport.state.sessionId;
        if (startupSessionId === sourceRef.nativeSessionId) {
          throw new Error("Pi Fork startup did not create a distinct Native Session identity");
        }
        const copiedHistory = await transport.getEntries();
        let boundary: ReturnType<typeof resolvePiForkBoundary>;
        try {
          boundary = resolvePiForkBoundary(copiedHistory, checkpoint.checkpointId);
        } catch {
          throw new PiAdapterFaultError({
            code: "checkpointNotFound",
            message: "Pi Checkpoint is not on the source Session's active branch",
            retryable: false,
          });
        }
        const derivedState = boundary.nextUserEntryId
          ? await transport.fork(boundary.nextUserEntryId)
          : transport.state;
        if (
          derivedState.sessionId === sourceRef.nativeSessionId ||
          (boundary.nextUserEntryId && derivedState.sessionId === startupSessionId)
        ) {
          throw new Error("Pi Fork did not create the required Native Session identity");
        }
        const derivedSnapshot = mapPiSnapshot(await transport.getEntries(), {
          sessionId: derivedState.sessionId,
          model: nativeModelForHistory(derivedState),
        });
        const terminal = derivedSnapshot.turns.at(-1);
        if (
          derivedSnapshot.turns.length !== boundary.targetTurnIndex + 1 ||
          terminal?.nativeTurnRef.nativeTurnKey !== checkpoint.checkpointId
        ) {
          throw new Error("Pi Fork derived history does not match the requested Checkpoint");
        }
        await transport.verifySessionCwd(input.cwd);
      }

      const startedThinkingLevels = await transport.getAvailableThinkingLevels();
      this.#thinkingSelectionSupported = startedThinkingLevels !== null;
      session = this.#trackSession(input.cwd, {
        startedTransport: transport,
        startedThinkingLevels,
        supportsThinkingSelection: startedThinkingLevels !== null,
      });
      return { ok: true, value: session };
    } catch (error) {
      await transport?.close().catch(() => undefined);
      return { ok: false, error: normalizedError(error, "nativeFailure") };
    }
  }

  #trackSession(
    cwd: string,
    options: {
      model?: HarnessModelRef;
      thinkingOptionId?: HarnessThinkingOptionId;
      supportsThinkingSelection: boolean;
      startedTransport?: PiTurnTransport;
      startedThinkingLevels?: HarnessThinkingOptionId[] | null;
    },
  ): PiHarnessSession {
    const session = new PiHarnessSession(
      cwd,
      this.#createTransport,
      () => {
        this.#sessions.delete(session);
      },
      {
        closeTimeoutMs: this.#closeTimeoutMs,
        ...(options.model ? { model: options.model } : {}),
        ...(options.thinkingOptionId ? { thinkingOptionId: options.thinkingOptionId } : {}),
        toolOutputLimit: this.#toolOutputLimit,
        supportsThinkingSelection: options.supportsThinkingSelection,
        ...(options.startedTransport ? { startedTransport: options.startedTransport } : {}),
        ...(options.startedThinkingLevels !== undefined
          ? { startedThinkingLevels: options.startedThinkingLevels }
          : {}),
      },
    );
    this.#sessions.add(session);
    return session;
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
