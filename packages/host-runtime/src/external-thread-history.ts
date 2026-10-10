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
  values: Iterable<T>,
  key: (value: T) => string,
  limit: number,
): { data: T[]; nextCursor: string | null; backwardsCursor: string | null } {
  const data: T[] = [];
  let hasMore = false;
  for (const value of values) {
    if (data.length === limit) {
      hasMore = true;
      break;
    }
    data.push(value);
  }
  return {
    data,
    nextCursor:
      hasMore && data.length > 0 ? serializeCursor(key(data[data.length - 1] as T), false) : null,
    backwardsCursor: data.length > 0 ? serializeCursor(key(data[0] as T), true) : null,
  };
}

function* turnEntries(
  turns: JsonObject[],
  direction: SortDirection,
  cursor: Cursor | null,
): Generator<JsonObject> {
  const step = direction === "asc" ? 1 : -1;
  let start = step === 1 ? 0 : turns.length - 1;
  if (cursor) {
    const matches = (turn: JsonObject) => id(turn, "Turn") === cursor.anchor;
    const anchorIndex = step === 1 ? turns.findIndex(matches) : turns.findLastIndex(matches);
    if (anchorIndex < 0) {
      throw new ExternalHistoryRequestError("cursor anchor is no longer present");
    }
    start = anchorIndex + (cursor.includeAnchor ? 0 : step);
  }
  for (let index = start; index >= 0 && index < turns.length; index += step) {
    yield turns[index] as JsonObject;
  }
}

function turnWithItemsView(turn: JsonObject, view: ItemsView): JsonObject {
  if (view === "notLoaded") return { ...turn, items: [], itemsView: "notLoaded" };
  const items = Array.isArray(turn.items) ? turn.items : [];
  if (view === "full") return { ...turn, items: items.filter(isItem), itemsView: "full" };
  const user = items.find(
    (item): item is JsonObject => isItem(item) && item.type === "userMessage",
  );
  const agent = items.findLast(
    (item): item is JsonObject => isItem(item) && item.type === "agentMessage",
  );
  return {
    ...turn,
    items:
      user && agent && user.id !== agent.id ? [user, agent] : user ? [user] : agent ? [agent] : [],
    itemsView: "summary",
  };
}

export function listExternalTurns(turns: JsonObject[], params: JsonObject): ExternalHistoryPage {
  const direction = sortDirection(params.sortDirection, "desc");
  const cursor = parseCursor(params.cursor);
  const page = pageEntries(
    turnEntries(turns, direction, cursor),
    (turn) => id(turn, "Turn"),
    pageSize(params.limit),
  );
  const view = itemsView(params.itemsView);
  return {
    ...page,
    data: page.data.map((turn) => turnWithItemsView(turn, view)),
  };
}

function isItem(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function itemAnchor(
  turns: JsonObject[],
  cursor: Cursor,
  direction: SortDirection,
): { turnIndex: number; itemIndex: number } {
  let anchor: unknown;
  try {
    anchor = JSON.parse(cursor.anchor);
  } catch {
    // An unmatched key is a stale anchor, even if it is not a JSON pair.
  }
  if (
    Array.isArray(anchor) &&
    anchor.length === 2 &&
    anchor.every((part) => typeof part === "string" && part.length > 0) &&
    JSON.stringify(anchor) === cursor.anchor
  ) {
    const matchesTurn = (turn: JsonObject) => id(turn, "Turn") === anchor[0];
    const turnIndex =
      direction === "asc" ? turns.findIndex(matchesTurn) : turns.findLastIndex(matchesTurn);
    const items = turns[turnIndex]?.items;
    if (Array.isArray(items)) {
      const matchesItem = (item: JsonValue) => isItem(item) && id(item, "Item") === anchor[1];
      const itemIndex =
        direction === "asc" ? items.findIndex(matchesItem) : items.findLastIndex(matchesItem);
      if (itemIndex >= 0) return { turnIndex, itemIndex };
    }
  }
  throw new ExternalHistoryRequestError("cursor anchor is no longer present");
}

function* itemEntries(
  turns: JsonObject[],
  direction: SortDirection,
  cursor: Cursor | null,
  turnId: string | null,
): Generator<ItemEntry> {
  const step = direction === "asc" ? 1 : -1;
  // Resolve the anchor in the full history before filtering by Turn. Desktop
  // can reuse the global Item head cursor while loading individual Turns.
  const anchor = cursor ? itemAnchor(turns, cursor, direction) : null;
  const startTurn = anchor?.turnIndex ?? (step === 1 ? 0 : turns.length - 1);
  for (let turnIndex = startTurn; turnIndex >= 0 && turnIndex < turns.length; turnIndex += step) {
    const turn = turns[turnIndex] as JsonObject;
    const currentTurnId = id(turn, "Turn");
    if (turnId !== null && currentTurnId !== turnId) continue;
    const items = turn.items;
    if (!Array.isArray(items)) continue;
    const startItem =
      anchor && turnIndex === anchor.turnIndex
        ? anchor.itemIndex + (cursor?.includeAnchor ? 0 : step)
        : step === 1
          ? 0
          : items.length - 1;
    for (let itemIndex = startItem; itemIndex >= 0 && itemIndex < items.length; itemIndex += step) {
      const item = items[itemIndex];
      if (!isItem(item)) continue;
      yield { key: JSON.stringify([currentTurnId, id(item, "Item")]), turnId: currentTurnId, item };
    }
  }
}

export function listExternalItems(turns: JsonObject[], params: JsonObject): ExternalHistoryPage {
  const turnId = optionalText(params.turnId, "turnId");
  const direction = sortDirection(params.sortDirection, "asc");
  const cursor = parseCursor(params.cursor);
  const page = pageEntries(
    itemEntries(turns, direction, cursor, turnId),
    (entry) => entry.key,
    pageSize(params.limit),
  );
  return {
    ...page,
    data: page.data.map(({ turnId: currentTurnId, item }) => ({
      turnId: currentTurnId,
      item,
    })),
  };
}
