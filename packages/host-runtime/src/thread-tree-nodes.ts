import type { StoredDelegationRecordV1, StoredThreadSummaryV1 } from "@codexhost/mapping-store";
import {
  harnessIdSchema,
  THREAD_TREE_NODE_TITLE_MAX_LENGTH,
  type ThreadTreeNode,
  type ThreadTreeNodeStatus,
  type ThreadTreeNodesParams,
  type ThreadTreeNodesResult,
} from "@codexhost/shared-contracts";

/** The official archived listing as far as it was read. */
export interface OfficialArchive {
  ids: ReadonlySet<string>;
  /** False when the listing was cut off at its bound: a Thread missing from it may be archived. */
  complete: boolean;
}

/** What one Host knows about the Threads a sidebar tree shows. */
export interface ThreadTreeNodeSource {
  listDelegations(): Promise<readonly StoredDelegationRecordV1[]>;
  listSummaries(): Promise<readonly StoredThreadSummaryV1[]>;
  /** Threads this Host is running a Turn for. */
  activeThreadIds(): readonly string[];
  /** Whether the Thread waits for the user: an approval or a question. */
  waitsForUser(threadId: string): boolean;
  /** Title of an official Codex Thread; null when it could not be read. */
  readOfficialTitle(threadId: string): Promise<string | null>;
  /**
   * Official Threads that are archived; null when that could not be read. The official Thread
   * object carries no archive flag, so membership comes from the archived listing.
   */
  listOfficialArchived(): Promise<OfficialArchive | null>;
}

const OFFICIAL_READ_CONCURRENCY = 8;
const CODEX_HARNESS_ID = harnessIdSchema.parse("codex");
const STATUS_PRIORITY: Record<ThreadTreeNodeStatus, number> = { pending: 0, running: 1, idle: 2 };

export function moreUrgentThreadTreeStatus(
  left: ThreadTreeNodeStatus,
  right: ThreadTreeNodeStatus,
): ThreadTreeNodeStatus {
  return STATUS_PRIORITY[right] < STATUS_PRIORITY[left] ? right : left;
}

function boundedTitle(title: string | undefined): string | undefined {
  const text = title?.trim();
  if (!text) return undefined;
  if (text.length <= THREAD_TREE_NODE_TITLE_MAX_LENGTH) return text;
  const cut = text.slice(0, THREAD_TREE_NODE_TITLE_MAX_LENGTH);
  // Do not end on the first half of a surrogate pair.
  return /[\uD800-\uDBFF]$/u.test(cut) ? cut.slice(0, -1) : cut;
}

/**
 * Display data for the requested Threads, in request order. An external Thread whose record is
 * gone is left out. An official Thread is always described; what could not be read about it is
 * absent, never guessed.
 */
export async function readThreadTreeNodes(
  params: ThreadTreeNodesParams,
  source: ThreadTreeNodeSource,
): Promise<ThreadTreeNodesResult> {
  const [delegations, summaries] = await Promise.all([
    source.listDelegations(),
    source.listSummaries(),
  ]);
  const delegationByChild = new Map<string, StoredDelegationRecordV1>();
  for (const delegation of delegations) {
    if (!delegationByChild.has(delegation.childHostThreadId))
      delegationByChild.set(delegation.childHostThreadId, delegation);
  }
  const summaryById = new Map(
    summaries.map((summary) => [summary.hostThreadId as string, summary]),
  );
  const isOfficial = (threadId: string): boolean => {
    if (summaryById.has(threadId)) return false;
    const delegation = delegationByChild.get(threadId);
    return delegation === undefined || delegation.targetHarnessId === "codex";
  };

  const officialTitles = new Map<string, string | null>();
  let officialArchive: OfficialArchive | null = null;
  if (params.includeOfficial) {
    const pending = params.threadIds.filter(isOfficial);
    let next = 0;
    const worker = async (): Promise<void> => {
      for (let threadId = pending[next++]; threadId !== undefined; threadId = pending[next++])
        officialTitles.set(threadId, await source.readOfficialTitle(threadId).catch(() => null));
    };
    if (pending.length > 0) {
      [officialArchive] = await Promise.all([
        source.listOfficialArchived().catch(() => null),
        ...Array.from({ length: Math.min(OFFICIAL_READ_CONCURRENCY, pending.length) }, worker),
      ]);
    }
  }

  // Live state is read last and in one synchronous step, so every entry is of the same moment.
  const active = new Set(source.activeThreadIds());
  const threads: ThreadTreeNode[] = [];
  for (const threadId of params.threadIds) {
    const summary = summaryById.get(threadId);
    const delegation = delegationByChild.get(threadId);
    let title: string | undefined;
    let archived: boolean | undefined;
    if (summary) {
      title = summary.title;
      archived = summary.archived;
    } else if (!isOfficial(threadId)) {
      continue;
    } else if (params.includeOfficial) {
      title = officialTitles.get(threadId) ?? undefined;
      archived = officialArchive?.ids.has(threadId)
        ? true
        : officialArchive?.complete
          ? false
          : undefined;
    }
    const bounded = boundedTitle(title);
    threads.push({
      threadId,
      harnessId: summary?.harnessId ?? delegation?.targetHarnessId ?? CODEX_HARNESS_ID,
      status: source.waitsForUser(threadId) ? "pending" : active.has(threadId) ? "running" : "idle",
      ...(bounded !== undefined ? { title: bounded } : {}),
      ...(archived !== undefined ? { archived } : {}),
      ...(delegation ? { delegatedAt: delegation.createdAt } : {}),
    });
  }
  return { threads };
}
