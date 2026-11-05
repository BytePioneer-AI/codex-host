import { describe, expect, it, vi } from "vitest";
import { THREAD_STEERING_CONTEXT_PARAM } from "@codexhost/shared-contracts";
import { installRendererRpcSteering } from "../src/renderer-rpc-steering.js";

const INTERRUPTED = "Interrupted before the steer was accepted.";
type Message = { id: string; pausedReason?: string };
type Prepared = {
  conversationId: string;
  afterInactiveTurnId?: string;
  steer: {
    input: unknown;
    restoreMessage: { id: string };
    clientUserMessageId: string;
    additionalContext?: unknown;
  };
  start?: { request: { input: unknown; clientUserMessageId: string; additionalContext?: unknown } };
};
type Prepare = (request: unknown, mode: string) => Promise<Prepared>;
function fixture(delivery = "newTurn", pausedOther = false) {
  let queue: Message[] = [
    ...(pausedOther ? [{ id: "previously-paused", pausedReason: INTERRUPTED }] : []),
    { id: "message", pausedReason: INTERRUPTED },
    { id: "next" },
  ];
  const requests: { method: string; params: unknown }[] = [];
  const submitted: { acceptLocally?: boolean }[] = [];
  let starts = 0;
  let steers = 0;
  let fail = false;
  let interrupted = false;
  let stopOnStart = false;
  let activeTurnId: string | null = "old";
  let executionState: "default" | "unloaded" = "default";
  const native = {
    removeQueuedMessage: vi.fn(async (_thread, id) => {
      const index = queue.findIndex((message) => message.id === id);
      if (index < 0) return null;
      return { message: queue.splice(index, 1)[0], index };
    }),
    restoreQueuedMessage: vi.fn(async (_thread, token) => {
      queue.splice(token.index, 0, token.message);
    }),
    resumeInterruptedQueuedMessages: vi.fn(async () => {
      queue = queue.map((message) =>
        message.pausedReason === INTERRUPTED ? { id: message.id } : message,
      );
    }),
    async sendMessage(input: { queue?: boolean; acceptLocally?: boolean }, prepare: Prepare) {
      submitted.push(input);
      if (input.queue) return { status: "queued", messageId: "message" };
      // Native prepares in "steer" mode first, even when nothing is running.
      let prepared = await prepare(input, "steer");
      if (!activeTurnId) {
        prepared = await prepare(input, "start");
        const response = await raw.sendRequest("turn/start", prepared.start?.request);
        starts++;
        return {
          status: "sent",
          kind: "start",
          turnId: (response as { turn: { id: string } }).turn.id,
        };
      }
      if (prepared.afterInactiveTurnId === "old" && prepared.start) {
        const response = await raw.sendRequest("turn/start", prepared.start.request);
        starts++;
        return {
          status: "sent",
          kind: "start",
          turnId: (response as { turn: { id: string } }).turn.id,
        };
      }
      await raw.sendRequest("turn/steer", { ...prepared.steer, expectedTurnId: "old" });
      steers++;
      return { status: "sent", kind: "steer", turnId: "old" };
    },
    async sendQueuedMessageNow(_thread: string, _id: string, options: unknown, prepare: Prepare) {
      return this.sendMessage(options as { queue?: boolean }, prepare);
    },
  };
  const leaseDisposed = vi.fn();
  const raw = {
    dup() {
      return this;
    },
    getTurnCoordinator() {
      return native;
    },
    async getThreadExecutionState() {
      if (executionState === "unloaded") return null;
      const active = interrupted ? null : activeTurnId;
      return { activeTurnId: active, inProgress: active !== null };
    },
    async getTurnById() {
      return { status: interrupted ? "interrupted" : "inProgress" };
    },
    async sendRequest(method: string, params: unknown): Promise<unknown> {
      requests.push({ method, params });
      if (method === "codexhost/thread/steering/inspect") return { delivery };
      if (fail) throw new Error("Harness rejected input");
      if (method === "turn/start") {
        activeTurnId = "replacement";
        interrupted = stopOnStart;
        queue = queue.map((message) => ({
          ...message,
          pausedReason: message.pausedReason ?? INTERRUPTED,
        }));
        return { turn: { id: "replacement" } };
      }
      return { turnId: "old" };
    },
    async subscribe(input: { listener(value: unknown): void }) {
      input.listener([...queue]);
      return { [Symbol.dispose]: leaseDisposed };
    },
  };
  let owner = raw;
  const controller = {
    forHost: (host: string) => {
      void host;
      return owner;
    },
  };
  const original = controller.forHost;
  const dispose = installRendererRpcSteering(controller);
  if (!dispose) throw new Error("Controller could not be adapted");
  const prepare: Prepare = vi.fn(async (_request, mode) => ({
    conversationId: "thread",
    steer: {
      input: [{ type: "text", text: "input" }],
      restoreMessage: { id: "message" },
      clientUserMessageId: "client-message",
    },
    ...(mode === "start"
      ? {
          start: {
            request: {
              input: [{ type: "text", text: "input" }],
              clientUserMessageId: "client-message",
            },
          },
        }
      : {}),
  }));
  return {
    controller: controller as unknown as { forHost(host: string): typeof raw },
    native,
    raw,
    prepare,
    requests,
    submitted,
    leaseDisposed,
    original,
    dispose,
    queue: () => queue,
    starts: () => starts,
    steers: () => steers,
    fail: () => {
      fail = true;
    },
    stopAfterAcceptance: () => {
      stopOnStart = true;
    },
    reconnect: () => {
      owner = { ...raw };
    },
    idle: (state: "default" | "unloaded" = "default") => {
      activeTurnId = null;
      executionState = state;
    },
  };
}

describe("native RPC steering preparation", () => {
  it.each([
    ["an idle external Thread", "newTurn", "default"],
    ["an idle Thread with native same-Turn steering", "activeTurn", "default"],
    ["an idle official Thread", "official", "default"],
    ["a Thread not loaded in the Manager", "newTurn", "unloaded"],
  ] as const)("leaves a normal send on %s to native start", async (_name, delivery, state) => {
    const f = fixture(delivery);
    f.idle(state);
    try {
      const result = await f.controller
        .forHost("local")
        .getTurnCoordinator()
        .sendMessage({}, f.prepare);
      expect(result).toMatchObject({ status: "sent", kind: "start" });
      expect(f.starts()).toBe(1);
      expect(f.steers()).toBe(0);
      // No Host request beyond the submission itself, so official sends gain no new dependency.
      expect(f.requests.map((request) => request.method)).toEqual(["turn/start"]);
      expect(f.requests[0]?.params).not.toHaveProperty("additionalContext");
      expect(f.native.removeQueuedMessage).not.toHaveBeenCalled();
      expect(f.native.resumeInterruptedQueuedMessages).not.toHaveBeenCalled();
    } finally {
      f.dispose();
    }
  });

  it.each(["sendMessage", "sendQueuedMessageNow"] as const)(
    "uses native start presentation for %s and removes only accepted input",
    async (method) => {
      const f = fixture();
      try {
        const queue = f.controller.forHost("local").getTurnCoordinator();
        const result =
          method === "sendMessage"
            ? await queue.sendMessage({}, f.prepare)
            : await queue.sendQueuedMessageNow("thread", "message", {}, f.prepare);
        expect(result).toMatchObject({ status: "sent", kind: "start", turnId: "replacement" });
        expect(f.starts()).toBe(1);
        expect(f.steers()).toBe(0);
        expect(f.requests.at(-1)).toMatchObject({
          method: "turn/start",
          params: {
            additionalContext: {
              [THREAD_STEERING_CONTEXT_PARAM]: {
                kind: "application",
                value: JSON.stringify({
                  expectedTurnId: "old",
                  clientUserMessageId: "client-message",
                  delivery: "newTurn",
                }),
              },
            },
          },
        });
        expect(f.queue()).toEqual([{ id: "next" }]);
        expect(f.leaseDisposed).toHaveBeenCalledOnce();
        expect(f.native.removeQueuedMessage.mock.calls.map(([, id]) => id)).toEqual(["message"]);
      } finally {
        f.dispose();
      }
    },
  );

  describe("local queue row", () => {
    const send = (f: ReturnType<typeof fixture>) =>
      f.controller
        .forHost("local")
        .getTurnCoordinator()
        .sendMessage({ acceptLocally: true, conversationId: "thread" } as never, f.prepare);

    it("submits a replacement directly so the stopped Turn cannot show it as paused", async () => {
      const f = fixture();
      try {
        await expect(send(f)).resolves.toMatchObject({ status: "sent", kind: "start" });
        expect(f.submitted).toEqual([
          expect.objectContaining({ acceptLocally: false, conversationId: "thread" }),
        ]);
        expect(f.starts()).toBe(1);
      } finally {
        f.dispose();
      }
    });

    it.each(["official", "activeTurn"])(
      "keeps native local acceptance for %s",
      async (delivery) => {
        const f = fixture(delivery);
        try {
          await send(f);
          expect(f.submitted[0]).toMatchObject({ acceptLocally: true });
        } finally {
          f.dispose();
        }
      },
    );

    it("keeps native local acceptance on an idle Thread without asking the Host", async () => {
      const f = fixture();
      f.idle();
      try {
        await send(f);
        expect(f.submitted[0]).toMatchObject({ acceptLocally: true });
        expect(f.requests.map((request) => request.method)).toEqual(["turn/start"]);
      } finally {
        f.dispose();
      }
    });

    it("keeps the native request when delivery cannot be determined", async () => {
      const f = fixture();
      const original = f.raw.sendRequest.bind(f.raw);
      vi.spyOn(f.raw, "sendRequest").mockImplementationOnce(() =>
        Promise.reject(new Error("Host is restarting")),
      );
      vi.spyOn(f.raw, "sendRequest").mockImplementation(original);
      try {
        await send(f);
        expect(f.submitted[0]).toMatchObject({ acceptLocally: true });
      } finally {
        f.dispose();
      }
    });
  });

  it("retains preparation interception after awaiting a native Coordinator RPC promise", async () => {
    const f = fixture();
    vi.spyOn(f.raw, "getTurnCoordinator").mockReturnValue(
      Promise.resolve(f.native) as unknown as typeof f.native,
    );
    try {
      const coordinator = await f.controller.forHost("local").getTurnCoordinator();
      await coordinator.sendMessage({}, f.prepare);
      expect(f.starts()).toBe(1);
      expect(f.steers()).toBe(0);
      expect(f.queue()).toEqual([{ id: "next" }]);
    } finally {
      f.dispose();
    }
  });

  it("leaves queue mode entirely with the native Coordinator", async () => {
    const f = fixture();
    try {
      await expect(
        f.controller.forHost("local").getTurnCoordinator().sendMessage({ queue: true }, f.prepare),
      ).resolves.toMatchObject({ status: "queued" });
      expect(f.prepare).not.toHaveBeenCalled();
      expect(f.requests).toEqual([]);
      expect(f.native.removeQueuedMessage).not.toHaveBeenCalled();
      expect(f.native.resumeInterruptedQueuedMessages).not.toHaveBeenCalled();
    } finally {
      f.dispose();
    }
  });

  it.each(["official", "activeTurn"])(
    "keeps %s on native same-Turn presentation",
    async (delivery) => {
      const f = fixture(delivery);
      try {
        await f.controller.forHost("local").getTurnCoordinator().sendMessage({}, f.prepare);
        expect(f.starts()).toBe(0);
        expect(f.steers()).toBe(1);
        expect(f.native.removeQueuedMessage).not.toHaveBeenCalled();
        expect(f.native.resumeInterruptedQueuedMessages).not.toHaveBeenCalled();
      } finally {
        f.dispose();
      }
    },
  );

  it("preserves a stock app-server after ownership is verified without Host extensions", async () => {
    const f = fixture("official");
    const original = f.raw.sendRequest.bind(f.raw);
    vi.spyOn(f.raw, "sendRequest").mockImplementation(async (method, params) => {
      if (method.startsWith("codexhost/")) throw { code: -32601, message: "Method not found" };
      if (method === "thread/read")
        return { thread: { id: "thread", modelProvider: "openai", cliVersion: "1.0" } };
      return original(method, params);
    });
    try {
      await f.controller.forHost("stock-remote").getTurnCoordinator().sendMessage({}, f.prepare);
      expect(f.steers()).toBe(1);
      expect(f.starts()).toBe(0);
      expect(f.native.removeQueuedMessage).not.toHaveBeenCalled();
    } finally {
      f.dispose();
    }
  });

  it("does not resume or delete rejected input", async () => {
    const f = fixture();
    f.fail();
    try {
      await expect(
        f.controller.forHost("local").getTurnCoordinator().sendMessage({}, f.prepare),
      ).rejects.toThrow("Harness rejected input");
      expect(f.queue()).toEqual([{ id: "message", pausedReason: INTERRUPTED }, { id: "next" }]);
      expect(f.native.resumeInterruptedQueuedMessages).not.toHaveBeenCalled();
    } finally {
      f.dispose();
    }
  });

  it("refuses to resume other previously paused inputs before any delivery", async () => {
    const f = fixture("newTurn", true);
    try {
      await expect(
        f.controller.forHost("local").getTurnCoordinator().sendMessage({}, f.prepare),
      ).rejects.toThrow("previously paused");
      expect(
        f.requests.every((request) => request.method === "codexhost/thread/steering/inspect"),
      ).toBe(true);
      expect(f.native.removeQueuedMessage).not.toHaveBeenCalled();
      expect(f.native.resumeInterruptedQueuedMessages).not.toHaveBeenCalled();
      expect(f.queue()).toHaveLength(3);
    } finally {
      f.dispose();
    }
  });

  it("keeps an explicit stop after accepted delivery paused", async () => {
    const f = fixture();
    f.stopAfterAcceptance();
    try {
      await f.controller.forHost("local").getTurnCoordinator().sendMessage({}, f.prepare);
      expect(f.queue()).toEqual([{ id: "next", pausedReason: INTERRUPTED }]);
      expect(f.native.resumeInterruptedQueuedMessages).not.toHaveBeenCalled();
    } finally {
      f.dispose();
    }
  });

  it("fails closed on reconnection during preparation and restores the original Controller on dispose", async () => {
    const f = fixture();
    const pending = Promise.withResolvers<Prepared>();
    const prepare = vi.fn(() => pending.promise);
    const send = f.controller.forHost("local").getTurnCoordinator().sendMessage({}, prepare);
    f.reconnect();
    pending.resolve(await f.prepare({}, "steer"));
    await expect(send).rejects.toThrow("retired");
    expect(f.requests).toEqual([]);
    f.dispose();
    expect(f.controller.forHost).toBe(f.original);
  });
});
