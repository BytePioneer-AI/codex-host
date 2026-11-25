import path from "node:path";
import { performance } from "node:perf_hooks";
import type { StoredSectionPlacementV1, StoredThreadSummaryV1 } from "@codexhost/mapping-store";
import {
  decodeThreadListRequest,
  type DecodedThreadListRequest,
  type JsonObject,
  type OfficialThreadListPage,
} from "@codexhost/protocol-core";
import {
  THREAD_OWNERSHIP_LIST_MAX_LENGTH,
  desktopProjectPathKey,
  hostThreadIdSchema,
  harnessIdSchema,
  type HostThreadId,
  type ThreadCatalogReadParams,
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
import {
  isShadowedOfficialThread,
  type OfficialImportTimes,
} from "./official-import-duplicates.js";
import { OfficialAdmissionError } from "./codex-runtime/official-work-gate.js";

const OFFICIAL_PAGE_SIZE = 20;
/** A scoped read: larger native pages, and a bound on how far one request reads ahead. */
const SCOPED_PAGE_SIZE = 100;
const SCOPED_MAX_PAGES = 10;

/** Whether `cwd` is `folder` or lies below it. */
function withinFolder(folder: string, cwd: string): boolean {
  const relative = path.relative(path.resolve(folder), path.resolve(cwd));
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

/** A native project lists exact registered roots; legacy folder scopes include descendants. */
function scopeMatcher(scope: NonNullable<ThreadCatalogReadParams["scope"]>) {
  if ("projectId" in scope) {
    const roots = new Set(scope.rootPaths?.map(desktopProjectPathKey));
    const assigned = new Set(scope.legacyThreadIds);
    return (row: JsonObject) => {
      if (typeof row.projectId === "string") return row.projectId === scope.projectId;
      if (typeof row.id === "string" && assigned.has(row.id)) return true;
      return (
        row.workspaceKind !== "projectless" &&
        typeof row.cwd === "string" &&
        roots.has(desktopProjectPathKey(row.cwd))
      );
    };
  }
  return ({ cwd }: JsonObject) =>
    typeof cwd === "string" &&
    withinFolder(scope.cwd, cwd) &&
    !scope.excludeCwds.some((folder) => withinFolder(folder, cwd));
}

interface CatalogEntry {
  entry: ThreadListEntry;
  ownership: ThreadOwnership;
  archived: boolean;
}

interface ExternalCatalog {
  rows: CatalogEntry[];
  archivedThreadIds: HostThreadId[];
  reservedIds: Set<string>;
}

export interface ThreadCatalogInput {
  includeArchived?: boolean;
  officialCursor?: ThreadCatalogReadResult["officialCursor"];
  /** Read native pages ahead until one holds a Thread of this folder. */
  scope?: ThreadCatalogReadParams["scope"];
  readLocal(): Promise<{
    records: readonly StoredThreadSummaryV1[];
    placements: readonly StoredSectionPlacementV1[];
    officialImportTimes?: OfficialImportTimes;
  }>;
  readContinuationImportTimes?(): Promise<OfficialImportTimes>;
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
      sortKey: "recency_at",
      sortDirection: "desc",
    },
  });
  if (!query) throw new Error("Thread catalog query could not be decoded");
  return query;
}

function rowId(row: JsonObject): HostThreadId {
  return hostThreadIdSchema.parse(row.id);
}

/** First page returns complete external metadata with one official page per branch; continuations read only official branches. */
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

  const readOfficial = (
    query: DecodedThreadListRequest,
    importTimes: Promise<OfficialImportTimes | undefined>,
  ): Promise<CatalogEntry[]> =>
    measure(query.archived ? "officialArchived" : "official", async (count) => {
      const branch = query.archived ? "archived" : "live";
      const cursor = input.officialCursor?.[branch];
      if (cursor === null || !(await prepareOfficial())) return [];
      const inScope = input.scope && scopeMatcher(input.scope);
      const data: JsonObject[] = [];
      let next: string | null = cursor ?? null;
      for (let pages = 0; pages < (inScope ? SCOPED_MAX_PAGES : 1); pages += 1) {
        count();
        const page = await input.requestOfficialPage({
          ...query.params,
          // A project can contain Codex conversations from more than one model provider.
          modelProviders: [],
          ...(inScope ? { limit: SCOPED_PAGE_SIZE } : {}),
          cursor: next,
        });
        if (page.nextCursor !== null && page.nextCursor === next)
          throw new Error("Official Thread catalog pagination did not advance");
        const times = await importTimes;
        const visible = page.data.filter((thread) => !isShadowedOfficialThread(times, thread));
        data.push(...visible);
        next = page.nextCursor;
        if (next === null || !inScope || visible.some(inScope)) break;
      }
      officialCursor[branch] = next;
      return data.map((thread) => ({
        entry: officialThreadListEntry(thread, "recency_at"),
        ownership: { threadId: rowId(thread), owner: "codex" as const },
        archived: query.archived,
      }));
    });

  const readExternal = async (
    localRead: ReturnType<ThreadCatalogInput["readLocal"]>,
  ): Promise<ExternalCatalog> => {
    const [local, sharedPages] = await Promise.all([
      localRead,
      Promise.all(
        queries.map((query) =>
          measure(query.archived ? "sharedArchived" : "shared", async (count) => {
            if (!input.sharedThreads) return [];
            count();
            return input.sharedThreads.list(query.params, { requireComplete: true });
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
      runtimeFor: input.runtimeFor,
      placementOf: (id) => placements.get(id),
    })
      .filter((record) => !record.ephemeral)
      .map((record) => record.hostThreadId);
    return { rows, archivedThreadIds, reservedIds: new Set([...localOwners.keys(), ...sharedIds]) };
  };

  try {
    const local =
      input.officialCursor === undefined
        ? measure("local", (count) => {
            count();
            return input.readLocal();
          })
        : undefined;
    const times = local
      ? local.then((snapshot) => snapshot.officialImportTimes)
      : Promise.resolve(input.readContinuationImportTimes?.());
    const [external, official] = await Promise.all([
      local
        ? readExternal(local)
        : { rows: [], archivedThreadIds: [], reservedIds: new Set<string>() },
      Promise.all(queries.map((query) => readOfficial(query, times))),
      times,
    ]);
    const byId = new Map<string, CatalogEntry>();
    // Live rows win over archived duplicates; confirmed external ownership wins over native echoes.
    for (const row of external.rows) {
      if (!byId.has(row.ownership.threadId)) byId.set(row.ownership.threadId, row);
    }
    for (const row of official.flat()) {
      const id = row.ownership.threadId;
      if (external.reservedIds.has(id) || byId.has(id)) continue;
      byId.set(id, row);
    }
    const rows = [...byId.values()]
      .filter(({ entry }) => entry.thread.ephemeral !== true)
      .sort((left, right) => compareThreadListEntries(left.entry, right.entry, "desc"));
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
