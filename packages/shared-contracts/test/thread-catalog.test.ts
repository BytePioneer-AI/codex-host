import { expect, it } from "vitest";
import {
  CLIENT_CHANNEL_METHODS,
  THREAD_CATALOG_READ_METHOD,
  threadCatalogReadParamsSchema,
  threadCatalogReadResultSchema,
  type JsonObject,
  type ThreadCatalogReadResult,
} from "../src/index.js";

it("exports a client-allowlisted strict catalog request and JSON-list-row response", () => {
  expect(CLIENT_CHANNEL_METHODS).toContain(THREAD_CATALOG_READ_METHOD);
  expect(threadCatalogReadParamsSchema.parse({})).toEqual({});
  expect(threadCatalogReadParamsSchema.parse({ includeArchived: true })).toEqual({
    includeArchived: true,
  });
  for (const value of [{ includeArchived: null }, { includeArchived: 1 }, { cursor: "x" }]) {
    expect(threadCatalogReadParamsSchema.safeParse(value).success).toBe(false);
  }
  expect(
    threadCatalogReadResultSchema.parse({ threads: [], ownership: [], archivedThreadIds: [] }),
  ).toEqual({ threads: [], ownership: [], archivedThreadIds: [] });
  expect(
    threadCatalogReadResultSchema.parse({
      threads: [],
      ownership: [],
      archivedThreadIds: ["local-archived-without-row"],
    }).archivedThreadIds,
  ).toEqual(["local-archived-without-row"]);
  const rows: JsonObject[] = Array.from({ length: 201 }, (_, n) => ({
    id: `native-${n}`,
    turns: [],
  }));
  const result: ThreadCatalogReadResult = threadCatalogReadResultSchema.parse({
    threads: rows,
    ownership: rows.map((thread) => ({ threadId: thread.id, owner: "codex" })),
    archivedThreadIds: ["native-0"],
  });
  expect(result.threads).toEqual(rows);
  expect(
    threadCatalogReadResultSchema.safeParse({
      threads: [],
      ownership: [{ threadId: "unknown", owner: "external" }],
      archivedThreadIds: [],
    }).success,
  ).toBe(false);
});
