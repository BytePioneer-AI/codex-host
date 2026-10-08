import { describe, expect, it } from "vitest";

import type { JsonObject } from "@codexhost/protocol-core";

import {
  ExternalHistoryRequestError,
  listExternalItems,
  listExternalTurns,
} from "../src/external-thread-history.js";

function turn(ordinal: number): JsonObject {
  return {
    id: `turn-${ordinal}`,
    status: "completed",
    items: [
      {
        id: `user-${ordinal}`,
        type: "userMessage",
        content: [{ type: "text", text: `question ${ordinal}` }],
      },
      {
        id: `tool-${ordinal}`,
        type: "dynamicToolCall",
        tool: "test",
      },
      {
        id: `agent-${ordinal}`,
        type: "agentMessage",
        text: `answer ${ordinal}`,
      },
    ],
    itemsView: "full",
  };
}

function ids(values: JsonObject[]): unknown[] {
  return values.map((value) => value.id);
}

describe("External Thread history pagination", () => {
  it("pages Turns newest-first with stable anchor cursors", () => {
    const turns = Array.from({ length: 6 }, (_, index) => turn(index + 1));
    const first = listExternalTurns(turns, { limit: 2, itemsView: "notLoaded" });
    expect(ids(first.data)).toEqual(["turn-6", "turn-5"]);
    expect(first.nextCursor).not.toBeNull();
    expect(first.backwardsCursor).not.toBeNull();
    expect(first.data).toMatchObject([
      { items: [], itemsView: "notLoaded" },
      { items: [], itemsView: "notLoaded" },
    ]);

    const second = listExternalTurns(turns, {
      cursor: first.nextCursor,
      limit: 2,
      sortDirection: "desc",
    });
    expect(ids(second.data)).toEqual(["turn-4", "turn-3"]);

    const reverse = listExternalTurns(turns, {
      cursor: second.backwardsCursor,
      limit: 2,
      sortDirection: "asc",
    });
    expect(ids(reverse.data)).toEqual(["turn-4", "turn-5"]);
  });

  it("projects summary and full Turn item views", () => {
    const turns = [turn(1)];
    expect(listExternalTurns(turns, {}).data[0]).toMatchObject({
      itemsView: "summary",
      items: [{ id: "user-1" }, { id: "agent-1" }],
    });
    expect(listExternalTurns(turns, { itemsView: "full" }).data[0]).toMatchObject({
      itemsView: "full",
      items: [{ id: "user-1" }, { id: "tool-1" }, { id: "agent-1" }],
    });
  });

  it("pages Items in chronological order and filters by Turn", () => {
    const turns = [turn(1), turn(2)];
    const first = listExternalItems(turns, { limit: 4 });
    expect(first.data).toMatchObject([
      { turnId: "turn-1", item: { id: "user-1" } },
      { turnId: "turn-1", item: { id: "tool-1" } },
      { turnId: "turn-1", item: { id: "agent-1" } },
      { turnId: "turn-2", item: { id: "user-2" } },
    ]);
    expect(
      listExternalItems(turns, { turnId: "turn-2", sortDirection: "desc" }).data,
    ).toMatchObject([
      { turnId: "turn-2", item: { id: "agent-2" } },
      { turnId: "turn-2", item: { id: "tool-2" } },
      { turnId: "turn-2", item: { id: "user-2" } },
    ]);
  });

  it("keeps Item cursor scope global when filtering by Turn", () => {
    const turns = [turn(1), turn(2)];
    const globalHead = listExternalItems(turns, {
      limit: 1,
      sortDirection: "desc",
    }).backwardsCursor;
    expect(globalHead).not.toBeNull();

    // thread/resume returns the global Item head. Desktop may reuse that cursor
    // while loading each Turn individually, so turnId must not narrow cursor scope.
    expect(
      listExternalItems(turns, {
        turnId: "turn-1",
        cursor: globalHead,
      }),
    ).toMatchObject({ data: [], nextCursor: null, backwardsCursor: null });

    expect(
      listExternalItems(turns, {
        turnId: "turn-1",
        cursor: globalHead,
        sortDirection: "desc",
      }).data,
    ).toMatchObject([
      { turnId: "turn-1", item: { id: "agent-1" } },
      { turnId: "turn-1", item: { id: "tool-1" } },
      { turnId: "turn-1", item: { id: "user-1" } },
    ]);
  });

  it("caps page sizes at the official limit", () => {
    const turns = Array.from({ length: 120 }, (_, index) => turn(index + 1));
    expect(listExternalTurns(turns, { limit: 500 }).data).toHaveLength(100);
  });

  it.each(["asc", "desc"])("reads only one Item page plus lookahead in %s order", (direction) => {
    let reads = 0;
    const items = Array.from({ length: 1000 }, (_, index) => ({ id: `item-${index}` }));
    const counted = new Proxy(items, {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/.test(property)) reads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    const page = listExternalItems([{ id: "large", items: counted }], {
      limit: 25,
      sortDirection: direction,
    });
    expect(page.data).toHaveLength(25);
    expect(page.nextCursor).not.toBeNull();
    expect(reads).toBe(26);
  });

  it("loads a Turn without enumerating unrelated Item arrays", () => {
    const unrelated = turn(1);
    Object.defineProperty(unrelated, "items", {
      get() {
        throw new Error("unrelated Items were read");
      },
    });
    expect(listExternalItems([unrelated, turn(2)], { turnId: "turn-2" }).data).toHaveLength(3);
  });

  it("does not enumerate Items in the notLoaded view", () => {
    const large = turn(1);
    large.items = new Proxy(large.items as JsonObject[], {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/.test(property)) {
          throw new Error("unloaded Items were enumerated");
        }
        return Reflect.get(target, property, receiver);
      },
    });
    expect(listExternalTurns([large], { itemsView: "notLoaded" }).data[0]?.items).toEqual([]);
  });

  it("stops summary searches at the first user and last agent message", () => {
    const value = turn(1);
    let reads = 0;
    value.items = new Proxy(value.items as JsonObject[], {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/.test(property)) reads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    expect(listExternalTurns([value], {}).data[0]?.items).toMatchObject([
      { id: "user-1" },
      { id: "agent-1" },
    ]);
    expect(reads).toBe(2);
  });

  it.each(["asc", "desc"])("reads only one Turn page plus lookahead in %s order", (direction) => {
    let reads = 0;
    const values = new Proxy(
      Array.from({ length: 1000 }, (_, index) => turn(index)),
      {
        get(target, property, receiver) {
          if (typeof property === "string" && /^\d+$/.test(property)) reads += 1;
          return Reflect.get(target, property, receiver);
        },
      },
    );
    expect(listExternalTurns(values, { sortDirection: direction, limit: 25 }).data).toHaveLength(
      25,
    );
    expect(reads).toBe(26);
  });

  it.each(["asc", "desc"])(
    "traverses Item pages and reverses inclusively in %s order",
    (direction) => {
      const turns = [turn(1), { id: "empty", items: [] }, turn(2), turn(3)];
      const expected = turns.flatMap((value) =>
        (value.items as JsonObject[]).map((item) => ({ turnId: value.id, item })),
      );
      if (direction === "desc") expected.reverse();
      const actual: JsonObject[] = [];
      let cursor: string | null = null;
      do {
        const page = listExternalItems(turns, { limit: 2, cursor, sortDirection: direction });
        actual.push(...page.data);
        if (page.data.length > 0) {
          const reverse = listExternalItems(turns, {
            limit: 2,
            cursor: page.backwardsCursor,
            sortDirection: direction === "asc" ? "desc" : "asc",
          });
          expect(reverse.data[0]).toEqual(page.data[0]);
        }
        cursor = page.nextCursor;
      } while (cursor !== null);
      expect(actual).toEqual(expected);
    },
  );

  it("validates a global Item anchor before applying a Turn filter", () => {
    const cursor = JSON.stringify({
      anchor: JSON.stringify(["turn-2", "removed"]),
      includeAnchor: true,
    });
    expect(() => listExternalItems([turn(1), turn(2)], { cursor, turnId: "turn-1" })).toThrow(
      "cursor anchor is no longer present",
    );
  });

  it("skips non-object Items and handles an excluded final anchor", () => {
    const turns = [{ id: "mixed", items: [null, 1, "text", [], { id: "only" }, false] }];
    const page = listExternalItems(turns, { limit: 1 });
    expect(page.data).toEqual([{ turnId: "mixed", item: { id: "only" } }]);
    expect(page.nextCursor).toBeNull();
    expect(
      listExternalItems(turns, {
        cursor: JSON.stringify({ anchor: JSON.stringify(["mixed", "only"]), includeAnchor: false }),
      }).data,
    ).toEqual([]);
  });

  it("rejects malformed and stale cursors", () => {
    expect(() => listExternalTurns([turn(1)], { cursor: "not-json" })).toThrow(
      ExternalHistoryRequestError,
    );
    expect(() =>
      listExternalTurns([turn(1)], {
        cursor: JSON.stringify({ anchor: "missing", includeAnchor: false }),
      }),
    ).toThrow("cursor anchor is no longer present");
    expect(() =>
      listExternalItems([turn(1)], {
        cursor: JSON.stringify({ anchor: "missing", includeAnchor: false }),
        turnId: "turn-1",
      }),
    ).toThrow("cursor anchor is no longer present");
  });
});
