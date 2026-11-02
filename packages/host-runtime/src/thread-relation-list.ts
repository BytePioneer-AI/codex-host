import type { StoredDelegationRecordV1, StoredThreadRecordV1 } from "@codexhost/mapping-store";
import {
  threadRelationListResultSchema,
  type HostThreadId,
  type ThreadRelation,
  type ThreadRelationListResult,
} from "@codexhost/shared-contracts";

/** Mapping Store reads used by the sidebar relation list; nothing else is needed. */
export interface ThreadRelationSource {
  find(hostThreadId: HostThreadId): Promise<StoredThreadRecordV1 | null>;
  getDelegationByChild(childHostThreadId: HostThreadId): Promise<StoredDelegationRecordV1 | null>;
}

/**
 * Read the persisted sidebar parent of each Thread without opening a Harness
 * Session, reading a Snapshot, or calling official Codex.
 *
 * A Delegation record wins over a Fork source because it is the relation the
 * user created explicitly. Subagent records are left to Desktop's native
 * nesting. Shared Threads are owned by another Host, so their
 * relation is not known here and is reported as absent.
 */
export async function listThreadRelations(input: {
  threadIds: readonly HostThreadId[];
  source: ThreadRelationSource;
  sharedThreadIds?: ReadonlySet<string> | ReadonlyMap<string, unknown> | undefined;
}): Promise<ThreadRelationListResult> {
  const threads = await Promise.all(
    input.threadIds.map(async (threadId): Promise<ThreadRelation> => {
      if (input.sharedThreadIds?.has(threadId)) {
        return { threadId, owner: "external", parent: null };
      }
      const [delegation, record] = await Promise.all([
        input.source.getDelegationByChild(threadId),
        input.source.find(threadId),
      ]);
      const owner = record ? "external" : "codex";
      // Desktop already nests Subagents through their projected parent.
      if (record?.subagent) return { threadId, owner, parent: null };
      if (delegation && delegation.parentHostThreadId !== threadId) {
        return {
          threadId,
          owner,
          parent: { threadId: delegation.parentHostThreadId, relation: "delegation" },
        };
      }
      const forkParent = record?.forkSource?.hostThreadId;
      if (forkParent && forkParent !== threadId) {
        return { threadId, owner, parent: { threadId: forkParent, relation: "fork" } };
      }
      return { threadId, owner, parent: null };
    }),
  );
  return threadRelationListResultSchema.parse({ threads });
}
