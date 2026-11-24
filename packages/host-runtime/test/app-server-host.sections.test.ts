import type { JsonObject } from "@codexhost/protocol-core";
import { describe, expect, it, vi } from "vitest";
import { SharedThreadBridge } from "../src/shared-thread-bridge.js";
import { SharedThreadOwner } from "../src/shared-thread-owner.js";

import {
  closeFixture,
  createFixture,
  requestId,
  startExternalThread,
  startPiThread,
  stopFixture,
  writeRequest,
} from "./app-server-host-fixture.js";

const PINNED = "01984de2-8f74-7c91-a3b2-5c5e937cf318";

/** Synthetic native section definitions and member order. */
function serveOfficialSections(
  fixture: ReturnType<typeof createFixture>,
  pinned: string[],
  custom: Readonly<Record<string, readonly string[]>> = {},
  options: {
    reject?: (method: string) => boolean;
    loseCreateReply?: (section: JsonObject) => void;
    deleteReply?: () => JsonObject;
    incompleteList?: () => boolean;
  } = {},
) {
  const moves: JsonObject[] = [];
  const sectionReads: JsonObject[] = [];
  const mutations: Array<{ method: string; params: JsonObject }> = [];
  const sections = new Map(Object.entries(custom).map(([id, members]) => [id, [...members]]));
  const definitions = new Map<string, JsonObject>(
    Object.keys(custom).map((id) => [id, { id, name: id, appearance: null }]),
  );
  const deleteSection = (id: string) => {
    definitions.delete(id);
    sections.delete(id);
  };
  let sectionNumber = 0;
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
      const method = String(request.method);
      const reply = (value: JsonObject) =>
        fixture.official.stdout.write(`${JSON.stringify({ id: request.id, ...value })}\n`);
      if (method === "initialize") {
        result = {};
      } else if (method === "threadSection/list") {
        result = {
          data: [
            { id: PINNED, name: "Pinned", appearance: null },
            ...(options.incompleteList?.() ? [] : definitions.values()),
          ],
          nextCursor: options.incompleteList?.() ? "loop" : null,
        };
      } else if (
        method === "threadSection/create" ||
        method === "threadSection/update" ||
        method === "threadSection/delete"
      ) {
        mutations.push({ method, params });
        if (options.reject?.(method)) {
          reply({ error: { code: -32005, message: "Native section write rejected" } });
          continue;
        }
        const id =
          method === "threadSection/create" ? `new-${++sectionNumber}` : String(params.sectionId);
        if (method === "threadSection/delete") {
          deleteSection(id);
          if (options.deleteReply) {
            reply(options.deleteReply());
            continue;
          }
          result = {};
        } else {
          const definition = {
            id,
            name: String(params.name),
            appearance:
              "appearance" in params
                ? (params.appearance ?? null)
                : (definitions.get(id)?.appearance ?? null),
          };
          definitions.set(id, definition);
          if (method === "threadSection/create") {
            sections.set(id, []);
            if (options.loseCreateReply) {
              options.loseCreateReply(definition);
              continue;
            }
          }
          result = { section: definition };
        }
      } else if (request.method === "project/read") {
        result = { project: { id: String(params.projectId) } };
      } else if (request.method === "thread/list" && params.sectionId === PINNED) {
        result = { data: pinned.map((id) => ({ id })), nextCursor: null, backwardsCursor: null };
      } else if (method === "thread/list") {
        if (typeof params.sectionId === "string") sectionReads.push(params);
        result = {
          data: (sections.get(String(params.sectionId)) ?? []).map((id) => ({ id })),
          nextCursor: null,
          backwardsCursor: null,
        };
      } else if (method === "thread/read") {
        const threadId = String(params.threadId);
        const section = [...sections].find(([, members]) => members.includes(threadId))?.[0];
        result = {
          thread: {
            id: threadId,
            section: pinned.includes(threadId)
              ? { id: PINNED, name: "Pinned", appearance: null }
              : section
                ? (definitions.get(section) ?? null)
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
        for (const [id, members] of sections)
          sections.set(
            id,
            members.filter((member) => member !== threadId),
          );
        const destination = sections.get(String(params.sectionId));
        if (destination) {
          const before = params.beforeThreadId;
          const index =
            typeof before === "string" ? destination.indexOf(before) : destination.length;
          destination.splice(index, 0, threadId);
        }
        result = {};
      }
      if (result === undefined) continue;
      reply({ result });
    }
  });
  return { moves, mutations, sectionReads, deleteSection };
}

async function call(
  fixture: ReturnType<typeof createFixture>,
  id: number,
  method: string,
  params?: JsonObject,
): Promise<JsonObject> {
  writeRequest(fixture.desktopInput, { id, method, ...(params ? { params } : {}) });
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

function sectionRpc(
  fixture: { host: { handleClientRequest(method: string, input: unknown): Promise<unknown> } },
  operation: "list" | "create" | "update" | "delete" | "move",
  params: JsonObject,
) {
  return fixture.host.handleClientRequest(`codexhost/thread/sections/${operation}`, params);
}

describe("External Thread sections through AppServerHost", () => {
  it("creates distinct empty sections with the same trimmed name and gates appearance", async () => {
    const fixture = createFixture();
    const appearance = { icon: "future-icon", color: "future-color" };
    const native = serveOfficialSections(fixture, []);
    try {
      await fixture.ready;
      await expect(call(fixture, 229, "codexhost/thread/sections/list")).resolves.toEqual({
        id: 229,
        result: { sections: [] },
      });
      await expect(sectionRpc(fixture, "list", { threadSectionsV1: true })).resolves.toEqual({
        result: { threadSectionsV1: true, sections: [] },
      });
      await expect(sectionRpc(fixture, "create", { name: " \t " })).resolves.toMatchObject({
        error: { code: -32602 },
      });
      await expect(
        sectionRpc(fixture, "update", { sectionId: PINNED, name: "Other" }),
      ).resolves.toMatchObject({ error: { code: -32602 } });
      await expect(sectionRpc(fixture, "delete", { sectionId: PINNED })).resolves.toMatchObject({
        error: { code: -32602 },
      });
      await expect(sectionRpc(fixture, "create", { name: " Research " })).resolves.toEqual({
        result: {
          status: "confirmed",
          sectionId: "new-1",
          syncPending: false,
          section: { id: "new-1", name: "Research", appearance: null },
        },
      });
      expect(
        await call(fixture, 201, "threadSection/create", { name: "Research", appearance }),
      ).toEqual({ id: 201, result: { section: { id: "new-2", name: "Research", appearance } } });
      expect(await call(fixture, 230, "codexhost/thread/sections/list")).toEqual({
        id: 230,
        result: {
          sections: [
            { id: "new-1", name: "Research", threads: [] },
            { id: "new-2", name: "Research", threads: [] },
          ],
        },
      });
      await expect(
        sectionRpc(fixture, "update", { sectionId: "new-2", name: " Renamed " }),
      ).resolves.toEqual({
        result: {
          status: "confirmed",
          sectionId: "new-2",
          syncPending: false,
          section: { id: "new-2", name: "Renamed", appearance },
        },
      });
      await expect(sectionRpc(fixture, "list", { threadSectionsV1: true })).resolves.toEqual({
        result: {
          threadSectionsV1: true,
          sections: [
            { id: "new-1", name: "Research", appearance: null, threads: [] },
            { id: "new-2", name: "Renamed", appearance, threads: [] },
          ],
        },
      });
      await expect(
        sectionRpc(fixture, "update", { sectionId: "new-2", name: "Renamed", appearance: null }),
      ).resolves.toMatchObject({
        result: { status: "confirmed", section: { id: "new-2", appearance: null } },
      });
      expect(native.mutations).toEqual([
        { method: "threadSection/create", params: { name: "Research" } },
        { method: "threadSection/create", params: { name: "Research", appearance } },
        { method: "threadSection/update", params: { sectionId: "new-2", name: "Renamed" } },
        {
          method: "threadSection/update",
          params: { sectionId: "new-2", name: "Renamed", appearance: null },
        },
      ]);
    } finally {
      await stopFixture(fixture);
    }
  });

  it("does not infer or replay a lost create reply even after refreshing duplicate names", async () => {
    const fixture = createFixture();
    const submitted = Promise.withResolvers<JsonObject>();
    const native = serveOfficialSections(
      fixture,
      [],
      { Research: [] },
      {
        loseCreateReply: submitted.resolve,
      },
    );
    try {
      await fixture.ready;
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const result = sectionRpc(fixture, "create", { name: "Research" });
      expect((await submitted.promise).id).toBe("new-1");
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(result).resolves.toEqual({ result: { status: "unknown" } });
      await expect(sectionRpc(fixture, "list", {})).resolves.toEqual({
        result: {
          sections: [
            { id: "Research", name: "Research", threads: [] },
            { id: "new-1", name: "Research", threads: [] },
          ],
        },
      });
      expect(native.mutations).toEqual([
        { method: "threadSection/create", params: { name: "Research" } },
      ]);
    } finally {
      vi.useRealTimers();
      await stopFixture(fixture);
    }
  });

  it("keeps Threads and project/archives intact when deletion is pending, then recovers on startup", async () => {
    let fixture = createFixture();
    let incomplete = false;
    let reject = true;
    serveOfficialSections(
      fixture,
      [],
      { Research: ["native"], Review: ["anchor"] },
      {
        reject: () => reject,
        incompleteList: () => incomplete,
      },
    );
    try {
      const active = await startPiThread(fixture);
      const archived = await startExternalThread(fixture, "codexhost/pi-native", 2);
      const moved = await startExternalThread(fixture, "codexhost/pi-native", 3);
      await call(fixture, 211, "thread/metadata/update", {
        threadId: active,
        projectId: "project-a",
      });
      for (const [index, threadId] of [active, archived, moved].entries()) {
        expect(
          await call(fixture, 212 + index, "thread/section/move", {
            threadId,
            sectionId: "Research",
          }),
        ).toHaveProperty("result");
      }
      await call(fixture, 215, "thread/archive", { threadId: archived });
      const original = await fixture.mappingStore.listSectionPlacements();
      await expect(sectionRpc(fixture, "delete", { sectionId: "Research" })).resolves.toEqual({
        error: { code: -32005, message: "Native section write rejected" },
      });
      expect(await fixture.mappingStore.listSectionPlacements()).toEqual(original);
      expect(
        await call(fixture, 216, "thread/section/move", {
          threadId: moved,
          sectionId: "Review",
        }),
      ).toHaveProperty("result");
      const review = (await fixture.mappingStore.listSectionPlacements()).find(
        ({ hostThreadId }) => hostThreadId === moved,
      );
      expect(review).toMatchObject({ section: { id: "Review" } });

      reject = false;
      incomplete = true;
      const complete = await fixture.mappingStore.listSectionPlacements();
      await expect(sectionRpc(fixture, "delete", { sectionId: "Research" })).resolves.toEqual({
        result: { status: "confirmed", sectionId: "Research", section: null, syncPending: true },
      });
      // The repeated cursor is not a complete list. Even with no fresh list,
      // the confirmed deletion is authoritative for its own section.
      expect(await fixture.mappingStore.listSectionPlacements()).toEqual(complete);
      const unsectioned = {
        id: active,
        projectId: "project-a",
        section: null,
        sectionEnteredAt: null,
      };
      expect(await call(fixture, 217, "thread/read", { threadId: active })).toMatchObject({
        result: { thread: unsectioned },
      });
      expect((await fixture.host.clientSnapshot(active)).thread).toMatchObject(unsectioned);
      expect(
        await call(fixture, 218, "thread/list", { ...pinnedList, sectionId: "Research" }),
      ).toMatchObject({ result: { data: [] } });

      incomplete = false;
      const save = vi
        .spyOn(fixture.mappingStore, "replaceSectionPlacements")
        .mockRejectedValue(new Error("Synthetic placement disk failure"));
      // Trigger the owner with a complete list, then leave its writes failing until restart.
      expect(
        await call(fixture, 219, "threadSection/update", { sectionId: "Review", name: "Review" }),
      ).toMatchObject({ result: { section: { id: "Review" } } });
      expect(await fixture.mappingStore.listSectionPlacements()).toEqual(complete);
      await expect(sectionRpc(fixture, "list", {})).resolves.toMatchObject({
        result: { sections: [{ id: "Review", threads: [{ id: "anchor" }, { id: moved }] }] },
      });
      const mappingStoreDirectory = fixture.mappingStoreDirectory;
      await closeFixture(fixture);
      save.mockRestore();
      fixture = createFixture({ mappingStoreDirectory });
      serveOfficialSections(fixture, [], { Review: ["anchor"] });
      await fixture.ready;
      await vi.waitFor(async () => {
        expect(await fixture.mappingStore.listSectionPlacements()).toEqual([review]);
      });
      expect(await call(fixture, 220, "thread/read", { threadId: active })).toMatchObject({
        result: { thread: unsectioned },
      });
      expect(await call(fixture, 221, "thread/unarchive", { threadId: archived })).toMatchObject({
        result: { thread: { id: archived, section: null } },
      });
    } finally {
      await stopFixture(fixture);
    }
  });

  it("retries placement persistence after repeated failures without replaying the delete", async () => {
    const fixture = createFixture();
    const native = serveOfficialSections(fixture, [], { Research: [] });
    try {
      const threadId = await startPiThread(fixture);
      await expect(
        sectionRpc(fixture, "move", { threadId, sectionId: "Research" }),
      ).resolves.toEqual({ result: {} });
      vi.spyOn(fixture.mappingStore, "replaceSectionPlacements")
        .mockRejectedValueOnce(new Error("Storage unavailable"))
        .mockRejectedValueOnce(new Error("Storage still unavailable"));
      await expect(sectionRpc(fixture, "delete", { sectionId: "Research" })).resolves.toMatchObject(
        {
          result: { status: "confirmed", syncPending: true },
        },
      );
      await vi.waitFor(async () => {
        expect(await fixture.mappingStore.listSectionPlacements()).toEqual([]);
      });
      expect(native.mutations).toEqual([
        { method: "threadSection/delete", params: { sectionId: "Research" } },
      ]);
    } finally {
      await stopFixture(fixture);
    }
  });

  it("reconciles an unknown delete only after a complete read and retries placement cleanup", async () => {
    const fixture = createFixture();
    let incompleteList = false;
    const native = serveOfficialSections(
      fixture,
      [],
      { Research: [] },
      {
        deleteReply: () => {
          incompleteList = true;
          return { error: { message: "Malformed reply" } };
        },
        incompleteList: () => incompleteList,
      },
    );
    try {
      const threadId = await startPiThread(fixture);
      await expect(
        sectionRpc(fixture, "move", { threadId, sectionId: "Research" }),
      ).resolves.toEqual({ result: {} });
      const original = await fixture.mappingStore.listSectionPlacements();
      vi.spyOn(fixture.mappingStore, "replaceSectionPlacements").mockRejectedValueOnce(
        new Error("Storage unavailable"),
      );
      await expect(sectionRpc(fixture, "delete", { sectionId: "Research" })).resolves.toEqual({
        result: { status: "unknown" },
      });
      expect(await fixture.mappingStore.listSectionPlacements()).toEqual(original);
      incompleteList = false;
      await vi.waitFor(async () => {
        expect(await fixture.mappingStore.listSectionPlacements()).toEqual([]);
      });
      expect(native.mutations).toEqual([
        { method: "threadSection/delete", params: { sectionId: "Research" } },
      ]);
    } finally {
      await stopFixture(fixture);
    }
  });

  it("notifies clients when a shared reconciliation retry changes stale placements", async () => {
    const fixture = createFixture({ externalOnly: true });
    let incompleteList = false;
    const native = serveOfficialSections(
      fixture,
      [],
      { Research: [] },
      { incompleteList: () => incompleteList },
    );
    const changes: number[] = [];
    const stop = fixture.host.clientEvents.subscribe((event) => {
      if (event.type === "sections-changed") changes.push(event.cursor.sequence);
    });
    try {
      await vi.waitFor(() => fixture.mappingStore.listSectionPlacements());
      await expect(sectionRpc(fixture, "list", {})).resolves.toHaveProperty("result");
      const threadId = await startPiThread(fixture);
      await expect(
        sectionRpc(fixture, "move", { threadId, sectionId: "Research" }),
      ).resolves.toEqual({ result: {} });

      changes.length = 0;
      native.deleteSection("Research");
      incompleteList = true;
      await expect(
        call(fixture, 231, "codexhost/shared-threads/sections/reconcile", {}),
      ).resolves.toEqual({ id: 231, result: { syncPending: true } });
      expect(changes).toHaveLength(1);
      expect((await fixture.host.clientSnapshot(threadId)).thread).toMatchObject({
        section: { id: "Research" },
      });

      incompleteList = false;
      await vi.waitFor(() => expect(changes).toHaveLength(2));
      expect(await fixture.mappingStore.listSectionPlacements()).toEqual([]);
      expect((await fixture.host.clientSnapshot(threadId)).thread).toMatchObject({ section: null });
      expect(native.mutations).toEqual([]);
    } finally {
      stop();
      await stopFixture(fixture);
    }
  });

  it("keeps a move made after deletion when the owner reconciles again", async () => {
    const fixture = createFixture();
    serveOfficialSections(fixture, [], { Research: [], Review: ["anchor"] });
    try {
      const threadId = await startPiThread(fixture);
      expect(
        await call(fixture, 222, "thread/section/move", { threadId, sectionId: "Research" }),
      ).toHaveProperty("result");
      const save = vi
        .spyOn(fixture.mappingStore, "replaceSectionPlacements")
        .mockRejectedValue(new Error("Synthetic placement disk failure"));
      await expect(sectionRpc(fixture, "delete", { sectionId: "Research" })).resolves.toMatchObject(
        {
          result: { status: "confirmed", syncPending: true },
        },
      );
      expect(await fixture.mappingStore.listSectionPlacements()).toMatchObject([
        { hostThreadId: threadId, section: { id: "Research" } },
      ]);
      save.mockRestore();
      expect(
        await call(fixture, 223, "thread/section/move", {
          threadId,
          sectionId: "Review",
        }),
      ).toHaveProperty("result");
      const [placement] = await fixture.mappingStore.listSectionPlacements();
      expect(placement).toMatchObject({
        hostThreadId: threadId,
        section: { id: "Review" },
      });
      expect(
        await call(fixture, 224, "threadSection/update", { sectionId: "Review", name: "Renamed" }),
      ).toHaveProperty("result");
      expect(await fixture.mappingStore.listSectionPlacements()).toMatchObject([
        { ...placement, section: { id: "Review", name: "Renamed" } },
      ]);
    } finally {
      await stopFixture(fixture);
    }
  });

  it.each(["unreachable", "RPC error"])(
    "reports pending on shared reconciliation failure (%s) despite local success",
    async (failure) => {
      const fixture = createFixture({
        sharedThreads: new SharedThreadBridge({
          connect: async () =>
            failure === "unreachable"
              ? null
              : {
                  request: async (method) =>
                    method === "codexhost/shared-threads/sections/reconcile"
                      ? { error: { code: -32601, message: "Method not found" } }
                      : { result: { threads: [] } },
                  respond: async () => undefined,
                  subscribe: () => () => undefined,
                  closed: Promise.withResolvers<undefined>().promise,
                  close: () => undefined,
                },
          delegateCreates: false,
          diagnose: () => undefined,
        }),
      });
      serveOfficialSections(fixture, [], { Research: [] });
      try {
        const threadId = await startPiThread(fixture);
        expect(
          await call(fixture, 225, "thread/section/move", { threadId, sectionId: "Research" }),
        ).toHaveProperty("result");
        await expect(
          sectionRpc(fixture, "update", { sectionId: "Research", name: "Renamed" }),
        ).resolves.toMatchObject({ result: { status: "confirmed", syncPending: true } });
        expect(await fixture.mappingStore.listSectionPlacements()).toMatchObject([
          { hostThreadId: threadId, section: { id: "Research", name: "Renamed" } },
        ]);
      } finally {
        await stopFixture(fixture);
      }
    },
  );

  it("refreshes shared rows after a different connection changes section membership or definitions", async () => {
    const fixture = createFixture({ externalOnly: true });
    const owner = new SharedThreadOwner();
    fixture.desktopOutput.pipe(owner.output, { end: false });
    owner.input.pipe(fixture.desktopInput, { end: false });
    const stock = owner.connect();
    const viewer = owner.connect();
    const bridge = new SharedThreadBridge({
      connect: async () => viewer,
      delegateCreates: true,
      diagnose: (error) => {
        throw error;
      },
    });
    serveOfficialSections(fixture, [], { Research: [], Review: [] });
    try {
      await vi.waitFor(() => fixture.mappingStore.listSectionPlacements());
      const boot = await sectionRpc(fixture, "list", {});
      expect(boot, fixture.diagnosticOutput.read()?.toString()).toHaveProperty("result");
      const threadId = await startPiThread(fixture);
      expect(
        await stock.request("thread/section/move", { threadId, sectionId: "Research" }),
      ).toHaveProperty("result");
      const list = () => bridge.list({ archived: false });
      expect(await list()).toMatchObject([{ id: threadId, section: { name: "Research" } }]);
      expect(await stock.request("threadSection/create", { name: "Empty" })).toHaveProperty(
        "result",
      );
      expect(
        await stock.request("threadSection/update", { sectionId: "new-1", name: "Still empty" }),
      ).toHaveProperty("result");
      expect(await stock.request("threadSection/delete", { sectionId: "new-1" })).toHaveProperty(
        "result",
      );
      expect(await list()).toMatchObject([{ id: threadId, section: { name: "Research" } }]);

      const move = (sectionId: string) =>
        stock.request("codexhost/thread/sections/move", { threadId, sectionId });
      expect(await move("Research")).toHaveProperty("result");
      expect(await list()).toMatchObject([{ id: threadId, section: { id: "Research" } }]);
      expect(await move("Review")).toHaveProperty("result");
      expect(await list()).toMatchObject([{ id: threadId, section: { id: "Review" } }]);
      expect(await move("Research")).toHaveProperty("result");
      expect(await list()).toMatchObject([{ id: threadId, section: { id: "Research" } }]);

      const appearance = { icon: "star", color: "red" };
      expect(
        await stock.request("threadSection/update", {
          sectionId: "Research",
          name: "New",
          appearance,
        }),
      ).toHaveProperty("result");
      expect(await list()).toMatchObject([{ id: threadId, section: { name: "New", appearance } }]);
      expect(await fixture.mappingStore.listSectionPlacements()).toMatchObject([
        { hostThreadId: threadId, section: { name: "New", appearance } },
      ]);
      vi.spyOn(fixture.mappingStore, "listSectionPlacements").mockRejectedValueOnce(
        new Error("Cannot read placements during delete"),
      );
      expect(await stock.request("threadSection/delete", { sectionId: "Research" })).toHaveProperty(
        "result",
      );
      expect(await list()).toMatchObject([{ id: threadId, section: null }]);
      await vi.waitFor(async () => {
        expect(await fixture.mappingStore.listSectionPlacements()).toEqual([]);
      });
    } finally {
      bridge.close();
      owner.close();
      await stopFixture(fixture);
    }
  });

  it("lists mixed custom sections in placement order without archived or pinned members", async () => {
    const fixture = createFixture();
    serveOfficialSections(fixture, ["pinned-1"], {
      Research: ["official-2", "official-1"],
      Empty: [],
    });
    try {
      const external = await startPiThread(fixture);
      const archived = await startExternalThread(fixture, "codexhost/pi-native", 2);
      await expect(
        call(fixture, 91, "thread/section/move", {
          threadId: external,
          sectionId: "Research",
          beforeThreadId: "official-1",
        }),
      ).resolves.toEqual({ id: 91, result: {} });
      await expect(
        call(fixture, 92, "thread/section/move", { threadId: archived, sectionId: "Research" }),
      ).resolves.toEqual({ id: 92, result: {} });
      await expect(call(fixture, 93, "thread/archive", { threadId: archived })).resolves.toEqual({
        id: 93,
        result: {},
      });
      await expect(
        fixture.host.handleClientRequest("codexhost/thread/sections/list", {}),
      ).resolves.toEqual({
        result: {
          sections: [
            {
              id: "Research",
              name: "Research",
              threads: [
                { id: "official-2" },
                expect.objectContaining({ id: external, modelProvider: "codexhost" }),
                { id: "official-1" },
              ],
            },
            { id: "Empty", name: "Empty", threads: [] },
          ],
        },
      });
    } finally {
      await stopFixture(fixture);
    }
  });

  it("moves active unpinned Threads through the Web custom-section command", async () => {
    const fixture = createFixture();
    try {
      const external = await startPiThread(fixture);
      const secondExternal = await startExternalThread(fixture, "codexhost/pi-native", 2);
      const official = serveOfficialSections(fixture, ["pinned-thread"], {
        Research: [],
        Review: [],
      });
      const move = (threadId: string, sectionId: string | null) =>
        fixture.host.handleClientRequest("codexhost/thread/sections/move", { threadId, sectionId });
      await expect(move("official-thread", "Research")).resolves.toEqual({ result: {} });
      await expect(move("official-thread", null)).resolves.toEqual({ result: {} });
      await expect(move(external, "Research")).resolves.toEqual({ result: {} });
      await expect(move(secondExternal, "Research")).resolves.toEqual({ result: {} });
      await expect(move(external, "Research")).resolves.toEqual({ result: {} });
      const desktop = await call(fixture, 94, "thread/list", {
        ...pinnedList,
        sectionId: "Research",
      });
      expect(desktop.result).toMatchObject({
        data: expect.arrayContaining([
          expect.objectContaining({ id: external }),
          expect.objectContaining({ id: secondExternal }),
        ]),
      });

      await expect(move(external, "Missing")).resolves.toMatchObject({ error: { code: -32602 } });
      await expect(move(external, "Review")).resolves.toEqual({ result: {} });
      const moved = await fixture.mappingStore.listSectionPlacements();
      expect(moved.find((row) => row.hostThreadId === external)?.section.id).toBe("Review");
      await expect(move(external, null)).resolves.toEqual({ result: {} });
      expect(
        (await fixture.mappingStore.listSectionPlacements()).map((row) => row.hostThreadId),
      ).toEqual([secondExternal]);

      await expect(
        call(fixture, 95, "thread/section/move", { threadId: external, sectionId: PINNED }),
      ).resolves.toEqual({ id: 95, result: {} });
      await expect(move(external, "Research")).resolves.toMatchObject({ error: { code: -32078 } });
      await expect(
        call(fixture, 96, "thread/archive", { threadId: secondExternal }),
      ).resolves.toEqual({ id: 96, result: {} });
      await expect(move(secondExternal, null)).resolves.toMatchObject({ error: { code: -32078 } });
      await expect(move("pinned-thread", "Research")).resolves.toMatchObject({
        error: { code: -32078 },
      });
      await expect(move("official-thread", PINNED)).resolves.toMatchObject({
        error: { code: -32602 },
      });
      expect(official.moves).toEqual([
        { threadId: "official-thread", sectionId: "Research", beforeThreadId: null },
        { threadId: "official-thread", sectionId: null, beforeThreadId: null },
      ]);
    } finally {
      await stopFixture(fixture);
    }
  });

  it("applies precise moves to the full mixed order and skips only true no-ops", async () => {
    const fixture = createFixture();
    const native = serveOfficialSections(fixture, [], {
      Research: ["official-1", "official-2"],
      Review: ["other"],
    });
    const move = (threadId: string, sectionId: string | null, beforeThreadId?: string | null) =>
      sectionRpc(fixture, "move", {
        threadId,
        sectionId,
        ...(beforeThreadId === undefined ? {} : { beforeThreadId }),
      });
    const order = async (sectionId = "Research") => {
      const listed = (await sectionRpc(fixture, "list", {})) as {
        result: { sections: { id: string; threads: { id: string }[] }[] };
      };
      return listed.result.sections.find(({ id }) => id === sectionId)?.threads.map(({ id }) => id);
    };
    try {
      const external = await startPiThread(fixture);
      const ok = { result: {} };
      await expect(move(external, "Research")).resolves.toEqual(ok);
      expect(await order()).toEqual(["official-1", "official-2", external]);
      await expect(move("official-1", "Research", "official-2")).resolves.toEqual(ok);
      expect(native.moves).toEqual([]);
      await expect(move("official-2", "Research", null)).resolves.toEqual(ok);
      expect(native.sectionReads).toContainEqual(
        expect.objectContaining({ sectionId: "Research", sortDirection: "asc" }),
      );
      expect(await order()).toEqual(["official-1", external, "official-2"]);
      // A legacy same-section move does not depend on a complete placement view.
      const unreadablePlacements = vi
        .spyOn(fixture.mappingStore, "listSectionPlacements")
        .mockRejectedValue(new Error("placements unavailable"));
      try {
        await expect(move("official-1", "Research")).resolves.toEqual(ok);
      } finally {
        unreadablePlacements.mockRestore();
      }
      await expect(move("official-1", "Research", external)).resolves.toEqual(ok);
      expect(native.moves).toEqual([]);

      const before = await fixture.mappingStore.listSectionPlacements();
      const unavailableDisk = vi
        .spyOn(fixture.mappingStore, "replaceSectionPlacements")
        .mockRejectedValue(new Error("unexpected placement write"));
      try {
        await expect(move(external, "Research", "official-2")).resolves.toEqual(ok);
        await expect(move("official-2", "Research", null)).resolves.toEqual(ok);
        for (const [section, anchor] of [
          ["Research", external],
          ["Research", "other"],
          ["Research", "missing"],
          [null, "official-1"],
        ] as const) {
          await expect(move(external, section, anchor)).resolves.toHaveProperty("error");
        }
        await expect(move("official-1", "Research", "other")).resolves.toHaveProperty("error");
      } finally {
        unavailableDisk.mockRestore();
      }
      expect(await fixture.mappingStore.listSectionPlacements()).toEqual(before);
      expect(native.moves).toEqual([]);
      expect(await order()).toEqual(["official-1", external, "official-2"]);

      const failedSave = vi
        .spyOn(fixture.mappingStore, "replaceSectionPlacements")
        .mockRejectedValue(new Error("Cannot write exact order"));
      try {
        await expect(move("official-2", "Research", external)).resolves.toMatchObject({
          error: { message: "Thread section could not be moved" },
        });
        expect(native.moves).toEqual([]);
        expect(await order()).toEqual(["official-1", external, "official-2"]);
      } finally {
        failedSave.mockRestore();
      }

      await expect(move("official-2", "Research", external)).resolves.toEqual(ok);
      expect(await order()).toEqual(["official-1", "official-2", external]);
      expect(await call(fixture, 97, "thread/archive", { threadId: external })).toHaveProperty(
        "result",
      );
      expect(await order()).toEqual(["official-1", "official-2"]);
      // The visible last row is not last in the persisted order.
      await expect(move("official-2", "Research", null)).resolves.toEqual(ok);
      expect(await fixture.mappingStore.listSectionPlacements()).toMatchObject([
        { hostThreadId: external, beforeThreadId: "official-2" },
      ]);
      expect(await call(fixture, 98, "thread/unarchive", { threadId: external })).toHaveProperty(
        "result",
      );
      await expect(move(external, "Review", "other")).resolves.toEqual(ok);
      expect(await order()).toEqual(["official-1", "official-2"]);
      expect(await order("Review")).toEqual([external, "other"]);
      await expect(move("official-2", "Review", external)).resolves.toEqual(ok);
      expect(await order()).toEqual(["official-1"]);
      expect(await order("Review")).toEqual(["official-2", external, "other"]);
      expect(native.moves).toEqual([
        { threadId: "official-2", sectionId: "Review", beforeThreadId: "other" },
      ]);
    } finally {
      await stopFixture(fixture);
    }
  });

  it("reports a native move with unsaved external anchors as partial without replaying it", async () => {
    const fixture = createFixture();
    const native = serveOfficialSections(fixture, [], { Research: ["N1", "N2"] });
    try {
      const threadId = await startPiThread(fixture);
      await expect(
        sectionRpc(fixture, "move", { threadId, sectionId: "Research", beforeThreadId: "N2" }),
      ).resolves.toEqual({ result: {} });
      vi.spyOn(fixture.mappingStore, "replaceSectionPlacements").mockRejectedValue(
        new Error("Cannot save the external anchors"),
      );
      await expect(
        sectionRpc(fixture, "move", {
          threadId: "N2",
          sectionId: "Research",
          beforeThreadId: "N1",
        }),
      ).resolves.toMatchObject({
        error: { message: expect.stringContaining("Native Thread moved") },
      });
      expect(native.moves).toEqual([
        { threadId: "N2", sectionId: "Research", beforeThreadId: "N1" },
      ]);
      await expect(sectionRpc(fixture, "list", {})).resolves.toMatchObject({
        result: { sections: [{ threads: [{ id: threadId }, { id: "N2" }, { id: "N1" }] }] },
      });
    } finally {
      await stopFixture(fixture);
    }
  });

  it("rejects split-owner anchors and source or destination members before either owner writes", async () => {
    const ownerFixture = createFixture({ externalOnly: true });
    const owner = new SharedThreadOwner();
    ownerFixture.desktopOutput.pipe(owner.output, { end: false });
    owner.input.pipe(ownerFixture.desktopInput, { end: false });
    const ownerNative = serveOfficialSections(ownerFixture, [], { Research: [], Review: [] });
    const local = createFixture({
      sharedThreads: new SharedThreadBridge({
        connect: async () => owner.connect(),
        delegateCreates: false,
        diagnose: () => undefined,
      }),
    });
    const localNative = serveOfficialSections(local, [], {
      Research: ["local-thread"],
      Review: ["local-review"],
      Empty: [],
    });
    try {
      await vi.waitFor(() => ownerFixture.mappingStore.listSectionPlacements());
      expect(await sectionRpc(ownerFixture, "list", {})).toHaveProperty("result");
      const shared = await startPiThread(ownerFixture);
      expect(
        await sectionRpc(ownerFixture, "move", { threadId: shared, sectionId: "Research" }),
      ).toHaveProperty("result");
      const before = await ownerFixture.mappingStore.listSectionPlacements();
      const move = (params: JsonObject) => sectionRpc(local, "move", params);
      await expect(move({ threadId: "local-thread", sectionId: "Research" })).resolves.toEqual({
        result: {},
      });
      await expect(move({ threadId: shared, sectionId: "Research" })).resolves.toEqual({
        result: {},
      });
      for (const params of [
        { threadId: "local-thread", sectionId: "Research", beforeThreadId: shared },
        { threadId: "local-thread", sectionId: "Research", beforeThreadId: null },
        { threadId: "local-thread", sectionId: "Review" },
        { threadId: "local-review", sectionId: "Research" },
        { threadId: shared, sectionId: "Review" },
      ]) {
        await expect(move(params)).resolves.toMatchObject({
          error: { code: -32078, message: expect.stringContaining("across owners") },
        });
      }
      expect(localNative.moves).toEqual([]);
      expect(ownerNative.moves).toEqual([]);
      expect(await local.mappingStore.listSectionPlacements()).toEqual([]);
      expect(await ownerFixture.mappingStore.listSectionPlacements()).toEqual(before);
      await expect(move({ threadId: "local-review", sectionId: "Empty" })).resolves.toEqual({
        result: {},
      });
    } finally {
      await stopFixture(local);
      owner.close();
      await stopFixture(ownerFixture);
    }
  });

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

  it.each([false, true])(
    "keeps section placement when metadata changes (restarted: %s)",
    async (restarted) => {
      let fixture = createFixture();
      const threadId = await startPiThread(fixture);
      serveOfficialSections(fixture, []);
      await call(fixture, 131, "thread/section/move", { threadId, sectionId: PINNED });
      const read = await call(fixture, 132, "thread/read", { threadId });
      const { section, sectionEnteredAt } = (read.result as JsonObject).thread as JsonObject;

      if (restarted) {
        const mappingStoreDirectory = fixture.mappingStoreDirectory;
        await closeFixture(fixture);
        fixture = createFixture({ mappingStoreDirectory });
        serveOfficialSections(fixture, []);
      }

      try {
        const updated = await call(fixture, 133, "thread/metadata/update", {
          threadId,
          projectId: "project-a",
          daybreakEnabled: true,
          gitInfo: { branch: "main" },
        });
        const expectedThread = {
          id: threadId,
          projectId: "project-a",
          daybreakEnabled: true,
          gitInfo: { branch: "main" },
          section,
          sectionEnteredAt,
        };
        expect(updated.result).toMatchObject({ thread: expectedThread });

        const listed = await call(fixture, 134, "thread/list", {
          ...pinnedList,
          projectId: "project-a",
        });
        expect((listed.result as JsonObject).data).toMatchObject([expectedThread]);
        const excluded = await call(fixture, 135, "thread/list", {
          ...pinnedList,
          projectId: "project-b",
        });
        expect((excluded.result as JsonObject).data).toEqual([]);

        await call(fixture, 136, "thread/section/move", { threadId, sectionId: null });
        const unpinned = await call(fixture, 137, "thread/metadata/update", {
          threadId,
          daybreakEnabled: false,
        });
        expect(unpinned.result).toMatchObject({
          thread: {
            ...expectedThread,
            daybreakEnabled: false,
            section: null,
            sectionEnteredAt: null,
          },
        });
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
