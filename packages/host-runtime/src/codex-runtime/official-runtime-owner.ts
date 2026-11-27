import { randomUUID } from "node:crypto";
import type { Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";

import type { JsonObject } from "@codexhost/protocol-core";

import type {
  OfficialAppServerConnection,
  OfficialAppServerExit,
} from "../official-app-server-connection.js";
import { observeProxyFrames } from "../remote-official-connection.js";
import { CodexRuntime, type CodexRuntimeOutput } from "./codex-runtime.js";
import { OfficialAdmissionError, type OfficialWorkGate } from "./official-work-gate.js";

/** Created synchronously so a failed start never hides an owned, possibly live process. */
export interface OwnedOfficialBackend {
  readonly processId?: number | undefined;
  readonly isolatesConnectionFailures?: boolean;
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
type RequestId = string | number;
interface Pending {
  method: string;
  params: JsonObject;
  finish(): void;
}
interface Client {
  id: string;
  role: "task" | "management";
  output: CodexRuntimeOutput;
  onBackendStopped?: () => void;
  runtime?: CodexRuntime;
  connecting?: Promise<CodexRuntime>;
  reconnecting?: Promise<void>;
  initializing?: Promise<JsonObject>;
  initialization?: JsonObject;
  initializationResult?: JsonObject;
  pending: Map<RequestId, Pending>;
  serverRequests: Map<string, RequestId>;
  threads: Map<string, { params: JsonObject; generation?: number; restoring?: Promise<void> }>;
}
interface ProxyConnection {
  hasActiveWork(): boolean;
  retire(): void;
}
export interface OfficialRuntimeOwnerOptions {
  createBackend(): OwnedOfficialBackend;
  diagnosticOutput: Writable;
  gate: OfficialWorkGate;
}
const object = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const turnId = (turn: unknown): string | undefined =>
  object(turn) && typeof turn.id === "string" ? turn.id : undefined;
const nativeThreadMissing = (error: unknown): boolean =>
  object(error) &&
  typeof error.message === "string" &&
  /no rollout found for thread id|thread not found|invalid thread id/i.test(error.message);
class OfficialThreadRestorationError extends Error {
  constructor(readonly missing: boolean) {
    super("Official Thread restoration failed");
  }
}
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
  readonly #proxies = new Set<ProxyConnection>();
  readonly #unobservedProxyThreads = new Map<string, symbol>();
  readonly #activeTurns = new Map<string, string | undefined>();
  readonly #threadModelSettings = new Map<string, JsonObject & { model: string }>();
  #backend: OwnedOfficialBackend | undefined;
  #generation = 0;
  #hasStartedSuccessfully = false;
  #phase: "stopped" | "starting" | "running" | "stopping" | "unavailable" = "stopped";
  #starting: Promise<void> | undefined;
  #stopping: Promise<void> | undefined;
  #checkingProxyThreads = false;

  constructor(input: OfficialRuntimeOwnerOptions) {
    this.#factory = input.createBackend;
    this.#diagnosticOutput = input.diagnosticOutput;
    this.gate = input.gate;
  }
  get generation(): number {
    return this.#generation;
  }

  get hasActiveWork(): boolean {
    if (this.gate.busy || this.#activeTurns.size > 0 || this.#unobservedProxyThreads.size > 0)
      return true;
    for (const proxy of this.#proxies) {
      if (proxy.hasActiveWork()) return true;
    }
    return false;
  }

  get running(): boolean {
    return this.#phase === "running";
  }

  /** Stays true when a confirmed generation is retired or its replacement fails to start. */
  get hasStartedSuccessfully(): boolean {
    return this.#hasStartedSuccessfully;
  }

  start(): Promise<void> {
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
    this.#threadModelSettings.clear();
    void backend.closed.then(() => {
      if (this.#backend !== backend || this.#phase === "stopping") return;
      // Keep ownership until the backend stop path completes.
      this.#unavailable();
      void this.stop().catch(() => undefined);
    });
    const starting = (async () => {
      try {
        await backend.start();
        if (this.#phase !== "starting") throw new OfficialAdmissionError("unavailable");
        const clients = [...this.#clients];
        // The Host management protocol must be initialized before Desktop can attach
        // to a managed listener. This also makes cold-start verification independent
        // of Desktop's initialize timing.
        clients.sort((left, right) =>
          left.role === right.role ? 0 : left.role === "management" ? -1 : 1,
        );
        for (const client of clients) {
          // Attach output immediately. Native notifications and early process
          // failure must not be lost merely because Desktop initialize has not arrived.
          await this.#connection(client);
          if (client.initialization) await this.#initialize(client, client.initialization);
        }
        if (generation !== this.#generation || this.#phase !== "starting")
          throw new OfficialAdmissionError("unavailable");
        this.#phase = "running";
        this.#hasStartedSuccessfully = true;
        if (backend.isolatesConnectionFailures) {
          for (const client of clients) {
            if (client.threads.size) this.#reconnectClient(client, backend, generation);
          }
        }
      } catch (error) {
        this.#unavailable();
        throw new OfficialAdmissionError("unavailable", error);
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
    let retired = false;
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
      this.#closeProxies();
      try {
        await backend.stop();
        // stop() must itself reject unconfirmed exit; this wait is an additional proof.
        await backend.closed;
        for (const client of this.#clients) {
          this.#closeClientConnection(client);
          delete client.connecting;
          delete client.reconnecting;
        }
        this.#backend = undefined;
        this.#activeTurns.clear();
        this.#phase = "stopped";
        retired = true;
      } catch {
        this.#unavailable();
        throw new OfficialAdmissionError("unavailable");
      }
    })();
    this.#stopping = stopping;
    void stopping.then(
      () => {
        this.#stopping = undefined;
        // A process generation retires only after actual exit proof, not socket
        // closure. Notify attached clients after releasing the stop barrier.
        if (retired) for (const client of [...this.#clients]) this.#notifyBackendStopped(client);
      },
      () => {
        this.#stopping = undefined;
      },
    );
    return stopping;
  }

  attach(output: CodexRuntimeOutput, onBackendStopped?: () => void): OfficialClientSession {
    return this.#attach("task", output, onBackendStopped);
  }

  attachManagement(output: CodexRuntimeOutput): OfficialClientSession {
    return this.#attach("management", output);
  }

  /**
   * Opens a raw native connection against the current backend generation for a
   * trusted local peer (such as the SSH listener) while preserving turn activity
   * and generation-stop tracking on this owner.
   */
  async connectProxy(): Promise<OfficialAppServerConnection> {
    if (!this.#backend || !["starting", "running"].includes(this.#phase)) {
      throw new OfficialAdmissionError("unavailable");
    }
    const backend = this.#backend;
    const generation = this.#generation;
    const connection = await backend.connect();
    if (
      backend !== this.#backend ||
      generation !== this.#generation ||
      !["starting", "running"].includes(this.#phase)
    ) {
      connection.close();
      throw new OfficialAdmissionError("unavailable");
    }
    const activeTurns = new Set<string>();
    const pending = new Map<RequestId, string | undefined>();
    const hasActiveWork = () => activeTurns.size > 0 || pending.size > 0;
    const closed = Promise.withResolvers<OfficialAppServerExit>();
    let detached = false;
    const input = observeProxyFrames(({ id, method, params }) => {
      if ((typeof id !== "number" && typeof id !== "string") || typeof method !== "string") return;
      pending.set(
        id,
        method === "turn/start" && object(params) && typeof params.threadId === "string"
          ? params.threadId
          : undefined,
      );
    });
    const output = observeProxyFrames(
      ({ id, method, params, result }) => {
        if (typeof method === "string") {
          if (!object(params) || typeof params.threadId !== "string") return;
          if (method === "turn/started") activeTurns.add(params.threadId);
          else if (method === "turn/completed" || method === "thread/closed") {
            activeTurns.delete(params.threadId);
            if (method === "turn/completed")
              this.#completeManagedTurn(params.threadId, params.turn);
            for (const [key, threadId] of pending) {
              if (threadId === params.threadId) pending.set(key, undefined);
            }
          }
        } else if (typeof id === "number" || typeof id === "string") {
          const threadId = pending.get(id);
          if (
            threadId &&
            object(result) &&
            object(result.turn) &&
            result.turn.status === "inProgress"
          )
            activeTurns.add(threadId);
          pending.delete(id);
        }
        if (detached) finishDrain();
      },
      {
        hasPending: () => pending.size > 0,
        expectsTurnResult: (id) => pending.get(id) !== undefined,
      },
    );
    const finish = (exit: OfficialAppServerExit, transportLost = false) => {
      if (!this.#proxies.delete(proxy)) return;
      if (transportLost && this.#phase === "running" && generation === this.#generation) {
        for (const threadId of [...activeTurns, ...pending.values()]) {
          if (threadId !== undefined) this.#unobservedProxyThreads.set(threadId, Symbol());
        }
        this.#checkUnobservedProxyThreads();
      }
      pending.clear();
      activeTurns.clear();
      input.destroy();
      closed.resolve(exit);
      if (!transportLost) connection.close();
    };
    const finishDrain = () => {
      if (hasActiveWork()) return;
      finish({ code: 0, signal: null });
    };
    const close = () => {
      if (detached) return;
      detached = true;
      input.destroy();
      closed.resolve({ code: 0, signal: null });
      output.resume();
      connection.stderr.resume();
      finishDrain();
    };
    const proxy: ProxyConnection = {
      hasActiveWork,
      retire: () => finish({ code: 1, signal: null }),
    };
    this.#proxies.add(proxy);
    input.pipe(connection.stdin);
    connection.stdout.pipe(output);
    void connection.closed.then((exit) => finish(exit, true));
    return {
      stdin: input,
      stdout: output,
      stderr: connection.stderr,
      closed: closed.promise,
      close,
    };
  }

  #attach(
    role: Client["role"],
    output: CodexRuntimeOutput,
    onBackendStopped?: () => void,
  ): OfficialClientSession {
    const client: Client = {
      id: randomUUID(),
      role,
      output,
      ...(onBackendStopped ? { onBackendStopped } : {}),
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
        candidate.role === "management" &&
        candidate.initializationResult &&
        candidate.runtime?.generation === this.#generation,
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
            !error ||
            !this.#clients.has(client) ||
            generation !== this.#generation ||
            this.#phase === "stopping"
          )
            return;
          if (!backend.isolatesConnectionFailures) {
            this.#unavailable();
          } else if (client.runtime === runtime) {
            this.#retire(client);
            this.#closeClientConnection(client);
            this.#notifyBackendStopped(client);
            this.#reconnectClient(client, backend, generation);
          }
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

  async #initializedConnection(client: Client): Promise<CodexRuntime> {
    const runtime = await this.#connection(client);
    if (
      this.#backend?.isolatesConnectionFailures &&
      client.initialization &&
      !client.initializationResult
    )
      await this.#initialize(client, client.initialization);
    return runtime;
  }

  #reconnectClient(client: Client, backend: OwnedOfficialBackend, generation: number): void {
    if (client.reconnecting || !client.initialization) return;
    const current = () =>
      this.#clients.has(client) &&
      backend === this.#backend &&
      generation === this.#generation &&
      this.#phase === "running";
    const reconnect = async () => {
      let retryDelay = 0;
      for (;;) {
        await delay(retryDelay, undefined, { ref: false });
        if (!current()) return;
        try {
          const runtime = await this.#initializedConnection(client);
          const restored = await this.#restoreSubscriptions(client, runtime);
          if (restored && client.runtime === runtime) return;
        } catch {
          // The proxy's listener can still be recovering. Retry the subscription, not writes.
        }
        retryDelay = Math.min(5000, Math.max(250, retryDelay * 2));
      }
    };
    const reconnecting = reconnect().finally(() => {
      if (client.reconnecting !== reconnecting) return;
      delete client.reconnecting;
      if (current() && !client.runtime) this.#reconnectClient(client, backend, generation);
    });
    client.reconnecting = reconnecting;
  }

  async #request(client: Client, method: string, params: JsonObject): Promise<JsonObject> {
    this.#checkMethod(method);
    const finish = this.gate.admit();
    let response: JsonObject | undefined;
    try {
      const runtime = await this.#initializedConnection(client);
      await this.#restoreBeforeRequest(client, runtime, method, params);
      const forwarded = method === "thread/fork" ? this.#forkParams(params) : params;
      response = await runtime.request(method, forwarded);
      if (
        client.runtime !== runtime ||
        runtime.generation !== this.#generation ||
        this.#phase !== "running"
      )
        throw new OfficialAdmissionError("unavailable");
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
      await client.runtime.send({ ...value, id: original });
      client.serverRequests.delete(String(value.id));
      return;
    }
    if (value.method === "initialized") return;
    const id = value.id;
    if (typeof id !== "string" && typeof id !== "number")
      throw new Error("Official methods require a request ID");
    const method = value.method;
    const params = object(value.params) ? value.params : {};
    this.#checkMethod(method);
    const finish = this.gate.admit();
    const pending = { method, params, finish };
    try {
      const runtime = await this.#initializedConnection(client);
      await this.#restoreBeforeRequest(client, runtime, method, params);
      if (method === "thread/fork" && object(value.params))
        value = { ...value, params: this.#forkParams(params) };
      if (client.pending.has(id)) throw new Error("Duplicate official request ID");
      client.pending.set(id, pending);
      await runtime.send(value);
    } catch (error) {
      if (client.pending.get(id) === pending) client.pending.delete(id);
      finish();
      throw error;
    }
  }

  #checkMethod(method: string): void {
    if (method === "initialize") {
      throw new Error("Initialization cannot use the ordinary request path");
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
    if (object(value.params) && typeof value.params.threadId === "string") {
      if (value.method === "turn/started")
        this.#activeTurns.set(value.params.threadId, turnId(value.params.turn));
      if (value.method === "turn/completed")
        this.#completeManagedTurn(value.params.threadId, value.params.turn);
      if (value.method === "thread/closed") {
        this.#activeTurns.delete(value.params.threadId);
        client.threads.delete(value.params.threadId);
        this.#threadModelSettings.delete(value.params.threadId);
      }
      if (value.method === "thread/settings/updated" && object(value.params.threadSettings))
        this.#rememberModelSettings(value.params.threadId, value.params.threadSettings);
    }
    if (value.method === "serverRequest/resolved" && object(value.params)) {
      const nativeId = value.params.requestId;
      const match = [...client.serverRequests].find(([, original]) => original === nativeId);
      if (match) {
        client.serverRequests.delete(match[0]);
        const projected = { ...value, params: { ...value.params, requestId: match[0] } };
        return client.output({
          ...event,
          value: projected,
          frame: Buffer.from(`${JSON.stringify(projected)}\n`),
        });
      }
      // A client can retire only a request identity it was shown.
      return;
    }
    if (typeof value.id === "string" || typeof value.id === "number") {
      if (typeof value.method === "string") {
        const id = `codexhost:server:${client.id}:${event.generation}:${randomUUID()}`;
        client.serverRequests.set(id, value.id);
        const projected = { ...value, id };
        return client.output({
          ...event,
          value: projected,
          frame: Buffer.from(`${JSON.stringify(projected)}\n`),
        });
      }
      const pending = client.pending.get(value.id);
      if (pending) {
        this.#remember(client, pending.method, pending.params, value);
        client.pending.delete(value.id);
        pending.finish();
      }
    }
    await client.output(event);
  }

  #remember(client: Client, method: string, params: JsonObject, response: JsonObject): void {
    if (response.error) return;
    if (object(response.result)) {
      if (
        method === "turn/start" &&
        typeof params.threadId === "string" &&
        object(response.result.turn) &&
        response.result.turn.status === "inProgress"
      )
        this.#activeTurns.set(params.threadId, turnId(response.result.turn));
    }
    if (
      ["thread/archive", "thread/unsubscribe", "thread/delete"].includes(method) &&
      typeof params.threadId === "string"
    ) {
      client.threads.delete(params.threadId);
      this.#threadModelSettings.delete(params.threadId);
    }
    if (
      !["thread/start", "thread/resume", "thread/fork"].includes(method) ||
      !object(response.result) ||
      !object(response.result.thread)
    )
      return;
    const id = response.result.thread.id;
    if (typeof id !== "string" || (method === "thread/fork" && id === params.threadId)) return;
    this.#rememberModelSettings(id, response.result);
    // Do not retain history/path: native resume can ignore threadId when those are supplied.
    const resume = Object.fromEntries(
      Object.entries(params).filter(([key]) => RESUME_FIELDS.has(key)),
    ) as JsonObject;
    client.threads.set(id, {
      params: { ...structuredClone(resume), threadId: id, excludeTurns: true },
      generation: this.#generation,
    });
  }

  #rememberModelSettings(threadId: string, settings: JsonObject): void {
    if (typeof settings.model !== "string" || !settings.model.trim()) return;
    const previous = this.#threadModelSettings.get(threadId);
    const sameModel = previous?.model === settings.model;
    const confirmed: JsonObject & { model: string } = { model: settings.model };
    for (const field of ["modelProvider", "serviceTier"] as const) {
      const fallback = field === "modelProvider" || sameModel ? previous?.[field] : undefined;
      const value = settings[field] === undefined ? fallback : settings[field];
      if (typeof value === "string" || (field === "serviceTier" && value === null))
        confirmed[field] = value;
    }
    const effort =
      settings.reasoningEffort !== undefined ? settings.reasoningEffort : settings.effort;
    if (typeof effort === "string") confirmed.effort = effort;
    else if (effort === undefined && sameModel && previous?.effort !== undefined)
      confirmed.effort = previous.effort;
    this.#threadModelSettings.set(threadId, confirmed);
  }

  #completeManagedTurn(threadId: string, turn: unknown): void {
    const activeId = this.#activeTurns.get(threadId);
    const completedId = turnId(turn);
    if (activeId === undefined || completedId === undefined || activeId === completedId)
      this.#activeTurns.delete(threadId);
  }

  #canInheritForkModel(params: JsonObject): boolean {
    return (
      typeof params.threadId === "string" &&
      params.path == null &&
      params.history == null &&
      params.model == null &&
      params.modelProvider == null &&
      (params.config == null ||
        (object(params.config) &&
          params.config.model == null &&
          params.config.model_provider == null))
    );
  }

  #forkParams(params: JsonObject): JsonObject {
    // Desktop can omit its source Model from Fork, making native Codex use the
    // global default. Only fill omitted settings from this generation's native
    // confirmations; explicit selections and path/history forks remain native.
    if (!this.#canInheritForkModel(params) || typeof params.threadId !== "string") return params;
    const config = object(params.config) ? params.config : {};
    const source = this.#threadModelSettings.get(params.threadId);
    if (!source) return params;
    const inherited: JsonObject = { ...params, model: source.model };
    if (source.modelProvider !== undefined) inherited.modelProvider = source.modelProvider;
    if (
      params.serviceTier === undefined &&
      !Object.hasOwn(config, "service_tier") &&
      source.serviceTier !== undefined
    )
      inherited.serviceTier = source.serviceTier;
    if (source.effort !== undefined && !Object.hasOwn(config, "model_reasoning_effort"))
      inherited.config = { ...config, model_reasoning_effort: source.effort };
    return inherited;
  }

  async #restoreBeforeRequest(
    client: Client,
    runtime: CodexRuntime,
    method: string,
    params: JsonObject,
  ): Promise<void> {
    try {
      await this.#restore(client, runtime, method, params);
    } catch (error) {
      if (
        method !== "thread/fork" ||
        !this.#canInheritForkModel(params) ||
        !(error instanceof OfficialThreadRestorationError)
      )
        throw error;
    }
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
        (method === "thread/fork" && this.#canInheritForkModel(params)) ||
        method === "thread/rollback" ||
        method === "thread/revert" ||
        method.startsWith("thread/backgroundTerminals/")
      )
    )
      return;
    await this.#restoreThread(client, runtime, params.threadId);
  }

  async #restoreSubscriptions(client: Client, runtime: CodexRuntime): Promise<boolean> {
    let restored = true;
    for (const threadId of [...client.threads.keys()]) {
      const subscription = client.threads.get(threadId);
      try {
        await this.#restoreThread(client, runtime, threadId);
      } catch (error) {
        if (client.runtime !== runtime || runtime.generation !== this.#generation) throw error;
        if (error instanceof OfficialThreadRestorationError && error.missing) {
          if (client.threads.get(threadId) === subscription) client.threads.delete(threadId);
        } else {
          restored = false;
        }
      }
    }
    return restored;
  }

  async #restoreThread(client: Client, runtime: CodexRuntime, threadId: string): Promise<void> {
    const subscription = client.threads.get(threadId);
    if (!subscription || subscription.generation === runtime.generation) return;
    if (subscription.restoring) return subscription.restoring;
    const restoring = (async () => {
      const resume = subscription.params;
      const response = await runtime.request("thread/resume", resume);
      if (
        response.error ||
        !object(response.result) ||
        !object(response.result.thread) ||
        response.result.thread.id !== threadId
      )
        throw new OfficialThreadRestorationError(nativeThreadMissing(response.error));
      if (client.runtime !== runtime || runtime.generation !== this.#generation)
        throw new OfficialAdmissionError("unavailable");
      this.#rememberModelSettings(threadId, response.result);
      subscription.generation = runtime.generation;
    })();
    subscription.restoring = restoring;
    try {
      await restoring;
    } finally {
      if (subscription.restoring === restoring) delete subscription.restoring;
    }
  }

  #retire(client: Client): void {
    client.runtime?.retire();
    for (const subscription of client.threads.values()) {
      delete subscription.generation;
      delete subscription.restoring;
    }
    for (const [id, pending] of client.pending) {
      pending.finish();
      const value: JsonObject = {
        id,
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
    client.serverRequests.clear();
  }

  #closeClientConnection(client: Client): void {
    client.runtime?.close();
    delete client.runtime;
    delete client.initializationResult;
    delete client.initializing;
  }

  #notifyBackendStopped(client: Client): void {
    try {
      client.onBackendStopped?.();
    } catch {
      /* observer isolation */
    }
  }

  #closeProxies(): void {
    for (const proxy of this.#proxies) proxy.retire();
    this.#unobservedProxyThreads.clear();
  }

  #checkUnobservedProxyThreads(): void {
    if (this.#checkingProxyThreads || this.#unobservedProxyThreads.size === 0) return;
    this.#checkingProxyThreads = true;
    const generation = this.#generation;
    const check = async () => {
      while (generation === this.#generation && this.#unobservedProxyThreads.size > 0) {
        await delay(500, undefined, { ref: false });
        if (generation !== this.#generation || this.#phase !== "running") return;
        for (const [threadId, observation] of [...this.#unobservedProxyThreads]) {
          const managedTurn = this.#activeTurns.get(threadId);
          const reply = await this.controlRequest("thread/read", {
            threadId,
            includeTurns: false,
          }).catch(() => undefined);
          const thread = object(reply?.result) ? reply.result.thread : undefined;
          const status = object(thread) && object(thread.status) ? thread.status.type : undefined;
          // An unavailable status is not evidence that the native Turn finished.
          if (
            (status === "idle" ||
              status === "notLoaded" ||
              status === "systemError" ||
              nativeThreadMissing(reply?.error)) &&
            this.#unobservedProxyThreads.get(threadId) === observation
          ) {
            this.#unobservedProxyThreads.delete(threadId);
            if (this.#activeTurns.get(threadId) === managedTurn) this.#activeTurns.delete(threadId);
          }
        }
      }
    };
    void check().finally(() => {
      this.#checkingProxyThreads = false;
      if (this.#phase === "running") this.#checkUnobservedProxyThreads();
    });
  }

  #unavailable(): void {
    this.#phase = "unavailable";
    for (const client of this.#clients) {
      this.#retire(client);
      client.runtime?.close();
    }
    this.#closeProxies();
    this.gate.unavailable();
  }
}
