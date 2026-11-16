import type { HostTurnSnapshot } from "@codexhost/harness-adapter";
import type { HostTurnId } from "@codexhost/shared-contracts";
import { CodeBuddyError, record, text } from "./common.js";

/** Native ACP extension announced before a drain run that no Host `turn.start` requested. */
export interface CodeBuddyUnsolicitedTurn {
  readonly requestId: string;
  readonly reason: "background_drain";
}

/** Ordered native frames held while a drain Turn waits for its public identity. */
const FRAME_LIMIT = 2_048;
const BYTE_LIMIT = 4 * 1024 * 1024;

/**
 * Reads the native unsolicited Turn announcement. ACP clients must open a new Request for
 * this `requestId` instead of waiting for a user message or discarding an idle frame.
 */
export function readUnsolicitedTurn(
  update: Record<string, unknown>,
): CodeBuddyUnsolicitedTurn | undefined {
  if (update.sessionUpdate !== "session_info_update") return;
  const announcement = record(record(update._meta)["codebuddy.ai/unsolicitedTurn"]);
  const requestId = text(announcement.requestId);
  return requestId && announcement.reason === "background_drain"
    ? { requestId, reason: "background_drain" }
    : undefined;
}

/** Native request identity carried by every frame of one Turn, including `session_end`. */
export function requestIdOf(update: Record<string, unknown>): string {
  return text(record(update._meta)["codebuddy.ai/requestId"]);
}

class CodeBuddyAutonomousFrames {
  readonly #frames: Record<string, unknown>[] = [];
  #bytes = 0;

  push(frame: Record<string, unknown>): void {
    const bytes = JSON.stringify(frame).length;
    if (this.#frames.length >= FRAME_LIMIT || this.#bytes + bytes > BYTE_LIMIT)
      throw new CodeBuddyError(
        "protocolError",
        "Native autonomous Turn output exceeded its buffer bound",
      );
    this.#frames.push(frame);
    this.#bytes += bytes;
  }

  drain(): Record<string, unknown>[] {
    const frames = this.#frames.splice(0);
    this.#bytes = 0;
    return frames;
  }
}

/** One native drain run, from its announcement to its `session_end`. */
export interface CodeBuddyAutonomousRound {
  readonly requestId: string;
  readonly frames: CodeBuddyAutonomousFrames;
  /** Resolves with the public Turn ID once claimed, or `undefined` when dropped. */
  readonly identity: Promise<HostTurnId | undefined>;
  ended: boolean;
  started: boolean;
  resolveIdentity(turnId: HostTurnId | undefined): void;
}

const turnKey = (turn: HostTurnSnapshot) => turn.nativeTurnRef.nativeTurnKey;

/**
 * Owns native drain Turn ordering and the boundary between native history and public Turns.
 *
 * Native drain rounds are strictly serial: an announcement may only follow the previous
 * round's `session_end`, even while the Session is still publishing that round. Persisted
 * Turns are consumed in native order from the last owned boundary, never by Host clock time.
 * Host-requested Turns claim their own persisted Turn first, so a drain that is persisted
 * before the Host terminal snapshot cannot be mistaken for the Host Turn.
 */
export class CodeBuddyAutonomousTurns {
  readonly #rounds: CodeBuddyAutonomousRound[] = [];
  readonly #owned = new Set<string>();
  #active: CodeBuddyAutonomousRound | undefined;
  #cursor: string | undefined;

  /** Establishes the boundary after already-persisted history, once per Session process. */
  reset(turns: readonly HostTurnSnapshot[]): void {
    const last = turns.at(-1);
    this.#cursor = last ? turnKey(last) : undefined;
  }

  announce(requestId: string): CodeBuddyAutonomousRound {
    const open = this.#rounds.at(-1);
    if (open && !open.ended)
      throw new CodeBuddyError("protocolError", "Native autonomous Turns overlapped");
    const identity = Promise.withResolvers<HostTurnId | undefined>();
    const round: CodeBuddyAutonomousRound = {
      requestId,
      frames: new CodeBuddyAutonomousFrames(),
      identity: identity.promise,
      resolveIdentity: identity.resolve,
      ended: false,
      started: false,
    };
    this.#rounds.push(round);
    return round;
  }

  /** Marks the open round's native end; rounds after it may now be announced. */
  end(requestId: string): CodeBuddyAutonomousRound | undefined {
    const open = this.#rounds.find((round) => !round.ended);
    if (!open || (requestId && open.requestId !== requestId)) return undefined;
    open.ended = true;
    return open;
  }

  start(round: CodeBuddyAutonomousRound, turnId: HostTurnId): void {
    round.started = true;
    this.#active = round;
    round.resolveIdentity(turnId);
  }

  /** Returns the publicly active round, a queued round to buffer for, or nothing. */
  route(update: Record<string, unknown>): CodeBuddyAutonomousRound | "active" | undefined {
    if (this.#active) return "active";
    const requestId = requestIdOf(update);
    return requestId
      ? this.#rounds.find((round) => !round.started && round.requestId === requestId)
      : undefined;
  }

  /** The round that owns a native Interaction: the active or currently open drain run. */
  owner(): CodeBuddyAutonomousRound | undefined {
    if (this.#active && !this.#active.ended) return this.#active;
    return this.#rounds.findLast((round) => !round.ended);
  }

  /** Claims the next round for publication, once no other public Turn owns the Session. */
  next(): CodeBuddyAutonomousRound | undefined {
    return this.#rounds.find((round) => !round.started);
  }

  finish(round: CodeBuddyAutonomousRound): void {
    const index = this.#rounds.indexOf(round);
    if (index >= 0) this.#rounds.splice(index, 1);
    if (this.#active === round) this.#active = undefined;
    round.resolveIdentity(undefined);
  }

  close(): void {
    for (const round of this.#rounds) round.resolveIdentity(undefined);
    this.#rounds.length = 0;
    this.#active = undefined;
  }

  /**
   * Claims the persisted Turn of a Host request. `userMessageId` is the native identity from
   * the prompt response; clients that omit it use the next unowned user Turn in native order.
   */
  ownHostTurn(
    turns: readonly HostTurnSnapshot[],
    userMessageId: string | undefined,
  ): HostTurnSnapshot | undefined {
    const turn =
      (userMessageId ? turns.find((turn) => turnKey(turn) === userMessageId) : undefined) ??
      (userMessageId ? undefined : this.#nextTurn(turns, (turn) => turn.input.length > 0));
    if (turn) this.#own(turn);
    return turn;
  }

  /**
   * Claims the persisted Turn of the oldest drain round. A drain Turn is opened by hidden
   * native input, so a user-input Turn that a Host request has not claimed yet is skipped.
   */
  autonomousTurn(turns: readonly HostTurnSnapshot[]): HostTurnSnapshot | undefined {
    const turn = this.#nextTurn(turns, (turn) => turn.input.length === 0);
    if (turn) this.#own(turn);
    return turn;
  }

  #nextTurn(
    turns: readonly HostTurnSnapshot[],
    match: (turn: HostTurnSnapshot) => boolean,
  ): HostTurnSnapshot | undefined {
    let start = 0;
    if (this.#cursor !== undefined) {
      const index = turns.findIndex((turn) => turnKey(turn) === this.#cursor);
      // An unreachable boundary means history no longer reflects the consumed order.
      if (index < 0) return undefined;
      start = index + 1;
    }
    for (const turn of turns.slice(start)) {
      if (this.#owned.has(turnKey(turn)) || !match(turn)) continue;
      return turn;
    }
    return undefined;
  }

  #own(turn: HostTurnSnapshot): void {
    const key = turnKey(turn);
    this.#owned.add(key);
    this.#cursor = key;
  }
}
