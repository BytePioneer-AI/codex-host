import { randomUUID } from "node:crypto";
import type { Writable } from "node:stream";

import type { JsonObject } from "@codexhost/protocol-core";

import type {
  OfficialAppServerConnection,
  OfficialAppServerExit,
} from "../official-app-server-connection.js";
import { CodexRuntime, type CodexRuntimeOutput } from "./codex-runtime.js";
import { OfficialAdmissionError, type OfficialWorkGate } from "./official-work-gate.js";

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
}
interface Client {
  id: string;
  role: "task" | "management";
  output: CodexRuntimeOutput;
  onBackendStopped?: () => void;
  runtime?: CodexRuntime;
  connecting?: Promise<CodexRuntime>;
  initializing?: Promise<JsonObject>;
  initialization?: JsonObject;
  initializationResult?: JsonObject;
  pending: Map<string, Pending>;
  serverRequests: Map<string, string | number>;
  threads: Map<string, { params: JsonObject; generation: number; restoring?: Promise<void> }>;
}
export interface OfficialRuntimeOwnerOptions {
  createBackend(): OwnedOfficialBackend;
  diagnosticOutput: Writable;
  gate: OfficialWorkGate;
}
const object = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const requestKey = (id: string | number): string => JSON.stringify([typeof id, id]);
class OfficialThreadRestorationError extends Error {}
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
  readonly #activeTurns = new Set<string>();
  readonly #threadModelSettings = new Map<string, JsonObject & { model: string }>();
  #backend: OwnedOfficialBackend | undefined;
  #generation = 0;
  #phase: "stopped" | "starting" | "running" | "stopping" | "unavailable" = "stopped";
  #starting: Promise<void> | undefined;
  #stopping: Promise<void> | undefined;

  constructor(input: OfficialRuntimeOwnerOptions) {
    this.#factory = input.createBackend;
    this.#diagnosticOutput = input.diagnosticOutput;
    this.gate = input.gate;
  }
  get generation(): number {
    return this.#generation;
  }

  get hasActiveWork(): boolean {
    return this.gate.busy || this.#activeTurns.size > 0;
  }

  get running(): boolean {
    return this.#phase === "running";
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
        if (retired)
          for (const client of [...this.#clients]) {
            try {
              client.onBackendStopped?.();
            } catch {
              /* observer isolation */
            }
          }
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
    this.#checkMethod(method);
    const finish = this.gate.admit();
    let response: JsonObject | undefined;
    try {
      const runtime = await this.#connection(client);
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
    if (typeof value.id !== "string" && typeof value.id !== "number")
      throw new Error("Official methods require a request ID");
    const method = value.method;
    const params = object(value.params) ? value.params : {};
    this.#checkMethod(method);
    const finish = this.gate.admit();
    let pendingKey: string | undefined;
    try {
      const runtime = await this.#connection(client);
      await this.#restoreBeforeRequest(client, runtime, method, params);
      if (method === "thread/fork" && object(value.params))
        value = { ...value, params: this.#forkParams(params) };
      if (typeof value.id === "string" || typeof value.id === "number") {
        const key = requestKey(value.id);
        if (client.pending.has(key)) throw new Error("Duplicate official request ID");
        pendingKey = key;
        client.pending.set(pendingKey, {
          id: value.id,
          method,
          params,
          finish,
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
      if (value.method === "turn/started") this.#activeTurns.add(value.params.threadId);
      if (value.method === "turn/completed" || value.method === "thread/closed")
        this.#activeTurns.delete(value.params.threadId);
      if (value.method === "thread/closed") {
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
      const pending = client.pending.get(requestKey(value.id));
      if (pending) {
        this.#remember(client, pending.method, pending.params, value);
        client.pending.delete(requestKey(value.id));
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
        this.#activeTurns.add(params.threadId);
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
    const threadId = params.threadId;
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
        response.result.thread.id !== params.threadId
      )
        throw new OfficialThreadRestorationError("Official Thread restoration failed");
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
