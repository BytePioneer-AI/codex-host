import { Buffer } from "node:buffer";
import type { HostTurnId } from "@codexhost/shared-contracts";
import { CodeBuddyError, record, text } from "./common.js";

/** Native ACP extension announced before a drain run with no Host request. */
export function readUnsolicitedTurn(update: Record<string, unknown>): string | undefined {
  if (update.sessionUpdate !== "session_info_update") return;
  const announcement = record(record(update._meta)["codebuddy.ai/unsolicitedTurn"]);
  return announcement.reason === "background_drain"
    ? text(announcement.requestId) || undefined
    : undefined;
}

/** All retained rounds, frames and waiting Interaction metadata share one allowance. */
class AutonomousBufferBudget {
  #frames = 0;
  #bytes = 0;

  hold(value: unknown): number {
    const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
    if (this.#frames >= 2_048 || this.#bytes + bytes > 4 * 1024 * 1024)
      throw new CodeBuddyError(
        "protocolError",
        "Native autonomous Turn output exceeded its buffer bound",
      );
    this.#frames += 1;
    this.#bytes += bytes;
    return bytes;
  }

  release(frames: number, bytes: number): void {
    this.#frames -= frames;
    this.#bytes -= bytes;
  }
}

class CodeBuddyAutonomousFrames {
  readonly #frames: Record<string, unknown>[] = [];
  #bytes = 0;
  constructor(readonly budget: AutonomousBufferBudget) {}

  push(frame: Record<string, unknown>): void {
    this.#bytes += this.budget.hold(frame);
    this.#frames.push(frame);
  }

  drain(): Record<string, unknown>[] {
    this.budget.release(this.#frames.length, this.#bytes);
    this.#bytes = 0;
    return this.#frames.splice(0);
  }
}

/** A live connection interval, not a persisted native Turn identity. */
export interface CodeBuddyAutonomousRound {
  readonly frames: CodeBuddyAutonomousFrames;
  readonly identity: Promise<HostTurnId | undefined>;
  readonly announcementBytes: number;
  terminalBytes?: number;
  ended: boolean;
  started: boolean;
  resolveIdentity(turnId: HostTurnId | undefined): void;
}

/** Owns live native intervals and their bounded wait for a public Turn. */
export class CodeBuddyAutonomousTurns {
  readonly #rounds: CodeBuddyAutonomousRound[] = [];
  readonly #budget = new AutonomousBufferBudget();
  #open: CodeBuddyAutonomousRound | undefined;

  announce(requestId: string): CodeBuddyAutonomousRound {
    if (this.#open) throw new CodeBuddyError("protocolError", "Native autonomous Turns overlapped");
    const announcementBytes = this.#budget.hold({
      sessionUpdate: "session_info_update",
      requestId,
    });
    const identity = Promise.withResolvers<HostTurnId | undefined>();
    const round: CodeBuddyAutonomousRound = {
      frames: new CodeBuddyAutonomousFrames(this.#budget),
      identity: identity.promise,
      resolveIdentity: identity.resolve,
      announcementBytes,
      ended: false,
      started: false,
    };
    this.#rounds.push(round);
    this.#open = round;
    return round;
  }

  /** IDs can be reused or change during admission; the connection interval owns the end. */
  end(requestId: string): CodeBuddyAutonomousRound | undefined {
    const round = this.#open;
    if (!round) return;
    round.terminalBytes = this.#budget.hold({ sessionUpdate: "session_end", requestId });
    round.ended = true;
    this.#open = undefined;
    return round;
  }

  start(round: CodeBuddyAutonomousRound, turnId: HostTurnId): void {
    round.started = true;
    round.resolveIdentity(turnId);
  }

  owner(): CodeBuddyAutonomousRound | undefined {
    return this.#open;
  }

  interactionIdentity(
    round: CodeBuddyAutonomousRound,
    request: unknown,
  ): Promise<HostTurnId | undefined> {
    const bytes = this.#budget.hold(request);
    return round.identity.finally(() => this.#budget.release(1, bytes));
  }

  next(): CodeBuddyAutonomousRound | undefined {
    return this.#rounds.find((round) => !round.started);
  }

  finish(round: CodeBuddyAutonomousRound): void {
    const index = this.#rounds.indexOf(round);
    if (index < 0) return;
    round.frames.drain();
    this.#budget.release(1, round.announcementBytes);
    if (round.terminalBytes !== undefined) this.#budget.release(1, round.terminalBytes);
    this.#rounds.splice(index, 1);
    if (this.#open === round) this.#open = undefined;
    round.resolveIdentity(undefined);
  }

  close(): void {
    for (const round of [...this.#rounds]) this.finish(round);
  }
}
