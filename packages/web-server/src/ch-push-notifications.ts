import type { HostClientUpdate } from "@codexhost/desktop-control";
import type { ChHostClient } from "./ch-host-client.ts";
import type { PushMessage, PushNotifier } from "./push.ts";
import { threadListTitle } from "./ch-thread-title.ts";

const INTERACTION_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
  "codexhost/thread/questions/updated",
]);

/** Push follows the shared Host, not browser history subscriptions. Only terminal
 * and interaction invalidations read a bounded snapshot; token deltas do not. */
export class ChPushNotifications {
  private readonly unsubscribe: () => void;
  private readonly reads = new Map<string, Promise<void>>();
  private readonly delivered = new Set<string>();
  private epoch: string | undefined;
  private sequence = 0;
  private generation = 0;
  private online = false;
  private closed = false;

  constructor(
    private readonly host: NonNullable<ChHostClient["realtime"]>,
    private readonly push: Pick<PushNotifier, "subscriptionCount" | "notify">,
  ) {
    this.unsubscribe = host.subscribe((event) => this.receive(event));
  }

  private receive(event: HostClientUpdate): void {
    if (this.closed) return;
    if (event.type === "connection") {
      this.online = event.online;
      if (!event.online) this.generation++;
      return;
    }
    if (event.type === "hello") {
      if (this.epoch !== event.cursor.epoch) {
        this.epoch = event.cursor.epoch;
        this.delivered.clear();
        this.sequence = 0;
        this.generation++;
      }
      // A full reset has no replay. Do not infer completions from old history.
      if (event.reset) this.sequence = event.cursor.sequence;
      return;
    }
    if (
      event.type !== "changed" ||
      event.cursor.epoch !== this.epoch ||
      event.cursor.sequence <= this.sequence
    )
      return;
    this.sequence = event.cursor.sequence;
    if (
      this.push.subscriptionCount === 0 ||
      (event.method !== "turn/completed" && !INTERACTION_METHODS.has(event.method))
    )
      return;
    const generation = this.generation;
    const reading = (this.reads.get(event.threadId) ?? Promise.resolve())
      .then(() => this.reconcile(event, generation))
      .catch((error: unknown) => {
        console.error("[push] Host notification failed", event.threadId, error);
      })
      .finally(() => {
        if (this.reads.get(event.threadId) === reading) this.reads.delete(event.threadId);
      });
    this.reads.set(event.threadId, reading);
  }

  private current(generation: number): boolean {
    return !this.closed && this.online && this.generation === generation;
  }

  private async reconcile(
    event: Extract<HostClientUpdate, { type: "changed" }>,
    generation: number,
  ): Promise<void> {
    if (!this.current(generation) || this.push.subscriptionCount === 0) return;
    const snapshot = await this.host.snapshot(event.threadId, { truncateToolOutput: true });
    if (!this.current(generation) || snapshot.cursor.epoch !== event.cursor.epoch) return;
    const title = threadListTitle({ ...snapshot.thread, id: event.threadId });
    const messages: Array<{ key: string; message: PushMessage }> = [];
    if (event.method === "turn/completed") {
      // The channel carries invalidations, not a Turn payload. Its page is newest first.
      const turn = snapshot.turnsPage.data.find((value) => value.status !== "inProgress");
      if (turn && (turn.status === "completed" || turn.status === "failed"))
        messages.push({
          key: JSON.stringify([event.cursor.epoch, event.threadId, "turn", turn.id]),
          message: {
            kind: turn.status === "failed" ? "error" : "turn",
            title,
            body: turn.status === "failed" ? "运行失败" : "已回复",
          },
        });
    }
    for (const pending of snapshot.interactions)
      messages.push({
        key: JSON.stringify([event.cursor.epoch, event.threadId, "interaction", pending.requestId]),
        message: {
          kind: pending.kind,
          title,
          body: pending.kind === "approval" ? "待授权" : "待回答",
        },
      });
    for (const { key, message } of messages) {
      if (!this.current(generation)) return;
      if (this.delivered.has(key)) continue;
      this.delivered.add(key);
      if (this.delivered.size > 512) {
        const oldest = this.delivered.values().next().value;
        if (oldest !== undefined) this.delivered.delete(oldest);
      }
      await this.push.notify({
        ...message,
        tag: event.threadId,
        sessionId: event.threadId,
        url: `./?session=${encodeURIComponent(event.threadId)}`,
      });
    }
  }

  close(): void {
    this.closed = true;
    this.unsubscribe();
    this.reads.clear();
    this.delivered.clear();
  }
}
