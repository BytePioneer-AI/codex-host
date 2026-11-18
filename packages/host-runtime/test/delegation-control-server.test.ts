import { describe, expect, it, vi } from "vitest";

import { startDelegationControlServer } from "../src/delegation-control-server.js";
import { projectDelegationThreadSnapshot } from "../src/delegation-snapshot.js";
import {
  DEFAULT_WATCH_TIMEOUT_MS,
  type ThreadReadInput,
  type ThreadWaitInput,
} from "../src/delegation-types.js";
import { externalClientRouter } from "../src/external-client-routes.js";

const token = "synthetic-token";

function authorized(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

describe("delegation control server", () => {
  it("reads whole Turn ranges over HTTP and rejects invalid and removed arguments", async () => {
    const turns = Array.from({ length: 60 }, (_, index) => ({
      id: `t${index + 1}`,
      status: "completed",
      items: [],
    }));
    const read = vi.fn(async (input: ThreadReadInput) =>
      projectDelegationThreadSnapshot({
        ...input,
        harnessId: "pi",
        thread: {},
        turns,
        running: false,
      }),
    );
    const wait = vi.fn(async (input: ThreadWaitInput) => ({
      ...(await read(input)),
      timedOut: false,
    }));
    const server = await startDelegationControlServer({
      token,
      api: {
        listHarnesses: vi.fn(),
        inspect: vi.fn(),
        answer: vi.fn(),
        start: vi.fn(),
        send: vi.fn(),
        cancel: vi.fn(),
        read,
        wait,
        list: vi.fn(),
      },
    });
    try {
      for (const command of ["read", "wait"]) {
        const base = {
          threadId: "thread",
          view: "messages",
          ...(command === "wait" ? { timeoutMs: 10 } : {}),
        };
        const request = (bounds: Record<string, unknown>) =>
          fetch(`${server.endpoint}/v1/thread/${command}`, authorized({ ...base, ...bounds }));
        const latest = await request({});
        expect(latest.status).toBe(200);
        expect(await latest.json()).toMatchObject({ totalTurns: 60, from: 51, to: 60 });
        const selected = await request({ from: 3, to: 5 });
        expect(await selected.json()).toMatchObject({
          totalTurns: 60,
          from: 3,
          to: 5,
          turns: [{ turnNumber: 5 }, { turnNumber: 4 }, { turnNumber: 3 }],
        });
        for (const bounds of [
          { from: "3" },
          { to: 0 },
          { from: 1.5 },
          { from: 5, to: 3 },
          { from: 1, to: 60 },
          { cursor: "old" },
          { limit: 10 },
        ]) {
          const invalid = await request(bounds);
          expect(invalid.status).toBe(400);
          expect(await invalid.json()).toMatchObject({ error: { code: "INVALID_ARGUMENT" } });
        }
      }
    } finally {
      await server.close();
    }
  });

  it("binds loopback, authenticates requests, and dispatches structured inputs", async () => {
    const start = vi.fn(async () => ({
      delegationId: "delegation-1",
      threadId: "thread-1",
      turnId: "turn-1",
      harnessId: "pi" as const,
      deepLink: "codex://threads/thread-1",
      status: "running" as const,
      next: { read: "read", wait: "wait" },
    }));
    const listHarnesses = vi.fn(async () => ({ harnesses: ["codex" as const, "pi" as const] }));
    const server = await startDelegationControlServer({
      token,
      api: {
        listHarnesses,
        inspect: vi.fn(),
        start,
        send: vi.fn(),
        cancel: vi.fn(),
        answer: vi.fn(),
        read: vi.fn(),
        wait: vi.fn(),
        list: vi.fn(),
      },
    });
    try {
      expect(new URL(server.endpoint).hostname).toBe("127.0.0.1");
      const unauthorized = await fetch(`${server.endpoint}/v1/delegate/start`, {
        method: "POST",
        body: "{}",
      });
      expect(unauthorized.status).toBe(401);
      await expect(unauthorized.json()).resolves.toMatchObject({
        error: { code: "RUNTIME_UNREACHABLE" },
      });
      for (const header of [`Bearer ${token}x`, `Bearer ${token.slice(1)}`, token]) {
        const rejected = await fetch(`${server.endpoint}/v1/delegate/start`, {
          method: "POST",
          headers: { authorization: header },
          body: "{}",
        });
        expect(rejected.status, header).toBe(401);
      }

      const response = await fetch(
        `${server.endpoint}/v1/delegate/start`,
        authorized({ harnessId: "pi", task: "review", cwd: "/synthetic" }),
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ threadId: "thread-1" });
      expect(start).toHaveBeenCalledWith({ harnessId: "pi", task: "review", cwd: "/synthetic" });
      const harnesses = await fetch(
        `${server.endpoint}/v1/harness/list`,
        authorized({ parentThreadId: "caller" }),
      );
      await expect(harnesses.json()).resolves.toEqual({ harnesses: ["codex", "pi"] });
      expect(listHarnesses).toHaveBeenCalledWith({ parentThreadId: "caller" });
      expect(start).toHaveBeenCalledTimes(1);
    } finally {
      await server.close();
    }
  });

  it("dispatches Harness inspection", async () => {
    const inspect = vi.fn(async () => ({
      harnessId: "pi" as const,
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
    }));
    const server = await startDelegationControlServer({
      token,
      api: {
        listHarnesses: vi.fn(async () => ({ harnesses: ["codex" as const, "pi" as const] })),
        inspect,
        start: vi.fn(),
        send: vi.fn(),
        cancel: vi.fn(),
        answer: vi.fn(),
        read: vi.fn(),
        wait: vi.fn(),
        list: vi.fn(),
      },
    });
    try {
      const response = await fetch(
        `${server.endpoint}/v1/harness/inspect`,
        authorized({ harnessId: "pi", cwd: "/synthetic", refresh: true }),
      );
      expect(response.status).toBe(200);
      expect(inspect).toHaveBeenCalledWith({ harnessId: "pi", cwd: "/synthetic", refresh: true });
    } finally {
      await server.close();
    }
  });

  it("dispatches thread send and cancel", async () => {
    const send = vi.fn(async () => ({
      threadId: "thread-1",
      turnId: "turn-2",
      harnessId: "pi" as const,
      status: "running" as const,
      next: { read: "read", wait: "wait" },
    }));
    const cancel = vi.fn(async () => ({
      threadId: "thread-1",
      turnId: "turn-2",
      harnessId: "pi" as const,
      cancelled: true,
    }));
    const answer = vi.fn(async () => ({
      threadId: "thread-1",
      interactionId: "interaction-1",
      turnId: "turn-2",
      harnessId: "pi" as const,
      status: "running" as const,
      next: { read: "read", wait: "wait" },
    }));
    const server = await startDelegationControlServer({
      token,
      api: {
        listHarnesses: vi.fn(async () => ({ harnesses: ["codex" as const, "pi" as const] })),
        inspect: vi.fn(),
        start: vi.fn(),
        send,
        cancel,
        answer,
        read: vi.fn(),
        wait: vi.fn(),
        list: vi.fn(),
      },
    });
    try {
      await fetch(
        `${server.endpoint}/v1/thread/send`,
        authorized({ threadId: "thread-1", message: "continue" }),
      );
      await fetch(`${server.endpoint}/v1/thread/cancel`, authorized({ threadId: "thread-1" }));
      const answered = await fetch(
        `${server.endpoint}/v1/thread/answer`,
        authorized({
          threadId: "thread-1",
          interactionId: "interaction-1",
          result: { answers: { decision: { answers: ["continue"] } } },
        }),
      );
      expect(send).toHaveBeenCalledWith({ threadId: "thread-1", message: "continue" });
      expect(cancel).toHaveBeenCalledWith({ threadId: "thread-1" });
      expect(answer).toHaveBeenCalledWith({
        threadId: "thread-1",
        interactionId: "interaction-1",
        result: { answers: { decision: { answers: ["continue"] } } },
      });
      await expect(answered.json()).resolves.toMatchObject({
        interactionId: "interaction-1",
        status: "running",
      });
    } finally {
      await server.close();
    }
  });

  it("returns the common JSON error envelope", async () => {
    const server = await startDelegationControlServer({
      token,
      api: {
        listHarnesses: vi.fn(async () => ({ harnesses: ["codex" as const, "pi" as const] })),
        inspect: vi.fn(),
        start: vi.fn(),
        send: vi.fn(),
        cancel: vi.fn(),
        answer: vi.fn(),
        read: vi.fn(async () => {
          throw new Error("synthetic failure");
        }),
        wait: vi.fn(),
        list: vi.fn(),
      },
    });
    try {
      const response = await fetch(
        `${server.endpoint}/v1/thread/read`,
        authorized({ threadId: "thread-1", view: "result" }),
      );
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({
        error: { code: "INTERNAL_ERROR", message: "synthetic failure" },
      });
    } finally {
      await server.close();
    }
  });

  it("registers a watch on the delegated child for the Host-resolved parent", async () => {
    const started = {
      delegationId: "delegation-1",
      threadId: "child",
      turnId: "turn-1",
      harnessId: "pi" as const,
      deepLink: "codex://threads/child",
      status: "running" as const,
      next: { read: "read", wait: "wait" },
    };
    const start = vi.fn(async (): Promise<typeof started & { parentThreadId?: string }> => ({
      ...started,
      parentThreadId: "parent",
    }));
    const watch = vi.fn(async (input: { threadId: string; notifyThreadId: string }) => ({
      threadId: input.threadId,
      notifyThreadId: input.notifyThreadId,
      state: "watching" as const,
      status: "running" as const,
      timeoutMs: 5_000,
    }));
    const api = {
      listHarnesses: vi.fn(),
      inspect: vi.fn(),
      start,
      send: vi.fn(),
      cancel: vi.fn(),
      answer: vi.fn(),
      read: vi.fn(),
      wait: vi.fn(),
      list: vi.fn(),
    };
    const server = await startDelegationControlServer({
      token,
      api,
      watchApi: { watch, watches: vi.fn(async () => ({ watches: [] })) },
    });
    const unsupported = await startDelegationControlServer({ token, api });
    try {
      const response = await fetch(
        `${server.endpoint}/v1/delegate/start`,
        authorized({ harnessId: "pi", task: "work", watchTimeoutMs: 5_000 }),
      );
      await expect(response.json()).resolves.toMatchObject({
        threadId: "child",
        watch: { state: "watching", notifyThreadId: "parent" },
      });
      // The watch option never reaches the Host session's start operation.
      expect(start).toHaveBeenCalledWith({ harnessId: "pi", task: "work" });
      expect(watch).toHaveBeenCalledWith({
        threadId: "child",
        notifyThreadId: "parent",
        timeoutMs: 5_000,
      });

      watch.mockRejectedValueOnce(new Error("synthetic watch failure"));
      const failed = await fetch(
        `${server.endpoint}/v1/delegate/start`,
        authorized({ harnessId: "pi", task: "work", watchTimeoutMs: 5_000 }),
      );
      expect(failed.status).toBe(200);
      await expect(failed.json()).resolves.toMatchObject({
        threadId: "child",
        watch: { state: "notRegistered", reason: "synthetic watch failure" },
      });

      // Without a Host-resolved parent the watch is reported as not registered.
      start.mockResolvedValueOnce(started);
      watch.mockRejectedValueOnce(new Error("Notified Thread is required; pass --notify <thread>"));
      const orphan = await fetch(
        `${server.endpoint}/v1/delegate/start`,
        authorized({ harnessId: "pi", task: "work", watchTimeoutMs: 5_000 }),
      );
      await expect(orphan.json()).resolves.toMatchObject({
        watch: { state: "notRegistered", reason: expect.stringContaining("--notify") },
      });
      expect(watch).toHaveBeenLastCalledWith({
        threadId: "child",
        notifyThreadId: "",
        timeoutMs: 5_000,
      });

      const rejected = await fetch(
        `${unsupported.endpoint}/v1/thread/watch`,
        authorized({ threadId: "child", notifyThreadId: "parent", timeoutMs: 5_000 }),
      );
      expect(rejected.status).toBe(400);
    } finally {
      await server.close();
      await unsupported.close();
    }
  });

  describe("optional request fields", () => {
    const started = {
      delegationId: "delegation-1",
      threadId: "thread-1",
      turnId: "turn-1",
      harnessId: "pi" as const,
      deepLink: "codex://threads/thread-1",
      status: "running" as const,
      next: { read: "read", wait: "wait" },
    };
    const snapshot = {
      threadId: "thread-1",
      harnessId: "pi" as const,
      status: "completed" as const,
      turn: null,
      progress: [],
      result: { availability: "pending" as const },
    };

    function setup() {
      const api = {
        listHarnesses: vi.fn(),
        inspect: vi.fn(),
        answer: vi.fn(),
        send: vi.fn(),
        cancel: vi.fn(),
        start: vi.fn(async () => ({ ...started, parentThreadId: "client:bot" })),
        read: vi.fn(async () => snapshot),
        wait: vi.fn(async () => ({ ...snapshot, timedOut: false })),
        list: vi.fn(async () => ({ threads: [], nextCursor: null })),
      };
      const watch = vi.fn(async (input: { threadId: string; timeoutMs: number }) => ({
        ...input,
        notifyThreadId: "client:bot",
        state: "watching" as const,
        status: "running" as const,
      }));
      return { api, watch, watchApi: { watch, watches: vi.fn() } };
    }

    // The request shapes http-events.{zh,en}.mdx documents, sent through the
    // external client router like a bot with a client token would.
    it.each([
      [
        "/v1/delegate/start",
        { harness: "pi", task: "t" },
        "start",
        { harnessId: "pi", task: "t", parentThreadId: "client:bot" },
      ],
      [
        "/v1/delegate/start",
        { harnessId: "pi", task: "t" },
        "start",
        { harnessId: "pi", task: "t", parentThreadId: "client:bot" },
      ],
      [
        "/v1/delegate/start",
        { harness: "pi", harnessId: "pi", task: "t" },
        "start",
        { harnessId: "pi", task: "t", parentThreadId: "client:bot" },
      ],
      [
        "/v1/thread/read",
        { threadId: "thread-1" },
        "read",
        { threadId: "thread-1", view: "result" },
      ],
      [
        "/v1/thread/read",
        { threadId: "thread-1", view: "messages" },
        "read",
        { threadId: "thread-1", view: "messages" },
      ],
      [
        "/v1/thread/wait",
        { threadId: "thread-1" },
        "wait",
        { threadId: "thread-1", view: "result", timeoutMs: 30_000 },
      ],
      [
        "/v1/thread/wait",
        { threadId: "thread-1", timeoutMs: 1000 },
        "wait",
        { threadId: "thread-1", view: "result", timeoutMs: 1000 },
      ],
      ["/v1/thread/list", {}, "list", { limit: 25, sort: "created-desc" }],
      ["/v1/thread/list", { limit: 3 }, "list", { limit: 3, sort: "created-desc" }],
      [
        "/v1/thread/list",
        { limit: 3, client: "other" },
        "list",
        { limit: 3, client: "other", sort: "created-desc" },
      ],
      [
        "/v1/thread/list",
        { limit: 3, sort: "updated-asc" },
        "list",
        { limit: 3, sort: "updated-asc" },
      ],
    ] as const)("%s %j reaches the Host as %j", async (route, body, method, expected) => {
      const { api, watchApi } = setup();
      const router = externalClientRouter({ api, watchApi });
      await router({ client: "bot" } as Parameters<typeof router>[0], route, { ...body });
      expect(api[method]).toHaveBeenCalledExactlyOnceWith(expected);
    });

    it("defaults the watch timeout to the CLI's", async () => {
      const { api, watch, watchApi } = setup();
      const router = externalClientRouter({ api, watchApi });
      const call = { client: "bot" } as Parameters<typeof router>[0];
      await router(call, "/v1/thread/watch", { threadId: "thread-1" });
      await router(call, "/v1/thread/watch", { threadId: "thread-1", timeoutMs: 1000 });
      expect(watch.mock.calls.map(([input]) => input)).toEqual([
        { threadId: "thread-1", notifyThreadId: "client:bot", timeoutMs: DEFAULT_WATCH_TIMEOUT_MS },
        { threadId: "thread-1", notifyThreadId: "client:bot", timeoutMs: 1000 },
      ]);
      expect(DEFAULT_WATCH_TIMEOUT_MS).toBe(1_740_000);
    });

    it.each([
      [{ task: "t" }],
      [{ harness: "", task: "t" }],
      [{ harness: 7, task: "t" }],
      [{ harness: "pi", harnessId: "claude", task: "t" }],
    ])("rejects delegate start %j as INVALID_ARGUMENT naming the field", async (body) => {
      const { api } = setup();
      const server = await startDelegationControlServer({ token, api });
      try {
        const response = await fetch(`${server.endpoint}/v1/delegate/start`, authorized(body));
        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({
          error: { code: "INVALID_ARGUMENT", message: expect.stringContaining("harness") },
        });
        expect(api.start).not.toHaveBeenCalled();
      } finally {
        await server.close();
      }
    });

    it("rejects an unknown sort as INVALID_ARGUMENT, not INTERNAL_ERROR", async () => {
      const { api } = setup();
      const server = await startDelegationControlServer({ token, api });
      try {
        const response = await fetch(
          `${server.endpoint}/v1/thread/list`,
          authorized({ limit: 3, sort: "newest" }),
        );
        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({
          error: { code: "INVALID_ARGUMENT", message: expect.stringContaining("sort") },
        });
        expect(api.list).not.toHaveBeenCalled();
      } finally {
        await server.close();
      }
    });

    it("starts with a watch when only the documented harness field is sent", async () => {
      const { api, watch, watchApi } = setup();
      const router = externalClientRouter({ api, watchApi });
      await router({ client: "bot" } as Parameters<typeof router>[0], "/v1/delegate/start", {
        harness: "pi",
        task: "t",
        cwd: "/w",
        watch: true,
      });
      expect(api.start).toHaveBeenCalledWith({
        harnessId: "pi",
        task: "t",
        cwd: "/w",
        parentThreadId: "client:bot",
      });
      expect(watch).toHaveBeenCalledWith({
        threadId: "thread-1",
        notifyThreadId: "client:bot",
        timeoutMs: DEFAULT_WATCH_TIMEOUT_MS,
      });
    });
  });
});
