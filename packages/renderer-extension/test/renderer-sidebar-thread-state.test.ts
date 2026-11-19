import { describe, expect, it, vi } from "vitest";
import {
  createRendererSidebarThreadState,
  repairSidebarThreadState,
} from "../src/renderer-sidebar-thread-state.js";

type Atom = { read(get: (atom: Atom) => unknown): unknown };

function fixture(provider = "codexhost", hostId = "local") {
  let state: unknown = {
    summary: { conversationId: "thread", hostId, modelProvider: provider },
    requests: [],
    resumeState: "resumed",
  };
  const leaf: Atom = { read: () => state };
  const atom: Atom = { read: (get) => get(leaf) };
  // The selector retains a null cache after its owned dependencies are replaced.
  const listeners = new Map<Atom, Set<() => void>>();
  const store = {
    get(candidate: Atom): unknown {
      return candidate === atom ? null : candidate.read(store.get);
    },
    set: vi.fn(),
    sub(candidate: Atom, listener: () => void) {
      const set = listeners.get(candidate) ?? new Set();
      listeners.set(candidate, set);
      set.add(listener);
      return () => {
        set.delete(listener);
      };
    },
  };
  const signal = {
    atom,
    store,
    get: () => store.get(atom),
    subscribe: (fn: () => void) => store.sub(atom, fn),
  };
  const subscriber = {
    getSnapshot: signal.get,
    subscribe: signal.subscribe,
    createRender: () => undefined,
  };
  const instance = { value: null as unknown, getSnapshot: () => subscriber.getSnapshot() };
  const render = vi.fn(() => {
    instance.value = instance.getSnapshot();
  });
  const effect = { deps: [subscriber.subscribe], create: () => subscriber.subscribe(render) };
  const hook = {
    memoizedState: [subscriber, [signal, undefined]],
    next: { queue: instance, next: { memoizedState: effect } },
  };
  const owner = {
    memoizedProps: {
      conversationId: "thread",
      hostId: "local",
      dataAttributes: {
        "data-app-action-sidebar-thread-row": "",
        "data-app-action-sidebar-thread-id": "local:thread",
        "data-app-action-sidebar-thread-host-id": "local",
      },
    },
    memoizedState: hook,
  };
  effect.create();
  return {
    owner,
    hook,
    store,
    atom,
    subscriber,
    instance,
    render,
    listenerCount: () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0),
    update(next: unknown) {
      state = next;
      for (const set of listeners.values()) for (const fn of set) fn();
    },
  };
}

describe("sidebar Thread state cache repair", () => {
  it("restores a row whose cached selector is null while its current dependencies contain the Thread", () => {
    const f = fixture();
    expect(f.instance.getSnapshot()).toBeNull();
    const originalSub = f.store.sub;
    const repair = repairSidebarThreadState(f.owner);
    expect(repair).not.toBeNull();
    expect(f.instance.value).toMatchObject({ summary: { conversationId: "thread" } });
    expect(f.store.get(f.atom)).toBeNull();
    expect(f.store.sub).toBe(originalSub);
    expect(f.store.set).not.toHaveBeenCalled();
    repair?.dispose();
  });

  it("follows native updates and genuine removal, and releases its subscription", () => {
    const f = fixture();
    const count = f.listenerCount();
    const original = f.instance.getSnapshot;
    const repair = repairSidebarThreadState(f.owner);
    expect(f.listenerCount()).toBe(count + 1);
    f.update({
      summary: { conversationId: "thread", hostId: "local", modelProvider: "codexhost" },
      requests: [],
      resumeState: "resuming",
    });
    expect(f.instance.value).toMatchObject({ resumeState: "resuming" });
    f.update(null);
    expect(f.instance.value).toBeNull();
    repair?.dispose();
    expect(f.listenerCount()).toBe(count);
    expect(f.instance.getSnapshot).toBe(original);
  });

  it.each(["openai", "other"])("leaves %s Threads on the native subscription", (provider) => {
    const f = fixture(provider);
    expect(repairSidebarThreadState(f.owner)).toBeNull();
    expect(f.listenerCount()).toBe(1);
  });

  it("rejects a different Host and genuine missing data", () => {
    expect(repairSidebarThreadState(fixture("codexhost", "remote").owner)).toBeNull();
    const f = fixture();
    f.update(null);
    expect(repairSidebarThreadState(f.owner)).toBeNull();
  });

  it("does not bind a non-sidebar component or ambiguous state selectors", () => {
    const f = fixture();
    expect(
      repairSidebarThreadState({ ...f.owner, memoizedProps: { conversationId: "thread" } }),
    ).toBeNull();
    Object.assign(f.hook.next.next, {
      next: {
        memoizedState: f.hook.memoizedState,
        next: { queue: f.instance, next: { memoizedState: f.hook.next.next.memoizedState } },
      },
    });
    expect(repairSidebarThreadState(f.owner)).toBeNull();
  });

  it("finds a row rendering null through the committed sidebar tree and cleans up on unmount", () => {
    const f = fixture();
    const sidebar = { child: f.owner, return: null as unknown };
    const root = { child: sidebar, stateNode: { current: null as unknown } };
    sidebar.return = root;
    root.stateNode.current = root;
    const stale = { return: root, alternate: sidebar };
    const element = { __reactFiber$test: stale };
    const dom = { querySelectorAll: () => [element] } as unknown as ParentNode;
    const control = createRendererSidebarThreadState(dom);
    control.refresh();
    expect(f.instance.value).toMatchObject({ summary: { conversationId: "thread" } });
    const count = f.listenerCount();
    control.refresh();
    expect(f.listenerCount()).toBe(count);
    Object.assign(sidebar, { child: null });
    control.refresh();
    expect(f.listenerCount()).toBe(1);
    control.dispose();
  });

  it("restores patched getters when subscribing to the new selector fails", () => {
    const f = fixture();
    const getSnapshot = f.instance.getSnapshot;
    f.store.sub = () => {
      throw new Error("Disposed store");
    };
    expect(repairSidebarThreadState(f.owner)).toBeNull();
    expect(f.instance.getSnapshot).toBe(getSnapshot);
    expect(f.subscriber.getSnapshot()).toBeNull();
  });
});
