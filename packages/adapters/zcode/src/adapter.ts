import { createZcodeUsageStatistics } from "./usage-statistics.js";
import path from "node:path";
import type { HarnessLocalPage } from "@codexhost/harness-adapter/plugin";
import { stat } from "node:fs/promises";
import type {
  HarnessAdapter,
  HarnessInspection,
  HarnessResult,
  HarnessSession,
  InspectHarnessInput,
  OpenSessionInput,
} from "@codexhost/harness-adapter";
import { nativeSessionRefSchema } from "@codexhost/shared-contracts";
import { CliTransport, type TransportOptions } from "./transport.js";
import {
  createZcodeVerifier,
  type ZcodeVerifier,
  type ZcodeVerifierOptions,
} from "./verification/index.js";
import { ZcodeSession } from "./session.js";
import {
  ZCODE_ID,
  modelCatalog,
  permissionModes,
  selectNativeModel,
  encodeModel,
} from "./models.js";
import { ZCODE_CAPABILITIES } from "./capabilities.js";
import { snapshotSchema, record } from "./protocol.js";
import { nativeError, ZcodeError, failure } from "./errors.js";
import { sameWorkspaceDirectory } from "./workspace-directory.js";
import { COMMAND_CATALOG } from "./commands.js";

export interface ZcodeAdapterOptions {
  environment?: NodeJS.ProcessEnv;
  /** ZCode application location; defaults to CODEXHOST_ZCODE_APP or the platform default. */
  app?: string;
  timeoutMs?: number;
  openLocalPage?: (url: string) => Promise<HarnessLocalPage>;
  createVerifier?: (options: ZcodeVerifierOptions) => ZcodeVerifier;
  createTransport?: (options: TransportOptions) => CliTransport;
}
/** A deferred native draft yields the full model catalog and is discarded unpersisted. */
async function readCatalog(transport: CliTransport) {
  const draft = snapshotSchema.parse(await transport.request("createDraftSession"));
  await transport.request("closeSession", {
    sessionId: draft.session.sessionId,
    expectedPersistence: "deferred",
  });
  return draft.settings;
}
export class ZcodeAdapter implements HarnessAdapter {
  readonly harnessId = ZCODE_ID;
  readonly commandCatalog = COMMAND_CATALOG;
  #closed = false;
  #sessions = new Set<ZcodeSession>();
  #transports = new Set<CliTransport>();
  #opening = new Set<string>();
  // One verification page and SDK instance for the whole Host, as in ZCode Desktop.
  #verifier: ZcodeVerifier | undefined;
  #prewarmed = false;
  readonly usageStatistics: ReturnType<typeof createZcodeUsageStatistics>;
  constructor(readonly options: ZcodeAdapterOptions = {}) {
    this.usageStatistics = createZcodeUsageStatistics(options.environment ?? process.env);
  }
  #sharedVerifier = (appVersion: string) =>
    (this.#verifier ??= (this.options.createVerifier ?? createZcodeVerifier)({
      appVersion,
      ...(this.options.openLocalPage ? { openLocalPage: this.options.openLocalPage } : {}),
    }));
  async #transport(cwd: string, environment?: NodeJS.ProcessEnv) {
    if (this.#closed) throw new ZcodeError("invalidState", "ZCode Adapter is closed");
    if (!(await stat(cwd)).isDirectory())
      throw new ZcodeError("invalidRequest", "ZCode workspace is not a directory");
    const options: TransportOptions = {
      cwd,
      environment: { ...(this.options.environment ?? process.env), ...environment },
      ...(this.options.app ? { app: this.options.app } : {}),
      ...(this.options.timeoutMs ? { timeoutMs: this.options.timeoutMs } : {}),
      verifier: this.#sharedVerifier,
    };
    const transport = this.options.createTransport
      ? this.options.createTransport(options)
      : new CliTransport(options);
    this.#transports.add(transport);
    try {
      await transport.start();
      return transport;
    } catch (error) {
      this.#transports.delete(transport);
      await transport.close();
      throw error;
    }
  }
  async inspect(input: InspectHarnessInput = {}): Promise<HarnessInspection> {
    let transport: CliTransport | undefined;
    try {
      transport = await this.#transport(path.resolve(input.cwd ?? process.cwd()));
      const settings = await readCatalog(transport);
      const catalog = modelCatalog(settings);
      if (!catalog.models.length)
        return {
          status: "unavailable",
          error: {
            code: "authenticationRequired",
            message:
              "ZCode has no available models. Sign in to ZCode Desktop with a Start Plan account or add a personal provider in ZCode.",
            retryable: true,
          },
        };
      return {
        status: "ready",
        catalog,
        permissionModes: permissionModes(settings.mode.current),
        capabilities: ZCODE_CAPABILITIES,
      };
    } catch (error) {
      const e = nativeError(error);
      return { status: e.code === "notInstalled" ? "notInstalled" : "unavailable", error: e };
    } finally {
      if (transport) {
        await transport.close();
        this.#transports.delete(transport);
      }
    }
  }
  async open(input: OpenSessionInput): Promise<HarnessResult<HarnessSession>> {
    if (input.kind === "fork" || input.kind === "rollbackLastTurn")
      return failure(
        "unsupported",
        "ZCode history derivation is not enabled for the ZCode Adapter",
      );
    const parsedRef =
      input.kind === "resume" ? nativeSessionRefSchema.safeParse(input.nativeRef) : undefined;
    if (parsedRef && !parsedRef.success)
      return failure("invalidRequest", "Invalid ZCode Session reference");
    const nativeRef = parsedRef?.data;
    const locator = record(nativeRef?.locator);
    if (
      nativeRef &&
      (nativeRef.harnessId !== ZCODE_ID ||
        nativeRef.formatVersion !== 1 ||
        locator.backend !== "local-service" ||
        typeof locator.cwd !== "string" ||
        !sameWorkspaceDirectory(locator.cwd, input.cwd))
    )
      return failure("invalidRequest", "ZCode Session identity or workspace does not match");
    const key = nativeRef?.nativeSessionId;
    if (key && (this.#opening.has(key) || [...this.#sessions].some((s) => s.sessionId === key)))
      return failure("sessionBusy", "ZCode Session is already open", true);
    if (key) this.#opening.add(key);
    let transport: CliTransport | undefined;
    let createdId: string | undefined;
    try {
      transport = await this.#transport(path.resolve(input.cwd), input.environment);
      let snapshot, settings;
      if (input.kind === "create") {
        settings = await readCatalog(transport);
        if (
          input.permissionModeId &&
          !permissionModes().modes.some((m) => m.id === input.permissionModeId)
        )
          throw new ZcodeError("invalidRequest", "Unknown ZCode permission mode");
        const model = input.model
          ? selectNativeModel(input.model, settings, input.thinkingOptionId)
          : undefined;
        const mode =
          input.executionPolicy === "unattended-full-access" ? "yolo" : input.permissionModeId;
        const created = await transport.command(null, "createSession", {
          workspaceId: input.cwd,
          config: {
            ...(model ? { modelSelection: model } : {}),
            ...(mode ? { mode } : {}),
            ...(input.thinkingOptionId ? { thought: input.thinkingOptionId } : {}),
          },
        });
        const result = record(created.result);
        if (
          result.type !== "createSession" ||
          typeof result.sessionId !== "string" ||
          !result.sessionId
        )
          throw new ZcodeError("protocolError", "ZCode did not return a created Session identity");
        createdId = result.sessionId;
        snapshot = snapshotSchema.parse(
          await transport.request("readSession", { sessionId: createdId }),
        );
      } else {
        snapshot = snapshotSchema.parse(
          await transport.request("resumeSession", { sessionId: input.nativeRef.nativeSessionId }),
        );
        if (snapshot.session.sessionId !== input.nativeRef.nativeSessionId)
          throw new ZcodeError("protocolError", "ZCode resumed a different Session");
        // session/resume carries the full model catalog; session/read carries only the current one.
        settings = snapshot.settings;
      }
      if (!sameWorkspaceDirectory(snapshot.session.workspace.workspacePath, input.cwd))
        throw new ZcodeError("protocolError", "ZCode Session belongs to a different workspace");
      if (snapshot.projection.currentTurnId || snapshot.session.status === "running")
        throw new ZcodeError("sessionBusy", "ZCode Session is executing native work", true);
      if (input.kind === "create") {
        if (
          input.model &&
          (!snapshot.settings.model.current ||
            encodeModel(snapshot.settings.model.current).id !== input.model.id)
        )
          throw new ZcodeError("nativeFailure", "ZCode did not apply the requested model");
        if (
          input.thinkingOptionId &&
          snapshot.settings.thoughtLevel.current !== input.thinkingOptionId
        )
          throw new ZcodeError(
            "nativeFailure",
            "ZCode did not apply the requested thinking option",
          );
        const requestedMode =
          input.executionPolicy === "unattended-full-access" ? "yolo" : input.permissionModeId;
        if (requestedMode && snapshot.settings.mode.current !== requestedMode)
          throw new ZcodeError(
            "nativeFailure",
            "ZCode did not apply the requested permission mode",
          );
      }
      if (this.#closed)
        throw new ZcodeError("invalidState", "ZCode Adapter closed while opening a Session");
      const ownedTransport = transport;
      const session = new ZcodeSession(
        ownedTransport,
        snapshot,
        () => {
          this.#sessions.delete(session);
          this.#transports.delete(ownedTransport);
        },
        settings,
      );
      await session.subscribe();
      this.#sessions.add(session);
      // Desktop warms its SDK after sign-in, so the first model request need not load it cold.
      if (!this.#prewarmed && ownedTransport.startPlan) {
        this.#prewarmed = true;
        this.#sharedVerifier(ownedTransport.appVersion).prewarm();
      }
      return { ok: true, value: session };
    } catch (error) {
      if (transport) {
        if (createdId)
          await transport.request("closeSession", { sessionId: createdId }).catch(() => undefined);
        await transport.close();
        this.#transports.delete(transport);
      }
      return { ok: false, error: nativeError(error) };
    } finally {
      if (key) this.#opening.delete(key);
    }
  }
  async close() {
    this.#closed = true;
    await Promise.all([...this.#sessions].map((session) => session.close()));
    await Promise.all([...this.#transports].map((transport) => transport.close()));
    this.#sessions.clear();
    this.#transports.clear();
    await this.#verifier?.close();
  }
}
