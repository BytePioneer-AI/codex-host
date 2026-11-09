// @vitest-environment jsdom
import { Context } from "@deepseek-ai/cordis";
import { afterEach, expect, it, vi } from "vitest";
import { SessionId } from "@deepseek-ai/dsh-session/types";
import { createSnapshotStore } from "@deepseek-ai/dsh-client-store";
import { RemoteStream } from "@deepseek-ai/dsh-api-gateway/client";
import type {
  IWorkspaces,
  WorkspaceSnapshot,
} from "@deepseek-ai/dsh-api-workspace-controller/client";
import { ClientSessions } from "../../../apps/web-ui/packages/api/session-controller/src/client/sessions/service.ts";
import type { SessionRemotes } from "../../../apps/web-ui/packages/api/session-controller/src/client/sessions/remotes.ts";
import type {
  SessionFollowFrame,
  SessionFollowRequest,
} from "../../../apps/web-ui/packages/api/session-controller/src/types.ts";
import { UiWorkspaceService } from "../../../apps/web-ui/packages/client/ui-workspace/src/client/navigation.ts";

const roots: Context[] = [];
afterEach(async () => {
  for (const ctx of roots.splice(0)) await ctx.fiber.dispose();
  localStorage.clear();
});
const flush = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};
const event = (seq: number, text: string) => ({
  type: "event" as const,
  event: { type: "test/content", seq, time: 1, data: { text }, ignorable: true },
});

async function fixture(runningIds: string[] = []) {
  const ctx = new Context();
  roots.push(ctx);
  ctx.provide("layout", {
    selectPanel: vi.fn(),
    beginNavigation: () => new AbortController().signal,
  } as never);
  const generation = createSnapshotStore<{ id: number } | undefined>({ id: 1 });
  const requests: SessionFollowRequest[] = [];
  const closed: string[] = [];
  const records = new Map<string, ReturnType<typeof event>[]>();
  const feeds = new Map<string, (frame: SessionFollowFrame | undefined) => void>();
  const failing = new Set<string>();
  const summary = (id: string) => ({
    sessionId: SessionId(id),
    running: runningIds.includes(id),
    blank: false,
    agentAvailable: true,
    updatedAt: 1,
  });
  const remote = {
    $stream: (options: ConstructorParameters<typeof RemoteStream>[1]) =>
      new RemoteStream({ generation } as never, options),
    session: {
      list: async () => ({
        ok: true,
        value: { items: Array.from({ length: 12 }, (_, i) => summary(String(i))) },
      }),
      create: async () => ({ ok: true, value: { sessionId: SessionId("11") } }),
      async *follow(request: SessionFollowRequest, signal: AbortSignal) {
        const id =
          request.address.kind === "session"
            ? request.address.sessionId
            : request.address.childSessionId;
        requests.push(request);
        if (failing.has(id)) throw new Error("open failed");
        const history = records.get(id) ?? [event(0, id)];
        records.set(id, history);
        let next = Promise.withResolvers<SessionFollowFrame | undefined>();
        const send = (frame: SessionFollowFrame | undefined) => next.resolve(frame);
        feeds.set(id, send);
        const abort = () => send(undefined);
        signal.addEventListener("abort", abort, { once: true });
        try {
          yield {
            type: "snapshot",
            epoch: `epoch-${id}`,
            ...(request.resume ? { resumedAfter: request.resume.cursor } : {}),
            header: { version: 4, id, createdAt: 1, isSeeded: false },
            cursor: history.length - 1,
            records: request.resume ? history.slice(request.resume.cursor + 1) : history,
            hasMore: false,
            projections: { asOfSeq: history.length - 1, values: {} },
            assistantStream: { revision: 0 },
          } as unknown as SessionFollowFrame;
          while (!signal.aborted) {
            const frame = await next.promise;
            next = Promise.withResolvers<SessionFollowFrame | undefined>();
            if (!frame) return;
            yield frame;
          }
        } finally {
          signal.removeEventListener("abort", abort);
          if (feeds.get(id) === send) feeds.delete(id);
          closed.push(id);
        }
      },
    },
  } as unknown as SessionRemotes;
  const sessions = new ClientSessions(ctx, remote);
  const workspace = createSnapshotStore<WorkspaceSnapshot>({
    phase: "pending",
    state: "idle",
    error: null,
    items: [],
    archivedSessionIds: [],
    pinnedSessionIds: [],
    canStartProjectless: true,
  });
  const workspaces = { list: workspace } as unknown as IWorkspaces;
  const navigation = new UiWorkspaceService(
    ctx,
    {} as never,
    workspaces,
    sessions,
    {} as never,
    vi.fn(),
  );
  await sessions.refresh();
  await flush();
  const open = async (id: string) => {
    navigation.openSession(SessionId(id));
    await flush();
    return sessions.binding(SessionId(id))!;
  };
  const append = async (id: string, text: string) => {
    const history = records.get(id)!;
    const frame = event(history.length, text);
    history.push(frame);
    feeds.get(id)?.(frame as unknown as SessionFollowFrame);
    await flush();
  };
  return {
    ctx,
    sessions,
    navigation,
    workspace,
    generation,
    requests,
    closed,
    feeds,
    failing,
    open,
    append,
    summary,
  };
}

it("keeps running and recently visited data through A→B→A, including output after running:false", async () => {
  const f = await fixture(["0", "2"]);
  // Running catalog discovery needs no visit; cold history and projected children stay unopened.
  expect(f.requests.map((r) => r.address.kind === "session" && r.address.sessionId).sort()).toEqual(
    ["0", "2"],
  );
  const a = await f.open("0");
  await f.open("1");
  const listUpdates = vi.fn();
  const stop = f.sessions.list.subscribe(listUpdates);
  expect(f.sessions.retainInfo(SessionId("0")).getSnapshot().retainedBy).toEqual({
    backgroundWarm: 1,
  });
  await f.append("0", "background output");
  expect(listUpdates).not.toHaveBeenCalled();
  expect(await f.open("0")).toBe(a);
  f.sessions.handleSessionStatus(SessionId("0"), false);
  await flush();
  await f.open("1");
  await f.append("0", "last reply after metadata");
  expect(await f.open("0")).toBe(a);
  expect(a.eventSource.getSnapshot().entries.at(-1)?.event.data).toEqual({
    text: "last reply after metadata",
  });
  expect(a.session.getSnapshot().openState).toBe("open");
  const b = await f.open("1");
  await f.open("0");
  expect(await f.open("1")).toBe(b);
  expect(f.requests).toHaveLength(3);
  expect(f.closed).toEqual([]);
  f.navigation.openSession(SessionId("0"));
  f.navigation.openSession(SessionId("1"));
  f.navigation.openSession(SessionId("0"));
  await flush();
  expect(f.sessions.binding(SessionId("0"))).toBe(a);
  expect(f.sessions.retainInfo(SessionId("0")).getSnapshot().retainedBy).toEqual({
    backgroundWarm: 1,
    mainView: 1,
  });
  stop();
  // An unvisited running Session also becomes warm on completion, without reopening.
  const unvisited = f.sessions.binding(SessionId("2"));
  f.sessions.handleSessionStatus(SessionId("2"), false);
  await flush();
  await f.append("2", "unvisited final reply");
  expect(f.sessions.binding(SessionId("2"))).toBe(unvisited);
  expect(unvisited?.eventSource.getSnapshot().entries.at(-1)?.event.data).toEqual({
    text: "unvisited final reply",
  });
  f.sessions.handleControlFrame({
    type: "projection",
    sessionId: SessionId("0"),
    key: "subagentCatalog",
    seq: 4,
    value: [{ id: "child", createdAt: 1, mode: "one-shot" }],
  });
  await flush();
  expect(f.sessions.list.getSnapshot().byId[SessionId("child")]).toBeDefined();
  expect(f.requests).toHaveLength(3);
  const child = await f.open("child");
  await f.open("1");
  expect(await f.open("child")).toBe(child);
  expect(f.requests).toHaveLength(4);
});

it("bounds stopped warm references, preserves other consumers, and cleans archive/removal/root lifetimes", async () => {
  const f = await fixture(["10"]);
  const first = await f.open("0");
  const other = f.sessions.retain(SessionId("0"), { source: "controllerOperation" });
  for (let i = 1; i <= 8; i++) await f.open(String(i));
  expect(f.sessions.binding(SessionId("0"))).toBe(first);
  expect(f.sessions.retainInfo(SessionId("0")).getSnapshot().retainedBy).toEqual({
    controllerOperation: 1,
  });
  const warm = Object.values(f.sessions.list.getSnapshot().byId).filter(
    (row) => row.retainedBy.backgroundWarm,
  );
  expect(warm).toHaveLength(9); // eight stopped (including main), plus one running
  other.release();
  await flush();
  expect(f.sessions.binding(SessionId("0"))).toBeUndefined();
  f.workspace.set({
    ...f.workspace.getSnapshot(),
    archivedSessionIds: [SessionId("1"), SessionId("8"), SessionId("10")],
  });
  f.sessions.handleSessionRemoved(SessionId("2"));
  await flush();
  for (const id of ["1", "2", "8", "10"]) expect(f.sessions.binding(SessionId(id))).toBeUndefined();
  await f.ctx.fiber.dispose();
  await flush();
  expect(f.feeds.size).toBe(0);
  expect(f.closed).toHaveLength(f.requests.length);
});

it("resumes multiple retained Sessions with their own epoch/cursor after a real generation change", async () => {
  const f = await fixture(["0", "1"]);
  const a = await f.open("0");
  const b = await f.open("1");
  await f.append("0", "a delta");
  await f.append("1", "b delta");
  f.generation.set(undefined);
  // A physical carrier loss ends each logical stream's current iterator.
  f.feeds.get("0")?.(undefined);
  f.feeds.get("1")?.(undefined);
  await flush();
  // Pending transport/catalog data must not look like deletion.
  const catalog = f.sessions.list.getSnapshot();
  f.sessions.list.set({ ...catalog, phase: "pending", ids: [], byId: {} });
  expect(f.sessions.binding(SessionId("0"))).toBe(a);
  expect(f.sessions.binding(SessionId("1"))).toBe(b);
  f.sessions.list.set(catalog);
  f.generation.set({ id: 2 });
  await flush();
  expect(f.requests.slice(-2).map((r) => r.resume)).toEqual([
    { epoch: "epoch-0", cursor: 1 },
    { epoch: "epoch-1", cursor: 1 },
  ]);
  expect(await f.open("0")).toBe(a);
  expect(await f.open("1")).toBe(b);
  expect(a.eventSource.getSnapshot().entries).toHaveLength(2);
  expect(b.eventSource.getSnapshot().entries).toHaveLength(2);
});

it("recovers failed background opens on reconnect without hot-looping or warming refused navigation", async () => {
  const runningIds: string[] = [];
  const f = await fixture(runningIds);
  const a = await f.open("0");
  await expect(
    f.navigation.openWorkspace(null, () => {
      throw new Error("draft blocked");
    }),
  ).rejects.toThrow("draft blocked");
  expect(
    f.sessions.retainInfo(SessionId("11")).getSnapshot().retainedBy.backgroundWarm,
  ).toBeUndefined();
  expect(await f.open("0")).toBe(a);
  f.failing.add("10");
  runningIds.push("10");
  f.sessions.handleSessionStatus(SessionId("10"), true);
  await flush();
  const failedBinding = f.sessions.binding(SessionId("10"));
  expect(failedBinding?.session.getSnapshot().openState).toBe("error");
  for (let i = 0; i < 3; i++) {
    f.sessions.handleSessionActivity(SessionId("0"), i + 2);
    await f.sessions.refresh();
    await flush();
  }
  expect(
    f.requests.filter((r) => r.address.kind === "session" && r.address.sessionId === "10"),
  ).toHaveLength(1);
  f.generation.set(undefined);
  f.feeds.get("0")?.(undefined);
  await flush();
  f.failing.delete("10");
  expect(f.sessions.list.getSnapshot().phase).toBe("ready");
  f.generation.set({ id: 2 });
  f.sessions.handleConnected();
  f.sessions.handleControlFrame({ type: "baseline", value: { projections: {} } });
  await flush();
  expect(
    f.requests.filter((r) => r.address.kind === "session" && r.address.sessionId === "10"),
  ).toHaveLength(2);
  const recovered = f.sessions.binding(SessionId("10"));
  expect(recovered).toBe(failedBinding);
  expect(recovered?.session.getSnapshot().openState).toBe("open");
  await f.append("10", "recovered without a visit");
  expect(recovered?.eventSource.getSnapshot().entries.at(-1)?.event.data).toEqual({
    text: "recovered without a visit",
  });
  expect(f.sessions.retainInfo(SessionId("10")).getSnapshot().retainedBy).toEqual({
    backgroundWarm: 1,
  });
  await recovered!.ctx.fiber.dispose();
  await a.ctx.fiber.dispose();
  await flush();
  await f.sessions.refresh();
  await flush();
  expect(f.sessions.binding(SessionId("10"))).toBeUndefined();
  expect(
    f.requests.filter((r) => r.address.kind === "session" && r.address.sessionId === "10"),
  ).toHaveLength(2);
  expect(f.sessions.binding(SessionId("0"))).toBeUndefined();
  expect(f.sessions.retainInfo(SessionId("0")).getSnapshot().referenceCount).toBe(0);
});
