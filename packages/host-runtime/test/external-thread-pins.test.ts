import { afterEach, expect, it, vi } from "vitest";
import type { JsonObject } from "@codexhost/protocol-core";
import { HostClientChannel } from "@codexhost/desktop-control";
import { startClientChannelServer } from "../src/client-channel-server.js";
import { PINNED_THREAD_SECTION_ID as PINNED } from "../src/external-thread-pins.js";
import {
  closeFixture,
  createFixture,
  startPiThread,
  startExternalThread,
  stopFixture,
  writeRequest,
} from "./app-server-host-fixture.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

function nativeSections(fixture: ReturnType<typeof createFixture>, pinned: string[] = []) {
  const requests: JsonObject[] = [];
  let failure = false;
  let moveFailure = false;
  let buffer = "";
  fixture.official.stdin.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const request = JSON.parse(buffer.slice(0, newline)) as JsonObject;
      buffer = buffer.slice(newline + 1);
      requests.push(request);
      const params = (request.params ?? {}) as JsonObject;
      const id = String(params.threadId);
      let result: JsonObject = {};
      let error: JsonObject | undefined;
      if (failure) error = { code: -32601, message: "Native sections unavailable" };
      else if (request.method === "threadSection/list")
        result = { data: [{ id: PINNED, name: "Pinned", appearance: null }], nextCursor: null };
      else if (request.method === "thread/list")
        result = { data: pinned.map((id) => ({ id })), nextCursor: null, backwardsCursor: null };
      else if (request.method === "thread/read") {
        if (!id.startsWith("official")) error = { code: -32600, message: "Thread not found" };
        else
          result = {
            thread: {
              id,
              archived: id === "official-archived",
              section: pinned.includes(id)
                ? { id: PINNED }
                : id === "official-custom"
                  ? { id: "custom" }
                  : null,
            },
          };
      } else if (request.method === "thread/section/move") {
        if (moveFailure) error = { code: -32600, message: "Native move refused" };
        else {
          const index = pinned.indexOf(id);
          if (index >= 0) pinned.splice(index, 1);
          if (params.sectionId === PINNED) {
            const before = params.beforeThreadId;
            pinned.splice(before == null ? pinned.length : pinned.indexOf(String(before)), 0, id);
          }
        }
      }
      fixture.official.stdout.write(
        JSON.stringify({ id: request.id, ...(error ? { error } : { result }) }) + "\n",
      );
    }
  });
  return {
    requests,
    failMoves: () => {
      moveFailure = true;
    },
    fail: () => {
      failure = true;
    },
  };
}

async function setup(pinned: string[] = []) {
  const fixture = createFixture();
  cleanup.push(() => stopFixture(fixture));
  const native = nativeSections(fixture, pinned);
  const threadId = await startPiThread(fixture);
  return { fixture, native, threadId };
}
const read = (fixture: ReturnType<typeof createFixture>) =>
  fixture.host.handleClientRequest("codexhost/thread/pins/list", {});
const set = (fixture: ReturnType<typeof createFixture>, threadId: string, pinned: boolean) =>
  fixture.host.handleClientRequest("codexhost/thread/pins/set", { threadId, pinned });

it("shares durable native sections between authenticated Web clients and Desktop protocol reads", async () => {
  const { fixture, threadId, native } = await setup(["official"]);
  const server = await startClientChannelServer({
    target: fixture.host,
    environment: {},
    directory: fixture.mappingStoreDirectory,
  });
  cleanup.push(() => server.close());
  const a = new HostClientChannel(fixture.mappingStoreDirectory, server.descriptor);
  const b = new HostClientChannel(fixture.mappingStoreDirectory, server.descriptor);
  cleanup.push(async () => {
    a.close();
    b.close();
  });
  await Promise.all([a.start(), b.start()]);
  const writes = vi.spyOn(fixture.mappingStore, "replaceSectionPlacements");
  expect(await a.request("codexhost/thread/pins/set", { threadId, pinned: true })).toEqual({
    threadIds: [threadId, "official"],
  });
  expect(await b.request("codexhost/thread/pins/list", {})).toEqual({
    threadIds: [threadId, "official"],
  });
  expect(await b.request("codexhost/workspace/read", {})).toMatchObject({ pinned: [threadId] });
  await a.request("codexhost/thread/pins/set", { threadId, pinned: true });
  expect(writes).toHaveBeenCalledOnce();
  writeRequest(fixture.desktopInput, {
    id: 501,
    method: "thread/list",
    params: { sectionId: PINNED, sortKey: "section_position", modelProviders: [], limit: 100 },
  });
  const desktop = await fixture.collector.waitFor((message) => message.id === 501);
  expect(((desktop.result as JsonObject).data as JsonObject[]).map((row) => row.id)).toEqual([
    threadId,
    "official",
  ]);
  expect(await a.request("codexhost/thread/pins/set", { threadId, pinned: false })).toEqual({
    threadIds: ["official"],
  });
  expect(await b.request("codexhost/thread/pins/list", {})).toEqual({ threadIds: ["official"] });
  expect(native.requests.some((request) => request.method === "thread/section/move")).toBe(false);
  expect(fixture.adapter.sessions).toHaveLength(1);
});

it("shares official-only pins bidirectionally between Web and Desktop, including fresh reads", async () => {
  const fixture = createFixture();
  cleanup.push(() => stopFixture(fixture));
  const native = nativeSections(fixture);
  await fixture.ready;
  const server = await startClientChannelServer({
    target: fixture.host,
    environment: {},
    directory: fixture.mappingStoreDirectory,
  });
  cleanup.push(() => server.close());
  const web = new HostClientChannel(fixture.mappingStoreDirectory, server.descriptor);
  cleanup.push(async () => web.close());
  await web.start();
  const writes = vi.spyOn(fixture.mappingStore, "replaceSectionPlacements");
  const pins = () => web.request("codexhost/thread/pins/list", {});
  const change = (pinned: boolean) =>
    web.request("codexhost/thread/pins/set", { threadId: "official", pinned });
  const desktopMove = async (id: number, pinned: boolean) => {
    writeRequest(fixture.desktopInput, {
      id,
      method: "thread/section/move",
      params: { threadId: "official", sectionId: pinned ? PINNED : null },
    });
    expect(await fixture.collector.waitFor((message) => message.id === id)).toEqual({
      id,
      result: {},
    });
  };
  expect(await change(true)).toEqual({ threadIds: ["official"] });
  await change(true);
  writeRequest(fixture.desktopInput, {
    id: 510,
    method: "thread/list",
    params: { sectionId: PINNED, sortKey: "section_position", modelProviders: [], limit: 100 },
  });
  expect(await fixture.collector.waitFor((message) => message.id === 510)).toMatchObject({
    result: { data: [{ id: "official" }] },
  });
  expect(await change(false)).toEqual({ threadIds: [] });
  await change(false);
  expect(native.requests.filter((r) => r.method === "thread/section/move")).toHaveLength(2);
  await desktopMove(511, true);
  expect(await pins()).toEqual({ threadIds: ["official"] });
  await desktopMove(512, false);
  expect(await pins()).toEqual({ threadIds: [] });
  expect(writes).not.toHaveBeenCalled();
  expect(await fixture.mappingStore.listThreads()).toEqual([]);
});

it("moves official pins around External anchors without changing either owner's membership", async () => {
  const { fixture, threadId, native } = await setup(["official"]);
  expect(await set(fixture, threadId, true)).toEqual({
    result: { threadIds: [threadId, "official"] },
  });
  expect(await set(fixture, "official-second", true)).toEqual({
    result: { threadIds: ["official-second", threadId, "official"] },
  });
  expect(
    native.requests.filter((r) => r.method === "thread/section/move").map((r) => r.params),
  ).toEqual([{ threadId: "official-second", sectionId: PINNED, beforeThreadId: "official" }]);
  expect(await set(fixture, "official", false)).toEqual({
    result: { threadIds: ["official-second", threadId] },
  });
  expect(await fixture.mappingStore.listSectionPlacements()).toMatchObject([
    { hostThreadId: threadId, beforeThreadId: null },
  ]);
  await fixture.host.handleClientRequest("thread/archive", { threadId });
  expect(await read(fixture)).toEqual({ result: { threadIds: ["official-second"] } });
  expect(await set(fixture, "official-second", false)).toEqual({ result: { threadIds: [] } });
  expect(await fixture.mappingStore.listThreads()).toHaveLength(1);
});

it("does not expose orphan External placements as official pins", async () => {
  const { fixture, threadId } = await setup(["official"]);
  await set(fixture, threadId, true);
  vi.spyOn(fixture.mappingStore, "listThreads").mockResolvedValue([]);
  expect(await read(fixture)).toEqual({ result: { threadIds: ["official"] } });
});

it("leaves an official custom section alone on unpin and does not simulate a rejected official move", async () => {
  const { fixture, native } = await setup();
  expect(await set(fixture, "official-custom", false)).toEqual({ result: { threadIds: [] } });
  expect(native.requests.some((r) => r.method === "thread/section/move")).toBe(false);
  native.failMoves();
  expect(await set(fixture, "official", true)).toMatchObject({
    error: { message: "Native move refused" },
  });
  expect(await read(fixture)).toEqual({ result: { threadIds: [] } });
  expect(await fixture.mappingStore.listSectionPlacements()).toEqual([]);
  expect(native.requests.filter((r) => r.method === "thread/section/move")).toHaveLength(1);
});

it("persists the pin across Host restart and reads subsequent Desktop unpin operations", async () => {
  const { fixture, threadId } = await setup();
  expect(await set(fixture, threadId, true)).toEqual({ result: { threadIds: [threadId] } });
  await closeFixture(fixture);
  const reopened = createFixture({ mappingStoreDirectory: fixture.mappingStoreDirectory });
  cleanup.push(() => stopFixture(reopened));
  nativeSections(reopened);
  await reopened.ready;
  expect(await read(reopened)).toEqual({ result: { threadIds: [threadId] } });
  writeRequest(reopened.desktopInput, {
    id: 502,
    method: "thread/section/move",
    params: { threadId, sectionId: null },
  });
  expect(await reopened.collector.waitFor((message) => message.id === 502)).toEqual({
    id: 502,
    result: {},
  });
  expect(await read(reopened)).toEqual({ result: { threadIds: [] } });
});

it("serializes pins on different Threads with Desktop section moves", async () => {
  const { fixture, threadId } = await setup();
  const second = await startExternalThread(fixture, "codexhost/pi-native", 503);
  await Promise.all([set(fixture, threadId, true), set(fixture, second, true)]);
  expect(await read(fixture)).toEqual({ result: { threadIds: [second, threadId] } });
  writeRequest(fixture.desktopInput, {
    id: 504,
    method: "thread/section/move",
    params: { threadId: second, sectionId: null },
  });
  await Promise.all([
    fixture.collector.waitFor((message) => message.id === 504),
    set(fixture, threadId, false),
  ]);
  expect(await read(fixture)).toEqual({ result: { threadIds: [] } });
});

it("refuses missing official Threads, malformed parameters and archived pin targets", async () => {
  const { fixture, threadId, native } = await setup();
  expect(await set(fixture, "missing", true)).toHaveProperty("error");
  expect(await set(fixture, "official-archived", true)).toHaveProperty("error");
  expect(
    await fixture.host.handleClientRequest("codexhost/thread/pins/set", {
      threadId,
      pinned: "yes",
    }),
  ).toHaveProperty("error");
  await fixture.host.handleClientRequest("thread/archive", { threadId });
  expect(await set(fixture, threadId, true)).toHaveProperty("error");
  expect(await fixture.mappingStore.listSectionPlacements()).toEqual([]);
  expect(native.requests.some((request) => request.method === "thread/section/move")).toBe(false);
});

it("leaves a custom section alone when cancelling a non-existent pin", async () => {
  const { fixture, threadId } = await setup();
  const record = (await fixture.mappingStore.listThreads())[0];
  if (!record) throw new Error("Missing external Thread");
  const placement = {
    hostThreadId: record.hostThreadId,
    section: { id: "custom", name: "Work", appearance: null },
    enteredAt: new Date().toISOString(),
    beforeThreadId: null,
  };
  await fixture.mappingStore.replaceSectionPlacements([placement]);
  expect(await set(fixture, threadId, false)).toEqual({ result: { threadIds: [] } });
  expect(await fixture.mappingStore.listSectionPlacements()).toEqual([placement]);
});

it("does not undo or replay a durable write when native confirmation fails", async () => {
  const { fixture, threadId, native } = await setup();
  const replace = fixture.mappingStore.replaceSectionPlacements.bind(fixture.mappingStore);
  const writes = vi
    .spyOn(fixture.mappingStore, "replaceSectionPlacements")
    .mockImplementation(async (placements) => {
      const saved = await replace(placements);
      native.fail();
      return saved;
    });
  expect(await set(fixture, threadId, true)).toHaveProperty("error");
  expect(await fixture.mappingStore.listSectionPlacements()).toMatchObject([
    { hostThreadId: threadId, section: { id: PINNED } },
  ]);
  expect(await set(fixture, threadId, true)).toHaveProperty("error");
  expect(writes).toHaveBeenCalledOnce();
});

it("fails without changing state when native sections are unavailable, with no fallback", async () => {
  const { fixture, threadId, native } = await setup();
  expect(await set(fixture, threadId, true)).toHaveProperty("result");
  const saved = await fixture.mappingStore.listSectionPlacements();
  native.fail();
  expect(await set(fixture, threadId, false)).toHaveProperty("error");
  expect(await read(fixture)).toHaveProperty("error");
  expect(await fixture.mappingStore.listSectionPlacements()).toEqual(saved);
  expect(native.requests.some((request) => request.method === "thread/start")).toBe(false);
});
