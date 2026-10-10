import fs from "node:fs";
import { isDeepStrictEqual } from "node:util";
import type { OpenCodeClient, SessionInfo } from "@opencode/client";
import type {
  HarnessAdapter,
  HarnessInspection,
  HarnessResult,
  HarnessSession,
  HarnessSessionImportCapability,
  HarnessSessionImportSource,
  OpenSessionInput,
  HarnessExecutionPolicy,
  HostThreadSnapshot,
} from "@codexhost/harness-adapter";
import {
  harnessPermissionModeIdSchema,
  type HarnessModelCatalog,
} from "@codexhost/shared-contracts";
import type { OpenCodeAdapterOptions } from "../opencode-adapter.js";
import { openCodeCommandCatalog } from "../opencode-adapter.js";
import { decodeOpenCodeModelRef, decodeOpenCodeVariant } from "../model-catalog.js";
import { OPENCODE_PERMISSION_MODE_CATALOG } from "../permission-modes.js";
import { readCatalog } from "./catalog.js";
import { V2Connection } from "./connection.js";
import { readHistory } from "./history.js";
import { listV2SessionCandidates, resolveV2SessionCandidate } from "./session-import.js";
import {
  errorResult,
  failure,
  harnessId,
  sameDirectory,
  v2Locator,
  v2Permissions,
} from "./state.js";
import { V2Session, v2Capabilities } from "./session.js";

export class V2Adapter implements HarnessAdapter {
  readonly harnessId = harnessId;
  readonly commandCatalog = openCodeCommandCatalog;
  readonly #connections = new Set<V2Connection>();
  readonly #sessions = new Set<V2Session>();
  #closed = false;
  constructor(readonly options: OpenCodeAdapterOptions) {}

  async #catalog(client: OpenCodeClient, cwd: string) {
    return readCatalog(client, cwd, this.options.startupTimeoutMs ?? 20_000);
  }

  async inspect(input: { cwd?: string; refresh?: boolean } = {}): Promise<HarnessInspection> {
    const cwd = input.cwd ?? process.cwd();
    const connection = new V2Connection(this.options, cwd);
    this.#connections.add(connection);
    try {
      if (this.#closed) throw new Error("OpenCode Adapter is closed");
      const client = await connection.client();
      const catalog = await this.#catalog(client, cwd);
      return {
        status: "ready",
        catalog,
        capabilities: v2Capabilities(catalog),
        permissionModes: OPENCODE_PERMISSION_MODE_CATALOG,
      };
    } catch (error) {
      return {
        status: "error",
        error: {
          ...errorResult(error).error,
          ...(connection.stderrTail ? { stderrTail: connection.stderrTail } : {}),
        },
      };
    } finally {
      await connection.close();
      this.#connections.delete(connection);
    }
  }

  readonly sessionImport = {
    listCandidates: () => this.#discover((client) => listV2SessionCandidates(client)),
    resolveCandidate: async (
      nativeSessionId: string,
    ): Promise<HarnessResult<HarnessSessionImportSource>> => {
      const source = await this.#discover((client) =>
        resolveV2SessionCandidate(client, nativeSessionId),
      );
      if (!source.ok) return source;
      return source.value
        ? { ok: true, value: source.value }
        : {
            ok: false,
            error: failure("OpenCode Session is no longer importable", "sessionNotFound"),
          };
    },
  } satisfies HarnessSessionImportCapability;

  /** Read-only discovery on a private server: no Session is created, loaded or prompted. */
  async #discover<T>(read: (client: OpenCodeClient) => Promise<T>): Promise<HarnessResult<T>> {
    if (this.#closed)
      return { ok: false, error: failure("OpenCode Adapter is closed", "invalidState") };
    const connection = new V2Connection(this.options, process.cwd());
    this.#connections.add(connection);
    try {
      const value = await read(await connection.client());
      if (this.#closed) throw new Error("OpenCode Adapter closed during Session discovery");
      return { ok: true, value };
    } catch {
      return {
        ok: false,
        error: this.#closed
          ? failure("OpenCode Adapter is closed", "invalidState")
          : failure(
              "OpenCode sessions could not be read; check the installation and retry",
              "unavailable",
            ),
      };
    } finally {
      await connection.close();
      this.#connections.delete(connection);
    }
  }

  async open(input: OpenSessionInput): Promise<HarnessResult<HarnessSession>> {
    try {
      input = { ...input, cwd: fs.realpathSync(input.cwd) };
    } catch (error) {
      return errorResult(error);
    }
    const connection = new V2Connection(
      {
        ...this.options,
        environment: { ...(this.options.environment ?? process.env), ...input.environment },
      },
      input.cwd,
    );
    this.#connections.add(connection);
    let created: string | undefined;
    let client: OpenCodeClient | undefined;
    try {
      if (this.#closed) throw new Error("OpenCode Adapter is closed");
      if (!input.cwd) throw new Error("OpenCode requires a working directory");
      let policy: HarnessExecutionPolicy =
        input.kind === "create" ? (input.executionPolicy ?? "default") : "default";
      if (input.kind !== "create") {
        const locator = v2Locator(input.kind === "resume" ? input.nativeRef : input.sourceRef);
        if (!sameDirectory(locator.directory, input.cwd))
          throw new Error("OpenCode cannot resume or derive a Session across directories");
        policy = locator.executionPolicy;
      }
      client = await connection.client();
      const catalog = await this.#catalog(client, input.cwd);
      let info: SessionInfo;
      if (input.kind === "create") {
        const model = selectedModel(input, catalog);
        info = await client.session.create({
          location: { directory: input.cwd },
          ...(model ? { model } : {}),
          permissions: v2Permissions(
            [],
            input.permissionModeId ??
              harnessPermissionModeIdSchema.parse(
                policy === "unattended-full-access" ? "allow" : "default",
              ),
          ),
        });
        created = info.id;
      } else {
        const ref = input.kind === "resume" ? input.nativeRef : input.sourceRef;
        info = await client.session.get({ sessionID: ref.nativeSessionId });
        if (info.id !== ref.nativeSessionId || !sameDirectory(info.location.directory, input.cwd))
          throw new Error("OpenCode returned a different Native Session or directory");
        if ((await client.session.active())[info.id])
          throw new Error("OpenCode Session is already running");
        const source = await readHistory(client, info, this.options.toolOutputLimit ?? 64_000);
        if (source.snapshot.turns.some((turn) => turn.outcome.status === "unknown"))
          throw new Error("OpenCode history contains an incomplete execution");
        if (input.kind !== "resume") {
          const parent = info;
          const turns = source.snapshot.turns;
          let count: number;
          if (input.kind === "rollbackLastTurn") {
            if (!turns.length) throw new Error("OpenCode history is empty");
            count = turns.length - 1;
          } else {
            if (
              input.checkpoint.harnessId !== harnessId ||
              input.checkpoint.nativeSessionId !== info.id
            )
              throw new Error("Checkpoint belongs to another Session");
            count =
              turns.findIndex(
                (turn) => turn.checkpoint?.checkpointId === input.checkpoint.checkpointId,
              ) + 1;
            if (
              !count ||
              JSON.stringify(turns[count - 1]?.checkpoint) !== JSON.stringify(input.checkpoint)
            )
              throw new Error("OpenCode checkpoint does not match native history");
          }
          const before = turns[count]?.nativeTurnRef.nativeTurnKey;
          info = await client.session.fork({ sessionID: parent.id, ...(before ? { before } : {}) });
          if (info.id === parent.id) throw new Error("OpenCode fork returned its source Session");
          created = info.id;
          if (!sameDirectory(info.location.directory, parent.location.directory))
            throw new Error("OpenCode fork changed directory");
          // Fork history and current configuration have independent native semantics.
          await client.session.update({
            sessionID: info.id,
            permissions: parent.permissions ?? [],
          });
          if (parent.model)
            await client.session.switchModel({ sessionID: info.id, model: parent.model });
          info = await client.session.get({ sessionID: info.id });
          const derived = await readHistory(client, info, this.options.toolOutputLimit ?? 64_000);
          if (
            historyContent(derived.snapshot, false) !==
            historyContent({ turns: turns.slice(0, count) }, false)
          )
            throw new Error("OpenCode fork did not preserve the exact history prefix");
          if (
            !isDeepStrictEqual(info.permissions ?? [], parent.permissions ?? []) ||
            !isDeepStrictEqual(info.model, parent.model)
          )
            throw new Error("OpenCode fork did not preserve the current configuration");
          const currentParent = await client.session.get({ sessionID: parent.id });
          if (
            !isDeepStrictEqual(currentParent.model, parent.model) ||
            !isDeepStrictEqual(currentParent.permissions, parent.permissions) ||
            !sameDirectory(currentParent.location.directory, parent.location.directory)
          )
            throw new Error("OpenCode source configuration changed during derivation");
          const unchanged = await readHistory(
            client,
            currentParent,
            this.options.toolOutputLimit ?? 64_000,
          );
          if (historyContent(unchanged.snapshot) !== historyContent(source.snapshot))
            throw new Error("OpenCode source history changed during derivation");
        }
      }
      if (this.#closed) throw new Error("OpenCode Adapter closed during Session open");
      const session = new V2Session(
        client,
        connection,
        info,
        catalog,
        policy,
        this.options.toolOutputLimit ?? 64_000,
        () => {
          this.#sessions.delete(session);
          this.#connections.delete(connection);
        },
      );
      this.#sessions.add(session);
      try {
        await session.start();
      } catch (error) {
        await session.close();
        throw error;
      }
      return { ok: true, value: session };
    } catch (error) {
      if (created && client)
        await client.session.remove({ sessionID: created }).catch(() => undefined);
      await connection.close();
      this.#connections.delete(connection);
      return errorResult(error);
    }
  }

  async close() {
    this.#closed = true;
    await Promise.all([...this.#sessions].map((session) => session.close()));
    await Promise.all([...this.#connections].map((connection) => connection.close()));
    this.#sessions.clear();
    this.#connections.clear();
  }
}

function selectedModel(
  input: Extract<OpenSessionInput, { kind: "create" }>,
  catalog: HarnessModelCatalog,
) {
  const selected = input.model ?? catalog.defaultModel;
  if (!selected) {
    if (input.thinkingOptionId) throw new Error("Thinking selection requires a Model");
    return undefined;
  }
  const entry = catalog.models.find((model) => model.ref.id === selected.id);
  if (!entry) throw new Error("OpenCode Model is not available");
  if (input.thinkingOptionId && !entry.supportedThinkingOptionIds?.includes(input.thinkingOptionId))
    throw new Error("OpenCode Thinking option is not available for this Model");
  const model = decodeOpenCodeModelRef(selected);
  const variant = input.thinkingOptionId
    ? decodeOpenCodeVariant(input.thinkingOptionId)
    : undefined;
  return { providerID: model.providerID, id: model.modelID, ...(variant ? { variant } : {}) };
}

function historyContent(snapshot: HostThreadSnapshot, identities = true) {
  return JSON.stringify(
    snapshot.turns.map((turn) => ({
      ...(identities ? { key: turn.nativeTurnRef.nativeTurnKey } : {}),
      input: turn.input,
      model: turn.model,
      checkpoint: Boolean(turn.checkpoint),
      items: identities
        ? turn.items
        : turn.items.map(({ item, ...rest }) => ({
            ...rest,
            item: { ...item, itemId: undefined },
          })),
      outcome: turn.outcome,
    })),
  );
}
