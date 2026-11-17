import {
  AntigravityTransportError,
  type AntigravityAcpEvent,
  type AntigravityAcpSessionOpenResult,
  type AntigravityAcpTransportLike,
  type AntigravityAcpTransportOptions,
} from "./acp-types.js";
import { AntigravityAcpTransport } from "./acp-transport.js";
import type { AntigravityAdapterOptions } from "./antigravity-adapter.js";

const THREAD_SCOPED_ENV_KEYS = new Set(["CODEXHOST_THREAD_ID"]);

export interface SnapshotLoadInput {
  sessionId: string;
  cwd: string;
  environment: NodeJS.ProcessEnv;
  skipPermissions: boolean;
  signal?: AbortSignal;
}

export interface SnapshotLoadOutput {
  opened: AntigravityAcpSessionOpenResult;
  replayedEvents: AntigravityAcpEvent[];
}

interface ReaderLane {
  transport: AntigravityAcpTransportLike | undefined;
  initialized: boolean;
  tail: Promise<void>;
}

function sanitizeReaderEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(environment)) {
    if (value !== undefined && !THREAD_SCOPED_ENV_KEYS.has(key)) {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

function readerScopeKey(
  command: string | undefined,
  skipPermissions: boolean,
  environment: NodeJS.ProcessEnv,
): string {
  const entries = Object.entries(environment).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  return JSON.stringify([command ?? "", skipPermissions, entries]);
}

/**
 * Reuses initialized read-only `agy acp` processes serially across `session/load` reads
 * within matching command, permission, and account/environment boundaries.
 */
export class AntigravitySnapshotReaderPool {
  readonly #lanes = new Map<string, ReaderLane>();
  readonly #retiring = new Set<Promise<void>>();
  readonly #retired = new WeakSet<AntigravityAcpTransportLike>();
  #closed = false;
  #closing: Promise<void> | undefined;

  constructor(private readonly adapterOptions: AntigravityAdapterOptions) {}

  loadSession(input: SnapshotLoadInput): Promise<SnapshotLoadOutput> {
    if (this.#closed || input.signal?.aborted) {
      return Promise.reject(
        new AntigravityTransportError("unavailable", "Snapshot reader is closed"),
      );
    }
    const environment = sanitizeReaderEnvironment(input.environment);
    const key = readerScopeKey(this.adapterOptions.command, input.skipPermissions, environment);
    let lane = this.#lanes.get(key);
    if (!lane) {
      lane = { transport: undefined, initialized: false, tail: Promise.resolve() };
      this.#lanes.set(key, lane);
    }
    const currentLane = lane;
    const run = currentLane.tail.then(() => this.#loadInLane(currentLane, input, environment));
    currentLane.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  close(): Promise<void> {
    return (this.#closing ??= this.#close().catch((error) => {
      this.#closing = undefined;
      throw error;
    }));
  }

  async #close(): Promise<void> {
    this.#closed = true;
    for (const lane of this.#lanes.values()) {
      if (lane.transport) this.#retire(lane, lane.transport);
    }
    this.#lanes.clear();
    await Promise.all(this.#retiring);
  }

  async #loadInLane(
    lane: ReaderLane,
    input: SnapshotLoadInput,
    environment: NodeJS.ProcessEnv,
  ): Promise<SnapshotLoadOutput> {
    if (this.#closed || input.signal?.aborted) {
      throw new AntigravityTransportError("unavailable", "Snapshot reader is closed");
    }
    let transport = lane.transport;
    if (!transport || transport.isClosed) {
      transport = this.#createTransport(lane, input.cwd, environment, input.skipPermissions);
      lane.transport = transport;
      lane.initialized = false;
    }
    if (!lane.initialized) {
      try {
        await transport.initialize();
        lane.initialized = true;
      } catch (error) {
        this.#retire(lane, transport);
        throw error;
      }
    }
    if (this.#closed || transport.isClosed) {
      this.#retire(lane, transport);
      throw new AntigravityTransportError("unavailable", "Snapshot reader is closed");
    }
    if (input.signal?.aborted) {
      throw new AntigravityTransportError("unavailable", "Snapshot read aborted");
    }
    try {
      const { opened, replayedEvents } = await transport.openSession({
        kind: "load",
        sessionId: input.sessionId,
        cwd: input.cwd,
      });
      if (opened.sessionId !== input.sessionId) {
        throw new AntigravityTransportError("protocolError", "Snapshot loaded a different Session");
      }
      await transport.closeSession();
      if (this.#closed || transport.isClosed) {
        this.#retire(lane, transport);
      }
      return { opened, replayedEvents };
    } catch (error) {
      this.#retire(lane, transport);
      throw error;
    }
  }

  #createTransport(
    lane: ReaderLane,
    cwd: string,
    environment: NodeJS.ProcessEnv,
    skipPermissions: boolean,
  ): AntigravityAcpTransportLike {
    const options: AntigravityAcpTransportOptions = {
      cwd,
      ...(this.adapterOptions.command ? { command: this.adapterOptions.command } : {}),
      environment,
      skipPermissions,
      ...(this.adapterOptions.commandTimeoutMs !== undefined
        ? { commandTimeoutMs: this.adapterOptions.commandTimeoutMs }
        : {}),
      ...(this.adapterOptions.closeTimeoutMs !== undefined
        ? { closeTimeoutMs: this.adapterOptions.closeTimeoutMs }
        : {}),
      onFault: () => {
        this.#retire(lane, transport);
      },
    };
    const transport =
      this.adapterOptions.createTransport?.(options) ?? new AntigravityAcpTransport(options);
    return transport;
  }

  #retire(lane: ReaderLane, transport: AntigravityAcpTransportLike): void {
    if (lane.transport === transport) {
      lane.transport = undefined;
      lane.initialized = false;
    }
    if (this.#retired.has(transport)) return;
    this.#retired.add(transport);
    let raw: Promise<void>;
    try {
      raw = transport.close();
    } catch (error) {
      raw = Promise.reject(error);
    }
    const tracked: Promise<void> = raw.then(() => {
      this.#retiring.delete(tracked);
    });
    this.#retiring.add(tracked);
    void tracked.catch(() => undefined);
  }
}
