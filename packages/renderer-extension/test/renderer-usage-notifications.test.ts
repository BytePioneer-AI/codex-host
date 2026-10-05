import type {
  RendererHostRoute,
  RendererHostRouting,
} from "@codexhost/desktop-control/renderer-bindings";
import { describe, expect, it, vi } from "vitest";
import { createRendererHostClients } from "../src/renderer-host-clients.js";
import type { RendererMessageTarget } from "../src/renderer-manual-compaction.js";
import { THREAD_USAGE_UPDATED_METHOD } from "../src/renderer-model-client.js";

type Listener = Parameters<RendererMessageTarget["addEventListener"]>[1];
function fixture(hostId = "local") {
  const listeners = new Set<Listener>();
  const messages: RendererMessageTarget = {
    addEventListener: (_type, listener) => {
      listeners.add(listener);
    },
    removeEventListener: (_type, listener) => {
      listeners.delete(listener);
    },
  };
  let usage: Record<string, unknown> = { timeToFirstOutputMs: 123 };
  let nativeCallback: ((notification: unknown) => void) | undefined;
  const removeNative = vi.fn();
  const manager = {
    sendRequest: vi.fn(async (_method: string, params: unknown) => ({
      threadId: (params as { threadId: string }).threadId,
      usage,
    })),
    addNotificationCallback: vi.fn(
      (_methods: string | readonly string[], callback: (notification: unknown) => void) => {
        nativeCallback = callback;
        return removeNative;
      },
    ),
  };
  let route = { hostId, manager, policy: {} } as unknown as RendererHostRoute;
  const routing = {
    forHost: (id: string) => (id === hostId ? route : null),
  } as unknown as RendererHostRouting;
  const clients = createRendererHostClients(() => routing, messages);
  const client = clients.forHost(hostId);
  if (!client) throw Error("No client");
  const notification = {
    type: "mcp-notification",
    hostId,
    method: THREAD_USAGE_UPDATED_METHOD,
    params: { threadId: "thread" },
  };
  const post = (data: unknown = notification, source: unknown = messages) => {
    for (const listener of [...listeners]) listener({ data, source });
  };
  return {
    clients,
    client,
    listeners,
    manager,
    removeNative,
    notification,
    post,
    native: (data: unknown) => nativeCallback?.(data),
    setUsage: (value: Record<string, unknown>) => {
      usage = value;
    },
    replace: () => {
      route = { ...route };
      return clients.forHost(hostId);
    },
  };
}

describe("Host usage notifications before Desktop's method filter", () => {
  it.each(["local", "ssh:remote"])(
    "refreshes TTFT and metering during a Turn without native Context usage (%s)",
    async (hostId) => {
      const f = fixture(hostId);
      const changed = vi.fn();
      const unsubscribe = f.client.subscribeThreadUsage?.(changed);
      try {
        // Desktop posts this frame to the window, but does NOT dispatch the custom method
        // through addNotificationCallback. No tokenUsage/updated or turn/completed arrives.
        f.post();
        await vi.waitFor(() =>
          expect(changed).toHaveBeenCalledWith({
            threadId: "thread",
            usage: { timeToFirstOutputMs: 123 },
          }),
        );
        f.setUsage({
          timeToFirstOutputMs: 123,
          totalCostUsd: 0.02,
          costSource: "publicPrice",
          sessionCacheHitRatePercent: 75,
          outputTokensPerSecond: 100,
        });
        f.post();
        await vi.waitFor(() =>
          expect(changed).toHaveBeenLastCalledWith({
            threadId: "thread",
            usage: expect.objectContaining({
              totalCostUsd: 0.02,
              sessionCacheHitRatePercent: 75,
              outputTokensPerSecond: 100,
            }),
          }),
        );
        expect(f.manager.sendRequest).toHaveBeenCalledTimes(2);
        expect(f.manager.sendRequest).toHaveBeenCalledWith("codexhost/thread/usage/inspect", {
          threadId: "thread",
        });
      } finally {
        unsubscribe?.();
        f.clients.dispose();
      }
      expect(f.listeners.size).toBe(0);
    },
  );

  it("ignores other Hosts, frames and methods; retains native notifications and unsubscribes", async () => {
    const f = fixture();
    const changed = vi.fn();
    const unsubscribe = f.client.subscribeThreadUsage?.(changed);
    try {
      f.post({ ...f.notification, hostId: "ssh:other" });
      f.post(f.notification, {});
      f.post({ ...f.notification, type: "mcp-request" });
      f.post({ ...f.notification, method: "thread/tokenUsage/updated" });
      f.post({ ...f.notification, params: {} });
      f.post(null);
      expect(f.manager.sendRequest).not.toHaveBeenCalled();
      f.native({ method: "thread/tokenUsage/updated", params: { threadId: "thread" } });
      await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
      unsubscribe?.();
      expect(f.listeners.size).toBe(0);
      f.post();
      expect(f.manager.sendRequest).toHaveBeenCalledTimes(1);
      expect(f.removeNative).toHaveBeenCalledTimes(1);
    } finally {
      f.clients.dispose();
    }
  });

  it("removes the window listener when a connection is replaced or disposed", () => {
    const f = fixture();
    f.client.subscribeThreadUsage?.(vi.fn());
    expect(f.listeners.size).toBe(1);
    const replacement = f.replace();
    expect(f.listeners.size).toBe(0);
    f.post();
    expect(f.manager.sendRequest).not.toHaveBeenCalled();
    replacement?.subscribeThreadUsage?.(vi.fn());
    expect(f.listeners.size).toBe(1);
    f.clients.dispose();
    expect(f.listeners.size).toBe(0);
    f.post();
    expect(f.manager.sendRequest).not.toHaveBeenCalled();
  });
});
