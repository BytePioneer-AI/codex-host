/** Web edit orchestration over the same revert/start operations used by Desktop. */
import { randomUUID } from "node:crypto";
import { threadInspectionSchema } from "@codexhost/shared-contracts";
import type { ChHostClient } from "./ch-host-client.ts";
import type { ChThreadHistory } from "./ch-thread-history.ts";
import { editedNativeInput } from "./native-user-input.ts";
import { RpcError } from "./transport.ts";

export interface EditReceipt {
  status: "accepted" | "rejected" | "unconfirmed" | "reverted";
  message?: string;
}

/** Prevent overlapping edits of one Thread; other operations keep their existing Host checks. */
export class ChThreadEditing {
  private readonly busy = new Set<string>();
  async edit(input: {
    host: ChHostClient;
    threadId: string;
    seq: number;
    text: string;
    displayed: ChThreadHistory | undefined;
    read: () => Promise<ChThreadHistory>;
    reconcile: () => Promise<void>;
  }): Promise<EditReceipt> {
    const { host, threadId, displayed } = input;
    if (this.busy.has(threadId))
      throw new RpcError("session/busy", "A sent message edit is in progress.");
    this.busy.add(threadId);
    let dispatched = false;
    let reverted = false;
    try {
      if (!displayed) throw new Error("Edit history expired. Reopen the conversation.");
      const owner = threadInspectionSchema.parse(
        await host.request("codexhost/thread/inspect", { threadId }),
      );
      if (owner.owner !== "external" || !owner.history.rollbackLastTurn)
        throw new Error("This Harness does not support editing the last sent message.");
      const view = await input.read();
      if (
        view !== displayed ||
        view.thread.parentThreadId ||
        view.thread.canAcceptDirectInput === false
      )
        throw new Error(
          "Edit history changed or this Thread is read-only. Reopen the conversation.",
        );
      const target = view.editableMessage();
      if (!target || target.seq !== input.seq)
        throw new Error("Only the latest settled message can be edited. Refresh its history.");
      const queue = await host.request<{ data: unknown[]; nextCursor: string | null }>(
        "thread/queue/list",
        { threadId },
      );
      if (queue.data.length || queue.nextCursor)
        throw new Error("Clear pending queued messages before editing history.");
      // Resolve again after asynchronous checks; a retired or advanced view must fail closed.
      if (view.editableMessage()?.turnId !== target.turnId)
        throw new Error("The edit boundary changed. Reopen the conversation.");
      const nativeInput = editedNativeInput(target.input, input.text);
      if (!nativeInput) throw new Error("This message's input structure cannot be edited safely.");
      dispatched = true;
      const response = await host.request<{ thread: { id: string } }>("thread/revert", {
        threadId,
        beforeTurnId: target.turnId,
      });
      if (response.thread?.id !== threadId)
        throw new Error("Host did not confirm the reverted Thread.");
      reverted = true;
      // No queue delivery and no retry: Host rejects an active operation from another client.
      await host.request("turn/start", {
        threadId,
        input: nativeInput,
        clientUserMessageId: randomUUID(),
      });
      return { status: "accepted" };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        status: reverted ? "reverted" : dispatched ? "unconfirmed" : "rejected",
        message: reverted
          ? `Host confirmed the rollback, but did not confirm the rerun. ${reason} No automatic resend; check current history.`
          : dispatched
            ? `Host did not confirm the edit. ${reason} No automatic resend; check current history.`
            : reason,
      };
    } finally {
      this.busy.delete(threadId);
      if (dispatched) await input.reconcile().catch(() => undefined);
    }
  }
}
