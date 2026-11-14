import { describe, expect, it, vi } from "vitest";

import { startDelegationControlServer } from "../src/delegation-control-server.js";
import { projectDelegationThreadSnapshot } from "../src/delegation-snapshot.js";
import type { ThreadReadInput, ThreadWaitInput } from "../src/delegation-types.js";

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

  it("accepts string Model and Thinking selectors and rejects the removed shapes", async () => {
    const start = vi.fn(async () => ({
      delegationId: "delegation-1",
      threadId: "thread-1",
      turnId: "turn-1",
      harnessId: "pi" as const,
      deepLink: "codex://threads/thread-1",
      status: "running" as const,
      next: { read: "read", wait: "wait" },
    }));
    const server = await startDelegationControlServer({
      token,
      api: {
        listHarnesses: vi.fn(),
        inspect: vi.fn(),
        start,
        send: vi.fn(),
        cancel: vi.fn(),
        read: vi.fn(),
        wait: vi.fn(),
        list: vi.fn(),
      },
    });
    try {
      const selected = await fetch(
        `${server.endpoint}/v1/delegate/start`,
        authorized({
          harnessId: "pi",
          task: "review",
          cwd: "/synthetic",
          model: "provider/model-a",
          thinking: "reasoning=high",
        }),
      );
      expect(selected.status).toBe(200);
      expect(start).toHaveBeenCalledWith({
        harnessId: "pi",
        task: "review",
        cwd: "/synthetic",
        model: "provider/model-a",
        thinking: "reasoning=high",
      });
      start.mockClear();
      for (const selectors of [
        { model: { id: "provider/model-a" } },
        { thinkingOptionId: "reasoning=high" },
      ]) {
        const rejected = await fetch(
          `${server.endpoint}/v1/delegate/start`,
          authorized({ harnessId: "pi", task: "review", cwd: "/synthetic", ...selectors }),
        );
        expect(rejected.status).toBe(400);
        expect(await rejected.json()).toMatchObject({ error: { code: "INVALID_ARGUMENT" } });
      }
      expect(start).not.toHaveBeenCalled();
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
    const server = await startDelegationControlServer({
      token,
      api: {
        listHarnesses: vi.fn(async () => ({ harnesses: ["codex" as const, "pi" as const] })),
        inspect: vi.fn(),
        start: vi.fn(),
        send,
        cancel,
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
      expect(send).toHaveBeenCalledWith({ threadId: "thread-1", message: "continue" });
      expect(cancel).toHaveBeenCalledWith({ threadId: "thread-1" });
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
});
