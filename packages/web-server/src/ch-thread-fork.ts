/** Ordinary same-cwd forks: CH alone owns native derivation and persistence. */
import {
  externalThreadForkResultSchema,
  threadInspectionSchema,
} from "@codexhost/shared-contracts";
import type { ChHostClient } from "./ch-host-client.ts";
import type { ChThreadView } from "./ch-thread-view.ts";
import { RpcError } from "./transport.ts";

export function forkUnavailable(sessionId: string, message: string): never {
  throw new RpcError("session/fork-unavailable", message, { sessionId });
}

export async function forkChThread(
  host: ChHostClient,
  view: ChThreadView,
  atSeq?: number,
): Promise<{ sessionId: string }> {
  const threadId = view.thread.id;
  const owner = threadInspectionSchema.parse(
    await host.request("codexhost/thread/inspect", { threadId }),
  );
  if (owner.history?.fork === false)
    return forkUnavailable(threadId, "This Thread does not support native forking.");
  // Resolve after inspection so a retired view cannot authorize a stale boundary.
  const lastTurnId = view.forkTurnId(atSeq);
  if (!lastTurnId)
    return forkUnavailable(
      threadId,
      "No completed Turn exists at this fork point. Reopen the conversation.",
    );
  // No cwd/worktree overrides, history copying, or write retries in the Web gateway.
  if (owner.owner === "codex") {
    const result = await host.request<{ thread?: { id?: unknown } }>("thread/fork", {
      threadId,
      lastTurnId,
      excludeTurns: true,
    });
    const id = result?.thread?.id;
    if (typeof id !== "string" || !id.trim() || id === threadId)
      throw new RpcError(
        "session/fork-unconfirmed",
        "Codex did not confirm a distinct forked Thread. Do not retry automatically.",
        { sessionId: threadId },
      );
    return { sessionId: id };
  }
  const result = externalThreadForkResultSchema.parse(
    await host.request("codexhost/thread/fork", { threadId, lastTurnId }),
  );
  return { sessionId: result.threadId };
}
