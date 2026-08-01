import { describe, expect, it } from "vitest";

import {
  decodeHostThreadListCursor,
  decodeOfficialThreadListPage,
  decodeThreadArchiveRequest,
  decodeThreadListRequest,
  decodeThreadMetadataUpdateRequest,
  encodeHostThreadListCursor,
} from "../src/index.js";

describe("Codex Thread list and management protocol boundary", () => {
  it("decodes and normalizes the current thread/list fields", () => {
    const decoded = decodeThreadListRequest({
      id: 1,
      method: "thread/list",
      params: {
        archived: true,
        cwd: ["/one", "/two"],
        isPinned: false,
        limit: 250,
        modelProviders: ["codexhost"],
        searchTerm: "Title",
        sortDirection: "asc",
        sortKey: "recency_at",
        sourceKinds: ["vscode"],
        useStateDbOnly: true,
      },
    });
    expect(decoded).toMatchObject({
      archived: true,
      cwd: ["/one", "/two"],
      isPinned: false,
      limit: 100,
      sortDirection: "asc",
      sortKey: "recency_at",
      supportsExternal: true,
    });
    expect(decoded?.queryFingerprint).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("rejects malformed list fields and conflicting relationships", () => {
    expect(() =>
      decodeThreadListRequest({
        id: 1,
        method: "thread/list",
        params: { limit: -1 },
      }),
    ).toThrow("uint32");
    expect(() =>
      decodeThreadListRequest({
        id: 2,
        method: "thread/list",
        params: { sourceKinds: ["future-source"] },
      }),
    ).toThrow("unsupported value");
    expect(() =>
      decodeThreadListRequest({
        id: 3,
        method: "thread/list",
        params: { parentThreadId: "parent", ancestorThreadId: "ancestor" },
      }),
    ).toThrow("cannot combine");
  });

  it("omits External aggregation for future filters and legacy official cursors", () => {
    expect(
      decodeThreadListRequest({
        id: 1,
        method: "thread/list",
        params: { futureFilter: true },
      })?.supportsExternal,
    ).toBe(false);
    expect(
      decodeThreadListRequest({
        id: 2,
        method: "thread/list",
        params: { cursor: "official-opaque" },
      })?.supportsExternal,
    ).toBe(false);
  });

  it("round-trips a bounded Host cursor and binds query plus direction", () => {
    const decoded = decodeThreadListRequest({
      id: 1,
      method: "thread/list",
      params: { archived: false, sortDirection: "desc" },
    });
    if (!decoded) throw new Error("Expected thread/list decoding");
    const encoded = encodeHostThreadListCursor({
      queryFingerprint: decoded.queryFingerprint,
      sortDirection: decoded.sortDirection,
      officialCursor: "official-next",
      officialDone: false,
      externalAnchor: { timestamp: 100, threadId: "external-1" },
      externalDone: false,
    });
    expect(
      decodeHostThreadListCursor(encoded, {
        queryFingerprint: decoded.queryFingerprint,
        sortDirection: "desc",
      }),
    ).toMatchObject({
      officialCursor: "official-next",
      externalAnchor: { threadId: "external-1" },
    });
    expect(() =>
      decodeHostThreadListCursor(encoded, {
        queryFingerprint: decoded.queryFingerprint,
        sortDirection: "asc",
      }),
    ).toThrow("does not match");
    expect(() =>
      decodeHostThreadListCursor(encoded, {
        queryFingerprint: "0".repeat(64),
        sortDirection: "desc",
      }),
    ).toThrow("does not match");
  });

  it("decodes archive and metadata update targets without generic forwarding semantics", () => {
    expect(
      decodeThreadArchiveRequest({
        id: 1,
        method: "thread/archive",
        params: { threadId: "thread-1" },
      }),
    ).toEqual({ threadId: "thread-1" });
    expect(
      decodeThreadMetadataUpdateRequest({
        id: 2,
        method: "thread/metadata/update",
        params: {
          threadId: "thread-1",
          isPinned: true,
          gitInfo: { branch: "main", sha: null },
        },
      }),
    ).toEqual({
      threadId: "thread-1",
      isPinned: true,
      gitInfo: { branch: "main", sha: null },
    });
  });

  it("validates official thread/list pages without interpreting Thread content", () => {
    expect(
      decodeOfficialThreadListPage({
        data: [{ id: "official", createdAt: 1 }],
        nextCursor: "next",
        backwardsCursor: null,
      }),
    ).toEqual({
      data: [{ id: "official", createdAt: 1 }],
      nextCursor: "next",
      backwardsCursor: null,
    });
    expect(() => decodeOfficialThreadListPage({ data: [null] })).toThrow("invalid");
  });
});
