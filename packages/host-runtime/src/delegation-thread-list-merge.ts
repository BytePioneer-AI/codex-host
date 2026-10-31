import {
  DelegationControlError,
  type DelegationThreadListItem,
  type DelegationThreadListResult,
  type ThreadListInput,
} from "./delegation-types.js";

/**
 * Where one session resumes: the cursor of the page it was reading, how many rows of that page
 * were already returned, and the page size used to read it, so the same page can be read again.
 * `null` means the session has no more rows.
 */
type SessionPosition = readonly [cursor: string | null, consumed: number, pageLimit: number] | null;

interface MergedListCursor {
  v: 1;
  sort: ThreadListInput["sort"];
  /** The Registry instance and session set the positions were issued for, by session index. */
  generation: string;
  sessions: SessionPosition[];
}

interface SessionStream {
  pageCursor: string | null;
  pageLimit: number;
  rows: DelegationThreadListItem[];
  consumed: number;
  nextCursor: string | null;
}

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
  if (!Array.isArray(value) || value.length !== 3) return false;
  const [cursor, consumed, pageLimit] = value as unknown[];
  return (
    (cursor === null || (typeof cursor === "string" && cursor.length > 0)) &&
    typeof pageLimit === "number" &&
    Number.isSafeInteger(pageLimit) &&
    pageLimit > 0 &&
    typeof consumed === "number" &&
    Number.isSafeInteger(consumed) &&
    consumed >= 0 &&
    // An issued position always has an unread row left on its page.
    consumed < pageLimit
  );
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
  if (
    parsed.v !== 1 ||
    parsed.sort !== input.sort ||
    !Array.isArray(parsed.sessions) ||
    !parsed.sessions.every(validPosition)
  ) {
    throw invalidCursor();
  }
  if (parsed.sessions.length !== sessions || parsed.generation !== generation) {
    throw invalidCursor("List cursor does not match the active Host Runtime sessions");
  }
  return parsed.sessions;
}

/**
 * Whether `cursor` has the shape of a merged list cursor. A single session never issues one, so a
 * Registry that is down to one session uses this to reject a cursor left over from a merged list
 * instead of handing it to that session.
 */
export function isMergedListCursor(cursor: string): boolean {
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    if (Buffer.from(decoded, "utf8").toString("base64url") !== cursor) return false;
    const value: unknown = JSON.parse(decoded);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const parsed = value as Partial<MergedListCursor>;
    return (
      parsed.v === 1 && typeof parsed.generation === "string" && Array.isArray(parsed.sessions)
    );
  } catch {
    return false;
  }
}

function encodeCursor(
  sort: ThreadListInput["sort"],
  generation: string,
  sessions: SessionPosition[],
): string {
  const cursor: MergedListCursor = { v: 1, sort, generation, sessions };
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

/**
 * Merges the Thread lists of several Host Runtime sessions into one page in `input.sort` order.
 * The returned cursor records each session's own position, so following it pages through every
 * Thread exactly once even though each session pages independently. `generation` identifies the
 * current session set; a cursor issued for another generation is rejected, because its positions
 * would be applied to the wrong sessions.
 */
export async function mergeThreadListPages(
  sessions: ReadonlyArray<(input: ThreadListInput) => Promise<DelegationThreadListResult>>,
  input: ThreadListInput,
  compare: (left: DelegationThreadListItem, right: DelegationThreadListItem) => number,
  generation: string,
): Promise<DelegationThreadListResult> {
  const positions: SessionPosition[] = input.cursor
    ? decodeCursor(input.cursor, input, sessions.length, generation)
    : sessions.map(() => [null, 0, input.limit] as const);
  const read = (index: number, cursor: string | null, limit: number) => {
    const request: ThreadListInput = { ...input, limit };
    if (cursor === null) delete request.cursor;
    else request.cursor = cursor;
    const list = sessions[index];
    if (!list) throw invalidCursor();
    return list(request);
  };
  const streams = await Promise.all(
    positions.map(async (position, index): Promise<SessionStream | null> => {
      if (position === null) return null;
      const [cursor, consumed, pageLimit] = position;
      const page = await read(index, cursor, pageLimit);
      return {
        pageCursor: cursor,
        pageLimit,
        rows: page.threads,
        consumed: Math.min(consumed, page.threads.length),
        nextCursor: page.nextCursor,
      };
    }),
  );

  const threads: DelegationThreadListItem[] = [];
  while (threads.length < input.limit) {
    // A drained session may still hold the next row in sort order: read its next page first.
    await Promise.all(
      streams.map(async (stream, index) => {
        while (stream && stream.consumed >= stream.rows.length && stream.nextCursor !== null) {
          const cursor = stream.nextCursor;
          const page = await read(index, cursor, input.limit);
          Object.assign(stream, {
            pageCursor: cursor,
            pageLimit: input.limit,
            rows: page.threads,
            consumed: 0,
            nextCursor: page.nextCursor,
          });
        }
      }),
    );
    let best: SessionStream | undefined;
    for (const stream of streams) {
      const candidate = stream?.rows[stream.consumed];
      if (!stream || !candidate) continue;
      const current = best?.rows[best.consumed];
      if (!current || compare(candidate, current) < 0) best = stream;
    }
    const next = best?.rows[best.consumed];
    if (!best || !next) break;
    threads.push(next);
    best.consumed += 1;
  }

  const next: SessionPosition[] = streams.map((stream) => {
    if (!stream) return null;
    if (stream.consumed < stream.rows.length) {
      return [stream.pageCursor, stream.consumed, stream.pageLimit] as const;
    }
    return stream.nextCursor === null ? null : ([stream.nextCursor, 0, input.limit] as const);
  });
  return {
    threads,
    nextCursor: next.some((position) => position !== null)
      ? encodeCursor(input.sort, generation, next)
      : null,
  };
}
