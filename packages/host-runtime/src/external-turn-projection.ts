import type { HostEvent } from "@codexhost/harness-adapter";
import {
  CodexTurnProjector,
  type JsonObject,
  type JsonValue,
  type ProjectableHostEvent,
} from "@codexhost/protocol-core";
import {
  THREAD_MANUAL_COMPACTION_STARTED_METHOD,
  type HostInteractionId,
  type HostItemId,
  type HostTurnId,
} from "@codexhost/shared-contracts";

import type { ExternalThread, ExternalThreadRuntime } from "./external-thread-runtime.js";
import type { ExternalThreadQueue } from "./external-thread-queue.js";
import type { ExternalThreadRepository, FailedTurn } from "./external-thread-repository.js";
import type { ExternalTurnSteering } from "./external-turn-steering.js";

export interface ProjectedTurn {
  projector: CodexTurnProjector;
}

export type ExternalThreadStatus = { type: "active"; activeFlags: [] } | { type: "idle" };
export type LiveFailedTurn = { failure: FailedTurn; items: JsonObject[] };

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function userMessageKey(item: JsonObject): string {
  if (!Array.isArray(item.content)) return "";
  return JSON.stringify(
    item.content.map((part) =>
      isJsonObject(part) && part.type === "text" && typeof part.text === "string"
        ? { type: "text", text: part.text }
        : part,
    ),
  );
}

/** Overlay Host failures without reordering Native Turns. Only live memory supplies Items. */
export function withFailedTurns(
  native: JsonObject[],
  failures: readonly FailedTurn[],
  live: ReadonlyMap<string, LiveFailedTurn> | undefined,
): JsonObject[] {
  if (!failures.length) return native;
  const turns = [...native];
  const insertedAfter = new Map<string | undefined, string>();
  for (const failure of failures) {
    const index = turns.findIndex(({ id }) => id === failure.hostTurnId);
    const original = turns[index];
    const items = Array.isArray(original?.items) ? [...original.items] : [];
    const nativeCount = items.length;
    const matchedNative = new Set<number>();
    for (const item of live?.get(failure.hostTurnId)?.items ?? []) {
      if (item.type === "userMessage") {
        const key = userMessageKey(item);
        const matched = items.findIndex(
          (existing, i) =>
            i < nativeCount &&
            !matchedNative.has(i) &&
            isJsonObject(existing) &&
            existing.type === "userMessage" &&
            userMessageKey(existing) === key,
        );
        if (matched !== -1) {
          matchedNative.add(matched);
          continue;
        }
        items.push(item);
        continue;
      }
      if (item.type === "agentMessage" && typeof item.text === "string") {
        const text = item.text;
        const covered = items.findIndex(
          (existing, i) =>
            i < nativeCount &&
            !matchedNative.has(i) &&
            isJsonObject(existing) &&
            existing.type === "agentMessage" &&
            typeof existing.text === "string" &&
            existing.text.startsWith(text),
        );
        if (covered !== -1) {
          matchedNative.add(covered);
          continue;
        }
        const prefix = items.findIndex(
          (existing, i) =>
            i < nativeCount &&
            !matchedNative.has(i) &&
            isJsonObject(existing) &&
            existing.type === "agentMessage" &&
            typeof existing.text === "string" &&
            text.startsWith(existing.text),
        );
        if (prefix !== -1) {
          matchedNative.add(prefix);
          items[prefix] = { ...(items[prefix] as JsonObject), text };
          continue;
        }
        items.push(item);
      }
    }
    const failed = {
      startedAt: null,
      completedAt: null,
      durationMs: null,
      ...original,
      id: failure.hostTurnId,
      items,
      status: "failed",
      error: {
        message:
          failure.error === "authenticationRequired"
            ? "External Harness authentication required during execution; sign in and retry"
            : "External Harness failed during execution",
      },
    };
    if (original) {
      turns[index] = failed;
    } else {
      const anchor = insertedAfter.get(failure.afterTurnId) ?? failure.afterTurnId;
      const boundary = anchor === undefined ? -1 : turns.findIndex(({ id }) => id === anchor);
      turns.splice(boundary + 1, 0, failed);
    }
    insertedAfter.set(failure.afterTurnId, failure.hostTurnId);
  }
  return turns;
}

/** Harness events that belong to one Turn, as opposed to Session, usage and subagent events. */
export type TurnScopedEvent = Exclude<
  HostEvent,
  {
    type:
      | "session.state.changed"
      | "session.usage.changed"
      | "usage.request"
      | "usage.request.timing"
      | "usage.history"
      | "subagent.state.changed"
      | "subagent.transcript.changed"
      | "session.faulted"
      | "turn.autonomous.completed";
  }
>;

export function projectedTurn(thread: ExternalThread, turnId: HostTurnId): ProjectedTurn {
  const projection = thread.projectedTurns.get(turnId);
  if (!projection) throw new Error("Harness output references an unknown Host Turn");
  return projection;
}

export async function waitForTurnResponse(
  thread: ExternalThread,
  turnId: HostTurnId,
): Promise<void> {
  await thread.responseGates.get(turnId)?.promise;
}

/** The Host state and collaborators that Turn projection writes through. */
export interface ExternalTurnProjectionHost {
  writeJson(value: JsonValue): Promise<void>;
  readonly repository: Pick<
    ExternalThreadRepository,
    "getDelegationByChild" | "setDelegationStatus"
  >;
  readonly steering: Pick<ExternalTurnSteering, "hasPending" | "terminal">;
  readonly queue: Pick<ExternalThreadQueue, "pause">;
  /** Turns started by an explicit /compact command, announced when compaction begins. */
  readonly manualCompactionTurns: WeakMap<ExternalThread, HostTurnId>;
  foldSettledItem(turn: JsonObject, projector: CodexTurnProjector, itemId: HostItemId): JsonObject;
  outputFailed(thread: ExternalThread): void;
  submitPrewarm(thread: ExternalThread): Promise<boolean>;
  notifyExternalThreadStarted(thread: JsonObject): Promise<void>;
  touchThread(thread: ExternalThread): Promise<void>;
  persistTerminalIdentity(
    thread: ExternalThread,
    event: Parameters<ExternalThreadRuntime["persistTerminalIdentity"]>[1],
  ): Promise<Error | null>;
  retainFailedTurn(...args: Parameters<ExternalThreadRuntime["retainFailedTurn"]>): Promise<void>;
  captureCompletedPreview(thread: ExternalThread, turn: JsonObject): Promise<void>;
  resolveDesktopApproval(interactionId: HostInteractionId, thread: ExternalThread): Promise<void>;
  resolveDesktopQuestion(interactionId: HostInteractionId, thread: ExternalThread): Promise<void>;
  retireSharedQuestions(thread: ExternalThread, turnId: HostTurnId): void;
  setThreadStatus(thread: ExternalThread, status: ExternalThreadStatus): Promise<void>;
  forgetQueuedTurnStart(threadId: string): void;
  signalActiveWorkChanged(): void;
  hasRunningSubagents(parentThreadId: string): boolean;
  publishExternalQueue(threadId: string): Promise<void>;
  startNextQueuedExternalTurn(thread: ExternalThread): Promise<void>;
}

/**
 * Projects the Harness events of one external Turn into Codex UI messages, and settles the
 * Thread's Turn state, delegation status, steering and queue when the Turn completes.
 */
export class ExternalTurnProjection {
  readonly #host: ExternalTurnProjectionHost;

  constructor(host: ExternalTurnProjectionHost) {
    this.#host = host;
  }

  async project(thread: ExternalThread, input: TurnScopedEvent): Promise<void> {
    let event = input;
    if (event.type === "turn.autonomous.started") {
      if (thread.running || thread.activeTurnId) {
        throw new Error("External autonomous Turn started while another Turn is active");
      }
      const projection: ProjectedTurn = {
        projector: new CodexTurnProjector({
          threadId: thread.id,
          turnId: event.turnId,
          cwd: thread.cwd,
          startedAtMs: Date.now(),
          initialInput: event.input,
        }),
      };
      thread.running = true;
      thread.activeTurnId = event.turnId;
      thread.projectedTerminalTurnId = null;
      thread.projectedTurns.set(event.turnId, projection);
      thread.responseGates.set(event.turnId, {
        promise: Promise.resolve(),
        resolve: () => undefined,
      });
      if (thread.clientCommand) thread.clientCommand.subsequentTurnId ??= event.turnId;
      // Real native work is no longer a disposable draft, even when it was
      // initiated by the Harness rather than a Desktop submission.
      if (thread.unsubmittedPrewarm && (await this.#host.submitPrewarm(thread))) {
        await this.#host.notifyExternalThreadStarted(thread.thread);
      }
      return;
    }

    if (event.type === "turn.completed" && thread.pendingSteerProjections.size > 0) {
      await Promise.allSettled([...thread.pendingSteerProjections]);
    }
    const projection = projectedTurn(thread, event.turnId);
    await waitForTurnResponse(thread, event.turnId);
    if (
      event.type === "interaction.closed" &&
      thread.ignoredInteractionIds.delete(event.interactionId)
    ) {
      return;
    }
    if (event.type === "turn.completed") this.#host.retireSharedQuestions(thread, event.turnId);
    if (event.type === "interaction.closed") {
      await this.#host.resolveDesktopApproval(event.interactionId, thread);
      await this.#host.resolveDesktopQuestion(event.interactionId, thread);
    }
    // agy uses the same ACP prompt for slash commands and conversation. Only
    // promote output backed by a new native user Turn, not local command text.
    const conversationalCommand =
      event.type === "turn.completed" &&
      thread.clientCommand?.turn.id === event.turnId &&
      thread.harnessId === "antigravity" &&
      this.#host.manualCompactionTurns.get(thread) !== event.turnId &&
      event.outcome.status === "succeeded" &&
      event.nativeTurnRef !== undefined &&
      [...projection.projector.foregroundWireItems().values()].some(
        (item) => item.type === "agentMessage" && typeof item.text === "string" && item.text.trim(),
      );
    const ephemeralTurn =
      event.type === "turn.completed"
        ? event.ephemeral === true ||
          (thread.ephemeralTurnIds.has(event.turnId) && !conversationalCommand)
        : thread.ephemeralTurnIds.has(event.turnId);
    if (event.type === "turn.completed" && !ephemeralTurn) {
      const persistenceError = await this.#host.persistTerminalIdentity(thread, event);
      if (persistenceError) {
        this.#host.outputFailed(thread);
        event = {
          type: "turn.completed",
          turnId: event.turnId,
          ...(event.nativeTurnRef ? { nativeTurnRef: event.nativeTurnRef } : {}),
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
    if (
      event.type === "item.background.started" ||
      (projection.projector.completed &&
        (event.type === "item.updated" || event.type === "item.completed"))
    ) {
      const updatedAt = Math.floor(Date.now() / 1000);
      thread.thread.updatedAt = updatedAt;
      thread.thread.recencyAt = updatedAt;
    }
    if (event.type === "turn.started") {
      if (thread.clientCommand && !ephemeralTurn)
        thread.clientCommand.subsequentTurnId ??= event.turnId;
      // A successor Turn ends the attribution window of every earlier Turn.
      this.#dropSettledTurnProjections(thread, event.turnId);
      // Not awaited: the write must not delay the Turn's first output.
      if (!ephemeralTurn) void this.#host.touchThread(thread);
      await this.#host.setThreadStatus(thread, { type: "active", activeFlags: [] });
    }
    if (event.type === "turn.completed") {
      this.#host.forgetQueuedTurnStart(thread.id);
      if (!result.completedTurn) throw new Error("Turn projector returned no completed Turn");
      const turn = projection.projector.snapshotTurn(result.completedTurn);
      if (thread.ephemeralTurnIds.delete(event.turnId)) {
        if (thread.clientCommand?.turn.id === event.turnId) {
          // Settle an already visible command card without repeating the reply in it.
          thread.clientCommand.turn = ephemeralTurn ? turn : { ...turn, items: [] };
        }
        this.#host.manualCompactionTurns.delete(thread);
      }
      if (!ephemeralTurn) {
        if (event.outcome.status === "failed")
          await this.#host.retainFailedTurn(thread, event, turn);
        if (event.outcome.status === "succeeded")
          await this.#host.captureCompletedPreview(thread, turn);
        thread.turns.push(turn);
        thread.projectedTerminalTurnId = event.turnId;
      }
      thread.historyHydrated = false;
      thread.running = false;
      thread.activeTurnId = null;
      // Before any completion message, so a client acting on it reads the touched record.
      if (!ephemeralTurn) await this.#host.touchThread(thread);
      // Detached Items (native background commands) and idle background output
      // settle on the completed Turn later; keep its projector so late events
      // still project instead of failing on a missing Turn.
      this.#dropSettledTurnProjections(thread, event.turnId);
      thread.responseGates.delete(event.turnId);
      thread.pendingSteerProjections.clear();
      this.#host.signalActiveWorkChanged();
      const delegation = await this.#host.repository.getDelegationByChild(
        thread.record.hostThreadId,
      );
      if (delegation) {
        const status =
          result.completedTurn.status === "failed"
            ? "failed"
            : result.completedTurn.status === "interrupted"
              ? "interrupted"
              : "completed";
        await this.#host.repository.setDelegationStatus(delegation.delegationId, status);
      }
    }
    if (
      event.type === "item.started" &&
      event.item.type === "contextCompaction" &&
      this.#host.manualCompactionTurns.get(thread) === event.turnId
    ) {
      // Only explicit /compact commands are manual; other commands can auto-compact.
      // Desktop labels a compaction manual only
      // through its own client registration, which must precede item/started.
      await this.#host.writeJson({
        method: THREAD_MANUAL_COMPACTION_STARTED_METHOD,
        params: { threadId: thread.id, turnId: event.turnId },
      });
    }
    if (event.type === "item.completed" && projection.projector.completed) {
      const index = thread.turns.findIndex((turn) => turn.id === event.turnId);
      const existing = thread.turns[index];
      if (existing) {
        // A stale cache may still contain native-only Items from an earlier read.
        thread.turns[index] = this.#host.foldSettledItem(
          existing,
          projection.projector,
          event.snapshot.item.itemId,
        );
        thread.historyHydrated = false;
      }
      if (
        !projection.projector.hasOpenDetachedItems &&
        event.turnId !== thread.projectedTerminalTurnId
      )
        thread.projectedTurns.delete(event.turnId);
    }
    for (const message of result.messages) {
      const params = message.params;
      if (
        message.method === "turn/plan/updated" &&
        typeof params === "object" &&
        params !== null &&
        !Array.isArray(params)
      ) {
        thread.livePlan = params;
      }
      await this.#host.writeJson(message);
    }
    if (event.type === "turn.completed") {
      await this.#host.setThreadStatus(
        thread,
        this.#host.hasRunningSubagents(thread.id)
          ? { type: "active", activeFlags: [] }
          : { type: "idle" },
      );
      const steering = this.#host.steering.hasPending(thread.id);
      this.#host.steering.terminal(thread.id, event.turnId, event.outcome);
      if (!steering) {
        const status = event.outcome.status;
        if (status === "succeeded") void this.#host.startNextQueuedExternalTurn(thread);
        else {
          const reason = status === "cancelled" ? "interrupted" : "failed";
          if (this.#host.queue.pause(thread.id, reason))
            await this.#host.publishExternalQueue(thread.id);
        }
      }
    }
  }

  /** Keep only Turn projections that can still receive output: the active one,
   * plus completed Turns whose detached or background Items have not settled. */
  #dropSettledTurnProjections(thread: ExternalThread, keep: HostTurnId): void {
    for (const [id, { projector }] of thread.projectedTurns) {
      if (id !== keep && projector.completed && !projector.hasOpenDetachedItems)
        thread.projectedTurns.delete(id);
    }
  }
}
