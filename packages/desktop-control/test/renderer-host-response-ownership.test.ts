import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

import { installRendererDraftPrewarmPolicyDirect } from "../src/renderer-draft-prewarm-policy.js";

import {
  installDraftPrewarmPolicyBridge,
  type DraftPrewarmPolicyTarget,
} from "../src/renderer-draft-prewarm-runtime.js";

type LifecycleEvent = { type: string; hostId: string; id: string; method: string };
let nextId = 0;
function nativeClient() {
  const listeners = new Set<(event: LifecycleEvent) => void>();
  const pending = new Map<
    string,
    { method: string; result: ReturnType<typeof Promise.withResolvers<unknown>> }
  >();
  const emit = (type: string, id: string, method: string) => {
    for (const listener of listeners) listener({ type, id, method, hostId: "local" });
  };
  return {
    listeners,
    pending,
    addRequestLifecycleListener(listener: (event: LifecycleEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    sendRequest: vi.fn((method: string) => {
      const id = `request-${++nextId}`;
      const result = Promise.withResolvers<unknown>();
      pending.set(id, { method, result });
      emit("started", id, method);
      return result.promise;
    }),
    enqueueRequest: vi.fn(),
    prewarmThreadStart: vi.fn(),
    onResult: vi.fn((id: unknown, value: unknown) => {
      const entry = pending.get(String(id));
      if (!entry) return;
      pending.delete(String(id));
      entry.result.resolve(value);
      emit("completed", String(id), entry.method);
    }),
    onError: vi.fn((id: unknown, error: unknown) => {
      const entry = pending.get(String(id));
      if (!entry) return;
      pending.delete(String(id));
      entry.result.reject(error);
      emit("failed", String(id), entry.method);
    }),
  };
}

function requestId(client: ReturnType<typeof nativeClient>, index = 0): string {
  const id = [...client.pending.keys()][index];
  if (!id) throw new Error("Expected a pending native request");
  return id;
}

function fixture(injected: boolean) {
  const events = new EventTarget();
  const target: DraftPrewarmPolicyTarget = {
    location: { origin: "app://desktop" },
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),
  };
  let currentManager: object | null = null;
  const install = async (client: ReturnType<typeof nativeClient>) => {
    const manager = {
      onNotification: vi.fn(),
      onRequest: vi.fn(),
      dispatchAppServerResponse: vi.fn(),
      requestClient: client,
      sendRequest: client.sendRequest,
      getHostId: () => "local",
      prewarmedThreadManager: { discardAllPrewarmedThreads: vi.fn() },
    };
    currentManager = manager;
    if (injected) {
      await installRendererDraftPrewarmPolicyDirect({
        async evaluate<T>(expression: string): Promise<T> {
          return await runInNewContext(expression, {
            document: {
              querySelectorAll: () => [
                {
                  parentElement: null,
                  __reactFiber$test: {
                    memoizedState: { memoizedState: { manager: currentManager } },
                  },
                },
              ],
            },
            window: target,
            crypto: globalThis.crypto,
            TextDecoder,
            TextEncoder,
            Uint8Array,
            queueMicrotask,
          });
        },
      });
    } else {
      installDraftPrewarmPolicyBridge(
        manager,
        client,
        "local",
        target,
        manager.prewarmedThreadManager,
      );
    }
  };
  const frame = (message: object, hostId = "local", hostMetrics?: object) =>
    events.dispatchEvent(
      new MessageEvent("message", { data: { type: "mcp-response", hostId, message, hostMetrics } }),
    );
  return { install, frame, target, events };
}

const flushDelivery = () => new Promise<void>((resolve) => setImmediate(resolve));

describe.each([false, true])("native Host response ownership (injected: %s)", (injected) => {
  it.each(["success", "busy"] as const)(
    "settles a %s response on its sending Client after Desktop replaces the Client",
    async (outcome) => {
      const { install, frame } = fixture(injected);
      const original = nativeClient();
      await install(original);
      const first = original.sendRequest("codexhost/account/switch");
      const firstId = requestId(original);
      original.onResult(firstId, { committed: true });
      frame({ id: firstId, result: { committed: true } });
      await expect(first).resolves.toEqual({ committed: true });

      const settled = vi.fn();
      const request = original.sendRequest("codexhost/account/switch");
      void request.then(settled, settled);
      const id = requestId(original);
      const replacement = nativeClient();
      const replacementSend = replacement.sendRequest;
      await install(replacement);
      const value =
        outcome === "busy" ? { code: -32084, message: "Codex is busy" } : { committed: true };
      // Desktop routes by the current host Client, not the Client that sent this ID.
      if (outcome === "busy") replacement.onError(id, value);
      else replacement.onResult(id, value);
      frame({ id, [outcome === "busy" ? "error" : "result"]: value });
      await flushDelivery();
      expect(settled).toHaveBeenCalledExactlyOnceWith(value);
      expect(original.pending.size).toBe(0);
      expect(original.listeners.size).toBe(0);
      expect(replacementSend).not.toHaveBeenCalled();
    },
  );

  it("does not deliver twice when native routing settles before or after the window listener", async () => {
    for (const nativeFirst of [true, false]) {
      const { install, frame } = fixture(injected);
      const client = nativeClient();
      await install(client);
      const promise = client.sendRequest("codexhost/account/list");
      const id = requestId(client);
      if (nativeFirst) client.onResult(id, {});
      frame({ id, result: {} });
      if (!nativeFirst) client.onResult(id, {});
      await flushDelivery();
      await expect(promise).resolves.toEqual({});
      expect(client.onResult).toHaveBeenCalledTimes(1);
    }
  });

  it("rejects other-window senders and mismatched same-window origins", async () => {
    const { install, frame, target, events } = fixture(injected);
    const client = nativeClient();
    await install(client);
    const promise = client.sendRequest("codexhost/account/list");
    const id = requestId(client);
    for (const source of [{}, target]) {
      events.dispatchEvent(
        Object.assign(new Event("message"), {
          source,
          origin: "https://other.invalid",
          data: { type: "mcp-response", hostId: "local", message: { id, result: {} } },
        }),
      );
    }
    await flushDelivery();
    expect(client.onResult).not.toHaveBeenCalled();
    frame({ id, result: {} });
    await expect(promise).resolves.toEqual({});
  });

  it("only completes owned Host requests from the same Host and retains native metrics", async () => {
    const { install, frame } = fixture(injected);
    const client = nativeClient();
    await install(client);
    const promise = client.sendRequest("codexhost/account/refresh");
    const id = requestId(client);
    const native = client.sendRequest("account/read");
    const nativeId = requestId(client, 1);
    frame({ id, result: {} }, "other-host");
    frame({ id: "unowned", result: {} });
    frame({ id: nativeId, result: {} });
    frame({ id });
    await flushDelivery();
    expect(client.onResult).not.toHaveBeenCalled();
    const metrics = { hostRoundTripDurationMs: 7 };
    frame({ id, result: null }, "local", metrics);
    await flushDelivery();
    await expect(promise).resolves.toBeNull();
    expect(client.onResult).toHaveBeenCalledExactlyOnceWith(id, null, metrics);
    frame({ id, result: {} });
    await flushDelivery();
    expect(client.onResult).toHaveBeenCalledTimes(1);
    client.onResult(nativeId, {});
    await native;
  });
});
