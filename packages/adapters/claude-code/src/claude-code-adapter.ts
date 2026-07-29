import { randomUUID } from "node:crypto";

import {
  HarnessOutputChannel,
  type CreateSessionInput,
  type HarnessAdapter,
  type HarnessError,
  type HarnessOutput,
  type HarnessResult,
  type HarnessSession,
  type HarnessSessionState,
  type HostAgentMessageItem,
  type HostCommand,
  type HostEvent,
  type HostItemOutcome,
  type InteractionRespondAccepted,
  type InteractionRespondCommand,
  type TurnCancelAccepted,
  type TurnCancelCommand,
  type TurnOutcome,
  type TurnStartAccepted,
  type TurnStartCommand,
} from "@codexhost/harness-adapter";
import { harnessIdSchema, hostItemIdSchema, type HarnessId } from "@codexhost/shared-contracts";

import { ClaudeCodeExecutableError } from "./command.js";
import { ClaudeSdkTransport } from "./sdk-transport.js";
import type {
  ClaudeAdapterDependencies,
  ClaudeTransportFailureKind,
  ClaudeTransportTurnResult,
  ClaudeTurnTransport,
} from "./transport.js";

export interface ClaudeCodeAdapterOptions {
  command?: string;
  environment?: NodeJS.ProcessEnv;
  closeTimeoutMs?: number;
}

type SessionPhase = "open" | "closing" | "closed" | "faulted";

interface ActiveTurn {
  command: TurnStartCommand;
  item: HostAgentMessageItem;
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
  readonly initialState: HarnessSessionState = {};
  readonly outputs: AsyncIterable<HarnessOutput>;
  readonly #channel = new HarnessOutputChannel<HarnessOutput>();
  readonly #closeTimeoutMs: number;
  readonly #createTransport: ClaudeAdapterDependencies["createTransport"];
  readonly #cwd: string;
  readonly #onClosed: () => void;
  readonly #randomUUID: () => string;
  readonly #sessionId: string;
  #acceptingTurn = false;
  #active: ActiveTurn | null = null;
  #closePromise: Promise<void> | null = null;
  #phase: SessionPhase = "open";
  #statePublished = false;
  #transport: ClaudeTurnTransport | null = null;

  constructor(
    cwd: string,
    dependencies: ClaudeAdapterDependencies,
    closeTimeoutMs: number,
    onClosed: () => void,
  ) {
    this.#cwd = cwd;
    this.#createTransport = dependencies.createTransport;
    this.#randomUUID = dependencies.randomUUID;
    this.#closeTimeoutMs = closeTimeoutMs;
    this.#onClosed = onClosed;
    this.#sessionId = this.#randomUUID();
    this.outputs = this.#channel.outputs;
  }

  execute(command: TurnStartCommand): Promise<HarnessResult<TurnStartAccepted>>;
  execute(command: TurnCancelCommand): Promise<HarnessResult<TurnCancelAccepted>>;
  execute(command: InteractionRespondCommand): Promise<HarnessResult<InteractionRespondAccepted>>;
  async execute(
    command: HostCommand,
  ): Promise<HarnessResult<TurnStartAccepted | TurnCancelAccepted | InteractionRespondAccepted>> {
    if (this.#phase !== "open") {
      return { ok: false, error: invalidState("Claude Code Session is not open") };
    }
    if (command.type === "turn.cancel") return this.#cancel(command);
    if (command.type === "interaction.respond") {
      return {
        ok: false,
        error: {
          code: "unsupported",
          message: "Claude Code Interaction is not implemented in this Adapter slice",
          retryable: false,
        },
      };
    }
    if (this.#acceptingTurn || this.#active) {
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
    this.#publishState();
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
      cancellationRequested: false,
      completion,
      resolveCompletion,
    };
    this.#active = active;
    this.#event({ type: "turn.started", turnId: command.turnId });
    this.#event({ type: "item.started", turnId: command.turnId, item });
    try {
      const running = transport.runTurn(text, this.#randomUUID(), (delta) => {
        this.#appendText(active, delta);
      });
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
    if (this.#phase !== "faulted") this.#phase = "closing";
    const active = this.#active;
    if (active) {
      active.cancellationRequested = true;
      await this.#transport?.abort().catch(() => undefined);
      await Promise.race([active.completion, delay(this.#closeTimeoutMs)]);
      if (this.#active === active) {
        this.#finishFailed(active, invalidState("Claude Code Session closed during active Turn"));
      }
    }
    await this.#transport?.close().catch(() => undefined);
    this.#phase = "closed";
    this.#channel.end();
    this.#onClosed();
  }

  async #ensureTransport(): Promise<ClaudeTurnTransport> {
    if (this.#transport) return this.#transport;
    const transport = this.#createTransport({
      cwd: this.#cwd,
      sessionId: this.#sessionId,
      onFault: () => this.#fault(faultError()),
    });
    try {
      await transport.start();
    } catch (error) {
      await transport.close().catch(() => undefined);
      throw error;
    }
    this.#transport = transport;
    return transport;
  }

  #publishState(): void {
    if (this.#statePublished) return;
    this.#statePublished = true;
    this.#event({
      type: "session.state.changed",
      state: {
        nativeRef: {
          harnessId: this.harnessId,
          nativeSessionId: this.#sessionId,
          formatVersion: 1,
        },
      },
    });
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
    if (result.status === "succeeded") {
      this.#finish(active, { status: "succeeded" });
    } else if (result.status === "cancelled") {
      this.#finish(active, { status: "cancelled", reason: result.reason });
    } else {
      this.#finishFailed(active, transportFailure(result.kind));
    }
  }

  #finishFailed(active: ActiveTurn, error: HarnessError): void {
    this.#finish(active, { status: "failed", error });
  }

  #finish(active: ActiveTurn, outcome: TurnOutcome): void {
    if (this.#active !== active) return;
    const itemOutcome: HostItemOutcome = outcome;
    this.#event({
      type: "item.completed",
      turnId: active.command.turnId,
      snapshot: { item: active.item, outcome: itemOutcome },
    });
    this.#event({ type: "turn.completed", turnId: active.command.turnId, outcome });
    this.#active = null;
    active.resolveCompletion();
  }

  #fault(error: HarnessError): void {
    if (this.#phase === "closed" || this.#phase === "closing" || this.#phase === "faulted") return;
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
  readonly #sessions = new Set<ClaudeHarnessSession>();
  #closePromise: Promise<void> | null = null;

  constructor(options: ClaudeCodeAdapterOptions = {}, dependencies?: ClaudeAdapterDependencies) {
    this.#closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
    this.#dependencies = dependencies ?? {
      randomUUID,
      createTransport: (input) =>
        new ClaudeSdkTransport({
          ...input,
          ...(options.command ? { command: options.command } : {}),
          environment: options.environment ?? process.env,
          closeTimeoutMs: this.#closeTimeoutMs,
        }),
    };
  }

  async open(input: CreateSessionInput): Promise<HarnessResult<HarnessSession>> {
    if (this.#closePromise) {
      return {
        ok: false,
        error: invalidState("Claude Code Adapter is closing"),
      };
    }
    if (input.kind !== "create" || input.cwd.length === 0) {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "Claude Code Adapter requires a create input with cwd",
          retryable: false,
        },
      };
    }
    const session = new ClaudeHarnessSession(
      input.cwd,
      this.#dependencies,
      this.#closeTimeoutMs,
      () => this.#sessions.delete(session),
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
