/** Session readiness and Turn boundary helpers for Composer-initiated context handoff. */
import type { HarnessHandoffStatus } from "./slots.ts";

export interface TurnEndLikeEvent {
  readonly type: string;
  readonly seq?: number;
  readonly data?: { readonly reason?: { readonly kind?: string } };
}

export interface HandoffEventWindowLike {
  readonly hasMore: boolean;
  readonly entries: readonly { readonly event: TurnEndLikeEvent }[];
}

export interface HandoffSessionSnapshotLike {
  readonly openState: string;
}

export interface ResolvedHandoffPoint {
  readonly status: Exclude<HarnessHandoffStatus, "unsupported">;
  /** Set only when the latest ended Turn is incomplete and an earlier completed Turn exists. */
  readonly atSeq?: number;
}

/** Derive whether a local bound session has a completed Turn ready for context handoff. */
export function resolveHandoffPoint(
  session: HandoffSessionSnapshotLike | undefined,
  window: HandoffEventWindowLike | undefined,
): ResolvedHandoffPoint {
  if (session === undefined || window === undefined || session.openState !== "open") {
    return { status: "pending" };
  }
  let lastTurnEnd: TurnEndLikeEvent | undefined;
  let lastCompletedSeq: number | undefined;
  for (let i = window.entries.length - 1; i >= 0; i -= 1) {
    const event = window.entries[i]?.event;
    if (event?.type !== "turn/end") continue;
    lastTurnEnd ??= event;
    if (event.data?.reason?.kind === "completed" && typeof event.seq === "number") {
      lastCompletedSeq = event.seq;
      break;
    }
  }
  if (lastTurnEnd === undefined) {
    return window.hasMore ? { status: "ready" } : { status: "pending" };
  }
  if (lastTurnEnd.data?.reason?.kind === "completed") {
    return { status: "ready" };
  }
  if (lastCompletedSeq !== undefined) {
    return { status: "ready", atSeq: lastCompletedSeq };
  }
  return window.hasMore ? { status: "ready" } : { status: "pending" };
}
