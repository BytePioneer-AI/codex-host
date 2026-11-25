/** Cross-Harness context handoff: Host owns extraction, creation, injection, and persistence. */
import {
  THREAD_HANDOFF_METHOD,
  threadHandoffParamsSchema,
  threadHandoffResultSchema,
  type ThreadHandoffMetadata,
} from "@codexhost/shared-contracts";
import type { ChHostClient } from "./ch-host-client.ts";
import type { ChThreadView } from "./ch-thread-view.ts";
import { RpcError } from "./transport.ts";

export interface HandoffChThreadInput {
  atSeq?: number;
  targetHarnessId: string;
  targetModel?: string;
  targetThinkingOptionId?: string;
}

export function handoffUnavailable(sessionId: string, message: string): never {
  throw new RpcError("session/handoff-unavailable", message, { sessionId });
}

export async function handoffChThread(
  host: ChHostClient,
  view: ChThreadView,
  input: HandoffChThreadInput,
): Promise<{ sessionId: string; handoff: ThreadHandoffMetadata }> {
  const threadId = view.thread.id;
  // Resolve boundary from the current view so a retired window cannot hand off a stale cut.
  const lastTurnId = view.forkTurnId(input.atSeq);
  if (!lastTurnId) {
    return handoffUnavailable(
      threadId,
      "No completed Turn exists at this handoff point. Reopen the conversation.",
    );
  }
  const params = threadHandoffParamsSchema.safeParse({
    sourceThreadId: threadId,
    lastTurnId,
    targetHarnessId: input.targetHarnessId,
    ...(input.targetModel !== undefined ? { targetModel: input.targetModel } : {}),
    ...(input.targetThinkingOptionId !== undefined
      ? { targetThinkingOptionId: input.targetThinkingOptionId }
      : {}),
  });
  if (!params.success) {
    throw new RpcError("session/handoff-invalid", "Invalid handoff request.");
  }
  const raw = await host.request(THREAD_HANDOFF_METHOD, params.data);
  const result = threadHandoffResultSchema.parse(raw);
  if (result.threadId === threadId) {
    throw new RpcError(
      "session/handoff-unconfirmed",
      "Host did not confirm a distinct handoff Thread. Do not retry automatically.",
      { sessionId: threadId },
    );
  }
  return { sessionId: result.threadId, handoff: result.handoff };
}
