import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRendererCodexUsageGate,
  inspectComposerCodexUsageGate,
} from "../src/renderer-codex-usage-gate.js";

type Atom = { read(get: (atom: Atom) => unknown): unknown };

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
  const emit = (atom: Atom) => {
    for (const listener of listeners.get(atom) ?? []) listener();
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
      emit(accountGate);
    },
    setAllowed(value: boolean) {
      allowed = value;
      emit(accountGate);
    },
    setHardBlocked(value: boolean) {
      hardBlocked = value;
      emit(reserveGate);
    },
    listenerCount: () => [...listeners.values()].reduce((n, set) => n + set.size, 0),
  };
}

/** A Composer owner whose hooks follow React's useSyncExternalStore layout. */
function composerFixture(
  source = desktopStore(),
  options: { omitReserve?: boolean; duplicateAccount?: boolean } = {},
) {
  const subscribers: Array<{ getSnapshot(): unknown }> = [];
  const hooks: Array<Record<string, unknown>> = [];
  const rerender = vi.fn();
  for (const atom of [
    source.reserveActive,
    source.accountGate,
    ...(options.omitReserve ? [] : [source.reserveGate]),
    ...(options.duplicateAccount ? [source.accountGate] : []),
  ]) {
    const subscriber = {
      getSnapshot: () => source.store.get(atom),
      subscribe: (listener: () => void) => source.store.sub(atom, listener),
      createRender: () => undefined,
    };
    const instance = { value: subscriber.getSnapshot(), getSnapshot: subscriber.getSnapshot };
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
      { memoizedState: [subscriber, [source.store, atom]] },
      { queue: instance },
      { memoizedState: effect },
    );
    subscribers.push(subscriber);
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
    blocked: () => subscribers.slice(1).some((subscriber) => subscriber.getSnapshot() === true),
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
    for (const options of [{ omitReserve: true }, { duplicateAccount: true }]) {
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
