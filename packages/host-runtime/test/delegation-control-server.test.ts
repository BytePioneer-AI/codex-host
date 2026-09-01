import { describe, expect, it, vi } from "vitest";

import { startDelegationControlServer } from "../src/delegation-control-server.js";

const token = "synthetic-token";

function authorized(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

describe("delegation control server", () => {
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
    const server = await startDelegationControlServer({
      token,
      api: {
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

      const response = await fetch(
        `${server.endpoint}/v1/delegate/start`,
        authorized({ harnessId: "pi", task: "review", cwd: "/synthetic" }),
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ threadId: "thread-1" });
      expect(start).toHaveBeenCalledWith({ harnessId: "pi", task: "review", cwd: "/synthetic" });
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
});
