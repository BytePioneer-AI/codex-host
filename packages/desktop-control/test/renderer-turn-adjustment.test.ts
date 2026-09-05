import { describe, expect, it, vi } from "vitest";

import { createRendererTurnAdjustmentSender } from "../src/renderer-turn-adjustment.js";

function fixture(canonical = false) {
  const item = {
    id: "optimistic-1",
    type: "steeringUserMessage",
    clientUserMessageId: "client-1",
    status: "pending",
    serverUserMessageId: null,
    restoreMessage: { text: "adjust" },
  };
  const source = { turnId: "old-turn", status: "inProgress", items: [item] };
  const state: Record<string, unknown> = canonical
    ? {
        turnHistory: {
          kind: "canonical",
          history: {
            islands: [{ entries: [{ value: "turn-key" }] }],
            entitiesByKey: { "turn-key": source },
          },
        },
      }
    : { turns: [source] };
  const manager = {
    getConversation: vi.fn(() => state),
    updateConversationState: vi.fn(
      (_id: string, update: (state: Record<string, unknown>) => void) => update(state),
    ),
  };
  const inspection = {
    owner: "external",
    activeTurns: { steer: false, interruptAndContinue: true },
  };
  const send = vi.fn<(method: string, parameters?: unknown, options?: unknown) => Promise<unknown>>(
    async (method) => {
      if (method === "codexhost/thread/inspect") return inspection;
      return { turnId: "new-turn", previousTurnId: "old-turn", delivery: "interrupt-and-continue" };
    },
  );
  const parameters = {
    threadId: "thread",
    expectedTurnId: "old-turn",
    clientUserMessageId: "client-1",
    input: [{ type: "text", text: "adjust" }],
  };
  return {
    item,
    source,
    state,
    manager,
    inspection,
    send,
    parameters,
    wrapped: createRendererTurnAdjustmentSender(manager, send),
  };
}

describe("Renderer Turn adjustment", () => {
  it.each([false, true])(
    "detaches the optimistic item before native cancellation (canonical=%s)",
    async (canonical) => {
      const f = fixture(canonical);
      const continuation = Promise.withResolvers<unknown>();
      f.send.mockImplementation(async (method) => {
        if (method === "codexhost/thread/inspect") return f.inspection;
        expect(method).toBe("codexhost/turn/adjust");
        expect(f.source.items).toEqual([]);
        // The stock old-Turn completion handler now has no unconsumed item to requeue.
        f.source.status = "interrupted";
        return continuation.promise;
      });
      const options = { onOutcomeUnknown: vi.fn() };
      const result = f.wrapped("turn/steer", f.parameters, options);
      await vi.waitFor(() =>
        expect(f.send).toHaveBeenCalledWith("codexhost/turn/adjust", f.parameters, options),
      );
      continuation.resolve({ turnId: "new-turn" });
      await expect(result).resolves.toEqual({ turnId: "new-turn" });
      expect(f.source.items).toEqual([]);
    },
  );

  it.each([false, true])(
    "restores the original recovery data on failure (canonical=%s)",
    async (canonical) => {
      const f = fixture(canonical);
      const error = new Error("Cancellation failed");
      f.send.mockImplementation(async (method) => {
        if (method === "codexhost/thread/inspect") return f.inspection;
        f.source.status = "interrupted";
        throw error;
      });
      await expect(f.wrapped("turn/steer", f.parameters)).rejects.toBe(error);
      expect(f.source.items).toEqual([f.item]);
      expect(f.source.items[0]).toBe(f.item);
    },
  );

  it.each([
    { owner: "codex" },
    { owner: "external", activeTurns: { steer: true, interruptAndContinue: true } },
    { owner: "external", activeTurns: { steer: false } },
  ])("preserves the native request and optimistic state for %j", async (inspection) => {
    const f = fixture();
    f.send.mockResolvedValueOnce(inspection);
    const options = { timeout: 123 };
    await f.wrapped("turn/steer", f.parameters, options);
    expect(f.send).toHaveBeenLastCalledWith("turn/steer", f.parameters, options);
    expect(f.manager.updateConversationState).not.toHaveBeenCalled();
    expect(f.source.items).toEqual([f.item]);
  });

  it.each(["unknown-shape", "missing-item", "ended-turn", "consumed-item"])(
    "rejects %s before cancellation",
    async (condition) => {
      const f = fixture();
      if (condition === "unknown-shape") delete f.state.turns;
      if (condition === "missing-item") f.source.items = [];
      if (condition === "ended-turn") f.source.status = "completed";
      if (condition === "consumed-item")
        Object.assign(f.item, { serverUserMessageId: "real-message" });
      await expect(f.wrapped("turn/steer", f.parameters)).rejects.toThrow(
        "could not be identified",
      );
      expect(f.send).toHaveBeenCalledOnce();
    },
  );

  it("leaves other methods synchronous and unchanged", () => {
    const f = fixture();
    const send = vi.fn(() => 42);
    const wrapped = createRendererTurnAdjustmentSender(f.manager, send);
    expect(wrapped("turn/start", f.parameters)).toBe(42);
    expect(send).toHaveBeenCalledOnce();
    expect(f.manager.getConversation).not.toHaveBeenCalled();
  });

  it("can run after serialization without module dependencies", async () => {
    const f = fixture(true);
    const factory = new Function(
      `return (${createRendererTurnAdjustmentSender.toString()})`,
    )() as typeof createRendererTurnAdjustmentSender;
    await factory(f.manager, f.send)("turn/steer", f.parameters);
    expect(f.send).toHaveBeenLastCalledWith("codexhost/turn/adjust", f.parameters, undefined);
  });
});
