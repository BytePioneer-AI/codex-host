import { describe, expect, it, vi } from "vitest";

import { DelegationControlRegistry } from "../src/delegation-control-registry.js";
import type { DelegationControlRegistration } from "../src/delegation-types.js";

function registration(threadId: string): DelegationControlRegistration {
  return {
    listHarnesses: vi.fn(async () => ({ harnesses: ["codex" as const, "pi" as const] })),
    inspect: vi.fn(async (input) => ({
      harnessId: input.harnessId,
      inspection: {
        status: "ready" as const,
        catalog: { models: [], thinkingOptions: [] },
        capabilities: {
          configuration: {
            selectModel: false,
            selectThinkingOption: false,
            selectPermissionMode: false,
            permissionModeScope: "live" as const,
          },
          history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
        },
      },
    })),
    canHandleStart: (input) => input.parentThreadId === threadId,
    ownsThread: (candidate) => candidate === threadId,
    start: vi.fn(async () => ({
      delegationId: `delegation-${threadId}`,
      threadId: `child-${threadId}`,
      turnId: `turn-${threadId}`,
      harnessId: "pi" as const,
      deepLink: `codex://threads/child-${threadId}`,
      status: "running" as const,
      next: { read: "read", wait: "wait" },
    })),
    send: vi.fn(async () => ({
      threadId,
      turnId: `turn-${threadId}`,
      harnessId: "pi" as const,
      status: "running" as const,
      next: { read: "read", wait: "wait" },
    })),
    cancel: vi.fn(async () => ({
      threadId,
      turnId: null,
      harnessId: "pi" as const,
      cancelled: false,
    })),
    read: vi.fn(async () => ({
      threadId,
      harnessId: "pi" as const,
      status: "running" as const,
      turn: null,
      progress: [],
      result: { availability: "pending" as const },
      messages: [],
      nextCursor: null,
    })),
    wait: vi.fn(async () => ({
      threadId,
      harnessId: "pi" as const,
      status: "running" as const,
      turn: null,
      progress: [],
      result: { availability: "pending" as const },
      messages: [],
      nextCursor: null,
      timedOut: true,
    })),
    list: vi.fn(async () => ({ threads: [], nextCursor: null })),
  };
}

describe("DelegationControlRegistry", () => {
  it("uses only the calling Thread's execution identity for same-Host reads", async () => {
    const caller = registration("caller");
    caller.executionHostId = (id) => (id === "caller" ? "ssh:mac" : undefined);
    const target = registration("target");
    const remoteRead = vi.fn(async (input: unknown) => {
      void input;
      throw new Error("remote unavailable");
    });
    const registry = new DelegationControlRegistry({ remoteRead });
    registry.register(caller);
    registry.register(target);
    const input = {
      threadId: "target",
      view: "result" as const,
      hostId: "ssh:mac",
      callerThreadId: "caller",
    };
    expect(await registry.read(input)).toMatchObject({ hostId: "ssh:mac", threadId: "target" });
    expect(target.read).toHaveBeenCalledExactlyOnceWith({ threadId: "target", view: "result" });
    expect(remoteRead).not.toHaveBeenCalled();
    for (const read of [
      { threadId: input.threadId, hostId: input.hostId, view: input.view },
      { ...input, callerThreadId: "different-client" },
      { ...input, hostId: "ssh:other" },
    ])
      await expect(registry.read(read)).rejects.toThrow("remote unavailable");
    expect(target.read).toHaveBeenCalledOnce();
    expect(remoteRead.mock.calls.at(-1)?.[0]).not.toHaveProperty("callerThreadId");
    registry.close();
  });

  it("fails closed on ambiguous caller context", async () => {
    const registry = new DelegationControlRegistry();
    for (let index = 0; index < 2; index++) {
      const caller = registration("caller");
      caller.executionHostId = () => "ssh:mac";
      registry.register(caller);
    }
    await expect(
      registry.read({
        callerThreadId: "caller",
        threadId: "target",
        hostId: "ssh:mac",
        view: "result",
      }),
    ).rejects.toMatchObject({ code: "PARENT_THREAD_AMBIGUOUS" });
    registry.close();
  });
  it("uses the shared SSH catalog with multiple GUI sessions while keeping command ownership", async () => {
    const registry = new DelegationControlRegistry();
    const owner = registration("shared");
    const native = registration("native");
    const unregister = registry.register(owner, { harnessCatalog: true });
    registry.register(native);
    await registry.listHarnesses();
    await registry.inspect({ harnessId: "pi" });
    await registry.list({ sort: "updated-desc", limit: 20 });
    expect(owner.listHarnesses).toHaveBeenCalledOnce();
    expect(owner.inspect).toHaveBeenCalledOnce();
    expect(owner.list).toHaveBeenCalledOnce();
    expect(native.list).not.toHaveBeenCalled();
    await registry.send({ threadId: "native", message: "continue" });
    expect(native.send).toHaveBeenCalledOnce();
    expect(owner.send).not.toHaveBeenCalled();
    unregister();
    await registry.listHarnesses();
    expect(native.listHarnesses).toHaveBeenCalledOnce();
  });
  it("discovers targets from the active session without inspecting Models", async () => {
    const registry = new DelegationControlRegistry();
    const session = registration("parent");
    registry.register(session);
    await expect(registry.listHarnesses()).resolves.toEqual({ harnesses: ["codex", "pi"] });
    expect(session.inspect).not.toHaveBeenCalled();
    registry.register(registration("another-parent"));
    await expect(registry.listHarnesses()).rejects.toMatchObject({
      code: "PARENT_THREAD_AMBIGUOUS",
    });
  });
  it("routes explicit parent and Thread operations to the owning Host session", async () => {
    const registry = new DelegationControlRegistry();
    const first = registration("parent-a");
    const second = registration("parent-b");
    registry.register(first);
    registry.register(second);

    await expect(registry.inspect({ harnessId: "pi" })).rejects.toMatchObject({
      code: "PARENT_THREAD_AMBIGUOUS",
    });
    await registry.start({
      harnessId: "pi" as const,
      task: "review",
      cwd: "/synthetic",
      parentThreadId: "parent-b",
    });
    await registry.read({ threadId: "parent-a", view: "result" });
    await registry.send({ threadId: "parent-b", message: "continue" });
    await registry.cancel({ threadId: "parent-a" });

    expect(second.start).toHaveBeenCalledOnce();
    expect(first.read).toHaveBeenCalledOnce();
    expect(second.send).toHaveBeenCalledOnce();
    expect(first.cancel).toHaveBeenCalledOnce();
  });

  it("requires a unique active session for implicit start and unscoped list", async () => {
    const registry = new DelegationControlRegistry();
    registry.register(registration("parent-a"));
    registry.register(registration("parent-b"));

    await expect(
      registry.start({ harnessId: "pi" as const, task: "review", cwd: "/synthetic" }),
    ).rejects.toMatchObject({ code: "PARENT_THREAD_AMBIGUOUS" });
    await expect(
      registry.list({ cwd: "/synthetic", limit: 25, sort: "created-desc" }),
    ).resolves.toEqual({ threads: [], nextCursor: null });
  });

  it("unregisters closed Host sessions", async () => {
    const registry = new DelegationControlRegistry();
    const unregister = registry.register(registration("parent-a"));
    expect(registry.size).toBe(1);
    unregister();
    expect(registry.size).toBe(0);
    await expect(registry.read({ threadId: "parent-a", view: "result" })).rejects.toMatchObject({
      code: "PARENT_THREAD_AMBIGUOUS",
    });
  });

  it("watches a Thread in one session and notifies a Thread in another", async () => {
    vi.useFakeTimers();
    try {
      const registry = new DelegationControlRegistry();
      const watched = registration("child");
      const subscriber = registration("parent");
      registry.register(watched);
      registry.register(subscriber);
      await expect(
        registry.watch({ threadId: "child", notifyThreadId: "parent", timeoutMs: 60_000 }),
      ).resolves.toMatchObject({ state: "watching" });

      vi.mocked(watched.read).mockResolvedValue({
        threadId: "child",
        harnessId: "pi",
        status: "completed",
        turn: null,
        progress: [],
        result: { availability: "available", text: "done" },
        nextCursor: null,
      });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(subscriber.send).toHaveBeenCalledTimes(1);
      expect(vi.mocked(subscriber.send).mock.calls[0]?.[0]).toMatchObject({ threadId: "parent" });
      expect(watched.send).not.toHaveBeenCalled();

      // Closing drops remaining watches with the Host Runtime.
      await registry.watch({ threadId: "parent", notifyThreadId: "child", timeoutMs: 60_000 });
      registry.close();
      await expect(registry.watches()).resolves.toEqual({ watches: [] });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never infers the notified Thread", async () => {
    const registry = new DelegationControlRegistry();
    const session = registration("child");
    session.ownsThread = () => true;
    registry.register(session);
    await expect(
      registry.watch({ threadId: "child", notifyThreadId: "", timeoutMs: 60_000 }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(session.read).not.toHaveBeenCalled();
    registry.close();
  });
});

describe("DelegationControlRegistry list paging across sessions", () => {
  type Row = Awaited<ReturnType<DelegationControlRegistration["list"]>>["threads"][number];
  type Sort = Parameters<DelegationControlRegistration["list"]>[0]["sort"];

  const order = (sort: Sort) => (left: Row, right: Row) => {
    const field = sort.startsWith("created") ? "createdAt" : "updatedAt";
    const direction = sort.endsWith("asc") ? 1 : -1;
    return (
      (Date.parse(left[field] ?? "") - Date.parse(right[field] ?? "")) * direction ||
      left.threadId.localeCompare(right.threadId)
    );
  };

  /** A session that pages its own Threads with an opaque offset cursor, like the coordinator. */
  function session(name: string, rows: Row[]): DelegationControlRegistration {
    const value = registration(`parent-${name}`);
    value.list = vi.fn(async ({ limit, cursor, sort }) => {
      const sorted = [...rows].sort(order(sort));
      const start = cursor ? Number(Buffer.from(cursor, "base64url").toString("utf8")) : 0;
      const end = start + limit;
      return {
        threads: sorted.slice(start, end),
        nextCursor: end < sorted.length ? Buffer.from(String(end)).toString("base64url") : null,
      };
    });
    return value;
  }

  function threads(name: string, count: number, offsetMinutes: number): Row[] {
    return Array.from({ length: count }, (_, index) => ({
      threadId: `${name}-${String(index).padStart(2, "0")}`,
      harnessId: "pi" as const,
      deepLink: `codex://threads/${name}-${index}`,
      status: "completed" as const,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, index * 2 + offsetMinutes)).toISOString(),
      // Reverse the update order so updated-* sorts interleave differently from created-*.
      updatedAt: new Date(
        Date.UTC(2026, 0, 2, 0, (count - index) * 3 + offsetMinutes),
      ).toISOString(),
    }));
  }

  async function pageAll(
    registry: DelegationControlRegistry,
    sort: Sort,
    limits: number[],
  ): Promise<{ ids: string[]; pages: number }> {
    const ids: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const limit = limits[pages % limits.length] ?? 25;
      const page = await registry.list({
        cwd: "/synthetic",
        limit,
        sort,
        ...(cursor ? { cursor } : {}),
      });
      expect(page.threads.length).toBeLessThanOrEqual(limit);
      ids.push(...page.threads.map(({ threadId }) => threadId));
      cursor = page.nextCursor ?? undefined;
      pages += 1;
      expect(pages).toBeLessThan(100);
    } while (cursor);
    return { ids, pages };
  }

  it.each<[Sort, number[]]>([
    ["created-desc", [25]],
    ["updated-asc", [7]],
    ["created-asc", [10, 3, 17]],
  ])("pages through 60 Threads in two sessions sorted %s", async (sort, limits) => {
    const first = threads("a", 30, 0);
    const second = threads("b", 30, 1);
    const registry = new DelegationControlRegistry();
    registry.register(session("a", first));
    registry.register(session("b", second));

    const { ids, pages } = await pageAll(registry, sort, limits);
    const expected = [...first, ...second].sort(order(sort)).map(({ threadId }) => threadId);
    expect(ids).toEqual(expected);
    expect(new Set(ids).size).toBe(60);
    if (limits.length === 1) expect(pages).toBe(Math.ceil(60 / (limits[0] ?? 1)));
    registry.close();
  });

  it("pages through sessions of different sizes, including an empty one", async () => {
    const registry = new DelegationControlRegistry();
    const rows = threads("a", 9, 0);
    registry.register(session("a", rows));
    registry.register(session("empty", []));
    registry.register(session("c", threads("c", 4, 1)));
    const { ids } = await pageAll(registry, "created-desc", [4]);
    expect(ids).toHaveLength(13);
    expect(new Set(ids).size).toBe(13);
    registry.close();
  });

  it("keeps the single-session cursor unchanged", async () => {
    const registry = new DelegationControlRegistry();
    const only = session("a", threads("a", 30, 0));
    registry.register(only);
    const first = await registry.list({ cwd: "/synthetic", limit: 25, sort: "created-desc" });
    expect(first.nextCursor).toBe(Buffer.from("25").toString("base64url"));
    await registry.list({
      cwd: "/synthetic",
      limit: 25,
      sort: "created-desc",
      cursor: first.nextCursor ?? "",
    });
    expect(only.list).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: first.nextCursor }),
    );
    registry.close();
  });

  it("rejects a merged cursor after a session re-registers", async () => {
    const registry = new DelegationControlRegistry();
    const a = session("a", threads("a", 30, 0));
    const b = session("b", threads("b", 30, 1));
    const unregisterA = registry.register(a);
    registry.register(b);
    const first = await registry.list({ cwd: "/synthetic", limit: 5, sort: "created-desc" });
    expect(first.nextCursor).not.toBeNull();

    // Same session count, but iteration order is now b, a: the old positions would be swapped.
    unregisterA();
    registry.register(a);
    await expect(
      registry.list({
        cwd: "/synthetic",
        limit: 5,
        sort: "created-desc",
        cursor: first.nextCursor ?? "",
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    registry.close();
  });

  it("rejects a merged cursor once only one session is left", async () => {
    const registry = new DelegationControlRegistry();
    const a = session("a", threads("a", 30, 0));
    const b = session("b", threads("b", 30, 1));
    registry.register(a);
    const unregisterB = registry.register(b);
    const first = await registry.list({ cwd: "/synthetic", limit: 5, sort: "created-desc" });
    expect(first.nextCursor).not.toBeNull();

    unregisterB();
    vi.mocked(a.list).mockClear();
    await expect(
      registry.list({
        cwd: "/synthetic",
        limit: 5,
        sort: "created-desc",
        cursor: first.nextCursor ?? "",
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      message: "List cursor does not match the active Host Runtime sessions",
    });
    expect(a.list).not.toHaveBeenCalled();
    registry.close();
  });

  it("rejects a merged cursor from another Registry or with an invalid session position", async () => {
    const build = () => {
      const registry = new DelegationControlRegistry();
      registry.register(session("a", threads("a", 30, 0)));
      registry.register(session("b", threads("b", 30, 1)));
      return registry;
    };
    const original = build();
    const first = await original.list({ cwd: "/synthetic", limit: 5, sort: "created-desc" });
    const cursor = first.nextCursor ?? "";
    const rebuilt = build();
    await expect(
      rebuilt.list({ cwd: "/synthetic", limit: 5, sort: "created-desc", cursor }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });

    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      sessions: ({ cursor: string | null } | null)[];
    };
    const position = decoded.sessions.find((entry) => entry !== null);
    if (!position) throw new Error("Expected an open session position");
    position.cursor = "";
    await expect(
      original.list({
        cwd: "/synthetic",
        limit: 5,
        sort: "created-desc",
        cursor: Buffer.from(JSON.stringify(decoded)).toString("base64url"),
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    original.close();
    rebuilt.close();
  });

  it.each(["parent", "catalog"])("does not forward merged cursors to a %s list", async (target) => {
    const registry = new DelegationControlRegistry();
    const a = session("a", threads("a", 10, 0));
    const b = session("b", threads("b", 10, 1));
    registry.register(a);
    registry.register(b);
    try {
      const first = await registry.list({ cwd: "/synthetic", limit: 2, sort: "created-desc" });
      vi.mocked(a.list).mockClear();
      vi.mocked(b.list).mockClear();
      if (target === "catalog") registry.register(a, { harnessCatalog: true });
      await expect(
        registry.list({
          cwd: "/synthetic",
          limit: 2,
          sort: "created-desc",
          cursor: first.nextCursor ?? "",
          ...(target === "parent" ? { parentThreadId: "parent-a" } : {}),
        }),
      ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
      expect(a.list).not.toHaveBeenCalled();
      expect(b.list).not.toHaveBeenCalled();
    } finally {
      registry.close();
    }
  });

  it("rejects malformed merged cursors", async () => {
    const registry = new DelegationControlRegistry();
    registry.register(session("a", threads("a", 30, 0)));
    registry.register(session("b", threads("b", 30, 1)));
    const first = await registry.list({ cwd: "/synthetic", limit: 5, sort: "created-desc" });
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const issued = JSON.parse(Buffer.from(first.nextCursor ?? "", "base64url").toString("utf8"));
    for (const cursor of [
      "not a cursor",
      Buffer.from("{").toString("base64url"),
      encode([]),
      encode({ ...issued, v: 1 }),
      encode({ ...issued, cwd: undefined }),
      encode({ ...issued, sessions: [{ cursor: "" }, null] }),
      encode({ ...issued, sessions: [{ cursor: 1 }, null] }),
      encode({ ...issued, sessions: [{}, null] }),
      encode({ ...issued, sessions: [[null, 0, 5], null] }),
      encode({ ...issued, sessions: [null] }),
    ]) {
      await expect(
        registry.list({ cwd: "/synthetic", limit: 5, sort: "created-desc", cursor }),
      ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    }
    // A cursor only continues the sort it was issued for.
    await expect(
      registry.list({
        cwd: "/synthetic",
        limit: 5,
        sort: "updated-desc",
        cursor: first.nextCursor ?? "",
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    registry.close();
  });
});
