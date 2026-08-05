import type { StoredThreadRecordV1 } from "@codexhost/mapping-store";
import {
  decodeOfficialThreadListPage,
  encodeHostThreadListCursor,
  type DecodedThreadListRequest,
  type HostThreadListCursor,
  type JsonObject,
  type OfficialThreadListPage,
  type ThreadListExternalAnchor,
  type ThreadListSortDirection,
} from "@codexhost/protocol-core";

import {
  compareThreadListEntries,
  externalAnchor,
  listExternalThreadMetadata,
  officialThreadListEntry,
  type ExternalThreadListRuntimeState,
  type ThreadListEntry,
} from "./external-thread-list.js";

const MAX_OFFICIAL_PAGE_REQUESTS = 256;
const OFFICIAL_TIE_ANCHOR = "\uffff";

export class OfficialThreadListError extends Error {
  constructor(readonly rpcError: JsonObject) {
    super(typeof rpcError.message === "string" ? rpcError.message : "Official thread/list failed");
    this.name = "OfficialThreadListError";
  }
}

export interface AggregatedThreadListPage extends JsonObject {
  data: JsonObject[];
  nextCursor: string | null;
  backwardsCursor: string | null;
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function officialThreadListPageFromResponse(response: JsonObject): OfficialThreadListPage {
  if (isRecord(response.error)) {
    if (!Number.isSafeInteger(response.error.code) || typeof response.error.message !== "string") {
      throw new Error("Official thread/list error response is invalid");
    }
    throw new OfficialThreadListError(response.error);
  }
  if (!("result" in response)) throw new Error("Official thread/list response has no result");
  return decodeOfficialThreadListPage(response.result);
}

function opposite(direction: ThreadListSortDirection): ThreadListSortDirection {
  return direction === "asc" ? "desc" : "asc";
}

function officialParams(
  query: DecodedThreadListRequest,
  cursor: string | null,
  limit: number,
): JsonObject {
  return { ...query.params, cursor, limit };
}

function cursorValue(input: {
  query: DecodedThreadListRequest;
  direction: ThreadListSortDirection;
  officialCursor: string | null;
  officialDone: boolean;
  externalAnchor: ThreadListExternalAnchor | null;
  externalDone: boolean;
}): string {
  return encodeHostThreadListCursor({
    queryFingerprint: input.query.queryFingerprint,
    sortDirection: input.direction,
    officialCursor: input.officialCursor,
    officialDone: input.officialDone,
    externalAnchor: input.externalAnchor,
    externalDone: input.externalDone,
  });
}

export async function aggregateThreadList(input: {
  query: DecodedThreadListRequest;
  records: readonly StoredThreadRecordV1[];
  runtimeFor(threadId: string): ExternalThreadListRuntimeState | null;
  requestOfficialPage(params: JsonObject): Promise<OfficialThreadListPage>;
}): Promise<AggregatedThreadListPage> {
  const { query } = input;
  if (!query.supportsExternal) throw new Error("External aggregation is not supported for query");
  const start: HostThreadListCursor = query.cursor ?? {
    queryFingerprint: query.queryFingerprint,
    sortDirection: query.sortDirection,
    officialCursor: null,
    officialDone: false,
    externalAnchor: null,
    externalDone: false,
  };
  const externalPage = start.externalDone
    ? { data: [], hasMore: false }
    : listExternalThreadMetadata({
        records: input.records,
        query,
        runtimeFor: input.runtimeFor,
        anchor: start.externalAnchor,
        limit: query.limit,
      });
  let externalIndex = 0;

  let officialCursor = start.officialCursor;
  let officialDone = start.officialDone;
  let officialBatchStart = officialCursor;
  let officialBatch: OfficialThreadListPage | null = null;
  let officialEntries: ThreadListEntry[] = [];
  let officialIndex = 0;
  let firstOfficialBackwardsCursor: string | null | undefined;
  let officialRequestCount = 0;
  const externalIds = new Set<string>(input.records.map((record) => record.hostThreadId));

  const requestOfficial = async (cursor: string | null, limit: number) => {
    officialRequestCount += 1;
    if (officialRequestCount > MAX_OFFICIAL_PAGE_REQUESTS) {
      throw new Error("Official thread/list pagination exceeded its request bound");
    }
    return input.requestOfficialPage(officialParams(query, cursor, limit));
  };

  const ensureOfficial = async (): Promise<ThreadListEntry | null> => {
    while (!officialDone) {
      if (officialIndex < officialEntries.length) return officialEntries[officialIndex] ?? null;
      if (officialBatch) {
        officialCursor = officialBatch.nextCursor;
        officialDone = officialCursor === null;
        officialBatch = null;
        officialEntries = [];
        officialIndex = 0;
        if (officialDone) return null;
      }
      officialBatchStart = officialCursor;
      const page = await requestOfficial(officialCursor, Math.max(1, query.limit));
      if (firstOfficialBackwardsCursor === undefined) {
        firstOfficialBackwardsCursor = page.backwardsCursor;
      }
      officialBatch = page;
      officialEntries = page.data.map((thread) => officialThreadListEntry(thread, query.sortKey));
      officialIndex = 0;
      if (officialEntries.length === 0) {
        if (page.nextCursor === null || page.nextCursor === officialCursor) {
          officialDone = true;
          return null;
        }
        officialCursor = page.nextCursor;
        officialBatch = null;
      }
    }
    return null;
  };

  const output: ThreadListEntry[] = [];
  let lastExternalAnchor = start.externalAnchor;
  while (output.length < query.limit) {
    const external = externalPage.data[externalIndex] ?? null;
    let official = await ensureOfficial();
    while (official && externalIds.has(String(official.thread.id))) {
      officialIndex += 1;
      official = await ensureOfficial();
    }
    if (!external && !official) break;
    if (
      external &&
      (!official || compareThreadListEntries(external, official, query.sortDirection) <= 0)
    ) {
      output.push(external);
      externalIndex += 1;
      lastExternalAnchor = externalAnchor(external);
    } else if (official) {
      output.push(official);
      officialIndex += 1;
    }
  }

  let nextOfficialCursor = officialCursor;
  let nextOfficialDone = officialDone;
  const finalOfficialBatch = officialBatch as OfficialThreadListPage | null;
  if (finalOfficialBatch && !officialDone) {
    if (officialIndex === 0) {
      nextOfficialCursor = officialBatchStart;
      nextOfficialDone = false;
    } else if (officialIndex < officialEntries.length) {
      const exact = await requestOfficial(officialBatchStart, officialIndex);
      if (exact.data.length !== officialIndex || exact.nextCursor === null) {
        throw new Error("Official thread/list did not return an exact consumed prefix cursor");
      }
      nextOfficialCursor = exact.nextCursor;
      nextOfficialDone = false;
    } else {
      nextOfficialCursor = finalOfficialBatch.nextCursor;
      nextOfficialDone = nextOfficialCursor === null;
    }
  }

  const externalRemaining =
    externalIndex < externalPage.data.length ||
    externalPage.hasMore ||
    (query.limit === 0 && !start.externalDone);
  const officialRemaining = !nextOfficialDone;
  const hasMore = externalRemaining || officialRemaining;
  const nextCursor = hasMore
    ? cursorValue({
        query,
        direction: query.sortDirection,
        officialCursor: nextOfficialCursor,
        officialDone: nextOfficialDone,
        externalAnchor: lastExternalAnchor,
        externalDone: !externalRemaining,
      })
    : null;

  const first = output[0];
  const backwardsAnchor = first
    ? {
        timestamp: first.timestamp,
        threadId: first.source === "external" ? String(first.thread.id) : OFFICIAL_TIE_ANCHOR,
      }
    : null;
  const backwardsCursor = first
    ? cursorValue({
        query,
        direction: opposite(query.sortDirection),
        officialCursor: firstOfficialBackwardsCursor ?? null,
        officialDone: firstOfficialBackwardsCursor == null,
        externalAnchor: backwardsAnchor,
        externalDone: false,
      })
    : null;

  return {
    data: output.map((entry) => entry.thread),
    nextCursor,
    backwardsCursor,
  };
}
