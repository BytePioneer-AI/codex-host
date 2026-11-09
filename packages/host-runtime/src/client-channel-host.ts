import type { HostApprovalInteraction, HostQuestionInteraction } from "@codexhost/harness-adapter";
import type { StoredSectionPlacementV1, StoredThreadRecordV1 } from "@codexhost/mapping-store";
import { jsonRpcRequestSchema, type JsonObject, type JsonValue } from "@codexhost/protocol-core";
import {
  CLIENT_CHANNEL_METHODS,
  clientThreadSnapshotSchema,
  clientProjectlessWorkspaceSchema,
  harnessModelRefSchema,
  restoreHarnessCommandMentions,
  harnessInstallationRequestTimeoutMs,
  jsonValueSchema,
  type ClientChannelResponse,
  type ClientSnapshotOptions,
  type ClientThreadSnapshot,
} from "@codexhost/shared-contracts";

import type { ConsoleHostReply } from "./app-server-host.js";
import { transcribeVoice, voiceStatus } from "./voice-transcription.js";
import type { ClientChannelEvents } from "./client-channel-events.js";
import { ClientChannelRequestError } from "./client-channel-error.js";
import { ClientCommandReceipts } from "./client-command-receipts.js";
import { compactClientSnapshot } from "./client-snapshot-compaction.js";
import { listExternalTurns } from "./external-thread-history.js";
import type { ExternalThreadQueueSnapshot } from "./external-thread-queue.js";
import type { ExternalThread, ExternalThreadLocation } from "./external-thread-runtime.js";
import { readExternalWorkspaceSnapshot } from "./native-workspace-snapshot.js";
import {
  NativeClientChannel,
  type NativeClientChannelDependencies,
} from "./native-client-channel.js";
import { classifyCreateRequestRoute } from "./route-observation.js";
import { allocateProjectlessWorkspace } from "./projectless-workspace.js";
import { decodeOfficialCodexModelSelection } from "./official-codex-model-ref.js";
import { nativeThreadSkillInput } from "./codex-runtime/native-thread-controls.js";

const OFFICIAL_METHODS: Readonly<Record<string, "native" | "host">> = {
  "thread/read": "native",
  "thread/resume": "native",
  "thread/fork": "native",
  "thread/turns/list": "native",
  "thread/items/list": "native",
  "thread/name/set": "native",
  "thread/archive": "native",
  "thread/unarchive": "native",
  "turn/start": "native",
  "turn/steer": "native",
  "turn/interrupt": "native",
  "thread/queue/list": "native",
  "thread/queue/add": "native",
  "thread/queue/update": "native",
  "thread/queue/delete": "native",
  "thread/queue/reorder": "native",
  "thread/queue/start": "native",
  "codexhost/thread/queue/send-now": "native",
  "codexhost/thread/model/select": "host",
  "codexhost/thread/thinking/select": "host",
  "codexhost/thread/permission-mode/select": "host",
  "codexhost/thread/commands/inspect": "host",
  "codexhost/thread/command/execute": "host",
  "codexhost/thread/pins/set": "host",
  "codexhost/thread/usage/inspect": "host",
  "codexhost/thread/inspect": "native",
};

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
  listSectionPlacements(): Promise<readonly StoredSectionPlacementV1[]>;
  locateExternalThread(threadId: string): Promise<ExternalThreadLocation>;
  loadedThread(threadId: string): ExternalThread | undefined;
  /** History served to clients, including the live snapshot of a non-ephemeral active Turn. */
  clientHistoryTurns(thread: ExternalThread): JsonObject[];
  queueSnapshot(threadId: string): ExternalThreadQueueSnapshot;
  /** Native Codex calls use the shared service's already-attached official client. */
  readonly native?: NativeClientChannelDependencies;
  /** Runs one client request through the shared Desktop request handling. */
  submit(
    method: string,
    params: JsonObject,
    timeoutMs: number | undefined,
  ): Promise<ConsoleHostReply>;
}

/**
 * Client channel adapter of the shared Host: restricted RPC, absolute Thread
 * snapshots, interaction answers and invalidation of Threads clients may read.
 */
export class ClientChannelHost {
  readonly clientEvents: ClientChannelEvents;
  readonly #host: ClientChannelHostDependencies;
  readonly #native: NativeClientChannel | undefined;
  readonly #clientOwnedThreads = new Set<string>();
  readonly #clientReceipts = new ClientCommandReceipts();

  constructor(host: ClientChannelHostDependencies) {
    this.#host = host;
    this.#native = host.native ? new NativeClientChannel(host.native) : undefined;
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

  /** Native app-server notifications are invalidations and server requests for
   * the same Web snapshot/response boundary. */
  observeNativeMessage(value: JsonValue): void {
    this.#native?.observeMessage(value);
  }

  resetNativeSession(): void {
    this.#native?.resetGeneration();
  }

  /** Route only to the confirmed external owner or this service's shared native client. */
  async handleClientRequest(method: string, input: unknown): Promise<ConsoleHostReply> {
    if (!(CLIENT_CHANNEL_METHODS as readonly string[]).includes(method))
      return { error: { code: -32601, message: "Client method is not available" } };
    const parsed = jsonRpcRequestSchema.safeParse({ id: "client", method, params: input ?? {} });
    if (!parsed.success || !isRecord(parsed.data.params))
      return { error: { code: -32602, message: "Invalid client parameters" } };
    const params = parsed.data.params as JsonObject;
    if (method === "codexhost/voice/status")
      return { result: jsonValueSchema.parse(await voiceStatus(this.#host.environment())) };
    if (method === "codexhost/voice/transcribe")
      return {
        result: jsonValueSchema.parse(await transcribeVoice(params, this.#host.environment())),
      };
    if (method === "codexhost/workspace/read") {
      await this.#host.waitForPlugins();
      const nativeThreadIds = Array.isArray(params.threadIds)
        ? params.threadIds.filter((value): value is string => typeof value === "string")
        : [];
      return {
        result: jsonValueSchema.parse(
          await readExternalWorkspaceSnapshot(
            this.#host.environment(),
            await this.#host.listRecords(),
            await this.#host.listSectionPlacements(),
            nativeThreadIds,
          ),
        ),
      };
    }
    let native = false;
    if (method === "thread/start") {
      const route = classifyCreateRequestRoute(parsed.data);
      native = !route || route.selectedHarness === "codex";
      if (native && !this.#native)
        return {
          error: {
            code: -32078,
            message: "Only external Harness Threads are available to this client",
          },
        };
    }
    if (typeof params.threadId === "string") {
      const location = await this.#host.locateExternalThread(params.threadId);
      const official = location.kind === "official" ? OFFICIAL_METHODS[method] : undefined;
      native = native || official === "native";
      if (location.kind !== "external" && !native && official !== "host")
        return { error: { code: -32078, message: "Thread is not owned by this external Host" } };
    } else if (
      (method.startsWith("thread/") || method.startsWith("turn/")) &&
      method !== "thread/list" &&
      method !== "thread/start"
    ) {
      return { error: { code: -32602, message: "threadId is required" } };
    }
    const normalize = (reply: ConsoleHostReply): ConsoleHostReply => {
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
    const submit = async (): Promise<ConsoleHostReply> =>
      normalize(
        await this.#host.submit(
          method,
          params,
          harnessInstallationRequestTimeoutMs(method, params),
        ),
      );
    const nativeChannel = this.#native;
    const nativeSubmit = async (): Promise<ConsoleHostReply> => {
      if (!nativeChannel)
        return {
          error: {
            code: -32078,
            message: "Only external Harness Threads are available to this client",
          },
        };
      let nativeParams = params;
      let skillName: string | undefined;
      if (Array.isArray(params.input))
        nativeParams = {
          ...params,
          input: params.input.map((part) => {
            if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string")
              return part;
            const text = restoreHarnessCommandMentions(part.text);
            if (text !== part.text) skillName ??= /^\$([A-Za-z0-9._:-]+)(?:\s|$)/u.exec(text)?.[1];
            return { ...part, text };
          }),
        };
      if (
        ["turn/start", "turn/steer", "thread/queue/add", "thread/queue/update"].includes(method) &&
        typeof params.threadId === "string" &&
        Array.isArray(nativeParams.input)
      ) {
        if (
          skillName &&
          !nativeParams.input.some(
            (part) => isRecord(part) && part.type === "skill" && part.name === skillName,
          )
        ) {
          const read = await nativeChannel.request("thread/read", {
            threadId: params.threadId,
            includeTurns: false,
          });
          if ("error" in read) return normalize(read);
          const thread =
            isRecord(read.result) && isRecord(read.result.thread) ? read.result.thread : {};
          if (typeof thread.cwd !== "string" || !thread.cwd)
            return { error: { code: -32078, message: "Codex Thread has no Skill workspace" } };
          const listed = await nativeChannel.request("skills/list", { cwds: [thread.cwd] });
          if ("error" in listed) return normalize(listed);
          const skill = nativeThreadSkillInput(
            isRecord(listed.result) ? (listed.result as JsonObject) : {},
            skillName,
          );
          if (!skill)
            return {
              error: { code: -32078, message: `Codex Skill '${skillName}' is unavailable` },
            };
          nativeParams = { ...nativeParams, input: [...nativeParams.input, skill] };
        }
      }
      if (
        ["turn/start", "turn/steer", "thread/queue/add", "thread/queue/update"].includes(method) &&
        Array.isArray(nativeParams.input)
      ) {
        const text = nativeParams.input
          .filter((part) => isRecord(part) && part.type === "text")
          .map((part) => (isRecord(part) ? part.text : ""))
          .join("\n");
        const command = /^\/(compact|review)(?:\s+([\s\S]*))?$/u.exec(text.trim());
        if (command?.[1] && typeof params.threadId === "string") {
          if (method !== "turn/start" || params.delivery === "queue")
            return {
              error: { code: -32078, message: "Codex compact/review cannot be queued or steered" },
            };
          if (!nativeParams.input.every((part) => isRecord(part) && part.type === "text"))
            return {
              error: { code: -32602, message: "Codex compact/review only accepts text arguments" },
            };
          return normalize(
            await this.#host.submit(
              "codexhost/thread/command/execute",
              {
                threadId: params.threadId,
                commandId: command[1],
                ...(command[2] ? { arguments: { text: command[2] } } : {}),
              },
              undefined,
            ),
          );
        }
      }
      if (method === "thread/start") {
        nativeParams = { ...params };
        if (typeof params.model === "object" && params.model && !Array.isArray(params.model)) {
          try {
            Object.assign(
              nativeParams,
              decodeOfficialCodexModelSelection(harnessModelRefSchema.parse(params.model)),
            );
          } catch {
            return { error: { code: -32602, message: "Invalid official Model Ref" } };
          }
        }
        if (params.projectlessWorkspace !== undefined) {
          const choice = clientProjectlessWorkspaceSchema.safeParse(params.projectlessWorkspace);
          if (!choice.success || params.cwd !== undefined || params.ephemeral === true)
            return { error: { code: -32602, message: "Invalid projectless workspace choice" } };
          nativeParams.cwd = (
            await allocateProjectlessWorkspace(this.#host.environment(), choice.data.prompt ?? "")
          ).cwd;
          delete nativeParams.projectlessWorkspace;
        }
      }
      return normalize(await nativeChannel.request(method, nativeParams));
    };
    const operation = native ? nativeSubmit : submit;
    if (native && method === "codexhost/thread/queue/send-now")
      return this.#clientReceipts.run(
        JSON.stringify([method, params.threadId, params.itemId]),
        params,
        operation,
      );
    return method === "turn/start" && typeof params.clientUserMessageId === "string"
      ? this.#clientReceipts.run(
          JSON.stringify([params.threadId, params.clientUserMessageId]),
          params,
          operation,
        )
      : operation();
  }

  /** Absolute, bounded state; capture fields and delivery cursor without yielding.
   * Notifications are invalidations, not text deltas to replay over this snapshot.
   */
  async clientSnapshot(
    threadId: string,
    options: ClientSnapshotOptions = {},
  ): Promise<ClientThreadSnapshot> {
    const location = await this.#host.locateExternalThread(threadId);
    if (location.kind === "error")
      throw new ClientChannelRequestError(location.error.code, location.error.message);
    if (location.kind === "official") {
      if (!this.#native) throw new Error("Thread is not owned by this local Host");
      const snapshot = await this.#native.snapshot(threadId, {});
      const queue = snapshot.thread.nativeSendError
        ? { result: { data: [] } }
        : await this.#native.request("thread/queue/list", { threadId });
      if ("error" in queue)
        throw new ClientChannelRequestError(queue.error.code, queue.error.message);
      const items =
        isRecord(queue.result) && Array.isArray(queue.result.data)
          ? queue.result.data.map((item) =>
              isRecord(item)
                ? { ...item, clientUserMessageId: item.clientUserMessageId ?? item.id }
                : item,
            )
          : [];
      for (const turn of snapshot.turnsPage.data) {
        const clientId = this.#clientReceipts.clientIdForTurn(threadId, turn.id);
        const user = turn.items.find((item) => item.type === "userMessage");
        if (clientId && user && typeof user.clientId !== "string") user.clientId = clientId;
      }
      const latestStatus = snapshot.turnsPage.data[0]?.status;
      const pausedReason =
        items.length > 0 &&
        !snapshot.activeTurnId &&
        (latestStatus === "interrupted" || latestStatus === "failed")
          ? latestStatus
          : null;
      return compactClientSnapshot(
        clientThreadSnapshotSchema.parse({
          ...snapshot,
          queue: { items, pausedReason },
        }),
        options,
      );
    }
    let thread = this.#host.loadedThread(threadId);
    if (!thread) {
      const prepared = await this.handleClientRequest("thread/turns/list", {
        threadId,
        limit: 5,
        sortDirection: "desc",
        itemsView: "full",
      });
      if ("error" in prepared)
        throw new ClientChannelRequestError(prepared.error.code, prepared.error.message);
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
    if (!pending) {
      if (this.#native) {
        const resolved = await this.#native.respond(
          input.requestId,
          input.threadId,
          jsonValueSchema.parse(input.result),
        );
        if (resolved) return { resolved: true };
        if (this.#native.isStaleRequestId(input.requestId))
          throw new Error("Host generation changed; refresh the pending interaction");
      }
      return { resolved: true };
    }
    if (pending.thread.id !== input.threadId)
      throw new Error("Interaction does not belong to this Thread");
    pending.projection.parseResponse(input.result); // Reject malformed client responses before claiming.
    const response = jsonValueSchema.parse({ id, result: input.result });
    if (approval) await interactions.respondApproval(response);
    else await interactions.respondQuestion(response);
    return { resolved: true };
  }
}
