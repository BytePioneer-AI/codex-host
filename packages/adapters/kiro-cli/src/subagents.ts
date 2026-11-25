import type { HostSubagentDelegationItem, HostThreadSnapshot } from "@codexhost/harness-adapter";
import { hostItemIdSchema, nativeTurnRefSchema } from "@codexhost/shared-contracts";

/** ACP exposes the task prompt and result, not the child's internal tool stream. */
export function kiroChildSnapshot(
  parentId: string,
  item: HostSubagentDelegationItem,
  childId: string,
): HostThreadSnapshot {
  const child = item.subagents.find((child) => child.nativeSubagentId === childId);
  if (!child) throw new Error("Kiro task does not belong to this parent");
  return {
    turns: [
      {
        nativeTurnRef: nativeTurnRefSchema.parse({
          harnessId: "kiro-cli",
          nativeSessionId: parentId,
          nativeTurnKey: childId,
          formatVersion: 1,
        }),
        input: item.prompt ? [{ type: "text", text: item.prompt }] : [],
        items: child.resultSummary
          ? [
              {
                item: {
                  type: "agentMessage",
                  itemId: hostItemIdSchema.parse(`kiro-task-result-${childId}`),
                  text: child.resultSummary,
                },
                outcome: { status: "succeeded" },
              },
            ]
          : [],
        outcome:
          child.status === "pending" || child.status === "running"
            ? {
                status: "unknown",
                reason: "Kiro ACP exposes task summaries, not the child's internal step stream",
              }
            : child.status === "interrupted"
              ? { status: "cancelled" }
              : child.status === "failed"
                ? {
                    status: "failed",
                    error: {
                      code: "nativeFailure",
                      message: child.resultSummary || "Kiro task failed",
                      retryable: false,
                    },
                  }
                : { status: "succeeded" },
      },
    ],
  };
}
