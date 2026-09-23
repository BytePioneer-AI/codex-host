import { isAbsolute, resolve } from "node:path";
import { stat } from "node:fs/promises";
import type {
  HarnessAdapter,
  HarnessInspection,
  HarnessResult,
  HarnessSession,
  InspectHarnessInput,
  OpenSessionInput,
} from "@codexhost/harness-adapter";
import { harnessInspectionSchema, nativeSessionRefSchema } from "@codexhost/shared-contracts";
import {
  capabilities,
  checked,
  decodeModel,
  encodeModel,
  errorOf,
  failure,
  MIMO_ID,
  MimoError,
} from "./protocol.js";
import { projectHistory, readMessages } from "./history.js";
import { connectMimo, MimoCleanupError, type Connect, type MimoConnection } from "./server.js";
import { MimoSession } from "./session.js";
import {
  enableFullAccess,
  fullAccess,
  observedPermission,
  permissionModes,
  permissionRules,
} from "./permissions.js";
import { validateModel } from "./models.js";

export interface MimoAdapterOptions {
  environment?: NodeJS.ProcessEnv;
  command?: string;
}
export class MimoAdapter implements HarnessAdapter {
  readonly harnessId = MIMO_ID;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #resources = new Set<{ close(): Promise<void> }>();
  readonly #sessions = new Set<MimoSession>();
  readonly #pending = new Set<Promise<MimoConnection>>();
  readonly #opening = new Set<Promise<HarnessResult<HarnessSession>>>();
  readonly #reserved = new Set<string>();
  #closed = false;
  #closing: Promise<void> | undefined;
  constructor(
    readonly options: MimoAdapterOptions = {},
    readonly connect: Connect = connectMimo,
  ) {
    this.#environment = { ...(options.environment ?? process.env) };
  }
  #track(resource: { close(): Promise<void> }, onClosed?: () => void): () => Promise<void> {
    let closing: Promise<void> | undefined;
    const managed = {
      close: (): Promise<void> =>
        (closing ??= Promise.resolve()
          .then(() => resource.close())
          .then(() => {
            this.#resources.delete(managed);
            onClosed?.();
          })
          .catch(() => {
            closing = undefined;
            throw new MimoError(
              "unavailable",
              "MiMo service cleanup failed; an owned process may still be running",
            );
          })),
    };
    this.#resources.add(managed);
    return managed.close;
  }
  async #connection(
    cwd: string,
    environment?: NodeJS.ProcessEnv,
    onClosed?: () => void,
  ): Promise<MimoConnection> {
    if (this.#closed) throw new MimoError("invalidState", "MiMo adapter is closed");
    if (!isAbsolute(cwd) || !(await stat(cwd).catch(() => null))?.isDirectory())
      throw new MimoError("invalidRequest", "MiMo cwd must be an existing absolute directory");
    if (this.#closed) throw new MimoError("invalidState", "MiMo adapter is closed");
    const merged = { ...this.#environment, ...environment };
    for (const key of Object.keys(merged))
      if (merged[key] === undefined) Reflect.deleteProperty(merged, key);
    const pending = this.connect({
      cwd,
      environment: merged,
      ...(this.options.command ? { command: this.options.command } : {}),
    });
    this.#pending.add(pending);
    try {
      const resource = await pending;
      const connection: MimoConnection = {
        client: resource.client,
        exited: resource.exited,
        close: this.#track(resource, onClosed),
      };
      if (this.#closed) {
        await connection.close();
        throw new MimoError("invalidState", "MiMo adapter closed while starting service");
      }
      return connection;
    } catch (error) {
      if (error instanceof MimoCleanupError) this.#track(error, onClosed);
      throw error;
    } finally {
      this.#pending.delete(pending);
    }
  }
  async inspect(input: InspectHarnessInput = {}): Promise<HarnessInspection> {
    let connection: MimoConnection | undefined;
    let inspection: HarnessInspection;
    try {
      connection = await this.#connection(input.cwd ?? process.cwd());
      const providers = checked(await connection.client.provider.list());
      // MiMo advertises built-in connected providers even with an empty auth
      // store. Loopback server authentication does not authenticate a Model.
      const configured = providers.all.some(
        (provider) =>
          providers.connected.includes(provider.id) &&
          (providers.authenticated.includes(provider.id) ||
            (typeof provider.key === "string" && provider.key.length > 0) ||
            (typeof provider.options.apiKey === "string" && provider.options.apiKey.length > 0)),
      );
      if (!configured)
        throw new MimoError(
          "authenticationRequired",
          "MiMo has no configured Provider authentication; sign in with the native CLI or configure a Provider key",
        );
      const models = providers.all
        .filter((provider) => providers.connected.includes(provider.id))
        .flatMap((provider) =>
          Object.values(provider.models).map((model) => ({
            ref: encodeModel({ providerID: provider.id, modelID: model.id }),
            label: model.name || model.id,
          })),
        );
      if (!models.length)
        throw new MimoError(
          "authenticationRequired",
          "MiMo has no connected models; configure authentication in the native CLI",
        );
      inspection = harnessInspectionSchema.parse({
        status: "ready",
        capabilities,
        permissionModes,
        catalog: { models, thinkingOptions: [] },
      });
    } catch (error) {
      const normalized = errorOf(error);
      inspection = {
        status: normalized.code === "notInstalled" ? "notInstalled" : "unavailable",
        error: normalized,
      };
    }
    if (connection) {
      try {
        await connection.close();
      } catch (error) {
        return { status: "unavailable", error: errorOf(error) };
      }
    }
    return inspection;
  }
  open(input: OpenSessionInput): Promise<HarnessResult<HarnessSession>> {
    const pending = this.#open(input);
    this.#opening.add(pending);
    void pending.finally(() => this.#opening.delete(pending)).catch(() => {});
    return pending;
  }
  async #open(input: OpenSessionInput): Promise<HarnessResult<HarnessSession>> {
    if (this.#closed) return failure("invalidState", "MiMo adapter is closed");
    if (input.kind !== "create" && input.kind !== "resume")
      return failure("unsupported", "MiMo Fork and Rollback are not verified");
    if (input.thinkingOptionId)
      return failure("unsupported", "MiMo Thinking selection is not supported");
    const unattended =
      input.kind === "create" && input.executionPolicy === "unattended-full-access";
    if (unattended && input.permissionModeId && input.permissionModeId !== fullAccess)
      return failure(
        "invalidRequest",
        "MiMo unattended execution conflicts with the requested Permission Mode",
      );
    const permissionModeId = unattended ? fullAccess : input.permissionModeId;
    let connection: MimoConnection | undefined;
    let session: MimoSession | undefined;
    let reserved: string | undefined;
    try {
      if (input.model) decodeModel(input.model);
      const permission = permissionModeId ? permissionRules(permissionModeId) : undefined;
      if (input.kind === "resume") {
        const ref = nativeSessionRefSchema.safeParse(input.nativeRef);
        if (
          !ref.success ||
          ref.data.harnessId !== MIMO_ID ||
          !ref.data.nativeSessionId.startsWith("ses")
        )
          throw new MimoError(
            "invalidRequest",
            "MiMo resume requires a valid MiMo Native Session Ref",
          );
        if (this.#reserved.has(ref.data.nativeSessionId))
          throw new MimoError("sessionBusy", "MiMo native session is already open in this adapter");
        reserved = ref.data.nativeSessionId;
        this.#reserved.add(reserved);
      }
      connection = await this.#connection(input.cwd, input.environment, () => {
        if (reserved) this.#reserved.delete(reserved);
      });
      if (input.model) await validateModel(connection.client, input.model);
      if (input.kind === "create" && permissionModeId === fullAccess)
        await enableFullAccess(connection.client);
      const native =
        input.kind === "create"
          ? checked(await connection.client.session.create(permission ? { permission } : {}))
          : checked(
              await connection.client.session.get({ sessionID: input.nativeRef.nativeSessionId }),
            );
      if (!reserved) {
        if (this.#reserved.has(native.id))
          throw new MimoError("sessionBusy", "MiMo native session is already open in this adapter");
        reserved = native.id;
        this.#reserved.add(reserved);
      }
      if (permissionModeId && observedPermission(native.permission) !== permissionModeId)
        throw new MimoError(
          "invalidRequest",
          "MiMo native permission differs from the requested mode",
        );
      if (
        (input.kind === "resume" && native.id !== input.nativeRef.nativeSessionId) ||
        resolve(native.directory) !== resolve(input.cwd)
      )
        throw new MimoError(
          "invalidRequest",
          "MiMo session identity or working directory does not match",
        );
      if (native.revert || native.parentID || native.contextFrom)
        throw new MimoError("unsupported", "MiMo derived or reverted sessions are not verified");
      const status = checked(await connection.client.session.status());
      if (status[native.id] && status[native.id]?.type !== "idle")
        throw new MimoError("sessionBusy", "MiMo native session is busy");
      if (input.kind === "resume" && observedPermission(native.permission) === fullAccess)
        await enableFullAccess(connection.client);
      const messages = await readMessages(connection.client, native.id);
      const snapshot = projectHistory(native, messages);
      const lastUser = messages.findLast(
        ({ info }) => info.role === "user" && (!info.agentID || info.agentID === "main"),
      )?.info;
      const selectedModel =
        input.model ?? (lastUser?.role === "user" ? encodeModel(lastUser.model) : undefined);
      session = new MimoSession(connection, native, snapshot.state ?? {}, selectedModel, () => {
        this.#reserved.delete(native.id);
        if (session) this.#sessions.delete(session);
      });
      this.#sessions.add(session);
      await session.startEvents();
      if (this.#closed)
        throw new MimoError("invalidState", "MiMo adapter closed while opening session");
      return { ok: true, value: session };
    } catch (error) {
      try {
        if (session) await session.close();
        else if (connection) await connection.close();
      } catch (cleanupError) {
        return { ok: false, error: errorOf(cleanupError) };
      }
      if (reserved && !(error instanceof MimoCleanupError)) this.#reserved.delete(reserved);
      return { ok: false, error: errorOf(error) };
    }
  }
  close(): Promise<void> {
    this.#closed = true;
    return (this.#closing ??= (async () => {
      await Promise.allSettled(this.#pending);
      await Promise.allSettled(this.#opening);
      // Session.close owns its resource; avoid a second attempt in this same
      // close pass, which could conceal a failed Session cleanup.
      const sessionConnections = new Set(
        [...this.#sessions].map((session) => session.connection.close),
      );
      const orphanResources = [...this.#resources].filter(
        (resource) => !sessionConnections.has(resource.close),
      );
      const results = await Promise.allSettled(
        [...this.#sessions].map((session) => session.close()),
      );
      const connections = await Promise.allSettled(
        orphanResources.map((connection) => connection.close()),
      );
      const failed = [...results, ...connections].find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    })().catch((error) => {
      this.#closing = undefined;
      throw error;
    }));
  }
}
