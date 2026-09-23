import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import type {
  HarnessAdapter,
  HarnessInspection,
  HarnessResult,
  HarnessSession,
  InspectHarnessInput,
  OpenSessionInput,
} from "@codexhost/harness-adapter";
import { harnessPermissionModeIdSchema, nativeSessionRefSchema } from "@codexhost/shared-contracts";
import {
  HARNESS_ID,
  KimiError,
  failure,
  modelsSchema,
  parse,
  permissionSchema,
  sessionPath,
  sessionSchema,
  snapshotSchema,
  statusSchema,
  success,
  type KimiTransport,
  type NativeModel,
  type TransportFactory,
} from "./protocol.js";
import { capabilities, catalog, modelRef, sessionState } from "./projection.js";
import { KimiSession } from "./session.js";
import { startKimiTransport } from "./transport.js";

export interface KimiAdapterOptions {
  environment?: NodeJS.ProcessEnv;
  command?: string;
  createTransport?: TransportFactory;
}
function samePath(left: string, right: string): boolean {
  const normalize = (value: string) =>
    process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(left) === normalize(right);
}
export class KimiCodeAdapter implements HarnessAdapter {
  readonly harnessId = HARNESS_ID;
  #environment: NodeJS.ProcessEnv;
  #factory: TransportFactory;
  #sessions = new Set<KimiSession>();
  #transports = new Set<KimiTransport>();
  #opening = new Set<Promise<unknown>>();
  #locked = new Set<string>();
  #closed = false;
  #closePromise: Promise<void> | undefined;
  constructor(private options: KimiAdapterOptions = {}) {
    this.#environment = { ...(options.environment ?? process.env) };
    this.#factory = options.createTransport ?? startKimiTransport;
  }
  #track<T>(operation: Promise<T>): Promise<T> {
    this.#opening.add(operation);
    void operation.finally(() => this.#opening.delete(operation)).catch(() => {});
    return operation;
  }
  async #start(
    cwd: string,
    environment: NodeJS.ProcessEnv,
    onCreated: (transport: KimiTransport) => void,
  ): Promise<KimiTransport> {
    if (this.#closed) throw new KimiError("invalidState", "Kimi Code adapter is closed");
    const transport = await this.#factory({
      cwd,
      environment,
      onCreated: (transport) => {
        this.#transports.add(transport);
        onCreated(transport);
      },
      ...(this.options.command ? { command: this.options.command } : {}),
    });
    this.#transports.add(transport);
    onCreated(transport);
    if (this.#closed) {
      await transport.close();
      throw new KimiError("invalidState", "Kimi Code adapter closed during startup");
    }
    return transport;
  }
  inspect(input: InspectHarnessInput = {}): Promise<HarnessInspection> {
    return this.#track(this.#inspect(input));
  }
  async #inspect(input: InspectHarnessInput): Promise<HarnessInspection> {
    let transport: KimiTransport | undefined;
    let result: HarnessInspection;
    try {
      transport = await this.#start(input.cwd ?? process.cwd(), this.#environment, (owned) => {
        transport = owned;
      });
      const [modelResult, configResult, authResult] = await Promise.all([
        transport.request("/api/v1/models"),
        transport.request("/api/v1/config"),
        transport.request("/api/v1/auth"),
      ]);
      const models = parse(modelsSchema, modelResult).items;
      const config = parse(
        z.object({
          default_model: z.string().optional(),
          default_permission_mode: permissionSchema.optional(),
          yolo: z.boolean().optional(),
        }),
        configResult,
      );
      const auth = parse(z.object({ models_ready: z.boolean() }), authResult);
      if (!auth.models_ready)
        throw new KimiError(
          "authenticationRequired",
          "Configure a usable model in Kimi Code before starting a turn",
        );
      const defaultMode = config.default_permission_mode ?? (config.yolo ? "yolo" : "manual");
      result = {
        status: "ready",
        capabilities,
        catalog: catalog(models, config.default_model),
        permissionModes: {
          modes: [
            { id: harnessPermissionModeIdSchema.parse("manual"), label: "Manual approval" },
            { id: harnessPermissionModeIdSchema.parse("auto"), label: "Native automatic approval" },
            { id: harnessPermissionModeIdSchema.parse("yolo"), label: "YOLO", dangerous: true },
          ],
          defaultModeId: harnessPermissionModeIdSchema.parse(defaultMode),
        },
      };
    } catch (error) {
      const normalized = failure(error).error;
      result = {
        status: normalized.code === "notInstalled" ? "notInstalled" : "unavailable",
        error: normalized,
      };
    }
    if (transport) {
      try {
        await transport.close();
        this.#transports.delete(transport);
      } catch (error) {
        return { status: "unavailable", error: failure(error).error };
      }
    }
    return result;
  }
  open(input: OpenSessionInput): Promise<HarnessResult<HarnessSession>> {
    return this.#track(this.#open(input));
  }
  async #open(input: OpenSessionInput): Promise<HarnessResult<HarnessSession>> {
    let transport: KimiTransport | undefined, lock: string | undefined;
    try {
      if (this.#closed) throw new KimiError("invalidState", "Kimi Code adapter is closed");
      if (input.kind !== "create" && input.kind !== "resume")
        throw new KimiError(
          "unsupported",
          "Kimi Code checkpoint fork and rollback are not supported",
        );
      if (
        !path.isAbsolute(input.cwd) ||
        !(await stat(input.cwd).catch(() => undefined))?.isDirectory()
      )
        throw new KimiError(
          "invalidRequest",
          "Kimi Code requires an existing absolute working directory",
        );
      const environment = { ...this.#environment, ...input.environment };
      const nativeHome = path.resolve(
        input.cwd,
        environment.KIMI_CODE_HOME || path.join(homedir(), ".kimi-code"),
      );
      if (input.kind === "resume") {
        const ref = parse(nativeSessionRefSchema, input.nativeRef);
        if (ref.harnessId !== HARNESS_ID)
          throw new KimiError("invalidRequest", "Native session belongs to another Harness");
        const locator = parse(z.object({ nativeHome: z.string() }), ref.locator);
        if (!samePath(locator.nativeHome, nativeHome))
          throw new KimiError(
            "invalidRequest",
            "Kimi Code resume must use the original native data directory",
          );
        const candidateLock = `${process.platform === "win32" ? nativeHome.toLowerCase() : nativeHome}:${ref.nativeSessionId}`;
        if (this.#locked.has(candidateLock))
          throw new KimiError(
            "sessionBusy",
            "Kimi Code session is already open in this adapter",
            true,
          );
        lock = candidateLock;
        this.#locked.add(lock);
      }
      transport = await this.#start(input.cwd, environment, (owned) => {
        transport = owned;
      });
      const models = parse(modelsSchema, await transport.request("/api/v1/models")).items;
      let defaultModel: string | undefined;
      if (input.kind === "create" && !input.model) {
        const config = parse(
          z.object({ default_model: z.string().optional() }),
          await transport.request("/api/v1/config"),
        );
        defaultModel = config.default_model;
        if (!defaultModel || !models.some((model) => model.model === defaultModel))
          throw new KimiError(
            "invalidRequest",
            "Kimi Code has no usable default model; configure the native default_model or explicitly select a model before delegation",
          );
      }
      const native = parse(
        sessionSchema,
        await transport.request(
          input.kind === "create"
            ? "/api/v1/sessions"
            : sessionPath(input.nativeRef.nativeSessionId),
          input.kind === "create" ? "POST" : "GET",
          input.kind === "create" ? { metadata: { cwd: input.cwd } } : undefined,
        ),
      );
      if (input.kind === "resume" && native.id !== input.nativeRef.nativeSessionId)
        throw new KimiError("protocolError", "Kimi Code resumed a different session");
      if (!samePath(native.metadata.cwd, input.cwd))
        throw new KimiError(
          "invalidRequest",
          "Kimi Code session working directory does not match the requested directory",
        );
      if (native.busy || native.main_turn_active)
        throw new KimiError("sessionBusy", "Kimi Code session has native work in progress", true);
      if (!lock) {
        lock = `${process.platform === "win32" ? nativeHome.toLowerCase() : nativeHome}:${native.id}`;
        this.#locked.add(lock);
      }
      const ref = nativeSessionRefSchema.parse({
        harnessId: HARNESS_ID,
        nativeSessionId: native.id,
        formatVersion: 1,
        locator: { nativeHome },
      });
      if (input.kind === "create")
        await this.#configureCreated(transport, native.id, input, models, defaultModel);
      const snapshot = parse(
        snapshotSchema,
        await transport.request(`${sessionPath(native.id)}/snapshot`),
      );
      const status = parse(
        statusSchema,
        await transport.request(`${sessionPath(native.id)}/status`),
      );
      if (status.swarm_mode || status.tower_mode || snapshot.session.agent_config.goal_objective)
        throw new KimiError(
          "unsupported",
          "Kimi Code swarm, tower, and autonomous goal sessions are not supported",
        );
      if (snapshot.session.id !== native.id || snapshot.session.busy)
        throw new KimiError("sessionBusy", "Kimi Code session changed while opening", true);
      const ownedTransport = transport,
        ownedLock = lock;
      const session = new KimiSession(
        transport,
        ref,
        models,
        snapshot,
        sessionState(ref, status, models),
        () => {
          this.#sessions.delete(session);
          this.#transports.delete(ownedTransport);
          this.#locked.delete(ownedLock);
        },
      );
      await session.initialize();
      if (this.#closed) {
        await session.close();
        throw new KimiError("invalidState", "Kimi Code adapter closed during open");
      }
      this.#sessions.add(session);
      return success(session);
    } catch (error) {
      if (transport) {
        try {
          await transport.close();
          this.#transports.delete(transport);
        } catch (cleanupError) {
          return failure(cleanupError);
        }
      }
      if (lock) this.#locked.delete(lock);
      return failure(error);
    }
  }
  async #configureCreated(
    transport: KimiTransport,
    id: string,
    input: Extract<OpenSessionInput, { kind: "create" }>,
    models: NativeModel[],
    defaultModel?: string,
  ): Promise<void> {
    const patch: Record<string, string> = {};
    // Kimi 2.0.2 REST create leaves the model empty even with a configured native default.
    if (defaultModel) patch.model = defaultModel;
    if (input.model) {
      const model = models.find((entry) => modelRef(entry.model).id === input.model?.id);
      if (!model) throw new KimiError("invalidRequest", "Unknown Kimi Code model reference");
      patch.model = model.model;
    }
    if (input.permissionModeId)
      patch.permission_mode = parse(permissionSchema, input.permissionModeId);
    if (input.executionPolicy === "unattended-full-access") {
      if (patch.permission_mode && patch.permission_mode !== "yolo")
        throw new KimiError(
          "invalidRequest",
          "Unattended full access conflicts with the selected Kimi Code permission mode",
        );
      patch.permission_mode = "yolo";
    }
    if (input.thinkingOptionId) {
      const status = parse(statusSchema, await transport.request(`${sessionPath(id)}/status`));
      const model = models.find((entry) => entry.model === (patch.model ?? status.model));
      if (!model?.support_efforts?.includes(input.thinkingOptionId))
        throw new KimiError(
          "invalidRequest",
          "Thinking option is not supported by the selected Kimi Code model",
        );
      patch.thinking = input.thinkingOptionId;
    }
    if (!Object.keys(patch).length) return;
    await transport.request(`${sessionPath(id)}/profile`, "POST", { agent_config: patch });
    const confirmed = parse(statusSchema, await transport.request(`${sessionPath(id)}/status`));
    if (
      (patch.model && confirmed.model !== patch.model) ||
      (patch.thinking && confirmed.thinking_level !== patch.thinking) ||
      (patch.permission_mode && confirmed.permission !== patch.permission_mode)
    )
      throw new KimiError(
        "nativeFailure",
        "Kimi Code did not apply the requested initial configuration",
      );
  }
  close(): Promise<void> {
    if (!this.#closePromise) {
      this.#closePromise = this.#close().catch((error: unknown) => {
        this.#closePromise = undefined;
        throw error;
      });
    }
    return this.#closePromise;
  }
  async #close(): Promise<void> {
    this.#closed = true;
    await Promise.allSettled([...this.#opening]);
    const results = await Promise.allSettled([...this.#sessions].map((session) => session.close()));
    const transports = await Promise.allSettled(
      [...this.#transports].map(async (transport) => {
        await transport.close();
        this.#transports.delete(transport);
      }),
    );
    const failed = [...results, ...transports].find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    this.#locked.clear();
  }
}
