import type { JsonObject } from "@codexhost/protocol-core";
import { describe, expect, it, vi } from "vitest";

import {
  completePiTurn,
  createFixture,
  requestId,
  rollbackCapableAdapter,
  startPiThread,
  stopFixture,
  writeRequest,
} from "./app-server-host-fixture.js";

const PINNED = "01984de2-8f74-7c91-a3b2-5c5e937cf318";

/** Answers the official requests the Host sends or forwards, over one pinned section. */
function serveOfficialSections(fixture: ReturnType<typeof createFixture>, pinned: string[]) {
  const moves: JsonObject[] = [];
  let buffer = "";
  fixture.official.stdin.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const request = JSON.parse(line) as JsonObject;
      const params = (request.params ?? {}) as JsonObject;
      let result: JsonObject | undefined;
      if (request.method === "threadSection/list") {
        result = { data: [{ id: PINNED, name: "Pinned", appearance: null }], nextCursor: null };
      } else if (request.method === "thread/list" && params.sectionId === PINNED) {
        result = { data: pinned.map((id) => ({ id })), nextCursor: null, backwardsCursor: null };
      } else if (request.method === "thread/read") {
        const threadId = String(params.threadId);
        result = {
          thread: {
            id: threadId,
            section: pinned.includes(threadId)
              ? { id: PINNED, name: "Pinned", appearance: null }
              : null,
          },
        };
      } else if (request.method === "thread/section/move") {
        moves.push(params);
        const threadId = String(params.threadId);
        const index = pinned.indexOf(threadId);
        if (index >= 0) pinned.splice(index, 1);
        if (params.sectionId === PINNED) {
          const before = (params.beforeThreadId as string | null | undefined) ?? null;
          pinned.splice(before === null ? pinned.length : pinned.indexOf(before), 0, threadId);
        }
        result = {};
      }
      if (result === undefined) continue;
      fixture.official.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
    }
  });
  return { moves };
}

async function call(
  fixture: ReturnType<typeof createFixture>,
  id: number,
  method: string,
  params: JsonObject,
): Promise<JsonObject> {
  writeRequest(fixture.desktopInput, { id, method, params });
  return fixture.collector.waitFor((message) => requestId(message, id));
}

const pinnedList = {
  cursor: null,
  limit: 100,
  modelProviders: [],
  sectionId: PINNED,
  sortKey: "section_position",
  useStateDbOnly: true,
};

describe("External Thread sections through AppServerHost", () => {
  it("pins, orders, reads and unpins an External Thread beside official Threads", async () => {
    const fixture = createFixture();
    const threadId = await startPiThread(fixture);
    const official = serveOfficialSections(fixture, ["official-1"]);

    await expect(
      call(fixture, 101, "thread/section/move", {
        threadId,
        sectionId: PINNED,
        beforeThreadId: "official-1",
      }),
    ).resolves.toEqual({ id: 101, result: {} });
    expect(official.moves).toEqual([]);

    const read = await call(fixture, 102, "thread/read", { threadId });
    expect(read.result).toMatchObject({
      thread: {
        id: threadId,
        section: { id: PINNED, name: "Pinned", appearance: null },
        sectionEnteredAt: expect.any(Number),
      },
    });

    const listed = await call(fixture, 103, "thread/list", pinnedList);
    expect(((listed.result as JsonObject).data as JsonObject[]).map((row) => row.id)).toEqual([
      threadId,
      "official-1",
    ]);

    // Official Thread dragged before the External Thread: the official order only sees officials.
    await expect(
      call(fixture, 104, "thread/section/move", {
        threadId: "official-2",
        sectionId: PINNED,
        beforeThreadId: threadId,
      }),
    ).resolves.toEqual({ id: 104, result: {} });
    expect(official.moves).toEqual([
      { threadId: "official-2", sectionId: PINNED, beforeThreadId: "official-1" },
    ]);
    const reordered = await call(fixture, 105, "thread/list", pinnedList);
    expect(((reordered.result as JsonObject).data as JsonObject[]).map((row) => row.id)).toEqual([
      "official-2",
      threadId,
      "official-1",
    ]);

    await expect(
      call(fixture, 106, "thread/section/move", { threadId, sectionId: null }),
    ).resolves.toEqual({ id: 106, result: {} });
    const unpinned = await call(fixture, 107, "thread/read", { threadId });
    expect(unpinned.result).toMatchObject({
      thread: { id: threadId, section: null, sectionEnteredAt: null },
    });
    const remaining = await call(fixture, 108, "thread/list", pinnedList);
    expect(((remaining.result as JsonObject).data as JsonObject[]).map((row) => row.id)).toEqual([
      "official-2",
      "official-1",
    ]);
    await stopFixture(fixture);
  });

  it("reports the saved section on resume and unarchive responses", async () => {
    const fixture = createFixture();
    const threadId = await startPiThread(fixture);
    serveOfficialSections(fixture, []);
    await call(fixture, 121, "thread/section/move", { threadId, sectionId: PINNED });
    const pinned = { section: { id: PINNED, name: "Pinned", appearance: null } };

    const resumed = await call(fixture, 122, "thread/resume", { threadId });
    expect(resumed.result).toMatchObject({ thread: { id: threadId, ...pinned } });

    await expect(call(fixture, 123, "thread/archive", { threadId })).resolves.toEqual({
      id: 123,
      result: {},
    });
    const unarchived = await call(fixture, 124, "thread/unarchive", { threadId });
    expect(unarchived.result).toMatchObject({ thread: { id: threadId, ...pinned } });
    await stopFixture(fixture);
  });

  it.each(["resume", "unarchive", "rollback", "read"])(
    "keeps thread/%s available when section placement reads fail",
    async (action) => {
      const fixture = createFixture({
        externalAdapters: new Map([["pi", rollbackCapableAdapter()]]),
      });
      try {
        const threadId = await startPiThread(fixture);
        await completePiTurn(fixture, threadId, 2);
        serveOfficialSections(fixture, []);
        await call(fixture, 130, "thread/section/move", { threadId, sectionId: PINNED });
        if (action === "unarchive") await call(fixture, 131, "thread/archive", { threadId });
        const placements = vi
          .spyOn(fixture.mappingStore, "listSectionPlacements")
          .mockRejectedValue(new Error("section storage unavailable"));
        const response = await call(fixture, 132, `thread/${action}`, {
          threadId,
          ...(action === "rollback" ? { numTurns: 1 } : {}),
        });
        expect(response.result).toMatchObject({ thread: { id: threadId } });
        expect(response).not.toHaveProperty("error");
        expect(fixture.diagnosticOutput.read()?.toString()).toContain(
          "External Thread section placement could not be read",
        );
        placements.mockRestore();
        const recovered = await call(fixture, 133, "thread/read", { threadId, includeTurns: true });
        expect(recovered.result).toMatchObject({
          thread: { id: threadId, section: { id: PINNED } },
        });
        expect(((recovered.result as JsonObject).thread as JsonObject).turns).toHaveLength(
          action === "rollback" ? 0 : 1,
        );
      } finally {
        await stopFixture(fixture);
      }
    },
  );

  it("returns the official error for a missing section", async () => {
    const fixture = createFixture();
    const threadId = await startPiThread(fixture);
    serveOfficialSections(fixture, []);
    await expect(
      call(fixture, 111, "thread/section/move", {
        threadId,
        sectionId: "019b0000-0000-7000-8000-00000000dead",
      }),
    ).resolves.toEqual({
      id: 111,
      error: {
        code: -32600,
        message: "section 019b0000-0000-7000-8000-00000000dead does not exist",
      },
    });
    await stopFixture(fixture);
  });
});
