import type {
  DecodedThreadListRequest,
  JsonObject,
  OfficialThreadListPage,
} from "@codexhost/protocol-core";

import {
  compareThreadListEntries,
  officialThreadListEntry,
  type ThreadListEntry,
} from "./external-thread-list.js";

const CURSOR_PREFIX = "codexhost:official-accounts:v1:";
const MAX_PAGE_REQUESTS = 256;

interface AccountCursorState {
  cursor: string | null;
  done: boolean;
}

interface MultiAccountCursor {
  accounts: Record<string, AccountCursorState>;
}

interface SourceState extends AccountCursorState {
  accountId: string;
  batchStart: string | null;
  batch: OfficialThreadListPage | null;
  entries: ThreadListEntry[];
  index: number;
  backwardsCursor: string | null | undefined;
}

function encodeCursor(accounts: Record<string, AccountCursorState>): string {
  return `${CURSOR_PREFIX}${Buffer.from(JSON.stringify({ formatVersion: 1, accounts })).toString("base64url")}`;
}

function decodeCursor(value: string): MultiAccountCursor {
  if (!value.startsWith(CURSOR_PREFIX) || value.length > 65_536) {
    throw new Error("Multi-Account official thread/list cursor is invalid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      Buffer.from(value.slice(CURSOR_PREFIX.length), "base64url").toString("utf8"),
    );
  } catch {
    throw new Error("Multi-Account official thread/list cursor is invalid");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    (parsed as { formatVersion?: unknown }).formatVersion !== 1
  ) {
    throw new Error("Multi-Account official thread/list cursor is invalid");
  }
  const accounts = (parsed as { accounts?: unknown }).accounts;
  if (typeof accounts !== "object" || accounts === null || Array.isArray(accounts)) {
    throw new Error("Multi-Account official thread/list cursor is invalid");
  }
  const result: Record<string, AccountCursorState> = {};
  for (const [accountId, candidate] of Object.entries(accounts)) {
    if (
      !accountId ||
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate)
    ) {
      throw new Error("Multi-Account official thread/list cursor is invalid");
    }
    const { cursor, done } = candidate as { cursor?: unknown; done?: unknown };
    if ((cursor !== null && typeof cursor !== "string") || typeof done !== "boolean") {
      throw new Error("Multi-Account official thread/list cursor is invalid");
    }
    result[accountId] = { cursor: cursor as string | null, done };
  }
  return { accounts: result };
}

function initialAccounts(accountIds: readonly string[]): Record<string, AccountCursorState> {
  return Object.fromEntries(
    [...new Set(accountIds)].sort().map((accountId) => [accountId, { cursor: null, done: false }]),
  );
}

function threadId(entry: ThreadListEntry): string {
  if (typeof entry.thread.id !== "string" || !entry.thread.id) {
    throw new Error("Official thread/list row has no stable Thread ID");
  }
  return entry.thread.id;
}

/** Merges per-Account official pages into one opaque official source for the existing aggregator. */
export async function aggregateOfficialAccountThreadListPage(input: {
  query: DecodedThreadListRequest;
  accountIds: readonly string[];
  params: JsonObject;
  requestAccountPage(accountId: string, params: JsonObject): Promise<OfficialThreadListPage>;
  observeThread?(threadId: string, accountId: string): Promise<void>;
}): Promise<OfficialThreadListPage> {
  const cursorValue = typeof input.params.cursor === "string" ? input.params.cursor : null;
  const cursor = cursorValue
    ? decodeCursor(cursorValue)
    : { accounts: initialAccounts(input.accountIds) };
  const sources = Object.entries(cursor.accounts).map(([accountId, state]): SourceState => ({
    accountId,
    ...state,
    batchStart: state.cursor,
    batch: null,
    entries: [],
    index: 0,
    backwardsCursor: undefined,
  }));
  let requestCount = 0;
  const request = async (source: SourceState, cursor: string | null, limit: number) => {
    requestCount += 1;
    if (requestCount > MAX_PAGE_REQUESTS) {
      throw new Error("Multi-Account official thread/list pagination exceeded its request bound");
    }
    return input.requestAccountPage(source.accountId, {
      ...input.params,
      cursor,
      limit,
    });
  };
  const ensure = async (source: SourceState): Promise<ThreadListEntry | null> => {
    while (!source.done) {
      if (source.index < source.entries.length) return source.entries[source.index] ?? null;
      if (source.batch) {
        source.cursor = source.batch.nextCursor;
        source.done = source.cursor === null;
        source.batch = null;
        source.entries = [];
        source.index = 0;
        if (source.done) return null;
      }
      source.batchStart = source.cursor;
      const page = await request(source, source.cursor, Math.max(1, input.query.limit));
      source.backwardsCursor ??= page.backwardsCursor;
      source.batch = page;
      source.entries = page.data.map((thread) =>
        officialThreadListEntry(thread, input.query.sortKey),
      );
      if (source.entries.length === 0) {
        if (page.nextCursor === null || page.nextCursor === source.cursor) {
          source.done = true;
          return null;
        }
        source.cursor = page.nextCursor;
        source.batch = null;
      }
    }
    return null;
  };

  const output: JsonObject[] = [];
  const emitted = new Set<string>();
  while (output.length < input.query.limit) {
    const candidates = await Promise.all(
      sources.map(async (source) => ({ source, entry: await ensure(source) })),
    );
    const available = candidates
      .filter((candidate): candidate is { source: SourceState; entry: ThreadListEntry } =>
        Boolean(candidate.entry),
      )
      .sort((left, right) => {
        const compared = compareThreadListEntries(
          left.entry,
          right.entry,
          input.query.sortDirection,
        );
        return compared || left.source.accountId.localeCompare(right.source.accountId);
      });
    const selected = available[0];
    if (!selected) break;
    selected.source.index += 1;
    const id = threadId(selected.entry);
    await input.observeThread?.(id, selected.source.accountId);
    if (emitted.has(id)) continue;
    emitted.add(id);
    output.push(selected.entry.thread);
  }

  const nextAccounts: Record<string, AccountCursorState> = {};
  for (const source of sources) {
    let nextCursor = source.cursor;
    let done = source.done;
    if (source.batch && !source.done) {
      if (source.index === 0) {
        nextCursor = source.batchStart;
      } else if (source.index < source.entries.length) {
        const exact = await request(source, source.batchStart, source.index);
        if (exact.data.length !== source.index || exact.nextCursor === null) {
          throw new Error("Official Account thread/list did not return an exact prefix cursor");
        }
        nextCursor = exact.nextCursor;
      } else {
        nextCursor = source.batch.nextCursor;
        done = nextCursor === null;
      }
    }
    nextAccounts[source.accountId] = { cursor: nextCursor, done };
  }
  const hasMore = Object.values(nextAccounts).some((state) => !state.done);
  const backwardsAccounts = Object.fromEntries(
    sources.map((source) => [
      source.accountId,
      { cursor: source.backwardsCursor ?? null, done: source.backwardsCursor == null },
    ]),
  );
  const hasBackwards = sources.some((source) => source.backwardsCursor != null);
  return {
    data: output,
    nextCursor: hasMore ? encodeCursor(nextAccounts) : null,
    backwardsCursor: hasBackwards ? encodeCursor(backwardsAccounts) : null,
  };
}
