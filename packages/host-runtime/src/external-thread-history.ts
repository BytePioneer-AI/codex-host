import type { JsonObject, JsonValue } from "@codexhost/protocol-core";

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

type SortDirection = "asc" | "desc";
type ItemsView = "notLoaded" | "summary" | "full";

interface Cursor {
  anchor: string;
  includeAnchor: boolean;
}

interface ItemEntry {
  key: string;
  turnId: string;
  item: JsonObject;
}

export type ExternalHistoryPage = JsonObject & {
  data: JsonObject[];
  nextCursor: string | null;
  backwardsCursor: string | null;
};

export class ExternalHistoryRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExternalHistoryRequestError";
  }
}

function optionalText(value: JsonValue | undefined, name: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new ExternalHistoryRequestError(`${name} must be text`);
  return value;
}

function pageSize(value: JsonValue | undefined): number {
  if (value === undefined || value === null) return DEFAULT_PAGE_SIZE;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ExternalHistoryRequestError("limit must be a non-negative integer");
  }
  return Math.min(MAX_PAGE_SIZE, Math.max(1, value as number));
}

function sortDirection(value: JsonValue | undefined, fallback: SortDirection): SortDirection {
  if (value === undefined || value === null) return fallback;
  if (value !== "asc" && value !== "desc") {
    throw new ExternalHistoryRequestError("sortDirection must be 'asc' or 'desc'");
  }
  return value;
}

function itemsView(value: JsonValue | undefined): ItemsView {
  if (value === undefined || value === null) return "summary";
  if (value !== "notLoaded" && value !== "summary" && value !== "full") {
    throw new ExternalHistoryRequestError("itemsView must be 'notLoaded', 'summary', or 'full'");
  }
  return value;
}

function serializeCursor(anchor: string, includeAnchor: boolean): string {
  return JSON.stringify({ anchor, includeAnchor });
}

function parseCursor(value: JsonValue | undefined): Cursor | null {
  const text = optionalText(value, "cursor");
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text) as Partial<Cursor>;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof parsed.anchor === "string" &&
      parsed.anchor.length > 0 &&
      typeof parsed.includeAnchor === "boolean"
    ) {
      return { anchor: parsed.anchor, includeAnchor: parsed.includeAnchor };
    }
  } catch {
    // Normalized below.
  }
  throw new ExternalHistoryRequestError("cursor is invalid");
}

function id(value: JsonObject, name: string): string {
  if (typeof value.id !== "string" || value.id.length === 0) {
    throw new Error(`External history ${name} has no stable ID`);
  }
  return value.id;
}

function pageEntries<T>(
  values: T[],
  key: (value: T) => string,
  input: {
    cursor: JsonValue | undefined;
    limit: JsonValue | undefined;
    sortDirection: JsonValue | undefined;
  },
  fallbackDirection: SortDirection,
  filter: (value: T) => boolean = () => true,
): { data: T[]; nextCursor: string | null; backwardsCursor: string | null } {
  const direction = sortDirection(input.sortDirection, fallbackDirection);
  const cursor = parseCursor(input.cursor);
  const ordered = direction === "asc" ? values : [...values].reverse();
  let start = 0;
  if (cursor) {
    const anchorIndex = ordered.findIndex((value) => key(value) === cursor.anchor);
    if (anchorIndex < 0) {
      throw new ExternalHistoryRequestError("cursor anchor is no longer present");
    }
    start = anchorIndex + (cursor.includeAnchor ? 0 : 1);
  }
  const limit = pageSize(input.limit);
  // Cursors describe positions in the full Thread history. Filters such as
  // turnId narrow the rows returned after applying that global boundary; they
  // must not redefine the cursor's scope.
  const eligible = ordered.slice(start).filter(filter);
  const data = eligible.slice(0, limit);
  const hasMore = data.length < eligible.length;
  return {
    data,
    nextCursor:
      hasMore && data.length > 0 ? serializeCursor(key(data[data.length - 1] as T), false) : null,
    backwardsCursor: data.length > 0 ? serializeCursor(key(data[0] as T), true) : null,
  };
}

function turnWithItemsView(turn: JsonObject, view: ItemsView): JsonObject {
  const items = Array.isArray(turn.items)
    ? turn.items.filter(
        (item): item is JsonObject =>
          typeof item === "object" && item !== null && !Array.isArray(item),
      )
    : [];
  if (view === "full") return { ...turn, items, itemsView: "full" };
  if (view === "notLoaded") return { ...turn, items: [], itemsView: "notLoaded" };
  const user = items.find((item) => item.type === "userMessage");
  const agent = items.findLast((item) => item.type === "agentMessage");
  return {
    ...turn,
    items:
      user && agent && user.id !== agent.id ? [user, agent] : user ? [user] : agent ? [agent] : [],
    itemsView: "summary",
  };
}

export function listExternalTurns(turns: JsonObject[], params: JsonObject): ExternalHistoryPage {
  const page = pageEntries(
    turns,
    (turn) => id(turn, "Turn"),
    {
      cursor: params.cursor,
      limit: params.limit,
      sortDirection: params.sortDirection,
    },
    "desc",
  );
  const view = itemsView(params.itemsView);
  return {
    ...page,
    data: page.data.map((turn) => turnWithItemsView(turn, view)),
  };
}

function itemEntries(turns: JsonObject[]): ItemEntry[] {
  return turns.flatMap((turn) => {
    const currentTurnId = id(turn, "Turn");
    if (!Array.isArray(turn.items)) return [];
    return turn.items.flatMap((item) => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) return [];
      const itemId = id(item, "Item");
      return [{ key: JSON.stringify([currentTurnId, itemId]), turnId: currentTurnId, item }];
    });
  });
}

export function listExternalItems(turns: JsonObject[], params: JsonObject): ExternalHistoryPage {
  const turnId = optionalText(params.turnId, "turnId");
  const page = pageEntries(
    itemEntries(turns),
    (entry) => entry.key,
    {
      cursor: params.cursor,
      limit: params.limit,
      sortDirection: params.sortDirection,
    },
    "asc",
    (entry) => turnId === null || entry.turnId === turnId,
  );
  return {
    ...page,
    data: page.data.map(({ turnId: currentTurnId, item }) => ({
      turnId: currentTurnId,
      item,
    })),
  };
}
