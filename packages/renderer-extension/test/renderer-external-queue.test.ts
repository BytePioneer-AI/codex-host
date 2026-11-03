import {
  IDLE_RELEASE_SETTINGS_METHOD,
  idleReleaseSettingsSchema,
} from "@codexhost/shared-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { installCurrentRendererAdapter } from "../src/versioned-renderer-adapter.js";

interface QueuedMessage {
  id: string;
  text: string;
  context: { prompt: string };
  pausedReason?: string;
}

function fixture() {
  const conversations = new Map([
    ["external", { id: "external", modelProvider: "codexhost" }],
    ["native", { id: "native", modelProvider: "openai" }],
  ]);
  const local = new Map<string, QueuedMessage[]>();
  const remote = new Map<string, QueuedMessage[]>();
  const rpc = vi.fn(async (method: string, params: { threadId: string }) => {
    // Desktop 26.1027 routes external Threads to the codexhost Host, which
    // implements `thread/queue/*` natively — these requests succeed. Only a
    // stock app-server connection would reject them (-32076).
    if (conversations.get(params.threadId)?.modelProvider === "closed-source-only") {
      throw Object.assign(new Error(`External Thread does not support ${method}`), {
        code: -32076,
      });
    }
    return { data: remote.get(params.threadId) ?? [], nextCursor: null };
  });
  const queue = {
    isEnabled: vi.fn<(threadId?: unknown) => boolean>(() => true),
    read: (threadId: string) => remote.get(threadId),
    load: async (threadId: string) => {
      const result = await rpc("thread/queue/list", { threadId });
      remote.set(threadId, result.data);
    },
    enqueue: async (threadId: string, message: QueuedMessage) => {
      await rpc("thread/queue/add", { threadId });
      remote.set(threadId, [...(remote.get(threadId) ?? []), message]);
      return { status: "queued", messageId: message.id };
    },
  };
  // Desktop 26.903.61454 selects the server queue only when isEnabled(threadId)
  // and the legacy local queue is empty. All queue operations go through this
  // same selection; an empty thread/queue/list reply alone cannot fix admission.
  class Coordinator {
    serverQueue: typeof queue | undefined = queue;

    #selectedQueue(threadId: string) {
      return this.serverQueue?.isEnabled(threadId) && (local.get(threadId) ?? []).length === 0
        ? this.serverQueue
        : undefined;
    }
    loadMessages = async (threadId: string) => {
      const selected = this.#selectedQueue(threadId);
      if (selected && selected.read(threadId) == null) await selected.load(threadId);
    };
    readMessages(threadId: string) {
      return this.#selectedQueue(threadId)?.read(threadId) ?? local.get(threadId) ?? [];
    }
    async sendMessage({
      conversationId,
      message,
    }: {
      conversationId: string;
      message: QueuedMessage;
    }) {
      // The running-Turn / queue branch of Desktop's sendMessage.
      await this.loadMessages(conversationId);
      const selected = this.#selectedQueue(conversationId);
      if (selected) return selected.enqueue(conversationId, message);
      local.set(conversationId, [...(local.get(conversationId) ?? []), message]);
      return { status: "queued", messageId: message.id };
    }
  }
  const coordinator = new Coordinator();
  class Manager {
    readonly hostId = "local";
    readonly #conversations = conversations;
    async sendRequest(method: string, params: unknown) {
      // Settings sync shares the connection but is not a queue operation.
      if (method === IDLE_RELEASE_SETTINGS_METHOD) return idleReleaseSettingsSchema.parse(params);
      if (
        method.startsWith("thread/queue/") &&
        params !== null &&
        typeof params === "object" &&
        "threadId" in params &&
        typeof params.threadId === "string"
      ) {
        return rpc(method, { threadId: params.threadId });
      }
      throw new Error(`Unexpected RPC: ${method}`);
    }
    prewarmThreadStart = vi.fn();
    enqueueRequest = vi.fn();
    getConversation(threadId: string) {
      return this.#conversations.get(threadId) ?? null;
    }
    getTurnCoordinator() {
      return coordinator;
    }
  }
  const manager = new Manager();
  const install = () => {
    const policy = {
      state: "ready",
      hostId: "local",
      requestTarget: () => manager,
      select: () => true,
      clear: async () => undefined,
    };
    const route = { hostId: "local", manager, policy };
    vi.stubGlobal("window", {
      __codexhostHostRoutingV1: {
        forHost: (hostId: string) => (hostId === "local" ? route : null),
        forComposer: () => route,
        hostIdForComposer: () => "local",
      },
      dispatchEvent: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    vi.stubGlobal("document", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    const adapter = installCurrentRendererAdapter();
    expect(adapter.status.state).toBe("ready");
    return adapter;
  };
  const message: QueuedMessage = {
    id: "follow-up",
    text: "next task",
    context: { prompt: "next task" },
  };
  return {
    manager,
    coordinator,
    queue,
    originalGate: queue.isEnabled,
    local,
    conversations,
    rpc,
    install,
    message,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("external follow-ups use the Host-served queue", () => {
  it("queues another message during an external Turn through the Host queue", async () => {
    const f = fixture();
    const adapter = f.install();
    try {
      await expect(
        f.coordinator.sendMessage({ conversationId: "external", message: f.message }),
      ).resolves.toEqual({ status: "queued", messageId: f.message.id });
      expect(f.coordinator.readMessages("external")).toEqual([f.message]);
      expect(f.rpc.mock.calls).toEqual([
        ["thread/queue/list", { threadId: "external" }],
        ["thread/queue/add", { threadId: "external" }],
      ]);
      expect(f.local.has("external")).toBe(false);
    } finally {
      adapter.dispose();
    }
  });

  it("keeps local paused follow-ups until they drain, then uses the Host queue", async () => {
    const f = fixture();
    const paused = {
      ...f.message,
      id: "paused",
      pausedReason: "Interrupted before the steer was accepted.",
    };
    f.local.set("external", [paused]);
    const adapter = f.install();
    try {
      // A non-empty legacy local queue still routes to Desktop's local queue:
      // paused entries must not be abandoned on the Host-side queue.
      await f.coordinator.sendMessage({ conversationId: "external", message: f.message });
      expect(f.local.get("external")).toEqual([paused, f.message]);
      f.local.delete("external");
      // Once the local queue is empty, the Host-served queue takes over.
      await f.coordinator.sendMessage({ conversationId: "external", message: f.message });
      expect(f.rpc.mock.calls).toEqual([
        ["thread/queue/list", { threadId: "external" }],
        ["thread/queue/add", { threadId: "external" }],
      ]);
      expect(f.local.has("external")).toBe(false);
    } finally {
      adapter.dispose();
    }
  });

  it("keeps native Threads on the enabled server queue on the same connection", async () => {
    const f = fixture();
    const adapter = f.install();
    try {
      await f.coordinator.sendMessage({ conversationId: "native", message: f.message });
      expect(f.rpc.mock.calls).toEqual([
        ["thread/queue/list", { threadId: "native" }],
        ["thread/queue/add", { threadId: "native" }],
      ]);
      expect(f.local.has("native")).toBe(false);
      expect(f.coordinator.readMessages("native")).toEqual([f.message]);
      expect(f.queue.isEnabled("external")).toBe(true);
      expect(f.queue.isEnabled("native")).toBe(true);
      expect(f.originalGate.mock.contexts.every((receiver) => receiver === f.queue)).toBe(true);
    } finally {
      adapter.dispose();
    }
  });

  it("reads current per-manager Thread metadata rather than the selected Agent or an ID cache", () => {
    const f = fixture();
    const other = fixture();
    const adapter = f.install();
    try {
      expect(f.queue.isEnabled("external")).toBe(true);
      expect(other.queue.isEnabled("external")).toBe(true);
      f.conversations.set("native", { id: "native", modelProvider: "codexhost" });
      expect(f.queue.isEnabled("native")).toBe(true);
      expect(other.queue.isEnabled("native")).toBe(true);
      expect(f.queue.isEnabled("unloaded")).toBe(true);
      expect(f.queue.isEnabled()).toBe(true);
      f.originalGate.mockReturnValue(false);
      expect(f.queue.isEnabled("unloaded")).toBe(false);
    } finally {
      adapter.dispose();
    }
  });

  it("restores the original gate on uninstall and can install again", () => {
    const f = fixture();
    for (let i = 0; i < 2; i++) {
      const adapter = f.install();
      expect(f.queue.isEnabled("external")).toBe(true);
      adapter.dispose();
      expect(f.queue.isEnabled).toBe(f.originalGate);
      expect(Object.hasOwn(f.manager, "getTurnCoordinator")).toBe(false);
    }
  });

  it("requires matching external Thread metadata and does not overwrite a later wrapper", () => {
    const f = fixture();
    const adapter = f.install();
    try {
      f.conversations.set("native", { id: "different-thread", modelProvider: "codexhost" });
      expect(f.queue.isEnabled("native")).toBe(true);
      f.conversations.delete("external");
      expect(f.queue.isEnabled("external")).toBe(true);
      f.conversations.set("external", { id: "external", modelProvider: "codexhost" });
      expect(f.queue.isEnabled("external")).toBe(true);
      const replacement = vi.fn(() => false);
      f.queue.isEnabled = replacement;
      adapter.dispose();
      expect(f.queue.isEnabled).toBe(replacement);
    } finally {
      adapter.dispose();
    }
  });

  it("does not patch a server queue with an incompatible gate property", () => {
    const f = fixture();
    Object.defineProperty(f.queue, "isEnabled", { writable: false });
    const adapter = f.install();
    try {
      expect(f.queue.isEnabled).toBe(f.originalGate);
    } finally {
      adapter.dispose();
    }
  });

  it("leaves older Desktop coordinators without a server queue unchanged", async () => {
    const f = fixture();
    f.coordinator.serverQueue = undefined;
    const adapter = f.install();
    try {
      await f.coordinator.sendMessage({ conversationId: "external", message: f.message });
      expect(f.local.get("external")).toEqual([f.message]);
      expect(f.rpc).not.toHaveBeenCalled();
    } finally {
      adapter.dispose();
    }
  });
});
