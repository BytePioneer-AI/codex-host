import type { HostTurnId } from "@codexhost/shared-contracts";
import type { JsonObject } from "@codexhost/protocol-core";
import type {
  HarnessResult,
  TurnCancelAccepted,
  TurnCancelCommand,
  TurnOutcome,
} from "@codexhost/harness-adapter";

import type { TurnProjectionGate } from "./external-thread-runtime.js";

interface SteeringThread {
  id: string;
  running: boolean;
  activeTurnId: HostTurnId | null;
  persistenceError: Error | null;
  session: { execute(command: TurnCancelCommand): Promise<HarnessResult<TurnCancelAccepted>> };
}

export class ExternalSteerError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

interface SteeringInput {
  expectedTurnId: string;
  clientUserMessageId?: string;
  text: string;
}

function parseInput(params: JsonObject): SteeringInput {
  if (typeof params.expectedTurnId !== "string" || !params.expectedTurnId.trim()) {
    throw new ExternalSteerError(-32602, "External steering requires expectedTurnId");
  }
  if (
    !Array.isArray(params.input) ||
    params.input.length === 0 ||
    params.input.some(
      (item) =>
        !item ||
        typeof item !== "object" ||
        Array.isArray(item) ||
        item.type !== "text" ||
        typeof item.text !== "string",
    )
  ) {
    throw new ExternalSteerError(-32602, "External steering requires text input");
  }
  const text = params.input.map((item) => (item as JsonObject).text).join("\n");
  if (!text.trim())
    throw new ExternalSteerError(-32602, "External steering input must not be empty");
  const clientUserMessageId = params.clientUserMessageId;
  if (
    clientUserMessageId != null &&
    (typeof clientUserMessageId !== "string" || !clientUserMessageId.trim())
  ) {
    throw new ExternalSteerError(-32602, "External steering message identity is invalid");
  }
  return {
    expectedTurnId: params.expectedTurnId,
    text,
    ...(typeof clientUserMessageId === "string" ? { clientUserMessageId } : {}),
  };
}

export interface ExternalSteerStarted {
  turnId: HostTurnId;
  gate: TurnProjectionGate;
}

interface PendingSteer {
  turnId: string;
  resolve(outcome: TurnOutcome): void;
  reject(error: Error): void;
}

/** Host-owned stop-then-start coordination, not a native Harness steer capability. */
export class ExternalTurnSteering {
  readonly #pending = new Map<string, PendingSteer>();
  readonly #receipts = new Map<
    string,
    { fingerprint: string; settled: boolean; result: Promise<ExternalSteerStarted> }
  >();
  #closed = false;

  constructor(readonly timeoutMs = 20_000) {}

  hasPending(threadId?: string): boolean {
    return threadId === undefined ? this.#pending.size > 0 : this.#pending.has(threadId);
  }

  run(
    thread: SteeringThread,
    params: JsonObject,
    start: (text: string) => Promise<ExternalSteerStarted>,
  ): Promise<ExternalSteerStarted> {
    try {
      const input = parseInput(params);
      if (this.#closed)
        throw new ExternalSteerError(-32074, "External steering connection is closed");
      const key = input.clientUserMessageId
        ? `${thread.id}\u0000${input.clientUserMessageId}`
        : null;
      const fingerprint = JSON.stringify([input.expectedTurnId, params.input]);
      const receipt = key ? this.#receipts.get(key) : undefined;
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) {
          throw new ExternalSteerError(
            -32602,
            "External steering message identity was reused with different input",
          );
        }
        return receipt.result;
      }
      if (this.hasPending(thread.id))
        throw new ExternalSteerError(-32072, "External Thread is already changing direction");
      if (!thread.running || thread.activeTurnId !== input.expectedTurnId) {
        // Do not use Codex's mismatch wording: Desktop automatically retries it against another Turn.
        throw new ExternalSteerError(-32074, "External steering must reference the active Turn");
      }
      const result = this.#replace(thread, input, start);
      if (key) {
        const receipt = { fingerprint, result, settled: false };
        this.#receipts.set(key, receipt);
        void result.then(
          () => {
            receipt.settled = true;
            // Bound completed receipts; never evict an in-flight delivery reservation.
            while (this.#receipts.size > 128) {
              const oldest = [...this.#receipts].find(([, entry]) => entry.settled)?.[0];
              if (oldest === undefined) break;
              this.#receipts.delete(oldest);
            }
          },
          () => {
            this.#receipts.delete(key);
          },
        );
      }
      return result;
    } catch (error) {
      return Promise.reject(error);
    }
  }

  terminal(threadId: string, turnId: string, outcome: TurnOutcome): void {
    const pending = this.#pending.get(threadId);
    if (pending?.turnId === turnId) pending.resolve(outcome);
  }

  interrupt(threadId: string, turnId: string): void {
    if (this.#pending.get(threadId)?.turnId === turnId) {
      this.fault(
        threadId,
        new ExternalSteerError(-32074, "External replacement was stopped before starting"),
      );
    }
  }

  fault(threadId: string, error: Error): void {
    this.#pending.get(threadId)?.reject(error);
  }

  close(): void {
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      pending.reject(
        new ExternalSteerError(-32074, "External steering connection closed before replacement"),
      );
    }
    this.#receipts.clear();
  }

  async #replace(
    thread: SteeringThread,
    input: SteeringInput,
    start: (text: string) => Promise<ExternalSteerStarted>,
  ): Promise<ExternalSteerStarted> {
    const turnId = thread.activeTurnId;
    if (!turnId)
      throw new ExternalSteerError(-32074, "External steering must reference the active Turn");
    const terminal = Promise.withResolvers<TurnOutcome>();
    const failure = Promise.withResolvers<never>();
    let failureReason: Error | null = null;
    const pending: PendingSteer = {
      turnId: input.expectedTurnId,
      resolve: terminal.resolve,
      reject(error) {
        failureReason ??= error;
        failure.reject(error);
      },
    };
    // Register before cancel: an Adapter may publish its terminal event synchronously.
    this.#pending.set(thread.id, pending);
    const timeout = setTimeout(
      () =>
        pending.reject(
          new ExternalSteerError(
            -32074,
            "Timed out waiting for the previous External Turn to stop; replacement was not started",
          ),
        ),
      this.timeoutMs,
    );
    try {
      const cancelled = await Promise.race([
        thread.session.execute({ type: "turn.cancel", turnId }),
        failure.promise,
      ]);
      if (!cancelled.ok) throw new ExternalSteerError(-32074, cancelled.error.message);
      const outcome = await Promise.race([terminal.promise, failure.promise]);
      clearTimeout(timeout);
      // A terminal and a stop/fault may both settle before the await continuation.
      // Promise.race alone would prefer the already-fulfilled terminal in that case.
      if (failureReason) throw failureReason;
      if (this.#closed)
        throw new ExternalSteerError(-32074, "External steering connection is closed");
      if (outcome.status === "failed") throw new ExternalSteerError(-32074, outcome.error.message);
      if (thread.persistenceError)
        throw new ExternalSteerError(
          -32074,
          "Previous External Turn identity could not be persisted",
        );
      if (thread.running || thread.activeTurnId) {
        throw new ExternalSteerError(-32072, "Another External Turn started before replacement");
      }
      return await start(input.text);
    } finally {
      clearTimeout(timeout);
      if (this.#pending.get(thread.id) === pending) this.#pending.delete(thread.id);
    }
  }
}
