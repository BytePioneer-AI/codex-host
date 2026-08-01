import type { StoredThreadRecordV1 } from "@codexhost/mapping-store";
import type {
  DecodedThreadListRequest,
  JsonObject,
  ThreadListExternalAnchor,
  ThreadListSortDirection,
  ThreadListSortKey,
} from "@codexhost/protocol-core";

import { externalThreadValue } from "./external-thread-repository.js";

export interface ExternalThreadListRuntimeState {
  running: boolean;
}

export interface ThreadListEntry {
  source: "external" | "official";
  thread: JsonObject;
  timestamp: number;
}

export interface ExternalThreadListPage {
  data: ThreadListEntry[];
  hasMore: boolean;
}

function unixTimestamp(value: string, field: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`External Thread ${field} is invalid`);
  return Math.floor(parsed / 1_000);
}

function threadId(thread: JsonObject): string {
  if (typeof thread.id !== "string" || thread.id.length === 0) {
    throw new Error("Thread list row has no stable ID");
  }
  return thread.id;
}

export function threadListTimestamp(thread: JsonObject, sortKey: ThreadListSortKey): number {
  const field =
    sortKey === "created_at"
      ? thread.createdAt
      : sortKey === "updated_at"
        ? thread.updatedAt
        : (thread.recencyAt ?? thread.updatedAt);
  if (!Number.isSafeInteger(field)) {
    throw new Error(`Thread list row has no valid ${sortKey} timestamp`);
  }
  return field as number;
}

function compareTimestamp(left: number, right: number, direction: ThreadListSortDirection): number {
  if (left === right) return 0;
  return direction === "asc" ? left - right : right - left;
}

export function compareThreadListEntries(
  left: ThreadListEntry,
  right: ThreadListEntry,
  direction: ThreadListSortDirection,
): number {
  const byTimestamp = compareTimestamp(left.timestamp, right.timestamp, direction);
  if (byTimestamp !== 0) return byTimestamp;
  if (left.source !== right.source) return left.source === "external" ? -1 : 1;
  if (left.source === "official") return 0;
  const leftId = threadId(left.thread);
  const rightId = threadId(right.thread);
  return leftId === rightId ? 0 : leftId < rightId ? -1 : 1;
}

function compareExternalAnchor(
  entry: ThreadListEntry,
  anchor: ThreadListExternalAnchor,
  direction: ThreadListSortDirection,
): number {
  const byTimestamp = compareTimestamp(entry.timestamp, anchor.timestamp, direction);
  if (byTimestamp !== 0) return byTimestamp;
  const id = threadId(entry.thread);
  return id === anchor.threadId ? 0 : id < anchor.threadId ? -1 : 1;
}

export function externalAnchor(entry: ThreadListEntry): ThreadListExternalAnchor {
  if (entry.source !== "external") throw new Error("Expected an External Thread list entry");
  return { timestamp: entry.timestamp, threadId: threadId(entry.thread) };
}

function includesExternalRecord(
  record: StoredThreadRecordV1,
  query: DecodedThreadListRequest,
): boolean {
  if (record.state !== "ready" || !record.nativeSessionRef) return false;
  if (record.archived !== query.archived) return false;
  if (query.cwd !== null && !query.cwd.includes(record.cwd)) return false;
  if (
    query.modelProviders !== null &&
    query.modelProviders.length > 0 &&
    !query.modelProviders.includes("codexhost")
  ) {
    return false;
  }
  if (
    query.sourceKinds !== null &&
    query.sourceKinds.length > 0 &&
    !query.sourceKinds.includes("vscode")
  ) {
    return false;
  }
  if (
    query.searchTerm !== null &&
    !record.title.toLowerCase().includes(query.searchTerm.toLowerCase())
  ) {
    return false;
  }
  if (query.parentThreadId !== null || query.ancestorThreadId !== null) return false;
  if (query.isPinned === true) return false;
  return true;
}

export function resolveExternalSessionTreeIds(
  records: readonly StoredThreadRecordV1[],
): Map<string, string> {
  const byId = new Map(records.map((record) => [record.hostThreadId, record] as const));
  const resolved = new Map<string, string>();

  const resolve = (start: StoredThreadRecordV1): string => {
    const cached = resolved.get(start.hostThreadId);
    if (cached) return cached;
    const path: StoredThreadRecordV1[] = [];
    const visited = new Set<string>();
    let current = start;
    while (true) {
      const known = resolved.get(current.hostThreadId);
      if (known) {
        for (const record of path) resolved.set(record.hostThreadId, known);
        return known;
      }
      if (visited.has(current.hostThreadId)) {
        throw new Error("External Thread Fork tree contains a cycle");
      }
      visited.add(current.hostThreadId);
      path.push(current);
      const sourceId = current.forkSource?.hostThreadId;
      const source = sourceId ? byId.get(sourceId) : undefined;
      if (!source) {
        const root = current.hostThreadId;
        for (const record of path) resolved.set(record.hostThreadId, root);
        return root;
      }
      current = source;
    }
  };

  for (const record of records) resolve(record);
  return resolved;
}

export function listExternalThreadMetadata(input: {
  records: readonly StoredThreadRecordV1[];
  query: DecodedThreadListRequest;
  runtimeFor(threadId: string): ExternalThreadListRuntimeState | null;
  anchor?: ThreadListExternalAnchor | null;
  limit?: number;
}): ExternalThreadListPage {
  if (!input.query.supportsExternal) return { data: [], hasMore: false };
  const sessionIds = resolveExternalSessionTreeIds(input.records);
  const entries = input.records
    .filter((record) => includesExternalRecord(record, input.query))
    .map((record): ThreadListEntry => {
      const runtime = input.runtimeFor(record.hostThreadId);
      const sessionId = sessionIds.get(record.hostThreadId);
      if (!sessionId) throw new Error("External Thread Session tree could not be resolved");
      const thread = externalThreadValue({
        record,
        turns: [],
        sessionId,
        ...(runtime ? { running: runtime.running } : { loaded: false }),
      });
      return {
        source: "external",
        thread,
        timestamp:
          input.query.sortKey === "created_at"
            ? unixTimestamp(record.createdAt, "createdAt")
            : unixTimestamp(record.updatedAt, "updatedAt"),
      };
    })
    .sort((left, right) => compareThreadListEntries(left, right, input.query.sortDirection))
    .filter(
      (entry) =>
        !input.anchor || compareExternalAnchor(entry, input.anchor, input.query.sortDirection) > 0,
    );
  const limit = input.limit ?? input.query.limit;
  return {
    data: entries.slice(0, limit),
    hasMore: entries.length > limit,
  };
}

export function officialThreadListEntry(
  thread: JsonObject,
  sortKey: ThreadListSortKey,
): ThreadListEntry {
  return { source: "official", thread, timestamp: threadListTimestamp(thread, sortKey) };
}
