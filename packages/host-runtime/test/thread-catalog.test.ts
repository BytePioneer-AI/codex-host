import type { StoredThreadRecordV1 } from "@codexhost/mapping-store";
import type { JsonObject, OfficialThreadListPage } from "@codexhost/protocol-core";
import {
  harnessIdSchema,
  hostThreadIdSchema,
  nativeSessionRefSchema,
  threadCatalogReadResultSchema,
} from "@codexhost/shared-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readThreadCatalog, type ThreadCatalogInput } from "../src/thread-catalog.js";
import { OfficialAdmissionError } from "../src/codex-runtime/official-work-gate.js";

function external(id: string, timestamp: number, archived = false): StoredThreadRecordV1 {
  const harnessId = harnessIdSchema.parse("pi");
  const date = new Date(timestamp * 1_000).toISOString();
  return {
    formatVersion: 1,
    revision: 1,
    hostThreadId: hostThreadIdSchema.parse(id),
    createRequestId: `create-${id}`,
    harnessId,
    state: "ready",
    nativeSessionRef: nativeSessionRefSchema.parse({
      harnessId,
      nativeSessionId: `native-${id}`,
      formatVersion: 1,
    }),
    cwd: "/private-workspace",
    title: "private-title",
    archived,
    transportModelId: "codexhost/pi-native",
    ephemeral: false,
    historyMode: "legacy",
    turnMappings: [],
    createdAt: date,
    updatedAt: date,
  };
}
function row(id: string, timestamp: number): JsonObject {
  return { id, createdAt: timestamp, updatedAt: timestamp, turns: [] };
}
function page(data: JsonObject[], nextCursor: string | null = null): OfficialThreadListPage {
  return { data, nextCursor, backwardsCursor: null };
}
function input(records: StoredThreadRecordV1[] = []): ThreadCatalogInput {
  return {
    readLocal: async () => ({ records, placements: [] }),
    runtimeFor: () => null,
    requestOfficialPage: async () => page([]),
    diagnose: vi.fn(),
  };
}

describe("source-separated Thread catalog", () => {
  beforeEach(() => vi.stubEnv("CODEXHOST_TRACE_SESSION_LIST", "1"));
  afterEach(() => vi.unstubAllEnvs());

  it.each([undefined, "0"])(
    "keeps details opt-in with trace=%s but always reports failures",
    async (trace) => {
      vi.stubEnv("CODEXHOST_TRACE_SESSION_LIST", trace);
      const options = input();
      await expect(readThreadCatalog(options)).resolves.toMatchObject({ threads: [] });
      expect(options.diagnose).not.toHaveBeenCalled();
      options.requestOfficialPage = async () => {
        throw new Error("Sensitive native error");
      };
      await expect(readThreadCatalog(options)).rejects.toThrow("Sensitive native error");
      expect(options.diagnose).toHaveBeenCalledExactlyOnceWith(
        "[thread/catalog/read] request failed",
      );
    },
  );

  it("starts native and local reads together, reads exactly the latest 20 once, and defaults to live only", async () => {
    const localStarted = Promise.withResolvers<undefined>();
    const nativeStarted = Promise.withResolvers<undefined>();
    const nativeRows = Array.from({ length: 301 }, (_, n) => row(`private-native-${n}`, 400 - n));
    const options = input([external("private-external", 500)]);
    options.readLocal = vi.fn(async () => {
      localStarted.resolve(undefined);
      await nativeStarted.promise;
      return { records: [external("private-external", 500)], placements: [] };
    });
    const request = vi.fn(async (params: JsonObject) => {
      nativeStarted.resolve(undefined);
      await localStarted.promise;
      const offset = params.cursor === null ? 0 : Number(params.cursor);
      return page(nativeRows.slice(offset, offset + 20), offset < 300 ? String(offset + 20) : null);
    });
    options.requestOfficialPage = request;
    const result = await readThreadCatalog(options);
    expect(options.readLocal).toHaveBeenCalledTimes(1);
    expect(request.mock.calls.map(([params]) => params)).toEqual(
      [null].map((cursor) => ({
        cursor,
        archived: false,
        limit: 20,
        sortKey: "updated_at",
        sortDirection: "desc",
      })),
    );
    expect(result.threads).toHaveLength(21);
    expect(result.officialCursor).toEqual({ live: "20" });
    expect(result.threads[0]?.id).toBe("private-external");
    expect(result.archivedThreadIds).toEqual([]);
    expect(threadCatalogReadResultSchema.parse(result)).toEqual(result);
    expect(options.diagnose).toHaveBeenCalledWith(expect.stringContaining('"official":{"ms":'));
    const log = vi.mocked(options.diagnose).mock.calls[0]?.[0] ?? "";
    expect(log).toContain('"requests":1');
    expect(log).not.toMatch(
      /private-native|private-external|private-title|private-workspace|cursor/i,
    );
  });

  it("reads one archived page in parallel, deduplicates archive branches, and keeps ownership aligned", async () => {
    const liveStarted = Promise.withResolvers<undefined>();
    const archivedStarted = Promise.withResolvers<undefined>();
    const request = vi.fn(async (params: JsonObject) => {
      if (params.archived) {
        archivedStarted.resolve(undefined);
        await liveStarted.promise;
        return page([row("native-live", 100), row("native-archived", 2)]);
      }
      liveStarted.resolve(undefined);
      await archivedStarted.promise;
      return params.cursor === null
        ? page([row("native-live", 6), row("native-live", 5)], "next")
        : page([row("native-live", 4), row("native-other", 3)]);
    });
    const result = await readThreadCatalog({
      ...input([external("local-live", 7), external("local-archived", 1, true)]),
      includeArchived: true,
      requestOfficialPage: request,
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(result.officialCursor).toEqual({ live: "next", archived: null });
    expect(result.threads.map((thread) => thread.id)).toEqual([
      "local-live",
      "native-live",
      "native-archived",
      "local-archived",
    ]);
    expect(result.ownership.map((owner) => owner.threadId)).toEqual(
      result.threads.map((thread) => thread.id),
    );
    expect(result.archivedThreadIds).toEqual(["native-archived", "local-archived"]);
    expect(result.threads.find((thread) => thread.id === "native-live")?.updatedAt).toBe(6);
    expect(
      result.threads.every((thread) => Array.isArray(thread.turns) && thread.turns.length === 0),
    ).toBe(true);
  });

  it("returns known visible local archived IDs without projecting their rows or reading native archives", async () => {
    const parent = external("parent", 5);
    const archived = external("known-archived", 2, true);
    const hiddenChild: StoredThreadRecordV1 = {
      ...external("hidden-child", 3, true),
      nativeSessionRef: parent.nativeSessionRef,
      subagent: { parentHostThreadId: parent.hostThreadId, nativeSubagentId: "child" },
    };
    const options = input([
      parent,
      archived,
      hiddenChild,
      { ...external("creating", 1, true), state: "creating" },
      { ...external("without-session", 1, true), nativeSessionRef: undefined },
    ]);
    options.readLocal = vi.fn(options.readLocal);
    const runtimeFor = vi.fn(() => null);
    const request = vi.fn(async () => page([row("native", 4)]));
    const result = await readThreadCatalog({
      ...options,
      runtimeFor,
      requestOfficialPage: request,
    });
    expect(result.threads.map((thread) => thread.id)).toEqual(["parent", "native"]);
    expect(result.ownership.map((owner) => owner.threadId)).toEqual(["parent", "native"]);
    expect(result.archivedThreadIds).toEqual(["known-archived"]);
    expect(options.readLocal).toHaveBeenCalledTimes(1);
    expect(runtimeFor).toHaveBeenCalledExactlyOnceWith("parent");
    expect(request).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ archived: false }));
  });

  it("sorts native and external rows by last update rather than creation time", async () => {
    const record = { ...external("external", 20), updatedAt: new Date(1_000).toISOString() };
    const result = await readThreadCatalog({
      ...input([record]),
      requestOfficialPage: async (params) => {
        expect(params.sortKey).toBe("updated_at");
        return page([{ ...row("native", 10), updatedAt: 1000 }]);
      },
    });
    expect(result.threads.map((thread) => thread.id)).toEqual(["native", "external"]);
  });

  it("shares lazy initialization between archive branches and only degrades admission unavailable", async () => {
    const initializeOfficial = vi.fn(async () => {
      throw new OfficialAdmissionError("unavailable");
    });
    const request = vi.fn(async () => page([row("native", 1)]));
    const result = await readThreadCatalog({
      ...input([external("external", 2)]),
      includeArchived: true,
      initializeOfficial,
      requestOfficialPage: request,
    });
    expect(result.ownership).toEqual([
      { threadId: "external", owner: "external", harnessId: "pi" },
    ]);
    expect(initializeOfficial).toHaveBeenCalledTimes(1);
    expect(request).not.toHaveBeenCalled();
    for (const failure of [
      new OfficialAdmissionError("busy"),
      new Error("initialization timeout"),
    ]) {
      await expect(
        readThreadCatalog({
          ...input(),
          initializeOfficial: async () => {
            throw failure;
          },
          requestOfficialPage: request,
        }),
      ).rejects.toBe(failure);
    }
    expect(request).not.toHaveBeenCalled();
  });

  for (const afterPage of [false, true]) {
    it(`does not swallow unavailable after successful initialization${afterPage ? " and a page" : ""}`, async () => {
      const failure = new OfficialAdmissionError("unavailable");
      const request = vi.fn(async (params: JsonObject) => {
        if (afterPage && params.cursor === null) return page([row("native", 1)], "next");
        throw failure;
      });
      await expect(
        readThreadCatalog({
          ...input(),
          initializeOfficial: async () => {},
          ...(afterPage ? { officialCursor: { live: "next" } } : {}),
          requestOfficialPage: request,
        }),
      ).rejects.toBe(failure);
      expect(request).toHaveBeenCalledTimes(1);
    });
  }

  it("reuses external visibility and shared-row precedence, requiring shared ownership instead of guessing Codex", async () => {
    const sharedList = vi.fn(async () => [
      { ...row("shared", 9), status: { type: "active" }, turns: [{ private: "body" }] },
      row("unconfirmed", 10),
    ]);
    const ownership = vi.fn(async () => new Map([["shared", "claude-code"]]));
    const pending = { ...external("pending", 20), state: "creating" as const };
    const parent = external("parent", 6);
    const child: StoredThreadRecordV1 = {
      ...external("child", 8),
      nativeSessionRef: parent.nativeSessionRef,
      subagent: { parentHostThreadId: parent.hostThreadId, nativeSubagentId: "child" },
    };
    const result = await readThreadCatalog({
      ...input([external("shared", 1), external("local", 9), pending, parent, child]),
      sharedThreads: { list: sharedList, ownership },
      requestOfficialPage: async () =>
        page([row("shared", 12), row("pending", 11), row("unconfirmed", 10), row("native", 9)]),
    });
    expect(sharedList).toHaveBeenCalledTimes(1);
    expect(ownership).toHaveBeenCalledWith(["shared", "unconfirmed"]);
    expect(result.threads.map((thread) => thread.id)).toEqual([
      "local",
      "shared",
      "native",
      "parent",
    ]);
    expect(result.threads[1]).toMatchObject({ status: { type: "active" }, turns: [] });
    expect(result.ownership[1]).toEqual({
      threadId: "shared",
      owner: "external",
      harnessId: "claude-code",
    });
    expect(result.ownership[2]).toEqual({ threadId: "native", owner: "codex" });
  });

  it("batches shared ownership without the paginated ownership schema's catalog size limit", async () => {
    const sharedRows = Array.from({ length: 201 }, (_, n) => row(`shared-${n}`, n));
    const ownership = vi.fn(async (ids: string[]) => new Map(ids.map((id) => [id, "pi"])));
    const result = await readThreadCatalog({
      ...input(),
      sharedThreads: { list: async () => sharedRows, ownership },
    });
    expect(ownership.mock.calls.map(([ids]) => ids.length)).toEqual([100, 100, 1]);
    expect(threadCatalogReadResultSchema.parse(result).ownership).toHaveLength(201);
  });

  it("rejects a non-advancing native cursor without requesting another page", async () => {
    const request = vi.fn(async () => page([], "A"));
    await expect(
      readThreadCatalog({
        ...input(),
        officialCursor: { live: "A" },
        requestOfficialPage: request,
      }),
    ).rejects.toThrow("did not advance");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("returns empty advancing pages without prefetch and propagates explicit next-page failures", async () => {
    const error = new Error("private upstream details");
    const request = vi.fn(async (params: JsonObject) => {
      if (params.cursor === null) return page([], "next");
      throw error;
    });
    const result = await readThreadCatalog({
      ...input([external("external", 1)]),
      requestOfficialPage: request,
    });
    expect(result.officialCursor).toEqual({ live: "next" });
    expect(request).toHaveBeenCalledTimes(1);
    await expect(
      readThreadCatalog({
        ...input(),
        officialCursor: result.officialCursor,
        requestOfficialPage: request,
      }),
    ).rejects.toBe(error);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("continues only explicit native branches and keeps all external metadata even after native exhaustion", async () => {
    const records = Array.from({ length: 41 }, (_, i) => external(`external-${i}`, i));
    const request = vi.fn(async (params: JsonObject) => {
      expect(params).toMatchObject({
        archived: true,
        cursor: "archive20",
        limit: 20,
        sortKey: "updated_at",
        sortDirection: "desc",
      });
      return page([row("old-archive", 1)]);
    });
    const result = await readThreadCatalog({
      ...input(records),
      includeArchived: true,
      officialCursor: { live: null, archived: "archive20" },
      requestOfficialPage: request,
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(result.threads).toHaveLength(42);
    expect(result.archivedThreadIds).toEqual(["old-archive"]);
    expect(result.officialCursor).toEqual({ live: null, archived: null });
    const ended = await readThreadCatalog({
      ...input(records),
      includeArchived: true,
      officialCursor: result.officialCursor,
      requestOfficialPage: request,
    });
    expect(ended.threads).toHaveLength(41);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("does not let logging fail the catalog read", async () => {
    const result = await readThreadCatalog({
      ...input([external("external", 1)]),
      diagnose: () => {
        throw new Error("log unavailable");
      },
    });
    expect(result.ownership).toEqual([
      { threadId: "external", owner: "external", harnessId: "pi" },
    ]);
  });
});
