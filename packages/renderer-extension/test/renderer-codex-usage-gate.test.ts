import { describe, expect, it, vi } from "vitest";
import {
  createRendererCodexUsageGate,
  inspectComposerCodexUsageGate,
} from "../src/renderer-codex-usage-gate.js";

type Atom = { read(get: (atom: Atom) => unknown): unknown };

function fixtureStore() {
  let allowed = false;
  let reserveBlocked = false;
  const auth: Atom = {
    read: () => ({
      authMethod: "chatgpt",
      authenticatedAccountId: "account",
      userId: "user",
      plan: "plus",
    }),
  };
  const usage: Atom = { read: () => ({ data: { plan_type: "plus", rate_limit: { allowed } } }) };
  const reserve: Atom = {
    read: () => ({ active: false, eligible: true, hardBlocked: reserveBlocked }),
  };
  const accountGate: Atom = {
    read: (get) => {
      const a = get(auth) as ReturnType<typeof auth.read> & {
        authMethod: string;
        authenticatedAccountId: string;
        plan: string;
      };
      const u = get(usage) as { data: { plan_type: string; rate_limit: { allowed: boolean } } };
      return (
        a.authMethod === "chatgpt" &&
        a.authenticatedAccountId != null &&
        u.data.plan_type === a.plan &&
        u.data.rate_limit.allowed === false
      );
    },
  };
  const reserveGate: Atom = {
    read: (get) => (get(reserve) as { hardBlocked: boolean }).hardBlocked,
  };
  const reserveActive: Atom = { read: (get) => (get(reserve) as { active: boolean }).active };
  const listeners = new Map<Atom, Set<() => void>>();
  const store = {
    get(atom: Atom): unknown {
      return atom.read(store.get);
    },
    sub: vi.fn((atom: Atom, listener: () => void) => {
      const set = listeners.get(atom) ?? new Set();
      set.add(listener);
      listeners.set(atom, set);
      return () => {
        set.delete(listener);
      };
    }),
    set: vi.fn(),
  };
  return {
    store,
    accountGate,
    reserveGate,
    reserveActive,
    setAllowed(value: boolean) {
      allowed = value;
      for (const listener of listeners.get(accountGate) ?? []) listener();
    },
    setReserveBlocked(value: boolean) {
      reserveBlocked = value;
      for (const listener of listeners.get(reserveGate) ?? []) listener();
    },
    listenerCount: () => [...listeners.values()].reduce((n, set) => n + set.size, 0),
  };
}

function composerFixture(
  source = fixtureStore(),
  options: { omitReserve?: boolean; duplicateAccount?: boolean } = {},
) {
  const stores: Array<{ getSnapshot(): unknown; subscribe(listener: () => void): () => void }> = [];
  const instances: Array<{ value: unknown; getSnapshot(): unknown }> = [];
  const hooks: Array<Record<string, unknown>> = [];
  const notify = vi.fn();
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
          notify();
          instance.value = instance.getSnapshot();
        }),
    };
    // Like React: memoized subscriber, useSyncExternalStore instance, subscription effect.
    hooks.push(
      { memoizedState: [subscriber, [source.store, atom]] },
      { queue: instance },
      { memoizedState: effect },
    );
    stores.push(subscriber);
    instances.push(instance);
    effect.create();
  }
  // Actual Desktop owners can exceed 1,200 hooks. Do not rely on an index/name.
  hooks.unshift(...Array.from({ length: 230 }, () => ({ memoizedState: null })));
  hooks.forEach((hook, i) => {
    hook.next = hooks[i + 1] ?? null;
  });
  const owner = {
    type: function ArbitraryMinifiedName() {},
    memoizedProps: { composerController: {}, onLocalSubmitStart() {}, submitDisabled: false },
    memoizedState: hooks[0],
    return: null,
  };
  const editor = { parentElement: null, __reactFiber$test: owner };
  const composer = {
    isConnected: true,
    matches: () => false,
    querySelector: () => editor,
  } as unknown as Element;
  let externalReady = true;
  const gate = createRendererCodexUsageGate(composer, () => externalReady);
  return {
    source,
    owner,
    composer,
    gate,
    stores,
    instances,
    notify,
    selectExternal(value: boolean) {
      externalReady = value;
    },
    disabled: (otherBlock = false) =>
      otherBlock || stores.slice(1).some((store) => store.getSnapshot() === true),
  };
}

describe("per-Composer Codex usage gate", () => {
  it("removes only quota gates for external Harnesses, preserving the shared Account and other blockers", () => {
    const f = composerFixture();
    const { store } = f.source;
    const originalSub = store.sub;
    const count = f.source.listenerCount();
    expect(f.disabled()).toBe(true);
    expect(inspectComposerCodexUsageGate(f.composer)).toEqual({
      candidateCount: 1,
      verifiedCount: 1,
    });
    expect(f.gate.refresh()).toBe("ready");
    expect(f.disabled()).toBe(false);
    expect(inspectComposerCodexUsageGate(f.composer).verifiedCount).toBe(1);
    expect(f.gate.refresh()).toBe("ready");
    expect(f.disabled(true)).toBe(true);
    expect(store.get(f.source.accountGate)).toBe(true);
    expect(store.set).not.toHaveBeenCalled();
    expect(store.sub).toBe(originalSub);
    expect(f.source.listenerCount()).toBe(count);
    expect(f.instances[1]?.getSnapshot()).toBe(false);
    expect(f.notify).toHaveBeenCalled();
    f.gate.dispose();
    expect(f.disabled()).toBe(true);
    expect(f.instances[1]?.getSnapshot()).toBe(true);
  });

  it("does not affect another Composer sharing the same store, regardless of focus", () => {
    const source = fixtureStore();
    const external = composerFixture(source);
    const codex = composerFixture(source);
    codex.selectExternal(false);
    expect(external.gate.refresh()).toBe("ready");
    expect(codex.gate.refresh()).toBe("inactive");
    expect(external.disabled()).toBe(false);
    expect(codex.disabled()).toBe(true);
    external.selectExternal(false);
    // A native rerender before the next reconciliation already observes revocation.
    expect(external.disabled()).toBe(true);
    external.gate.refresh();
    expect(codex.disabled()).toBe(true);
  });

  it("keeps another external Composer active when one is disposed", () => {
    const source = fixtureStore();
    const first = composerFixture(source);
    const second = composerFixture(source);
    first.gate.refresh();
    second.gate.refresh();
    first.gate.dispose();
    expect(first.disabled()).toBe(true);
    expect(second.disabled()).toBe(false);
    expect(source.store.get(source.accountGate)).toBe(true);
    second.gate.dispose();
    expect(second.disabled()).toBe(true);
  });

  it("rebinds a replaced hook chain and restores the retired instance", () => {
    const f = composerFixture();
    f.gate.refresh();
    const replacement = composerFixture(f.source);
    f.owner.memoizedState = replacement.owner.memoizedState;
    expect(f.gate.refresh()).toBe("ready");
    expect(f.disabled()).toBe(true);
    expect(replacement.disabled()).toBe(false);
    f.gate.dispose();
    expect(replacement.disabled()).toBe(true);
  });

  it("notifies after an intervening native render revoked the projection", () => {
    const f = composerFixture();
    f.gate.refresh();
    f.selectExternal(false);
    f.source.setAllowed(false);
    expect(f.instances[1]?.value).toBe(true);
    f.selectExternal(true);
    f.gate.refresh();
    expect(f.instances[1]?.value).toBe(false);
  });

  it("restores current native values, not values saved before a quota update", () => {
    const f = composerFixture();
    f.gate.refresh();
    f.source.setAllowed(true);
    f.source.setReserveBlocked(true);
    expect(f.disabled()).toBe(false);
    f.selectExternal(false);
    f.gate.refresh();
    expect(f.stores[1]?.getSnapshot()).toBe(false);
    expect(f.stores[2]?.getSnapshot()).toBe(true);
  });

  it("fails closed on missing, ambiguous or non-writable contracts", () => {
    for (const options of [{ omitReserve: true }, { duplicateAccount: true }]) {
      const f = composerFixture(undefined, options);
      expect(f.gate.refresh()).toBe("unsupported");
      expect(f.disabled()).toBe(true);
    }
    const f = composerFixture();
    Object.defineProperty(f.stores[2], "getSnapshot", { writable: false });
    const original = f.source.store.sub;
    expect(f.gate.refresh()).toBe("unsupported");
    expect(f.disabled()).toBe(true);
    expect(f.source.store.sub).toBe(original);
  });

  it("releases projections when the owner disappears or the Composer disconnects", () => {
    const f = composerFixture();
    f.gate.refresh();
    Object.defineProperty(f.composer, "isConnected", { value: false });
    expect(f.disabled()).toBe(true);
    expect(f.gate.refresh()).toBe("inactive");
    f.gate.dispose();
    expect(f.disabled()).toBe(true);
  });
});
