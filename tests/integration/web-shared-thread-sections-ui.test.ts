import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { JsonObject } from "@codexhost/protocol-core";
import { THREAD_SECTION_CAPABILITY } from "@codexhost/shared-contracts";
import { tsImport } from "tsx/esm/api";
import { expect, it } from "vitest";
import { SharedThreadBridge } from "../../packages/host-runtime/src/shared-thread-bridge.js";
import { SharedThreadOwner } from "../../packages/host-runtime/src/shared-thread-owner.js";
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
  type StreamSink,
} from "../../packages/web-server/src/transport.ts";
import { Workspaces, type ThreadSectionView } from "../../packages/web-server/src/workspaces.ts";

const section = { id: "research", name: "Research", appearance: null };
const pinned = { id: "01984de2-8f74-7c91-a3b2-5c5e937cf318", name: "Pinned", appearance: null };
const moveMethod = "codexhost/thread/sections/move";
const placementsMethod = "codexhost/shared-threads/placements";

interface WireWorkspaceView {
  workspaceId: string;
  path: string;
  title: string;
  sessionIds: string[];
  createdAt: string;
  updatedAt: string;
}

type WorkspaceStreamFrame =
  | {
      type: "baseline";
      value: {
        items: WireWorkspaceView[];
        archivedSessionIds: string[];
        pinnedSessionIds: string[];
        threadSections?: ThreadSectionView[];
        threadSectionsV1?: true;
      };
    }
  | { type: "upsert"; workspace: WireWorkspaceView }
  | { type: "remove"; workspaceId: string }
  | { type: "order"; workspaceIds: string[] }
  | { type: "archived"; archivedSessionIds: string[] }
  | { type: "pinned"; pinnedSessionIds: string[] }
  | {
      type: "threadSections";
      threadSections: ThreadSectionView[];
      threadSectionsV1?: true;
    };

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
  const older = { ...head, id: "native-older", name: "Older native project row", updatedAt: 1500 };
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

/** Minimal mirror of ClientWorkspaceModel's authoritative stream projection for dual-browser checks. */
interface SubscriberProjection {
  items: WireWorkspaceView[];
  archivedSessionIds: string[];
  pinnedSessionIds: string[];
  threadSections: ThreadSectionView[];
  threadSectionsV1: true | undefined;
  sectionFrames: Array<Extract<WorkspaceStreamFrame, { type: "threadSections" }>>;
}

function applyFrame(state: SubscriberProjection, frame: WorkspaceStreamFrame): void {
  switch (frame.type) {
    case "baseline":
      state.items = frame.value.items;
      state.archivedSessionIds = frame.value.archivedSessionIds;
      state.pinnedSessionIds = frame.value.pinnedSessionIds;
      state.threadSections = frame.value.threadSections ?? [];
      state.threadSectionsV1 = frame.value.threadSectionsV1;
      return;
    case "upsert": {
      const index = state.items.findIndex(
        (item) => item.workspaceId === frame.workspace.workspaceId,
      );
      state.items =
        index === -1
          ? [frame.workspace, ...state.items]
          : state.items.map((item, i) => (i === index ? frame.workspace : item));
      return;
    }
    case "remove":
      state.items = state.items.filter((item) => item.workspaceId !== frame.workspaceId);
      return;
    case "order": {
      const rank = new Map(frame.workspaceIds.map((id, i) => [id, i]));
      state.items = [...state.items].sort(
        (a, b) =>
          (rank.get(a.workspaceId) ?? Number.MAX_SAFE_INTEGER) -
          (rank.get(b.workspaceId) ?? Number.MAX_SAFE_INTEGER),
      );
      return;
    }
    case "archived":
      state.archivedSessionIds = frame.archivedSessionIds;
      return;
    case "pinned":
      state.pinnedSessionIds = frame.pinnedSessionIds;
      return;
    case "threadSections":
      state.sectionFrames.push(frame);
      state.threadSections = frame.threadSections;
      state.threadSectionsV1 = frame.threadSectionsV1;
      return;
  }
}

it("preserves prior section projections across dual browser followers on failed project pagination, single move, and fresh restart baseline", async () => {
  const { ChSessions } = (await tsImport(
    "../../packages/web-server/src/ch-sessions.ts",
    import.meta.url,
  )) as typeof WebSessions;
  const owner = new SharedThreadOwner();
  const source = createFixture({ externalOnly: true });
  source.desktopOutput.pipe(owner.output, { end: false });
  owner.input.pipe(source.desktopInput, { end: false });
  const peer = owner.connect();
  let failPlacements = false;
  const viewer = createFixture({
    sharedThreads: new SharedThreadBridge({
      connect: async () => ({
        ...peer,
        request: async (method, params) => {
          if (method === placementsMethod && failPlacements) {
            failPlacements = false;
            return { error: { code: -32078, message: "Synthetic owner placement read failed" } };
          }
          return peer.request(method, params);
        },
      }),
      delegateCreates: true,
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
      return (await this.request<{ threadIds: string[] }>("codexhost/thread/pins/list", {}))
        .threadIds;
    },
    close() {},
  };
  const webRoot = join(viewer.mappingStoreDirectory, "web");
  mkdirSync(webRoot);
  const workspaces = new Workspaces(new DataDir(webRoot), webRoot, true);
  const sessions = new ChSessions(client, workspaces, new EventHub(webRoot));
  const rpc = new RpcRegistry();
  const streams = new StreamRegistry();
  let workspaceFollowHandler:
    ((args: Record<string, unknown>, sink: StreamSink) => void | Promise<void>) | undefined;
  const originalRegister = streams.register.bind(streams);
  streams.register = (name, handler) => {
    if (name === "workspace/follow") workspaceFollowHandler = handler;
    originalRegister(name, handler);
  };
  workspaces.register(rpc, streams);
  sessions.register(rpc, streams);

  const list = async (request: object = {}) => {
    const reply = await rpc.dispatch("session/list", { args: { request } });
    expect(reply).toMatchObject({ ok: true });
    if (!reply.ok) throw new Error(reply.error.message);
    return reply.value as { items: Array<{ sessionId: string }>; nextCursor: string | null };
  };

  const closers: Array<() => void> = [];
  const openFollower = async (id: string): Promise<SubscriberProjection> => {
    if (!workspaceFollowHandler) throw new Error("workspace/follow handler was not registered");
    const state: SubscriberProjection = {
      items: [],
      archivedSessionIds: [],
      pinnedSessionIds: [],
      threadSections: [],
      threadSectionsV1: undefined,
      sectionFrames: [],
    };
    const sink: StreamSink = {
      id,
      closed: false,
      push: (value) => applyFrame(state, value as WorkspaceStreamFrame),
      end: () => {},
      fail: (code, message) => {
        throw new Error(`${code}: ${message}`);
      },
      onClose: (close) => {
        closers.push(close);
      },
    };
    await workspaceFollowHandler({ [THREAD_SECTION_CAPABILITY]: true }, sink);
    return state;
  };

  const unsectionedProjectRows = (state: SubscriberProjection, workspaceId: string) => {
    const sectioned = new Set(state.threadSections.flatMap((entry) => entry.threadIds));
    const archived = new Set(state.archivedSessionIds);
    const pinnedIds = new Set(state.pinnedSessionIds);
    const workspace = state.items.find((item) => item.workspaceId === workspaceId);
    return (workspace?.sessionIds ?? []).filter(
      (id) => !sectioned.has(id) && !archived.has(id) && !pinnedIds.has(id),
    );
  };

  try {
    const boot = await peer.request("codexhost/thread/sections/list", {});
    expect(boot, source.diagnosticOutput.read()?.toString()).toHaveProperty("result");

    const external: string[] = [];
    for (let i = 1; i <= 5; i++) {
      external.push(await startExternalThread(source, "codexhost/pi-native", i, { cwd: root }));
    }
    const [first, second, archived, pin, unsectionedExt] = external as [
      string,
      string,
      string,
      string,
      string,
    ];
    for (const threadId of [first, second, archived]) {
      expect(await peer.request(moveMethod, { threadId, sectionId: section.id })).toHaveProperty(
        "result",
      );
    }
    expect(await peer.request("thread/archive", { threadId: archived })).toHaveProperty("result");
    expect(
      await peer.request("thread/section/move", { threadId: pin, sectionId: pinned.id }),
    ).toHaveProperty("result");

    const baselinePage = await list();
    expect(baselinePage.nextCursor).not.toBeNull();

    const browserA = await openFollower("browser-a");
    const browserB = await openFollower("browser-b");
    const project = browserA.items.find((item) => item.path === root);
    if (!project) throw new Error("project workspace was not projected");
    const wsId = project.workspaceId;

    const expectedBeforeMove = [head.id, first, second];
    for (const browser of [browserA, browserB]) {
      expect(browser.threadSectionsV1).toBe(true);
      expect(browser.threadSections).toEqual([
        { id: section.id, name: section.name, appearance: null, threadIds: expectedBeforeMove },
      ]);
      const projectRows = unsectionedProjectRows(browser, wsId);
      expect(projectRows).toContain(unsectionedExt);
      expect(projectRows).not.toContain(head.id);
      expect(projectRows).not.toContain(first);
      expect(projectRows).not.toContain(second);
    }

    const persistedBeforePage = await source.mappingStore.listSectionPlacements();
    const framesBeforeA = browserA.sectionFrames.length;
    const framesBeforeB = browserB.sectionFrames.length;

    // Project pagination while SharedThreadBridge.placements() transiently fails:
    // page still returns older native row, disk placements stay intact, and neither
    // browser receives a degraded section snapshot before any move happens.
    failPlacements = true;
    const paged = await list({ cursor: baselinePage.nextCursor, workspaceId: wsId });
    expect(paged.items).toContainEqual(expect.objectContaining({ sessionId: older.id }));
    expect(await source.mappingStore.listSectionPlacements()).toEqual(persistedBeforePage);
    expect(browserA.sectionFrames.length).toBe(framesBeforeA);
    expect(browserB.sectionFrames.length).toBe(framesBeforeB);

    for (const browser of [browserA, browserB]) {
      expect(browser.threadSections).toEqual([
        { id: section.id, name: section.name, appearance: null, threadIds: expectedBeforeMove },
      ]);
      const projectRows = unsectionedProjectRows(browser, wsId);
      expect(projectRows).toContain(older.id);
      expect(projectRows).toContain(unsectionedExt);
      expect(projectRows).not.toContain(first);
      expect(projectRows).not.toContain(second);
      expect(projectRows).not.toContain(head.id);
    }

    // Move one external member (first before head): both followers converge on the new order.
    expect(
      await rpc.dispatch("workspace/moveSessionToSection", {
        args: {
          request: { sessionId: first, sectionId: section.id, beforeSessionId: head.id },
        },
      }),
    ).toEqual({ ok: true, value: { sectionId: section.id } });

    const expectedAfterMove = [first, head.id, second];
    for (const browser of [browserA, browserB]) {
      expect(browser.threadSections).toEqual([
        { id: section.id, name: section.name, appearance: null, threadIds: expectedAfterMove },
      ]);
      const projectRows = unsectionedProjectRows(browser, wsId);
      expect(projectRows).not.toContain(first);
      expect(projectRows).not.toContain(second);
      expect(projectRows).not.toContain(head.id);
    }

    // Fresh browser subscriber (restart/reconnect projection) gets the full authoritative baseline.
    const browserC = await openFollower("browser-c");
    expect(browserC.threadSectionsV1).toBe(true);
    expect(browserC.threadSections).toEqual([
      { id: section.id, name: section.name, appearance: null, threadIds: expectedAfterMove },
    ]);
    const restartedRows = unsectionedProjectRows(browserC, wsId);
    expect(restartedRows).toContain(older.id);
    expect(restartedRows).toContain(unsectionedExt);
    expect(restartedRows).not.toContain(first);
    expect(restartedRows).not.toContain(second);
    expect(restartedRows).not.toContain(head.id);
  } finally {
    for (const close of closers) close();
    await sessions.close();
    await stopFixture(viewer);
    owner.close();
    await stopFixture(source);
  }
});
