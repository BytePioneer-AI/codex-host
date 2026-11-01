import type {
  RendererHostRoute,
  RendererHostRouting,
} from "@codexhost/desktop-control/renderer-bindings";
import { THREAD_MANUAL_COMPACTION_STARTED_METHOD } from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import { createRendererHostClients } from "../src/renderer-host-clients.js";
import {
  installRendererManualCompaction,
  type RendererMessageTarget,
} from "../src/renderer-manual-compaction.js";

type MessageListener = Parameters<RendererMessageTarget["addEventListener"]>[1];

// Mirrors the Desktop manager members this binding reads. Methods live on the
// prototype, as on Desktop's RpcTarget manager.
class FakeManager {
  readonly conversations = new Map<string, unknown>([
    ["external", { id: "external", modelProvider: "codexhost" }],
    ["native", { id: "native", modelProvider: "openai" }],
  ]);
  readonly roles = new Map<string, unknown>();
  readonly registered: string[] = [];

  sendRequest(): Promise<unknown> {
    return Promise.reject(new Error("Unexpected RPC"));
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
}

// Desktop's main process posts each Host notification to the Renderer window
// as { type: "mcp-notification", hostId, method, params }.
class FakeWindow implements RendererMessageTarget {
  readonly listeners = new Set<MessageListener>();

  addEventListener(type: "message", listener: MessageListener): void {
    if (type === "message") this.listeners.add(listener);
  }
  removeEventListener(type: "message", listener: MessageListener): void {
    if (type === "message") this.listeners.delete(listener);
  }
  post(data: unknown, source: unknown = this): void {
    for (const listener of [...this.listeners]) listener({ data, source });
  }
  notify(
    params: unknown,
    { hostId = "local", method = THREAD_MANUAL_COMPACTION_STARTED_METHOD } = {},
  ): void {
    this.post({ type: "mcp-notification", hostId, method, params });
  }
}

const started = (threadId: string) => ({ threadId, turnId: "compact-turn" });

function install(manager: FakeManager, window: FakeWindow, hostId = "local") {
  return installRendererManualCompaction(manager, hostId, window);
}

describe("renderer manual compaction registration", () => {
  it("registers an announced external command compaction with Desktop", () => {
    const manager = new FakeManager();
    const window = new FakeWindow();
    manager.roles.set("external", { role: "owner" });
    const dispose = install(manager, window);
    expect(dispose).toBeTypeOf("function");
    window.notify(started("external"));
    expect(manager.registered).toEqual(["external"]);
    dispose?.();
  });

  it("registers when Desktop reports no stream role or the message has no source", () => {
    const manager = new FakeManager();
    const window = new FakeWindow();
    const dispose = install(manager, window);
    window.post(
      {
        type: "mcp-notification",
        hostId: "local",
        method: THREAD_MANUAL_COMPACTION_STARTED_METHOD,
        params: started("external"),
      },
      null,
    );
    expect(manager.registered).toEqual(["external"]);
    dispose?.();
  });

  it("does not register in a follower window, which never consumes the registration", () => {
    const manager = new FakeManager();
    const window = new FakeWindow();
    manager.roles.set("external", { role: "follower", ownerClientId: "owner-window" });
    const dispose = install(manager, window);
    window.notify(started("external"));
    expect(manager.registered).toEqual([]);
    dispose?.();
  });

  it("registers only loaded Host-projected external Threads", () => {
    const manager = new FakeManager();
    const window = new FakeWindow();
    manager.conversations.set("mismatched", { id: "other", modelProvider: "codexhost" });
    const dispose = install(manager, window);
    for (const threadId of ["native", "unloaded", "mismatched"]) window.notify(started(threadId));
    expect(manager.registered).toEqual([]);
    dispose?.();
  });

  it("ignores other Hosts, other frames, other messages and malformed announcements", () => {
    const manager = new FakeManager();
    const window = new FakeWindow();
    const dispose = install(manager, window);
    window.notify(started("external"), { hostId: "ssh:remote" });
    window.notify(started("external"), { method: "thread/status/changed" });
    window.post(
      {
        type: "mcp-notification",
        hostId: "local",
        method: THREAD_MANUAL_COMPACTION_STARTED_METHOD,
        params: started("external"),
      },
      { frame: "embedded" },
    );
    window.post({
      type: "mcp-request",
      hostId: "local",
      method: THREAD_MANUAL_COMPACTION_STARTED_METHOD,
      params: started("external"),
    });
    window.notify({ threadId: "external" });
    window.notify({ ...started("external"), extra: true });
    window.notify(null);
    window.post(null);
    window.post("mcp-notification");
    expect(manager.registered).toEqual([]);
    dispose?.();
  });

  it("leaves Desktop builds without the registration binding unchanged", () => {
    const manager = new FakeManager();
    const window = new FakeWindow();
    Object.defineProperty(manager, "registerPendingManualContextCompaction", { value: undefined });
    expect(install(manager, window)).toBeNull();
    expect(window.listeners.size).toBe(0);
    expect(installRendererManualCompaction(null, "local", window)).toBeNull();
    expect(installRendererManualCompaction(new FakeManager(), "local", null)).toBeNull();
    expect(window.listeners.size).toBe(0);
  });

  it("removes its message listener on uninstall", () => {
    const manager = new FakeManager();
    const window = new FakeWindow();
    const dispose = install(manager, window);
    expect(window.listeners.size).toBe(1);
    dispose?.();
    expect(window.listeners.size).toBe(0);
    window.notify(started("external"));
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
    const window = new FakeWindow();
    const clients = createRendererHostClients(() => routing, window);
    try {
      expect(clients.forHost("ssh:remote")).not.toBeNull();
      expect(window.listeners.size).toBe(1);
      window.notify(started("external"), { hostId: "local" });
      expect(managers.get("ssh:remote")?.registered).toEqual([]);
      window.notify(started("external"), { hostId: "ssh:remote" });
      expect(managers.get("ssh:remote")?.registered).toEqual(["external"]);
      expect(managers.get("local")?.registered).toEqual([]);
    } finally {
      clients.dispose();
    }
    expect(window.listeners.size).toBe(0);
  });
});
