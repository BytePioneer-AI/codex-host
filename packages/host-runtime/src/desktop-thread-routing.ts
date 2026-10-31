import {
  carriesHostThreadListCursor,
  decodeThreadArchiveRequest,
  decodeThreadForkRequest,
  decodeThreadListRequest,
  decodeThreadMetadataUpdateRequest,
  decodeThreadRevertRequest,
  decodeThreadRollbackRequest,
  decodeThreadSectionMoveRequest,
  type DecodedThreadForkRequest,
  type DecodedThreadListRequest,
  type DecodedThreadMetadataUpdateRequest,
  type DecodedThreadRevertRequest,
  type DecodedThreadRollbackRequest,
  type DecodedThreadSectionMoveRequest,
  type ExternalHarnessId,
  type JsonObject,
  type JsonRpcRequest,
  type JsonValue,
} from "@codexhost/protocol-core";
import {
  THREAD_QUESTIONS_LIST_METHOD,
  THREAD_QUESTION_RESPOND_METHOD,
  harnessCommandsInspectParamsSchema,
  type HarnessId,
} from "@codexhost/shared-contracts";

import {
  errorMessage,
  rpcEnvelope,
  rpcError,
  routingParams,
  type HostRequestOrigin,
} from "./desktop-rpc.js";
import { externalThreadEmptyOfficialResult } from "./external-thread-official-defaults.js";
import type {
  ExternalThread,
  ExternalThreadLocation,
  ExternalThreadResolution,
} from "./external-thread-runtime.js";
import {
  classifyCreateRequestRoute,
  classifyThreadPurpose,
  type CreateRequestRouteObservation,
  type RequestRouteObservation,
  type RequestRouteObservationTracker,
} from "./route-observation.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const EXPLICIT_EXTERNAL_THREAD_METHODS = new Set([
  "thread/archive",
  "thread/delete",
  "thread/fork",
  "thread/items/list",
  "thread/metadata/update",
  "thread/name/set",
  "thread/read",
  "thread/resume",
  "thread/revert",
  "thread/rollback",
  "thread/section/move",
  "thread/turns/list",
  "thread/unarchive",
  "thread/unsubscribe",
]);

type ExternalLocation = Extract<ExternalThreadLocation, { kind: "external" }>;

/** The Host state and Thread handlers that Desktop Thread routing dispatches to. */
export interface DesktopThreadRoutingHost {
  writeJson(value: JsonValue): Promise<void>;
  /** Detaches `run` so it answers `request`, keeping the Host's failure fallback. */
  dispatchReply(request: JsonRpcRequest, run: () => Promise<void>, threadId?: string): void;
  readonly routeCallbacks: {
    readonly onCreateRequestRoute?:
      ((observation: CreateRequestRouteObservation) => void) | undefined;
    readonly onRequestRoute?: ((observation: RequestRouteObservation) => void) | undefined;
  };
  readonly routeObservationTracker: RequestRouteObservationTracker;
  /** Native Turn starts awaiting their response, keyed by JSON-RPC request ID. */
  readonly pendingOfficialTurnStarts: Map<unknown, string>;
  locateExternalThread(threadId: string): Promise<ExternalThreadLocation>;
  resolveExternalThread(threadId: string): Promise<ExternalThreadResolution>;
  /** Answers the request when the Thread could not be resolved; returns whether it did. */
  writeResolutionError(
    request: JsonRpcRequest,
    resolution: ExternalThreadLocation | ExternalThreadResolution,
  ): Promise<boolean>;
  forwardOfficialRequest(request: JsonRpcRequest, frame: Buffer<ArrayBufferLike>): Promise<void>;
  startExternalThread(
    request: JsonRpcRequest,
    harnessId: ExternalHarnessId,
    origin: HostRequestOrigin,
  ): Promise<void>;
  forkExternalThreadFromRenderer(request: JsonRpcRequest): Promise<void>;
  inspectThread(request: JsonRpcRequest): Promise<void>;
  inspectThreadUsage(request: JsonRpcRequest): Promise<void>;
  listThreadOwnership(request: JsonRpcRequest): Promise<void>;
  inspectThreadSteering(request: JsonRpcRequest): Promise<void>;
  handleSharedQuestionRequest(request: JsonRpcRequest): Promise<void>;
  selectThreadModel(request: JsonRpcRequest): Promise<void>;
  selectThreadThinking(request: JsonRpcRequest): Promise<void>;
  selectThreadPermissionMode(request: JsonRpcRequest): Promise<void>;
  writeHarnessCommandCatalog(
    request: JsonRpcRequest,
    harnessId: HarnessId,
    cwd?: string,
    inspectedThreadId?: string,
  ): Promise<void>;
  inspectThreadCommands(request: JsonRpcRequest): Promise<void>;
  executeThreadCommand(request: JsonRpcRequest): Promise<void>;
  sendQueuedExternalTurnNow(request: JsonRpcRequest, thread: ExternalThread): Promise<void>;
  handleExternalQueueRequest(request: JsonRpcRequest, thread: ExternalThread): Promise<void>;
  listSectionThreads(
    request: JsonRpcRequest,
    frame: Buffer<ArrayBufferLike>,
    query: DecodedThreadListRequest,
    origin: HostRequestOrigin,
  ): Promise<void>;
  listThreads(
    request: JsonRpcRequest,
    listRequest: DecodedThreadListRequest,
    origin: HostRequestOrigin,
  ): Promise<void>;
  moveThreadSection(
    request: JsonRpcRequest,
    frame: Buffer<ArrayBufferLike>,
    move: DecodedThreadSectionMoveRequest,
  ): Promise<void>;
  setExternalThreadArchived(
    request: JsonRpcRequest,
    location: ExternalLocation,
    archived: boolean,
  ): Promise<void>;
  updateExternalThreadMetadata(
    request: JsonRpcRequest,
    location: ExternalLocation,
    update: DecodedThreadMetadataUpdateRequest,
  ): Promise<void>;
  forkExternalThread(
    request: JsonRpcRequest,
    source: ExternalThread,
    fork: DecodedThreadForkRequest,
  ): Promise<void>;
  revertExternalThread(
    request: JsonRpcRequest,
    thread: ExternalThread,
    revert: DecodedThreadRevertRequest,
  ): Promise<void>;
  rollbackExternalThread(
    request: JsonRpcRequest,
    derived: ExternalThread,
    rollback: DecodedThreadRollbackRequest,
  ): Promise<void>;
  listExternalHistory(
    request: JsonRpcRequest,
    thread: ExternalThread,
    params: JsonObject,
    historyFresh: boolean,
  ): Promise<void>;
  startExternalTurn(request: JsonRpcRequest, thread: ExternalThread): Promise<void>;
  steerExternalTurn(request: JsonRpcRequest, thread: ExternalThread): Promise<void>;
  interruptExternalTurn(
    request: JsonRpcRequest,
    thread: ExternalThread,
    requestedTurnId: JsonValue | undefined,
  ): Promise<void>;
  readExternalThreadMetadata(request: JsonRpcRequest, location: ExternalLocation): Promise<void>;
  readExternalThread(
    request: JsonRpcRequest,
    thread: ExternalThread,
    includeTurns: boolean,
    historyFresh: boolean,
  ): Promise<void>;
  resumeExternalThread(
    request: JsonRpcRequest,
    thread: ExternalThread,
    params: JsonObject,
    historyFresh: boolean,
  ): Promise<void>;
  setExternalThreadName(
    request: JsonRpcRequest,
    location: ExternalLocation,
    name: JsonValue | undefined,
  ): Promise<void>;
  deleteExternalThread(request: JsonRpcRequest, location: ExternalLocation): Promise<void>;
  cleanExternalBackgroundTerminals(request: JsonRpcRequest, threadId: string): Promise<void>;
}

/**
 * Routes Thread-scoped Desktop requests (`thread/*`, `turn/*`, `codexhost/thread/*`) to the
 * External Thread owner or leaves them to native Codex.
 */
export class DesktopThreadRouting {
  readonly #host: DesktopThreadRoutingHost;
  #sectionMoves: Promise<void> = Promise.resolve();

  constructor(host: DesktopThreadRoutingHost) {
    this.#host = host;
  }

  /** Returns false when native Codex should receive the request. */
  async handle(
    request: JsonRpcRequest,
    frame: Buffer<ArrayBufferLike>,
    origin: HostRequestOrigin,
  ): Promise<boolean> {
    if (request.method === "codexhost/thread/fork") {
      await this.#host.forkExternalThreadFromRenderer(request);
      return true;
    }
    if (request.method === "codexhost/thread/inspect") {
      await this.#host.inspectThread(request);
      return true;
    }
    if (request.method === "codexhost/thread/usage/inspect") {
      await this.#host.inspectThreadUsage(request);
      return true;
    }
    if (request.method === "codexhost/thread/ownership/list") {
      await this.#host.listThreadOwnership(request);
      return true;
    }
    if (
      request.method === THREAD_QUESTIONS_LIST_METHOD ||
      request.method === THREAD_QUESTION_RESPOND_METHOD
    ) {
      const threadId = routingParams(request).threadId;
      this.#host.dispatchReply(
        request,
        () => this.#host.handleSharedQuestionRequest(request),
        request.method === THREAD_QUESTION_RESPOND_METHOD && typeof threadId === "string"
          ? threadId
          : undefined,
      );
      return true;
    }
    if (request.method === "codexhost/thread/steering/inspect") {
      await this.#host.inspectThreadSteering(request);
      return true;
    }
    if (request.method === "codexhost/thread/model/select") {
      await this.#host.selectThreadModel(request);
      return true;
    }
    if (request.method === "codexhost/thread/thinking/select") {
      await this.#host.selectThreadThinking(request);
      return true;
    }
    if (request.method === "codexhost/thread/permission-mode/select") {
      await this.#host.selectThreadPermissionMode(request);
      return true;
    }
    if (request.method === "codexhost/harness/commands/inspect") {
      const params = harnessCommandsInspectParamsSchema.safeParse(request.params);
      if (!params.success) {
        await this.#host.writeJson(
          rpcError(request, -32602, "Invalid Harness command inspection params"),
        );
      } else {
        await this.#host.writeHarnessCommandCatalog(
          request,
          params.data.harnessId,
          params.data.cwd,
        );
      }
      return true;
    }
    if (request.method === "codexhost/thread/commands/inspect") {
      await this.#host.inspectThreadCommands(request);
      return true;
    }
    if (request.method === "codexhost/thread/command/execute") {
      await this.#host.executeThreadCommand(request);
      return true;
    }
    if (request.method === "codexhost/thread/queue/send-now") {
      const params = routingParams(request);
      const resolution =
        typeof params.threadId === "string"
          ? await this.#host.resolveExternalThread(params.threadId)
          : ({ kind: "official" } as const);
      if (await this.#host.writeResolutionError(request, resolution)) return true;
      if (resolution.kind !== "external") {
        await this.#host.writeJson(
          rpcError(request, -32078, "Thread is not owned by this external Host"),
        );
        return true;
      }
      this.#host.dispatchReply(
        request,
        () => this.#host.sendQueuedExternalTurnNow(request, resolution.thread),
        resolution.thread.id,
      );
      return true;
    }
    if (request.method.startsWith("thread/queue/")) {
      const params = routingParams(request);
      const resolution =
        typeof params.threadId === "string"
          ? await this.#host.resolveExternalThread(params.threadId)
          : ({ kind: "official" } as const);
      if (await this.#host.writeResolutionError(request, resolution)) return true;
      if (resolution.kind === "external") {
        this.#host.dispatchReply(
          request,
          () => this.#host.handleExternalQueueRequest(request, resolution.thread),
          resolution.thread.id,
        );
        return true;
      }
    }
    if (request.method === "thread/list") {
      let listRequest: DecodedThreadListRequest;
      try {
        const decoded = decodeThreadListRequest(request);
        if (!decoded) throw new Error("Expected thread/list request");
        listRequest = decoded;
      } catch (error) {
        // Only a Host cursor makes the list Host-owned. Any other shape is native Codex's to judge.
        if (carriesHostThreadListCursor(request)) {
          await this.#host.writeJson(rpcError(request, -32602, errorMessage(error)));
        } else {
          await this.#host.forwardOfficialRequest(request, frame);
        }
        return true;
      }
      if (
        !listRequest.supportsExternal ||
        (listRequest.sortKey === "section_position" && typeof listRequest.sectionId !== "string")
      ) {
        await this.#host.forwardOfficialRequest(request, frame);
        return true;
      }
      this.#host.dispatchReply(request, () =>
        listRequest.sortKey === "section_position"
          ? this.#host.listSectionThreads(request, frame, listRequest, origin)
          : this.#host.listThreads(request, listRequest, origin),
      );
      return true;
    }
    if (request.method === "thread/section/move") {
      let move: DecodedThreadSectionMoveRequest;
      try {
        const decoded = decodeThreadSectionMoveRequest(request);
        if (!decoded) throw new Error("Expected thread/section/move request");
        move = decoded;
      } catch (error) {
        // Either Thread may be External: the moved one or the one it is placed before.
        const params = routingParams(request);
        let external = false;
        for (const threadId of [params.threadId, params.beforeThreadId]) {
          if (typeof threadId !== "string") continue;
          const location = await this.#host.locateExternalThread(threadId);
          if (await this.#host.writeResolutionError(request, location)) return true;
          if (location.kind === "external") external = true;
        }
        if (external) {
          await this.#host.writeJson(rpcError(request, -32602, errorMessage(error)));
        } else {
          await this.#host.forwardOfficialRequest(request, frame);
        }
        return true;
      }
      // Moves read and rewrite one shared order, so they apply one at a time.
      const task = this.#sectionMoves.then(() =>
        this.#host.moveThreadSection(request, frame, move),
      );
      this.#sectionMoves = task.catch(() => undefined);
      this.#host.dispatchReply(request, () => task);
      return true;
    }
    if (request.method === "thread/archive" || request.method === "thread/unarchive") {
      const threadId = routingParams(request).threadId;
      const location =
        typeof threadId === "string"
          ? await this.#host.locateExternalThread(threadId)
          : ({ kind: "official" } as const);
      if (await this.#host.writeResolutionError(request, location)) return true;
      if (location.kind === "official") {
        await this.#host.forwardOfficialRequest(request, frame);
        return true;
      }
      if (location.kind === "external") {
        try {
          if (!decodeThreadArchiveRequest(request)) {
            throw new Error(`Expected ${request.method} request`);
          }
        } catch (error) {
          await this.#host.writeJson(rpcError(request, -32602, errorMessage(error)));
          return true;
        }
        await this.#host.setExternalThreadArchived(
          request,
          location,
          request.method === "thread/archive",
        );
      }
      return true;
    }
    if (request.method === "thread/metadata/update") {
      const threadId = routingParams(request).threadId;
      const location =
        typeof threadId === "string"
          ? await this.#host.locateExternalThread(threadId)
          : ({ kind: "official" } as const);
      if (await this.#host.writeResolutionError(request, location)) return true;
      if (location.kind === "official") {
        await this.#host.forwardOfficialRequest(request, frame);
        return true;
      }
      if (location.kind === "external") {
        let update: DecodedThreadMetadataUpdateRequest;
        try {
          const decoded = decodeThreadMetadataUpdateRequest(request);
          if (!decoded) throw new Error("Expected thread/metadata/update request");
          update = decoded;
        } catch (error) {
          await this.#host.writeJson(rpcError(request, -32602, errorMessage(error)));
          return true;
        }
        await this.#host.updateExternalThreadMetadata(request, location, update);
      }
      return true;
    }
    let createRoute: CreateRequestRouteObservation | null;
    try {
      createRoute = classifyCreateRequestRoute(request);
    } catch (error) {
      await this.#host.writeJson(rpcError(request, -32602, errorMessage(error)));
      return true;
    }
    if (createRoute) {
      this.#host.routeCallbacks.onCreateRequestRoute?.(createRoute);
      this.#host.routeCallbacks.onRequestRoute?.(
        this.#host.routeObservationTracker.registerCreate(
          request.id,
          createRoute,
          classifyThreadPurpose(request),
        ),
      );
    }
    if (createRoute && createRoute.selectedHarness !== "codex") {
      await this.#host.startExternalThread(request, createRoute.selectedHarness, origin);
      return true;
    }
    if (request.method === "thread/fork") {
      const params = isRecord(request.params) ? request.params : {};
      const resolution =
        typeof params.threadId === "string"
          ? await this.#host.resolveExternalThread(params.threadId)
          : ({ kind: "official" } as const);
      if (resolution.kind === "error") {
        await this.#host.writeJson(
          rpcError(request, resolution.error.code, resolution.error.message),
        );
        return true;
      }
      if (resolution.kind === "external") {
        let fork: DecodedThreadForkRequest;
        try {
          const decoded = decodeThreadForkRequest(request);
          if (!decoded) throw new Error("Expected thread/fork request");
          fork = decoded;
        } catch (error) {
          await this.#host.writeJson(rpcError(request, -32602, errorMessage(error)));
          return true;
        }
        await this.#host.forkExternalThread(request, resolution.thread, fork);
        return true;
      }
    }
    if (request.method === "thread/revert") {
      const params = isRecord(request.params) ? request.params : {};
      const resolution =
        typeof params.threadId === "string"
          ? await this.#host.resolveExternalThread(params.threadId)
          : ({ kind: "official" } as const);
      if (resolution.kind === "error") {
        await this.#host.writeJson(
          rpcError(request, resolution.error.code, resolution.error.message),
        );
        return true;
      }
      if (resolution.kind === "external") {
        let revert: DecodedThreadRevertRequest;
        try {
          const decoded = decodeThreadRevertRequest(request);
          if (!decoded) throw new Error("Expected thread/revert request");
          revert = decoded;
        } catch (error) {
          await this.#host.writeJson(rpcError(request, -32602, errorMessage(error)));
          return true;
        }
        await this.#host.revertExternalThread(request, resolution.thread, revert);
        return true;
      }
    }
    if (request.method === "thread/rollback") {
      const params = isRecord(request.params) ? request.params : {};
      const resolution =
        typeof params.threadId === "string"
          ? await this.#host.resolveExternalThread(params.threadId)
          : ({ kind: "official" } as const);
      if (resolution.kind === "error") {
        await this.#host.writeJson(
          rpcError(request, resolution.error.code, resolution.error.message),
        );
        return true;
      }
      if (resolution.kind === "external") {
        let rollback: DecodedThreadRollbackRequest;
        try {
          const decoded = decodeThreadRollbackRequest(request);
          if (!decoded) throw new Error("Expected thread/rollback request");
          rollback = decoded;
        } catch (error) {
          await this.#host.writeJson(rpcError(request, -32602, errorMessage(error)));
          return true;
        }
        await this.#host.rollbackExternalThread(request, resolution.thread, rollback);
        return true;
      }
    }
    if (request.method === "thread/turns/list" || request.method === "thread/items/list") {
      const params = routingParams(request);
      const resolution =
        typeof params.threadId === "string"
          ? await this.#host.resolveExternalThread(params.threadId)
          : ({ kind: "official" } as const);
      if (await this.#host.writeResolutionError(request, resolution)) return true;
      if (resolution.kind === "external") {
        await this.#host.listExternalHistory(
          request,
          resolution.thread,
          params,
          resolution.historyFresh,
        );
        return true;
      }
    }
    if (request.method === "turn/start") {
      const params = routingParams(request);
      const threadId = params.threadId;
      const resolution =
        typeof threadId === "string"
          ? await this.#host.resolveExternalThread(threadId)
          : ({ kind: "official" } as const);
      if (typeof threadId === "string") {
        this.#host.routeCallbacks.onRequestRoute?.(
          this.#host.routeObservationTracker.observeTurn(
            threadId,
            resolution.kind === "external" ? resolution.thread.harnessId : "codex",
          ),
        );
      }
      if (await this.#host.writeResolutionError(request, resolution)) return true;
      if (resolution.kind === "external") {
        this.#host.dispatchReply(
          request,
          () => this.#host.startExternalTurn(request, resolution.thread),
          resolution.thread.id,
        );
        return true;
      }
      if (typeof threadId === "string") {
        this.#host.pendingOfficialTurnStarts.set(request.id, threadId);
      }
    }
    if (request.method === "turn/steer") {
      const params = routingParams(request);
      const resolution =
        typeof params.threadId === "string"
          ? await this.#host.resolveExternalThread(params.threadId)
          : ({ kind: "official" } as const);
      if (await this.#host.writeResolutionError(request, resolution)) return true;
      if (resolution.kind === "external") {
        this.#host.dispatchReply(
          request,
          () => this.#host.steerExternalTurn(request, resolution.thread),
          resolution.thread.id,
        );
        return true;
      }
    }
    if (request.method === "turn/interrupt") {
      const params = routingParams(request);
      const resolution =
        typeof params.threadId === "string"
          ? await this.#host.resolveExternalThread(params.threadId)
          : ({ kind: "official" } as const);
      if (await this.#host.writeResolutionError(request, resolution)) return true;
      if (resolution.kind === "external") {
        await this.#host.interruptExternalTurn(request, resolution.thread, params.turnId);
        return true;
      }
    }
    if (request.method === "thread/read") {
      const params = routingParams(request);
      const location =
        typeof params.threadId === "string"
          ? await this.#host.locateExternalThread(params.threadId)
          : ({ kind: "official" } as const);
      if (location.kind === "error") {
        await this.#host.writeJson(rpcError(request, location.error.code, location.error.message));
        return true;
      }
      if (location.kind === "official") {
        await this.#host.forwardOfficialRequest(request, frame);
        return true;
      }
      if (params.includeTurns !== true) {
        await this.#host.readExternalThreadMetadata(request, location);
        return true;
      }
      if (location.record.historyMode === "paginated") {
        await this.#host.writeJson(
          rpcError(request, -32602, "Paginated External Threads require thread/turns/list"),
        );
        return true;
      }
    }
    if (request.method === "thread/read" || request.method === "thread/resume") {
      const params = routingParams(request);
      const resolution =
        typeof params.threadId === "string"
          ? await this.#host.resolveExternalThread(params.threadId)
          : ({ kind: "official" } as const);
      if (await this.#host.writeResolutionError(request, resolution)) return true;
      if (resolution.kind === "external") {
        if (request.method === "thread/read") {
          await this.#host.readExternalThread(
            request,
            resolution.thread,
            params.includeTurns === true,
            resolution.historyFresh,
          );
        } else {
          await this.#host.resumeExternalThread(
            request,
            resolution.thread,
            params,
            resolution.historyFresh,
          );
        }
        return true;
      }
    }
    if (request.method === "thread/unsubscribe") {
      const params = routingParams(request);
      if (typeof params.threadId === "string") {
        const location = await this.#host.locateExternalThread(params.threadId);
        if (await this.#host.writeResolutionError(request, location)) return true;
        if (location.kind === "official") {
          await this.#host.forwardOfficialRequest(request, frame);
          return true;
        }
        if (location.kind === "external") {
          await this.#host.writeJson(
            rpcEnvelope(request, {
              result: { status: location.thread ? "notSubscribed" : "notLoaded" },
            }),
          );
          return true;
        }
      }
    }
    if (request.method === "thread/name/set" || request.method === "thread/delete") {
      const params = routingParams(request);
      const location =
        typeof params.threadId === "string"
          ? await this.#host.locateExternalThread(params.threadId)
          : ({ kind: "official" } as const);
      if (await this.#host.writeResolutionError(request, location)) return true;
      if (location.kind === "external") {
        if (request.method === "thread/name/set") {
          await this.#host.setExternalThreadName(request, location, params.name);
        } else {
          await this.#host.deleteExternalThread(request, location);
        }
        return true;
      }
    }
    if (
      request.method === "thread/backgroundTerminals/clean" &&
      isRecord(request.params) &&
      typeof request.params.threadId === "string"
    ) {
      const location = await this.#host.locateExternalThread(request.params.threadId);
      if (await this.#host.writeResolutionError(request, location)) return true;
      if (location.kind === "external") {
        await this.#host.cleanExternalBackgroundTerminals(request, request.params.threadId);
        return true;
      }
    }
    if (
      request.method.startsWith("thread/") &&
      !EXPLICIT_EXTERNAL_THREAD_METHODS.has(request.method) &&
      isRecord(request.params) &&
      typeof request.params.threadId === "string"
    ) {
      const location = await this.#host.locateExternalThread(request.params.threadId);
      if (await this.#host.writeResolutionError(request, location)) return true;
      if (location.kind === "external") {
        const emptyResult = externalThreadEmptyOfficialResult(request.method);
        await this.#host.writeJson(
          emptyResult
            ? rpcEnvelope(request, { result: emptyResult })
            : rpcError(request, -32076, `External Thread does not support ${request.method}`),
        );
        return true;
      }
    }
    return false;
  }
}
