import type { Writable } from "node:stream";

import { parseJsonFrame, type JsonObject } from "@codexhost/protocol-core";

import type { OfficialAppServerConnection } from "../official-app-server-connection.js";
import type { CodexRuntimeOutput } from "./codex-runtime.js";
import {
  OfficialRuntimeOwner,
  type OfficialClientSession,
  type OwnedOfficialBackend,
} from "./official-runtime-owner.js";
import { OfficialWorkGate } from "./official-work-gate.js";

export interface CurrentOfficialRuntime {
  request(method: string, params: JsonObject): Promise<JsonObject>;
  send(value: JsonObject): Promise<void>;
  sendFrame(frame: Buffer<ArrayBufferLike>): Promise<void>;
  close(): void;
}

/** Process ownership shared by all AppServerHost clients in one Host deployment. */
export class OfficialRuntimeScope {
  readonly owner: OfficialRuntimeOwner;
  readonly gate: OfficialWorkGate;
  readonly #failure = Promise.withResolvers<Error>();
  #starting: Promise<void> | undefined;
  #started = false;
  #closed = false;

  constructor(input: { createBackend(): OwnedOfficialBackend; diagnosticOutput: Writable }) {
    this.gate = new OfficialWorkGate();
    this.owner = new OfficialRuntimeOwner({
      createBackend: input.createBackend,
      diagnosticOutput: input.diagnosticOutput,
      gate: this.gate,
    });
    this.gate.subscribe(() => {
      if (this.#started && this.gate.phase === "unavailable")
        this.#failure.resolve(new Error("Official Codex is unavailable"));
    });
  }

  start(): Promise<void> {
    if (this.#closed) return Promise.reject(new Error("Official Codex is unavailable"));
    if (this.#started) return Promise.resolve();
    if (this.owner.running) {
      this.#started = true;
      return Promise.resolve();
    }
    if (this.#starting) return this.#starting;
    const starting = this.owner.start().then(() => {
      this.#started = true;
      this.gate.initialized();
    });
    this.#starting = starting;
    void starting.then(
      () => {
        this.#starting = undefined;
      },
      () => {
        this.#starting = undefined;
      },
    );
    return starting;
  }

  attach(output: CodexRuntimeOutput): OfficialClientSession {
    return this.owner.attach(output);
  }
  failure(): Promise<Error> {
    return this.#failure.promise;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.owner.stop();
  }
}

/** Per-Desktop client facade. Account count never changes process count or Thread routing. */
export class OfficialRuntimeClient {
  readonly #scope: OfficialRuntimeScope;
  readonly #session: OfficialClientSession;
  #closed = false;

  constructor(input: { scope: OfficialRuntimeScope; output: CodexRuntimeOutput }) {
    this.#scope = input.scope;
    this.#session = input.scope.attach(input.output);
  }

  initialize(): Promise<void> {
    return this.#scope.start();
  }
  active(): Promise<CurrentOfficialRuntime> {
    return this.#runtime();
  }
  failure(): Promise<Error> {
    return this.#scope.failure();
  }
  initializeProtocol(params: JsonObject): Promise<JsonObject> {
    return this.#session.initialize(params);
  }
  forThread(threadId: string): Promise<CurrentOfficialRuntime> {
    void threadId;
    return this.#runtime();
  }
  requestActive(method: string, params: JsonObject): Promise<JsonObject> {
    return this.#session.request(method, params);
  }
  requestForThread(threadId: string, method: string, params: JsonObject): Promise<JsonObject> {
    void threadId;
    return this.#session.request(method, params);
  }
  close(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true;
      this.#session.close();
    }
    return Promise.resolve();
  }

  async #runtime(): Promise<CurrentOfficialRuntime> {
    if (this.#closed) throw new Error("Official Codex is unavailable");
    return {
      request: (method, params) => this.#session.request(method, params),
      send: (value) => this.#session.send(value),
      sendFrame: async (frame) => {
        const value = parseJsonFrame(frame);
        if (typeof value !== "object" || value === null || Array.isArray(value))
          throw new Error("Official protocol frame must be an object");
        await this.#session.send(value);
      },
      close: () => this.#session.close(),
    };
  }
}

/** Adapter for an already established one-client connection. Production shared
 * listeners should inject their native OwnedOfficialBackend directly. */
export function createSharedConnectionBackend(
  factory: () => OfficialAppServerConnection | Promise<OfficialAppServerConnection>,
  backendClosed: Promise<Awaited<OfficialAppServerConnection["closed"]>>,
): OwnedOfficialBackend {
  const connections = new Set<OfficialAppServerConnection>();
  const closed = Promise.withResolvers<Awaited<OfficialAppServerConnection["closed"]>>();
  void backendClosed.then(closed.resolve);
  let stopped = false;
  return {
    closed: closed.promise,
    async start() {},
    async connect() {
      if (stopped) throw new Error("Official connection backend is stopped");
      const connection = await factory();
      connections.add(connection);
      void connection.closed.finally(() => connections.delete(connection));
      return connection;
    },
    async stop() {
      stopped = true;
      const active = [...connections];
      for (const connection of active) connection.close();
      await Promise.allSettled(active.map((connection) => connection.closed));
      connections.clear();
      closed.resolve({ code: 0, signal: null });
    },
  };
}

export function createOwnedConnectionBackend(
  factory: () => OfficialAppServerConnection | Promise<OfficialAppServerConnection>,
): OwnedOfficialBackend {
  const closed = Promise.withResolvers<Awaited<OfficialAppServerConnection["closed"]>>();
  let connection: OfficialAppServerConnection | undefined;
  let claimed = false;
  return {
    get processId() {
      return connection?.processId;
    },
    closed: closed.promise,
    async start() {
      connection = await factory();
      void connection.closed.then(closed.resolve);
    },
    async connect() {
      if (!connection || claimed) throw new Error("Official connection is unavailable");
      claimed = true;
      return connection;
    },
    async stop() {
      if (!connection) {
        closed.resolve({ code: 0, signal: null });
        return;
      }
      if (connection.stopProcess) await connection.stopProcess();
      else {
        connection.close();
        await connection.closed;
      }
    },
  };
}
