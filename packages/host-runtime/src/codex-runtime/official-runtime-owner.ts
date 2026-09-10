import { randomUUID } from "node:crypto";
import type { Writable } from "node:stream";

import type { JsonObject } from "@codexhost/protocol-core";

import type {
  OfficialAppServerConnection,
  OfficialAppServerExit,
} from "../official-app-server-connection.js";
import { CodexRuntime, type CodexRuntimeOutput } from "./codex-runtime.js";
import { OfficialAdmissionError, type OfficialWorkGate } from "./official-work-gate.js";
import { OfficialWorkTracker } from "./official-work-tracker.js";

/** Created synchronously so a failed start never hides an owned, possibly live process. */
export interface OwnedOfficialBackend {
  readonly processId?: number | undefined;
  readonly closed: Promise<OfficialAppServerExit>;
  start(): Promise<void>;
  connect(): Promise<OfficialAppServerConnection>;
  stop(): Promise<void>;
}
export interface OfficialClientSession {
  configure(params: JsonObject): void;
  initialize(params: JsonObject): Promise<JsonObject>;
  request(method: string, params: JsonObject): Promise<JsonObject>;
  send(value: JsonObject): Promise<void>;
  close(): void;
}
interface Pending {
  id: string | number;
  method: string;
  params: JsonObject;
  finish(): void;
  observe(response: JsonObject): void;
}
interface Client {
  id: string;
  output: CodexRuntimeOutput;
  runtime?: CodexRuntime;
  connecting?: Promise<CodexRuntime>;
  initializing?: Promise<JsonObject>;
  initialization?: JsonObject;
  initializationResult?: JsonObject;
  pending: Map<string, Pending>;
  serverRequests: Map<string, string | number>;
  threads: Map<string, { params: JsonObject; generation: number; restoring?: Promise<void> }>;
}
const object = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const requestKey = (id: string | number): string => JSON.stringify([typeof id, id]);
const RESUME_FIELDS = new Set([
  "model",
  "modelProvider",
  "serviceTier",
  "cwd",
  "runtimeWorkspaceRoots",
  "approvalPolicy",
  "approvalsReviewer",
  "sandbox",
  "permissions",
  "config",
  "baseInstructions",
  "developerInstructions",
  "personality",
]);

/** One process owner, many native client connections; never a per-Account pool. */
export class OfficialRuntimeOwner {
  readonly gate: OfficialWorkGate;
  readonly #factory: () => OwnedOfficialBackend;
  readonly #diagnosticOutput: Writable;
  readonly #clients = new Set<Client>();
  readonly #work: OfficialWorkTracker;
  readonly #threadSettings = new Map<
    string,
    { model: string; modelProvider: string; effort: string | null }
  >();
  #backend: OwnedOfficialBackend | undefined;
  #generation = 0;
  #phase: "stopped" | "starting" | "running" | "stopping" | "unavailable" = "stopped";
  #starting: Promise<void> | undefined;
  #stopping: Promise<void> | undefined;

  constructor(input: {
    createBackend(): OwnedOfficialBackend;
    diagnosticOutput: Writable;
    gate: OfficialWorkGate;
  }) {
    this.#factory = input.createBackend;
    this.#diagnosticOutput = input.diagnosticOutput;
    this.gate = input.gate;
    this.#work = new OfficialWorkTracker(this.gate, (id, threadId) => {
      const client = [...this.#clients].find((candidate) => candidate.id === id);
      if (client) void this.#inspectQueue(client, threadId);
    });
  }
  get generation(): number {
    return this.#generation;
  }

  get running(): boolean {
    return this.#phase === "running";
  }

  start(initializeClients = true): Promise<void> {
    if (this.#starting) return this.#starting;
    if (this.#backend || this.#phase !== "stopped")
      return Promise.reject(new OfficialAdmissionError("unavailable"));
    this.#phase = "starting";
    let backend: OwnedOfficialBackend;
    try {
      backend = this.#factory();
    } catch {
      this.#phase = "stopped";
      return Promise.reject(new OfficialAdmissionError("unavailable"));
    }
    this.#backend = backend;
    const generation = ++this.#generation;
    void backend.closed.then(() => {
      if (this.#backend === backend) {
        if (this.#phase !== "stopping") this.#unavailable();
        this.#work.retired();
        this.gate.retired();
      }
    });
    const starting = (async () => {
      try {
        await backend.start();
        if (this.#phase !== "starting") throw new OfficialAdmissionError("unavailable");
        if (initializeClients) {
          for (const client of this.#clients) {
            // Attach output immediately. Native notifications and early process
            // failure must not be lost merely because Desktop initialize has not arrived.
            await this.#connection(client);
            if (client.initialization) await this.#initialize(client, client.initialization);
          }
        }
        if (generation !== this.#generation || this.#phase !== "starting")
          throw new OfficialAdmissionError("unavailable");
        this.#phase = "running";
      } catch {
        this.#unavailable();
        throw new OfficialAdmissionError("unavailable");
      }
    })();
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

  stop(): Promise<void> {
    if (this.#stopping) return this.#stopping;
    const stopping = (async () => {
      if (this.#starting) await this.#starting.catch(() => undefined);
      const backend = this.#backend;
      if (!backend) {
        this.#phase = "stopped";
        return;
      }
      this.#phase = "stopping";
      if (this.gate.phase === "ready") this.gate.unavailable();
      for (const client of this.#clients) this.#retire(client);
      try {
        await backend.stop();
        // stop() must itself reject unconfirmed exit; this wait is an additional proof.
        await backend.closed;
        for (const client of this.#clients) {
          client.runtime?.close();
          delete client.runtime;
          delete client.initializationResult;
          delete client.connecting;
          delete client.initializing;
        }
        this.#backend = undefined;
        this.#phase = "stopped";
        this.gate.retired();
      } catch {
        this.#unavailable();
        throw new OfficialAdmissionError("unavailable");
      }
    })();
    this.#stopping = stopping;
    void stopping.then(
      () => {
        this.#stopping = undefined;
      },
      () => {
        this.#stopping = undefined;
      },
    );
    return stopping;
  }

  attach(output: CodexRuntimeOutput): OfficialClientSession {
    const client: Client = {
      id: randomUUID(),
      output,
      pending: new Map(),
      serverRequests: new Map(),
      threads: new Map(),
    };
    this.#clients.add(client);
    return {
      configure: (params) => this.#configure(client, params),
      initialize: (params) => this.#initialize(client, params),
      request: (method, params) => this.#request(client, method, structuredClone(params)),
      send: (value) => this.#send(client, structuredClone(value)),
      close: () => {
        this.#clients.delete(client);
        this.#retire(client);
        client.runtime?.close();
      },
    };
  }

  /** Management-only requests; work admission cannot use this as a routing shortcut. */
  async controlRequest(method: string, params: JsonObject): Promise<JsonObject> {
    const client = [...this.#clients].find(
      (candidate) =>
        candidate.initializationResult && candidate.runtime?.generation === this.#generation,
    );
    if (!client || this.#phase !== "running") throw new OfficialAdmissionError("unavailable");
    const runtime = await this.#connection(client);
    const response = await runtime.request(method, params);
    if (
      client.runtime !== runtime ||
      runtime.generation !== this.#generation ||
      this.#phase !== "running"
    )
      throw new OfficialAdmissionError("unavailable");
    return response;
  }

  /** Capture authoritative live thread/read results after closing admission, rather
   * than ordering duplicate settings notifications from independent connections.
   */
  captureThreadSettings(threads: readonly JsonObject[]): void {
    if (this.gate.phase === "ready") throw new OfficialAdmissionError("busy");
    for (const thread of threads) {
      if (
        typeof thread.id !== "string" ||
        typeof thread.model !== "string" ||
        typeof thread.modelProvider !== "string" ||
        (thread.reasoningEffort != null && typeof thread.reasoningEffort !== "string")
      )
        throw new Error("Official Thread settings capture failed");
      this.#threadSettings.set(thread.id, {
        model: thread.model,
        modelProvider: thread.modelProvider,
        effort: thread.reasoningEffort ?? null,
      });
    }
  }

  #configure(client: Client, params: JsonObject): void {
    if (client.initialization && JSON.stringify(client.initialization) !== JSON.stringify(params))
      throw new Error("Official client initialization parameters changed");
    client.initialization = structuredClone(params);
  }

  async #initialize(client: Client, params: JsonObject): Promise<JsonObject> {
    this.#configure(client, params);
    if (client.initializationResult) return client.initializationResult;
    if (client.initializing) return client.initializing;
    const pending = (async () => {
      const runtime = await this.#connection(client);
      const response = await runtime.request("initialize", client.initialization ?? params);
      if (response.error) throw new Error("Official client initialization failed");
      await runtime.send({ method: "initialized" });
      if (client.runtime !== runtime || runtime.generation !== this.#generation)
        throw new OfficialAdmissionError("unavailable");
      client.initializationResult = response;
      return response;
    })();
    client.initializing = pending;
    try {
      return await pending;
    } finally {
      if (client.initializing === pending) delete client.initializing;
    }
  }

  async #connection(client: Client): Promise<CodexRuntime> {
    if (
      !this.#clients.has(client) ||
      !this.#backend ||
      !["starting", "running"].includes(this.#phase)
    )
      throw new OfficialAdmissionError("unavailable");
    if (client.runtime) return client.runtime;
    if (client.connecting) return client.connecting;
    const backend = this.#backend;
    const generation = this.#generation;
    const pending = (async () => {
      const connection = await backend.connect();
      if (
        backend !== this.#backend ||
        !this.#clients.has(client) ||
        !["starting", "running"].includes(this.#phase)
      ) {
        connection.close();
        throw new OfficialAdmissionError("unavailable");
      }
      const runtime = new CodexRuntime({
        generation,
        connection,
        diagnosticOutput: this.#diagnosticOutput,
        onOutput: (event) => this.#output(client, event),
        onClosed: (error) => {
          if (
            error &&
            this.#clients.has(client) &&
            generation === this.#generation &&
            this.#phase !== "stopping"
          )
            this.#unavailable();
        },
      });
      client.runtime = runtime;
      return runtime;
    })();
    client.connecting = pending;
    try {
      return await pending;
    } finally {
      if (client.connecting === pending) delete client.connecting;
    }
  }

  async #request(client: Client, method: string, params: JsonObject): Promise<JsonObject> {
    this.#checkMethod(method, params);
    const finish = this.gate.admit();
    try {
      const runtime = await this.#connection(client);
      await this.#restore(client, runtime, method, params);
      const observe = this.#work.admitted(client.id, method, params);
      const response = await runtime.request(method, params);
      if (
        client.runtime !== runtime ||
        runtime.generation !== this.#generation ||
        this.#phase !== "running"
      )
        throw new OfficialAdmissionError("unavailable");
      observe(response);
      this.#remember(client, method, params, response);
      return response;
    } finally {
      finish();
    }
  }

  async #send(client: Client, value: JsonObject): Promise<void> {
    if (typeof value.method !== "string") {
      const original =
        typeof value.id === "string" ? client.serverRequests.get(value.id) : undefined;
      if (
        original === undefined ||
        !client.runtime ||
        client.runtime.generation !== this.#generation
      )
        throw new Error("Retired official server request");
      const key = String(value.id);
      client.serverRequests.delete(key);
      await client.runtime.send({ ...value, id: original });
      this.gate.nativeWork(key, false);
      return;
    }
    if (value.method === "initialized") return;
    if (typeof value.id !== "string" && typeof value.id !== "number")
      throw new Error("Official methods require a request ID");
    const params = object(value.params) ? value.params : {};
    this.#checkMethod(value.method, params);
    const finish = this.gate.admit();
    let pendingKey: string | undefined;
    try {
      const runtime = await this.#connection(client);
      await this.#restore(client, runtime, value.method, params);
      if (typeof value.id === "string" || typeof value.id === "number") {
        const key = requestKey(value.id);
        if (client.pending.has(key)) throw new Error("Duplicate official request ID");
        pendingKey = key;
        client.pending.set(pendingKey, {
          id: value.id,
          method: value.method,
          params,
          finish,
          observe: this.#work.admitted(client.id, value.method, params),
        });
      }
      await runtime.send(value);
      if (!pendingKey) finish();
    } catch (error) {
      if (pendingKey) client.pending.delete(pendingKey);
      finish();
      throw error;
    }
  }

  #checkMethod(method: string, params: JsonObject): void {
    if (
      method === "initialize" ||
      method.startsWith("account/login/") ||
      method === "account/logout" ||
      method === "codexhost/account/activate" ||
      "__codexhostAccountId" in params
    ) {
      throw new Error(
        "Official authentication and legacy Account overrides require the current Host coordinator",
      );
    }
  }

  async #output(client: Client, event: Parameters<CodexRuntimeOutput>[0]): Promise<void> {
    if (
      !this.#clients.has(client) ||
      event.generation !== this.#generation ||
      !["running", "starting"].includes(this.#phase)
    )
      return;
    const value = event.value;
    if (!object(value)) return client.output(event);
    this.#work.notification(client.id, value);
    if (typeof value.id === "string" || typeof value.id === "number") {
      if (typeof value.method === "string") {
        const id = `codexhost:server:${client.id}:${event.generation}:${randomUUID()}`;
        client.serverRequests.set(id, value.id);
        this.gate.nativeWork(id, true);
        const projected = { ...value, id };
        return client.output({
          ...event,
          value: projected,
          frame: Buffer.from(`${JSON.stringify(projected)}\n`),
        });
      }
      const pending = client.pending.get(requestKey(value.id));
      if (pending) {
        pending.observe(value);
        this.#remember(client, pending.method, pending.params, value);
        client.pending.delete(requestKey(value.id));
        pending.finish();
      }
    }
    await client.output(event);
  }

  #remember(client: Client, method: string, params: JsonObject, response: JsonObject): void {
    if (response.error) return;
    if (
      ["thread/archive", "thread/unsubscribe"].includes(method) &&
      typeof params.threadId === "string"
    )
      client.threads.delete(params.threadId);
    if (
      !["thread/start", "thread/resume", "thread/fork"].includes(method) ||
      !object(response.result) ||
      !object(response.result.thread)
    )
      return;
    const id = response.result.thread.id;
    if (typeof id !== "string") return;
    // Do not retain history/path: native resume can ignore threadId when those are supplied.
    const resume = Object.fromEntries(
      Object.entries(params).filter(([key]) => RESUME_FIELDS.has(key)),
    ) as JsonObject;
    client.threads.set(id, {
      params: { ...structuredClone(resume), threadId: id, excludeTurns: true },
      generation: this.#generation,
    });
  }

  async #restore(
    client: Client,
    runtime: CodexRuntime,
    method: string,
    params: JsonObject,
  ): Promise<void> {
    if (
      typeof params.threadId !== "string" ||
      !(
        method.startsWith("turn/") ||
        method.startsWith("thread/realtime/") ||
        method === "thread/compact/start" ||
        method === "thread/queue/start" ||
        method === "thread/shellCommand" ||
        method === "thread/settings/update" ||
        method === "thread/rollback" ||
        method === "thread/revert" ||
        method.startsWith("thread/backgroundTerminals/")
      )
    )
      return;
    const threadId = params.threadId;
    const subscription = client.threads.get(threadId);
    if (!subscription || subscription.generation === runtime.generation) return;
    if (subscription.restoring) return subscription.restoring;
    const restoring = (async () => {
      const settings = this.#threadSettings.get(threadId);
      const resume = settings
        ? { ...subscription.params, model: settings.model, modelProvider: settings.modelProvider }
        : subscription.params;
      const observe = this.#work.admitted(client.id, "thread/resume", resume);
      const response = await runtime.request("thread/resume", resume);
      observe(response);
      if (
        response.error ||
        !object(response.result) ||
        !object(response.result.thread) ||
        response.result.thread.id !== params.threadId
      )
        throw new Error("Official Thread restoration failed");
      if (client.runtime !== runtime || runtime.generation !== this.#generation)
        throw new OfficialAdmissionError("unavailable");
      if (settings) {
        if (settings.effort !== null) {
          const restored = await runtime.request("thread/settings/update", {
            threadId,
            effort: settings.effort,
          });
          if (
            restored.error ||
            !object(restored.result) ||
            client.runtime !== runtime ||
            runtime.generation !== this.#generation
          )
            throw new Error("Official Thread settings restoration failed");
        }
        const read = await runtime.request("thread/read", { threadId, includeTurns: false });
        if (
          read.error ||
          !object(read.result) ||
          !object(read.result.thread) ||
          client.runtime !== runtime ||
          runtime.generation !== this.#generation ||
          read.result.thread.model !== settings.model ||
          read.result.thread.modelProvider !== settings.modelProvider ||
          (read.result.thread.reasoningEffort ?? null) !== settings.effort
        )
          throw new Error("Official Thread settings restoration failed");
      }
      subscription.generation = runtime.generation;
    })();
    subscription.restoring = restoring;
    try {
      await restoring;
    } finally {
      if (subscription.restoring === restoring) delete subscription.restoring;
    }
  }

  async #inspectQueue(client: Client, threadId: string): Promise<void> {
    const runtime = client.runtime;
    if (!runtime) return;
    const params: JsonObject = { threadId, cursor: null, limit: 1 };
    const observe = this.#work.admitted(client.id, "thread/queue/list", params);
    try {
      const response = await runtime.request("thread/queue/list", params);
      if (
        runtime === client.runtime &&
        runtime.generation === this.#generation &&
        this.#clients.has(client)
      )
        observe(response);
    } catch {
      /* Keep unknown queued work busy; never infer idle from a failed query. */
    }
  }

  #retire(client: Client): void {
    client.runtime?.retire();
    for (const subscription of client.threads.values()) delete subscription.restoring;
    for (const pending of client.pending.values()) {
      pending.finish();
      const value: JsonObject = {
        id: pending.id,
        error: { code: -32001, message: "Official connection retired; retry explicitly" },
      };
      void client
        .output({
          generation: this.#generation,
          value,
          frame: Buffer.from(`${JSON.stringify(value)}\n`),
        })
        .catch(() => undefined);
    }
    client.pending.clear();
    for (const id of client.serverRequests.keys()) this.gate.nativeWork(id, false);
    client.serverRequests.clear();
  }

  #unavailable(): void {
    this.#phase = "unavailable";
    for (const client of this.#clients) {
      this.#retire(client);
      client.runtime?.close();
    }
    this.gate.unavailable();
  }
}
