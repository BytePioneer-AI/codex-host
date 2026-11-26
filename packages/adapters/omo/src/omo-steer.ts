/**
 * Native same-Turn steering for OmO Sessions, following the OMP safe-window
 * pattern (docs/harnesses/omp/omp-steer.md) and the Host's delivery contract
 * (docs/architecture/external-thread-steering.md).
 *
 * Safe window: OmO's `steer` command queues input that is delivered after the
 * running assistant message finishes its tool batch, before the next model
 * request. That makes the window safe only while the engine is executing a
 * root tool call: the run is still live, and the input provably joins it.
 * {@link OmoSteerWindow} follows the `tool_execution_start` /
 * `tool_execution_end` stream and is open exactly while at least one tool call
 * of the active Turn is executing. Text output, idle, and terminal phases keep
 * it closed; the Host then uses its stop-and-resend path instead.
 *
 * Delivery semantics (never blind-resend):
 *
 * - A correlated `success:false` answer means the engine did not take the
 *   input; {@link OmoSteerRejectedError} lets the Session report a typed
 *   refusal, which lets the Host fall back to stopping and restarting.
 * - `turn_conflict` is the native `expectedTurnId` guard refusing an input for
 *   a Turn that is no longer running. It is the same class of refusal and is
 *   queued nowhere natively.
 * - A write whose answer never arrives (timeout, transport fault, process
 *   exit, or a `handled` disposition that bypassed the queue) may already have
 *   consumed the input. {@link OmoSteerDeliveryUncertainError} is thrown, never
 *   returned as `ok: false`, so the Host records an unknown outcome instead of
 *   replaying the text.
 * - An answer that arrives after the target Turn settled cannot be attributed
 *   to that Turn: the engine may have queued it for a later turn.
 *   {@link OmoSteerTargetEndedError} is thrown; the Session preserves the
 *   historical Turn and closes the native process so the queued text cannot run
 *   as a phantom turn.
 *
 * Settlement reconciliation: a steered Turn persists one user entry for the
 * prompt plus one for each accepted steer. {@link reconcileOmoSteerSettlement}
 * proves that count from history; a missing entry means an accepted steer was
 * not applied, and an extra entry means the Turn consumed input this Session
 * never admitted. Both are protocol failures, never silent success.
 */

import { OmoRpcResponseError } from "./omo-rpc-session.js";

/**
 * Tracks the native root-tool window of the active Turn.
 *
 * The classic RPC surface reports `tool_execution_start` / `tool_execution_end`
 * per call id. Sessions on this transport declare no subagent capability, so
 * every reported execution is a root call. A duplicate start is counted once;
 * an end for an unknown call is ignored so a late/interrupted record cannot
 * close a live window. {@link close} is final: cancellation, settlement, fault,
 * and close end the window for the rest of the Turn.
 */
export class OmoSteerWindow {
  readonly #openTools = new Set<string>();
  #closed = false;

  /** True exactly while a tool call of this Turn is executing. */
  get isOpen(): boolean {
    return !this.#closed && this.#openTools.size > 0;
  }

  /** Number of tool calls currently open; diagnostics and tests only. */
  get openToolCount(): number {
    return this.#openTools.size;
  }

  toolStarted(callId: string): void {
    if (this.#closed) return;
    this.#openTools.add(callId);
  }

  toolEnded(callId: string): void {
    this.#openTools.delete(callId);
  }

  /** Ends the window and every future open; idempotent. */
  close(): void {
    this.#closed = true;
    this.#openTools.clear();
  }
}

/** The engine answered that it did not take the steer; the input was not queued. */
export class OmoSteerRejectedError extends Error {
  readonly refusal: OmoRpcResponseError | undefined;

  constructor(message: string, refusal?: OmoRpcResponseError) {
    super(message);
    this.name = "OmoSteerRejectedError";
    this.refusal = refusal;
  }
}

/** The steer may have been consumed; the answer is unknown. Never invite a replay. */
export class OmoSteerDeliveryUncertainError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OmoSteerDeliveryUncertainError";
  }
}

/** The target Turn settled before its steer admission could be confirmed. */
export class OmoSteerTargetEndedError extends Error {
  constructor(
    message = "OmO Turn ended before steer admission could be confirmed. Delivery is unknown; do not automatically resend the input",
  ) {
    super(message);
    this.name = "OmoSteerTargetEndedError";
  }
}

/** History persisted a different number of user entries than this Turn admitted. */
export class OmoSteerSettlementError extends Error {
  constructor(
    readonly expectedUserEntries: number,
    readonly persistedUserEntries: number,
  ) {
    super(
      `OmO Turn persisted ${persistedUserEntries} new User Entries; exactly ${expectedUserEntries} is required (the prompt plus each accepted steer)`,
    );
    this.name = "OmoSteerSettlementError";
  }
}

/**
 * Proves that the new user entries of a settled Turn are exactly the prompt
 * plus the steers this Session accepted into it. The first entry stays the
 * Turn's identity.
 */
export function reconcileOmoSteerSettlement(
  userEntryIds: readonly string[],
  acceptedSteerCount: number,
): void {
  const expected = 1 + Math.max(0, acceptedSteerCount);
  if (userEntryIds.length !== expected) {
    throw new OmoSteerSettlementError(expected, userEntryIds.length);
  }
}

/** Writes one `steer` command and resolves with its correlated answer. */
export type OmoSteerSend = (
  payload: Readonly<Record<string, unknown>>,
) => Promise<{ readonly data?: unknown }>;

export interface OmoSteerAdmissionOptions {
  /** The Turn's tool window; open right before the write, or nothing is sent. */
  readonly window: OmoSteerWindow;
  readonly text: string;
  /** `get_state.currentTurnId`-form engine turn id the steer must join. */
  readonly expectedTurnId: string;
  /** Durable client Turn id, so continuation events stay attributable. */
  readonly clientTurnId?: string;
  readonly send: OmoSteerSend;
  /**
   * Frame-order receipt check: true while this steer's target Turn still runs
   * and has not begun settling. Must be synchronous.
   */
  readonly targetActive: () => boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * One steer admission for the active Turn.
 *
 * Resolves only after the engine queued the text into the target Turn. Throws
 * {@link OmoSteerRejectedError} when nothing was queued,
 * {@link OmoSteerTargetEndedError} when the target settled before the answer,
 * and {@link OmoSteerDeliveryUncertainError} for every unknown outcome.
 */
export async function admitOmoSteer(options: OmoSteerAdmissionOptions): Promise<void> {
  // The window check is the write's precondition, not a cached decision: the
  // Host read the capability before this call and the Turn may have moved on.
  if (!options.window.isOpen) {
    throw new OmoSteerRejectedError("OmO Turn is not accepting native input");
  }
  if (options.expectedTurnId.trim().length === 0) {
    throw new OmoSteerRejectedError("OmO steer requires the running native Turn id");
  }

  let response: { readonly data?: unknown };
  try {
    response = await options.send({
      message: options.text,
      expectedTurnId: options.expectedTurnId,
      ...(options.clientTurnId ? { clientTurnId: options.clientTurnId } : {}),
    });
  } catch (error) {
    if (error instanceof OmoRpcResponseError) {
      // The engine answered for this command and refused it: nothing was queued.
      throw new OmoSteerRejectedError(error.message, error);
    }
    // The frame was written and no answer followed (timeout, fault, exit,
    // framing). The engine may have consumed it.
    throw new OmoSteerDeliveryUncertainError(
      `OmO steer delivery is unknown: ${error instanceof Error ? error.message : String(error)}`,
      error instanceof Error ? { cause: error } : undefined,
    );
  }

  if (!options.targetActive()) {
    // The answer is for a Turn that already settled. The text may be queued for
    // a later turn, so this is not an "engine refused it" refusal.
    throw new OmoSteerTargetEndedError();
  }

  const disposition = isRecord(response.data) ? response.data.disposition : undefined;
  if (disposition !== undefined && disposition !== "queued") {
    // An input handler consumed it, or the engine reported an admission this
    // adapter cannot attribute to the running Turn. Retrying could repeat
    // handler effects.
    throw new OmoSteerDeliveryUncertainError(
      `OmO steer was handled without confirming same-Turn queue admission (disposition: ${String(disposition)})`,
    );
  }
}
