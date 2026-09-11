import type { StoredThreadRecordV1 } from "@codexhost/mapping-store";
import { decodeThreadListRequest, type JsonObject } from "@codexhost/protocol-core";
import {
  harnessIdSchema,
  hostThreadIdSchema,
  hostTurnIdSchema,
  nativeSessionRefSchema,
} from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import {
  externalAnchor,
  listExternalThreadMetadata,
  resolveExternalSessionTreeIds,
} from "../src/external-thread-list.js";

const harnessId = harnessIdSchema.parse("pi");

function record(id: string, input: Partial<StoredThreadRecordV1> = {}): StoredThreadRecordV1 {
  const hostThreadId = hostThreadIdSchema.parse(id);
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
    title: `Title ${id}`,
    archived: false,
    isPinned: false,
    transportModelId: "codexhost/pi-native",
    ephemeral: false,
    historyMode: "legacy",
    turnMappings: [],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T01:00:00.000Z",
    ...input,
  } as StoredThreadRecordV1;
}

function query(params: JsonObject = {}) {
  const decoded = decodeThreadListRequest({ id: 1, method: "thread/list", params });
  if (!decoded) throw new Error("Expected thread/list query");
  return decoded;
}

describe("External Thread metadata catalog", () => {
  it("projects only ready records without loading Native history", () => {
    const ready = record("ready");
    const provisional = record("provisional", { state: "creating" });
    const page = listExternalThreadMetadata({
      records: [ready, provisional],
      query: query(),
      runtimeFor: () => null,
    });
    expect(page.data).toHaveLength(1);
    expect(page.data[0]?.thread).toMatchObject({
      id: "ready",
      sessionId: "ready",
      status: { type: "notLoaded" },
      turns: [],
      preview: "",
      isPinned: false,
      canAcceptDirectInput: null,
    });
  });

  it("uses current runtime state without reading a Snapshot", () => {
    const page = listExternalThreadMetadata({
      records: [record("loaded")],
      query: query(),
      runtimeFor: () => ({ running: true }),
    });
    expect(page.data[0]?.thread).toMatchObject({
      status: { type: "active", activeFlags: [] },
      canAcceptDirectInput: true,
    });
  });

  it("applies current management filters using persisted metadata", () => {
    const active = record("active", { title: "Needle result" });
    const archived = record("archived", { archived: true, cwd: "/archive" });
    expect(
      listExternalThreadMetadata({
        records: [active, archived],
        query: query({ searchTerm: "needle", modelProviders: ["codexhost"] }),
        runtimeFor: () => null,
      }).data.map((entry) => entry.thread.id),
    ).toEqual(["active"]);
    expect(
      listExternalThreadMetadata({
        records: [active, archived],
        query: query({ archived: true, cwd: ["/archive"], sourceKinds: ["vscode"] }),
        runtimeFor: () => null,
      }).data.map((entry) => entry.thread.id),
    ).toEqual(["archived"]);
    for (const params of [
      { isPinned: true },
      { modelProviders: ["openai"] },
      { sourceKinds: ["cli"] },
      { parentThreadId: "parent" },
      { ancestorThreadId: "ancestor" },
    ]) {
      expect(
        listExternalThreadMetadata({
          records: [active],
          query: query(params),
          runtimeFor: () => null,
        }).data,
      ).toEqual([]);
    }
  });

  it("filters and projects persisted pin state", () => {
    const pinned = record("pinned", { isPinned: true });
    const unpinned = record("unpinned");
    expect(
      listExternalThreadMetadata({
        records: [pinned, unpinned],
        query: query({ isPinned: true }),
        runtimeFor: () => null,
      }).data.map((entry) => entry.thread.id),
    ).toEqual(["pinned"]);
    expect(
      listExternalThreadMetadata({
        records: [pinned, unpinned],
        query: query({ isPinned: false }),
        runtimeFor: () => null,
      }).data.map((entry) => entry.thread.isPinned),
    ).toEqual([false]);
  });

  it("resolves a Fork tree in one record map and rejects cycles", () => {
    const source = record("source");
    const derived = record("derived", {
      forkSource: {
        hostThreadId: source.hostThreadId,
        hostTurnId: hostTurnIdSchema.parse("source-turn"),
      },
    });
    expect(resolveExternalSessionTreeIds([derived, source]).get(derived.hostThreadId)).toBe(
      source.hostThreadId,
    );
    const first = record("first", {
      forkSource: {
        hostThreadId: hostThreadIdSchema.parse("second"),
        hostTurnId: hostTurnIdSchema.parse("one"),
      },
    });
    const second = record("second", {
      forkSource: {
        hostThreadId: hostThreadIdSchema.parse("first"),
        hostTurnId: hostTurnIdSchema.parse("two"),
      },
    });
    expect(() => resolveExternalSessionTreeIds([first, second])).toThrow("cycle");
  });

  it("sorts stably and resumes after an External anchor", () => {
    const records = [
      record("c", { updatedAt: "2026-08-01T03:00:00.000Z" }),
      record("a", { updatedAt: "2026-08-01T02:00:00.000Z" }),
      record("b", { updatedAt: "2026-08-01T02:00:00.000Z" }),
    ];
    const first = listExternalThreadMetadata({
      records,
      query: query({ sortKey: "updated_at", sortDirection: "desc", limit: 2 }),
      runtimeFor: () => null,
    });
    expect(first.data.map((entry) => entry.thread.id)).toEqual(["c", "a"]);
    expect(first.hasMore).toBe(true);
    const anchorEntry = first.data[1];
    if (!anchorEntry) throw new Error("Expected a first-page External anchor");
    const second = listExternalThreadMetadata({
      records,
      query: query({ sortKey: "updated_at", sortDirection: "desc", limit: 2 }),
      runtimeFor: () => null,
      anchor: externalAnchor(anchorEntry),
    });
    expect(second.data.map((entry) => entry.thread.id)).toEqual(["b"]);
    expect(second.hasMore).toBe(false);
  });

  it("filters and returns the first page from 1000 in-memory records", () => {
    const records = Array.from({ length: 1_000 }, (_, index) =>
      record(`scale-${index.toString().padStart(4, "0")}`, {
        title: index % 2 === 0 ? `Matching Scale ${index}` : `Other ${index}`,
      }),
    );
    const page = listExternalThreadMetadata({
      records,
      query: query({ searchTerm: "matching scale", limit: 100 }),
      runtimeFor: () => null,
    });
    expect(page.data).toHaveLength(100);
    expect(page.hasMore).toBe(true);
    expect(page.data.every((entry) => String(entry.thread.name).startsWith("Matching Scale"))).toBe(
      true,
    );
  });

  it("does not inject External rows for an unknown future filter", () => {
    const page = listExternalThreadMetadata({
      records: [record("external")],
      query: query({ futureFilter: "value" }),
      runtimeFor: () => null,
    });
    expect(page).toEqual({ data: [], hasMore: false });
  });
});
