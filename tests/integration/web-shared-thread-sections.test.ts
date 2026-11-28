import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { JsonObject } from "@codexhost/protocol-core";
import { THREAD_SECTION_CAPABILITY } from "@codexhost/shared-contracts";
import { tsImport } from "tsx/esm/api";
import { expect, it } from "vitest";
import { SharedThreadBridge } from "../../packages/host-runtime/src/shared-thread-bridge.js";
import { SharedThreadOwner } from "../../packages/host-runtime/src/shared-thread-owner.js";
import { SHARED_THREAD_LIST_METHOD } from "../../packages/host-runtime/src/shared-thread-peer.js";
import {
  type FakeOfficialProcess,
  createFixture,
  JsonLineCollector,
  startExternalThread,
  stopFixture,
  writeRequest,
} from "../../packages/host-runtime/test/app-server-host-fixture.js";
import type { ChHostClient } from "../../packages/web-server/src/ch-host-client.ts";
import type * as WebSessions from "../../packages/web-server/src/ch-sessions.ts";
import { DataDir } from "../../packages/web-server/src/store.ts";
import {
  EventHub,
  RpcError,
  RpcRegistry,
  StreamRegistry,
  type StreamHandler,
} from "../../packages/web-server/src/transport.ts";
import { Workspaces } from "../../packages/web-server/src/workspaces.ts";

const section = { id: "research", name: "Research", appearance: null };
const pinned = { id: "01984de2-8f74-7c91-a3b2-5c5e937cf318", name: "Pinned", appearance: null };
const catalogMethod = "codexhost/thread/catalog/read";
const moveMethod = "codexhost/thread/sections/move";
const placementsMethod = "codexhost/shared-threads/placements";

function serveNative({ official }: { official: FakeOfficialProcess }, root: string) {
  const head = {
    id: "native-head",
    cwd: root,
    name: "Native member",
    modelProvider: "openai",
    createdAt: 1000,
    updatedAt: 2000,
    status: { type: "idle" },
    archived: false,
  };
  const older = { ...head, id: "native-older", updatedAt: 1500 };
  const requests = new JsonLineCollector(official.stdin);
  official.stdin.on("data", () => {
    for (const request of requests.messages.splice(0)) {
      const params = request.params as JsonObject | undefined;
      const list = (data: JsonObject[], nextCursor: string | null = null) => ({
        data,
        nextCursor,
        backwardsCursor: null,
      });
      let result: JsonObject = {};
      if (request.method === "threadSection/list") result = list([pinned, section]);
      if (request.method === "thread/list") {
        if (params?.sectionId === section.id) result = list([head]);
        else if (params?.sectionId || params?.archived === true) result = list([]);
        else if (params?.cursor === "older") result = list([older]);
        else result = list([head], "older");
      }
      if (request.id !== undefined) writeRequest(official.stdout, { id: request.id, result });
    }
  });
  return { head, older };
}

it("keeps shared section members and follower order across incomplete reads and moves", async () => {
  // Match the Web server runner for ChSessions and its Web-only dependencies.
  const { ChSessions } = (await tsImport(
    "../../packages/web-server/src/ch-sessions.ts",
    import.meta.url,
  )) as typeof WebSessions;
  const owner = new SharedThreadOwner();
  const source = createFixture({ externalOnly: true });
  source.desktopOutput.pipe(owner.output, { end: false });
  owner.input.pipe(source.desktopInput, { end: false });
  const peer = owner.connect();
  let unavailableMethod: string | undefined;
  let now = 0;
  const viewer = createFixture({
    sharedThreads: new SharedThreadBridge({
      connect: async () => ({
        ...peer,
        request: async (method, params) => {
          if (
            method === unavailableMethod ||
            (unavailableMethod === "thread/list" && method === SHARED_THREAD_LIST_METHOD)
          ) {
            return { error: { code: -32078, message: "Synthetic shared owner read failure" } };
          }
          return peer.request(method, params);
        },
      }),
      delegateCreates: true,
      now: () => now,
      diagnose: () => undefined,
    }),
  });
  const root = join(viewer.mappingStoreDirectory, "project");
  mkdirSync(root);
  serveNative(source, root);
  const { head, older } = serveNative(viewer, root);
  const client: ChHostClient = {
    async request<T>(method: string, params: Record<string, unknown>): Promise<T> {
      const reply = (await viewer.host.handleClientRequest(method, params)) as JsonObject;
      if (reply.error) throw new RpcError("host/rejected", JSON.stringify(reply.error));
      return reply.result as T;
    },
    async projects() {
      return {
        projects: [{ id: "project", name: "Project", rootPaths: [root] }],
        assignments: {},
        projectless: [],
      };
    },
    async pins() {
      const result = await this.request<{ threadIds: string[] }>("codexhost/thread/pins/list", {});
      return result.threadIds;
    },
    close() {},
  };
  const webRoot = join(viewer.mappingStoreDirectory, "web");
  mkdirSync(webRoot);
  const workspaces = new Workspaces(new DataDir(webRoot), webRoot, true);
  const sessions = new ChSessions(client, workspaces, new EventHub(webRoot));
  const rpc = new RpcRegistry();
  const streams = new StreamRegistry();
  let follow: StreamHandler | undefined;
  const register = streams.register.bind(streams);
  streams.register = (name, handler) => {
    if (name === "workspace/follow") follow = handler;
    register(name, handler);
  };
  workspaces.register(rpc, streams);
  sessions.register(rpc, streams);

  const closers: Array<() => void> = [];
  const openFollower = async (id: string) => {
    if (!follow) throw new Error("workspace/follow handler was not registered");
    const frames: Array<{ type: string }> = [];
    await follow(
      { [THREAD_SECTION_CAPABILITY]: true },
      {
        id,
        closed: false,
        push: (frame) => frames.push(frame as (typeof frames)[number]),
        end() {},
        fail: (code, message) => {
          throw new Error(`${code}: ${message}`);
        },
        onClose: (close) => closers.push(close),
      },
    );
    return frames;
  };

  const list = async (request: object = {}) => {
    const reply = await rpc.dispatch("session/list", { args: { request } });
    expect(reply).toMatchObject({ ok: true });
    if (!reply.ok) throw new Error(reply.error.message);
    return reply.value as { items: Array<{ sessionId: string }>; nextCursor: string | null };
  };
  const members = () => [...workspaces.sectionMemberIds()].sort();
  try {
    const boot = await peer.request("codexhost/thread/sections/list", {});
    expect(boot, source.diagnosticOutput.read()?.toString()).toHaveProperty("result");
    const start = (id: number) =>
      startExternalThread(source, "codexhost/pi-native", id, { cwd: root });
    const first = await start(1);
    const second = await start(2);
    const archived = await start(3);
    const pin = await start(4);
    const unsectioned = await start(5);
    for (const threadId of [first, second, archived]) {
      expect(await peer.request(moveMethod, { threadId, sectionId: section.id })).toHaveProperty(
        "result",
      );
    }
    expect(await peer.request("thread/archive", { threadId: archived })).toHaveProperty("result");
    expect(
      await peer.request("thread/section/move", { threadId: pin, sectionId: pinned.id }),
    ).toHaveProperty("result");
    const initialOrder = [head.id, first, second];
    const expected = [...initialOrder].sort();
    const baseline = await list();
    expect(baseline.items.map(({ sessionId }) => sessionId).sort()).toEqual(
      [...expected, pin, unsectioned].sort(),
    );
    expect(members()).toEqual(expected);
    const project = workspaces.ownerOf(first);
    expect(project?.path).toBe(root);
    if (!project || !baseline.nextCursor) throw new Error("Missing project or native cursor");
    const scope = { cursor: baseline.nextCursor, workspaceId: project.workspaceId };
    const followers = [await openFollower("browser-a"), await openFollower("browser-b")];
    const expectBaseline = (frame: unknown, order: string[], projectRows: string[]) => {
      expect(frame).toMatchObject({
        type: "baseline",
        value: {
          [THREAD_SECTION_CAPABILITY]: true,
          threadSections: [{ ...section, threadIds: order }],
          items: expect.arrayContaining([
            expect.objectContaining({
              workspaceId: project.workspaceId,
              path: root,
              sessionIds: expect.arrayContaining(projectRows),
            }),
          ]),
        },
      });
    };
    for (const frames of followers) expectBaseline(frames[0], initialOrder, [unsectioned]);
    const sectionFrames = (frames: ReadonlyArray<{ type: string }>) =>
      frames.filter(({ type }) => type === "threadSections");
    const persisted = await source.mappingStore.listSectionPlacements();

    unavailableMethod = placementsMethod;
    const page = await list(scope);
    unavailableMethod = undefined;
    expect(page.items).toContainEqual(expect.objectContaining({ sessionId: older.id }));
    expect(members(), "a failed read must not unsection either external member").toEqual(expected);
    expect(workspaces.ownerOf(first)?.sessionIds).toEqual(expect.arrayContaining([first, second]));
    expect(await source.mappingStore.listSectionPlacements()).toEqual(persisted);
    for (const frames of followers) {
      const updates = frames.slice(1);
      expect(sectionFrames(updates)).toEqual([]);
      expect(updates).not.toContainEqual(
        expect.objectContaining({ type: "remove", workspaceId: project.workspaceId }),
      );
      expect(updates.findLast(({ type }) => type === "upsert")).toMatchObject({
        workspace: {
          workspaceId: project.workspaceId,
          sessionIds: expect.arrayContaining([older.id, unsectioned]),
        },
      });
    }

    const move = (sectionId: string | null, beforeSessionId?: string) =>
      rpc.dispatch("workspace/moveSessionToSection", {
        args: {
          request: {
            sessionId: first,
            sectionId,
            ...(beforeSessionId === undefined ? {} : { beforeSessionId }),
          },
        },
      });
    expect(await move(section.id)).toEqual({ ok: true, value: { sectionId: section.id } });
    expect(members()).toEqual(expected);
    expect(await source.mappingStore.listSectionPlacements()).toEqual(persisted);
    for (const frames of followers) {
      for (const frame of sectionFrames(frames))
        expect(frame).toMatchObject({
          [THREAD_SECTION_CAPABILITY]: true,
          threadSections: [{ ...section, threadIds: initialOrder }],
        });
    }
    const beforeMove = followers.map((frames) => frames.length);

    expect(await move(section.id, head.id)).toEqual({ ok: true, value: { sectionId: section.id } });
    const movedOrder = [first, head.id, second];
    for (const [index, frames] of followers.entries()) {
      expect(sectionFrames(frames.slice(beforeMove[index]))).toEqual([
        {
          type: "threadSections",
          [THREAD_SECTION_CAPABILITY]: true,
          threadSections: [{ ...section, threadIds: movedOrder }],
        },
      ]);
    }
    const browserC = await openFollower("browser-c");
    expectBaseline(browserC[0], movedOrder, [older.id, unsectioned]);

    unavailableMethod = placementsMethod;
    expect((await list()).items.map(({ sessionId }) => sessionId).sort()).toEqual(
      [...expected, pin, unsectioned].sort(),
    );
    expect(members()).toEqual(expected);

    // Expire the reusable shared list and fail the walk, not native pagination.
    now += 10_000;
    unavailableMethod = "thread/list";
    await list(scope);
    expect(members()).toEqual(expected);
    expect(await rpc.dispatch("session/list", { args: {} })).toMatchObject({ ok: false });
    expect(members()).toEqual(expected);
    unavailableMethod = undefined;
    expect(await client.request(catalogMethod, { includeArchived: true })).toMatchObject({
      archivedThreadIds: [archived],
    });
    expect(await move(null)).toEqual({ ok: true, value: { sectionId: null } });
    expect(members()).toEqual([head.id, second].sort());
    expect(workspaces.ownerOf(first)?.workspaceId).toBe(project.workspaceId);
  } finally {
    for (const close of closers) close();
    await sessions.close();
    await stopFixture(viewer);
    owner.close();
    await stopFixture(source);
  }
});
