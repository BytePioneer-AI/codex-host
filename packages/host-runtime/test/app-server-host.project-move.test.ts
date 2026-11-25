import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { MappingStore } from "@codexhost/mapping-store";
import type { JsonObject } from "@codexhost/protocol-core";
import { clientWorkspaceSnapshotSchema, hostThreadIdSchema } from "@codexhost/shared-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createOwnedConnectionBackend,
  OfficialRuntimeScope,
} from "../src/codex-runtime/official-runtime-scope.js";
import { PINNED_THREAD_SECTION_ID } from "../src/external-thread-pins.js";
import {
  createFixture,
  JsonLineCollector,
  startExternalThread,
  stopFixture,
  writeRequest,
} from "./app-server-host-fixture.js";

const MOVE = "codexhost/workspace/moveThreadToProject";
const NATIVE_THREAD = "01984de2-8f74-7c91-a3b2-5c5e937cf319";
const GUI_PROJECT = "gui-destination";
const NATIVE_PROJECT = "native-destination";
const OLD_GUI_PROJECT = "gui-original";
const OLD_NATIVE_PROJECT = "native-original";
const SECTION = { id: "research", name: "Research", appearance: null };
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function setup(
  options: {
    thread?: JsonObject;
    write?: "apply" | "stale" | "malformed-readback" | "rejected" | "ambiguous";
    projectId?: string;
    listMembership?: "archived" | "sectionId";
    archivedPages?: number;
    desktop?: boolean;
    nativeProjects?: boolean;
    beforeReplace?: ConstructorParameters<typeof MappingStore>[0]["beforeReplace"];
    remote?: boolean;
  } = {},
) {
  const home = await mkdtemp(path.join(tmpdir(), "ch-project-move-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const stateFile = path.join(home, ".codex-global-state.json");
  const cwd = path.join(home, "working-tree");
  const originalState = JSON.stringify({
    "project-order": [OLD_GUI_PROJECT, GUI_PROJECT],
    "local-projects": {
      [OLD_GUI_PROJECT]: { id: OLD_GUI_PROJECT, name: "Original", rootPaths: [cwd] },
      [GUI_PROJECT]: {
        id: GUI_PROJECT,
        name: "Destination",
        rootPaths: [path.join(home, "other")],
      },
    },
    "app-server-project-id-by-legacy-project-id-by-host": {
      [`local:${path.resolve(home)}`]: {
        [GUI_PROJECT]: NATIVE_PROJECT,
        [OLD_GUI_PROJECT]: OLD_NATIVE_PROJECT,
      },
      "local:another-home": { [GUI_PROJECT]: "wrong-scope-project" },
    },
    "thread-project-assignments": {
      [NATIVE_THREAD]: { projectKind: "local", projectId: OLD_GUI_PROJECT },
    },
  });
  await writeFile(stateFile, originalState);
  const mappingStoreDirectory = path.join(home, "store");
  const mappingStore = new MappingStore({
    directory: mappingStoreDirectory,
    ...(options.beforeReplace ? { beforeReplace: options.beforeReplace } : {}),
  });
  await mappingStore.initialize();
  const requests: JsonObject[] = [];
  const thread: JsonObject = {
    id: NATIVE_THREAD,
    cwd,
    projectId: OLD_NATIVE_PROJECT,
    archived: false,
    section: SECTION,
    ...options.thread,
  };
  let nativeOutput: PassThrough | undefined;
  function notify(method: string, params: JsonObject) {
    if (!nativeOutput) throw new Error("Native app-server is not connected");
    writeRequest(nativeOutput, { method, params });
  }
  const pauses = new Map<string, (reply: () => void) => void>();
  function pauseNext(method: string) {
    const reached = Promise.withResolvers<() => void>();
    pauses.set(method, reached.resolve);
    return reached.promise;
  }
  function response(request: JsonObject): JsonObject {
    const params = (request.params ?? {}) as JsonObject;
    const projectId = params.projectId ?? null;
    switch (request.method) {
      case "project/list":
        return options.nativeProjects
          ? {
              result: {
                data: [OLD_NATIVE_PROJECT, NATIVE_PROJECT].map((id) => ({
                  id,
                  name: id,
                  roots: [{ path: cwd }],
                })),
                nextCursor: null,
              },
            }
          : { error: { code: -32601, message: "Method unavailable" } };
      case "project/read":
        return { result: { project: { id: options.projectId ?? projectId } } };
      case "thread/read":
        if (params.threadId === "unreadable")
          return { error: { code: -32093, message: "Read unavailable" } };
        return options.write === "malformed-readback" && nativeWrites({ requests }).length > 0
          ? { result: { thread: { ...thread, id: "unexpected-thread" } } }
          : { result: { thread } };
      case "thread/metadata/update":
        if (options.write === "rejected")
          return { error: { code: -32602, message: "Native project move rejected" } };
        if (options.write !== "stale") thread.projectId = projectId;
        return options.write === "ambiguous"
          ? { error: { code: -32093, message: "Native write outcome unavailable" } }
          : { result: { thread: { ...thread, projectId } } };
      case "threadSection/list":
        return { result: { data: [SECTION], nextCursor: null } };
      case "thread/list":
        if (params.archived === true && options.archivedPages !== undefined) {
          const page = Number(params.cursor ?? 0);
          return {
            result: {
              data: Array.from({ length: 100 }, (_, i) => ({ id: `archive-${page}-${i}` })),
              nextCursor: page + 1 < options.archivedPages ? String(page + 1) : null,
              backwardsCursor: null,
            },
          };
        }
        return {
          result: {
            data:
              (options.listMembership === "archived" && params.archived === true) ||
              (options.listMembership === "sectionId" &&
                params.sectionId === PINNED_THREAD_SECTION_ID)
                ? [thread]
                : [],
            nextCursor: null,
            backwardsCursor: null,
          },
        };
      default:
        return { result: {} };
    }
  }
  const scope = new OfficialRuntimeScope({
    permanentHome: home,
    diagnosticOutput: new PassThrough(),
    createBackend: () =>
      createOwnedConnectionBackend(() => {
        const stdin = new PassThrough();
        const stdout = new PassThrough();
        nativeOutput = stdout;
        const stderr = new PassThrough();
        const closed = Promise.withResolvers<{ code: number; signal: null }>();
        const collector = new JsonLineCollector(stdin);
        stdin.on("data", () => {
          for (const request of collector.messages.splice(0)) {
            if (request.id === undefined || typeof request.method !== "string") continue;
            requests.push(request);
            const reply = { id: request.id, ...response(request) };
            const send = () => writeRequest(stdout, reply);
            const pause = pauses.get(request.method);
            if (pause) {
              pauses.delete(request.method);
              pause(send);
            } else send();
          }
        });
        return {
          stdin,
          stdout,
          stderr,
          closed: closed.promise,
          close() {
            stdin.end();
            stdout.end();
            stderr.end();
            closed.resolve({ code: 0, signal: null });
          },
        };
      }),
  });
  cleanup.push(() => scope.close());
  const fixture = createFixture({
    externalOnly: !options.desktop,
    localProjectMoves: !options.remote,
    environment: { CODEX_HOME: home },
    mappingStore,
    mappingStoreDirectory,
    officialRuntimeScope: scope,
  });
  cleanup.push(() => stopFixture(fixture));
  if (options.desktop) {
    writeRequest(fixture.desktopInput, {
      id: 0,
      method: "initialize",
      params: { clientInfo: { name: "fixture", version: "1" } },
    });
    await fixture.collector.waitFor(({ id }) => id === 0);
  } else {
    // Attach the native app-server without warming the workspace assignment cache.
    await fixture.host.handleClientRequest("codexhost/workspace/read", {
      threadIds: ["attach-native"],
    });
  }
  await fixture.ready;
  return {
    fixture,
    cwd,
    stateFile,
    originalState,
    requests,
    thread,
    scope,
    pauseNext,
    notify,
    mappingStore,
    home,
  };
}

type Setup = Awaited<ReturnType<typeof setup>>;

function move({ fixture }: Setup, threadId: string, projectId = GUI_PROJECT) {
  return fixture.host.handleClientRequest(MOVE, { threadId, projectId });
}

function nativeWrites({ requests }: Pick<Setup, "requests">) {
  return requests.filter(({ method }) => method === "thread/metadata/update");
}

async function workspace({ fixture }: Setup, threadIds: string[] = [], nativeProjects = false) {
  const response = await fixture.host.handleClientRequest("codexhost/workspace/read", {
    threadIds,
    nativeProjects,
  });
  if (!("result" in response)) throw new Error(response.error.message);
  return clientWorkspaceSnapshotSchema.parse(response.result);
}

async function startExternal({ fixture, cwd }: Setup) {
  return hostThreadIdSchema.parse(
    await startExternalThread(fixture, "codexhost/pi-native", 1, { cwd }),
  );
}

const confirmed = { result: { status: "confirmed", projectId: GUI_PROJECT } };

describe("Host client project move", () => {
  it("moves between native catalog projects without Desktop registrations", async () => {
    const context = await setup({ nativeProjects: true });
    await rm(context.stateFile);
    const initial = await workspace(context, [NATIVE_THREAD], true);
    expect(initial.projectMoveBindings).toEqual({
      projectIds: [OLD_NATIVE_PROJECT, NATIVE_PROJECT],
      assignments: { [NATIVE_THREAD]: OLD_NATIVE_PROJECT },
    });
    await expect(move(context, NATIVE_THREAD, NATIVE_PROJECT)).resolves.toEqual({
      result: { status: "confirmed", projectId: NATIVE_PROJECT },
    });
    expect((await workspace(context, [NATIVE_THREAD], true)).assignments[NATIVE_THREAD]).toBe(
      NATIVE_PROJECT,
    );
  });

  it("moves the official Thread using scoped native IDs and confirms from a separate read", async () => {
    const context = await setup();
    await expect(move(context, NATIVE_THREAD)).resolves.toEqual(confirmed);
    expect(context.requests).toContainEqual(
      expect.objectContaining({ method: "project/read", params: { projectId: NATIVE_PROJECT } }),
    );
    expect(nativeWrites(context)).toEqual([
      expect.objectContaining({ params: { threadId: NATIVE_THREAD, projectId: NATIVE_PROJECT } }),
    ]);
    const writeIndex = context.requests.findIndex(
      ({ method }) => method === "thread/metadata/update",
    );
    for (const requests of [
      context.requests.slice(0, writeIndex),
      context.requests.slice(writeIndex + 1),
    ]) {
      expect(requests).toContainEqual(expect.objectContaining({ method: "thread/read" }));
    }
    expect(context.thread).toMatchObject({
      projectId: NATIVE_PROJECT,
      cwd: context.cwd,
      section: SECTION,
    });
    expect(await context.fixture.mappingStore.listThreads()).toEqual([]);
    expect(await readFile(context.stateFile, "utf8")).toBe(context.originalState);
    expect((await workspace(context, [NATIVE_THREAD])).assignments[NATIVE_THREAD]).toBe(
      GUI_PROJECT,
    );
  });

  it("reuses confirmed native identities until the owner changes", async () => {
    const context = await setup();
    const read = () => workspace(context, [NATIVE_THREAD]);
    const first = await read();
    const count = () =>
      context.requests.filter(
        ({ method, params }) =>
          method === "thread/read" && (params as JsonObject).threadId === NATIVE_THREAD,
      ).length;
    expect(first.projectMoveBindings?.assignments[NATIVE_THREAD]).toBe(OLD_GUI_PROJECT);
    const reads = count();
    await expect(read()).resolves.toEqual(first);
    const repeatedReads = count() - reads;
    await context.scope.stop();
    context.thread.projectId = null;
    await context.scope.start();
    expect((await read()).projectMoveBindings?.assignments[NATIVE_THREAD]).toBeNull();
    expect(count()).toBe(reads + repeatedReads + 1);
    expect(repeatedReads).toBe(0);
  });

  it("invalidates a native identity when another client moves the Thread", async () => {
    const context = await setup();
    const { fixture } = context;
    expect((await workspace(context, [NATIVE_THREAD])).assignments[NATIVE_THREAD]).toBe(
      OLD_GUI_PROJECT,
    );
    const notified = Promise.withResolvers<undefined>();
    const unsubscribe = fixture.host.clientEvents.subscribe((event) => {
      if (event.type === "changed" && event.method === "thread/project/updated")
        notified.resolve(undefined);
    });
    try {
      context.thread.projectId = NATIVE_PROJECT;
      context.notify("thread/project/updated", {
        threadId: NATIVE_THREAD,
        projectId: NATIVE_PROJECT,
      });
      await notified.promise;
      expect((await workspace(context, [NATIVE_THREAD])).assignments[NATIVE_THREAD]).toBe(
        GUI_PROJECT,
      );
    } finally {
      unsubscribe();
    }
  });

  it("does not write if the official Thread is already in the destination", async () => {
    const context = await setup({ thread: { projectId: NATIVE_PROJECT } });
    await expect(move(context, NATIVE_THREAD)).resolves.toEqual(confirmed);
    expect(nativeWrites(context)).toEqual([]);
  });

  it("does not transfer a target validation or queued move to a replacement owner", async () => {
    const context = await setup();
    const target = context.pauseNext("project/read");
    const first = move(context, NATIVE_THREAD);
    const reply = await target;
    const queued = move(context, NATIVE_THREAD);
    reply();
    await context.scope.stop();
    await context.scope.start();
    for (const outcome of await Promise.all([first, queued]))
      expect(outcome).toHaveProperty("error");
    expect(nativeWrites(context)).toEqual([]);
    expect(context.thread.projectId).toBe(OLD_NATIVE_PROJECT);
  });

  it.each(["write", "readback"] as const)(
    "cannot confirm a late %s reply from the retired owner",
    async (stage) => {
      const context = await setup();
      const written = context.pauseNext("thread/metadata/update");
      const moving = move(context, NATIVE_THREAD);
      let late = await written;
      if (stage === "readback") {
        const reading = context.pauseNext("thread/read");
        late();
        late = await reading;
      }
      // Deliver a matching reply but retire its owner before the reader consumes it.
      late();
      await context.scope.stop();
      await context.scope.start();
      await expect(moving).resolves.toEqual({ result: { status: "unknown" } });
      expect(nativeWrites(context)).toHaveLength(1);
    },
  );

  it.each(["stale", "malformed-readback"] as const)(
    "returns unknown on %s after a claimed write success, without resending",
    async (write) => {
      const context = await setup({ write });
      await expect(move(context, NATIVE_THREAD)).resolves.toEqual({
        result: { status: "unknown" },
      });
      const writeIndex = context.requests.findIndex(
        ({ method }) => method === "thread/metadata/update",
      );
      expect(context.requests.slice(writeIndex + 1)).toContainEqual(
        expect.objectContaining({ method: "thread/read" }),
      );
      expect(nativeWrites(context)).toHaveLength(1);
    },
  );

  it("confirms an ambiguous native write only by reading it back, without resending", async () => {
    const context = await setup({ write: "ambiguous" });
    await expect(move(context, NATIVE_THREAD)).resolves.toEqual(confirmed);
    expect(nativeWrites(context)).toHaveLength(1);
  });

  it("preserves an explicit native rejection as an RPC error", async () => {
    const context = await setup({ write: "rejected" });
    await expect(move(context, NATIVE_THREAD)).resolves.toMatchObject({ error: { code: -32602 } });
    expect(nativeWrites(context)).toHaveLength(1);
    expect(context.thread.projectId).toBe(OLD_NATIVE_PROJECT);
  });

  it.each([
    ["archived", { archived: true }],
    ["pinned", { section: { id: PINNED_THREAD_SECTION_ID } }],
    ["child", { parentThreadId: "parent-thread" }],
    ["subagent", { source: { subAgent: { threadSpawn: { parentThreadId: "parent-thread" } } } }],
    ["read-only child", { canAcceptDirectInput: false }],
    ["string subagent", { source: "subAgentReview" }],
    ["ephemeral", { ephemeral: true }],
    ["unknown source project", { projectId: "unregistered" }],
  ] satisfies [string, JsonObject][])(
    "rejects a %s official Thread before writing",
    async (_name, thread) => {
      const context = await setup({ thread });
      await expect(move(context, NATIVE_THREAD)).resolves.toHaveProperty("error");
      expect(nativeWrites(context)).toEqual([]);
    },
  );

  it.each([
    ["archived", "archived"],
    ["section", "sectionId"],
  ] as const)("checks native membership when thread/read omits %s", async (field, filter) => {
    const context = await setup({ listMembership: filter });
    if (field === "archived") delete context.thread.archived;
    else delete context.thread.section;
    await expect(move(context, NATIVE_THREAD)).resolves.toHaveProperty("error");
    expect(context.requests).toContainEqual(
      expect.objectContaining({
        method: "thread/list",
        params: expect.objectContaining({
          [filter]: filter === "archived" ? true : PINNED_THREAD_SECTION_ID,
        }),
      }),
    );
    expect(nativeWrites(context)).toEqual([]);
  });

  it("checks the end of an archive catalog with more than 1000 Threads", async () => {
    const context = await setup({ archivedPages: 11 });
    delete context.thread.archived;
    await expect(move(context, NATIVE_THREAD)).resolves.toEqual(confirmed);
    expect(context.requests).toContainEqual(
      expect.objectContaining({
        method: "thread/list",
        params: expect.objectContaining({ archived: true, cursor: "10" }),
      }),
    );
  });

  it.each(["draft-local", "web-remote:peer"])(
    "refuses reserved non-local Thread identity %s before contacting native Codex",
    async (id) => {
      const context = await setup({ thread: { id } });
      const before = context.requests.length;
      await expect(move(context, id)).resolves.toHaveProperty("error");
      expect(context.requests.slice(before)).toEqual([]);
    },
  );

  it("keeps legacy project assignments readable without enabling unverified native writes", async () => {
    const context = await setup();
    delete context.thread.projectId;
    const snapshot = await workspace(context, [NATIVE_THREAD]);
    expect(snapshot.assignments[NATIVE_THREAD]).toBe(OLD_GUI_PROJECT);
    expect(snapshot.projectMoveBindings?.assignments).not.toHaveProperty(NATIVE_THREAD);
    await expect(move(context, NATIVE_THREAD)).resolves.toHaveProperty("error");
    expect(nativeWrites(context)).toEqual([]);
  });

  it("drops only failed native bindings and keeps verified projectless distinct from unreadable", async () => {
    const context = await setup({ thread: { projectId: null } });
    const state = JSON.parse(context.originalState);
    state["thread-project-assignments"].unreadable = {
      projectKind: "local",
      projectId: GUI_PROJECT,
    };
    state["thread-project-assignments"].broken = { projectKind: "local", projectId: 42 };
    await writeFile(context.stateFile, JSON.stringify(state));
    const snapshot = await workspace(context, ["unreadable", NATIVE_THREAD]);
    expect(snapshot.assignments).toEqual({});
    expect(snapshot.projectMoveBindings).toEqual({
      projectIds: [OLD_GUI_PROJECT, GUI_PROJECT],
      assignments: { [NATIVE_THREAD]: null },
    });
  });

  it("never exposes an ambiguous native mapping as a move target or source", async () => {
    const context = await setup();
    const state = JSON.parse(context.originalState);
    const mappings = state["app-server-project-id-by-legacy-project-id-by-host"];
    mappings[`local:${path.resolve(context.home)}`][GUI_PROJECT] = OLD_NATIVE_PROJECT;
    await writeFile(context.stateFile, JSON.stringify(state));
    expect((await workspace(context, [NATIVE_THREAD])).projectMoveBindings).toEqual({
      projectIds: [],
      assignments: {},
    });
    await expect(move(context, NATIVE_THREAD)).resolves.toHaveProperty("error");
    expect(nativeWrites(context)).toEqual([]);
  });

  it("does not publish move capability on a remote Host or route the mutation there", async () => {
    const context = await setup({ remote: true });
    expect((await workspace(context, [NATIVE_THREAD])).projectMoveBindings).toBeUndefined();
    await expect(move(context, NATIVE_THREAD)).resolves.toHaveProperty("error");
    expect(nativeWrites(context)).toEqual([]);
  });

  it("retains a legacy external navigation assignment without treating it as projectless", async () => {
    const context = await setup();
    const id = await startExternal(context);
    const state = JSON.parse(context.originalState);
    state["thread-project-assignments"][id] = { projectKind: "local", projectId: OLD_GUI_PROJECT };
    await writeFile(context.stateFile, JSON.stringify(state), "utf8");

    const snapshot = await workspace(context);
    expect(snapshot.assignments[id]).toBe(OLD_GUI_PROJECT);
    expect(snapshot.projectMoveBindings?.assignments).not.toHaveProperty(id);
    await expect(move(context, id, OLD_GUI_PROJECT)).resolves.toHaveProperty("error");
    expect((await context.mappingStore.getThread(id))?.projectId).toBeUndefined();
  });

  it("clears a deleted project after the in-flight section mutation", async () => {
    const context = await setup({ desktop: true });
    const { fixture } = context;
    const id = await startExternal(context);
    await context.mappingStore.updateMetadata(id, { projectId: OLD_NATIVE_PROJECT });

    const paused = context.pauseNext("threadSection/delete");
    writeRequest(fixture.desktopInput, {
      id: 2,
      method: "threadSection/delete",
      params: { sectionId: SECTION.id },
    });
    const reply = await paused;
    try {
      context.notify("project/changed", { projectId: OLD_NATIVE_PROJECT, changeType: "deleted" });
      context.notify("project/changed", { projectId: NATIVE_PROJECT, changeType: "updated" });
      await fixture.collector.waitFor(
        (message) =>
          message.method === "project/changed" &&
          (message.params as JsonObject).projectId === NATIVE_PROJECT,
      );
    } finally {
      reply();
    }

    const section = await fixture.collector.waitFor(({ id }) => id === 2);
    const cleared = await fixture.collector.waitFor(
      ({ method }) => method === "thread/project/updated",
    );
    expect(fixture.collector.messages.indexOf(cleared)).toBeGreaterThan(
      fixture.collector.messages.indexOf(section),
    );
    expect((await context.mappingStore.getThread(id))?.projectId).toBeUndefined();
  });

  it("persists only external project metadata, projects the GUI ID, and skips same-value writes", async () => {
    const context = await setup();
    const { fixture, cwd } = context;
    const threadId = await startExternal(context);
    await fixture.mappingStore.updateMetadata(threadId, { projectId: OLD_NATIVE_PROJECT });
    const placements = await fixture.mappingStore.replaceSectionPlacements([
      {
        hostThreadId: threadId,
        section: SECTION,
        enteredAt: "2026-01-10T00:00:00.000Z",
        beforeThreadId: NATIVE_THREAD,
      },
    ]);
    const before = await fixture.mappingStore.getThread(threadId);
    if (!before) throw new Error("Missing external Thread record");
    expect(before.cwd).toBe(cwd);
    expect((await workspace(context)).assignments[threadId]).toBe(OLD_GUI_PROJECT);
    const update = vi.spyOn(fixture.mappingStore, "updateMetadata");

    await expect(move(context, threadId)).resolves.toEqual(confirmed);
    expect(update).toHaveBeenCalledTimes(1);
    expect(await fixture.mappingStore.getThread(threadId)).toEqual({
      ...before,
      projectId: NATIVE_PROJECT,
      revision: before.revision + 1,
      updatedAt: expect.any(String),
    });
    expect(await fixture.mappingStore.listSectionPlacements()).toEqual(placements);
    expect((await workspace(context)).assignments[threadId]).toBe(GUI_PROJECT);
    const after = await fixture.mappingStore.getThread(threadId);
    await expect(move(context, threadId)).resolves.toEqual(confirmed);
    expect(update).toHaveBeenCalledTimes(1);
    expect(await fixture.mappingStore.getThread(threadId)).toEqual(after);
    expect(nativeWrites(context)).toEqual([]);
    expect(await readFile(context.stateFile, "utf8")).toBe(context.originalState);
  });

  it("cancels an external update at the store write boundary if its owner retired", async () => {
    const entered = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const context = await setup({
      beforeReplace: (record) => {
        if (record.projectId !== NATIVE_PROJECT) return;
        entered.resolve(undefined);
        return release.promise;
      },
    });
    const id = await startExternal(context);
    const before = await context.mappingStore.getThread(id);
    const moving = move(context, id);
    try {
      await entered.promise;
      await context.scope.stop();
      await context.scope.start();
    } finally {
      release.resolve(undefined);
    }
    await expect(moving).resolves.toHaveProperty("error");
    expect(await context.mappingStore.getThread(id)).toEqual(before);
    expect(nativeWrites(context)).toEqual([]);
  });

  it("does not confirm a durable external write with a late mapping read after replacement", async () => {
    const context = await setup();
    const id = await startExternal(context);
    const reading = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const read = context.mappingStore.getThread.bind(context.mappingStore);
    const held = vi.spyOn(context.mappingStore, "getThread").mockImplementation(async (key) => {
      const result = await read(key);
      if (result?.projectId === NATIVE_PROJECT) {
        reading.resolve(undefined);
        await release.promise;
      }
      return result;
    });
    const moving = move(context, id);
    try {
      await reading.promise;
      await context.scope.stop();
      await context.scope.start();
    } finally {
      held.mockRestore();
      release.resolve(undefined);
    }
    await expect(moving).resolves.toEqual({ result: { status: "unknown" } });
    expect((await read(id))?.projectId).toBe(NATIVE_PROJECT);
    expect(nativeWrites(context)).toEqual([]);
  });

  it("rejects a mismatched project/read identity without mutating either owner", async () => {
    const context = await setup({ projectId: OLD_NATIVE_PROJECT });
    const threadId = await startExternal(context);
    const update = vi.spyOn(context.fixture.mappingStore, "updateMetadata");
    for (const id of [threadId, NATIVE_THREAD]) {
      await expect(move(context, id)).resolves.toHaveProperty("error");
    }
    expect(nativeWrites(context)).toEqual([]);
    expect(update).not.toHaveBeenCalled();
  });

  it("rejects an ephemeral external Thread even when it has a persisted native identity", async () => {
    const context = await setup();
    const id = hostThreadIdSchema.parse(
      await startExternalThread(context.fixture, "codexhost/pi-native", 1, {
        cwd: context.cwd,
        ephemeral: true,
      }),
    );
    const before = await context.mappingStore.getThread(id);
    await expect(move(context, id)).resolves.toHaveProperty("error");
    expect(await context.mappingStore.getThread(id)).toEqual(before);
    expect(nativeWrites(context)).toEqual([]);
  });

  it("rejects pinned external Threads and extra project-move fields", async () => {
    const context = await setup();
    const { fixture } = context;
    const threadId = await startExternal(context);
    const placements = await fixture.mappingStore.replaceSectionPlacements([
      {
        hostThreadId: threadId,
        section: { id: PINNED_THREAD_SECTION_ID, name: "Pinned", appearance: null },
        enteredAt: "2026-01-10T00:00:00.000Z",
        beforeThreadId: null,
      },
    ]);
    const before = await fixture.mappingStore.getThread(threadId);
    await expect(move(context, threadId)).resolves.toHaveProperty("error");
    await expect(
      fixture.host.handleClientRequest(MOVE, {
        threadId,
        projectId: GUI_PROJECT,
        daybreakEnabled: true,
      }),
    ).resolves.toMatchObject({ error: { code: -32602 } });
    expect(await fixture.mappingStore.listSectionPlacements()).toEqual(placements);
    expect(await fixture.mappingStore.getThread(threadId)).toEqual(before);
    expect(nativeWrites(context)).toEqual([]);
  });
});
