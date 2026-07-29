import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";

import { PiAdapter } from "@codexhost/adapter-pi";
import type {
  HarnessAdapter,
  HarnessOutput,
  HarnessSession,
  HostQuestionInteraction,
} from "@codexhost/harness-adapter";
import type { StoredThreadRecordV1 } from "@codexhost/mapping-store";
import {
  harnessInspectionSchema,
  harnessModelSelectionStateSchema,
  hostItemIdSchema,
  hostTurnIdSchema,
  jsonValueSchema,
  piHarnessInspectParamsSchema,
  threadInspectionParamsSchema,
  threadInspectionSchema,
  threadModelSelectParamsSchema,
  type HarnessModelRef,
  type HostInteractionId,
  type HostTurnId,
} from "@codexhost/shared-contracts";
import { executeExternalThreadFork } from "./external-thread-fork.js";
import {
  createExternalThreadRecordInput,
  createProductionExternalThreadStore,
  ExternalThreadRepository,
  externalThreadValue,
  type ExternalThreadStore,
} from "./external-thread-repository.js";
import {
  ExternalThreadRuntime,
  type ExternalThread,
  type ExternalThreadResolution,
} from "./external-thread-runtime.js";
import {
  classifyThreadPurpose,
  RequestRouteObservationTracker,
  type CreateRequestRouteObservation,
  type RequestRouteObservation,
} from "./route-observation.js";
import {
  CodexTurnProjector,
  decodeCreateRoute,
  decodePiTransportModel,
  decodeThreadForkRequest,
  mapExternalThreadHarnessError,
  parseJsonFrame,
  readLfFrames,
  writeFrame,
  writeJsonFrame,
  jsonRpcRequestSchema,
  threadForkResult,
  transportModelIdForHarness,
  type CodexQuestionProjection,
  type DecodedThreadForkRequest,
  type ExternalThreadRpcError,
  type CodexQuestionRequestProjection,
  type ExternalHarnessId,
  type JsonObject,
  type JsonRpcRequest,
  type JsonValue,
  type ProjectableHostEvent,
} from "@codexhost/protocol-core";

export interface AppServerHostOptions {
  stockCodexPath: string;
  arguments: string[];
  defaultAgent: "codex" | "pi";
  environment?: NodeJS.ProcessEnv;
  desktopInput?: Readable;
  desktopOutput?: Writable;
  diagnosticOutput?: Writable;
  piCommand?: string;
  piAdapter?: HarnessAdapter;
  externalAdapters?: ReadonlyMap<ExternalHarnessId, HarnessAdapter>;
  mappingStore?: ExternalThreadStore;
  spawnOfficial?: typeof spawn;
  onCreateRequestRoute?: (observation: CreateRequestRouteObservation) => void;
  onRequestRoute?: (observation: RequestRouteObservation) => void;
}

interface TurnProjectionGate {
  promise: Promise<void>;
  resolve(): void;
}

interface ProjectedTurn {
  projector: CodexTurnProjector;
}

type HostQuestionRequestId = number;

interface PendingDesktopQuestion {
  thread: ExternalThread;
  interaction: HostQuestionInteraction;
  projection: CodexQuestionRequestProjection;
  timeout: NodeJS.Timeout | null;
}

type ExternalThreadStatus = { type: "active"; activeFlags: [] } | { type: "idle" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function officialEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const internal = new Set([
    "CODEX_CLI_PATH",
    "CODEXHOST_HOST_NODE_PATH",
    "CODEXHOST_DATA_DIR",
    "CODEXHOST_DEFAULT_AGENT",
    "CODEXHOST_HOST_RUNTIME_PATH",
    "CODEXHOST_PI_COMMAND",
    "CODEXHOST_ENABLE_CLAUDE_CODE",
    "CODEXHOST_CLAUDE_COMMAND",
    "CODEXHOST_STOCK_CODEX_PATH",
  ]);
  return Object.fromEntries(Object.entries(source).filter(([key]) => !internal.has(key)));
}

function rpcEnvelope(request: JsonRpcRequest, value: JsonObject): JsonObject {
  return {
    ...(request.jsonrpc === "2.0" ? { jsonrpc: "2.0" } : {}),
    id: request.id,
    ...value,
  };
}

function rpcError(request: JsonRpcRequest, code: number, message: string): JsonObject {
  return rpcEnvelope(request, { error: { code, message } });
}

function unixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

const HOST_QUESTION_REQUEST_ID_MIN = -1_000_000;
const HOST_QUESTION_REQUEST_ID_MAX = -1;

function isHostQuestionRequestId(value: unknown): value is HostQuestionRequestId {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= HOST_QUESTION_REQUEST_ID_MIN &&
    value <= HOST_QUESTION_REQUEST_ID_MAX
  );
}

export function classifyCreateRequestRoute(
  request: JsonRpcRequest,
  defaultAgent: "codex" | "pi",
): CreateRequestRouteObservation | null {
  const route = decodeCreateRoute(request);
  if (!route) return null;
  if (route.harnessId !== "codex") {
    return {
      requestMethod: "thread/start",
      modelCarrier: `${route.harnessId}-transport`,
      selectedHarness: route.harnessId,
      selectionSource: "transport-model",
    };
  }
  return {
    requestMethod: "thread/start",
    modelCarrier: "official-model",
    selectedHarness: defaultAgent,
    selectionSource: defaultAgent === "pi" ? "default-agent" : "official-model",
  };
}

function requestObject(request: JsonRpcRequest): JsonObject {
  if (!isRecord(request.params)) throw new Error(`${request.method} params must be an object`);
  return request.params as JsonObject;
}

function requestText(params: JsonObject): string {
  if (!Array.isArray(params.input)) throw new Error("turn/start input must be an array");
  const text = params.input
    .filter((item): item is JsonObject => isRecord(item) && item.type === "text")
    .map((item) => item.text)
    .filter((value): value is string => typeof value === "string")
    .join("\n");
  if (!text) throw new Error("turn/start must contain text input");
  return text;
}

function sandboxResult(params: JsonObject): JsonObject {
  const sandbox = params.sandbox;
  if (sandbox === "read-only") return { type: "readOnly", networkAccess: false };
  if (sandbox === "danger-full-access") return { type: "dangerFullAccess" };
  return {
    type: "workspaceWrite",
    networkAccess: false,
    writableRoots: [],
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

function turnProjectionGate(): TurnProjectionGate {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

class OrderedWriter {
  #tail = Promise.resolve();

  constructor(private readonly stream: Writable) {}

  frame(frame: Buffer<ArrayBufferLike>): Promise<void> {
    return this.#enqueue(() => writeFrame(this.stream, frame));
  }

  json(value: JsonValue): Promise<void> {
    return this.#enqueue(() => writeJsonFrame(this.stream, value));
  }

  #enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.#tail.then(operation, operation);
    this.#tail = next.catch(() => undefined);
    return next;
  }
}

export class AppServerHost {
  readonly #options: Required<
    Pick<AppServerHostOptions, "desktopInput" | "desktopOutput" | "diagnosticOutput">
  > &
    AppServerHostOptions;
  #official: ChildProcessWithoutNullStreams | null = null;
  #externalAdapters: Map<ExternalHarnessId, HarnessAdapter>;
  #externalRuntime: ExternalThreadRuntime;
  #repository: ExternalThreadRepository;
  #pendingDesktopQuestions = new Map<HostQuestionRequestId, PendingDesktopQuestion>();
  #nextQuestionRequestId = HOST_QUESTION_REQUEST_ID_MAX;
  #routeObservationTracker = new RequestRouteObservationTracker();
  #writer: OrderedWriter;

  constructor(options: AppServerHostOptions) {
    this.#options = {
      desktopInput: process.stdin,
      desktopOutput: process.stdout,
      diagnosticOutput: process.stderr,
      ...options,
    };
    this.#writer = new OrderedWriter(this.#options.desktopOutput);
    this.#repository = new ExternalThreadRepository(
      options.mappingStore ??
        createProductionExternalThreadStore(this.#options.environment ?? process.env),
    );
    this.#externalAdapters = options.externalAdapters
      ? new Map(options.externalAdapters)
      : new Map([
          [
            "pi",
            options.piAdapter ??
              new PiAdapter({
                ...(options.piCommand ? { command: options.piCommand } : {}),
                environment: options.environment ?? process.env,
              }),
          ],
        ]);
    for (const [harnessId, adapter] of this.#externalAdapters) {
      if (adapter.harnessId !== harnessId) {
        throw new Error(`External Adapter '${harnessId}' has mismatched Harness ID`);
      }
    }
    this.#externalRuntime = new ExternalThreadRuntime({
      adapters: this.#externalAdapters,
      repository: this.#repository,
      consumeOutputs: (thread) => this.#consumeHarnessOutputs(thread),
      diagnose: (error) => this.#diagnose(error),
    });
  }

  async run(): Promise<number> {
    try {
      await this.#repository.initialize();
    } catch (error) {
      this.#diagnose(`Mapping Store initialization failed: ${errorMessage(error)}`);
      return 1;
    }
    const spawnOfficial = this.#options.spawnOfficial ?? spawn;
    const official = spawnOfficial(this.#options.stockCodexPath, this.#options.arguments, {
      env: officialEnvironment(this.#options.environment ?? process.env),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    official.stderr.pipe(this.#options.diagnosticOutput, { end: false });
    this.#official = official;
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        official.once("error", reject);
        official.once("exit", (code, signal) => resolve({ code, signal }));
      },
    );
    try {
      await Promise.all([this.#forwardDesktop(), this.#forwardOfficial()]);
      const result = await exited;
      if (result.signal) throw new Error(`official app-server exited by signal ${result.signal}`);
      return result.code ?? 1;
    } catch (error) {
      this.#diagnose(error);
      official.stdin.destroy();
      official.kill("SIGTERM");
      await exited.catch(() => undefined);
      return 1;
    } finally {
      const threads = this.#externalRuntime.values();
      await Promise.allSettled(threads.map(({ session }) => session.close()));
      await Promise.allSettled(threads.map(({ outputTask }) => outputTask));
      await Promise.allSettled(
        [...new Set(this.#externalAdapters.values())].map((adapter) => adapter.close()),
      );
      for (const pending of [...this.#pendingDesktopQuestions.values()]) {
        await this.#resolveDesktopQuestion(pending.interaction.interactionId).catch(
          () => undefined,
        );
      }
      this.#externalRuntime.clear();
      this.#routeObservationTracker.clear();
      await this.#repository.close().catch((error) => this.#diagnose(error));
    }
  }

  async #forwardDesktop(): Promise<void> {
    const official = this.#official;
    if (!official) throw new Error("official app-server is unavailable");
    for await (const frame of readLfFrames(this.#options.desktopInput)) {
      const parsed = parseJsonFrame(frame);
      if (await this.#handleDesktopQuestionResponse(parsed)) continue;
      const requestResult = jsonRpcRequestSchema.safeParse(parsed);
      if (!requestResult.success) {
        await writeFrame(official.stdin, frame);
        continue;
      }
      const request = requestResult.data;
      if (request.method === "codexhost/harness/inspect") {
        await this.#inspectHarness(request);
        continue;
      }
      if (request.method === "codexhost/thread/inspect") {
        await this.#inspectThread(request);
        continue;
      }
      if (request.method === "codexhost/thread/model/select") {
        await this.#selectPiThreadModel(request);
        continue;
      }
      let createRoute: CreateRequestRouteObservation | null;
      try {
        createRoute = classifyCreateRequestRoute(request, this.#options.defaultAgent);
      } catch (error) {
        await this.#writer.json(rpcError(request, -32602, errorMessage(error)));
        continue;
      }
      if (createRoute) {
        this.#options.onCreateRequestRoute?.(createRoute);
        this.#options.onRequestRoute?.(
          this.#routeObservationTracker.registerCreate(
            request.id,
            createRoute,
            classifyThreadPurpose(request),
          ),
        );
      }
      if (createRoute && createRoute.selectedHarness !== "codex") {
        await this.#startExternalThread(request, createRoute.selectedHarness);
        continue;
      }
      if (request.method === "thread/fork") {
        const params = isRecord(request.params) ? request.params : {};
        const resolution =
          typeof params.threadId === "string"
            ? await this.#resolveExternalThread(params.threadId)
            : ({ kind: "official" } as const);
        if (resolution.kind === "error") {
          await this.#writer.json(
            rpcError(request, resolution.error.code, resolution.error.message),
          );
          continue;
        }
        if (resolution.kind === "external") {
          let fork: DecodedThreadForkRequest;
          try {
            const decoded = decodeThreadForkRequest(request);
            if (!decoded) throw new Error("Expected thread/fork request");
            fork = decoded;
          } catch (error) {
            await this.#writer.json(rpcError(request, -32602, errorMessage(error)));
            continue;
          }
          await this.#forkExternalThread(request, resolution.thread, fork);
          continue;
        }
      }
      if (request.method === "turn/start") {
        const params = requestObject(request);
        const threadId = params.threadId;
        const resolution =
          typeof threadId === "string"
            ? await this.#resolveExternalThread(threadId)
            : ({ kind: "official" } as const);
        if (typeof threadId === "string") {
          this.#options.onRequestRoute?.(
            this.#routeObservationTracker.observeTurn(
              threadId,
              resolution.kind === "external" ? resolution.thread.harnessId : "codex",
            ),
          );
        }
        if (await this.#writeResolutionError(request, resolution)) continue;
        if (resolution.kind === "external") {
          await this.#startExternalTurn(request, resolution.thread);
          continue;
        }
      }
      if (request.method === "turn/interrupt") {
        const params = requestObject(request);
        const resolution =
          typeof params.threadId === "string"
            ? await this.#resolveExternalThread(params.threadId)
            : ({ kind: "official" } as const);
        if (await this.#writeResolutionError(request, resolution)) continue;
        if (resolution.kind === "external") {
          await this.#interruptExternalTurn(request, resolution.thread, params.turnId);
          continue;
        }
      }
      if (request.method === "thread/read" || request.method === "thread/resume") {
        const params = requestObject(request);
        const resolution =
          typeof params.threadId === "string"
            ? await this.#resolveExternalThread(params.threadId)
            : ({ kind: "official" } as const);
        if (await this.#writeResolutionError(request, resolution)) continue;
        if (resolution.kind === "external") {
          if (request.method === "thread/read") {
            await this.#readExternalThread(
              request,
              resolution.thread,
              params.includeTurns === true,
            );
          } else {
            await this.#resumeExternalThread(request, resolution.thread, params);
          }
          continue;
        }
      }
      if (request.method === "thread/name/set" || request.method === "thread/delete") {
        const params = requestObject(request);
        const resolution =
          typeof params.threadId === "string"
            ? await this.#resolveExternalThread(params.threadId)
            : ({ kind: "official" } as const);
        if (await this.#writeResolutionError(request, resolution)) continue;
        if (resolution.kind === "external") {
          if (request.method === "thread/name/set") {
            await this.#setExternalThreadName(request, resolution.thread, params.name);
          } else {
            await this.#deleteExternalThread(request, resolution.thread);
          }
          continue;
        }
      }
      await writeFrame(official.stdin, frame);
    }
    official.stdin.end();
  }

  async #forwardOfficial(): Promise<void> {
    const official = this.#official;
    if (!official) throw new Error("official app-server is unavailable");
    for await (const frame of readLfFrames(official.stdout)) {
      const parsed = parseJsonFrame(frame);
      this.#routeObservationTracker.bindOfficialResponse(parsed);
      await this.#writer.frame(frame);
    }
  }

  async #inspectHarness(request: JsonRpcRequest): Promise<void> {
    const params = piHarnessInspectParamsSchema.safeParse(request.params);
    if (!params.success) {
      await this.#writer.json(rpcError(request, -32602, "Invalid Pi Harness inspection params"));
      return;
    }
    const adapter = this.#externalAdapters.get("pi");
    if (!adapter) {
      await this.#writer.json(rpcError(request, -32077, "Pi Harness is unavailable"));
      return;
    }
    let inspection: unknown;
    try {
      inspection = await adapter.inspect({
        ...(params.data.cwd ? { cwd: params.data.cwd } : {}),
        ...(params.data.refresh !== undefined ? { refresh: params.data.refresh } : {}),
      });
    } catch (error) {
      await this.#writer.json(
        rpcError(request, -32077, `Pi Harness inspection failed: ${errorMessage(error)}`),
      );
      return;
    }
    const validated = harnessInspectionSchema.safeParse(inspection);
    if (!validated.success) {
      await this.#writer.json(
        rpcError(request, -32077, "Pi Harness inspection returned an invalid result"),
      );
      return;
    }
    await this.#writer.json(
      rpcEnvelope(request, { result: jsonValueSchema.parse(validated.data) }),
    );
  }

  async #inspectThread(request: JsonRpcRequest): Promise<void> {
    const params = threadInspectionParamsSchema.safeParse(request.params);
    if (!params.success) {
      await this.#writer.json(rpcError(request, -32602, "Invalid Thread inspection params"));
      return;
    }
    const resolution = await this.#resolveExternalThread(params.data.threadId);
    if (resolution.kind === "error") {
      await this.#writer.json(rpcError(request, resolution.error.code, resolution.error.message));
      return;
    }
    const inspection = threadInspectionSchema.parse(
      resolution.kind === "official"
        ? { owner: "codex", locked: true }
        : {
            owner: "external",
            harnessId: resolution.thread.harnessId,
            transportModelId: resolution.thread.transportModelId,
            ...(resolution.thread.stateObserver.state.effectiveModel
              ? { effectiveModel: resolution.thread.stateObserver.state.effectiveModel }
              : {}),
            locked: true,
          },
    );
    await this.#writer.json(rpcEnvelope(request, { result: jsonValueSchema.parse(inspection) }));
  }

  async #selectPiThreadModel(request: JsonRpcRequest): Promise<void> {
    const params = threadModelSelectParamsSchema.safeParse(request.params);
    if (!params.success) {
      await this.#writer.json(rpcError(request, -32602, "Invalid Pi Model selection params"));
      return;
    }
    const resolution = await this.#resolveExternalThread(params.data.threadId);
    if (resolution.kind === "error") {
      await this.#writer.json(rpcError(request, resolution.error.code, resolution.error.message));
      return;
    }
    const thread = resolution.kind === "external" ? resolution.thread : undefined;
    if (!thread || thread.harnessId !== "pi") {
      await this.#writer.json(
        rpcError(request, -32078, "Model selection requires a current-process Pi Thread"),
      );
      return;
    }
    const beforeRevision = thread.stateObserver.revision;
    const result = await thread.session.execute({
      type: "model.select",
      model: params.data.model,
    });
    if (!result.ok) {
      await this.#writer.json(rpcError(request, -32078, result.error.message));
      return;
    }
    try {
      const state = await thread.stateObserver.waitForChange(beforeRevision);
      const projected = harnessModelSelectionStateSchema.parse({
        ...(state.effectiveModel ? { effectiveModel: state.effectiveModel } : {}),
      });
      if (!projected.effectiveModel) {
        throw new Error("Pi Session did not report an effective Model");
      }
      await this.#writer.json(rpcEnvelope(request, { result: jsonValueSchema.parse(projected) }));
    } catch (error) {
      await this.#writer.json(
        rpcError(request, -32078, `Pi Model state was not confirmed: ${errorMessage(error)}`),
      );
    }
  }

  async #startExternalThread(request: JsonRpcRequest, harnessId: ExternalHarnessId): Promise<void> {
    const adapter = this.#externalAdapters.get(harnessId);
    if (!adapter) {
      this.#routeObservationTracker.rejectCreate(request.id);
      await this.#writer.json(
        rpcError(request, -32070, `External Harness '${harnessId}' is unavailable`),
      );
      return;
    }
    const params = requestObject(request);
    const route = decodeCreateRoute(request);
    const requestedModel = route?.harnessId === "pi" ? route.model : undefined;
    const transportModelId =
      route && route.harnessId === harnessId
        ? route.transportModelId
        : transportModelIdForHarness(harnessId);
    const cwd = params.cwd;
    if (typeof cwd !== "string" || cwd.length === 0) {
      this.#routeObservationTracker.rejectCreate(request.id);
      await this.#writer.json(
        rpcError(request, -32602, `External Harness '${harnessId}' thread/start requires cwd`),
      );
      return;
    }

    const recordInput = createExternalThreadRecordInput({
      harnessId: adapter.harnessId,
      cwd,
      transportModelId,
      ephemeral: params.ephemeral === true,
      historyMode: params.historyMode === "paginated" ? "paginated" : "legacy",
    });
    let record: StoredThreadRecordV1;
    try {
      record = await this.#repository.createProvisional(recordInput);
    } catch {
      this.#routeObservationTracker.rejectCreate(request.id);
      await this.#writer.json(rpcError(request, -32081, "External Thread could not be persisted"));
      return;
    }

    const sessionResult = await adapter.open({
      kind: "create",
      cwd,
      ...(requestedModel ? { model: requestedModel } : {}),
    });
    if (!sessionResult.ok) {
      this.#routeObservationTracker.rejectCreate(request.id);
      await this.#repository.removeProvisional(record.hostThreadId).catch(() => undefined);
      const mapped = mapExternalThreadHarnessError(sessionResult.error, "create");
      await this.#writer.json(rpcError(request, mapped.code, mapped.message));
      return;
    }
    const session = sessionResult.value;
    try {
      if (session.initialState.nativeRef) {
        record = await this.#repository.commitNative(
          record.hostThreadId,
          session.initialState.nativeRef,
        );
      }
      const thread = externalThreadValue({
        record,
        turns: [],
        sessionId: record.hostThreadId,
      });
      const externalThread = this.#registerExternalThread({
        record,
        session,
        sessionId: record.hostThreadId,
        thread,
        turns: [],
        ...(requestedModel ? { requestedModel } : {}),
      });
      this.#routeObservationTracker.bindCreatedThread(request.id, externalThread.id);
      await this.#writer.json(
        rpcEnvelope(request, {
          result: {
            thread,
            model: transportModelId,
            modelProvider: "codexhost",
            cwd,
            approvalPolicy:
              typeof params.approvalPolicy === "string" ? params.approvalPolicy : "never",
            approvalsReviewer: "user",
            sandbox: sandboxResult(params),
            reasoningEffort: "medium",
            serviceTier: "default",
            multiAgentMode: "explicitRequestOnly",
            activePermissionProfile: null,
            runtimeWorkspaceRoots: Array.isArray(params.runtimeWorkspaceRoots)
              ? params.runtimeWorkspaceRoots
              : [],
            instructionSources: [],
          },
        }),
      );
      await this.#writer.json({
        method: "thread/started",
        emittedAtMs: Date.now(),
        params: { thread },
      });
    } catch {
      this.#externalRuntime.remove(record.hostThreadId);
      this.#routeObservationTracker.forgetThread(record.hostThreadId);
      await session.close().catch(() => undefined);
      await this.#repository.removeProvisional(record.hostThreadId).catch(() => undefined);
      await this.#writer.json(rpcError(request, -32081, "External Thread could not be persisted"));
    }
  }

  #registerExternalThread(input: {
    record: StoredThreadRecordV1;
    session: HarnessSession;
    sessionId: string;
    thread: JsonObject;
    turns: JsonObject[];
    requestedModel?: HarnessModelRef;
  }): ExternalThread {
    return this.#externalRuntime.register(input);
  }

  #resolveExternalThread(threadId: string): Promise<ExternalThreadResolution> {
    return this.#externalRuntime.resolve(threadId);
  }

  async #writeResolutionError(
    request: JsonRpcRequest,
    resolution: ExternalThreadResolution,
  ): Promise<boolean> {
    if (resolution.kind !== "error") return false;
    await this.#writer.json(rpcError(request, resolution.error.code, resolution.error.message));
    return true;
  }

  #refreshExternalThread(thread: ExternalThread): Promise<ExternalThreadRpcError | null> {
    return this.#externalRuntime.refresh(thread);
  }

  #persistTerminalIdentity(
    thread: ExternalThread,
    event: Parameters<ExternalThreadRuntime["persistTerminalIdentity"]>[1],
  ): Promise<Error | null> {
    return this.#externalRuntime.persistTerminalIdentity(thread, event);
  }

  async #forkExternalThread(
    request: JsonRpcRequest,
    source: ExternalThread,
    fork: DecodedThreadForkRequest,
  ): Promise<void> {
    const result = await executeExternalThreadFork({
      source,
      fork,
      adapters: this.#externalAdapters,
      repository: this.#repository,
      runtime: this.#externalRuntime,
    });
    if (!result.ok) {
      await this.#writer.json(rpcError(request, result.error.code, result.error.message));
      return;
    }
    const params: JsonObject = {
      ...(fork.sandbox ? { sandbox: fork.sandbox } : {}),
    };
    await this.#writer.json(
      rpcEnvelope(request, {
        result: threadForkResult(result.responseThread, {
          model: result.derived.transportModelId,
          cwd: result.derived.cwd,
          ...(fork.runtimeWorkspaceRoots
            ? { runtimeWorkspaceRoots: fork.runtimeWorkspaceRoots }
            : {}),
          ...(fork.approvalPolicy ? { approvalPolicy: fork.approvalPolicy } : {}),
          sandbox: sandboxResult(params),
          ...(fork.serviceTier ? { serviceTier: fork.serviceTier } : {}),
        }),
      }),
    );
    await this.#writer.json({
      method: "thread/started",
      emittedAtMs: Date.now(),
      params: { thread: { ...result.thread, turns: [] } },
    });
  }

  async #setExternalThreadName(
    request: JsonRpcRequest,
    thread: ExternalThread,
    name: JsonValue | undefined,
  ): Promise<void> {
    if (typeof name !== "string" || name.length === 0) {
      await this.#writer.json(
        rpcError(request, -32602, "External Thread name must be a non-empty string"),
      );
      return;
    }
    try {
      thread.record = await this.#repository.setTitle(thread.id, name);
    } catch {
      await this.#writer.json(
        rpcError(request, -32081, "External Thread title could not be persisted"),
      );
      return;
    }
    thread.thread.name = name;
    thread.thread.updatedAt = unixSeconds();
    await this.#writer.json(rpcEnvelope(request, { result: {} }));
    await this.#writer.json({
      method: "thread/name/updated",
      params: { threadId: thread.id, threadName: name },
    });
  }

  async #deleteExternalThread(request: JsonRpcRequest, thread: ExternalThread): Promise<void> {
    try {
      await this.#repository.removeThread(thread.id);
    } catch {
      await this.#writer.json(rpcError(request, -32081, "External Thread could not be removed"));
      return;
    }
    this.#externalRuntime.remove(thread.id);
    this.#routeObservationTracker.forgetThread(thread.id);
    thread.stateObserver.fault(new Error("External Thread was deleted"));
    try {
      await thread.session.close();
      await thread.outputTask;
      await this.#writer.json(rpcEnvelope(request, { result: {} }));
    } catch (error) {
      await this.#writer.json(
        rpcError(request, -32075, `External Thread could not close: ${errorMessage(error)}`),
      );
    }
  }

  async #readExternalThread(
    request: JsonRpcRequest,
    thread: ExternalThread,
    includeTurns: boolean,
  ): Promise<void> {
    if (includeTurns && !thread.running) {
      const refreshed = await this.#refreshExternalThread(thread);
      if (refreshed) {
        await this.#writer.json(rpcError(request, refreshed.code, refreshed.message));
        return;
      }
    }
    await this.#writer.json(
      rpcEnvelope(request, {
        result: {
          thread: {
            ...thread.thread,
            turns: includeTurns ? thread.turns : [],
          },
        },
      }),
    );
  }

  async #resumeExternalThread(
    request: JsonRpcRequest,
    thread: ExternalThread,
    params: JsonObject,
  ): Promise<void> {
    if (!thread.running) {
      const refreshed = await this.#refreshExternalThread(thread);
      if (refreshed) {
        await this.#writer.json(rpcError(request, refreshed.code, refreshed.message));
        return;
      }
    }
    const result = threadForkResult(thread.thread, {
      model: thread.transportModelId,
      cwd: thread.cwd,
      runtimeWorkspaceRoots: Array.isArray(params.runtimeWorkspaceRoots)
        ? params.runtimeWorkspaceRoots.filter((value): value is string => typeof value === "string")
        : [],
      approvalPolicy: typeof params.approvalPolicy === "string" ? params.approvalPolicy : "never",
      sandbox: sandboxResult(params),
      ...(typeof params.serviceTier === "string" ? { serviceTier: params.serviceTier } : {}),
    });
    await this.#writer.json(
      rpcEnvelope(request, {
        result: {
          ...result,
          initialTurnsPage: null,
          turnsBackwardsCursor: null,
          itemsBackwardsCursor: null,
        },
      }),
    );
  }

  async #startExternalTurn(request: JsonRpcRequest, thread: ExternalThread): Promise<void> {
    if (thread.running) {
      await this.#writer.json(
        rpcError(request, -32072, "External Thread already has an active Turn"),
      );
      return;
    }
    const params = requestObject(request);
    let requestedModel: HarnessModelRef | null | undefined;
    try {
      requestedModel = thread.harnessId === "pi" ? decodePiTransportModel(params.model) : null;
    } catch (error) {
      await this.#writer.json(rpcError(request, -32602, errorMessage(error)));
      return;
    }
    if (requestedModel) {
      const current = thread.stateObserver.state.effectiveModel;
      const pendingCreateSelection =
        current === undefined && thread.requestedModel?.id === requestedModel.id;
      if (current?.id !== requestedModel.id && !pendingCreateSelection) {
        const beforeRevision = thread.stateObserver.revision;
        const selection = await thread.session.execute({
          type: "model.select",
          model: requestedModel,
        });
        if (!selection.ok) {
          await this.#writer.json(rpcError(request, -32078, selection.error.message));
          return;
        }
        try {
          const state = await thread.stateObserver.waitForChange(beforeRevision);
          if (state.effectiveModel?.id !== requestedModel.id) {
            throw new Error("Pi Session activated a different Model");
          }
        } catch (error) {
          await this.#writer.json(rpcError(request, -32078, errorMessage(error)));
          return;
        }
      }
      thread.transportModelId = params.model as string;
      thread.requestedModel = requestedModel;
    }
    let text: string;
    try {
      text = requestText(params);
    } catch (error) {
      await this.#writer.json(rpcError(request, -32602, errorMessage(error)));
      return;
    }
    const turnId = hostTurnIdSchema.parse(randomUUID());
    const startedAtMs = Date.now();
    const projection: ProjectedTurn = {
      projector: new CodexTurnProjector({
        threadId: thread.id,
        turnId,
        cwd: thread.cwd,
        startedAtMs,
      }),
    };
    const gate = turnProjectionGate();
    thread.running = true;
    thread.activeTurnId = turnId;
    thread.projectedTurns.set(turnId, projection);
    thread.responseGates.set(turnId, gate);

    const result = await thread.session.execute({
      type: "turn.start",
      turnId,
      input: [{ type: "text", text }],
    });
    if (!result.ok) {
      thread.running = false;
      thread.activeTurnId = null;
      thread.projectedTurns.delete(turnId);
      thread.responseGates.delete(turnId);
      gate.resolve();
      await this.#writer.json(rpcError(request, -32073, result.error.message));
      return;
    }
    try {
      await this.#writer.json(
        rpcEnvelope(request, { result: { turn: projection.projector.pendingTurn() } }),
      );
    } finally {
      gate.resolve();
    }
  }

  async #interruptExternalTurn(
    request: JsonRpcRequest,
    thread: ExternalThread,
    requestedTurnId: JsonValue | undefined,
  ): Promise<void> {
    if (
      typeof requestedTurnId !== "string" ||
      !thread.running ||
      thread.activeTurnId !== requestedTurnId
    ) {
      await this.#writer.json(
        rpcError(request, -32074, "External turn/interrupt must reference the active Turn"),
      );
      return;
    }
    const turnId = thread.activeTurnId;
    const gate = turnProjectionGate();
    thread.responseGates.set(turnId, gate);
    const result = await thread.session.execute({ type: "turn.cancel", turnId });
    if (!result.ok) {
      gate.resolve();
      await this.#writer.json(rpcError(request, -32074, result.error.message));
      return;
    }
    try {
      await this.#writer.json(rpcEnvelope(request, { result: {} }));
    } finally {
      gate.resolve();
    }
  }

  async #consumeHarnessOutputs(thread: ExternalThread): Promise<void> {
    try {
      for await (const output of thread.session.outputs) {
        await this.#projectHarnessOutput(thread, output);
      }
    } catch (error) {
      this.#diagnose(error);
    }
  }

  async #projectHarnessOutput(thread: ExternalThread, output: HarnessOutput): Promise<void> {
    if (output.kind === "interaction") {
      await this.#projectQuestion(thread, output.interaction);
      return;
    }
    let event = output.event;
    if (event.type === "session.state.changed") {
      try {
        if (event.state.nativeRef) {
          if (!thread.record.nativeSessionRef) {
            thread.record = await this.#repository.commitNative(thread.id, event.state.nativeRef);
          } else if (
            thread.record.nativeSessionRef.harnessId !== event.state.nativeRef.harnessId ||
            thread.record.nativeSessionRef.nativeSessionId !== event.state.nativeRef.nativeSessionId
          ) {
            throw new Error("External Session changed Native identity");
          }
        }
        thread.stateObserver.update(event.state);
      } catch (error) {
        thread.persistenceError = error instanceof Error ? error : new Error(errorMessage(error));
        thread.stateObserver.fault(thread.persistenceError);
        this.#diagnose("External Session state could not be persisted");
      }
      return;
    }
    if (event.type === "session.faulted") {
      thread.stateObserver.fault(new Error(event.error.message));
      this.#diagnose(`${thread.harnessId} Harness Session faulted: ${event.error.message}`);
      return;
    }

    const projection = this.#projectedTurn(thread, event.turnId);
    await this.#waitForTurnResponse(thread, event.turnId);
    if (
      event.type === "interaction.closed" &&
      thread.ignoredInteractionIds.delete(event.interactionId)
    ) {
      return;
    }
    if (event.type === "interaction.closed") {
      await this.#resolveDesktopQuestion(event.interactionId);
    }
    if (event.type === "turn.completed") {
      const persistenceError = await this.#persistTerminalIdentity(thread, event);
      if (persistenceError) {
        event = {
          type: "turn.completed",
          turnId: event.turnId,
          outcome: {
            status: "failed",
            error: {
              code: "internalError",
              message: "External Turn identity could not be persisted",
              retryable: false,
            },
          },
        };
      }
    }
    const result = projection.projector.project(event as ProjectableHostEvent);
    if (event.type === "turn.started") {
      await this.#setThreadStatus(thread, { type: "active", activeFlags: [] });
    }
    if (event.type === "turn.completed") {
      if (!result.completedTurn) throw new Error("Turn projector returned no completed Turn");
      const completedAt = Math.floor(Date.now() / 1000);
      thread.turns.push(result.completedTurn);
      thread.thread.updatedAt = completedAt;
      thread.thread.recencyAt = completedAt;
      thread.running = false;
      thread.activeTurnId = null;
      thread.projectedTurns.delete(event.turnId);
      thread.responseGates.delete(event.turnId);
    }
    for (const message of result.messages) await this.#writer.json(message);
    if (event.type === "turn.completed") {
      await this.#setThreadStatus(thread, { type: "idle" });
    }
  }

  async #projectQuestion(
    thread: ExternalThread,
    interaction: HostQuestionInteraction,
  ): Promise<void> {
    const projection = this.#projectedTurn(thread, interaction.turnId);
    await this.#waitForTurnResponse(thread, interaction.turnId);
    let result: CodexQuestionProjection;
    try {
      result = projection.projector.projectQuestion(
        interaction,
        hostItemIdSchema.parse(randomUUID()),
      );
    } catch (error) {
      this.#diagnose(error);
      thread.ignoredInteractionIds.add(interaction.interactionId);
      const cancelled = await thread.session.execute({
        type: "interaction.respond",
        interactionId: interaction.interactionId,
        response: { type: "question", answers: {}, cancelled: true },
      });
      if (!cancelled.ok) {
        thread.ignoredInteractionIds.delete(interaction.interactionId);
        this.#diagnose(`Unsupported Question cancellation failed: ${cancelled.error.message}`);
      }
      return;
    }
    for (const message of result.messages) await this.#writer.json(message);

    const requestId = this.#allocateQuestionRequestId();
    const expiresAtMs = interaction.expiresAt ? Date.parse(interaction.expiresAt) : Number.NaN;
    const timeoutMs = Number.isFinite(expiresAtMs) ? Math.max(0, expiresAtMs - Date.now()) : null;
    const pending: PendingDesktopQuestion = {
      thread,
      interaction,
      projection: result.questionRequest,
      timeout: null,
    };
    if (timeoutMs !== null) {
      pending.timeout = setTimeout(() => {
        void this.#cancelExpiredQuestion(requestId);
      }, timeoutMs);
    }
    this.#pendingDesktopQuestions.set(requestId, pending);
    try {
      await this.#writer.json({ id: requestId, ...result.questionRequest.request });
    } catch (error) {
      this.#retireDesktopQuestion(interaction.interactionId);
      await thread.session
        .execute({
          type: "interaction.respond",
          interactionId: interaction.interactionId,
          response: { type: "question", answers: {}, cancelled: true },
        })
        .catch(() => undefined);
      throw error;
    }
  }

  async #handleDesktopQuestionResponse(value: JsonValue): Promise<boolean> {
    if (!isRecord(value) || !isHostQuestionRequestId(value.id)) return false;
    const pending = this.#pendingDesktopQuestions.get(value.id);
    if (!pending) return true;
    this.#pendingDesktopQuestions.delete(value.id);
    if (pending.timeout) clearTimeout(pending.timeout);

    let response;
    try {
      response =
        "error" in value
          ? { type: "question" as const, answers: {}, cancelled: true as const }
          : pending.projection.parseResponse(value.result);
    } catch (error) {
      this.#diagnose(error);
      response = { type: "question" as const, answers: {}, cancelled: true as const };
    }
    const result = await pending.thread.session.execute({
      type: "interaction.respond",
      interactionId: pending.interaction.interactionId,
      response,
    });
    if (!result.ok && result.error.code !== "invalidState") {
      this.#diagnose(`Question response failed: ${result.error.message}`);
    }
    return true;
  }

  async #cancelExpiredQuestion(requestId: HostQuestionRequestId): Promise<void> {
    const pending = this.#pendingDesktopQuestions.get(requestId);
    if (!pending) return;
    await this.#resolveDesktopQuestion(pending.interaction.interactionId);
    const result = await pending.thread.session.execute({
      type: "interaction.respond",
      interactionId: pending.interaction.interactionId,
      response: { type: "question", answers: {}, cancelled: true },
    });
    if (!result.ok && result.error.code !== "invalidState") {
      this.#diagnose(`Question expiry failed: ${result.error.message}`);
    }
  }

  #retireDesktopQuestion(interactionId: HostInteractionId): void {
    for (const [requestId, pending] of this.#pendingDesktopQuestions) {
      if (pending.interaction.interactionId !== interactionId) continue;
      if (pending.timeout) clearTimeout(pending.timeout);
      this.#pendingDesktopQuestions.delete(requestId);
    }
  }

  async #resolveDesktopQuestion(interactionId: HostInteractionId): Promise<void> {
    for (const [requestId, pending] of this.#pendingDesktopQuestions) {
      if (pending.interaction.interactionId !== interactionId) continue;
      if (pending.timeout) clearTimeout(pending.timeout);
      this.#pendingDesktopQuestions.delete(requestId);
      await this.#writer.json({
        method: "serverRequest/resolved",
        params: { threadId: pending.thread.id, requestId },
      });
    }
  }

  #allocateQuestionRequestId(): HostQuestionRequestId {
    if (this.#nextQuestionRequestId < HOST_QUESTION_REQUEST_ID_MIN) {
      throw new Error("Host Question Request ID namespace is exhausted");
    }
    const requestId = this.#nextQuestionRequestId;
    this.#nextQuestionRequestId -= 1;
    return requestId;
  }

  async #setThreadStatus(thread: ExternalThread, status: ExternalThreadStatus): Promise<void> {
    thread.thread.status = status;
    await this.#writer.json({
      method: "thread/status/changed",
      emittedAtMs: Date.now(),
      params: { threadId: thread.id, status },
    });
  }

  #projectedTurn(thread: ExternalThread, turnId: HostTurnId): ProjectedTurn {
    const projection = thread.projectedTurns.get(turnId);
    if (!projection) throw new Error("Harness output references an unknown Host Turn");
    return projection;
  }

  async #waitForTurnResponse(thread: ExternalThread, turnId: HostTurnId): Promise<void> {
    await thread.responseGates.get(turnId)?.promise;
  }

  #diagnose(error: unknown): void {
    this.#options.diagnosticOutput.write(`codexhost Host Runtime: ${errorMessage(error)}\n`);
  }
}
