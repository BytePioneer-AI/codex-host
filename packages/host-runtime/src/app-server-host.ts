import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";

import type {
  HarnessAdapter,
  HarnessOutput,
  HarnessSession,
  HostApprovalInteraction,
  HostApprovalResponse,
  HostQuestionInteraction,
} from "@codexhost/harness-adapter";
import type { StoredThreadRecordV1 } from "@codexhost/mapping-store";
import {
  accountCreditsSnapshotSchema,
  externalThreadForkParamsSchema,
  harnessCommandCatalogSchema,
  threadCommandExecuteParamsSchema,
  threadCommandExecuteResultSchema,
  threadCommandsInspectParamsSchema,
  externalThreadForkResultSchema,
  harnessInspectParamsSchema,
  harnessConfigurationStateSchema,
  harnessInspectionSchema,
  harnessModelSelectionStateSchema,
  hostItemIdSchema,
  hostTurnIdSchema,
  jsonValueSchema,
  threadInspectionParamsSchema,
  threadInspectionSchema,
  threadModelSelectParamsSchema,
  threadUsageInspectionParamsSchema,
  threadUsageInspectionSchema,
  threadPermissionModeSelectParamsSchema,
  threadThinkingSelectParamsSchema,
  threadOwnershipListParamsSchema,
  threadOwnershipListResultSchema,
  updateCheckResultSchema,
  updateEmptyParamsSchema,
  updateStartResultSchema,
  updateStatusResultSchema,
  type AccountCreditsSnapshot,
  type HarnessModelRef,
  type HarnessPermissionModeId,
  type HarnessThinkingOptionId,
  type HostInteractionId,
  type HostTurnId,
} from "@codexhost/shared-contracts";
import { executeExternalThreadFork } from "./external-thread-fork.js";
import {
  ExternalHistoryRequestError,
  listExternalItems,
  listExternalTurns,
} from "./external-thread-history.js";
import { executeExternalThreadRollback } from "./external-thread-rollback.js";
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
  type ExternalThreadLocation,
  type ExternalThreadResolution,
} from "./external-thread-runtime.js";
import { OfficialRequestBroker } from "./official-request-broker.js";
import type { HostUpdateCoordinator } from "./update-coordinator.js";
import {
  classifyThreadPurpose,
  RequestRouteObservationTracker,
  type CreateRequestRouteObservation,
  type RequestRouteObservation,
} from "./route-observation.js";
import {
  aggregateThreadList,
  officialThreadListPageFromResponse,
  OfficialThreadListError,
} from "./thread-list-aggregator.js";
import {
  CodexTurnProjector,
  decodeCreateRoute,
  decodeExternalTransportSelection,
  encodeExternalTransportSelection,
  decodeThreadArchiveRequest,
  decodeThreadForkRequest,
  decodeThreadListRequest,
  decodeThreadMetadataUpdateRequest,
  decodeThreadRollbackRequest,
  mapExternalThreadHarnessError,
  parseJsonFrame,
  projectCodexThreadUsage,
  readLfFrames,
  writeFrame,
  writeJsonFrame,
  jsonRpcRequestSchema,
  threadForkResult,
  threadRollbackResult,
  transportModelIdForHarness,
  type CodexApprovalProjection,
  type CodexQuestionProjection,
  type DecodedThreadForkRequest,
  type DecodedThreadListRequest,
  type DecodedThreadRollbackRequest,
  type ExternalThreadRpcError,
  type CodexApprovalRequestProjection,
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
  externalAdapters: ReadonlyMap<ExternalHarnessId, HarnessAdapter>;
  mappingStore?: ExternalThreadStore;
  spawnOfficial?: typeof spawn;
  onCreateRequestRoute?: (observation: CreateRequestRouteObservation) => void;
  onRequestRoute?: (observation: RequestRouteObservation) => void;
  updateCoordinator?: HostUpdateCoordinator;
}

interface TurnProjectionGate {
  promise: Promise<void>;
  resolve(): void;
}

interface ProjectedTurn {
  projector: CodexTurnProjector;
}

type HostApprovalRequestId = number;
type HostQuestionRequestId = number;

interface PendingDesktopApproval {
  thread: ExternalThread;
  interaction: HostApprovalInteraction;
  projection: CodexApprovalRequestProjection;
}

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

function isCreditsAdapter(adapter: HarnessAdapter): adapter is HarnessAdapter & {
  credits(): unknown;
  refreshCredits(): Promise<unknown>;
} {
  return (
    typeof (adapter as { credits?: unknown }).credits === "function" &&
    typeof (adapter as { refreshCredits?: unknown }).refreshCredits === "function"
  );
}

function projectAccountCredits(value: unknown): AccountCreditsSnapshot | null {
  if (!isRecord(value)) return null;
  const rest = { ...value };
  delete rest.fetchedAt;
  const parsed = accountCreditsSnapshotSchema.safeParse(rest);
  return parsed.success ? parsed.data : null;
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
    "CODEXHOST_LAUNCHER_PID",
    "CODEXHOST_LAUNCHER_EXECUTABLE",
    "CODEXHOST_RUNTIME_DESCRIPTOR_PATH",
    "CODEXHOST_CONTROL_PORT",
    "CODEXHOST_CONTROL_NONCE",
    "CODEXHOST_NPM_NODE_PATH",
    "CODEXHOST_NPM_CLI_PATH",
    "CODEXHOST_NPM_LAUNCHER_PATH",
    "CODEXHOST_NPM_PACKAGE_ROOT",
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

function approvalServerName(harnessId: ExternalHarnessId): string {
  switch (harnessId) {
    case "pi":
      return "Pi";
    case "claude-code":
      return "Claude Code";
    case "deepseek-harness":
      return "DeepSeek Harness";
    case "grok":
      return "Grok";
  }
}

const HOST_APPROVAL_REQUEST_ID_MIN = -2_000_000;
const HOST_APPROVAL_REQUEST_ID_MAX = -1_000_001;
const HOST_QUESTION_REQUEST_ID_MIN = -1_000_000;
const HOST_QUESTION_REQUEST_ID_MAX = -1;
const EXPLICIT_EXTERNAL_THREAD_METHODS = new Set([
  "thread/archive",
  "thread/delete",
  "thread/fork",
  "thread/items/list",
  "thread/metadata/update",
  "thread/name/set",
  "thread/read",
  "thread/resume",
  "thread/rollback",
  "thread/turns/list",
  "thread/unarchive",
  "thread/unsubscribe",
]);

function isHostApprovalRequestId(value: unknown): value is HostApprovalRequestId {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= HOST_APPROVAL_REQUEST_ID_MIN &&
    value <= HOST_APPROVAL_REQUEST_ID_MAX
  );
}

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
  #pendingDesktopApprovals = new Map<HostApprovalRequestId, PendingDesktopApproval>();
  #pendingDesktopQuestions = new Map<HostQuestionRequestId, PendingDesktopQuestion>();
  #nextApprovalRequestId = HOST_APPROVAL_REQUEST_ID_MAX;
  #nextQuestionRequestId = HOST_QUESTION_REQUEST_ID_MAX;
  #officialRequestBroker: OfficialRequestBroker;
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
    this.#officialRequestBroker = new OfficialRequestBroker({
      send: async (request) => {
        const official = this.#official;
        if (!official) throw new Error("official app-server is unavailable");
        await writeJsonFrame(official.stdin, request);
      },
    });
    this.#repository = new ExternalThreadRepository(
      options.mappingStore ??
        createProductionExternalThreadStore(this.#options.environment ?? process.env),
    );
    this.#externalAdapters = new Map(options.externalAdapters);
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
      for (const pending of [...this.#pendingDesktopApprovals.values()]) {
        await this.#resolveDesktopApproval(pending.interaction.interactionId).catch(
          () => undefined,
        );
      }
      for (const pending of [...this.#pendingDesktopQuestions.values()]) {
        await this.#resolveDesktopQuestion(pending.interaction.interactionId).catch(
          () => undefined,
        );
      }
      this.#officialRequestBroker.failAll(new Error("codexhost Host Runtime closed"));
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
      if (await this.#handleDesktopApprovalResponse(parsed)) continue;
      if (await this.#handleDesktopQuestionResponse(parsed)) continue;
      const requestResult = jsonRpcRequestSchema.safeParse(parsed);
      if (!requestResult.success) {
        await writeFrame(official.stdin, frame);
        continue;
      }
      const request = requestResult.data;
      if (
        request.method === "codexhost/update/check" ||
        request.method === "codexhost/update/start" ||
        request.method === "codexhost/update/status"
      ) {
        this.#dispatchDesktopRequest(() => this.#handleUpdateRequest(request));
        continue;
      }
      if (request.method === "codexhost/harness/inspect") {
        this.#dispatchDesktopRequest(() => this.#inspectHarness(request));
        continue;
      }
      if (request.method === "codexhost/thread/fork") {
        await this.#forkExternalThreadFromRenderer(request);
        continue;
      }
      if (request.method === "codexhost/thread/inspect") {
        await this.#inspectThread(request);
        continue;
      }
      if (request.method === "codexhost/thread/usage/inspect") {
        await this.#inspectThreadUsage(request);
        continue;
      }
      if (request.method === "codexhost/thread/ownership/list") {
        await this.#listThreadOwnership(request);
        continue;
      }
      if (request.method === "codexhost/thread/model/select") {
        await this.#selectThreadModel(request);
        continue;
      }
      if (request.method === "codexhost/thread/thinking/select") {
        await this.#selectThreadThinking(request);
        continue;
      }
      if (request.method === "codexhost/thread/permission-mode/select") {
        await this.#selectThreadPermissionMode(request);
        continue;
      }
      if (request.method === "codexhost/thread/commands/inspect") {
        await this.#inspectThreadCommands(request);
        continue;
      }
      if (request.method === "codexhost/thread/command/execute") {
        await this.#executeThreadCommand(request);
        continue;
      }
      if (request.method === "thread/list") {
        let listRequest: DecodedThreadListRequest;
        try {
          const decoded = decodeThreadListRequest(request);
          if (!decoded) throw new Error("Expected thread/list request");
          listRequest = decoded;
        } catch (error) {
          await this.#writer.json(rpcError(request, -32602, errorMessage(error)));
          continue;
        }
        if (!listRequest.supportsExternal) {
          await writeFrame(official.stdin, frame);
          continue;
        }
        this.#dispatchDesktopRequest(() => this.#listThreads(request, listRequest));
        continue;
      }
      if (request.method === "thread/archive" || request.method === "thread/unarchive") {
        let threadId: string;
        try {
          const decoded = decodeThreadArchiveRequest(request);
          if (!decoded) throw new Error(`Expected ${request.method} request`);
          threadId = decoded.threadId;
        } catch (error) {
          await this.#writer.json(rpcError(request, -32602, errorMessage(error)));
          continue;
        }
        const location = await this.#locateExternalThread(threadId);
        if (await this.#writeResolutionError(request, location)) continue;
        if (location.kind === "official") {
          await writeFrame(official.stdin, frame);
          continue;
        }
        if (location.kind === "external") {
          await this.#setExternalThreadArchived(
            request,
            location,
            request.method === "thread/archive",
          );
        }
        continue;
      }
      if (request.method === "thread/metadata/update") {
        let threadId: string;
        try {
          const decoded = decodeThreadMetadataUpdateRequest(request);
          if (!decoded) throw new Error("Expected thread/metadata/update request");
          threadId = decoded.threadId;
        } catch (error) {
          await this.#writer.json(rpcError(request, -32602, errorMessage(error)));
          continue;
        }
        const location = await this.#locateExternalThread(threadId);
        if (await this.#writeResolutionError(request, location)) continue;
        if (location.kind === "official") {
          await writeFrame(official.stdin, frame);
          continue;
        }
        await this.#writer.json(
          rpcError(request, -32078, "External Thread metadata updates are unsupported"),
        );
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
      if (request.method === "thread/rollback") {
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
          let rollback: DecodedThreadRollbackRequest;
          try {
            const decoded = decodeThreadRollbackRequest(request);
            if (!decoded) throw new Error("Expected thread/rollback request");
            rollback = decoded;
          } catch (error) {
            await this.#writer.json(rpcError(request, -32602, errorMessage(error)));
            continue;
          }
          await this.#rollbackExternalThread(request, resolution.thread, rollback);
          continue;
        }
      }
      if (request.method === "thread/turns/list" || request.method === "thread/items/list") {
        const params = requestObject(request);
        const resolution =
          typeof params.threadId === "string"
            ? await this.#resolveExternalThread(params.threadId)
            : ({ kind: "official" } as const);
        if (await this.#writeResolutionError(request, resolution)) continue;
        if (resolution.kind === "external") {
          await this.#listExternalHistory(
            request,
            resolution.thread,
            params,
            resolution.historyFresh,
          );
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
      if (request.method === "thread/read") {
        const params = requestObject(request);
        const location =
          typeof params.threadId === "string"
            ? await this.#locateExternalThread(params.threadId)
            : ({ kind: "official" } as const);
        if (location.kind === "error") {
          await this.#writer.json(rpcError(request, location.error.code, location.error.message));
          continue;
        }
        if (location.kind === "official") {
          await writeFrame(official.stdin, frame);
          continue;
        }
        if (params.includeTurns !== true) {
          await this.#readExternalThreadMetadata(request, location);
          continue;
        }
        if (location.record.historyMode === "paginated") {
          await this.#writer.json(
            rpcError(request, -32602, "Paginated External Threads require thread/turns/list"),
          );
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
              resolution.historyFresh,
            );
          } else {
            await this.#resumeExternalThread(
              request,
              resolution.thread,
              params,
              resolution.historyFresh,
            );
          }
          continue;
        }
      }
      if (request.method === "thread/unsubscribe") {
        const params = requestObject(request);
        if (typeof params.threadId === "string") {
          const location = await this.#locateExternalThread(params.threadId);
          if (await this.#writeResolutionError(request, location)) continue;
          if (location.kind === "official") {
            await writeFrame(official.stdin, frame);
            continue;
          }
          if (location.kind === "external") {
            await this.#writer.json(
              rpcEnvelope(request, {
                result: { status: location.thread ? "notSubscribed" : "notLoaded" },
              }),
            );
            continue;
          }
        }
      }
      if (request.method === "thread/name/set" || request.method === "thread/delete") {
        const params = requestObject(request);
        const location =
          typeof params.threadId === "string"
            ? await this.#locateExternalThread(params.threadId)
            : ({ kind: "official" } as const);
        if (await this.#writeResolutionError(request, location)) continue;
        if (location.kind === "external") {
          if (request.method === "thread/name/set") {
            await this.#setExternalThreadName(request, location, params.name);
          } else {
            await this.#deleteExternalThread(request, location);
          }
          continue;
        }
      }
      if (
        request.method.startsWith("thread/") &&
        !EXPLICIT_EXTERNAL_THREAD_METHODS.has(request.method) &&
        isRecord(request.params) &&
        typeof request.params.threadId === "string"
      ) {
        const location = await this.#locateExternalThread(request.params.threadId);
        if (await this.#writeResolutionError(request, location)) continue;
        if (location.kind === "external") {
          await this.#writer.json(
            rpcError(request, -32076, `External Thread does not support ${request.method}`),
          );
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
    try {
      for await (const frame of readLfFrames(official.stdout)) {
        const parsed = parseJsonFrame(frame);
        if (this.#officialRequestBroker.handle(parsed)) continue;
        this.#routeObservationTracker.bindOfficialResponse(parsed);
        await this.#writer.frame(frame);
      }
    } finally {
      this.#officialRequestBroker.failAll(new Error("official app-server output closed"));
    }
  }

  async #listThreads(
    request: JsonRpcRequest,
    listRequest: DecodedThreadListRequest,
  ): Promise<void> {
    try {
      const records = await this.#repository.list();
      const result = await aggregateThreadList({
        query: listRequest,
        records,
        runtimeFor: (threadId) => {
          const thread = this.#externalRuntime.get(threadId);
          return thread ? { running: thread.running } : null;
        },
        requestOfficialPage: async (params) =>
          officialThreadListPageFromResponse(
            await this.#officialRequestBroker.request("thread/list", params),
          ),
      });
      await this.#writer.json(rpcEnvelope(request, { result }));
    } catch (error) {
      if (error instanceof OfficialThreadListError) {
        await this.#writer.json(rpcEnvelope(request, { error: error.rpcError }));
        return;
      }
      await this.#writer.json(rpcError(request, -32082, "Thread list aggregation failed"));
      this.#diagnose(error);
    }
  }

  async #setExternalThreadArchived(
    request: JsonRpcRequest,
    location: Extract<ExternalThreadLocation, { kind: "external" }>,
    archived: boolean,
  ): Promise<void> {
    if (location.record.state !== "ready" || !location.record.nativeSessionRef) {
      await this.#writer.json(rpcError(request, -32079, "External Native Session is unavailable"));
      return;
    }
    const sessionId =
      location.thread?.sessionId ??
      (await this.#repository.sessionTreeId(location.record).catch(() => null));
    if (!sessionId) {
      await this.#writer.json(
        rpcError(request, -32081, "External Thread metadata could not be projected"),
      );
      return;
    }
    let record: StoredThreadRecordV1;
    try {
      record = await this.#repository.setArchived(location.record.hostThreadId, archived);
    } catch {
      await this.#writer.json(
        rpcError(request, -32081, "External Thread archive state could not be persisted"),
      );
      return;
    }
    const projected = externalThreadValue({
      record,
      turns: [],
      sessionId,
      ...(location.thread ? { running: location.thread.running } : { loaded: false }),
    });
    if (location.thread) {
      location.thread.record = record;
      location.thread.thread = {
        ...location.thread.thread,
        ...projected,
        turns: location.thread.thread.turns ?? [],
      };
    }
    await this.#writer.json(
      rpcEnvelope(request, { result: archived ? {} : { thread: projected } }),
    );
    await this.#writer.json({
      method: archived ? "thread/archived" : "thread/unarchived",
      params: { threadId: record.hostThreadId },
    });
  }

  async #handleUpdateRequest(request: JsonRpcRequest): Promise<void> {
    const params = updateEmptyParamsSchema.safeParse(
      request.params === undefined ? {} : request.params,
    );
    if (!params.success) {
      await this.#writer.json(rpcError(request, -32602, "Update params must be empty"));
      return;
    }
    const coordinator = this.#options.updateCoordinator;
    if (!coordinator) {
      await this.#writer.json(rpcError(request, -32090, "Application updates are unavailable"));
      return;
    }
    try {
      if (request.method === "codexhost/update/check") {
        const result = updateCheckResultSchema.parse(await coordinator.check());
        await this.#writer.json(rpcEnvelope(request, { result: jsonValueSchema.parse(result) }));
        return;
      }
      if (request.method === "codexhost/update/status") {
        const result = updateStatusResultSchema.parse(await coordinator.status());
        await this.#writer.json(rpcEnvelope(request, { result: jsonValueSchema.parse(result) }));
        return;
      }
      const result = updateStartResultSchema.parse(await coordinator.start());
      await this.#writer.json(rpcEnvelope(request, { result: jsonValueSchema.parse(result) }));
    } catch (error) {
      await this.#writer.json(rpcError(request, -32091, errorMessage(error).slice(0, 500)));
    }
  }

  async #inspectHarness(request: JsonRpcRequest): Promise<void> {
    const params = harnessInspectParamsSchema.safeParse(request.params);
    if (!params.success) {
      await this.#writer.json(rpcError(request, -32602, "Invalid Harness inspection params"));
      return;
    }
    const registered = [...this.#externalAdapters].find(
      ([harnessId]) => harnessId === params.data.harnessId,
    );
    const adapter = registered?.[1];
    if (!adapter) {
      await this.#writer.json(
        rpcError(request, -32077, `Harness '${params.data.harnessId}' is unavailable`),
      );
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
        rpcError(request, -32077, `Harness inspection failed: ${errorMessage(error)}`),
      );
      return;
    }
    const validated = harnessInspectionSchema.safeParse(inspection);
    if (!validated.success) {
      await this.#writer.json(
        rpcError(request, -32077, "Harness inspection returned an invalid result"),
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
            ...(resolution.thread.stateObserver.state.resolvedModelLabel
              ? { resolvedModelLabel: resolution.thread.stateObserver.state.resolvedModelLabel }
              : {}),
            ...(resolution.thread.stateObserver.state.effectiveThinkingOptionId
              ? {
                  effectiveThinkingOptionId:
                    resolution.thread.stateObserver.state.effectiveThinkingOptionId,
                }
              : {}),
            ...(resolution.thread.stateObserver.state.availableThinkingOptions
              ? {
                  availableThinkingOptions:
                    resolution.thread.stateObserver.state.availableThinkingOptions,
                }
              : {}),
            ...(resolution.thread.stateObserver.state.effectivePermissionModeId
              ? {
                  effectivePermissionModeId:
                    resolution.thread.stateObserver.state.effectivePermissionModeId,
                }
              : {}),
            history: resolution.thread.session.capabilities.history,
            ...(resolution.thread.latestUsage ? { usage: resolution.thread.latestUsage } : {}),
            locked: true,
          },
    );
    await this.#writer.json(rpcEnvelope(request, { result: jsonValueSchema.parse(inspection) }));
  }

  async #inspectThreadUsage(request: JsonRpcRequest): Promise<void> {
    const params = threadUsageInspectionParamsSchema.safeParse(request.params);
    if (!params.success) {
      await this.#writer.json(rpcError(request, -32602, "Invalid Thread Usage inspection params"));
      return;
    }
    const resolution = await this.#resolveExternalThread(params.data.threadId);
    if (resolution.kind === "error") {
      await this.#writer.json(rpcError(request, resolution.error.code, resolution.error.message));
      return;
    }
    if (resolution.kind === "official") {
      await this.#writer.json(
        rpcError(request, -32079, "Thread Usage is unavailable for official Codex Threads"),
      );
      return;
    }
    const adapter = this.#externalAdapters.get(resolution.thread.harnessId);
    if (adapter && isCreditsAdapter(adapter)) void adapter.refreshCredits();
    const credits =
      adapter && isCreditsAdapter(adapter) ? projectAccountCredits(adapter.credits()) : null;
    const result = threadUsageInspectionSchema.parse({
      threadId: params.data.threadId,
      usage: resolution.thread.latestUsage,
      ...(credits ? { accountCredits: credits } : {}),
    });
    await this.#writer.json(rpcEnvelope(request, { result: jsonValueSchema.parse(result) }));
  }

  async #listThreadOwnership(request: JsonRpcRequest): Promise<void> {
    const params = threadOwnershipListParamsSchema.safeParse(request.params);
    if (!params.success) {
      await this.#writer.json(rpcError(request, -32602, "Invalid Thread ownership-list params"));
      return;
    }
    try {
      const threads = await Promise.all(
        params.data.threadIds.map(async (threadId) => {
          const record = await this.#repository.find(threadId);
          return record
            ? { threadId, owner: "external" as const, harnessId: record.harnessId }
            : { threadId, owner: "codex" as const };
        }),
      );
      const result = threadOwnershipListResultSchema.parse({ threads });
      await this.#writer.json(rpcEnvelope(request, { result: jsonValueSchema.parse(result) }));
    } catch {
      await this.#writer.json(
        rpcError(request, -32081, "Thread ownership metadata could not be read"),
      );
    }
  }

  async #inspectThreadCommands(request: JsonRpcRequest): Promise<void> {
    const params = threadCommandsInspectParamsSchema.safeParse(request.params);
    if (!params.success) {
      await this.#writer.json(
        rpcError(request, -32602, "Invalid Thread command inspection params"),
      );
      return;
    }
    const resolution = await this.#resolveExternalThread(params.data.threadId);
    if (await this.#writeResolutionError(request, resolution)) return;
    if (resolution.kind !== "external" || !resolution.thread.session.commands) {
      await this.#writer.json(rpcEnvelope(request, { result: { commands: [] } }));
      return;
    }
    const result = await resolution.thread.session.commands.list();
    if (!result.ok) {
      await this.#writer.json(rpcError(request, -32078, result.error.message));
      return;
    }
    try {
      await this.#writer.json(
        rpcEnvelope(request, {
          result: jsonValueSchema.parse(harnessCommandCatalogSchema.parse(result.value)),
        }),
      );
    } catch (error) {
      await this.#writer.json(
        rpcError(request, -32078, `Harness command catalog is invalid: ${errorMessage(error)}`),
      );
    }
  }

  async #executeThreadCommand(request: JsonRpcRequest): Promise<void> {
    const params = threadCommandExecuteParamsSchema.safeParse(request.params);
    if (!params.success) {
      await this.#writer.json(rpcError(request, -32602, "Invalid Thread command parameters"));
      return;
    }
    const resolution = await this.#resolveExternalThread(params.data.threadId);
    if (await this.#writeResolutionError(request, resolution)) return;
    if (resolution.kind !== "external") {
      await this.#writer.json(rpcError(request, -32078, "Thread is not externally owned"));
      return;
    }
    const thread = resolution.thread;
    if (thread.running) {
      await this.#writer.json(
        rpcError(request, -32072, "External Thread already has an active operation"),
      );
      return;
    }
    const commands = thread.session.commands;
    if (!commands) {
      await this.#writer.json(
        rpcError(request, -32078, "External Harness does not expose commands"),
      );
      return;
    }
    const catalog = await commands.list();
    if (!catalog.ok) {
      await this.#writer.json(rpcError(request, -32078, catalog.error.message));
      return;
    }
    if (!catalog.value.commands.some(({ id }) => id === params.data.commandId)) {
      await this.#writer.json(
        rpcError(
          request,
          -32078,
          `External Harness does not expose command '${params.data.commandId}'`,
        ),
      );
      return;
    }

    try {
      await this.#startExternalCommand(
        request,
        thread,
        params.data.commandId,
        params.data.arguments,
        params.data.turnId,
        "command",
      );
    } catch (error) {
      this.#diagnose(error);
      await this.#writer.json(
        rpcError(request, -32073, `External Harness command failed: ${errorMessage(error)}`),
      );
    }
  }

  async #startExternalCommand(
    request: JsonRpcRequest,
    thread: ExternalThread,
    commandId: string,
    arguments_: JsonObject | undefined,
    requestedTurnId: HostTurnId | undefined,
    responseKind: "command" | "turn",
  ): Promise<void> {
    const commands = thread.session.commands;
    if (!commands) {
      await this.#writer.json(
        rpcError(request, -32078, "External Harness does not expose commands"),
      );
      return;
    }
    if (thread.running) {
      await this.#writer.json(
        rpcError(request, -32072, "External Thread already has an active operation"),
      );
      return;
    }
    const turnId = requestedTurnId ?? hostTurnIdSchema.parse(randomUUID());
    const projection: ProjectedTurn = {
      projector: new CodexTurnProjector({
        threadId: thread.id,
        turnId,
        cwd: thread.cwd,
        startedAtMs: Date.now(),
      }),
    };
    const gate = turnProjectionGate();
    thread.running = true;
    thread.activeTurnId = turnId;
    thread.projectedTurns.set(turnId, projection);
    thread.responseGates.set(turnId, gate);
    thread.ephemeralTurnIds.add(turnId);

    let result: Awaited<ReturnType<NonNullable<HarnessSession["commands"]>["execute"]>>;
    try {
      result = await commands.execute({
        turnId,
        commandId,
        ...(arguments_ ? { arguments: arguments_ } : {}),
      });
    } catch (error) {
      thread.running = false;
      thread.activeTurnId = null;
      thread.projectedTurns.delete(turnId);
      thread.responseGates.delete(turnId);
      thread.ephemeralTurnIds.delete(turnId);
      gate.resolve();
      throw error;
    }
    if (!result.ok) {
      thread.running = false;
      thread.activeTurnId = null;
      thread.projectedTurns.delete(turnId);
      thread.responseGates.delete(turnId);
      thread.ephemeralTurnIds.delete(turnId);
      gate.resolve();
      await this.#writer.json(rpcError(request, -32073, result.error.message));
      return;
    }
    try {
      const response =
        responseKind === "command"
          ? jsonValueSchema.parse(threadCommandExecuteResultSchema.parse(result.value))
          : { turn: projection.projector.pendingTurn() };
      await this.#writer.json(rpcEnvelope(request, { result: response as JsonObject }));
    } finally {
      gate.resolve();
    }
  }

  async #selectThreadModel(request: JsonRpcRequest): Promise<void> {
    const params = threadModelSelectParamsSchema.safeParse(request.params);
    if (!params.success) {
      await this.#writer.json(rpcError(request, -32602, "Invalid Thread Model selection params"));
      return;
    }
    const resolution = await this.#resolveExternalThread(params.data.threadId);
    if (resolution.kind === "error") {
      await this.#writer.json(rpcError(request, resolution.error.code, resolution.error.message));
      return;
    }
    const thread = resolution.kind === "external" ? resolution.thread : undefined;
    if (!thread) {
      await this.#writer.json(
        rpcError(request, -32078, "Model selection requires a current-process external Thread"),
      );
      return;
    }
    if (!thread.session.capabilities.configuration.selectModel) {
      await this.#writer.json(
        rpcError(request, -32078, "External Harness does not support Model selection"),
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
        ...(state.resolvedModelLabel ? { resolvedModelLabel: state.resolvedModelLabel } : {}),
        ...(state.effectiveThinkingOptionId
          ? { effectiveThinkingOptionId: state.effectiveThinkingOptionId }
          : {}),
        ...(state.availableThinkingOptions
          ? { availableThinkingOptions: state.availableThinkingOptions }
          : {}),
        ...(state.effectivePermissionModeId
          ? { effectivePermissionModeId: state.effectivePermissionModeId }
          : {}),
      });
      if (!projected.effectiveModel) {
        throw new Error("Harness Session did not report an effective Model");
      }
      await this.#writer.json(rpcEnvelope(request, { result: jsonValueSchema.parse(projected) }));
    } catch (error) {
      await this.#writer.json(
        rpcError(request, -32078, `Model state was not confirmed: ${errorMessage(error)}`),
      );
    }
  }

  async #selectThreadThinking(request: JsonRpcRequest): Promise<void> {
    const params = threadThinkingSelectParamsSchema.safeParse(request.params);
    if (!params.success) {
      await this.#writer.json(
        rpcError(request, -32602, "Invalid Thread Thinking selection params"),
      );
      return;
    }
    const resolution = await this.#resolveExternalThread(params.data.threadId);
    if (resolution.kind === "error") {
      await this.#writer.json(rpcError(request, resolution.error.code, resolution.error.message));
      return;
    }
    const thread = resolution.kind === "external" ? resolution.thread : undefined;
    if (!thread) {
      await this.#writer.json(
        rpcError(request, -32078, "Thinking selection requires a current-process external Thread"),
      );
      return;
    }
    if (!thread.session.capabilities.configuration.selectThinkingOption) {
      await this.#writer.json(
        rpcError(request, -32078, "External Harness does not support Thinking selection"),
      );
      return;
    }
    const beforeRevision = thread.stateObserver.revision;
    const result = await thread.session.execute({
      type: "thinking.select",
      thinkingOptionId: params.data.thinkingOptionId,
    });
    if (!result.ok) {
      await this.#writer.json(rpcError(request, -32078, result.error.message));
      return;
    }
    try {
      const state = await thread.stateObserver.waitForChange(beforeRevision);
      const projected = harnessModelSelectionStateSchema.parse({
        ...(state.effectiveModel ? { effectiveModel: state.effectiveModel } : {}),
        ...(state.resolvedModelLabel ? { resolvedModelLabel: state.resolvedModelLabel } : {}),
        ...(state.effectiveThinkingOptionId
          ? { effectiveThinkingOptionId: state.effectiveThinkingOptionId }
          : {}),
        ...(state.availableThinkingOptions
          ? { availableThinkingOptions: state.availableThinkingOptions }
          : {}),
        ...(state.effectivePermissionModeId
          ? { effectivePermissionModeId: state.effectivePermissionModeId }
          : {}),
      });
      if (!projected.effectiveThinkingOptionId) {
        throw new Error("Harness Session did not report effective Thinking");
      }
      thread.requestedThinkingOptionId = projected.effectiveThinkingOptionId;
      const previousSelection = decodeExternalTransportSelection(
        thread.harnessId,
        thread.transportModelId,
      );
      const effectiveModel =
        projected.effectiveModel ?? thread.requestedModel ?? previousSelection?.model;
      if (effectiveModel) {
        const transportModelId = encodeExternalTransportSelection(thread.harnessId, {
          ...(previousSelection ?? {}),
          model: effectiveModel,
          thinkingOptionId: projected.effectiveThinkingOptionId,
        });
        thread.transportModelId = transportModelId;
        thread.requestedModel = effectiveModel;
        try {
          thread.record = await this.#repository.setTransportModelId(
            thread.record.hostThreadId,
            transportModelId,
          );
        } catch (error) {
          this.#diagnose(error);
        }
        thread.thread = externalThreadValue({
          record: { ...thread.record, transportModelId },
          turns: thread.turns,
          sessionId: thread.sessionId,
          running: thread.running,
        });
      }
      await this.#writer.json(rpcEnvelope(request, { result: jsonValueSchema.parse(projected) }));
    } catch (error) {
      await this.#writer.json(
        rpcError(request, -32078, `Thinking state was not confirmed: ${errorMessage(error)}`),
      );
    }
  }

  async #selectThreadPermissionMode(request: JsonRpcRequest): Promise<void> {
    const params = threadPermissionModeSelectParamsSchema.safeParse(request.params);
    if (!params.success) {
      await this.#writer.json(
        rpcError(request, -32602, "Invalid Thread Permission Mode selection params"),
      );
      return;
    }
    const resolution = await this.#resolveExternalThread(params.data.threadId);
    if (resolution.kind === "error") {
      await this.#writer.json(rpcError(request, resolution.error.code, resolution.error.message));
      return;
    }
    const thread = resolution.kind === "external" ? resolution.thread : undefined;
    if (!thread) {
      await this.#writer.json(
        rpcError(
          request,
          -32078,
          "Permission Mode selection requires a current-process external Thread",
        ),
      );
      return;
    }
    if (!thread.session.capabilities.configuration.selectPermissionMode) {
      await this.#writer.json(
        rpcError(request, -32078, "External Harness does not support Permission Mode selection"),
      );
      return;
    }
    const beforeRevision = thread.stateObserver.revision;
    const result = await thread.session.execute({
      type: "permissionMode.select",
      permissionModeId: params.data.permissionModeId,
    });
    if (!result.ok) {
      await this.#writer.json(rpcError(request, -32078, result.error.message));
      return;
    }
    try {
      const state = await thread.stateObserver.waitForChange(beforeRevision);
      const projected = harnessConfigurationStateSchema.parse({
        ...(state.effectiveModel ? { effectiveModel: state.effectiveModel } : {}),
        ...(state.resolvedModelLabel ? { resolvedModelLabel: state.resolvedModelLabel } : {}),
        ...(state.effectiveThinkingOptionId
          ? { effectiveThinkingOptionId: state.effectiveThinkingOptionId }
          : {}),
        ...(state.availableThinkingOptions
          ? { availableThinkingOptions: state.availableThinkingOptions }
          : {}),
        ...(state.effectivePermissionModeId
          ? { effectivePermissionModeId: state.effectivePermissionModeId }
          : {}),
      });
      if (!projected.effectivePermissionModeId) {
        throw new Error("Harness Session did not report its current Permission Mode");
      }
      thread.requestedPermissionModeId = projected.effectivePermissionModeId;
      const previousSelection = decodeExternalTransportSelection(
        thread.harnessId,
        thread.transportModelId,
      );
      const effectiveModel =
        projected.effectiveModel ?? thread.requestedModel ?? previousSelection?.model;
      if (effectiveModel) {
        const transportModelId = encodeExternalTransportSelection(thread.harnessId, {
          ...(previousSelection ?? {}),
          model: effectiveModel,
          permissionModeId: projected.effectivePermissionModeId,
        });
        thread.transportModelId = transportModelId;
        thread.requestedModel = effectiveModel;
        try {
          thread.record = await this.#repository.setTransportModelId(
            thread.record.hostThreadId,
            transportModelId,
          );
        } catch (error) {
          this.#diagnose(error);
        }
        thread.thread = externalThreadValue({
          record: { ...thread.record, transportModelId },
          turns: thread.turns,
          sessionId: thread.sessionId,
          running: thread.running,
        });
      }
      await this.#writer.json(rpcEnvelope(request, { result: jsonValueSchema.parse(projected) }));
    } catch (error) {
      await this.#writer.json(
        rpcError(
          request,
          -32078,
          `Permission Mode state was not confirmed: ${errorMessage(error)}`,
        ),
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
    const requestedModel = route && route.harnessId !== "codex" ? route.model : undefined;
    const requestedThinkingOptionId =
      route && route.harnessId !== "codex" ? route.thinkingOptionId : undefined;
    const requestedPermissionModeId =
      route && route.harnessId !== "codex" ? route.permissionModeId : undefined;
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
      ...(requestedThinkingOptionId ? { thinkingOptionId: requestedThinkingOptionId } : {}),
      ...(requestedPermissionModeId ? { permissionModeId: requestedPermissionModeId } : {}),
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
        ...(requestedThinkingOptionId ? { requestedThinkingOptionId } : {}),
        ...(requestedPermissionModeId ? { requestedPermissionModeId } : {}),
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
    requestedThinkingOptionId?: HarnessThinkingOptionId;
    requestedPermissionModeId?: HarnessPermissionModeId;
  }): ExternalThread {
    return this.#externalRuntime.register(input);
  }

  #locateExternalThread(threadId: string): Promise<ExternalThreadLocation> {
    return this.#externalRuntime.locate(threadId);
  }

  #resolveExternalThread(threadId: string): Promise<ExternalThreadResolution> {
    return this.#externalRuntime.resolve(threadId);
  }

  async #writeResolutionError(
    request: JsonRpcRequest,
    resolution: ExternalThreadLocation | ExternalThreadResolution,
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

  async #forkExternalThreadFromRenderer(request: JsonRpcRequest): Promise<void> {
    const parsed = externalThreadForkParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      await this.#writer.json(rpcError(request, -32602, "External Fork request is invalid"));
      return;
    }
    const resolution = await this.#resolveExternalThread(parsed.data.threadId);
    if (await this.#writeResolutionError(request, resolution)) return;
    if (resolution.kind !== "external") {
      await this.#writer.json(rpcError(request, -32078, "Thread is not externally owned"));
      return;
    }
    const result = await executeExternalThreadFork({
      source: resolution.thread,
      fork: {
        threadId: parsed.data.threadId,
        lastTurnId: parsed.data.lastTurnId,
        excludeTurns: true,
      },
      adapters: this.#externalAdapters,
      repository: this.#repository,
      runtime: this.#externalRuntime,
    });
    if (!result.ok) {
      await this.#writer.json(rpcError(request, result.error.code, result.error.message));
      return;
    }
    await this.#writer.json(
      rpcEnvelope(request, {
        result: externalThreadForkResultSchema.parse({ threadId: result.derived.id }),
      }),
    );
    await this.#notifyExternalThreadStarted(result.thread);
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
    await this.#notifyExternalThreadStarted(result.thread);
  }

  async #notifyExternalThreadStarted(thread: JsonObject): Promise<void> {
    await this.#writer.json({
      method: "thread/started",
      emittedAtMs: Date.now(),
      params: { thread: { ...thread, turns: [] } },
    });
  }

  async #rollbackExternalThread(
    request: JsonRpcRequest,
    derived: ExternalThread,
    rollback: DecodedThreadRollbackRequest,
  ): Promise<void> {
    const result = await executeExternalThreadRollback({
      derived,
      rollback,
      adapters: this.#externalAdapters,
      repository: this.#repository,
      runtime: this.#externalRuntime,
    });
    if (!result.ok) {
      await this.#writer.json(rpcError(request, result.error.code, result.error.message));
      return;
    }
    await this.#writer.json(rpcEnvelope(request, { result: threadRollbackResult(result.thread) }));
  }

  async #setExternalThreadName(
    request: JsonRpcRequest,
    location: Extract<ExternalThreadLocation, { kind: "external" }>,
    name: JsonValue | undefined,
  ): Promise<void> {
    if (typeof name !== "string" || name.length === 0) {
      await this.#writer.json(
        rpcError(request, -32602, "External Thread name must be a non-empty string"),
      );
      return;
    }
    let record: StoredThreadRecordV1;
    try {
      record = await this.#repository.setTitle(location.record.hostThreadId, name);
    } catch {
      await this.#writer.json(
        rpcError(request, -32081, "External Thread title could not be persisted"),
      );
      return;
    }
    if (location.thread) {
      location.thread.record = record;
      location.thread.thread.name = name;
      location.thread.thread.updatedAt = unixSeconds();
    }
    await this.#writer.json(rpcEnvelope(request, { result: {} }));
    await this.#writer.json({
      method: "thread/name/updated",
      params: { threadId: location.record.hostThreadId, threadName: name },
    });
  }

  async #deleteExternalThread(
    request: JsonRpcRequest,
    location: Extract<ExternalThreadLocation, { kind: "external" }>,
  ): Promise<void> {
    const thread = location.thread;
    try {
      await this.#repository.removeThread(location.record.hostThreadId);
    } catch {
      await this.#writer.json(rpcError(request, -32081, "External Thread could not be removed"));
      return;
    }
    this.#externalRuntime.remove(location.record.hostThreadId);
    this.#routeObservationTracker.forgetThread(location.record.hostThreadId);
    if (!thread) {
      await this.#writer.json(rpcEnvelope(request, { result: {} }));
      return;
    }
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

  async #readExternalThreadMetadata(
    request: JsonRpcRequest,
    location: Extract<ExternalThreadLocation, { kind: "external" }>,
  ): Promise<void> {
    try {
      const thread = location.thread
        ? { ...location.thread.thread, turns: [] }
        : externalThreadValue({
            record: location.record,
            turns: [],
            sessionId: await this.#repository.sessionTreeId(location.record),
          });
      await this.#writer.json(rpcEnvelope(request, { result: { thread } }));
      if (location.thread) await this.#replayExternalUsage(location.thread);
    } catch {
      await this.#writer.json(
        rpcError(request, -32081, "External Thread metadata could not be read"),
      );
    }
  }

  async #readExternalThread(
    request: JsonRpcRequest,
    thread: ExternalThread,
    includeTurns: boolean,
    historyFresh: boolean,
  ): Promise<void> {
    if (includeTurns && thread.record.historyMode === "paginated") {
      await this.#writer.json(
        rpcError(request, -32602, "Paginated External Threads require thread/turns/list"),
      );
      return;
    }
    if (includeTurns && !thread.running && !historyFresh) {
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
            turns: includeTurns ? this.#externalHistoryTurns(thread) : [],
          },
        },
      }),
    );
    await this.#replayExternalUsage(thread);
  }

  async #listExternalHistory(
    request: JsonRpcRequest,
    thread: ExternalThread,
    params: JsonObject,
    historyFresh: boolean,
  ): Promise<void> {
    const headPage = params.cursor === null || params.cursor === undefined;
    const requiresRefresh =
      request.method === "thread/turns/list" ||
      (request.method === "thread/items/list" && !thread.historyHydrated);
    if (!thread.running && !historyFresh && headPage && requiresRefresh) {
      const refreshed = await this.#refreshExternalThread(thread);
      if (refreshed) {
        await this.#writer.json(rpcError(request, refreshed.code, refreshed.message));
        return;
      }
    }
    try {
      const turns = this.#externalHistoryTurns(thread);
      const result =
        request.method === "thread/turns/list"
          ? listExternalTurns(turns, params)
          : listExternalItems(turns, params);
      await this.#writer.json(rpcEnvelope(request, { result }));
    } catch (error) {
      await this.#writer.json(
        rpcError(
          request,
          error instanceof ExternalHistoryRequestError ? -32602 : -32076,
          error instanceof ExternalHistoryRequestError
            ? error.message
            : "External Thread history projection failed",
        ),
      );
    }
  }

  async #resumeExternalThread(
    request: JsonRpcRequest,
    thread: ExternalThread,
    params: JsonObject,
    historyFresh: boolean,
  ): Promise<void> {
    if (!thread.running && !historyFresh) {
      const refreshed = await this.#refreshExternalThread(thread);
      if (refreshed) {
        await this.#writer.json(rpcError(request, refreshed.code, refreshed.message));
        return;
      }
    }
    const turns = this.#externalHistoryTurns(thread);
    const responseThread = {
      ...thread.thread,
      turns: params.excludeTurns === true ? [] : turns,
    };
    const result = threadForkResult(responseThread, {
      model: thread.transportModelId,
      cwd: thread.cwd,
      runtimeWorkspaceRoots: Array.isArray(params.runtimeWorkspaceRoots)
        ? params.runtimeWorkspaceRoots.filter((value): value is string => typeof value === "string")
        : [],
      approvalPolicy: typeof params.approvalPolicy === "string" ? params.approvalPolicy : "never",
      sandbox: sandboxResult(params),
      ...(typeof params.serviceTier === "string" ? { serviceTier: params.serviceTier } : {}),
    });
    try {
      if (
        params.initialTurnsPage !== undefined &&
        params.initialTurnsPage !== null &&
        !isRecord(params.initialTurnsPage)
      ) {
        throw new ExternalHistoryRequestError("initialTurnsPage must be an object");
      }
      const initialPageParams = isRecord(params.initialTurnsPage)
        ? (params.initialTurnsPage as JsonObject)
        : null;
      const initialTurnsPage = initialPageParams
        ? listExternalTurns(turns, initialPageParams)
        : null;
      const paginated = thread.record.historyMode === "paginated";
      const turnsBackwardsCursor = paginated
        ? listExternalTurns(turns, { limit: 1, itemsView: "notLoaded" }).backwardsCursor
        : null;
      const itemsBackwardsCursor = paginated
        ? listExternalItems(turns, { limit: 1, sortDirection: "desc" }).backwardsCursor
        : null;
      await this.#writer.json(
        rpcEnvelope(request, {
          result: {
            ...result,
            initialTurnsPage,
            turnsBackwardsCursor,
            itemsBackwardsCursor,
          },
        }),
      );
    } catch (error) {
      await this.#writer.json(
        rpcError(
          request,
          error instanceof ExternalHistoryRequestError ? -32602 : -32076,
          error instanceof ExternalHistoryRequestError
            ? error.message
            : "External Thread history projection failed",
        ),
      );
    }
  }

  #externalHistoryTurns(thread: ExternalThread): JsonObject[] {
    if (!thread.activeTurnId) return thread.turns;
    const active = thread.projectedTurns.get(thread.activeTurnId);
    return active ? [...thread.turns, active.projector.pendingTurn()] : thread.turns;
  }

  async #startExternalTurn(request: JsonRpcRequest, thread: ExternalThread): Promise<void> {
    if (thread.running) {
      await this.#writer.json(
        rpcError(request, -32072, "External Thread already has an active Turn"),
      );
      return;
    }
    const params = requestObject(request);
    if (typeof params.model === "string") {
      let route: ReturnType<typeof decodeCreateRoute>;
      try {
        route = decodeCreateRoute({ id: request.id, method: "thread/start", params });
      } catch (error) {
        await this.#writer.json(rpcError(request, -32602, errorMessage(error)));
        return;
      }
      if (route?.harnessId !== "codex" && route?.harnessId !== thread.harnessId) {
        await this.#writer.json(
          rpcError(request, -32602, "Turn Model carrier does not belong to the Thread Harness"),
        );
        return;
      }
    }
    let text: string;
    try {
      text = requestText(params);
    } catch (error) {
      await this.#writer.json(rpcError(request, -32602, errorMessage(error)));
      return;
    }
    if (thread.session.commands) {
      const catalog = await thread.session.commands.list();
      if (!catalog.ok) {
        await this.#writer.json(rpcError(request, -32073, catalog.error.message));
        return;
      }
      const matched = catalog.value.commands
        .toSorted((left, right) => right.invocation.length - left.invocation.length)
        .find((command) => {
          if (text === command.invocation) return true;
          return command.argumentMode === "text" && text.startsWith(`${command.invocation} `);
        });
      if (matched) {
        const argumentText = text.slice(matched.invocation.length).trimStart();
        try {
          await this.#startExternalCommand(
            request,
            thread,
            matched.id,
            argumentText.length > 0 ? { text: argumentText } : undefined,
            undefined,
            "turn",
          );
        } catch (error) {
          this.#diagnose(error);
          await this.#writer.json(
            rpcError(request, -32073, `External Harness command failed: ${errorMessage(error)}`),
          );
        }
        return;
      }
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
      if (output.interaction.type === "approval") {
        await this.#projectApproval(thread, output.interaction);
      } else {
        await this.#projectQuestion(thread, output.interaction);
      }
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
    if (event.type === "session.usage.changed") {
      if (this.#externalRuntime.get(thread.id) !== thread) return;
      thread.latestUsage = event.usage;
      if (event.usage === null) {
        thread.usageTurnId = null;
        return;
      }
      const turnId = event.observedForTurnId
        ? this.#isKnownExternalTurn(thread, event.observedForTurnId)
          ? event.observedForTurnId
          : null
        : (thread.activeTurnId ?? this.#latestCompletedTurnId(thread));
      thread.usageTurnId = turnId;
      if (turnId) await this.#writeExternalUsage(thread, turnId);
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
      await this.#resolveDesktopApproval(event.interactionId);
      await this.#resolveDesktopQuestion(event.interactionId);
    }
    const ephemeralTurn =
      event.type === "turn.completed" && thread.ephemeralTurnIds.has(event.turnId);
    if (event.type === "turn.completed" && !ephemeralTurn) {
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
      if (ephemeralTurn) {
        thread.ephemeralTurnIds.delete(event.turnId);
      } else {
        thread.turns.push(result.completedTurn);
        thread.thread.updatedAt = completedAt;
        thread.thread.recencyAt = completedAt;
      }
      thread.historyHydrated = false;
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

  async #projectApproval(
    thread: ExternalThread,
    interaction: HostApprovalInteraction,
  ): Promise<void> {
    const projection = this.#projectedTurn(thread, interaction.turnId);
    await this.#waitForTurnResponse(thread, interaction.turnId);
    let result: CodexApprovalProjection;
    try {
      result = projection.projector.projectApproval(
        interaction,
        approvalServerName(thread.harnessId),
      );
    } catch (error) {
      this.#diagnose(error);
      thread.ignoredInteractionIds.add(interaction.interactionId);
      const denied = await this.#denyApproval(thread, interaction);
      if (!denied) thread.ignoredInteractionIds.delete(interaction.interactionId);
      return;
    }
    for (const message of result.messages) await this.#writer.json(message);

    const requestId = this.#allocateApprovalRequestId();
    const pending: PendingDesktopApproval = {
      thread,
      interaction,
      projection: result.approvalRequest,
    };
    this.#pendingDesktopApprovals.set(requestId, pending);
    try {
      await this.#writer.json({ id: requestId, ...result.approvalRequest.request });
    } catch (error) {
      this.#pendingDesktopApprovals.delete(requestId);
      await this.#denyApproval(thread, interaction);
      throw error;
    }
  }

  async #handleDesktopApprovalResponse(value: JsonValue): Promise<boolean> {
    if (!isRecord(value) || !isHostApprovalRequestId(value.id)) return false;
    const pending = this.#pendingDesktopApprovals.get(value.id);
    if (!pending) return true;
    this.#pendingDesktopApprovals.delete(value.id);

    let response: HostApprovalResponse;
    try {
      response =
        "error" in value
          ? pending.projection.denyResponse
          : pending.projection.parseResponse(value.result);
    } catch (error) {
      this.#diagnose(error);
      response = pending.projection.denyResponse;
    }
    const result = await pending.thread.session.execute({
      type: "interaction.respond",
      interactionId: pending.interaction.interactionId,
      response,
    });
    if (!result.ok && result.error.code !== "invalidState") {
      this.#diagnose(`Approval response failed: ${result.error.message}`);
      const cancelled = await pending.thread.session.execute({
        type: "turn.cancel",
        turnId: pending.interaction.turnId,
      });
      if (!cancelled.ok && cancelled.error.code !== "invalidState") {
        this.#diagnose(`Approval fail-closed cancellation failed: ${cancelled.error.message}`);
      }
    }
    return true;
  }

  async #denyApproval(
    thread: ExternalThread,
    interaction: HostApprovalInteraction,
  ): Promise<boolean> {
    const denyActions = interaction.actions.filter(({ effect }) => effect === "deny");
    if (denyActions.length !== 1) {
      const cancelled = await thread.session.execute({
        type: "turn.cancel",
        turnId: interaction.turnId,
      });
      if (!cancelled.ok) {
        this.#diagnose(`Unsupported Approval cancellation failed: ${cancelled.error.message}`);
      }
      return cancelled.ok;
    }
    const action = denyActions[0];
    if (!action) return false;
    const denied = await thread.session.execute({
      type: "interaction.respond",
      interactionId: interaction.interactionId,
      response: { type: "approval", actionId: action.id },
    });
    if (!denied.ok) {
      this.#diagnose(`Unsupported Approval denial failed: ${denied.error.message}`);
    }
    return denied.ok;
  }

  async #resolveDesktopApproval(interactionId: HostInteractionId): Promise<void> {
    for (const [requestId, pending] of this.#pendingDesktopApprovals) {
      if (pending.interaction.interactionId !== interactionId) continue;
      this.#pendingDesktopApprovals.delete(requestId);
      await this.#writer.json({
        method: "serverRequest/resolved",
        params: { threadId: pending.thread.id, requestId },
      });
    }
  }

  #allocateApprovalRequestId(): HostApprovalRequestId {
    if (this.#nextApprovalRequestId < HOST_APPROVAL_REQUEST_ID_MIN) {
      throw new Error("Host Approval Request ID namespace is exhausted");
    }
    const requestId = this.#nextApprovalRequestId;
    this.#nextApprovalRequestId -= 1;
    return requestId;
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

  #latestCompletedTurnId(thread: ExternalThread): HostTurnId | null {
    const parsed = hostTurnIdSchema.safeParse(thread.turns.at(-1)?.id);
    return parsed.success ? parsed.data : null;
  }

  #isKnownExternalTurn(thread: ExternalThread, turnId: HostTurnId): boolean {
    return thread.projectedTurns.has(turnId) || thread.turns.some((turn) => turn.id === turnId);
  }

  async #replayExternalUsage(thread: ExternalThread): Promise<void> {
    const latestTurnId = this.#latestCompletedTurnId(thread);
    if (!latestTurnId || !thread.latestUsage) return;
    thread.usageTurnId = latestTurnId;
    await this.#writeExternalUsage(thread, latestTurnId);
  }

  async #writeExternalUsage(thread: ExternalThread, turnId: HostTurnId): Promise<void> {
    const usage = thread.latestUsage;
    if (!usage || this.#externalRuntime.get(thread.id) !== thread) return;
    const projection = projectCodexThreadUsage({ threadId: thread.id, turnId, usage });
    if (!projection) return;
    await this.#waitForTurnResponse(thread, turnId);
    if (
      this.#externalRuntime.get(thread.id) !== thread ||
      thread.latestUsage !== usage ||
      thread.usageTurnId !== turnId
    ) {
      return;
    }
    await this.#writer.json(projection);
  }

  #dispatchDesktopRequest(run: () => Promise<void>): void {
    void run().catch((error) => this.#diagnose(error));
  }

  #diagnose(error: unknown): void {
    this.#options.diagnosticOutput.write(`codexhost Host Runtime: ${errorMessage(error)}\n`);
  }
}
