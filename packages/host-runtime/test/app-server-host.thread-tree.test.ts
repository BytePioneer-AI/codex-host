import { harnessIdSchema, hostThreadIdSchema } from "@codexhost/shared-contracts";
import type { DelegationControlRegistration } from "../src/delegation-types.js";
import type { JsonObject } from "@codexhost/protocol-core";
import { afterEach, expect, it, vi } from "vitest";
import { OfficialRuntimeClient } from "../src/codex-runtime/official-runtime-scope.js";
import {
  createFixture,
  startPiThread,
  stopFixture,
  writeRequest,
} from "./app-server-host-fixture.js";
import { PINNED_THREAD_SECTION_ID as PINNED } from "../src/external-thread-pins.js";

function nativePins(pinned: string[] = []) {
  return vi
    .spyOn(OfficialRuntimeClient.prototype, "request")
    .mockImplementation(async (method, params) => {
      if (method === "threadSection/list")
        return {
          result: { data: [{ id: PINNED, name: "Pinned", appearance: null }], nextCursor: null },
        };
      if (method === "thread/list")
        return { result: { data: pinned.map((id) => ({ id })), nextCursor: null } };
      const id = String(params.threadId);
      if (method === "thread/read")
        return { result: { thread: { id, section: pinned.includes(id) ? { id: PINNED } : null } } };
      if (method === "thread/section/move") {
        const index = pinned.indexOf(id);
        if (index >= 0) pinned.splice(index, 1);
        if (params.sectionId === PINNED) pinned.unshift(id);
      }
      return { result: {} };
    });
}

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0)) await close();
});

it("publishes official delegation tree changes after persistence even though native creation happens first", async () => {
  let api: DelegationControlRegistration | undefined;
  const fixture = createFixture({
    onDelegationApi: (value) => {
      api = value;
      return undefined;
    },
  });
  cleanup.push(() => stopFixture(fixture));
  await fixture.ready;
  const changed = vi.spyOn(fixture.host.clientEvents, "changed");
  vi.spyOn(OfficialRuntimeClient.prototype, "request").mockImplementation(async (method) => {
    if (method === "thread/start") {
      expect(await fixture.mappingStore.listDelegations()).toEqual([]);
      fixture.official.stdout.write(
        `${JSON.stringify({ method: "thread/started", params: { thread: { id: "official-child", cwd: "/synthetic" } } })}\n`,
      );
      return { result: { thread: { id: "official-child", cwd: "/synthetic" } } };
    }
    if (method === "threadSection/list")
      return {
        result: { data: [{ id: PINNED, name: "Pinned", appearance: null }], nextCursor: null },
      };
    if (method === "thread/list") return { result: { data: [], nextCursor: null } };
    if (method === "thread/read")
      return { result: { thread: { id: "parent", cwd: "/synthetic" } } };
    if (method === "turn/start") return { result: { turn: { id: "official-turn" } } };
    return { result: {} };
  });
  const written = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  cleanup.push(async () => {
    release.resolve(undefined);
  });
  const create = fixture.mappingStore.createDelegation.bind(fixture.mappingStore);
  vi.spyOn(fixture.mappingStore, "createDelegation").mockImplementation(async (input) => {
    const record = await create(input);
    written.resolve(undefined);
    await release.promise;
    return record;
  });
  if (!api) throw new Error("Missing delegation API");
  const starting = api.start({
    harnessId: "codex",
    parentThreadId: "parent",
    cwd: "/synthetic",
    task: "Create child",
  });
  await written.promise;
  await fixture.collector.waitFor((message) => message.method === "thread/started");
  expect(changed).not.toHaveBeenCalledWith("official-child", "codexhost/thread/tree/changed");
  release.resolve(undefined);
  await starting;
  expect(changed).toHaveBeenCalledWith("official-child", "codexhost/thread/tree/changed");
  expect(await fixture.host.handleClientRequest("codexhost/thread/tree/read", {})).toEqual({
    result: { parents: { "official-child": "parent" } },
  });
});

it("reads delegation parents on client and Desktop channels while native archive remains non-cascading", async () => {
  let api: DelegationControlRegistration | undefined;
  const fixture = createFixture({
    onDelegationApi: (value) => {
      api = value;
      return undefined;
    },
  });
  cleanup.push(() => stopFixture(fixture));
  await fixture.ready;
  const ids: string[] = [];
  for (let i = 0; i < 2; i++) {
    const started = await fixture.host.handleClientRequest("thread/start", {
      model: "codexhost/pi-native",
      cwd: "/synthetic",
    });
    if (!("result" in started)) throw new Error(started.error.message);
    ids.push(String(((started.result as JsonObject).thread as JsonObject).id));
  }
  nativePins();
  const [parent, child] = ids;
  if (!parent || !child || !api) throw new Error("Missing fixture identities");
  const delegationApi = api;
  await fixture.mappingStore.createDelegation({
    delegationId: hostThreadIdSchema.parse("delegation-test"),
    parentHostThreadId: hostThreadIdSchema.parse(parent),
    childHostThreadId: hostThreadIdSchema.parse(child),
    sourceHarnessId: harnessIdSchema.parse("pi"),
    targetHarnessId: harnessIdSchema.parse("pi"),
    taskDigest: "a".repeat(64),
  });
  const listChildren = () =>
    delegationApi.list({ parentThreadId: parent, limit: 20, sort: "updated-desc" });
  const delegated = await listChildren();
  expect(delegated.threads.map((thread) => thread.threadId)).toEqual([child]);
  expect(await fixture.host.handleClientRequest("codexhost/thread/tree/read", {})).toEqual({
    result: { parents: { [child]: parent } },
  });
  expect(await listChildren()).toEqual(delegated);
  writeRequest(fixture.desktopInput, { id: 901, method: "codexhost/thread/tree/read", params: {} });
  expect(await fixture.collector.waitFor((message) => message.id === 901)).toMatchObject({
    result: { parents: { [child]: parent } },
  });
  writeRequest(fixture.desktopInput, {
    id: 902,
    method: "thread/archive",
    params: { threadId: parent },
  });
  expect(await fixture.collector.waitFor((message) => message.id === 902)).toHaveProperty("result");
  const records = await fixture.mappingStore.listThreads();
  expect(records.find((record) => record.hostThreadId === parent)?.archived).toBe(true);
  expect(records.find((record) => record.hostThreadId === child)?.archived).toBe(false);
});

it.each(["official", "external"])(
  "promotes and restores %s children on Web and Desktop pin changes, preserving descendants",
  async (kind) => {
    const fixture = createFixture();
    cleanup.push(() => stopFixture(fixture));
    await fixture.ready;
    const child = kind === "external" ? await startPiThread(fixture) : "official-child";
    nativePins();
    for (const [parent, id] of [
      ["parent", child],
      [child, "grandchild"],
    ]) {
      await fixture.mappingStore.createDelegation({
        delegationId: hostThreadIdSchema.parse(`delegation-${id}`),
        parentHostThreadId: hostThreadIdSchema.parse(parent),
        childHostThreadId: hostThreadIdSchema.parse(id),
        sourceHarnessId: harnessIdSchema.parse("pi"),
        targetHarnessId: harnessIdSchema.parse(kind === "official" ? "codex" : "pi"),
        taskDigest: "a".repeat(64),
      });
    }
    const readTree = () => fixture.host.handleClientRequest("codexhost/thread/tree/read", {});
    const original = { result: { parents: { [child]: "parent", grandchild: child } } };
    expect(await readTree()).toEqual(original);
    const changed = vi.spyOn(fixture.host.clientEvents, "changed");
    for (const source of ["web", "desktop"]) {
      for (const pinned of [true, false]) {
        changed.mockClear();
        if (source === "web") {
          expect(
            await fixture.host.handleClientRequest("codexhost/thread/pins/set", {
              threadId: child,
              pinned,
            }),
          ).toHaveProperty("result");
        } else {
          const id = pinned ? 911 : 912;
          writeRequest(fixture.desktopInput, {
            id,
            method: "thread/section/move",
            params: { threadId: child, sectionId: pinned ? PINNED : null },
          });
          expect(await fixture.collector.waitFor((message) => message.id === id)).toHaveProperty(
            "result",
          );
        }
        await vi.waitFor(() =>
          expect(changed).toHaveBeenCalledWith(child, "codexhost/thread/tree/changed"),
        );
        expect(await readTree()).toEqual(
          pinned ? { result: { parents: { grandchild: child } } } : original,
        );
      }
    }
  },
);

it("observes out-of-process Desktop pin membership on canonical reads, without events on unchanged membership or reorder", async () => {
  const fixture = createFixture();
  cleanup.push(() => stopFixture(fixture));
  await fixture.ready;
  const pinned: string[] = [];
  nativePins(pinned);
  const changed = vi.spyOn(fixture.host.clientEvents, "changed");
  const read = () => fixture.host.handleClientRequest("codexhost/thread/pins/list", {});
  await read();
  changed.mockClear();
  pinned.push("official-child", "official-other");
  await read();
  expect(changed).toHaveBeenCalledWith("official-child", "codexhost/thread/tree/changed");
  expect(changed).toHaveBeenCalledWith("official-other", "codexhost/thread/tree/changed");
  changed.mockClear();
  pinned.reverse();
  await read();
  expect(changed).not.toHaveBeenCalled();
  pinned.splice(pinned.indexOf("official-child"), 1);
  await read();
  expect(changed).toHaveBeenCalledExactlyOnceWith(
    "official-child",
    "codexhost/thread/tree/changed",
  );

  const external = await startPiThread(fixture);
  await vi.waitFor(() => expect(changed).toHaveBeenCalledWith(external, "thread/started"));
  changed.mockClear();
  await fixture.mappingStore.replaceSectionPlacements([
    {
      hostThreadId: hostThreadIdSchema.parse(external),
      section: { id: PINNED, name: "Pinned", appearance: null },
      enteredAt: new Date().toISOString(),
      beforeThreadId: null,
    },
  ]);
  await read();
  expect(changed).toHaveBeenCalledExactlyOnceWith(external, "codexhost/thread/tree/changed");
  changed.mockClear();
  await fixture.mappingStore.replaceSectionPlacements([]);
  await read();
  expect(changed).toHaveBeenCalledExactlyOnceWith(external, "codexhost/thread/tree/changed");
});
