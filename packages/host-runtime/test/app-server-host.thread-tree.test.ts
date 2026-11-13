import { harnessIdSchema, hostThreadIdSchema } from "@codexhost/shared-contracts";
import type { DelegationControlRegistration } from "../src/delegation-types.js";
import type { JsonObject } from "@codexhost/protocol-core";
import { afterEach, expect, it, vi } from "vitest";
import { OfficialRuntimeClient } from "../src/codex-runtime/official-runtime-scope.js";
import { createFixture, stopFixture, writeRequest } from "./app-server-host-fixture.js";

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

it("routes tree methods on client and Desktop channels while native archive remains non-cascading", async () => {
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
  expect(
    await fixture.host.handleClientRequest("codexhost/thread/tree/place", {
      threadId: child,
      parentThreadId: null,
    }),
  ).toEqual({ result: { parents: {} } });
  expect(await listChildren()).toEqual(delegated);
  expect(
    await fixture.host.handleClientRequest("codexhost/thread/tree/place", {
      threadId: child,
      parentThreadId: parent,
    }),
  ).toEqual({ result: { parents: { [child]: parent } } });
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
