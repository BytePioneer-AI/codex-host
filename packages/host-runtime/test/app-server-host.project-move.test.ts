import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MappingStore } from "@codexhost/mapping-store";
import type { JsonObject } from "@codexhost/protocol-core";
import { clientWorkspaceSnapshotSchema, hostThreadIdSchema } from "@codexhost/shared-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
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
    archivedList?: boolean;
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
  const mappingStore = new MappingStore({ directory: mappingStoreDirectory });
  await mappingStore.initialize();
  const fixture = createFixture({
    externalOnly: true,
    environment: { CODEX_HOME: home },
    mappingStore,
    mappingStoreDirectory,
  });
  cleanup.push(() => stopFixture(fixture));
  const requests: JsonObject[] = [];
  const thread: JsonObject = {
    id: NATIVE_THREAD,
    cwd,
    projectId: OLD_NATIVE_PROJECT,
    archived: false,
    section: SECTION,
    ...options.thread,
  };
  const collector = new JsonLineCollector(fixture.official.stdin);
  fixture.official.stdin.on("data", () => {
    for (const request of collector.messages.splice(0)) {
      if (request.id === undefined || request.id === null) continue;
      requests.push(request);
      const params = (request.params ?? {}) as JsonObject;
      let reply: JsonObject;
      switch (request.method) {
        case "project/read":
          reply = { result: { project: { id: options.projectId ?? params.projectId } } };
          break;
        case "thread/read":
          reply =
            options.write === "malformed-readback" && nativeWrites({ requests }).length > 0
              ? { result: { thread: { ...thread, id: "unexpected-thread" } } }
              : { result: { thread } };
          break;
        case "thread/metadata/update":
          if (options.write === "rejected") {
            reply = { error: { code: -32602, message: "Native project move rejected" } };
            break;
          }
          if (options.write !== "stale") thread.projectId = params.projectId ?? null;
          reply =
            options.write === "ambiguous"
              ? { error: { code: -32093, message: "Native write outcome unavailable" } }
              : { result: { thread: { ...thread, projectId: params.projectId } } };
          break;
        case "threadSection/list":
          reply = { result: { data: [SECTION], nextCursor: null } };
          break;
        case "thread/list":
          reply = {
            result: {
              data: options.archivedList && params.archived === true ? [thread] : [],
              nextCursor: null,
              backwardsCursor: null,
            },
          };
          break;
        default:
          reply = { result: {} };
      }
      writeRequest(fixture.official.stdout, { id: request.id, ...reply });
    }
  });
  // The shared service lazily attaches to the native app-server for the first read.
  await fixture.host.handleClientRequest("codexhost/workspace/read", {
    threadIds: [NATIVE_THREAD],
  });
  await fixture.ready;
  return { fixture, cwd, stateFile, originalState, requests, thread };
}

type Setup = Awaited<ReturnType<typeof setup>>;

function move({ fixture }: Setup, threadId: string, projectId = GUI_PROJECT) {
  return fixture.host.handleClientRequest(MOVE, { threadId, projectId });
}

function nativeWrites({ requests }: Pick<Setup, "requests">) {
  return requests.filter(({ method }) => method === "thread/metadata/update");
}

async function workspace({ fixture }: Setup, threadIds: string[] = []) {
  const response = await fixture.host.handleClientRequest("codexhost/workspace/read", {
    threadIds,
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

  it("does not write if the official Thread is already in the destination", async () => {
    const context = await setup({ thread: { projectId: NATIVE_PROJECT } });
    await expect(move(context, NATIVE_THREAD)).resolves.toEqual(confirmed);
    expect(nativeWrites(context)).toEqual([]);
  });

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
  ] satisfies [string, JsonObject][])(
    "rejects a %s official Thread before writing",
    async (_name, thread) => {
      const context = await setup({ thread });
      await expect(move(context, NATIVE_THREAD)).resolves.toHaveProperty("error");
      expect(nativeWrites(context)).toEqual([]);
    },
  );

  it("checks the native archive list when thread/read does not expose archive membership", async () => {
    const context = await setup({ archivedList: true });
    delete context.thread.archived;
    await expect(move(context, NATIVE_THREAD)).resolves.toHaveProperty("error");
    expect(context.requests).toContainEqual(
      expect.objectContaining({
        method: "thread/list",
        params: expect.objectContaining({ archived: true }),
      }),
    );
    expect(nativeWrites(context)).toEqual([]);
  });

  it("keeps legacy project assignments readable without enabling unverified native writes", async () => {
    const context = await setup();
    delete context.thread.projectId;
    expect((await workspace(context, [NATIVE_THREAD])).assignments[NATIVE_THREAD]).toBe(
      OLD_GUI_PROJECT,
    );
    await expect(move(context, NATIVE_THREAD)).resolves.toHaveProperty("error");
    expect(nativeWrites(context)).toEqual([]);
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

  it("rejects pinned external Threads and does not expose general metadata updates", async () => {
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
    for (const id of [threadId, NATIVE_THREAD]) {
      await expect(
        fixture.host.handleClientRequest("thread/metadata/update", {
          threadId: id,
          projectId: NATIVE_PROJECT,
        }),
      ).resolves.toMatchObject({ error: { code: -32601 } });
    }
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
