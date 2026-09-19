import path from "node:path";
import { stat } from "node:fs/promises";
import { z } from "zod";
import type {
  HarnessAdapter,
  HarnessInspection,
  HarnessResult,
  HarnessSession,
  HostThreadSnapshot,
  InspectHarnessInput,
  OpenSessionInput,
} from "@codexhost/harness-adapter";
import {
  harnessSessionImportCandidateSchema,
  nativeSessionRefSchema,
  type NativeSessionRef,
} from "@codexhost/shared-contracts";
import { ZcodeTransport, type TransportOptions } from "./transport.js";
import type { ZcodeConnection } from "./connection.js";
import { DesktopBackend, type DesktopServiceFactory } from "./desktop-backend.js";
import { ZcodeSession, handleRuntimeRequest } from "./session.js";
import { failure, nativeError, ZcodeError } from "./errors.js";
import {
  ZCODE_ID,
  selectNativeModel,
  encodeModel,
  modelCatalog,
  permissionModes,
} from "./models.js";
import { record, snapshotSchema, summarySchema, text, type NativeSnapshot } from "./protocol.js";
import { readWorkspace } from "./desktop-config.js";
import { history } from "./history.js";
import { forkConversation } from "./fork.js";
import { capabilitiesForConnection } from "./capabilities.js";
import { COMMAND_CATALOG } from "./commands.js";
import { sameWorkspaceDirectory } from "./workspace-directory.js";

export interface ZcodeAdapterOptions {
  environment?: NodeJS.ProcessEnv;
  command?: string;
  timeoutMs?: number;
  desktopServiceFactory?: DesktopServiceFactory;
  desktopSupported?: boolean;
}
export class ZcodeAdapter implements HarnessAdapter {
  readonly harnessId = ZCODE_ID;
  readonly commandCatalog = COMMAND_CATALOG;
  readonly #sessions = new Set<ZcodeSession>();
  readonly #transports = new Set<ZcodeConnection>();
  readonly #desktop: DesktopBackend;
  readonly connection: DesktopBackend["connection"];
  readonly #opening = new Set<string>();
  #closed = false;
  constructor(readonly options: ZcodeAdapterOptions = {}) {
    this.#desktop = new DesktopBackend(
      options.environment ?? process.env,
      options.desktopServiceFactory,
      options.desktopSupported,
    );
    this.connection = this.#desktop.connection;
  }
  async sessionEnvironmentScope(input: OpenSessionInput): Promise<"session" | "native"> {
    return (await this.#desktop.target(input)) === "desktop" ? "native" : "session";
  }
  async #transport(
    cwd: string,
    environment?: NodeJS.ProcessEnv,
    input?: OpenSessionInput,
    forceStdio = false,
  ) {
    if (this.#closed) throw new ZcodeError("invalidState", "ZCode adapter is closed");
    const options: TransportOptions = {
      cwd,
      environment: { ...(this.options.environment ?? process.env), ...environment },
      ...(this.options.command ? { command: this.options.command } : {}),
      ...(this.options.timeoutMs ? { timeoutMs: this.options.timeoutMs } : {}),
    };
    const target = forceStdio ? "stdio" : await this.#desktop.target(input);
    if (target === "desktop") {
      const ref =
        input && input.kind !== "create"
          ? input.kind === "resume"
            ? input.nativeRef
            : input.sourceRef
          : undefined;
      const connection = await this.#desktop.open(options, environment, ref);
      this.#transports.add(connection);
      return connection;
    }
    const transport = new ZcodeTransport(options);
    transport.onMessage = (message) => {
      if (!handleRuntimeRequest(transport, message) && message.id !== undefined)
        transport.reject(message.id);
    };
    this.#transports.add(transport);
    try {
      transport.start();
    } catch (error) {
      this.#transports.delete(transport);
      throw error;
    }
    return transport;
  }
  async #temporary<T>(
    cwd: string,
    work: (transport: ZcodeConnection) => Promise<T>,
    forceStdio = false,
  ): Promise<T> {
    const transport = await this.#transport(cwd, undefined, undefined, forceStdio);
    try {
      return await work(transport);
    } finally {
      await transport.close();
      this.#transports.delete(transport);
    }
  }
  async inspect(input: InspectHarnessInput = {}): Promise<HarnessInspection> {
    try {
      const cwd = input.cwd ?? (await this.#desktop.inspectionCwd()) ?? process.cwd();
      return await this.#temporary(path.resolve(cwd), async (transport) => {
        const state = await readWorkspace(transport),
          catalog = modelCatalog(
            state.settings,
            transport.locator?.backend === "desktop" ? "desktop" : "stdio",
          );
        if (!catalog.models.length)
          throw new ZcodeError(
            "authenticationRequired",
            "ZCode has no available models. Configure and authenticate a Provider in ZCode.",
          );
        return {
          status: "ready",
          catalog,
          permissionModes: permissionModes(state.settings.mode.current),
          capabilities: capabilitiesForConnection(transport),
        };
      });
    } catch (error) {
      const normalized = nativeError(error);
      return {
        status: normalized.code === "notInstalled" ? "notInstalled" : "unavailable",
        error: {
          code: normalized.code,
          message: normalized.message,
          retryable: normalized.retryable,
        },
      };
    }
  }
  #reference(ref: NativeSessionRef, cwd: string) {
    if (!nativeSessionRefSchema.safeParse(ref).success || ref.harnessId !== ZCODE_ID)
      throw new ZcodeError("invalidRequest", "Native session reference does not belong to ZCode");
    const savedCwd = text(record(ref.locator).cwd);
    if (savedCwd && !sameWorkspaceDirectory(savedCwd, cwd))
      throw new ZcodeError("unsupported", "ZCode sessions cannot change workspace directory");
    if (
      this.#opening.has(ref.nativeSessionId) ||
      [...this.#sessions].some(
        (session) => session.sessionId === ref.nativeSessionId && session.busy,
      )
    )
      throw new ZcodeError("sessionBusy", "ZCode source session is busy", true);
  }
  async open(input: OpenSessionInput): Promise<HarnessResult<HarnessSession>> {
    let transport: ZcodeConnection | undefined;
    let lock: string | undefined;
    try {
      if (!path.isAbsolute(input.cwd) || !(await stat(input.cwd)).isDirectory())
        throw new ZcodeError(
          "invalidRequest",
          "ZCode requires an existing absolute workspace directory",
        );
      if (
        (input.kind === "fork" || input.kind === "rollbackLastTurn") &&
        (await this.#desktop.target(input)) === "desktop"
      )
        throw new ZcodeError(
          "unsupported",
          "Desktop history derivation has not been validated; use ZCode's native UI",
        );
      if (input.kind !== "create") {
        const ref = input.kind === "resume" ? input.nativeRef : input.sourceRef;
        this.#reference(ref, input.cwd);
        if (
          input.kind === "resume" &&
          [...this.#sessions].some((session) => session.sessionId === ref.nativeSessionId)
        )
          throw new ZcodeError("sessionBusy", "ZCode session is already open", true);
        lock = ref.nativeSessionId;
        this.#opening.add(lock);
        if (
          input.kind === "fork" &&
          (input.checkpoint.harnessId !== ZCODE_ID ||
            input.checkpoint.nativeSessionId !== ref.nativeSessionId)
        )
          throw new ZcodeError("checkpointNotFound", "ZCode checkpoint belongs to another session");
      }
      transport = await this.#transport(input.cwd, input.environment, input);
      const backend = transport.locator?.backend === "desktop" ? "desktop" : "stdio";
      // Restore the native workspace before registering ephemeral Providers. An
      // equivalent cwd spelling is not necessarily the same native registry key.
      let source: NativeSnapshot | undefined;
      if (input.kind !== "create") {
        const ref = input.kind === "resume" ? input.nativeRef : input.sourceRef;
        source = snapshotSchema.parse(
          await transport.request("session/resume", { sessionId: ref.nativeSessionId }),
        );
        if (source.session.sessionId !== ref.nativeSessionId)
          throw new ZcodeError("protocolError", "ZCode resumed a different session");
        if (!sameWorkspaceDirectory(source.session.workspace.workspacePath, input.cwd))
          throw new ZcodeError("unsupported", "ZCode session belongs to a different workspace");
      }
      const workspace = await readWorkspace(transport, source?.session.workspace);
      if (
        "model" in input &&
        input.model &&
        !modelCatalog(workspace.settings, backend).models.some(
          (model) => model.ref.id === input.model?.id,
        )
      )
        throw new ZcodeError("invalidRequest", "Requested ZCode model is not available");
      if (
        "permissionModeId" in input &&
        input.permissionModeId &&
        !permissionModes().modes.some((mode) => mode.id === input.permissionModeId)
      )
        throw new ZcodeError("invalidRequest", "Unknown ZCode permission mode");
      if (input.kind === "create" && input.thinkingOptionId) {
        const catalog = modelCatalog(workspace.settings, backend),
          selected = "model" in input && input.model ? input.model : catalog.defaultModel;
        const model =
          catalog.models.find((model) => model.ref.id === selected?.id) ?? catalog.models[0];
        if (!model?.supportedThinkingOptionIds?.includes(input.thinkingOptionId))
          throw new ZcodeError(
            "invalidRequest",
            "Requested thinking option is not supported by the ZCode model",
          );
      }
      let snapshot: NativeSnapshot;
      if (input.kind === "create") {
        if (
          input.executionPolicy === "unattended-full-access" &&
          input.permissionModeId &&
          input.permissionModeId !== "yolo"
        )
          throw new ZcodeError(
            "invalidRequest",
            "Full access execution conflicts with the selected ZCode permission mode",
          );
        snapshot = snapshotSchema.parse(
          await transport.request("session/create", {
            workspace: workspace.workspace,
            ...(input.model
              ? {
                  model: selectNativeModel(
                    input.model,
                    workspace.settings,
                    workspace.registryScope === "process",
                    input.thinkingOptionId,
                  ),
                }
              : {}),
            ...(input.thinkingOptionId ? { thoughtLevel: input.thinkingOptionId } : {}),
            ...(input.executionPolicy === "unattended-full-access"
              ? { mode: "yolo" }
              : input.permissionModeId
                ? { mode: input.permissionModeId }
                : {}),
          }),
        );
      } else {
        const ref = input.kind === "resume" ? input.nativeRef : input.sourceRef;
        snapshot = snapshotSchema.parse(
          await transport.request("session/read", {
            sessionId: ref.nativeSessionId,
          }),
        );
        if (snapshot.session.sessionId !== ref.nativeSessionId)
          throw new ZcodeError("protocolError", "ZCode resumed a different session");
        if (!sameWorkspaceDirectory(snapshot.session.workspace.workspacePath, input.cwd))
          throw new ZcodeError("unsupported", "ZCode resumed a different workspace");
        if (input.kind !== "resume") {
          const source = history(snapshot, [], transport.locator),
            count =
              input.kind === "fork"
                ? source.turns.findIndex(
                    (turn) => turn.checkpoint?.checkpointId === input.checkpoint.checkpointId,
                  ) + 1
                : source.turns.length - 1;
          if (input.kind === "fork" && count <= 0)
            throw new ZcodeError(
              "checkpointNotFound",
              "ZCode checkpoint was not found in the active history",
            );
          if (input.kind === "rollbackLastTurn" && count < 0)
            throw new ZcodeError("invalidRequest", "ZCode has no turn to roll back");
          const settings = snapshot.settings;
          if (input.kind === "rollbackLastTurn" && input.thinkingOptionId) {
            const catalog = modelCatalog(workspace.settings, backend),
              selected =
                input.model ??
                (settings.model.current ? encodeModel(settings.model.current, backend) : undefined);
            if (
              !catalog.models
                .find((model) => model.ref.id === selected?.id)
                ?.supportedThinkingOptionIds?.includes(input.thinkingOptionId)
            )
              throw new ZcodeError(
                "invalidRequest",
                "Requested thinking option is not supported by the ZCode model",
              );
          }
          if (count === 0)
            snapshot = snapshotSchema.parse(
              await transport.request("session/create", {
                workspace: snapshot.session.workspace,
                model: settings.model.current,
                ...(settings.thoughtLevel.current
                  ? { thoughtLevel: settings.thoughtLevel.current }
                  : {}),
                mode: settings.mode.current,
              }),
            );
          else {
            const checkpoint = source.turns[count - 1]?.checkpoint;
            if (!checkpoint)
              throw new ZcodeError(
                "unsupported",
                "ZCode cannot derive history at an incomplete turn",
              );
            snapshot = await forkConversation(transport, snapshot, checkpoint.checkpointId);
          }
          if (snapshot.session.sessionId === ref.nativeSessionId)
            throw new ZcodeError(
              "protocolError",
              "ZCode history derivation reused the source session",
            );
          const derived = history(snapshot, [], transport.locator);
          if (
            derived.turns.length !== count ||
            derived.turns.some(
              (turn, index) =>
                JSON.stringify(historyContent(turn)) !==
                JSON.stringify(
                  source.turns[index] ? historyContent(source.turns[index]) : undefined,
                ),
            )
          )
            throw new ZcodeError(
              "protocolError",
              "ZCode did not preserve the exact history prefix",
            );
          if (input.kind === "rollbackLastTurn") {
            const selectedModel = input.model
              ? selectNativeModel(
                  input.model,
                  workspace.settings,
                  workspace.registryScope === "process",
                  input.thinkingOptionId,
                )
              : settings.model.current;
            if (selectedModel)
              snapshot = snapshotSchema.parse(
                await transport.request("session/setModel", {
                  sessionId: snapshot.session.sessionId,
                  model: selectedModel,
                  persistAsWorkspaceLastUsed: false,
                }),
              );
            const modelChanged =
              input.model &&
              (!settings.model.current ||
                input.model.id !== encodeModel(settings.model.current, backend).id);
            const thought =
              input.thinkingOptionId ?? (modelChanged ? undefined : settings.thoughtLevel.current);
            if (thought)
              snapshot = snapshotSchema.parse(
                await transport.request("session/setThoughtLevel", {
                  sessionId: snapshot.session.sessionId,
                  thoughtLevel: thought,
                  persistAsWorkspaceLastUsed: false,
                }),
              );
            snapshot = snapshotSchema.parse(
              await transport.request("session/setMode", {
                sessionId: snapshot.session.sessionId,
                mode: input.permissionModeId ?? settings.mode.current,
              }),
            );
          }
        }
      }
      if (
        input.kind === "create" &&
        input.thinkingOptionId &&
        snapshot.settings.thoughtLevel.current !== input.thinkingOptionId
      )
        throw new ZcodeError(
          "invalidRequest",
          "ZCode did not accept the requested thinking option",
        );
      if (
        input.kind === "create" &&
        input.executionPolicy === "unattended-full-access" &&
        snapshot.settings.mode.current !== "yolo"
      )
        throw new ZcodeError(
          "unsupported",
          "ZCode did not accept unattended full access execution",
        );
      if (this.#closed)
        throw new ZcodeError("invalidState", "ZCode adapter closed during session creation");
      const owned = transport;
      const session = new ZcodeSession(
        transport,
        snapshot,
        () => {
          this.#sessions.delete(session);
          this.#transports.delete(owned);
        },
        workspace.settings,
        () => this.#opening.has(snapshot.session.sessionId),
        workspace.registryScope === "process",
      );
      this.#sessions.add(session);
      try {
        await session.subscribe();
      } catch (error) {
        await session.close();
        throw error;
      }
      transport = undefined;
      return { ok: true, value: session };
    } catch (error) {
      return { ok: false, error: nativeError(error) };
    } finally {
      if (transport) {
        await transport.close();
        this.#transports.delete(transport);
      }
      if (lock) this.#opening.delete(lock);
    }
  }
  readonly sessionImport = {
    listCandidates: async () => {
      try {
        return { ok: true as const, value: await this.#listCandidates() };
      } catch (error) {
        return { ok: false as const, error: nativeError(error) };
      }
    },
    resolveCandidate: async (id: string) => {
      try {
        const candidate = (await this.#listCandidates()).find(
          (candidate) => candidate.nativeSessionId === id,
        );
        if (!candidate) return failure("sessionNotFound", "ZCode session is not available");
        return {
          ok: true as const,
          value: {
            candidate,
            nativeRef: nativeSessionRefSchema.parse({
              harnessId: ZCODE_ID,
              nativeSessionId: id,
              locator: { cwd: candidate.cwd },
              formatVersion: 1,
            }),
          },
        };
      } catch (error) {
        return { ok: false as const, error: nativeError(error) };
      }
    },
  };
  async #listCandidates() {
    return this.#temporary(
      process.cwd(),
      async (transport) => {
        const result = z
          .object({ sessions: z.array(summarySchema) })
          .parse(await transport.request("session/list", { limit: 100_000 }));
        return result.sessions.map((session) =>
          harnessSessionImportCandidateSchema.parse({
            nativeSessionId: session.sessionId,
            title: session.title.trim() || null,
            updatedAt: session.updatedAt,
            cwd: session.workspace.workspacePath,
            running: [...this.#sessions].some(
              (open) => open.sessionId === session.sessionId && open.busy,
            )
              ? true
              : null,
          }),
        );
      },
      true,
    );
  }
  readonly subagents = {
    readSnapshot: async (input: {
      parent: NativeSessionRef;
      nativeSubagentId: string;
      cwd: string;
    }): Promise<HarnessResult<HostThreadSnapshot>> => {
      try {
        if (input.parent.harnessId !== ZCODE_ID)
          return failure("invalidRequest", "Subagent parent does not belong to ZCode");
        if (record(input.parent.locator).backend === "desktop")
          return failure(
            "unsupported",
            "Desktop subagent transcript import is not supported; inspect it in ZCode",
          );
        return await this.#temporary(
          input.cwd,
          async (transport) => {
            await readWorkspace(transport);
            const children = record(
              await transport.request("session/subagents", {
                sessionId: input.parent.nativeSessionId,
              }),
            );
            if (
              !Array.isArray(children.childSessionIds) ||
              !children.childSessionIds.includes(input.nativeSubagentId)
            )
              return failure("sessionNotFound", "ZCode subagent does not belong to this parent");
            if (
              Array.isArray(children.running) &&
              children.running.some(
                (value) => record(value).childSessionId === input.nativeSubagentId,
              )
            )
              return failure(
                "sessionBusy",
                "ZCode exposes child transcripts only after the child has stopped",
                true,
              );
            const child = snapshotSchema.parse(
              await transport.request("session/resume", { sessionId: input.nativeSubagentId }),
            );
            return { ok: true as const, value: history(child) };
          },
          true,
        );
      } catch (error) {
        return { ok: false, error: nativeError(error) };
      }
    },
  };
  async close() {
    if (this.#closed) return;
    this.#closed = true;
    await Promise.all([...this.#sessions].map((session) => session.close()));
    await Promise.all([...this.#transports].map((transport) => transport.close()));
    this.#sessions.clear();
    this.#transports.clear();
    await this.#desktop.close();
  }
}

/** Fork remaps message/part identities; compare the actual user-visible prefix. */
function historyContent(turn: HostThreadSnapshot["turns"][number]) {
  return {
    input: turn.input,
    items: turn.items.map(({ item, outcome }) => {
      const content = Object.fromEntries(Object.entries(item).filter(([key]) => key !== "itemId"));
      if ("sourceItemIds" in content) delete content.sourceItemIds;
      return { item: content, outcome: outcome.status };
    }),
    outcome: turn.outcome.status,
  };
}
