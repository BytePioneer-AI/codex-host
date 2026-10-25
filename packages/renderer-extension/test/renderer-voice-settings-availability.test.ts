import { describe, expect, it, vi } from "vitest";
import {
  bindVoiceSettingsAvailability,
  voiceSettingsSurface,
} from "../src/renderer-voice-settings-availability.js";

type Atom = { read(get: (atom: Atom) => unknown): unknown; write?: unknown };
function fixture() {
  let access = true;
  let loading = false;
  let allowed = true;
  const gate: Atom = { read: () => true, write: true };
  const voice: Atom = {
    read: (get) => ({ isLoading: loading, isError: false, isCapable: access && !get(gate) }),
  };
  const boolean: Atom = { read: (get) => (get(voice) as { isCapable: boolean }).isCapable };
  const unrelated: Atom = { read: () => false };
  const store = {
    get: (atom: Atom): unknown => atom.read(store.get),
    sub: vi.fn((atom: Atom, notify: () => void) => {
      void atom;
      void notify;
      return () => {};
    }),
  };
  function subscription(atom: Atom) {
    const original = () => store.get(atom);
    const subscriber = {
      getSnapshot: original,
      subscribe: (notify: () => void) => store.sub(atom, notify),
      createRender: () => undefined,
    };
    const instance = { getSnapshot: () => subscriber.getSnapshot() };
    const notify = vi.fn(() => {
      hook.next.memoizedState = subscriber.getSnapshot();
    });
    const hook = {
      memoizedState: [subscriber, [store, atom]],
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
    return { subscriber, instance, hook, notify, original };
  }
  const owned = subscription(boolean);
  const other = subscription(unrelated);
  const owner = { memoizedState: owned.hook };
  let fibers = new Set<Record<string, unknown>>([owner, { memoizedState: other.hook }]);
  return {
    store,
    gate,
    voice,
    owned,
    other,
    owner,
    bind: () =>
      bindVoiceSettingsAvailability(
        () => fibers,
        store,
        voice,
        gate,
        () => allowed,
      ),
    deny: () => {
      access = false;
    },
    load: () => {
      loading = true;
    },
    disable: () => {
      allowed = false;
    },
    unmount: () => {
      fibers = new Set();
    },
    duplicate: () => {
      fibers.add({ memoizedState: subscription(boolean).hook });
    },
  };
}

describe("owned native Voice Settings availability", () => {
  it("restores only the boolean reader derived from realtime voice without writing native gates or capability", () => {
    const f = fixture();
    const binding = f.bind();
    expect(f.owned.subscriber.getSnapshot()).toBe(true);
    expect(f.other.subscriber.getSnapshot()).toBe(false);
    expect(f.store.get(f.voice)).toMatchObject({ isCapable: false });
    expect(f.store.get(f.gate)).toBe(true);
    expect(f.store.sub).not.toHaveBeenCalled();
    expect(binding.current()).toBe(true);
    binding.dispose();
    expect(f.owned.subscriber.getSnapshot).toBe(f.owned.original);
    expect(f.owned.instance.getSnapshot()).toBe(false);
    expect(f.owned.notify).toHaveBeenCalledTimes(2);
  });
  it.each(["deny", "load", "disable"] as const)("preserves native %s after binding", (change) => {
    const f = fixture();
    const binding = f.bind();
    f[change]();
    expect(f.owned.subscriber.getSnapshot()).toBe(false);
    expect(binding.current()).toBe(false);
    binding.dispose();
  });
  it("detects a lost owner and accepts an equivalent React instance wrapper", () => {
    const f = fixture();
    const binding = f.bind();
    f.owned.instance.getSnapshot = () => f.owned.subscriber.getSnapshot();
    expect(binding.current()).toBe(true);
    f.unmount();
    expect(binding.current()).toBe(false);
    binding.dispose();
  });
  it("rebinds while React still holds the previous projected commit after disposal", () => {
    const f = fixture();
    const binding = f.bind();
    binding.dispose();
    f.owned.hook.next.memoizedState = true;
    const rebound = f.bind();
    expect(rebound.current()).toBe(true);
    rebound.dispose();
  });

  it("rejects duplicate availability readers before mutating either", () => {
    const f = fixture();
    f.duplicate();
    expect(f.bind).toThrow(/ambiguous/i);
    expect(f.owned.subscriber.getSnapshot).toBe(f.owned.original);
    expect(f.owned.notify).not.toHaveBeenCalled();
  });
  it("rejects a writable boolean, an invalid replay and a malformed subscription", () => {
    for (const mutate of [
      (f: ReturnType<typeof fixture>) => {
        const deps = f.owned.hook.memoizedState[1] as unknown[];
        (deps[1] as Atom).write = true;
      },
      (f: ReturnType<typeof fixture>) => {
        f.owned.subscriber.getSnapshot = () => true;
      },
      (f: ReturnType<typeof fixture>) => {
        f.owned.hook.next.next.memoizedState.deps = [];
      },
    ]) {
      const f = fixture();
      mutate(f);
      expect(f.bind).toThrow();
      expect(f.owned.notify).not.toHaveBeenCalled();
    }
  });
});

describe("Voice Settings surface ownership", () => {
  it("uses only one exported page and its AppScope, excluding ancestors and other pages", () => {
    const appScope = { id: Symbol() };
    const node = {};
    const scope = {
      scope: appScope,
      node,
      chain: new Map([[appScope.id, node]]),
      get: () => undefined,
    };
    const page = () => {};
    const ancestor = { memoizedState: null, return: null };
    const owner = {
      type: page,
      memoizedState: { memoizedState: { current: scope }, next: null },
      return: ancestor,
    };
    const group = { memoizedState: null, return: owner };
    const section = { __reactFiber$fixture: { return: group } };
    const doc = { querySelectorAll: () => [section] } as unknown as Document;
    const surface = voiceSettingsSurface(doc, page, appScope);
    expect(surface?.scope).toBe(scope);
    expect(surface?.fibers.has(group)).toBe(true);
    expect(surface?.fibers.has(ancestor)).toBe(false);
    owner.type = () => {};
    expect(voiceSettingsSurface(doc, page, appScope)).toBeUndefined();
    owner.type = page;
    const second = { __reactFiber$fixture: { return: { ...owner } } };
    expect(
      voiceSettingsSurface(
        { querySelectorAll: () => [section, second] } as unknown as Document,
        page,
        appScope,
      ),
    ).toBeUndefined();
  });
});
