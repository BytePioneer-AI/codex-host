import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRendererCodexUsageGate,
  inspectComposerCodexUsageGate,
} from "../src/renderer-codex-usage-gate.js";

type Atom = { read(get: (atom: Atom) => unknown): unknown };

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing fixture subscription");
  return value;
}

/** Desktop-shaped selectors: an Account rate-limit gate and a reserve gate. */
function desktopStore() {
  let authMethod = "chatgpt";
  let allowed = false;
  let hardBlocked = false;
  const auth: Atom = { read: () => ({ authMethod, authenticatedAccountId: "account" }) };
  const usage: Atom = { read: () => ({ data: { rate_limit: { allowed } } }) };
  const reserve: Atom = { read: () => ({ active: false, eligible: true, hardBlocked }) };
  const accountGate: Atom = {
    read: (get) => {
      const a = get(auth) as { authMethod: string };
      // Like Desktop: API-key sign-in returns before reading ChatGPT usage.
      if (a.authMethod !== "chatgpt") return false;
      return (
        (get(usage) as { data: { rate_limit: { allowed: boolean } } }).data.rate_limit.allowed ===
        false
      );
    },
  };
  const reserveGate: Atom = {
    read: (get) => (get(reserve) as { hardBlocked: boolean }).hardBlocked,
  };
  const reserveActive: Atom = { read: (get) => (get(reserve) as { active: boolean }).active };
  const listeners = new Map<Atom, Set<() => void>>();
  const emit = () => {
    // Model Jotai's propagation to derived signal atoms; React's listener
    // compares snapshots, so unchanged selectors do not rerender.
    for (const set of listeners.values()) {
      for (const listener of set) listener();
    }
  };
  const store = {
    get(atom: Atom): unknown {
      return atom.read(store.get);
    },
    sub: vi.fn((atom: Atom, listener: () => void) => {
      const set = listeners.get(atom) ?? new Set();
      set.add(listener);
      listeners.set(atom, set);
      return () => set.delete(listener);
    }),
    set: vi.fn(),
  };
  return {
    store,
    accountGate,
    reserveGate,
    reserveActive,
    setAuthMethod(value: string) {
      authMethod = value;
      emit();
    },
    setAllowed(value: boolean) {
      allowed = value;
      emit();
    },
    setHardBlocked(value: boolean) {
      hardBlocked = value;
      emit();
    },
    listenerCount: () => [...listeners.values()].reduce((n, set) => n + set.size, 0),
  };
}

/** A Composer owner whose hooks follow React's useSyncExternalStore layout. */
function composerFixture(
  source = desktopStore(),
  options: {
    omitReserve?: boolean;
    duplicateAccount?: boolean;
    snapshotWrapper?: boolean;
    signalReserve?: boolean;
  } = {},
) {
  const subscribers: Array<{ getSnapshot(): unknown }> = [];
  const instances: Array<{ value: unknown; getSnapshot(): unknown }> = [];
  const hooks: Array<Record<string, unknown>> = [];
  const rerender = vi.fn();
  for (const selector of [
    source.reserveActive,
    source.accountGate,
    ...(options.omitReserve ? [] : [source.reserveGate]),
    ...(options.duplicateAccount ? [source.accountGate] : []),
  ]) {
    // Desktop 26.928 wraps parameterized selectors in a readonly signal atom.
    const signal = options.signalReserve && selector !== source.accountGate;
    const atom: Atom = signal ? { read: (get) => get(selector) } : selector;
    const value = {
      atom,
      store: source.store,
      get: () => source.store.get(atom),
      subscribe: (listener: () => void) => source.store.sub(atom, listener),
    };
    const subscriber = {
      getSnapshot: value.get,
      subscribe: value.subscribe,
      createRender: () => undefined,
    };
    // The new hook passes a lazy wrapper, not subscriber.getSnapshot, to React.
    const getSnapshot = options.snapshotWrapper
      ? () => {
          const snapshot = subscriber.getSnapshot();
          subscriber.createRender();
          return snapshot;
        }
      : subscriber.getSnapshot;
    const instance = { value: getSnapshot(), getSnapshot };
    const effect = {
      deps: [subscriber.subscribe],
      create: () =>
        subscriber.subscribe(() => {
          const next = instance.getSnapshot();
          if (Object.is(next, instance.value)) return;
          instance.value = next;
          rerender();
        }),
    };
    hooks.push(
      { memoizedState: [subscriber, signal ? [value, undefined] : [source.store, atom]] },
      { queue: instance },
      { memoizedState: effect },
    );
    subscribers.push(subscriber);
    instances.push(instance);
    effect.create();
  }
  // Desktop owners have more than a thousand hooks; do not rely on positions.
  hooks.unshift(...Array.from({ length: 230 }, () => ({ memoizedState: null })));
  hooks.forEach((hook, i) => {
    hook.next = hooks[i + 1] ?? null;
  });
  const props = { onLocalSubmitStart() {}, submitDisabled: false };
  // Desktop wraps the owner in a pass-through component with the same props.
  const wrapper = {
    memoizedProps: props,
    memoizedState: { memoizedState: null, next: null },
    return: null,
  };
  const owner = {
    memoizedProps: props,
    memoizedState: hooks[0] as unknown,
    return: wrapper,
  };
  const editor = { parentElement: null, __reactFiber$test: owner };
  const composer = {
    isConnected: true,
    querySelector: () => editor,
  } as unknown as Element;
  return {
    source,
    owner,
    composer,
    gate: createRendererCodexUsageGate(composer),
    rerender,
    subscribers,
    instances,
    hooks,
    blocked: () => instances.slice(1).some((instance) => instance.getSnapshot() === true),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Codex usage gate for external Harness Composers", () => {
  it("lifts only this Composer's usage gates without touching the shared store", () => {
    const f = composerFixture();
    const { store } = f.source;
    const originalSub = store.sub;
    const listeners = f.source.listenerCount();
    expect(f.blocked()).toBe(true);

    expect(f.gate.update(true)).toBe("bypassed");
    expect(f.blocked()).toBe(false);
    expect(f.rerender).toHaveBeenCalled();
    expect(f.gate.refresh()).toBe("bypassed");
    expect(store.get(f.source.accountGate)).toBe(true);
    expect(store.set).not.toHaveBeenCalled();
    expect(store.sub).toBe(originalSub);
    expect(f.source.listenerCount()).toBe(listeners);

    expect(f.gate.update(false)).toBe("native");
    expect(f.blocked()).toBe(true);
  });

  it("binds 26.928 signal selectors and lazy snapshot wrappers", () => {
    const source = desktopStore();
    source.setHardBlocked(true);
    const external = composerFixture(source, { snapshotWrapper: true, signalReserve: true });
    const codex = composerFixture(source, { snapshotWrapper: true, signalReserve: true });
    const nativeSnapshots = external.instances.map((instance) => instance.getSnapshot);
    const listeners = source.listenerCount();
    const originalSub = source.store.sub;
    const calls = source.store.sub.mock.calls.length;

    expect(inspectComposerCodexUsageGate(external.composer)).toEqual({
      ownerCount: 1,
      reserveGateCount: 1,
      accountGateCount: 1,
    });
    expect(source.store.sub.mock.calls).toHaveLength(calls);
    expect(external.blocked()).toBe(true);
    expect(external.gate.update(true)).toBe("bypassed");
    expect(external.blocked()).toBe(false);
    expect(codex.blocked()).toBe(true);
    expect(source.store.get(source.accountGate)).toBe(true);
    expect(source.store.get(source.reserveGate)).toBe(true);
    expect(source.store.set).not.toHaveBeenCalled();
    expect(source.store.sub).toBe(originalSub);
    expect(source.listenerCount()).toBe(listeners);

    expect(external.gate.update(false)).toBe("native");
    expect(external.blocked()).toBe(true);
    expect(external.instances.map((instance) => instance.getSnapshot)).toEqual(nativeSnapshots);
  });

  it("keeps unrelated or mismatched snapshot wrappers native", () => {
    const f = composerFixture(undefined, { snapshotWrapper: true, signalReserve: true });
    const subscriber = required(f.subscribers[1]);
    // A boolean-returning getter alone does not establish the native atom relationship.
    subscriber.getSnapshot = () => false;
    required(f.instances[1]).getSnapshot = () => true;
    expect(f.gate.update(true)).toBe("unsupported");
    expect(f.blocked()).toBe(true);
  });

  it("does not project unrelated native blockers or combined usage selectors", () => {
    const source = desktopStore();
    source.reserveActive.read = () => true;
    const f = composerFixture(source, { snapshotWrapper: true, signalReserve: true });
    expect(f.gate.update(true)).toBe("bypassed");
    expect(required(f.instances[0]).getSnapshot()).toBe(true);
    expect(required(f.instances[1]).getSnapshot()).toBe(false);
    expect(required(f.instances[2]).getSnapshot()).toBe(false);
    f.gate.dispose();

    for (const key of ["accountGate", "reserveGate"] as const) {
      const combined = desktopStore();
      const reserveRead = combined.reserveGate.read;
      const accountRead = combined.accountGate.read;
      combined[key].read = (get) => {
        const reserve = reserveRead(get);
        const account = accountRead(get);
        return Boolean(reserve || account);
      };
      const unsupported = composerFixture(combined, {
        snapshotWrapper: true,
        signalReserve: true,
      });
      expect(unsupported.gate.update(true)).toBe("unsupported");
      expect(unsupported.blocked()).toBe(true);
    }
  });

  it("rejects tracked renders and rolls back a partially projected pair", () => {
    const tracked = composerFixture(undefined, { snapshotWrapper: true, signalReserve: true });
    Object.assign(required(tracked.subscribers[1]), {
      createRender: () => ({ getSnapshot: () => true }),
    });
    expect(tracked.gate.update(true)).toBe("unsupported");
    expect(tracked.blocked()).toBe(true);

    const readonly = composerFixture(undefined, { snapshotWrapper: true, signalReserve: true });
    Object.defineProperty(required(readonly.instances[2]), "getSnapshot", { writable: false });
    const instance = required(readonly.instances[1]);
    const original = instance.getSnapshot;
    expect(readonly.gate.update(true)).toBe("unsupported");
    expect(instance.getSnapshot).toBe(original);
    expect(readonly.blocked()).toBe(true);
  });

  it("rejects cyclic or excessive readonly selector indirections", () => {
    for (const cyclic of [true, false]) {
      const f = composerFixture(undefined, { snapshotWrapper: true, signalReserve: true });
      const reserveMemo = required(
        f.hooks.find(
          (hook) => Array.isArray(hook.memoizedState) && hook.memoizedState[0] === f.subscribers[2],
        ),
      ).memoizedState as [{ getSnapshot(): unknown }, [{ atom: Atom }, undefined]];
      const atoms: Atom[] = [];
      for (let i = 0; i < (cyclic ? 2 : 140); i += 1) {
        atoms.push({ read: (get) => get(required(atoms[(i + 1) % atoms.length])) });
      }
      reserveMemo[1][0].atom = required(atoms[0]);
      const nativeGet = f.source.store.get;
      vi.spyOn(f.source.store, "get").mockImplementation((atom) =>
        atoms.includes(atom) ? false : nativeGet(atom),
      );
      expect(f.gate.update(true)).toBe("unsupported");
      expect(f.blocked()).toBe(true);
      expect(f.source.store.set).not.toHaveBeenCalled();
    }
  });

  it("adds the Account gate after sign-in without losing a wrapped reserve projection", () => {
    vi.useFakeTimers();
    const f = composerFixture(undefined, { snapshotWrapper: true, signalReserve: true });
    f.source.setAuthMethod("api-key");
    f.source.setHardBlocked(true);
    expect(f.gate.update(true)).toBe("bypassed");
    // React supplies another wrapper while only the reserve subscription is bound.
    required(f.instances[2]).getSnapshot = () => required(f.subscribers[2]).getSnapshot();
    f.source.setAuthMethod("chatgpt");
    expect(f.blocked()).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(f.gate.refresh()).toBe("bypassed");
    expect(f.blocked()).toBe(false);
    f.gate.update(false);
    expect(f.blocked()).toBe(true);
    f.source.setAllowed(true);
    f.source.setHardBlocked(false);
    expect(f.blocked()).toBe(false);
  });

  it("restores the original wrapper after React refreshes the instance getter", () => {
    const f = composerFixture(undefined, { snapshotWrapper: true, signalReserve: true });
    const instance = required(f.instances[1]);
    const native = instance.getSnapshot;
    expect(f.gate.update(true)).toBe("bypassed");
    // A subsequent React render replaces the per-instance getter with a new wrapper.
    const replacement = () => required(f.subscribers[1]).getSnapshot();
    instance.getSnapshot = replacement;
    expect(f.gate.refresh()).toBe("bypassed");
    expect(f.blocked()).toBe(false);
    f.gate.dispose();
    expect(instance.getSnapshot).toBe(replacement);
    expect(f.blocked()).toBe(true);
    expect(native()).toBe(true);
  });

  it("does not affect another Composer sharing the same store", () => {
    const source = desktopStore();
    const external = composerFixture(source);
    const codex = composerFixture(source);
    expect(external.gate.update(true)).toBe("bypassed");
    expect(codex.gate.update(false)).toBe("native");
    expect(external.blocked()).toBe(false);
    expect(codex.blocked()).toBe(true);
    external.gate.dispose();
    expect(external.blocked()).toBe(true);
  });

  it("restores live native values after usage changed while lifted", () => {
    const f = composerFixture();
    f.gate.update(true);
    f.source.setAllowed(true);
    f.source.setHardBlocked(true);
    expect(f.blocked()).toBe(false);
    f.gate.update(false);
    expect(f.blocked()).toBe(true);
    f.source.setHardBlocked(false);
    expect(f.blocked()).toBe(false);
  });

  it("binds the account gate once it reads usage after API-key sign-in", () => {
    vi.useFakeTimers();
    const f = composerFixture();
    f.source.setAuthMethod("api-key");
    expect(f.gate.update(true)).toBe("bypassed");
    f.source.setAuthMethod("chatgpt");
    expect(f.blocked()).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(f.gate.refresh()).toBe("bypassed");
    expect(f.blocked()).toBe(false);
  });

  it("rebinds immediately after Desktop replaces the Composer hooks", () => {
    const f = composerFixture();
    f.gate.update(true);
    const replacement = composerFixture(f.source);
    f.owner.memoizedState = replacement.owner.memoizedState;
    expect(f.gate.refresh()).toBe("bypassed");
    expect(f.blocked()).toBe(true);
    expect(replacement.blocked()).toBe(false);
    f.gate.dispose();
    expect(replacement.blocked()).toBe(true);
  });

  it("keeps native restrictions when the contract is missing, ambiguous or read-only", () => {
    for (const options of [
      { omitReserve: true },
      { duplicateAccount: true },
      { omitReserve: true, snapshotWrapper: true, signalReserve: true },
      { duplicateAccount: true, snapshotWrapper: true, signalReserve: true },
    ]) {
      const f = composerFixture(undefined, options);
      expect(f.gate.update(true)).toBe("unsupported");
      expect(f.blocked()).toBe(true);
    }
    const f = composerFixture();
    Object.defineProperty(f.source.store, "sub", { writable: false });
    expect(f.gate.update(true)).toBe("unsupported");
    expect(f.blocked()).toBe(true);
  });

  it("counts owner and gates for the contract audit without lifting them", () => {
    const f = composerFixture();
    const sub = f.source.store.sub;
    expect(inspectComposerCodexUsageGate(f.composer)).toEqual({
      ownerCount: 1,
      reserveGateCount: 1,
      accountGateCount: 1,
    });
    expect(f.blocked()).toBe(true);
    expect(f.source.store.sub).toBe(sub);
    expect(f.rerender).not.toHaveBeenCalled();

    f.source.setAuthMethod("api-key");
    expect(inspectComposerCodexUsageGate(f.composer).accountGateCount).toBe(0);
    const duplicate = composerFixture(undefined, { duplicateAccount: true });
    expect(inspectComposerCodexUsageGate(duplicate.composer).accountGateCount).toBe(2);
  });

  it("releases the gates when the Composer disconnects", () => {
    const f = composerFixture();
    f.gate.update(true);
    Object.defineProperty(f.composer, "isConnected", { value: false });
    expect(f.gate.refresh()).toBe("native");
    expect(f.blocked()).toBe(true);
  });
});
