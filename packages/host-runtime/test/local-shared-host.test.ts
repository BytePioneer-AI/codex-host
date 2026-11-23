import type { DelegationControlRegistration } from "../src/delegation-types.js";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { FakeHarnessAdapter } from "@codexhost/harness-adapter/testing";
import { MappingStore } from "@codexhost/mapping-store";
import { HostClientChannel } from "@codexhost/desktop-control";
import {
  CONSOLE_OPEN_METHOD,
  HOST_EXTENSIONS_RPC,
  encodeHarnessPluginRoute,
  harnessIdSchema,
  hostThreadIdSchema,
  THREAD_TREE_WATCH_METHOD,
  THREAD_TREE_SNAPSHOT_METHOD,
  threadTreeWatchResultSchema,
} from "@codexhost/shared-contracts";
import { OfficialRuntimeClient } from "../src/codex-runtime/official-runtime-scope.js";
import { PINNED_THREAD_SECTION_ID } from "../src/external-thread-pins.js";
import type { JsonObject } from "@codexhost/protocol-core";
import { AppServerHost } from "../src/app-server-host.js";
import { SharedThreadOwner } from "../src/shared-thread-owner.js";
import { SharedThreadBridge } from "../src/shared-thread-bridge.js";
import {
  connectLocalSharedHost,
  connectLocalSharedExternalHost,
  runLocalDesktopBridge,
} from "../src/local-shared-host.js";
import {
  CODEX_RUNTIME_REMOVED_MESSAGE,
  CodexRuntimeFilesRemovedError,
} from "../src/codex-runtime/backend-files.js";
import { startClientChannelServer } from "../src/client-channel-server.js";
import { runSharedHostService } from "../src/shared-host-service.js";
import { sharedHostDesktop } from "../src/shared-host-desktop.js";
import { prepareLocalCodex } from "../src/native-account-host.js";
import { ModelPriceCatalog } from "../src/model-prices.js";
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

async function setup(
  desktopSession?: Parameters<typeof startClientChannelServer>[0]["desktopSession"],
  environment: NodeJS.ProcessEnv = {},
) {
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
    environment: {
      HOME: root,
      CODEX_HOME: path.join(root, ".codex"),
      CODEXHOST_DATA_DIR: root,
      ...environment,
    },
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
    desktopSession: desktopSession ?? ((streams) => owner.createSession(streams)),
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

it("lists Host extensions through the local shared Host client channel", async () => {
  const { web } = await setup();
  await expect(web.request(HOST_EXTENSIONS_RPC.list, {})).resolves.toMatchObject({
    configuration: { revision: 0, enabled: [] },
    extensions: [],
  });
});

it("rejects extension management through the SSH-managed shared Host client channel", async () => {
  const { web } = await setup(undefined, { CODEXHOST_REMOTE_SSH_MANAGED: "1" });
  await expect(web.request(HOST_EXTENSIONS_RPC.list, {})).rejects.toMatchObject({
    code: -32601,
    message: "Extension management is only available on the local Host",
  });
});

it("keeps unlisted Desktop methods unavailable on the shared Host", async () => {
  const { owner } = await setup();
  const desktop = owner.connect();
  cleanup.push(() => desktop.close());
  for (const method of [CONSOLE_OPEN_METHOD, "codexhost/extensions/unknown"]) {
    await expect(desktop.request(method, {})).resolves.toMatchObject({
      error: { code: -32601, message: "Method is unavailable on the shared Thread service" },
    });
  }
});

it("returns an actionable failure when authenticated Desktop admission finds a removed runtime", async () => {
  const register = vi.fn();
  const connected = new Set<AppServerHost>();
  const running = new Set<Promise<number>>();
  const f = await setup((streams, request) => {
    expect(request.headers["x-codexhost-desktop-context"]).toBeTypeOf("string");
    return sharedHostDesktop(
      {
        environment: { CODEXHOST_DATA_DIR: f.root },
        runtimeUrl: import.meta.url,
        stockCodex: path.join(f.root, "codex.exe"),
        official,
        owner: f.owner,
        store: f.store,
        prices: new ModelPriceCatalog({
          directory: path.join(f.root, "prices"),
          diagnose: () => {},
        }),
        delegation: () => undefined,
        register,
        connected,
        running,
      },
      streams,
      request,
    );
  });
  const official = await prepareLocalCodex({
    stockCodexPath: path.join(f.root, "codex.exe"),
    arguments: ["app-server"],
    environment: { CODEX_HOME: path.join(f.root, "native-home"), CODEXHOST_DATA_DIR: f.root },
    diagnosticOutput: new PassThrough(),
    deferStart: true,
  });
  vi.spyOn(official, "configureStartup").mockRejectedValue(new CodexRuntimeFilesRemovedError());
  const stdin = vi.spyOn(process.stdin, "pipe").mockImplementation((destination) => destination);
  const pause = vi.spyOn(process.stdin, "pause");
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    const result = await runLocalDesktopBridge(
      {
        CODEXHOST_LAUNCHER_EXECUTABLE: path.join(f.root, "unused-launcher"),
        CODEXHOST_DATA_DIR: f.root,
      },
      path.join(f.root, "unused-runtime.mjs"),
      path.join(f.root, "codex.exe"),
      ["app-server"],
    );
    expect(result).toBe(1);
    expect(pause).toHaveBeenCalled();
    expect(stderr.mock.calls.map(([message]) => String(message)).join("")).toContain(
      CODEX_RUNTIME_REMOVED_MESSAGE,
    );
    expect(f.stop).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
    expect(connected.size).toBe(0);
    expect(running.size).toBe(0);
    await expect(f.web.request("thread/list", {})).resolves.toMatchObject({ data: [] });
  } finally {
    stdin.mockRestore();
    pause.mockRestore();
    stderr.mockRestore();
    await official.close();
  }
});

it.each([true, false])("forwards current Desktop browser access (%s)", async (enabled) => {
  const pipe = path.join(tmpdir(), "codex-app-tools-synthetic.sock");
  const browserAccess = {
    BROWSER_USE_ACCESS_EXECUTOR_ID: "synthetic-executor",
    BROWSER_USE_ACCESS_PIPE_PATH: path.join(tmpdir(), "browser-access-synthetic.sock"),
    BROWSER_USE_ACCESS_VERIFYING_IDENTITY: "synthetic-verifying-identity",
    CODEXHOST_DESKTOP_BROWSER_MCP_ARGUMENTS: "[]",
  };
  const f = await setup((streams, request) =>
    sharedHostDesktop(
      {
        environment: {
          CODEXHOST_DATA_DIR: f.root,
          ...Object.fromEntries(
            Object.keys(browserAccess).map((key) => [key, "stale-service-value"]),
          ),
        },
        runtimeUrl: import.meta.url,
        stockCodex: path.join(f.root, "codex.exe"),
        official,
        owner: f.owner,
        store: f.store,
        prices: new ModelPriceCatalog({
          directory: path.join(f.root, "prices"),
          diagnose: () => {},
        }),
        delegation: () => undefined,
        register: () => undefined,
        connected: new Set<AppServerHost>(),
        running: new Set<Promise<number>>(),
      },
      streams,
      request,
    ),
  );
  const official = await prepareLocalCodex({
    stockCodexPath: path.join(f.root, "codex.exe"),
    arguments: ["app-server"],
    environment: { CODEX_HOME: path.join(f.root, "native-home"), CODEXHOST_DATA_DIR: f.root },
    diagnosticOutput: new PassThrough(),
    deferStart: true,
  });
  const configured: NodeJS.ProcessEnv[] = [];
  vi.spyOn(official, "configureStartup").mockImplementation(async ({ environment }) => {
    configured.push(environment);
    // Stop after admission; only the forwarded startup environment matters here.
    throw new CodexRuntimeFilesRemovedError();
  });
  const stdin = vi.spyOn(process.stdin, "pipe").mockImplementation((destination) => destination);
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    await runLocalDesktopBridge(
      {
        CODEXHOST_LAUNCHER_EXECUTABLE: path.join(f.root, "unused-launcher"),
        CODEXHOST_DATA_DIR: f.root,
        CODEX_APP_TOOLS_PIPE_PATH: pipe,
        ...(enabled ? browserAccess : {}),
        BROWSER_USE_ACCESS_UNRELATED: "must-not-cross",
        NODE_OPTIONS: "must-not-cross",
        UNRELATED_DESKTOP_SECRET: "must-not-cross",
      },
      path.join(f.root, "unused-runtime.mjs"),
      path.join(f.root, "codex.exe"),
      ["app-server"],
    );
    expect(configured).toHaveLength(1);
    expect(configured[0]?.CODEX_APP_TOOLS_PIPE_PATH).toBe(pipe);
    for (const [key, value] of Object.entries(browserAccess)) {
      if (enabled) expect(configured[0]?.[key]).toBe(value);
      else expect(configured[0]).not.toHaveProperty(key);
    }
    expect(configured[0]).not.toHaveProperty("BROWSER_USE_ACCESS_UNRELATED");
    expect(configured[0]).not.toHaveProperty("NODE_OPTIONS");
    expect(configured[0]).not.toHaveProperty("UNRELATED_DESKTOP_SECRET");
  } finally {
    stdin.mockRestore();
    stderr.mockRestore();
    await official.close();
  }
});

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

it("projects the shared owner's Turn state without forwarding owner subscription IDs", async () => {
  const { web, adapter, store, gui } = await setup();
  const { viewer, bridge } = gui();
  await viewer.ready;
  const native = vi
    .spyOn(OfficialRuntimeClient.prototype, "request")
    .mockImplementation(async (method, params): Promise<JsonObject> => {
      if (method === "threadSection/list")
        return {
          result: {
            data: [{ id: PINNED_THREAD_SECTION_ID, name: "Pinned", appearance: null }],
            nextCursor: null,
          },
        };
      if (method === "thread/read") {
        if (typeof params.threadId !== "string") throw new Error("Missing native Thread ID");
        return { result: { thread: { id: params.threadId, status: { type: "notLoaded" } } } };
      }
      return { result: { data: [], nextCursor: null } };
    });
  try {
    const { thread } = await web.request<{ thread: { id: string } }>("thread/start", {
      model: encodeHarnessPluginRoute({ harnessId: harnessIdSchema.parse("pi") }),
      cwd: "/synthetic",
    });
    const child = hostThreadIdSchema.parse(thread.id);
    await store.createDelegation({
      delegationId: hostThreadIdSchema.parse("delegated"),
      parentHostThreadId: hostThreadIdSchema.parse("native-parent"),
      childHostThreadId: child,
      taskDigest: "a".repeat(64),
      sourceHarnessId: harnessIdSchema.parse("codex"),
      targetHarnessId: harnessIdSchema.parse("pi"),
    });
    writeRequest(viewer.desktopInput, { id: 99, method: THREAD_TREE_WATCH_METHOD, params: {} });
    const { subscriptionId, snapshot } = threadTreeWatchResultSchema.parse(
      (await viewer.collector.waitFor((m) => m.id === 99)).result,
    );
    let revision = snapshot.revision;
    const next = async (status: string) => {
      const msg = await viewer.collector.waitFor((m) => {
        if (m.method !== THREAD_TREE_SNAPSHOT_METHOD) return false;
        const result = threadTreeWatchResultSchema.parse(m.params);
        return (
          result.subscriptionId === subscriptionId &&
          result.snapshot.revision > revision &&
          result.snapshot.nodes[child]?.status === status
        );
      }, 1000);
      revision = threadTreeWatchResultSchema.parse(msg.params).snapshot.revision;
    };
    await web.request("turn/start", {
      threadId: child,
      input: [{ type: "text", text: "A shared Turn" }],
    });
    await next("running");
    const session = adapter.sessions[0];
    if (!session) throw new Error("Missing shared Session");
    session.succeedTurn();
    await next("idle");
    bridge.close();
    await next("unknown");
    expect(
      viewer.collector.messages
        .filter((m) => m.method === THREAD_TREE_SNAPSHOT_METHOD)
        .map((m) => threadTreeWatchResultSchema.parse(m.params).subscriptionId),
    ).toEqual(expect.arrayContaining([subscriptionId]));
    expect(
      new Set(
        viewer.collector.messages
          .filter((m) => m.method === THREAD_TREE_SNAPSHOT_METHOD)
          .map((m) => threadTreeWatchResultSchema.parse(m.params).subscriptionId),
      ),
    ).toEqual(new Set([subscriptionId]));
  } finally {
    native.mockRestore();
  }
});

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
  const selected = { id: "selected", name: "Project", rootPaths: ["/real/project"] };
  const first = { id: "first", name: "First", rootPaths: ["/first"] };
  const hidden = { id: "hidden", name: "Hidden", rootPaths: ["/other"] };
  const foreign = { id: "foreign", name: "Foreign", rootPaths: ["/foreign"] };
  const state = {
    "project-order": ["remote-project", "first", "selected", "first"],
    "local-projects": { a: selected, b: hidden, c: first, duplicate: hidden, foreign },
    "thread-project-assignments": {
      thread: { projectKind: "local", projectId: "selected" },
      remote: { projectKind: "remote", projectId: "remote" },
    },
    "projectless-thread-ids": ["unselected"],
    "pinned-thread-ids": ["thread"],
    privateData: "must not be projected",
  };
  const text = JSON.stringify(state);
  writeFileSync(file, text);
  expect(await readNativeWorkspaceSnapshot(environment)).toEqual({
    projects: [first, selected],
    assignments: { thread: "selected" },
    projectless: ["unselected"],
    pinned: [],
  });
  expect(readFileSync(file, "utf8")).toBe(text);
  // Desktop keeps project members of custom sections only in the signed-in owner's atoms.
  const sections = (entries: unknown) => ({
    "sidebar-custom-sections-v3": {
      account: { sections: entries, collapsedSectionIds: [], sectionOrder: [] },
    },
  });
  const sectioned = {
    ...state,
    "electron-renderer-content-owner": "owner",
    "electron-owner-atoms:previous-owner": sections([
      { id: "old", name: "Old", hostSectionIds: { local: "stale" }, itemKeys: ["codex:project:a"] },
    ]),
    "electron-owner-atoms:owner": sections([
      {
        id: "papers",
        name: "Papers",
        hostSectionIds: { local: "official-papers" },
        itemKeys: [
          "codex:project:selected",
          "codex:thread:local:thread",
          "chatgpt:project:g-p-cloud",
          "codex:project:first",
        ],
      },
      {
        id: "remote",
        name: "Remote",
        hostSectionIds: { "remote-control:env": "remote-section" },
        itemKeys: ["codex:project:hidden"],
      },
      {
        id: "threads",
        name: "Threads",
        hostSectionIds: { local: "official-threads" },
        itemKeys: ["codex:thread:local:thread"],
      },
    ]),
  };
  writeFileSync(file, JSON.stringify(sectioned));
  expect((await readNativeWorkspaceSnapshot(environment)).sectionProjects).toEqual({
    "official-papers": ["selected", "first"],
  });
  writeFileSync(
    file,
    JSON.stringify({ ...sectioned, "electron-owner-atoms:owner": sections("reshaped") }),
  );
  expect(await readNativeWorkspaceSnapshot(environment)).toEqual({
    projects: [first, selected],
    assignments: { thread: "selected" },
    projectless: ["unselected"],
    pinned: [],
  });
  const migrated = {
    ...state,
    "app-server-project-id-by-legacy-project-id-by-host": {
      [`local:${path.resolve(root)}`]: { hidden: "native-hidden", first: "native-first" },
      "remote-ssh:other": { foreign: "native-foreign" },
    },
  };
  writeFileSync(file, JSON.stringify(migrated));
  expect((await readNativeWorkspaceSnapshot(environment)).projects).toEqual([
    first,
    selected,
    hidden,
  ]);
  for (const key of ["a", "duplicate"] as const) {
    writeFileSync(
      file,
      JSON.stringify({
        ...migrated,
        "local-projects": {
          ...state["local-projects"],
          [key]: { ...state["local-projects"][key], rootPaths: [123] },
        },
      }),
    );
    await expect(readNativeWorkspaceSnapshot(environment)).rejects.toThrow(/rootPaths/u);
  }
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
