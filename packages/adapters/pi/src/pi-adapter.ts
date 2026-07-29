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
  type TurnOutcome,
  type TurnStartAccepted,
} from "@codexhost/harness-adapter";
import {
  harnessIdSchema,
  hostItemIdSchema,
  type HarnessId,
  type HostItemId,
} from "@codexhost/shared-contracts";
import { randomUUID } from "node:crypto";

import {
  PiRpcFaultError,
  PiRpcSession,
  type PiRpcSessionOptions,
  type PiSessionState,
} from "./pi-rpc-session.js";

export interface PiAdapterOptions {
  command?: string;
  environment?: NodeJS.ProcessEnv;
  commandTimeoutMs?: number;
  turnTimeoutMs?: number;
  closeTimeoutMs?: number;
}

export interface PiTextTransport {
  readonly state: PiSessionState;
  start(): Promise<unknown>;
  runTextTurn(text: string, onDelta: (delta: string) => void): Promise<{ text: string }>;
  close(): Promise<void>;
}

export interface PiAdapterDependencies {
  createTransport(options: PiRpcSessionOptions): PiTextTransport;
}

interface ActiveTurn {
  command: HostCommand;
  item: HostAgentMessageItem;
}

type SessionPhase = "open" | "closing" | "closed" | "faulted";

const piHarnessId = harnessIdSchema.parse("pi");

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

class PiHarnessSession implements HarnessSession {
  readonly harnessId: HarnessId = piHarnessId;
  readonly initialState: HarnessSessionState = {};
  readonly outputs: AsyncIterable<HarnessOutput>;
  readonly #channel = new HarnessOutputChannel<HarnessOutput>();
  readonly #createTransport: PiAdapterDependencies["createTransport"];
  readonly #cwd: string;
  readonly #onClosed: () => void;
  #acceptingTurn = false;
  #active: ActiveTurn | null = null;
  #closePromise: Promise<void> | null = null;
  #phase: SessionPhase = "open";
  #starting: Promise<PiTextTransport> | null = null;
  #state: HarnessSessionState = {};
  #transport: PiTextTransport | null = null;

  constructor(
    cwd: string,
    createTransport: PiAdapterDependencies["createTransport"],
    onClosed: () => void,
  ) {
    this.#cwd = cwd;
    this.#createTransport = createTransport;
    this.#onClosed = onClosed;
    this.outputs = this.#channel.outputs;
  }

  async execute(command: HostCommand): Promise<HarnessResult<TurnStartAccepted>> {
    if (this.#phase !== "open") {
      return { ok: false, error: invalidState("Pi Session is not open") };
    }
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
      let transport: PiTextTransport;
      try {
        transport = await this.#ensureTransport();
      } catch (error) {
        return { ok: false, error: normalizedError(error, "unavailable") };
      }
      if (this.#phase !== "open") {
        return { ok: false, error: invalidState("Pi Session became unavailable during startup") };
      }

      const item: HostAgentMessageItem = {
        type: "agentMessage",
        itemId: this.#newItemId(),
        text: "",
      };
      const active: ActiveTurn = { command, item };
      this.#active = active;
      this.#event({ type: "turn.started", turnId: command.turnId });
      this.#event({ type: "item.started", turnId: command.turnId, item });

      void transport
        .runTextTurn(text, (delta) => this.#appendText(active, delta))
        .then(({ text: output }) => this.#completeTurn(active, { status: "succeeded" }, output))
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

  async #ensureTransport(): Promise<PiTextTransport> {
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

  #appendText(active: ActiveTurn, text: string): void {
    if (this.#active !== active || this.#phase !== "open") return;
    active.item = { ...active.item, text: active.item.text + text };
    this.#event({
      type: "item.updated",
      turnId: active.command.turnId,
      itemId: active.item.itemId,
      update: { type: "text.append", text },
    });
  }

  #completeTurn(active: ActiveTurn, outcome: TurnOutcome, finalText?: string): void {
    if (this.#active !== active) return;
    this.#active = null;
    if (finalText !== undefined) active.item = { ...active.item, text: finalText };
    const itemOutcome =
      outcome.status === "failed"
        ? { status: "failed" as const, error: outcome.error }
        : outcome.status === "cancelled"
          ? { status: "cancelled" as const, ...(outcome.reason ? { reason: outcome.reason } : {}) }
          : { status: "succeeded" as const };
    this.#event({
      type: "item.completed",
      turnId: active.command.turnId,
      snapshot: { item: active.item, outcome: itemOutcome },
    });
    this.#event({ type: "turn.completed", turnId: active.command.turnId, outcome });
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
    try {
      if (transport) await transport.close();
    } catch (error) {
      this.#fault(error);
      throw error;
    }
    if (this.#active) {
      const error = invalidState("Pi Session closed during an active Turn");
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
  readonly #createTransport: PiAdapterDependencies["createTransport"];
  readonly #sessions = new Set<PiHarnessSession>();
  #closePromise: Promise<void> | null = null;

  constructor(
    options: PiAdapterOptions = {},
    dependencies: PiAdapterDependencies = {
      createTransport: (sessionOptions) => new PiRpcSession({ ...options, ...sessionOptions }),
    },
  ) {
    this.#createTransport = dependencies.createTransport;
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
    const session = new PiHarnessSession(input.cwd, this.#createTransport, () => {
      this.#sessions.delete(session);
    });
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
