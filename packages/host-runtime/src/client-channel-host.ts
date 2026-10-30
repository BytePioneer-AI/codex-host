import type { HostApprovalInteraction, HostQuestionInteraction } from "@codexhost/harness-adapter";
import type { StoredThreadRecordV1 } from "@codexhost/mapping-store";
import { jsonRpcRequestSchema, type JsonObject, type JsonValue } from "@codexhost/protocol-core";
import {
  CLIENT_CHANNEL_METHODS,
  clientThreadSnapshotSchema,
  harnessInstallationRequestTimeoutMs,
  jsonValueSchema,
  type ClientChannelResponse,
  type ClientSnapshotOptions,
  type ClientThreadSnapshot,
} from "@codexhost/shared-contracts";

import type { ConsoleHostReply } from "./app-server-host.js";
import type { ClientChannelEvents } from "./client-channel-events.js";
import { ClientCommandReceipts } from "./client-command-receipts.js";
import { compactClientSnapshot } from "./client-snapshot-compaction.js";
import { listExternalTurns } from "./external-thread-history.js";
import type { ExternalThreadQueueSnapshot } from "./external-thread-queue.js";
import type { ExternalThread, ExternalThreadLocation } from "./external-thread-runtime.js";
import { readExternalWorkspaceSnapshot } from "./native-workspace-snapshot.js";
import { classifyCreateRequestRoute } from "./route-observation.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A Host approval or question request still awaiting its first accepted answer. */
export interface PendingClientInteraction {
  readonly thread: ExternalThread;
  readonly interaction: HostApprovalInteraction | HostQuestionInteraction;
  readonly projection: { readonly request: JsonObject; parseResponse(result: unknown): unknown };
}

/** Pending interactions keyed by Host request ID, answered through the Desktop response path. */
export interface ClientInteractionSource {
  readonly approvals: ReadonlyMap<number, PendingClientInteraction>;
  readonly questions: ReadonlyMap<number, PendingClientInteraction>;
  isApprovalRequestId(value: unknown): value is number;
  isQuestionRequestId(value: unknown): value is number;
  respondApproval(response: JsonValue): Promise<boolean>;
  respondQuestion(response: JsonValue): Promise<boolean>;
}

export interface ClientChannelHostDependencies {
  readonly events: ClientChannelEvents;
  readonly interactions: ClientInteractionSource;
  environment(): NodeJS.ProcessEnv;
  waitForPlugins(): Promise<void>;
  listRecords(): Promise<readonly StoredThreadRecordV1[]>;
  locateExternalThread(threadId: string): Promise<ExternalThreadLocation>;
  loadedThread(threadId: string): ExternalThread | undefined;
  /** History served to clients, including the live snapshot of a non-ephemeral active Turn. */
  clientHistoryTurns(thread: ExternalThread): JsonObject[];
  queueSnapshot(threadId: string): ExternalThreadQueueSnapshot;
  /** Runs one client request through the shared Desktop request handling. */
  submit(
    method: string,
    params: JsonObject,
    timeoutMs: number | undefined,
  ): Promise<ConsoleHostReply>;
}

/**
 * Client channel adapter of the external Thread owner: restricted RPC, absolute Thread
 * snapshots, interaction answers and invalidation of Threads clients may read.
 */
export class ClientChannelHost {
  readonly clientEvents: ClientChannelEvents;
  readonly #host: ClientChannelHostDependencies;
  readonly #clientOwnedThreads = new Set<string>();
  readonly #clientReceipts = new ClientCommandReceipts();

  constructor(host: ClientChannelHostDependencies) {
    this.#host = host;
    this.clientEvents = host.events;
  }

  /** A Thread located as external stays visible to client invalidations. */
  noteExternalThread(threadId: string): void {
    this.#clientOwnedThreads.add(threadId);
  }

  /** Desktop-bound notifications about a client-visible Thread invalidate that Thread. */
  observeDesktopMessage(value: JsonValue): void {
    if (isRecord(value) && typeof value.method === "string" && isRecord(value.params)) {
      const params = value.params;
      const thread = isRecord(params.thread) ? params.thread : undefined;
      const id = typeof params.threadId === "string" ? params.threadId : thread?.id;
      if (
        typeof id === "string" &&
        (this.#clientOwnedThreads.has(id) ||
          thread?.modelProvider === "codexhost" ||
          this.#host.loadedThread(id))
      ) {
        this.#clientOwnedThreads.add(id);
        this.clientEvents.changed(id, value.method);
      }
    }
  }

  /** Public client operations stay on this owner and never fall through to official Codex. */
  async handleClientRequest(method: string, input: unknown): Promise<ConsoleHostReply> {
    if (!(CLIENT_CHANNEL_METHODS as readonly string[]).includes(method))
      return { error: { code: -32601, message: "Client method is not available" } };
    const parsed = jsonRpcRequestSchema.safeParse({ id: "client", method, params: input ?? {} });
    if (!parsed.success || !isRecord(parsed.data.params))
      return { error: { code: -32602, message: "Invalid client parameters" } };
    const params = parsed.data.params as JsonObject;
    if (method === "codexhost/workspace/read") {
      await this.#host.waitForPlugins();
      return {
        result: jsonValueSchema.parse(
          await readExternalWorkspaceSnapshot(
            this.#host.environment(),
            await this.#host.listRecords(),
          ),
        ),
      };
    }
    if (method === "thread/start") {
      const route = classifyCreateRequestRoute(parsed.data);
      if (!route || route.selectedHarness === "codex")
        return {
          error: {
            code: -32078,
            message: "Only external Harness Threads are available to this client",
          },
        };
    }
    if (typeof params.threadId === "string") {
      const location = await this.#host.locateExternalThread(params.threadId);
      if (location.kind !== "external")
        return { error: { code: -32078, message: "Thread is not owned by this external Host" } };
    } else if (
      (method.startsWith("thread/") || method.startsWith("turn/")) &&
      method !== "thread/list" &&
      method !== "thread/start"
    ) {
      return { error: { code: -32602, message: "threadId is required" } };
    }
    const submit = async (): Promise<ConsoleHostReply> => {
      const reply = await this.#host.submit(
        method,
        method === "thread/list" ? { ...params, modelProviders: ["codexhost"] } : params,
        harnessInstallationRequestTimeoutMs(method, params),
      );
      return "error" in reply && [-32090, -32093].includes(reply.error.code)
        ? {
            error: {
              code: reply.error.code,
              message:
                "CH did not confirm an outcome; the operation may have executed. Do not retry automatically.",
            },
          }
        : reply;
    };
    return method === "turn/start" && typeof params.clientUserMessageId === "string"
      ? this.#clientReceipts.run(
          JSON.stringify([params.threadId, params.clientUserMessageId]),
          params,
          submit,
        )
      : submit();
  }

  /** Absolute, bounded state; capture fields and delivery cursor without yielding.
   * Notifications are invalidations, not text deltas to replay over this snapshot.
   */
  async clientSnapshot(
    threadId: string,
    options: ClientSnapshotOptions = {},
  ): Promise<ClientThreadSnapshot> {
    let thread = this.#host.loadedThread(threadId);
    if (!thread) {
      const prepared = await this.handleClientRequest("thread/turns/list", {
        threadId,
        limit: 5,
        sortDirection: "desc",
        itemsView: "full",
      });
      if ("error" in prepared) throw new Error(prepared.error.message);
      thread = this.#host.loadedThread(threadId);
    }
    if (!thread) throw new Error("Thread is not owned by this local Host");
    const interactions = [
      ...[...this.#host.interactions.approvals]
        .filter(([, pending]) => pending.thread === thread)
        .map(([requestId, pending]) => ({
          requestId,
          threadId,
          kind: "approval",
          interaction: pending.interaction,
          request: pending.projection.request,
        })),
      ...[...this.#host.interactions.questions]
        .filter(([, pending]) => pending.thread === thread)
        .map(([requestId, pending]) => ({
          requestId,
          threadId,
          kind: "question",
          interaction: pending.interaction,
          request: pending.projection.request,
        })),
    ];
    const state = thread.stateObserver.state;
    const snapshot = clientThreadSnapshotSchema.parse(
      JSON.parse(
        JSON.stringify({
          cursor: this.clientEvents.cursor,
          activeTurnId: thread.activeTurnId,
          command: thread.clientCommand
            ? {
                ...thread.clientCommand,
                turn:
                  thread.activeTurnId && thread.activeTurnId === thread.clientCommand.turn.id
                    ? (thread.projectedTurns.get(thread.activeTurnId)?.projector.snapshotTurn() ??
                      thread.clientCommand.turn)
                    : thread.clientCommand.turn,
              }
            : undefined,
          thread: { ...thread.thread, turns: [] },
          turnsPage: listExternalTurns(this.#host.clientHistoryTurns(thread), {
            limit: 5,
            sortDirection: "desc",
            itemsView: "full",
          }),
          configuration: {
            effectiveModel: state.effectiveModel,
            effectiveThinkingOptionId: state.effectiveThinkingOptionId,
            effectivePermissionModeId: state.effectivePermissionModeId,
          },
          queue: this.#host.queueSnapshot(threadId),
          interactions,
        }),
      ),
    );
    // Native history may be refreshed after terminal output. Preserve this
    // process's submission receipt, without persisting a second message index.
    for (const turn of snapshot.turnsPage.data) {
      if (typeof turn.id !== "string" || !Array.isArray(turn.items)) continue;
      const clientId = this.#clientReceipts.clientIdForTurn(threadId, turn.id);
      const user = turn.items.find(
        (item: unknown) => isRecord(item) && item.type === "userMessage",
      ) as Record<string, unknown> | undefined;
      if (clientId && user && typeof user.clientId !== "string") user.clientId = clientId;
    }
    return compactClientSnapshot(snapshot, options);
  }

  async respondClient(input: ClientChannelResponse): Promise<{ resolved: boolean }> {
    if (input.epoch !== this.clientEvents.epoch)
      throw new Error("Host generation changed; refresh the pending interaction");
    const id = input.requestId;
    const interactions = this.#host.interactions;
    const approval = interactions.isApprovalRequestId(id)
      ? interactions.approvals.get(id)
      : undefined;
    const question = interactions.isQuestionRequestId(id)
      ? interactions.questions.get(id)
      : undefined;
    const pending = approval ?? question;
    if (!pending) return { resolved: true };
    if (pending.thread.id !== input.threadId)
      throw new Error("Interaction does not belong to this Thread");
    pending.projection.parseResponse(input.result); // Reject malformed client responses before claiming.
    const response = jsonValueSchema.parse({ id, result: input.result });
    if (approval) await interactions.respondApproval(response);
    else await interactions.respondQuestion(response);
    return { resolved: true };
  }
}
