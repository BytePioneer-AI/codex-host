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
  type HostTurnId,
} from "@codexhost/shared-contracts";

import type { ExternalThread, ExternalThreadRuntime } from "./external-thread-runtime.js";
import type { ExternalThreadQueue } from "./external-thread-queue.js";
import type { ExternalThreadRepository } from "./external-thread-repository.js";
import type { ExternalTurnSteering } from "./external-turn-steering.js";

export interface ProjectedTurn {
  projector: CodexTurnProjector;
}

export type ExternalThreadStatus = { type: "active"; activeFlags: [] } | { type: "idle" };

/** Harness events that belong to one Turn, as opposed to Session, usage and subagent events. */
export type TurnScopedEvent = Exclude<
  HostEvent,
  {
    type:
      | "session.state.changed"
      | "session.usage.changed"
      | "usage.request"
      | "usage.history"
      | "subagent.state.changed"
      | "subagent.transcript.changed"
      | "session.faulted";
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
  outputFailed(thread: ExternalThread): void;
  submitPrewarm(thread: ExternalThread): Promise<boolean>;
  notifyExternalThreadStarted(thread: JsonObject): Promise<void>;
  persistTerminalIdentity(
    thread: ExternalThread,
    event: Parameters<ExternalThreadRuntime["persistTerminalIdentity"]>[1],
  ): Promise<Error | null>;
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
    const ephemeralTurn =
      event.type === "turn.completed" &&
      (event.ephemeral === true || thread.ephemeralTurnIds.has(event.turnId));
    if (event.type === "turn.completed" && !ephemeralTurn) {
      const persistenceError = await this.#host.persistTerminalIdentity(thread, event);
      if (persistenceError) {
        this.#host.outputFailed(thread);
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
      await this.#host.setThreadStatus(thread, { type: "active", activeFlags: [] });
    }
    if (event.type === "turn.completed") {
      this.#host.forgetQueuedTurnStart(thread.id);
      if (!result.completedTurn) throw new Error("Turn projector returned no completed Turn");
      const completedAt = Math.floor(Date.now() / 1000);
      if (ephemeralTurn) {
        if (thread.clientCommand?.turn.id === event.turnId)
          thread.clientCommand.turn = projection.projector.snapshotTurn(result.completedTurn);
        thread.ephemeralTurnIds.delete(event.turnId);
        this.#host.manualCompactionTurns.delete(thread);
      } else {
        thread.turns.push(projection.projector.snapshotTurn(result.completedTurn));
        thread.projectedTerminalTurnId = event.turnId;
        thread.thread.updatedAt = completedAt;
        thread.thread.recencyAt = completedAt;
      }
      thread.historyHydrated = false;
      thread.running = false;
      thread.activeTurnId = null;
      // Detached Items (native background commands) settle on this Turn later.
      if (!projection.projector.hasOpenDetachedItems) thread.projectedTurns.delete(event.turnId);
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
    if (
      event.type === "item.completed" &&
      projection.projector.completed &&
      !projection.projector.hasOpenDetachedItems
    ) {
      thread.projectedTurns.delete(event.turnId);
    }
    for (const message of result.messages) await this.#host.writeJson(message);
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
}
