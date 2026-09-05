import { randomUUID } from "node:crypto";

import type { TurnCompletedEvent } from "@codexhost/harness-adapter";
import { CodexTurnProjector } from "@codexhost/protocol-core";
import {
  hostTurnIdSchema,
  turnAdjustmentParamsSchema,
  type HostTurnId,
  type TurnAdjustmentParams,
  type TurnAdjustmentResult,
} from "@codexhost/shared-contracts";

import {
  createTurnProjectionGate,
  type ExternalThread,
  type ExternalThreadRuntime,
} from "./external-thread-runtime.js";
import { executeExternalTurnSteer } from "./external-turn-steering.js";

export type ExternalTurnAdjustmentOutcome =
  | { ok: true; value: TurnAdjustmentResult; releaseProjectionGate(): void }
  | { ok: false; code: number; message: string; releaseProjectionGate(): void };

interface PendingAdjustment {
  turnId: HostTurnId;
  terminal: ReturnType<typeof Promise.withResolvers<TurnCompletedEvent>>;
  abort: ReturnType<typeof Promise.withResolvers<never>>;
  stopped: boolean;
  continuation?: Promise<ExternalTurnAdjustmentOutcome>;
}

function failure(message: string, code = -32073): ExternalTurnAdjustmentOutcome {
  return { ok: false, code, message, releaseProjectionGate: () => undefined };
}

/** Coordinates controls through the existing, single Harness output consumer. */
export class ExternalTurnAdjustments {
  #closed = false;
  readonly #active = new Map<ExternalThread, PendingAdjustment>();
  readonly #receipts = new WeakMap<
    ExternalThread,
    Map<
      string,
      {
        key: string;
        result: Promise<ExternalTurnAdjustmentOutcome>;
        settled: boolean;
      }
    >
  >();

  constructor(
    readonly runtime: ExternalThreadRuntime,
    readonly timeoutMs = 30_000,
  ) {}

  hasPending(thread: ExternalThread): boolean {
    return this.#active.has(thread);
  }

  terminal(thread: ExternalThread, event: TurnCompletedEvent): void {
    const pending = this.#active.get(thread);
    if (pending?.turnId === event.turnId) pending.terminal.resolve(event);
  }

  async stop(thread: ExternalThread, turnId?: string): Promise<boolean> {
    const pending = this.#active.get(thread);
    if (
      !pending ||
      (turnId !== undefined && pending.turnId !== turnId && thread.activeTurnId !== turnId)
    )
      return false;
    pending.stopped = true;
    pending.abort.reject(new Error("Adjustment was stopped before continuation"));
    // If admission already began, #start cancels the new Turn after its acknowledgement.
    // Do not send a stale cancel for the old Turn while the native prompt is being admitted.
    const outcome = await pending.continuation;
    if (outcome && !outcome.ok && thread.activeTurnId !== null) throw new Error(outcome.message);
    return true;
  }

  fault(thread: ExternalThread, message: string): void {
    const pending = this.#active.get(thread);
    if (!pending) return;
    pending.stopped = true;
    pending.abort.reject(new Error(message));
  }

  close(): void {
    this.#closed = true;
    for (const thread of this.#active.keys()) this.fault(thread, "Host closed during adjustment");
  }

  execute(thread: ExternalThread, input: unknown): Promise<ExternalTurnAdjustmentOutcome> {
    const parsed = turnAdjustmentParamsSchema.safeParse(input);
    if (!parsed.success || parsed.data.threadId !== thread.id) {
      return Promise.resolve(failure("Invalid external Turn adjustment input", -32602));
    }
    const command = parsed.data;
    const key = JSON.stringify([command.expectedTurnId, command.input]);
    let receipts = this.#receipts.get(thread);
    const existing = receipts?.get(command.clientUserMessageId);
    if (existing)
      return existing.key === key
        ? existing.result
        : Promise.resolve(
            failure("Adjustment clientUserMessageId was reused with new input", -32602),
          );
    if (!receipts) {
      receipts = new Map();
      this.#receipts.set(thread, receipts);
    }
    // Register before executing any asynchronous native command.
    const result = Promise.resolve()
      .then(() => this.#execute(thread, command))
      .catch((error: unknown) => failure(error instanceof Error ? error.message : String(error)));
    const receipt = { key, result, settled: false };
    receipts.set(command.clientUserMessageId, receipt);
    const cache = receipts;
    void result.then(() => {
      receipt.settled = true;
      // Never evict an in-flight identity. Stale Turn validation protects old
      // completed requests once their receipts have left the bounded cache.
      for (const [id, cached] of cache) {
        if (cache.size <= 256) break;
        if (cached.settled) cache.delete(id);
      }
    });
    return result;
  }

  async #execute(
    thread: ExternalThread,
    command: TurnAdjustmentParams,
  ): Promise<ExternalTurnAdjustmentOutcome> {
    if (this.#closed) return failure("Host closed before adjustment");
    if (this.#active.has(thread)) return failure("Another adjustment is pending", -32072);
    if (thread.session.capabilities.activeTurns?.steer) {
      const result = await executeExternalTurnSteer(thread, command);
      return result.ok
        ? {
            ok: true,
            value: {
              turnId: result.turnId,
              previousTurnId: command.expectedTurnId,
              delivery: "steer",
            },
            releaseProjectionGate: result.releaseProjectionGate,
          }
        : result;
    }
    if (!thread.session.capabilities.activeTurns?.interruptAndContinue) {
      return failure("External Harness does not support Turn adjustment", -32076);
    }
    if (
      !thread.running ||
      thread.activeTurnId !== command.expectedTurnId ||
      !thread.projectedTurns.has(command.expectedTurnId) ||
      thread.ephemeralTurnIds.has(command.expectedTurnId)
    ) {
      return failure("Adjustment must reference the active text Turn", -32074);
    }
    const access = this.runtime.beginSessionAccess(thread);
    if (!access) return failure("External Thread history is being changed", -32072);
    const pending: PendingAdjustment = {
      turnId: command.expectedTurnId,
      terminal: Promise.withResolvers<TurnCompletedEvent>(),
      abort: Promise.withResolvers<never>(),
      stopped: false,
    };
    // Rejections can precede awaiting cancellation admission.
    void pending.abort.promise.catch(() => undefined);
    this.#active.set(thread, pending);
    const timeout = setTimeout(
      () => this.fault(thread, "Adjustment timed out waiting for the current Turn to stop"),
      this.timeoutMs,
    );
    timeout.unref();
    let cancellationSettled = false;
    const cancellation = Promise.resolve()
      .then(() =>
        thread.session.execute({
          type: "turn.cancel",
          turnId: command.expectedTurnId,
        }),
      )
      .finally(() => {
        cancellationSettled = true;
      });
    try {
      const cancel = await Promise.race([cancellation, pending.abort.promise]);
      if (!cancel.ok && cancel.error.code !== "invalidState") return failure(cancel.error.message);
      const terminal = await Promise.race([pending.terminal.promise, pending.abort.promise]);
      if (
        pending.stopped ||
        terminal.outcome.status === "failed" ||
        thread.persistenceError ||
        this.runtime.get(thread.id) !== thread
      ) {
        return failure("Current Turn did not stop safely; adjustment was not sent");
      }
      this.runtime.endSessionAccess(thread, access);
      if (!this.runtime.canStartSessionOperation(thread))
        return failure("External Thread became busy before continuation", -32072);
      clearTimeout(timeout);
      pending.continuation = this.#start(thread, command, pending);
      return await pending.continuation;
    } finally {
      clearTimeout(timeout);
      this.#active.delete(thread);
      if (cancellationSettled) this.runtime.endSessionAccess(thread, access);
      else {
        // A timed-out/stopped request cannot release execution while a late native
        // cancel might still affect the next prompt.
        const release = () => this.runtime.endSessionAccess(thread, access);
        void cancellation.then(release, release);
      }
    }
  }

  async #start(
    thread: ExternalThread,
    command: TurnAdjustmentParams,
    pending: PendingAdjustment,
  ): Promise<ExternalTurnAdjustmentOutcome> {
    const turnId = hostTurnIdSchema.parse(randomUUID());
    const projector = new CodexTurnProjector({
      threadId: thread.id,
      turnId,
      cwd: thread.cwd,
      startedAtMs: Date.now(),
      initialInput: command.input,
      emitInitialInput: true,
      clientUserMessageId: command.clientUserMessageId,
    });
    const gate = createTurnProjectionGate();
    thread.running = true;
    thread.activeTurnId = turnId;
    thread.projectedTurns.set(turnId, { projector });
    thread.responseGates.set(turnId, gate);
    try {
      const started = await thread.session.execute({
        type: "turn.start",
        turnId,
        input: command.input,
      });
      if (!started.ok) {
        thread.running = false;
        thread.activeTurnId = null;
        thread.projectedTurns.delete(turnId);
        thread.responseGates.delete(turnId);
        gate.resolve();
        return failure(started.error.message);
      }
      if (started.value.turnId !== turnId)
        throw new Error("Continuation acknowledged another Turn");
      if (pending.stopped) {
        const cancelled = await thread.session.execute({ type: "turn.cancel", turnId });
        if (!cancelled.ok)
          throw new Error(`Continuation could not be stopped: ${cancelled.error.message}`);
      }
      return {
        ok: true,
        value: {
          turnId,
          previousTurnId: command.expectedTurnId,
          delivery: "interrupt-and-continue",
        },
        releaseProjectionGate: gate.resolve,
      };
    } catch (error) {
      // A thrown transport error is not proof that native admission failed. Keep the
      // projection/occupancy and never replay this identity; late output must remain visible.
      return {
        ...failure(
          `Continuation outcome is uncertain: ${error instanceof Error ? error.message : String(error)}`,
        ),
        releaseProjectionGate: gate.resolve,
      };
    }
  }
}
