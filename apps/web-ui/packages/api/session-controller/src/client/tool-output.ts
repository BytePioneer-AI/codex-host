/** Explicit tool-output reads; successful values and concurrent reads share one session-local key. */
import type { WebToolOutputReference } from "@codexhost/shared-contracts";
import type { SessionRemotes } from "./sessions/remotes.ts";

export class ToolOutputCache {
  readonly values: Map<string, string>;
  private readonly pending = new Map<string, Promise<string>>();

  constructor(
    private readonly readRemote: SessionRemotes["session"]["toolOutput"],
    initial?: ReadonlyMap<string, string>,
  ) {
    this.values = new Map(initial);
  }

  read(ref: WebToolOutputReference): Promise<string> {
    const key = JSON.stringify([
      ref.sessionId,
      ref.epoch,
      ref.turn,
      ref.seq,
      ref.callId,
      ref.part,
      ref.version,
    ]);
    const held = this.values.get(key);
    if (held !== undefined) return Promise.resolve(held);
    const pending = this.pending.get(key);
    if (pending) return pending;
    const request = this.readRemote(ref)
      .then((result) => {
        if (!result.ok) throw result.error;
        this.values.set(key, result.value.text);
        return result.value.text;
      })
      .finally(() => {
        this.pending.delete(key);
      });
    this.pending.set(key, request);
    return request;
  }
}
