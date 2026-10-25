import { afterEach, describe, expect, it, vi } from "vitest";

import { installOverlayExternalFollowUps } from "../src/renderer-overlay-external-followups.js";

const overlayHref = "app://-/index.html?initialRoute=%2Favatar-overlay";

function followUpManager() {
  const conversations = new Map([["external", { id: "external", modelProvider: "codexhost" }]]);
  const isEnabled = vi.fn(() => true);
  const queue = { isEnabled };
  const coordinator = {
    serverQueue: queue,
    getTurnCoordinator() {
      return this;
    },
  };
  const manager = {
    sendRequest: vi.fn(async (method: string, params: unknown) => ({ method, params })),
    steerTurn: vi.fn(),
    startTurn: vi.fn(),
    getStreamRole: vi
      .fn<(threadId: string) => { role: string }>()
      .mockReturnValue({ role: "follower" }),
    getTurnCoordinator: () => coordinator,
    getConversation: (threadId: string) => conversations.get(threadId) ?? null,
  };
  return { manager, queue, originalGate: isEnabled };
}

function overlayDocument(manager?: object): Document {
  const surface: Record<string, unknown> = {};
  if (manager) {
    Object.defineProperty(surface, "__reactFiber$test", {
      value: { memoizedState: { memoizedState: manager, next: null }, return: null },
      configurable: true,
    });
  }
  const attach = (value: object) => {
    Object.defineProperty(surface, "__reactFiber$test", {
      value: { memoizedState: { memoizedState: value, next: null }, return: null },
      configurable: true,
    });
  };
  const document = {
    querySelectorAll: (selector: string) =>
      selector.includes("data-avatar-overlay-native-surface-id") ? [surface] : [],
    documentElement: {},
    attach,
  };
  return document as unknown as Document;
}

describe("overlay external follow-up bindings", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stays disabled outside the avatar overlay", () => {
    const hook = installOverlayExternalFollowUps({
      location: { href: "app://-/index.html" },
      document: overlayDocument(),
      setTimeout,
      clearTimeout,
    });
    expect(hook.status).toBe("disabled");
    hook.dispose();
  });

  it("treats overlay-owned External Threads as the stream owner so Host queue drain can run", () => {
    const f = followUpManager();
    const hook = installOverlayExternalFollowUps({
      location: { href: overlayHref },
      document: overlayDocument(f.manager),
      setTimeout,
      clearTimeout,
    });
    try {
      expect(hook.status).toBe("active");
      expect(f.manager.getStreamRole("external")).toEqual({ role: "owner" });
      expect(f.queue.isEnabled).toBe(f.originalGate);
    } finally {
      hook.dispose();
    }
    expect(f.manager.getStreamRole("external")).toEqual({ role: "follower" });
  });

  it("keeps polling until the overlay surface publishes a manager", () => {
    vi.useFakeTimers();
    const f = followUpManager();
    const root = overlayDocument();
    const hook = installOverlayExternalFollowUps({
      location: { href: overlayHref },
      document: root,
      setTimeout,
      clearTimeout,
    });
    expect(hook.status).toBe("pending");
    (root as unknown as { attach(value: object): void }).attach(f.manager);
    vi.advanceTimersByTime(50);
    expect(hook.status).toBe("active");
    expect(f.manager.getStreamRole("external")).toEqual({ role: "owner" });
    hook.dispose();
  });
});
