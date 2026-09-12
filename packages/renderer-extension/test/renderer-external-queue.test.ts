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
    if (conversations.get(params.threadId)?.modelProvider === "codexhost") {
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
    sendRequest = rpc;
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
    vi.stubGlobal("window", {
      __codexhostDraftPrewarmPolicyV1: {
        state: "ready",
        hostId: "local",
        requestTarget: () => manager,
        select: () => true,
        clear: async () => undefined,
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

describe("external follow-ups retain Desktop's local queue", () => {
  it("queues another message during an external Turn without thread/queue/list or add", async () => {
    const f = fixture();
    const adapter = f.install();
    try {
      await expect(
        f.coordinator.sendMessage({ conversationId: "external", message: f.message }),
      ).resolves.toEqual({ status: "queued", messageId: f.message.id });
      expect(f.coordinator.readMessages("external")).toEqual([f.message]);
      expect(f.local.get("external")).toEqual([f.message]);
      expect(f.rpc).not.toHaveBeenCalled();
    } finally {
      adapter.dispose();
    }
  });

  it("preserves existing paused follow-ups and stays local after the queue drains", async () => {
    const f = fixture();
    const paused = {
      ...f.message,
      id: "paused",
      pausedReason: "Interrupted before the steer was accepted.",
    };
    f.local.set("external", [paused]);
    const adapter = f.install();
    try {
      await f.coordinator.sendMessage({ conversationId: "external", message: f.message });
      expect(f.local.get("external")).toEqual([paused, f.message]);
      f.local.delete("external");
      await f.coordinator.sendMessage({ conversationId: "external", message: f.message });
      expect(f.local.get("external")).toEqual([f.message]);
      expect(f.rpc).not.toHaveBeenCalled();
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
      expect(f.queue.isEnabled("external")).toBe(false);
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
      expect(f.queue.isEnabled("external")).toBe(false);
      expect(other.queue.isEnabled("external")).toBe(true);
      f.conversations.set("native", { id: "native", modelProvider: "codexhost" });
      expect(f.queue.isEnabled("native")).toBe(false);
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
      expect(f.queue.isEnabled("external")).toBe(false);
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
      expect(f.queue.isEnabled("external")).toBe(false);
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
