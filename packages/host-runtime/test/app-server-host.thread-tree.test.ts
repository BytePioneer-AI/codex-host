import {
  harnessIdSchema,
  hostThreadIdSchema,
  threadTreeWatchResultSchema,
  THREAD_TREE_WATCH_METHOD,
  THREAD_TREE_SNAPSHOT_METHOD,
} from "@codexhost/shared-contracts";
import { limitTreeParents } from "../src/thread-tree-watch.js";
import type { DelegationControlRegistration } from "../src/delegation-types.js";
import type { JsonObject } from "@codexhost/protocol-core";
import { afterEach, expect, it, vi } from "vitest";
import { OfficialRuntimeClient } from "../src/codex-runtime/official-runtime-scope.js";
import {
  createFixture,
  readJsonLine,
  startPiThread,
  startPiTurn,
  stopFixture,
  writeRequest,
} from "./app-server-host-fixture.js";
import { PINNED_THREAD_SECTION_ID as PINNED } from "../src/external-thread-pins.js";

function nativePins(pinned: string[] = [], states: Record<string, JsonObject> = {}) {
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
        return {
          result: {
            thread: {
              id,
              section: pinned.includes(id) ? { id: PINNED } : null,
              ...(states[id] ? { status: states[id] } : {}),
            },
          },
        };
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

it("bounds nodes without emitting dangling relationships", () => {
  const edges = Object.fromEntries(
    Array.from({ length: 5000 }, (_, index) => [`child-${index}`, "parent"]),
  );
  const bounded = limitTreeParents(edges);
  expect(bounded.ids.size).toBe(5000);
  expect(Object.keys(bounded.parents)).toHaveLength(4999);
  expect(bounded.truncated).toBe(true);
});

it("publishes full snapshots for delegation, Turn, multi-select and pin changes", async () => {
  const fixture = createFixture();
  cleanup.push(() => stopFixture(fixture));
  const child = await startPiThread(fixture);
  const pinned: string[] = [];
  const native = nativePins(pinned, {
    parent: { type: "systemError" },
    "official-child": { type: "active", activeFlags: ["waitingOnUserInput"] },
  });
  const addChild = async (id: string) => {
    await fixture.mappingStore.createDelegation({
      delegationId: hostThreadIdSchema.parse(`delegation-${id}`),
      parentHostThreadId: hostThreadIdSchema.parse("parent"),
      childHostThreadId: hostThreadIdSchema.parse(id),
      sourceHarnessId: harnessIdSchema.parse("codex"),
      targetHarnessId: harnessIdSchema.parse(id === child ? "pi" : "codex"),
      taskDigest: "a".repeat(64),
    });
    fixture.host.clientEvents.changed(id, "codexhost/thread/tree/changed");
  };
  await addChild(child);
  writeRequest(fixture.desktopInput, { id: 930, method: THREAD_TREE_WATCH_METHOD, params: {} });
  const initial = threadTreeWatchResultSchema.parse(
    (await fixture.collector.waitFor((m) => m.id === 930)).result,
  );
  expect(initial.snapshot).toMatchObject({
    parents: { [child]: "parent" },
    nodes: { [child]: { status: "idle" }, parent: { status: "unknown", harnessId: "codex" } },
  });
  let revision = initial.snapshot.revision;
  async function next(check: (snapshot: typeof initial.snapshot) => boolean) {
    const update = await fixture.collector.waitFor((m) => {
      if (m.method !== THREAD_TREE_SNAPSHOT_METHOD) return false;
      const result = threadTreeWatchResultSchema.parse(m.params);
      return (
        result.subscriptionId === initial.subscriptionId &&
        result.snapshot.revision > revision &&
        check(result.snapshot)
      );
    }, 1000);
    revision = threadTreeWatchResultSchema.parse(update.params).snapshot.revision;
  }
  await addChild("official-child");
  await next(
    (snapshot) => snapshot.nodes[hostThreadIdSchema.parse("official-child")]?.status === "waiting",
  );
  const turnId = await startPiTurn(fixture, child);
  const session = fixture.adapter.sessions[0];
  if (!session) throw new Error("Missing fixture Session");
  const status = (wanted: string) => (snapshot: typeof initial.snapshot) =>
    snapshot.nodes[hostThreadIdSchema.parse(child)]?.status === wanted;
  await next(status("running"));
  const interactionId = session.askQuestion({
    id: "pick",
    type: "choice",
    prompt: "Pick",
    multiple: true,
    optional: false,
    allowOther: false,
    options: [
      { value: "a", label: "A" },
      { value: "b", label: "B" },
    ],
  });
  await next(status("waiting"));
  writeRequest(fixture.desktopInput, {
    id: 931,
    method: "codexhost/thread/question/respond",
    params: { threadId: child, turnId, interactionId, answers: { pick: ["a", "b"] } },
  });
  expect(await fixture.collector.waitFor((m) => m.id === 931)).toHaveProperty("result");
  session.succeedTurn();
  await next(status("idle"));
  await fixture.host.handleClientRequest("codexhost/thread/pins/set", {
    threadId: child,
    pinned: true,
  });
  await next((snapshot) => !Object.hasOwn(snapshot.parents, child));
  expect(
    native.mock.calls.filter(
      ([method, params]) => method === "thread/read" && params.threadId === "parent",
    ),
  ).toHaveLength(1);
  fixture.desktopInput.end();
  await fixture.running;
  const count = fixture.collector.messages.length;
  fixture.host.clientEvents.changed(child, "codexhost/thread/tree/changed");
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(fixture.collector.messages).toHaveLength(count);
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

async function delegateBelowParent(fixture: ReturnType<typeof createFixture>, child: string) {
  for (const [parent, id] of [
    ["parent", child],
    [child, "grandchild"],
  ]) {
    await fixture.mappingStore.createDelegation({
      delegationId: hostThreadIdSchema.parse(`delegation-${id}`),
      parentHostThreadId: hostThreadIdSchema.parse(parent),
      childHostThreadId: hostThreadIdSchema.parse(id),
      sourceHarnessId: harnessIdSchema.parse("pi"),
      targetHarnessId: harnessIdSchema.parse("codex"),
      taskDigest: "a".repeat(64),
    });
  }
}

it.each(["official", "external"])(
  "drops a deleted %s Thread and its Delegations from the Thread tree",
  async (kind) => {
    const fixture = createFixture();
    cleanup.push(() => stopFixture(fixture));
    await fixture.ready;
    const child = kind === "external" ? await startPiThread(fixture) : "official-child";
    nativePins();
    await delegateBelowParent(fixture, child);
    const readTree = () => fixture.host.handleClientRequest("codexhost/thread/tree/read", {});
    expect(await readTree()).toEqual({
      result: { parents: { [child]: "parent", grandchild: child } },
    });
    const changed = vi.spyOn(fixture.host.clientEvents, "changed");

    const request = { id: 921, method: "thread/delete", params: { threadId: child } };
    writeRequest(fixture.desktopInput, request);
    if (kind === "official") {
      expect(await readJsonLine(fixture.official.stdin)).toEqual(request);
      // A colliding server-initiated request ID must not retire the pending delete.
      fixture.official.stdout.write(
        `${JSON.stringify({ id: 921, method: "item/tool/requestUserInput", params: { threadId: "other", questions: [] } })}\n`,
      );
      fixture.official.stdout.write(`${JSON.stringify({ id: 921, result: {} })}\n`);
    }
    expect(
      await fixture.collector.waitFor((message) => message.id === 921 && !("method" in message)),
    ).toEqual({
      id: 921,
      result: {},
    });

    await vi.waitFor(() =>
      expect(changed).toHaveBeenCalledWith(child, "codexhost/thread/tree/changed"),
    );
    // Its own Delegation and its children's go: the grandchild now stands at the top.
    expect(await fixture.mappingStore.listDelegations()).toEqual([]);
    expect(await readTree()).toEqual({ result: { parents: {} } });
  },
);

it("keeps an official Thread's Delegations when its deletion fails", async () => {
  const fixture = createFixture();
  cleanup.push(() => stopFixture(fixture));
  await fixture.ready;
  await delegateBelowParent(fixture, "official-child");
  const request = { id: 922, method: "thread/delete", params: { threadId: "official-child" } };
  writeRequest(fixture.desktopInput, request);
  expect(await readJsonLine(fixture.official.stdin)).toEqual(request);
  const failure = { id: 922, error: { code: -32600, message: "Thread not found" } };
  fixture.official.stdout.write(`${JSON.stringify(failure)}\n`);
  expect(await fixture.collector.waitFor((message) => message.id === 922)).toEqual(failure);
  expect(
    (await fixture.mappingStore.listDelegations()).map(
      ({ childHostThreadId }) => childHostThreadId,
    ),
  ).toEqual(expect.arrayContaining(["official-child", "grandchild"]));
});
