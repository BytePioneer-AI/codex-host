import type { JsonObject, OfficialThreadListPage } from "@codexhost/protocol-core";
import { decodeThreadListRequest } from "@codexhost/protocol-core";
import { describe, expect, it } from "vitest";

import { aggregateOfficialAccountThreadListPage } from "../src/multi-account-thread-list.js";

function query(cursor: string | null = null) {
  const decoded = decodeThreadListRequest({
    id: 1,
    method: "thread/list",
    params: { limit: 2, sortDirection: "desc", cursor },
  });
  if (!decoded) throw new Error("Expected thread/list query");
  return decoded;
}

function source(rows: Record<string, JsonObject[]>) {
  return async (accountId: string, params: JsonObject): Promise<OfficialThreadListPage> => {
    const accountRows = rows[accountId] ?? [];
    const offset = typeof params.cursor === "string" ? Number(params.cursor) : 0;
    const limit = typeof params.limit === "number" ? params.limit : 2;
    const data = accountRows.slice(offset, offset + limit);
    return {
      data,
      nextCursor: offset + data.length < accountRows.length ? String(offset + data.length) : null,
      backwardsCursor: data.length > 0 ? "0" : null,
    };
  };
}

describe("Multi-Account official Thread list", () => {
  it("merges and paginates Account sources without duplicates or omissions", async () => {
    const requestAccountPage = source({
      a: [
        { id: "a-5", createdAt: 5, updatedAt: 5, recencyAt: 5 },
        { id: "a-2", createdAt: 2, updatedAt: 2, recencyAt: 2 },
      ],
      b: [
        { id: "b-4", createdAt: 4, updatedAt: 4, recencyAt: 4 },
        { id: "b-1", createdAt: 1, updatedAt: 1, recencyAt: 1 },
      ],
    });
    const observed: string[] = [];
    let cursor: string | null = null;
    const ids: unknown[] = [];
    for (let index = 0; index < 3; index += 1) {
      const decoded = query(cursor);
      const page = await aggregateOfficialAccountThreadListPage({
        query: decoded,
        accountIds: ["a", "b"],
        params: decoded.params,
        requestAccountPage,
        observeThread: async (threadId, accountId) => {
          observed.push(`${threadId}:${accountId}`);
        },
      });
      ids.push(...page.data.map((thread) => thread.id));
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    expect(ids).toEqual(["a-5", "b-4", "a-2", "b-1"]);
    expect(observed).toEqual(["a-5:a", "b-4:b", "a-2:a", "b-1:b"]);
  });

  it("keeps the Account snapshot inside the opaque cursor", async () => {
    const decoded = query();
    const first = await aggregateOfficialAccountThreadListPage({
      query: decoded,
      accountIds: ["a", "b"],
      params: decoded.params,
      requestAccountPage: source({
        a: [{ id: "a", createdAt: 2, updatedAt: 2 }],
        b: [
          { id: "b", createdAt: 1, updatedAt: 1 },
          { id: "b2", createdAt: 0, updatedAt: 0 },
        ],
      }),
    });
    expect(first.nextCursor).toMatch(/^codexhost:official-accounts:v1:/u);
    const next = query(first.nextCursor);
    const second = await aggregateOfficialAccountThreadListPage({
      query: next,
      accountIds: ["a", "b", "new-account"],
      params: next.params,
      requestAccountPage: source({ b: [{ id: "b2", createdAt: 0, updatedAt: 0 }] }),
    });
    expect(second.data.map((thread) => thread.id)).not.toContain("new-account");
  });
});
