import type { SessionEventLike } from "@deepseek-ai/dsh-api-session-controller/client";

/** Transient chunks have integer keys in a separate range from durable Session seqs. */
export function eventKey(event: SessionEventLike): number {
  return event.type === "assistant/live-chunk" ? -event.order : event.seq;
}

/** Groups live chunks by render anchor, then orders ties by chunk arrival. */
export function compareEvents(left: SessionEventLike, right: SessionEventLike): number {
  return (
    left.seq - right.seq ||
    (left.type === "assistant/live-chunk" ? left.order : 0) -
      (right.type === "assistant/live-chunk" ? right.order : 0)
  );
}
