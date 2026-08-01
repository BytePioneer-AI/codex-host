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

  it("caps page sizes at the official limit", () => {
    const turns = Array.from({ length: 120 }, (_, index) => turn(index + 1));
    expect(listExternalTurns(turns, { limit: 500 }).data).toHaveLength(100);
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
  });
});
