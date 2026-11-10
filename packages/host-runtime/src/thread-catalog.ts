import { performance } from "node:perf_hooks";
import type { StoredSectionPlacementV1, StoredThreadRecordV1 } from "@codexhost/mapping-store";
import {
  decodeThreadListRequest,
  type DecodedThreadListRequest,
  type JsonObject,
  type OfficialThreadListPage,
} from "@codexhost/protocol-core";
import {
  THREAD_OWNERSHIP_LIST_MAX_LENGTH,
  hostThreadIdSchema,
  harnessIdSchema,
  type HostThreadId,
  type ThreadCatalogReadResult,
  type ThreadOwnership,
} from "@codexhost/shared-contracts";
import {
  compareThreadListEntries,
  filterExternalThreadListRecords,
  listExternalThreadMetadata,
  officialThreadListEntry,
  type ExternalThreadListRuntimeState,
  type ThreadListEntry,
} from "./external-thread-list.js";
import type { SharedThreadBridge } from "./shared-thread-bridge.js";
import { OfficialAdmissionError } from "./codex-runtime/official-work-gate.js";

const OFFICIAL_PAGE_SIZE = 20;

interface CatalogEntry {
  entry: ThreadListEntry;
  ownership: ThreadOwnership;
  archived: boolean;
}

export interface ThreadCatalogInput {
  includeArchived?: boolean;
  officialCursor?: ThreadCatalogReadResult["officialCursor"];
  readLocal(): Promise<{
    records: readonly StoredThreadRecordV1[];
    placements: readonly StoredSectionPlacementV1[];
  }>;
  sharedThreads?: Pick<SharedThreadBridge, "list" | "ownership">;
  runtimeFor(threadId: string): ExternalThreadListRuntimeState | null;
  /** Lazy admission to the existing managed scope; only unavailable here permits external-only. */
  initializeOfficial?: () => Promise<void>;
  requestOfficialPage(params: JsonObject): Promise<OfficialThreadListPage>;
  diagnose(line: string): void;
}

function listQuery(archived: boolean): DecodedThreadListRequest {
  const query = decodeThreadListRequest({
    id: "catalog",
    method: "thread/list",
    params: {
      archived,
      limit: OFFICIAL_PAGE_SIZE,
      sortKey: "updated_at",
      sortDirection: "desc",
    },
  });
  if (!query) throw new Error("Thread catalog query could not be decoded");
  return query;
}

function rowId(row: JsonObject): HostThreadId {
  return hostThreadIdSchema.parse(row.id);
}

/** External metadata is complete; official branches read one native page each. */
export async function readThreadCatalog(
  input: ThreadCatalogInput,
): Promise<ThreadCatalogReadResult> {
  const queries = [listQuery(false), ...(input.includeArchived ? [listQuery(true)] : [])];
  const metrics: Record<string, { ms: number; requests: number; ok: boolean }> = {};
  const started = performance.now();
  let ok = false;
  let returnedRows = 0;
  let officialUnavailable = false;
  const officialCursor: NonNullable<ThreadCatalogReadResult["officialCursor"]> = {
    live: null,
    ...(input.includeArchived ? { archived: null } : {}),
  };
  const measure = async <T>(source: string, work: (count: () => void) => Promise<T>) => {
    const metric: { ms: number; requests: number; ok: boolean } = {
      ms: 0,
      requests: 0,
      ok: false,
    };
    metrics[source] = metric;
    const start = performance.now();
    try {
      const result = await work(() => metric.requests++);
      metric.ok = true;
      return result;
    } finally {
      metric.ms = Math.round((performance.now() - start) * 100) / 100;
    }
  };

  let officialReady: Promise<boolean> | undefined;
  const prepareOfficial = (): Promise<boolean> =>
    (officialReady ??= measure("officialInitialization", async (count) => {
      if (!input.initializeOfficial) return true;
      count();
      try {
        await input.initializeOfficial();
        return true;
      } catch (error) {
        if (error instanceof OfficialAdmissionError && error.code === "unavailable") {
          officialUnavailable = true;
          return false;
        }
        throw error;
      }
    }));

  const readOfficial = (query: DecodedThreadListRequest): Promise<CatalogEntry[]> =>
    measure(query.archived ? "officialArchived" : "official", async (count) => {
      const branch = query.archived ? "archived" : "live";
      const cursor = input.officialCursor?.[branch];
      if (cursor === null || !(await prepareOfficial())) return [];
      count();
      const page = await input.requestOfficialPage({ ...query.params, cursor: cursor ?? null });
      if (page.nextCursor !== null && page.nextCursor === cursor)
        throw new Error("Official Thread catalog pagination did not advance");
      officialCursor[branch] = page.nextCursor;
      return page.data.map((thread) => ({
        entry: officialThreadListEntry(thread, "updated_at"),
        ownership: { threadId: rowId(thread), owner: "codex" as const },
        archived: query.archived,
      }));
    });

  const readExternal = async () => {
    const [local, sharedPages] = await Promise.all([
      measure("local", async (count) => {
        count();
        return input.readLocal();
      }),
      Promise.all(
        queries.map((query) =>
          measure(query.archived ? "sharedArchived" : "shared", async (count) => {
            if (!input.sharedThreads) return [];
            count();
            return input.sharedThreads.list(query.params);
          }),
        ),
      ),
    ]);
    const localOwners = new Map(
      local.records.map((record) => [record.hostThreadId as string, record.harnessId]),
    );
    const sharedIdSet = new Set(sharedPages.flat().map(rowId));
    const sharedIds = [...sharedIdSet];
    const sharedOwners = new Map<string, string>();
    const shared = input.sharedThreads;
    if (shared && sharedIds.length > 0) {
      await measure("sharedOwnership", async (count) => {
        for (
          let offset = 0;
          offset < sharedIds.length;
          offset += THREAD_OWNERSHIP_LIST_MAX_LENGTH
        ) {
          count();
          const owners = await shared.ownership(
            sharedIds.slice(offset, offset + THREAD_OWNERSHIP_LIST_MAX_LENGTH),
          );
          for (const [id, harnessId] of owners) sharedOwners.set(id, harnessId);
        }
      });
    }
    const placements = new Map(
      local.placements.map((placement) => [placement.hostThreadId as string, placement]),
    );
    const rows: CatalogEntry[] = [];
    for (const [index, query] of queries.entries()) {
      const page = listExternalThreadMetadata({
        records: local.records,
        query,
        sharedThreads: sharedPages[index] ?? [],
        runtimeFor: input.runtimeFor,
        placementOf: (id) => placements.get(id),
        limit: Number.MAX_SAFE_INTEGER,
      });
      for (const entry of page.data) {
        const threadId = rowId(entry.thread);
        // A shared row overrides a local copy only with confirmed shared ownership.
        const harnessId = sharedIdSet.has(threadId)
          ? sharedOwners.get(threadId)
          : localOwners.get(threadId);
        if (!harnessId) continue;
        rows.push({
          entry,
          ownership: { threadId, owner: "external", harnessId: harnessIdSchema.parse(harnessId) },
          archived: query.archived,
        });
      }
    }
    const archivedThreadIds = filterExternalThreadListRecords({
      records: local.records,
      query: listQuery(true),
      placementOf: (id) => placements.get(id),
    }).map((record) => record.hostThreadId);
    return { rows, archivedThreadIds, reservedIds: new Set([...localOwners.keys(), ...sharedIds]) };
  };

  try {
    const [external, ...official] = await Promise.all([
      readExternal(),
      ...queries.map(readOfficial),
    ]);
    const byId = new Map<string, CatalogEntry>();
    // Live rows win over archived duplicates; confirmed external ownership wins over native echoes.
    for (const row of external.rows) {
      if (!byId.has(row.ownership.threadId)) byId.set(row.ownership.threadId, row);
    }
    for (const row of official.flat()) {
      const id = row.ownership.threadId;
      if (!external.reservedIds.has(id) && !byId.has(id)) byId.set(id, row);
    }
    const rows = [...byId.values()].sort((left, right) =>
      compareThreadListEntries(left.entry, right.entry, "desc"),
    );
    const result: ThreadCatalogReadResult = {
      officialCursor,
      threads: rows.map(({ entry }) => ({ ...entry.thread, turns: [] })),
      ownership: rows.map((row) => row.ownership),
      archivedThreadIds: [
        ...new Set([
          ...rows.filter((row) => row.archived).map((row) => row.ownership.threadId),
          ...external.archivedThreadIds.filter((id) => !byId.has(id)),
        ]),
      ],
    };
    returnedRows = rows.length;
    ok = true;
    return result;
  } finally {
    try {
      if (process.env.CODEXHOST_TRACE_SESSION_LIST !== "1") {
        if (!ok) input.diagnose("[thread/catalog/read] request failed");
      } else
        input.diagnose(
          `[thread/catalog/read] ${JSON.stringify({
            ok,
            includeArchived: input.includeArchived === true,
            officialUnavailable,
            totalMs: Math.round((performance.now() - started) * 100) / 100,
            returnedRows,
            sources: metrics,
          })}`,
        );
    } catch {
      // Logging must not change the catalog response.
    }
  }
}
