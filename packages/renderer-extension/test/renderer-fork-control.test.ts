import {
  hostThreadIdSchema,
  hostTurnIdSchema,
  type ThreadInspection,
} from "@codexhost/shared-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  installRendererForkControl,
  openRendererThread,
  rendererForkTargetFromButton,
  type RendererForkDom,
  type RendererForkTarget,
} from "../src/renderer-fork-control.js";
import type { RendererModelClient } from "../src/renderer-model-client.js";

class FakeForkDom implements RendererForkDom {
  listener: ((target: RendererForkTarget) => boolean) | null = null;
  readonly openThread = vi.fn(async () => undefined);
  readonly replay = vi.fn();

  listen(onFork: (target: RendererForkTarget) => boolean): () => void {
    this.listener = onFork;
    return () => {
      this.listener = null;
    };
  }

  emit(target: RendererForkTarget): boolean {
    return this.listener?.(target) ?? false;
  }
}

function clientWith(inspection: ThreadInspection): RendererModelClient {
  return {
    forkThread: vi.fn(async () => ({ threadId: hostThreadIdSchema.parse("derived-thread") })),
    inspectHarness: vi.fn(),
    inspectThread: vi.fn(async () => inspection),
    inspectHarnessCommands: vi.fn(),
    inspectThreadCommands: vi.fn(),
    executeThreadCommand: vi.fn(),
    inspectThreadUsage: vi.fn(),
    listThreadOwnership: vi.fn(),
    selectThreadModel: vi.fn(),
    selectThreadThinking: vi.fn(),
    selectThreadPermissionMode: vi.fn(),
    checkUpdate: vi.fn(),
    startUpdate: vi.fn(),
    readUpdateStatus: vi.fn(),
  };
}

function target(isProjectlessConversation = true): RendererForkTarget {
  return {
    control: {},
    isProjectlessConversation,
    threadId: hostThreadIdSchema.parse("source-thread"),
    turnId: hostTurnIdSchema.parse("source-turn"),
  };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function forkButton(
  input: {
    domThreadId?: string;
    fiberThreadId?: string;
    domTurnId?: string;
    fiberTurnId?: string;
    forkSignature?: boolean;
    isProjectlessConversation?: boolean;
    projectlessSignature?: boolean;
  } = {},
): HTMLButtonElement {
  const domThreadId = input.domThreadId ?? "source-thread";
  const fiberThreadId = input.fiberThreadId ?? domThreadId;
  const domTurnId = input.domTurnId ?? "source-turn";
  const fiberTurnId = input.fiberTurnId ?? domTurnId;
  const annotation = {
    getAttribute: (name: string) =>
      name === "data-response-annotation-conversation" ? domThreadId : null,
  };
  const turn = {
    getAttribute: (name: string) => (name === "data-content-search-turn-key" ? domTurnId : null),
  };
  const button = {
    closest(selector: string) {
      if (selector === "[data-response-annotation-conversation]") return annotation;
      if (selector === "[data-content-search-turn-key]") return turn;
      return null;
    },
  } as unknown as HTMLButtonElement;
  const fiber = {
    memoizedProps:
      input.forkSignature === false ? { onClick: vi.fn() } : { "aria-busy": undefined },
    return: {
      memoizedProps: {
        conversationId: fiberThreadId,
        turnId: fiberTurnId,
        hostId: "local",
        onFork: vi.fn(),
        ...(input.projectlessSignature === false
          ? {}
          : { isProjectlessConversation: input.isProjectlessConversation ?? false }),
      },
      return: null,
    },
  };
  Object.defineProperty(button, "__reactFiber$test", { value: fiber });
  return button;
}

function sidebarRow(threadId: string, hostId: string) {
  const attributes = {
    "data-app-action-sidebar-thread-row": "row-marker",
    "data-app-action-sidebar-thread-id": `${hostId}:${threadId}`,
    "data-app-action-sidebar-thread-host-id": hostId,
  } as const;
  const row = {
    click: vi.fn(),
    getAttribute: (name: string) => attributes[name as keyof typeof attributes] ?? null,
  } as unknown as HTMLElement;
  Object.defineProperty(row, "__reactFiber$test", {
    value: {
      memoizedProps: {
        conversationId: threadId,
        dataAttributes: attributes,
      },
      return: null,
    },
  });
  return row;
}

describe("Renderer external Thread Fork control", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("opens only the Host-qualified standard sidebar row", async () => {
    const local = sidebarRow("same-thread", "local");
    const remote = sidebarRow("same-thread", "remote-1");
    vi.stubGlobal("document", {
      querySelectorAll: () => [local, remote],
      documentElement: {},
    });

    await openRendererThread(hostThreadIdSchema.parse("same-thread"), { hostId: "remote-1" });

    expect(local.click).not.toHaveBeenCalled();
    expect(remote.click).toHaveBeenCalledOnce();
  });

  it("keeps the generic Fork opener compatible with a Remote Host row", async () => {
    const remote = sidebarRow("remote-thread", "remote-1");
    vi.stubGlobal("document", {
      querySelectorAll: () => [remote],
      documentElement: {},
    });

    await openRendererThread(hostThreadIdSchema.parse("remote-thread"));

    expect(remote.click).toHaveBeenCalledOnce();
  });

  it("opens a delayed Host-qualified row and releases its observer", async () => {
    const local = sidebarRow("delayed-thread", "local");
    let rows: HTMLElement[] = [];
    const callbacks: MutationCallback[] = [];
    const disconnect = vi.fn();
    class FakeMutationObserver {
      constructor(callback: MutationCallback) {
        callbacks.push(callback);
      }
      observe = vi.fn();
      disconnect = disconnect;
    }
    vi.stubGlobal("document", {
      querySelectorAll: () => rows,
      documentElement: {},
    });
    vi.stubGlobal("window", {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    });
    vi.stubGlobal("MutationObserver", FakeMutationObserver);
    const opening = openRendererThread(hostThreadIdSchema.parse("delayed-thread"), {
      hostId: "local",
      timeoutMs: 60_000,
    });

    rows = [local];
    const notify = callbacks[0];
    if (!notify) throw new Error("Sidebar observer was not installed");
    notify([], {} as MutationObserver);
    await opening;

    expect(local.click).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("aborts a pending sidebar wait and releases its observer", async () => {
    const disconnect = vi.fn();
    class FakeMutationObserver {
      observe = vi.fn();
      disconnect = disconnect;
    }
    vi.stubGlobal("document", { querySelectorAll: () => [], documentElement: {} });
    vi.stubGlobal("window", {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    });
    vi.stubGlobal("MutationObserver", FakeMutationObserver);
    const abort = new AbortController();
    const opening = openRendererThread(hostThreadIdSchema.parse("pending-thread"), {
      hostId: "remote-1",
      signal: abort.signal,
      timeoutMs: 60_000,
    });

    abort.abort();

    await expect(opening).rejects.toMatchObject({ name: "AbortError" });
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("times out a missing sidebar row and releases its observer", async () => {
    vi.useFakeTimers();
    const disconnect = vi.fn();
    class FakeMutationObserver {
      observe = vi.fn();
      disconnect = disconnect;
    }
    vi.stubGlobal("document", { querySelectorAll: () => [], documentElement: {} });
    vi.stubGlobal("window", {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    });
    vi.stubGlobal("MutationObserver", FakeMutationObserver);
    const opening = openRendererThread(hostThreadIdSchema.parse("missing-thread"), {
      hostId: "local",
      timeoutMs: 5,
    });
    const rejection = expect(opening).rejects.toThrow("Thread did not appear in the sidebar");

    await vi.advanceTimersByTimeAsync(5);

    await rejection;
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("resolves a Fork button only when DOM and Fiber identities agree", () => {
    expect(rendererForkTargetFromButton(forkButton())).toMatchObject({
      isProjectlessConversation: false,
      threadId: "source-thread",
      turnId: "source-turn",
    });
    expect(
      rendererForkTargetFromButton(forkButton({ fiberThreadId: "different-thread" })),
    ).toBeNull();
    expect(rendererForkTargetFromButton(forkButton({ fiberTurnId: "different-turn" }))).toBeNull();
    expect(rendererForkTargetFromButton(forkButton({ forkSignature: false }))).toBeNull();
    expect(rendererForkTargetFromButton(forkButton({ projectlessSignature: false }))).toBeNull();
  });

  it("intercepts a projectless external Fork and opens the derived Thread", async () => {
    const dom = new FakeForkDom();
    const client = clientWith({
      owner: "external",
      harnessId: "pi",
      transportModelId: "codexhost/pi-native",
      history: { fork: true, forkAcrossCwd: true, rollbackLastTurn: false },
      locked: true,
    });
    const control = installRendererForkControl({ getClient: () => client, dom });

    expect(dom.emit(target())).toBe(true);
    await settle();

    expect(client.forkThread).toHaveBeenCalledWith({
      threadId: "source-thread",
      lastTurnId: "source-turn",
    });
    expect(dom.openThread).toHaveBeenCalledWith("derived-thread");
    expect(dom.replay).not.toHaveBeenCalled();
    control.dispose();
  });

  it("replays the native destination flow for a project external Thread", async () => {
    const dom = new FakeForkDom();
    const client = clientWith({
      owner: "external",
      harnessId: "pi",
      transportModelId: "codexhost/pi-native",
      history: { fork: true, forkAcrossCwd: true, rollbackLastTurn: false },
      locked: true,
    });
    const source = target(false);
    const control = installRendererForkControl({ getClient: () => client, dom });

    expect(dom.emit(source)).toBe(true);
    await settle();

    expect(dom.replay).toHaveBeenCalledWith(source);
    expect(client.forkThread).not.toHaveBeenCalled();
    control.dispose();
  });

  it("replays the native destination flow for a project Thread without cross-cwd capability", async () => {
    const dom = new FakeForkDom();
    const client = clientWith({
      owner: "external",
      harnessId: "claude-code",
      transportModelId: "codexhost/claude-code-native",
      history: { fork: true, forkAcrossCwd: false, rollbackLastTurn: false },
      locked: true,
    });
    const source = target(false);
    const control = installRendererForkControl({ getClient: () => client, dom });

    expect(dom.emit(source)).toBe(true);
    await settle();

    expect(dom.replay).toHaveBeenCalledWith(source);
    expect(client.forkThread).not.toHaveBeenCalled();
    expect(dom.openThread).not.toHaveBeenCalled();
    control.dispose();
  });

  it("replays the native action for a Codex-owned Thread", async () => {
    const dom = new FakeForkDom();
    const client = clientWith({ owner: "codex", locked: true });
    const source = target();
    const control = installRendererForkControl({ getClient: () => client, dom });

    expect(dom.emit(source)).toBe(true);
    await settle();

    expect(dom.replay).toHaveBeenCalledWith(source);
    expect(client.forkThread).not.toHaveBeenCalled();
    control.dispose();
  });

  it("leaves the native action untouched when the fixed request client is unavailable", () => {
    const dom = new FakeForkDom();
    const control = installRendererForkControl({ getClient: () => null, dom });

    expect(dom.emit(target())).toBe(false);
    control.dispose();
    expect(dom.listener).toBeNull();
  });
});
