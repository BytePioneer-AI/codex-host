import { describe, expect, it, vi } from "vitest";

import { installRendererExternalSteering } from "../src/renderer-external-steering.js";

// Desktop exports its Manager as a RpcTarget. Its RPC resolver refuses own
// properties, even when their values are functions. Ordinary object mocks miss this.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- Desktop uses an empty RpcTarget marker base.
class RpcTarget {}
class Manager extends RpcTarget {
  readonly #identity = "local";
  readonly requests = vi.fn(async (method: unknown) => {
    if (method === "codexhost/thread/ownership/list") {
      return {
        threads: [
          {
            threadId: "thread",
            owner: this.owner,
            ...(this.owner === "external" ? { harnessId: "pi" } : {}),
          },
        ],
      };
    }
    if (method === "turn/steer") return { turnId: "replacement" };
    return { data: ["available"] };
  });
  readonly presented: unknown[] = [];
  readonly onMessageAdded = vi.fn(async () => undefined);
  owner: "codex" | "external" = "external";

  sendRequest(method: unknown, params?: unknown, options?: unknown): Promise<unknown> {
    // Preserve the real receiver, including private fields, through the wrapper.
    if (this.#identity !== "local") throw new Error("Invalid receiver");
    void params;
    void options;
    return this.requests(method);
  }
  steerTurn(...args: unknown[]): unknown {
    void args;
    return { turnId: "official" };
  }
  async startTurn(_threadId: unknown, operation: unknown, onAdded: unknown): Promise<unknown> {
    void _threadId;
    const request = (operation as { request: unknown }).request;
    this.presented.push(request);
    if (typeof onAdded === "function") await onAdded();
    return this.sendRequest("turn/start", request);
  }
  getTurnCoordinator(): unknown {
    return {
      loadMessages: async () => undefined,
      readMessages: () => [],
      mutate: () => undefined,
      options: {
        submissionHost: {
          getActiveTurnId: () => "old",
          hasPendingTurnStart: () => false,
        },
      },
    };
  }
}

async function callRpc(
  manager: Manager,
  method: "sendRequest" | "steerTurn",
  ...args: unknown[]
): Promise<unknown> {
  if (Object.hasOwn(manager, method)) {
    throw new TypeError(`Cannot access instance property '${method}' of RpcTarget`);
  }
  const exported = manager[method] as (...args: unknown[]) => unknown;
  return exported.apply(manager, args);
}

function install(manager: Manager): () => void {
  const dispose = installRendererExternalSteering(manager);
  if (!dispose) throw new Error("Steering binding unavailable");
  return dispose;
}

function steerArgs(manager: Manager): unknown[] {
  return [
    "thread",
    [{ type: "text", text: "replacement input" }],
    { id: "message", context: {} },
    null,
    [],
    "message",
    null,
    null,
    manager.onMessageAdded,
  ];
}

describe("Desktop RpcTarget method visibility", () => {
  it("keeps model and permission discovery callable over RPC while steering is installed", async () => {
    const manager = new Manager();
    await expect(callRpc(manager, "sendRequest", "model/list", {})).resolves.toEqual({
      data: ["available"],
    });
    const dispose = install(manager);
    try {
      for (const method of ["model/list", "permissionProfile/list"]) {
        await expect(callRpc(manager, "sendRequest", method, {})).resolves.toEqual({
          data: ["available"],
        });
      }
      expect(manager).toBeInstanceOf(Manager);
    } finally {
      dispose();
    }
  });

  it("allows an external direction change through the exported steer method", async () => {
    const manager = new Manager();
    const dispose = install(manager);
    try {
      await expect(callRpc(manager, "steerTurn", ...steerArgs(manager))).resolves.toEqual({
        turnId: "replacement",
      });
      expect(manager.presented).toHaveLength(1);
      expect(manager.requests.mock.calls.map(([method]) => method)).toEqual([
        "codexhost/thread/ownership/list",
        "turn/steer",
      ]);
    } finally {
      dispose();
    }
  });

  it("preserves official steering and does not patch other Manager instances", async () => {
    const manager = new Manager();
    manager.owner = "codex";
    const other = new Manager();
    const original = other.sendRequest;
    const dispose = install(manager);
    try {
      expect(other.sendRequest).toBe(original);
      expect(Object.getPrototypeOf(other)).toBe(Manager.prototype);
      await expect(callRpc(manager, "steerTurn", ...steerArgs(manager))).resolves.toEqual({
        turnId: "official",
      });
      expect(manager.presented).toHaveLength(0);
    } finally {
      dispose();
    }
  });

  it("restores the original prototype without own-property shadows across reinstall", async () => {
    const manager = new Manager();
    for (let i = 0; i < 2; i++) {
      const dispose = install(manager);
      dispose();
      expect(Object.hasOwn(manager, "sendRequest")).toBe(false);
      expect(Object.hasOwn(manager, "steerTurn")).toBe(false);
      expect(Object.getPrototypeOf(manager)).toBe(Manager.prototype);
      expect(manager.sendRequest).toBe(Manager.prototype.sendRequest);
      await expect(callRpc(manager, "sendRequest", "permissionProfile/list", {})).resolves.toEqual({
        data: ["available"],
      });
    }
  });

  it("keeps RPC reads working while a disposed replacement waits to fail closed", async () => {
    const manager = new Manager();
    const waiting = Promise.withResolvers<undefined>();
    manager.onMessageAdded.mockReturnValue(waiting.promise);
    const dispose = install(manager);
    expect(Object.hasOwn(manager, "steerTurn")).toBe(false);
    const result = callRpc(manager, "steerTurn", ...steerArgs(manager));
    const rejected = expect(result).rejects.toThrow("disposed");
    await vi.waitFor(() => expect(manager.onMessageAdded).toHaveBeenCalledOnce());
    dispose();
    expect(manager.steerTurn).toBe(Manager.prototype.steerTurn);
    await expect(callRpc(manager, "sendRequest", "model/list", {})).resolves.toEqual({
      data: ["available"],
    });
    waiting.resolve(undefined);
    await rejected;
    await vi.waitFor(() => expect(Object.getPrototypeOf(manager)).toBe(Manager.prototype));
    expect(Object.hasOwn(manager, "sendRequest")).toBe(false);
    expect(manager.requests.mock.calls.map(([method]) => method)).not.toContain("turn/start");
  });
});
