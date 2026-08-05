import type { StoredThreadRecordV1 } from "@codexhost/mapping-store";
import {
  decodeHostThreadListCursor,
  decodeThreadListRequest,
  type JsonObject,
  type OfficialThreadListPage,
} from "@codexhost/protocol-core";
import {
  harnessIdSchema,
  hostThreadIdSchema,
  nativeSessionRefSchema,
} from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import {
  aggregateThreadList,
  officialThreadListPageFromResponse,
} from "../src/thread-list-aggregator.js";

const harnessId = harnessIdSchema.parse("pi");

function external(id: string, timestamp: number): StoredThreadRecordV1 {
  const hostThreadId = hostThreadIdSchema.parse(id);
  const date = new Date(timestamp * 1_000).toISOString();
  return {
    formatVersion: 1,
    revision: 1,
    hostThreadId,
    createRequestId: `create-${id}`,
    harnessId,
    state: "ready",
    nativeSessionRef: nativeSessionRefSchema.parse({
      harnessId,
      nativeSessionId: `native-${id}`,
      formatVersion: 1,
    }),
    cwd: "/workspace",
    title: id,
    archived: false,
    transportModelId: "codexhost/pi-native",
    ephemeral: false,
    historyMode: "legacy",
    turnMappings: [],
    createdAt: date,
    updatedAt: date,
  };
}

function official(id: string, timestamp: number): JsonObject {
  return { id, createdAt: timestamp, updatedAt: timestamp, recencyAt: timestamp };
}

function query(params: JsonObject) {
  const decoded = decodeThreadListRequest({ id: 1, method: "thread/list", params });
  if (!decoded) throw new Error("Expected list query");
  return decoded;
}

function officialSource(rows: JsonObject[]) {
  const calls: JsonObject[] = [];
  const request = async (params: JsonObject): Promise<OfficialThreadListPage> => {
    calls.push(params);
    const offset = typeof params.cursor === "string" ? Number(params.cursor) : 0;
    const limit = typeof params.limit === "number" ? params.limit : 25;
    const data = rows.slice(offset, offset + limit);
    return {
      data,
      nextCursor: offset + data.length < rows.length ? String(offset + data.length) : null,
      backwardsCursor: data.length > 0 ? String(Math.max(0, offset - limit)) : null,
    };
  };
  return { calls, request };
}

function directionalOfficialSource(rowsAscending: JsonObject[]) {
  return async (params: JsonObject): Promise<OfficialThreadListPage> => {
    const direction = params.sortDirection === "asc" ? "asc" : "desc";
    const ordered = direction === "asc" ? rowsAscending : [...rowsAscending].reverse();
    const cursor = typeof params.cursor === "string" ? params.cursor : `${direction}:0`;
    const [cursorDirection, offsetText] = cursor.split(":");
    if (cursorDirection !== direction) throw new Error("Official cursor direction mismatch");
    const offset = Number(offsetText);
    const limit = typeof params.limit === "number" ? params.limit : 25;
    const data = ordered.slice(offset, offset + limit);
    const oppositeDirection = direction === "asc" ? "desc" : "asc";
    return {
      data,
      nextCursor:
        offset + data.length < ordered.length ? `${direction}:${offset + data.length}` : null,
      backwardsCursor: data.length > 0 ? `${oppositeDirection}:${ordered.length - offset}` : null,
    };
  };
}

describe("aggregated Thread list", () => {
  it("terminates after an empty final official page", async () => {
    const source = officialSource([]);
    const page = await aggregateThreadList({
      query: query({ limit: 100, sortDirection: "desc" }),
      records: [],
      runtimeFor: () => null,
      requestOfficialPage: source.request,
    });

    expect(page).toMatchObject({ data: [], nextCursor: null, backwardsCursor: null });
    expect(source.calls).toHaveLength(1);
  });

  it("re-requests a partially consumed official batch for an exact cursor", async () => {
    const source = officialSource([official("official-5", 5), official("official-3", 3)]);
    const decoded = query({ limit: 2, sortKey: "created_at", sortDirection: "desc" });
    const page = await aggregateThreadList({
      query: decoded,
      records: [external("external-4", 4)],
      runtimeFor: () => null,
      requestOfficialPage: source.request,
    });
    expect(page.data.map((row) => row.id)).toEqual(["official-5", "external-4"]);
    expect(source.calls).toEqual([
      expect.objectContaining({ cursor: null, limit: 2 }),
      expect.objectContaining({ cursor: null, limit: 1 }),
    ]);
    if (!page.nextCursor) throw new Error("Expected an aggregated next cursor");
    const cursor = decodeHostThreadListCursor(page.nextCursor, {
      queryFingerprint: decoded.queryFingerprint,
      sortDirection: "desc",
    });
    expect(cursor).toMatchObject({
      officialCursor: "1",
      externalAnchor: { threadId: "external-4" },
    });
  });

  it("paginates interleaved sources without duplicates or omissions", async () => {
    const records = [external("external-6", 6), external("external-2", 2)];
    const rows = [official("official-5", 5), official("official-3", 3), official("official-1", 1)];
    let cursor: string | null = null;
    const ids: unknown[] = [];
    for (let pageIndex = 0; pageIndex < 4; pageIndex += 1) {
      const source = officialSource(rows);
      const decoded = query({ limit: 2, sortDirection: "desc", cursor });
      const page = await aggregateThreadList({
        query: decoded,
        records,
        runtimeFor: () => null,
        requestOfficialPage: source.request,
      });
      ids.push(...page.data.map((row) => row.id));
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    expect(ids).toEqual(["external-6", "official-5", "official-3", "external-2", "official-1"]);
  });

  it("uses a backwards cursor with the opposite direction to return the prior page", async () => {
    const records = [external("external-6", 6), external("external-2", 2)];
    const requestOfficialPage = directionalOfficialSource([
      official("official-1", 1),
      official("official-3", 3),
      official("official-5", 5),
    ]);
    const firstQuery = query({ limit: 2, sortDirection: "desc" });
    const first = await aggregateThreadList({
      query: firstQuery,
      records,
      runtimeFor: () => null,
      requestOfficialPage,
    });
    if (!first.nextCursor) throw new Error("Expected a second aggregated page");
    const secondQuery = query({ limit: 2, sortDirection: "desc", cursor: first.nextCursor });
    const second = await aggregateThreadList({
      query: secondQuery,
      records,
      runtimeFor: () => null,
      requestOfficialPage,
    });
    expect(second.data.map((row) => row.id)).toEqual(["official-3", "external-2"]);
    if (!second.backwardsCursor) throw new Error("Expected a backwards cursor");
    const backwardsQuery = query({
      limit: 2,
      sortDirection: "asc",
      cursor: second.backwardsCursor,
    });
    const backwards = await aggregateThreadList({
      query: backwardsQuery,
      records,
      runtimeFor: () => null,
      requestOfficialPage,
    });
    expect(backwards.data.map((row) => row.id)).toEqual(["official-5", "external-6"]);
  });

  it("uses External-first source ties and suppresses duplicate owned IDs", async () => {
    const source = officialSource([official("owned", 5), official("official", 5)]);
    const page = await aggregateThreadList({
      query: query({ limit: 3 }),
      records: [external("owned", 5), external("external", 5)],
      runtimeFor: () => null,
      requestOfficialPage: source.request,
    });
    expect(page.data.map((row) => row.id)).toEqual(["external", "owned", "official"]);
  });

  it("encodes backwards cursors for the opposite direction without row content", async () => {
    const source = officialSource([official("official", 5)]);
    const decoded = query({ limit: 2, sortDirection: "desc" });
    const page = await aggregateThreadList({
      query: decoded,
      records: [external("private-title-not-in-cursor", 6)],
      runtimeFor: () => null,
      requestOfficialPage: source.request,
    });
    expect(page.backwardsCursor).not.toContain("private-title-not-in-cursor");
    if (!page.backwardsCursor) throw new Error("Expected an aggregated backwards cursor");
    expect(
      decodeHostThreadListCursor(page.backwardsCursor, {
        queryFingerprint: decoded.queryFingerprint,
        sortDirection: "asc",
      }).sortDirection,
    ).toBe("asc");
  });

  it("preserves official RPC errors and rejects malformed success responses", () => {
    expect(() =>
      officialThreadListPageFromResponse({
        id: "internal",
        error: { code: -32000, message: "bad" },
      }),
    ).toThrow("bad");
    expect(() =>
      officialThreadListPageFromResponse({ id: "internal", result: { data: [null] } }),
    ).toThrow("invalid");
    expect(() =>
      officialThreadListPageFromResponse({ id: "internal", error: { message: "no code" } }),
    ).toThrow("invalid");
  });
});
