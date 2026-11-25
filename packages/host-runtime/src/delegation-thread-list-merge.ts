import {
  DelegationControlError,
  type DelegationThreadListItem,
  type DelegationThreadListResult,
  type ThreadListInput,
} from "./delegation-types.js";

/** A native continuation, or null for an exhausted session. A null cursor starts a session. */
type SessionPosition = { cursor: string | null } | null;

interface MergedListCursor {
  v: 2;
  cwd: string | null;
  sort: ThreadListInput["sort"];
  /** The Registry instance and session set the positions were issued for, by session index. */
  generation: string;
  sessions: SessionPosition[];
}

interface SessionHead {
  row: DelegationThreadListItem;
  nextCursor: string | null;
}

const MAX_SESSION_PAGE_REQUESTS = 256;
type ListTimestampField = "createdAt" | "updatedAt" | "recencyAt";

/**
 * The native Unix seconds behind a native row's timestamps. They stay beside the row rather than
 * on it, so a value too large for a Date still orders the merge without entering the list contract.
 */
const nativeListSeconds = new WeakMap<
  DelegationThreadListItem,
  Partial<Record<ListTimestampField, number>>
>();

/** Records the native seconds a row's timestamps were projected from, for the cross-session merge. */
export function rememberNativeListSeconds<T extends DelegationThreadListItem>(
  row: T,
  seconds: Partial<Record<ListTimestampField, number>>,
): T {
  nativeListSeconds.set(row, seconds);
  return row;
}

/** A row's timestamp in seconds for ordering: the native value when there is one, else its ISO field. */
export function listSortSeconds(
  row: DelegationThreadListItem,
  field: ListTimestampField,
): number | undefined {
  const native = nativeListSeconds.get(row);
  if (native) return native[field];
  const value = row[field];
  return value === undefined ? undefined : Date.parse(value) / 1_000;
}

function invalidCursor(message = "List cursor is invalid"): DelegationControlError {
  return new DelegationControlError("INVALID_ARGUMENT", message);
}

function validPosition(value: unknown): value is SessionPosition {
  if (value === null) return true;
  if (typeof value !== "object" || Array.isArray(value)) return false;
  const { cursor } = value as { cursor?: unknown };
  return cursor === null || (typeof cursor === "string" && cursor.length > 0);
}

function decodeCursor(
  cursor: string,
  input: ThreadListInput,
  sessions: number,
  generation: string,
): SessionPosition[] {
  let value: unknown;
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    if (Buffer.from(decoded, "utf8").toString("base64url") !== cursor) throw new Error();
    value = JSON.parse(decoded);
  } catch {
    throw invalidCursor();
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalidCursor();
  const parsed = value as Partial<MergedListCursor>;
  if (parsed.v !== 2 || !Array.isArray(parsed.sessions) || !parsed.sessions.every(validPosition)) {
    throw invalidCursor();
  }
  if (parsed.sort !== input.sort || parsed.cwd !== (input.cwd ?? null)) {
    throw invalidCursor("List cursor does not match the current query");
  }
  if (parsed.sessions.length !== sessions || parsed.generation !== generation) {
    throw invalidCursor("List cursor does not match the active Host Runtime sessions");
  }
  return parsed.sessions;
}

/** Recognizes current and retired merged cursors so neither can be forwarded to a lone session. */
export function isMergedListCursor(cursor: string): boolean {
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    if (Buffer.from(decoded, "utf8").toString("base64url") !== cursor) return false;
    const value: unknown = JSON.parse(decoded);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const parsed = value as { v?: unknown; generation?: unknown; sessions?: unknown };
    return (
      (parsed.v === 1 || parsed.v === 2) &&
      typeof parsed.generation === "string" &&
      Array.isArray(parsed.sessions)
    );
  } catch {
    return false;
  }
}

/**
 * Merges independent session lists using one-row native pages. Only an emitted row advances its
 * session's continuation; no later request skips a prefix of a reread page. Native cursors retain
 * their backend's live-list semantics, not snapshot semantics. The query and session generation
 * must match, but the caller may change its output limit between pages.
 */
export async function mergeThreadListPages(
  sessions: ReadonlyArray<(input: ThreadListInput) => Promise<DelegationThreadListResult>>,
  input: ThreadListInput,
  compare: (left: DelegationThreadListItem, right: DelegationThreadListItem) => number,
  generation: string,
): Promise<DelegationThreadListResult> {
  if (!Number.isSafeInteger(input.limit) || input.limit <= 0 || input.limit > 100) {
    throw invalidCursor("List limit must be between 1 and 100");
  }
  const positions: SessionPosition[] = input.cursor
    ? decodeCursor(input.cursor, input, sessions.length, generation)
    : sessions.map(() => ({ cursor: null }));
  const requests = sessions.map(() => 0);
  const readHead = async (index: number): Promise<SessionHead | null> => {
    let position = positions[index];
    while (position) {
      const list = sessions[index];
      if (!list) throw invalidCursor();
      const count = (requests[index] ?? 0) + 1;
      requests[index] = count;
      if (count > MAX_SESSION_PAGE_REQUESTS) {
        throw new DelegationControlError(
          "INTERNAL_ERROR",
          "Thread list exceeded its request bound",
        );
      }
      const request: ThreadListInput = { ...input, limit: 1 };
      if (position.cursor === null) delete request.cursor;
      else request.cursor = position.cursor;
      const page = await list(request);
      if (
        page.threads.length > 1 ||
        (page.nextCursor !== null && page.nextCursor === position.cursor)
      ) {
        throw new DelegationControlError("INTERNAL_ERROR", "Thread list returned an invalid page");
      }
      const row = page.threads[0];
      if (row) return { row, nextCursor: page.nextCursor };
      position = page.nextCursor === null ? null : { cursor: page.nextCursor };
      positions[index] = position;
    }
    return null;
  };
  const heads = await Promise.all(sessions.map((_, index) => readHead(index)));
  const threads: DelegationThreadListItem[] = [];
  while (threads.length < input.limit) {
    let bestIndex = -1;
    let best: SessionHead | null = null;
    for (const [index, head] of heads.entries()) {
      if (head && (!best || compare(head.row, best.row) < 0)) {
        best = head;
        bestIndex = index;
      }
    }
    if (!best) break;
    threads.push(best.row);
    positions[bestIndex] = best.nextCursor === null ? null : { cursor: best.nextCursor };
    if (threads.length < input.limit) heads[bestIndex] = await readHead(bestIndex);
  }
  const cursor: MergedListCursor = {
    v: 2,
    cwd: input.cwd ?? null,
    sort: input.sort,
    generation,
    sessions: positions,
  };
  return {
    threads,
    nextCursor: positions.some((position) => position !== null)
      ? Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url")
      : null,
  };
}
