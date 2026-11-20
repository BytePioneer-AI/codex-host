import type { DelegationControlRegistration } from "../src/delegation-types.js";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { FakeHarnessAdapter } from "@codexhost/harness-adapter/testing";
import { MappingStore } from "@codexhost/mapping-store";
import { HostClientChannel } from "@codexhost/desktop-control";
import { encodeHarnessPluginRoute, harnessIdSchema } from "@codexhost/shared-contracts";
import type { JsonObject } from "@codexhost/protocol-core";
import { AppServerHost } from "../src/app-server-host.js";
import { SharedThreadOwner } from "../src/shared-thread-owner.js";
import { SharedThreadBridge } from "../src/shared-thread-bridge.js";
import {
  connectLocalSharedHost,
  connectLocalSharedExternalHost,
} from "../src/local-shared-host.js";
import { startClientChannelServer } from "../src/client-channel-server.js";
import { runSharedHostService } from "../src/shared-host-service.js";
import { readNativeWorkspaceSnapshot } from "../src/native-workspace-snapshot.js";
import {
  createFixture,
  JsonLineCollector,
  writeRequest,
  stopFixture,
} from "./app-server-host-fixture.js";

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const run of cleanup.splice(0).reverse()) await run();
});

async function setup() {
  const root = mkdtempSync(path.join(tmpdir(), "local-shared-owner-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const store = new MappingStore({ directory: path.join(root, "mapping-store") });
  await store.initialize();
  const owner = new SharedThreadOwner();
  const adapter = new FakeHarnessAdapter(harnessIdSchema.parse("pi"));
  const host = new AppServerHost({
    stockCodexPath: "/unused",
    arguments: [],
    externalOnly: true,
    desktopInput: owner.input,
    desktopOutput: owner.output,
    diagnosticOutput: new PassThrough(),
    mappingStore: store,
    externalAdapters: new Map([["pi", adapter]]),
  });
  const running = host.run();
  cleanup.push(async () => {
    host.close();
    owner.close();
    await running;
    owner.output.end();
  });
  const stop = vi.fn();
  const server = await startClientChannelServer({
    target: host,
    environment: { CODEXHOST_DATA_DIR: root },
    owner: "service",
    externalSession: (streams) => owner.createSession(streams),
    shutdown: { runningTasks: () => new Set(host.runningThreadIds()).size, stop },
    desktopSession: (streams) => owner.createSession(streams),
  });
  cleanup.push(() => server.close());
  const web = new HostClientChannel(path.join(root, "client-hosts"), server.descriptor);
  cleanup.push(() => web.close());
  await web.start();
  function gui() {
    const bridge = new SharedThreadBridge({
      connect: () =>
        connectLocalSharedHost({ launcher: "/unused", runtime: "/unused", dataDirectory: root }),
      delegateCreates: true,
      diagnose: () => undefined,
    });
    const viewer = createFixture({
      sharedThreads: bridge,
      mappingStore: store,
      closeMappingStoreOnExit: false,
      externalAdapters: new Map(),
    });
    const official = new JsonLineCollector(viewer.official.stdin);
    viewer.official.stdin.on("data", () => {
      for (const request of official.messages.splice(0))
        viewer.official.stdout.write(
          JSON.stringify({ id: request.id, result: { data: [], nextCursor: null } }) + "\n",
        );
    });
    cleanup.push(() => stopFixture(viewer));
    return { viewer, bridge };
  }
  return { root, owner, adapter, host, server, web, store, gui, stop };
}

it("SSH and local clients create and resume the same external sessions across separate stores", async () => {
  const { root, web, adapter, store } = await setup();
  const bridge = new SharedThreadBridge({
    connect: () =>
      connectLocalSharedExternalHost({
        launcher: "/unused",
        runtime: "/unused",
        dataDirectory: root,
      }),
    delegateCreates: true,
    diagnose: () => undefined,
  });
  const remote = createFixture({ externalOnly: true, sharedThreads: bridge });
  cleanup.push(() => stopFixture(remote));
  const model = encodeHarnessPluginRoute({ harnessId: harnessIdSchema.parse("pi") });
  const local = await web.request<{ thread: { id: string } }>("thread/start", {
    cwd: "/synthetic",
    model,
  });
  writeRequest(remote.desktopInput, { id: 1, method: "thread/list", params: {} });
  expect(await remote.collector.waitFor((m) => m.id === 1)).toMatchObject({
    result: { data: [{ id: local.thread.id }] },
  });
  writeRequest(remote.desktopInput, {
    id: 2,
    method: "thread/start",
    params: { request: { cwd: "/synthetic", model }, daybreakProgramPropagationEnrolled: false },
  });
  const created = await remote.collector.waitFor((m) => m.id === 2);
  expect(created).toMatchObject({ result: { thread: { modelProvider: "codexhost" } } });
  const id = ((created.result as JsonObject).thread as JsonObject).id as string;
  expect(await web.request("thread/list", {})).toMatchObject({
    data: expect.arrayContaining([expect.objectContaining({ id })]),
  });
  expect((await store.listThreads()).map((t) => t.hostThreadId)).toContain(id);
  expect(await remote.mappingStore.listThreads()).toHaveLength(0);
  writeRequest(remote.desktopInput, {
    id: 3,
    method: "thread/resume",
    params: { threadId: local.thread.id },
  });
  expect(await remote.collector.waitFor((m) => m.id === 3)).toMatchObject({
    result: { thread: { id: local.thread.id } },
  });
  expect(adapter.sessions).toHaveLength(2);
});

it.each(["Web", "Desktop"])(
  "%s may join first; viewers share one execution and one writable store",
  async (first) => {
    const { web, store, adapter, gui, server } = await setup();
    const { viewer, bridge } = gui();
    await viewer.ready;
    await bridge.list({});
    const model = encodeHarnessPluginRoute({ harnessId: harnessIdSchema.parse("pi") });
    let threadId: string;
    if (first === "Web") {
      const result = await web.request<{ thread: { id: string } }>("thread/start", {
        model,
        cwd: "/synthetic",
      });
      threadId = result.thread.id;
    } else {
      writeRequest(viewer.desktopInput, {
        id: 30,
        method: "thread/start",
        params: { model, cwd: "/synthetic" },
      });
      const reply = await viewer.collector.waitFor((message) => message.id === 30);
      expect(reply.error).toBeUndefined();
      threadId = ((reply.result as JsonObject).thread as JsonObject).id as string;
    }
    await web.request("turn/start", {
      threadId,
      input: [{ type: "text", text: "shared input" }],
      clientUserMessageId: "one-input",
    });
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1));
    const session = adapter.sessions[0];
    if (!session) throw new Error("Missing canonical Session");
    session.appendText("still running");
    await viewer.collector.waitFor((message) => message.method === "item/agentMessage/delta");
    expect(await viewer.mappingStore.listThreads()).toEqual(await store.listThreads());
    expect(viewer.mappingStore).toBe(store);
    await expect(web.request("codexhost/private/store", {})).rejects.toThrow("not available");
    // Closing Desktop does not close the canonical Session or terminate its Turn.
    viewer.host.close();
    await viewer.running;
    web.close();
    session.appendText(" after both viewers closed");
    session.succeedTurn();
    const reconnect = new HostClientChannel(path.dirname(server.descriptorPath), server.descriptor);
    cleanup.push(() => reconnect.close());
    await reconnect.start();
    await vi.waitFor(async () =>
      expect(JSON.stringify((await reconnect.snapshot(threadId)).turnsPage)).toContain(
        "after both viewers closed",
      ),
    );
    expect(adapter.sessions).toHaveLength(1);
    expect(await store.listThreads()).toHaveLength(1);
  },
);

it.each([0, 1])("shutdown reports %i running tasks before stopping", async (count) => {
  const { root, web, adapter, stop } = await setup();
  if (count === 1) {
    const { thread } = await web.request<{ thread: { id: string } }>("thread/start", {
      model: encodeHarnessPluginRoute({ harnessId: harnessIdSchema.parse("pi") }),
      cwd: root,
    });
    await web.request("turn/start", {
      threadId: thread.id,
      input: [{ type: "text", text: "running task" }],
    });
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1));
  }
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    expect(await runSharedHostService(["--data", root, "--stop"], {}, import.meta.url)).toBe(0);
    expect(stdout).toHaveBeenCalledWith(
      `Shared Host stopped; interrupted ${count} running task(s)\n`,
    );
    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
  } finally {
    stdout.mockRestore();
  }
});

it("prints only stopped for an old Host response without a task count", async () => {
  const { root } = await setup();
  const fetch = globalThis.fetch;
  const request = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    if (String(input).endsWith("/v1/shutdown"))
      return Promise.resolve(Response.json({ result: { stopping: true } }));
    return fetch(input, init);
  });
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    expect(await runSharedHostService(["--data", root, "--stop"], {}, import.meta.url)).toBe(0);
    expect(stdout).toHaveBeenCalledWith("Shared Host stopped\n");
  } finally {
    request.mockRestore();
    stdout.mockRestore();
  }
});

it("reads projects and pins with no Desktop and never rewrites native metadata", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "workspace-snapshot-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const environment = { CODEX_HOME: root };
  expect(await readNativeWorkspaceSnapshot(environment)).toEqual({
    projects: [],
    assignments: {},
    projectless: [],
    pinned: [],
  });
  mkdirSync(root, { recursive: true });
  const file = path.join(root, ".codex-global-state.json");
  const text = JSON.stringify({
    "project-order": ["selected"],
    "local-projects": {
      a: { id: "selected", name: "Project", rootPaths: ["/real/project"] },
      b: { id: "hidden", name: "Hidden", rootPaths: ["/other"] },
    },
    "thread-project-assignments": {
      thread: { projectKind: "local", projectId: "selected" },
      remote: { projectKind: "remote", projectId: "remote" },
    },
    "projectless-thread-ids": ["unselected"],
    "pinned-thread-ids": ["thread"],
    privateData: "must not be projected",
  });
  writeFileSync(file, text);
  expect(await readNativeWorkspaceSnapshot(environment)).toEqual({
    projects: [{ id: "selected", name: "Project", rootPaths: ["/real/project"] }],
    assignments: { thread: "selected" },
    projectless: ["unselected"],
    pinned: [],
  });
  expect(readFileSync(file, "utf8")).toBe(text);
  for (const invalid of ["{bad", "[]", "null", '"wrong"', '{"project-order":[123]}']) {
    writeFileSync(file, invalid);
    await expect(readNativeWorkspaceSnapshot(environment)).rejects.toThrow();
  }
});

it("routes the SSH delegation API to the shared owner without native fallback", async () => {
  const { root, web, adapter } = await setup();
  const bridge = new SharedThreadBridge({
    connect: () =>
      connectLocalSharedExternalHost({
        launcher: "/unused",
        runtime: "/unused",
        dataDirectory: root,
      }),
    delegateCreates: true,
    diagnose: () => undefined,
  });
  const captured: { api?: DelegationControlRegistration } = {};
  const remote = createFixture({
    externalOnly: true,
    sharedThreads: bridge,
    onDelegationApi: (api) => {
      captured.api = api;
    },
  });
  cleanup.push(() => stopFixture(remote));
  const official = new JsonLineCollector(remote.official.stdin);
  remote.official.stdin.on("data", () => {
    for (const request of official.messages.splice(0))
      remote.official.stdout.write(
        JSON.stringify({
          id: request.id,
          error: { code: -32600, message: "not a native Thread" },
        }) + "\n",
      );
  });
  const started = await web.request<{ thread: { id: string } }>("thread/start", {
    cwd: "/synthetic",
    model: encodeHarnessPluginRoute({ harnessId: harnessIdSchema.parse("pi") }),
  });
  if (!captured.api) throw new Error("Missing delegation registration");
  const snapshot = await captured.api.read({ threadId: started.thread.id, view: "messages" });
  expect(snapshot).toMatchObject({ threadId: started.thread.id, harnessId: "pi" });
  const sent = await captured.api.send({ threadId: started.thread.id, message: "continue" });
  expect(sent.harnessId).toBe("pi");
  await expect(
    captured.api.send({ threadId: started.thread.id, message: "duplicate" }),
  ).rejects.toMatchObject({ code: "THREAD_BUSY" });
  const session = adapter.sessions[0];
  if (!session) throw new Error("Missing shared Session");
  session.appendText("shared answer");
  session.succeedTurn();
  expect(
    await captured.api.wait({ threadId: started.thread.id, view: "messages", timeoutMs: 1000 }),
  ).toMatchObject({ harnessId: "pi", timedOut: false });
  const child = await captured.api.start({
    harnessId: "pi",
    parentThreadId: started.thread.id,
    task: "child task",
    cwd: "/synthetic",
  });
  expect(child.harnessId).toBe("pi");
  expect(
    await captured.api.list({ parentThreadId: started.thread.id, sort: "created-asc", limit: 10 }),
  ).toMatchObject({ threads: [{ threadId: child.threadId }] });
  const childSession = adapter.sessions[1];
  if (!childSession) throw new Error("Missing shared child");
  childSession.completeCancellationOnRequest();
  expect(await captured.api.cancel({ threadId: child.threadId })).toMatchObject({
    cancelled: true,
  });
  expect(await remote.mappingStore.listThreads()).toHaveLength(0);
  bridge.close();
  await expect(
    captured.api.read({ threadId: started.thread.id, view: "messages" }),
  ).rejects.toThrow("disconnected");
});
