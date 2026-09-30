import { describe, expect, it } from "vitest";

import {
  decodeHostThreadListCursor,
  decodeOfficialThreadListPage,
  decodeThreadArchiveRequest,
  decodeThreadListRequest,
  decodeThreadMetadataUpdateRequest,
  decodeThreadSectionMoveRequest,
  encodeHostThreadListCursor,
  encodeSectionThreadListCursor,
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

  it("keeps official section cursors official and lets the Host merge a first section page", () => {
    for (const sectionId of ["section-1", undefined, null]) {
      for (const cursor of ["official-section-cursor", undefined, null]) {
        const params = {
          limit: 5,
          sortDirection: "asc",
          sortKey: "section_position",
          ...(cursor === undefined ? {} : { cursor }),
          ...(sectionId === undefined ? {} : { sectionId }),
        };
        const decoded = decodeThreadListRequest({ id: 3, method: "thread/list", params });
        expect(decoded).toMatchObject({
          cursor: null,
          sectionId,
          sectionOffset: null,
          sortDirection: "asc",
          sortKey: "section_position",
          supportsExternal: cursor !== "official-section-cursor",
        });
        expect(decoded?.params).toEqual(params);
      }
    }
    // Official section order is ascending unless a caller asks otherwise.
    expect(
      decodeThreadListRequest({
        id: 5,
        method: "thread/list",
        params: { sectionId: "section-1", sortKey: "section_position" },
      })?.sortDirection,
    ).toBe("asc");

    const first = decodeThreadListRequest({
      id: 6,
      method: "thread/list",
      params: { sectionId: "section-1", sortKey: "section_position", limit: 2 },
    });
    const cursor = encodeSectionThreadListCursor(first?.queryFingerprint ?? "", 2);
    expect(
      decodeThreadListRequest({
        id: 7,
        method: "thread/list",
        params: { sectionId: "section-1", sortKey: "section_position", limit: 2, cursor },
      }),
    ).toMatchObject({ sectionOffset: 2, supportsExternal: true });
    expect(() =>
      decodeThreadListRequest({
        id: 8,
        method: "thread/list",
        params: { sectionId: "section-2", sortKey: "section_position", cursor },
      }),
    ).toThrow("does not match");
    expect(() =>
      decodeThreadListRequest({ id: 9, method: "thread/list", params: { cursor } }),
    ).toThrow("section_position");

    expect(() =>
      decodeThreadListRequest({
        id: 4,
        method: "thread/list",
        params: {
          cursor: "codexhost:thread-list:v1:legacy-host-cursor",
          sortKey: "section_position",
        },
      }),
    ).toThrow("Host cursor");
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

  it("decodes thread section moves with explicit removal and optional anchors", () => {
    expect(
      decodeThreadSectionMoveRequest({
        id: 1,
        method: "thread/section/move",
        params: { threadId: "t1", sectionId: "s1" },
      }),
    ).toEqual({ threadId: "t1", sectionId: "s1", beforeThreadId: null });
    expect(
      decodeThreadSectionMoveRequest({
        id: 2,
        method: "thread/section/move",
        params: { threadId: "t1", sectionId: null, beforeThreadId: "t2" },
      }),
    ).toEqual({ threadId: "t1", sectionId: null, beforeThreadId: "t2" });
    expect(() =>
      decodeThreadSectionMoveRequest({
        id: 3,
        method: "thread/section/move",
        params: { threadId: "t1" },
      }),
    ).toThrow("sectionId");
    expect(decodeThreadSectionMoveRequest({ id: 4, method: "thread/list" })).toBeNull();
  });
});
