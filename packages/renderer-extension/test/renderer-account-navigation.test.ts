import { hostThreadIdSchema } from "@codexhost/shared-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRendererAccountNavigation } from "../src/renderer-account-navigation.js";

const threadId = hostThreadIdSchema.parse("existing-native-thread");

function fixture() {
  vi.useFakeTimers();
  const before = { isConnected: true } as Element;
  let editor: object | null = before;
  let displayedThread: string | null = threadId;
  let notify = () => {};
  const disconnect = vi.fn();
  const document = Object.assign(new EventTarget(), {
    documentElement: {},
    querySelector: () => editor,
    querySelectorAll: () => [row],
  });
  const attributes: Record<string, string> = {
    "data-app-action-sidebar-thread-row": "row-marker",
    "data-app-action-sidebar-thread-host-id": "local",
    "data-app-action-sidebar-thread-id": `local:${threadId}`,
  };
  const row = {
    __reactFiber$test: {
      memoizedProps: { conversationId: threadId, dataAttributes: attributes },
      return: null,
    },
    getAttribute: (name: string) => attributes[name] ?? null,
    click: vi.fn(() => {
      displayedThread = threadId;
    }),
  };
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", { setTimeout, clearTimeout });
  vi.stubGlobal(
    "Element",
    class Element {
      hasAttribute(): boolean {
        return false;
      }
    },
  );
  vi.stubGlobal(
    "MutationObserver",
    class {
      constructor(callback: () => void) {
        notify = callback;
      }
      observe() {}
      disconnect = disconnect;
    },
  );
  const navigation = createRendererAccountNavigation(() => ({ composer: before, threadId }));
  const response = Promise.withResolvers<{ committed: true }>();
  const operation = vi.fn(() => response.promise);
  const resetRouter = (nextThread: string | null = null) => {
    Object.defineProperty(before, "isConnected", { value: false });
    displayedThread = nextThread;
    editor = {
      querySelector: () =>
        displayedThread === null
          ? null
          : {
              getAttribute: () => displayedThread,
            },
    };
    notify();
  };
  return {
    navigation,
    response,
    operation,
    resetRouter,
    row,
    document,
    notify: () => notify(),
    disconnect,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Account switch navigation", () => {
  it("keeps the RPC result and opens the same Thread once after the delayed native router reset", async () => {
    const f = fixture();
    const pending = f.navigation.switchAccount(f.operation);
    f.response.resolve({ committed: true });
    await expect(pending).resolves.toEqual({ committed: true });
    expect(f.row.click).not.toHaveBeenCalled();
    f.resetRouter();
    await Promise.resolve();
    f.notify();
    expect(f.row.click).toHaveBeenCalledTimes(1);
    expect(f.operation).toHaveBeenCalledTimes(1);
    f.navigation.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits for success if the native router resets before the switch acknowledgement", async () => {
    const f = fixture();
    const pending = f.navigation.switchAccount(f.operation);
    f.resetRouter();
    expect(f.row.click).not.toHaveBeenCalled();
    f.response.resolve({ committed: true });
    await pending;
    expect(f.row.click).toHaveBeenCalledTimes(1);
    f.navigation.dispose();
  });

  it("starts the UI wait budget after the switch response, not before backend verification", async () => {
    const f = fixture();
    const pending = f.navigation.switchAccount(f.operation);
    await vi.advanceTimersByTimeAsync(35_000);
    f.response.resolve({ committed: true });
    await pending;
    f.resetRouter();
    expect(f.row.click).toHaveBeenCalledTimes(1);
    f.navigation.dispose();
  });

  it("does not revive navigation when disposed before the response", async () => {
    const f = fixture();
    const pending = f.navigation.switchAccount(f.operation);
    f.navigation.dispose();
    f.response.resolve({ committed: true });
    await pending;
    f.resetRouter();
    expect(f.row.click).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not navigate or retry when the switch is refused", async () => {
    const f = fixture();
    const pending = f.navigation.switchAccount(f.operation);
    f.resetRouter();
    const busy = new Error("busy");
    f.response.reject(busy);
    await expect(pending).rejects.toBe(busy);
    f.notify();
    expect(f.row.click).not.toHaveBeenCalled();
    expect(f.operation).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["pointerdown", "keydown"])(
    "does not override user navigation after %s outside Settings",
    async (type) => {
      const f = fixture();
      const pending = f.navigation.switchAccount(f.operation);
      f.response.resolve({ committed: true });
      await pending;
      f.document.dispatchEvent(new Event(type));
      f.resetRouter();
      expect(f.row.click).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("keeps waiting when the user interacts inside Settings", async () => {
    const f = fixture();
    const pending = f.navigation.switchAccount(f.operation);
    f.response.resolve({ committed: true });
    await pending;
    const shell = new Element();
    vi.spyOn(shell, "hasAttribute").mockImplementation(
      (name) => name === "data-codexhost-settings-shell",
    );
    const event = new Event("pointerdown");
    vi.spyOn(event, "composedPath").mockReturnValue([shell]);
    f.document.dispatchEvent(event);
    f.resetRouter();
    expect(f.row.click).toHaveBeenCalledTimes(1);
    f.navigation.dispose();
  });

  it.each([threadId, "another-thread"])(
    "does not replace an already selected Thread (%s)",
    async (selected) => {
      const f = fixture();
      const pending = f.navigation.switchAccount(f.operation);
      f.response.resolve({ committed: true });
      await pending;
      f.resetRouter(selected);
      expect(f.row.click).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("expires without keeping listeners or navigating on a later unrelated reset", async () => {
    const f = fixture();
    const pending = f.navigation.switchAccount(f.operation);
    f.response.resolve({ committed: true });
    await pending;
    await vi.advanceTimersByTimeAsync(30_001);
    f.resetRouter();
    expect(f.row.click).not.toHaveBeenCalled();
    expect(f.disconnect).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does nothing for drafts, external Harnesses, remote Hosts or unavailable bindings", async () => {
    fixture();
    const operation = vi.fn(async () => "unchanged");
    const navigation = createRendererAccountNavigation(() => null);
    await expect(navigation.switchAccount(operation)).resolves.toBe("unchanged");
    expect(vi.getTimerCount()).toBe(0);
    expect(operation).toHaveBeenCalledTimes(1);
  });
});
