import { describe, expect, it, vi } from "vitest";
import {
  bindDictationSettingsMode,
  replayDictationSettingsMode,
} from "../src/renderer-dictation-settings.js";
type Atom = { read(get: (atom: Atom) => unknown): unknown; write?: unknown };
function fixture(platform = "darwin") {
  let permitted = true;
  let loading = false;
  const gate: Atom = { read: () => true, write: true };
  const capability: Atom = {
    read: (get) => ({ isLoading: loading, isError: false, isCapable: permitted && !get(gate) }),
  };
  const mode: Atom = {
    read: (get) =>
      ["darwin", "win32", "linux"].includes(platform) &&
      (get(capability) as { isCapable: boolean }).isCapable
        ? platform === "linux"
          ? "app"
          : "os-global"
        : null,
  };
  const store = {
    get: (atom: Atom): unknown => atom.read(store.get),
    sub: vi.fn((atom: Atom, listener: () => void) => {
      void atom;
      void listener;
      return () => {};
    }),
  };
  function reader() {
    const original = () => store.get(mode);
    const subscriber = {
      getSnapshot: original,
      subscribe: (notify: () => void) => store.sub(mode, notify),
      createRender: () => undefined,
    };
    const instance = { getSnapshot: original };
    const notify = vi.fn(() => {
      hook.next.memoizedState = subscriber.getSnapshot();
    });
    const hook = {
      memoizedState: [subscriber, [store, mode]],
      next: {
        memoizedState: original(),
        queue: instance,
        next: {
          memoizedState: {
            create: () => subscriber.subscribe(notify),
            deps: [subscriber.subscribe],
          },
          next: null,
        },
      },
    };
    return { original, subscriber, instance, hook, notify };
  }
  const page = reader();
  const fibers = new Set<Record<string, unknown>>([{ memoizedState: page.hook }]);
  return {
    gate,
    capability,
    mode,
    store,
    page,
    fibers,
    reader,
    bind: () =>
      bindDictationSettingsMode(
        () => fibers,
        store,
        mode,
        [capability],
        gate,
        () => true,
      ),
    deny: () => {
      permitted = false;
    },
    load: () => {
      loading = true;
    },
  };
}
describe("native Settings dictation mode", () => {
  it.each([
    ["darwin", "os-global"],
    ["win32", "os-global"],
    ["linux", "app"],
    ["unknown", undefined],
  ])("retains native platform choice for %s", (platform, expected) => {
    const f = fixture(platform as string);
    expect(replayDictationSettingsMode(f.store, f.mode, [f.capability], f.gate)).toBe(expected);
    expect(f.store.get(f.mode)).toBeNull();
    expect(f.store.get(f.capability)).toMatchObject({ isCapable: false });
  });
  it.each(["deny", "load"] as const)(
    "does not invent dictation eligibility during %s",
    (change) => {
      const f = fixture();
      f[change]();
      expect(replayDictationSettingsMode(f.store, f.mode, [f.capability], f.gate)).toBeNull();
    },
  );
  it("binds only the exact mode selector, detects newly mounted shortcut readers, and restores", () => {
    const f = fixture();
    const b = f.bind();
    expect(f.page.subscriber.getSnapshot()).toBe("os-global");
    expect(b.current()).toBe(true);
    const shortcut = f.reader();
    f.fibers.add({ memoizedState: shortcut.hook });
    expect(b.current()).toBe(false);
    b.dispose();
    expect(f.page.subscriber.getSnapshot).toBe(f.page.original);
    const rebound = f.bind();
    expect(shortcut.subscriber.getSnapshot()).toBe("os-global");
    expect(rebound.current()).toBe(true);
    f.deny();
    expect(shortcut.subscriber.getSnapshot()).toBeNull();
    expect(rebound.current()).toBe(false);
    rebound.dispose();
    expect(shortcut.subscriber.getSnapshot).toBe(shortcut.original);
    expect(f.store.sub).not.toHaveBeenCalled();
  });
  it("rejects writable or unrelated mode selectors", () => {
    const f = fixture();
    expect(
      replayDictationSettingsMode(f.store, { read: () => "os-global" }, [f.capability], f.gate),
    ).toBeUndefined();
    f.mode.write = true;
    expect(() => f.bind()).toThrow();
    expect(f.page.subscriber.getSnapshot).toBe(f.page.original);
  });
});
