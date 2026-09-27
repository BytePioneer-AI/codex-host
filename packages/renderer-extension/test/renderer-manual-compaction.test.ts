import type {
  RendererHostRoute,
  RendererHostRouting,
} from "@codexhost/desktop-control/renderer-bindings";
import { THREAD_MANUAL_COMPACTION_STARTED_METHOD } from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import { createRendererHostClients } from "../src/renderer-host-clients.js";
import { installRendererManualCompaction } from "../src/renderer-manual-compaction.js";

type NotificationCallback = (notification: unknown, receivedAtMs?: number) => void;

// Mirrors the Desktop manager members this binding reads. Methods live on the
// prototype, as on Desktop's RpcTarget manager.
class FakeManager {
  readonly callbacks = new Map<string, NotificationCallback[]>();
  readonly conversations = new Map<string, unknown>([
    ["external", { id: "external", modelProvider: "codexhost" }],
    ["native", { id: "native", modelProvider: "openai" }],
  ]);
  readonly roles = new Map<string, unknown>();
  readonly registered: string[] = [];

  sendRequest(): Promise<unknown> {
    return Promise.reject(new Error("Unexpected RPC"));
  }
  addNotificationCallback(method: string, callback: NotificationCallback): () => void {
    this.callbacks.set(method, [...(this.callbacks.get(method) ?? []), callback]);
    return () => {
      this.callbacks.set(
        method,
        (this.callbacks.get(method) ?? []).filter((candidate) => candidate !== callback),
      );
    };
  }
  registerPendingManualContextCompaction(threadId: string): void {
    this.registered.push(threadId);
  }
  getConversation(threadId: string): unknown {
    return this.conversations.get(threadId) ?? null;
  }
  getStreamRole(threadId: string): unknown {
    return this.roles.get(threadId) ?? null;
  }
  notify(params: unknown, method = THREAD_MANUAL_COMPACTION_STARTED_METHOD): void {
    for (const callback of this.callbacks.get(method) ?? []) callback({ method, params }, 0);
  }
  listenerCount(): number {
    return this.callbacks.get(THREAD_MANUAL_COMPACTION_STARTED_METHOD)?.length ?? 0;
  }
}

const started = (threadId: string) => ({ threadId, turnId: "compact-turn" });

describe("renderer manual compaction registration", () => {
  it("registers an announced external command compaction with Desktop", () => {
    const manager = new FakeManager();
    manager.roles.set("external", { role: "owner" });
    const dispose = installRendererManualCompaction(manager);
    expect(dispose).toBeTypeOf("function");
    manager.notify(started("external"));
    expect(manager.registered).toEqual(["external"]);
    dispose?.();
  });

  it("registers when Desktop reports no stream role for the Thread", () => {
    const manager = new FakeManager();
    const dispose = installRendererManualCompaction(manager);
    manager.notify(started("external"));
    expect(manager.registered).toEqual(["external"]);
    dispose?.();
  });

  it("does not register in a follower window, which never consumes the registration", () => {
    const manager = new FakeManager();
    manager.roles.set("external", { role: "follower", ownerClientId: "owner-window" });
    const dispose = installRendererManualCompaction(manager);
    manager.notify(started("external"));
    expect(manager.registered).toEqual([]);
    dispose?.();
  });

  it("registers only loaded Host-projected external Threads", () => {
    const manager = new FakeManager();
    manager.conversations.set("mismatched", { id: "other", modelProvider: "codexhost" });
    const dispose = installRendererManualCompaction(manager);
    for (const threadId of ["native", "unloaded", "mismatched"]) manager.notify(started(threadId));
    expect(manager.registered).toEqual([]);
    dispose?.();
  });

  it("ignores malformed announcements and other notification methods", () => {
    const manager = new FakeManager();
    const dispose = installRendererManualCompaction(manager);
    manager.notify({ threadId: "external" });
    manager.notify({ ...started("external"), extra: true });
    manager.notify(null);
    manager.callbacks.get(THREAD_MANUAL_COMPACTION_STARTED_METHOD)?.[0]?.({
      method: "thread/status/changed",
      params: started("external"),
    });
    expect(manager.registered).toEqual([]);
    dispose?.();
  });

  it("leaves Desktop builds without the registration binding unchanged", () => {
    const manager = new FakeManager();
    Object.defineProperty(manager, "registerPendingManualContextCompaction", { value: undefined });
    expect(installRendererManualCompaction(manager)).toBeNull();
    expect(manager.listenerCount()).toBe(0);
    expect(installRendererManualCompaction(null)).toBeNull();
  });

  it("removes its notification callback on uninstall", () => {
    const manager = new FakeManager();
    const dispose = installRendererManualCompaction(manager);
    expect(manager.listenerCount()).toBe(1);
    dispose?.();
    expect(manager.listenerCount()).toBe(0);
    manager.notify(started("external"));
    expect(manager.registered).toEqual([]);
  });

  it("is installed per Host connection, including remote SSH Hosts", () => {
    const managers = new Map([
      ["local", new FakeManager()],
      ["ssh:remote", new FakeManager()],
    ]);
    const routes = new Map(
      [...managers].map(([hostId, manager]) => [
        hostId,
        { hostId, manager, policy: {} } as unknown as RendererHostRoute,
      ]),
    );
    const routing = {
      forHost: (hostId: string) => routes.get(hostId) ?? null,
    } as unknown as RendererHostRouting;
    const clients = createRendererHostClients(() => routing);
    try {
      expect(clients.forHost("ssh:remote")).not.toBeNull();
      expect(managers.get("ssh:remote")?.listenerCount()).toBe(1);
      expect(managers.get("local")?.listenerCount()).toBe(0);
      managers.get("ssh:remote")?.notify(started("external"));
      expect(managers.get("ssh:remote")?.registered).toEqual(["external"]);
    } finally {
      clients.dispose();
    }
    expect(managers.get("ssh:remote")?.listenerCount()).toBe(0);
  });
});
