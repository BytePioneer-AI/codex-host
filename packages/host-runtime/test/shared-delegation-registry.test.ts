import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, it } from "vitest";
import { FakeHarnessAdapter } from "@codexhost/harness-adapter/testing";
import { MappingStore } from "@codexhost/mapping-store";
import { harnessIdSchema, hostThreadIdSchema } from "@codexhost/shared-contracts";
import { AppServerHost } from "../src/app-server-host.js";
import { DelegationControlRegistry } from "../src/delegation-control-registry.js";
import type { DelegationControlRegistration } from "../src/delegation-types.js";
import { SharedThreadBridge } from "../src/shared-thread-bridge.js";
import { SharedThreadOwner } from "../src/shared-thread-owner.js";
import {
  createFixture,
  JsonLineCollector,
  stopFixture,
  writeRequest,
} from "./app-server-host-fixture.js";

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function setup() {
  const directory = mkdtempSync(path.join(tmpdir(), "shared-delegation-registry-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const owner = new SharedThreadOwner();
  const adapter = new FakeHarnessAdapter(harnessIdSchema.parse("pi"));
  const store = new MappingStore({ directory });
  let sharedApi!: DelegationControlRegistration;
  const host = new AppServerHost({
    stockCodexPath: "/unused",
    arguments: [],
    externalOnly: true,
    desktopInput: owner.input,
    desktopOutput: owner.output,
    diagnosticOutput: new PassThrough(),
    mappingStore: store,
    environment: { CODEXHOST_DATA_DIR: directory },
    externalAdapters: new Map([["pi", adapter]]),
    onDelegationApi: (api) => {
      sharedApi = api;
    },
  });
  const running = host.run();
  cleanup.push(async () => {
    host.close();
    owner.close();
    await running;
    owner.output.end();
  });
  const registry = new DelegationControlRegistry();
  cleanup.push(() => registry.close());
  const bridge = new SharedThreadBridge({
    connect: async () => owner.connect(),
    delegateCreates: true,
    diagnose: () => {},
  });
  let sshApi!: DelegationControlRegistration;
  const ssh = createFixture({
    externalOnly: true,
    sharedThreads: bridge,
    onDelegationApi: (api) => {
      sshApi = api;
      return registry.register(api, { harnessCatalog: true });
    },
  });
  cleanup.push(() => stopFixture(ssh));
  const nativeId = "native-thread";
  const official = new JsonLineCollector(ssh.official.stdin);
  ssh.official.stdin.on("data", () => {
    for (const request of official.messages.splice(0))
      ssh.official.stdout.write(
        JSON.stringify({
          id: request.id,
          ...(request.method === "thread/read"
            ? { error: { code: -32600, message: "not a native Thread" } }
            : {
                result: {
                  data:
                    request.method === "thread/list"
                      ? [
                          {
                            id: nativeId,
                            cwd: "/native",
                            preview: "native",
                            modelProvider: "openai",
                            createdAt: 1,
                            updatedAt: 1,
                            status: { type: "idle" },
                          },
                        ]
                      : [],
                  nextCursor: null,
                },
              }),
        }) + "\n",
      );
  });
  // Seed a historical SSH-only parent without changing the proxy registration.
  bridge.options.delegateCreates = false;
  writeRequest(ssh.desktopInput, {
    id: 1,
    method: "thread/start",
    params: { model: "codexhost/pi-native", cwd: "/synthetic" },
  });
  const legacy = await ssh.collector.waitFor((message) => message.id === 1);
  expect(legacy.error).toBeUndefined();
  const legacyParent = (legacy.result as { thread: { id: string } }).thread.id;
  bridge.options.delegateCreates = true;
  const peer = owner.connect();
  cleanup.push(() => peer.close());
  const started = await peer.request("thread/start", {
    model: "codexhost/pi-native",
    cwd: "/synthetic",
  });
  expect(started.error).toBeUndefined();
  const sharedParent = (started.result as { thread: { id: string } }).thread.id;
  return { registry, sharedApi, sshApi, sharedParent, legacyParent, nativeId, ssh, owner, store };
}

it("selects only the SSH proxy for a shared parent with multiple attached clients", async () => {
  const { registry, sshApi, sharedParent, legacyParent, ssh, owner, store } = await setup();
  for (let index = 0; index < 2; index++) {
    const frontend = createFixture({
      sharedThreads: new SharedThreadBridge({
        connect: async () => owner.connect(),
        delegateCreates: true,
        diagnose: () => {},
      }),
      sharedDelegation: sshApi,
      mappingStore: ssh.mappingStore,
      closeMappingStoreOnExit: false,
      onDelegationApi: (api) => registry.register(api),
    });
    cleanup.push(() => stopFixture(frontend));
  }
  const child = await registry.start({
    harnessId: "pi",
    parentThreadId: sharedParent,
    task: "shared child",
  });
  expect(child.parentThreadId).toBe(sharedParent);
  const childId = hostThreadIdSchema.parse(child.threadId);
  expect(await store.getThread(childId)).toMatchObject({ harnessId: "pi" });
  expect(await ssh.mappingStore.getThread(childId)).toBeNull();
  const legacy = await registry.start({
    harnessId: "pi",
    parentThreadId: legacyParent,
    task: "legacy child",
  });
  const legacyId = hostThreadIdSchema.parse(legacy.threadId);
  expect(await ssh.mappingStore.getThread(legacyId)).toMatchObject({ harnessId: "pi" });
  expect(await store.getThread(legacyId)).toBeNull();
  owner.close();
  await expect(
    registry.start({ harnessId: "pi", parentThreadId: sharedParent, task: "never fall back" }),
  ).rejects.toThrow(/closed|disconnected/);
  expect(await ssh.mappingStore.listThreads()).toHaveLength(2);
});

it("continues a shared child list through the Registry and rejects other cursor sources", async () => {
  const { registry, sharedApi, sshApi, sharedParent, legacyParent } = await setup();
  const children = await Promise.all(
    ["first", "second"].map((task) =>
      sharedApi.start({ harnessId: "pi", parentThreadId: sharedParent, task }),
    ),
  );
  const query = { parentThreadId: sharedParent, sort: "created-asc" as const, limit: 1 };
  const first = await registry.list(query);
  expect(first.nextCursor).not.toBeNull();
  const cursor = first.nextCursor ?? "";
  const second = await registry.list({ ...query, cursor });
  expect([...first.threads, ...second.threads].map((thread) => thread.threadId).sort()).toEqual(
    children.map((child) => child.threadId).sort(),
  );
  expect(second.nextCursor).toBeNull();
  for (const changed of [
    { parentThreadId: legacyParent },
    { cwd: "/other" },
    { sort: "updated-desc" as const },
  ])
    await expect(registry.list({ ...query, ...changed, cursor })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  const other = new DelegationControlRegistry();
  cleanup.push(() => other.close());
  other.register({
    ...sharedApi,
    list: (input) => sharedApi.list({ ...input, parentThreadId: sharedParent }),
  });
  other.register({
    ...sshApi,
    list: (input) => sshApi.list({ ...input, parentThreadId: sharedParent }),
  });
  const foreign = await other.list({ sort: "created-asc", limit: 1 });
  expect(foreign.nextCursor).not.toBeNull();
  await expect(registry.list({ ...query, cursor: foreign.nextCursor ?? "" })).rejects.toMatchObject(
    { code: "INVALID_ARGUMENT" },
  );
  const direct = new DelegationControlRegistry();
  cleanup.push(() => direct.close());
  direct.register(sharedApi);
  await expect(direct.list({ ...query, cursor })).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
  await expect(registry.list({ sort: query.sort, limit: 1, cursor })).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
});

it("keeps shared and legacy external Harness identities in the SSH global catalog", async () => {
  const { registry, sharedParent, legacyParent, nativeId } = await setup();
  const page = await registry.list({ sort: "created-asc", limit: 10 });
  expect(page.threads).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ threadId: sharedParent, harnessId: "pi" }),
      expect.objectContaining({ threadId: legacyParent, harnessId: "pi" }),
      expect.objectContaining({ threadId: nativeId, harnessId: "codex" }),
    ]),
  );
});
