import { randomUUID } from "node:crypto";

import {
  hostItemIdSchema,
  restoreHarnessCommandMentions,
  THREAD_STEER_DELIVERY_PARAM,
  threadSteerDeliverySchema,
  type HarnessSessionCapabilities,
  type HostTurnId,
  type ThreadSteerDelivery,
} from "@codexhost/shared-contracts";
import type { JsonObject } from "@codexhost/protocol-core";
import type {
  HarnessResult,
  HarnessSession,
  HostTextInput,
  HostUserMessageItem,
  TurnCancelAccepted,
  TurnCancelCommand,
  TurnOutcome,
  TurnSteerAccepted,
  TurnSteerCommand,
} from "@codexhost/harness-adapter";

import { rewriteDelegationMentionText } from "./delegation-mention-rewrite.js";
import { isExternalCommandCandidate } from "./external-command-routing.js";
import type { TurnProjectionGate } from "./external-thread-runtime.js";

interface SteeringThread {
  id: string;
  running: boolean;
  activeTurnId: HostTurnId | null;
  persistenceError: Error | null;
  session: {
    readonly capabilities: Pick<HarnessSessionCapabilities, "steer">;
    readonly commands?: HarnessSession["commands"];
    readCapabilities?: HarnessSession["readCapabilities"];
    execute(command: TurnCancelCommand): Promise<HarnessResult<TurnCancelAccepted>>;
  };
}

/** A Thread whose Session can take native same-Turn input. */
export interface NativeSteeringThread {
  pendingSteerProjections: Set<Promise<void>>;
  steeredTurnIds: Set<HostTurnId>;
  session: {
    execute(command: TurnSteerCommand): Promise<HarnessResult<TurnSteerAccepted>>;
  };
}

/** A Harness command keeps the stop-then-start path, which resolves and runs commands. */
function isHarnessCommand(thread: SteeringThread, text: string): boolean {
  return (
    thread.session.commands !== undefined &&
    isExternalCommandCandidate(restoreHarnessCommandMentions(text))
  );
}

/**
 * The delivery a steer submitted now would use. Native delivery needs the Session to report it
 * can take input into the running Turn now; commands and every other case stop and restart.
 */
export function externalSteeringDelivery(
  thread: SteeringThread,
  text?: string,
): ThreadSteerDelivery | Promise<ThreadSteerDelivery> {
  if (text !== undefined && isHarnessCommand(thread, text)) return "newTurn";
  if (thread.session.readCapabilities) {
    return thread.session
      .readCapabilities()
      .then((capabilities) => (capabilities.steer === true ? "activeTurn" : "newTurn"));
  }
  return thread.session.capabilities.steer === true ? "activeTurn" : "newTurn";
}

export class ExternalSteerError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

/** The Harness did not take native same-Turn input, so stopping and restarting is still safe. */
export class ExternalSteerNotTakenError extends ExternalSteerError {
  constructor(message: string) {
    super(-32074, message);
  }
}

interface SteeringInput {
  expectedTurnId: string;
  clientUserMessageId?: string;
  text: string;
  /** The delivery a Renderer already presented; absent for clients without one. */
  delivery?: ThreadSteerDelivery;
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
  const delivery = params[THREAD_STEER_DELIVERY_PARAM];
  const parsedDelivery =
    delivery == null ? undefined : threadSteerDeliverySchema.safeParse(delivery);
  if (parsedDelivery && !parsedDelivery.success) {
    throw new ExternalSteerError(-32602, "External steering delivery is invalid");
  }
  return {
    expectedTurnId: params.expectedTurnId,
    text,
    ...(typeof clientUserMessageId === "string" ? { clientUserMessageId } : {}),
    ...(parsedDelivery ? { delivery: parsedDelivery.data } : {}),
  };
}

/**
 * Hands steered input to the Harness's native insertion primitive. Once the Harness takes it,
 * the Host shows it in that Turn: the Harness receives rewritten Delegation mentions, Desktop
 * shows what the user typed, as on the `turn/start` path. A Harness refusal means the input was
 * not taken and is reported as {@link ExternalSteerNotTakenError}.
 */
export async function insertNativeSteer(
  thread: NativeSteeringThread,
  input: { turnId: HostTurnId; text: string; clientUserMessageId?: string },
  host: {
    project(
      turnId: HostTurnId,
      item: HostUserMessageItem,
      clientUserMessageId?: string,
    ): Promise<void>;
    diagnose(error: unknown): void;
  },
): Promise<void> {
  const restored = restoreHarnessCommandMentions(input.text);
  const steered: HostTextInput[] = [{ type: "text", text: rewriteDelegationMentionText(restored) }];
  const displayed: HostTextInput[] = [{ type: "text", text: restored }];
  const projectionDone = Promise.withResolvers<undefined>();
  thread.pendingSteerProjections.add(projectionDone.promise);
  try {
    const result = await thread.session.execute({
      type: "turn.steer",
      turnId: input.turnId,
      input: steered,
    });
    if (!result.ok) throw new ExternalSteerNotTakenError(result.error.message);
    thread.steeredTurnIds.add(input.turnId);
    const item: HostUserMessageItem = {
      type: "userMessage",
      itemId: hostItemIdSchema.parse(randomUUID()),
      input: displayed,
    };
    try {
      await host.project(input.turnId, item, input.clientUserMessageId);
    } catch (error) {
      // Native delivery already succeeded. Reporting failure here would invite a duplicate retry.
      host.diagnose(error);
    }
  } finally {
    projectionDone.resolve(undefined);
    thread.pendingSteerProjections.delete(projectionDone.promise);
  }
}

export interface ExternalTurnAdmission {
  turnId: HostTurnId;
  gate: TurnProjectionGate;
}

/** `activeTurn`: native same-Turn input; `newTurn`: the previous Turn stopped and this one started. */
export interface ExternalSteerStarted extends ExternalTurnAdmission {
  delivery: "activeTurn" | "newTurn";
}

type StartSteeredTurn = (text: string, assertActive: () => void) => Promise<ExternalTurnAdmission>;
type InsertSteeredInput = (input: {
  turnId: HostTurnId;
  text: string;
  clientUserMessageId?: string;
}) => Promise<ExternalTurnAdmission>;

interface PendingSteer {
  turnId: string;
  resolve(outcome: TurnOutcome): void;
  reject(error: Error): void;
}

/**
 * The Host's single steer operation. A Session declaring native steering takes the input into
 * its active Turn; otherwise the Host stops that Turn and starts the input as the next one.
 */
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
    start: StartSteeredTurn,
    insert: InsertSteeredInput,
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
      const result = this.#deliver(thread, input, start, insert);
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

  /**
   * A Renderer that already presented a delivery gets exactly that one. Otherwise native delivery
   * is tried only when the Session can take the input now, and input the Harness did not take
   * falls back to stopping and restarting, so no case is worse than the stop-then-start path.
   */
  #deliver(
    thread: SteeringThread,
    input: SteeringInput,
    start: StartSteeredTurn,
    insert: InsertSteeredInput,
  ): Promise<ExternalSteerStarted> {
    const delivery =
      input.delivery === "newTurn" || isHarnessCommand(thread, input.text)
        ? "newTurn"
        : (input.delivery ?? externalSteeringDelivery(thread));
    const deliver = (mode: ThreadSteerDelivery): Promise<ExternalSteerStarted> => {
      // A broker capability read may have yielded while the target ended or another request won.
      if (this.#closed || !thread.running || thread.activeTurnId !== input.expectedTurnId) {
        throw new ExternalSteerError(-32074, "External steering target is no longer active");
      }
      if (this.hasPending(thread.id))
        throw new ExternalSteerError(-32072, "External Thread is already changing direction");
      if (mode === "newTurn") return this.#replace(thread, input, start);
      const native = insert({
        turnId: thread.activeTurnId,
        text: input.text,
        ...(input.clientUserMessageId ? { clientUserMessageId: input.clientUserMessageId } : {}),
      }).then((admitted) => ({ ...admitted, delivery: "activeTurn" as const }));
      if (input.delivery === "activeTurn") return native;
      return native.catch(async (error: unknown) => {
        if (!(error instanceof ExternalSteerNotTakenError)) throw error;
        if (thread.running || thread.activeTurnId) return deliver("newTurn");
        // The Turn ended meanwhile; nothing is left to stop, so start the input as the next Turn.
        const assertActive = (): void => {
          if (this.#closed)
            throw new ExternalSteerError(-32074, "External steering connection is closed");
        };
        return { ...(await start(input.text, assertActive)), delivery: "newTurn" as const };
      });
    };
    if (typeof delivery === "string") return deliver(delivery);
    // Reserve the Thread while a remote read is pending, just as during stop-then-start.
    const failure = Promise.withResolvers<never>();
    let failureReason: Error | null = null;
    const pending: PendingSteer = {
      turnId: input.expectedTurnId,
      resolve: () => undefined,
      reject(error) {
        failureReason ??= error;
        failure.reject(error);
      },
    };
    this.#pending.set(thread.id, pending);
    return Promise.race([delivery, failure.promise])
      .then((mode) => {
        if (failureReason) throw failureReason;
        if (this.#pending.get(thread.id) === pending) this.#pending.delete(thread.id);
        return deliver(mode);
      })
      .finally(() => {
        if (this.#pending.get(thread.id) === pending) this.#pending.delete(thread.id);
      });
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
    start: StartSteeredTurn,
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
      // A Turn that is already ending (for example after its native steer was not taken) refuses
      // the cancel as inactive; its terminal still follows, so keep waiting for it.
      if (!cancelled.ok && cancelled.error.code !== "invalidState") {
        throw new ExternalSteerError(-32074, cancelled.error.message);
      }
      const outcome = await Promise.race([terminal.promise, failure.promise]);
      clearTimeout(timeout);
      // A terminal and a stop/fault may both settle before the await continuation.
      // Promise.race alone would prefer the already-fulfilled terminal in that case.
      const assertActive = (): void => {
        if (failureReason) throw failureReason;
        if (this.#closed)
          throw new ExternalSteerError(-32074, "External steering connection is closed");
      };
      assertActive();
      if (outcome.status === "failed") throw new ExternalSteerError(-32074, outcome.error.message);
      if (thread.persistenceError)
        throw new ExternalSteerError(
          -32074,
          "Previous External Turn identity could not be persisted",
        );
      if (thread.running || thread.activeTurnId) {
        throw new ExternalSteerError(-32072, "Another External Turn started before replacement");
      }
      // Command discovery can await native data. Recheck cancellation after
      // that await, immediately before the replacement actually executes.
      return { ...(await start(input.text, assertActive)), delivery: "newTurn" };
    } finally {
      clearTimeout(timeout);
      if (this.#pending.get(thread.id) === pending) this.#pending.delete(thread.id);
    }
  }
}
