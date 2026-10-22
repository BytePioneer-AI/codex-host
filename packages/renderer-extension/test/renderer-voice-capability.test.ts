import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bindComposerVoiceCapability,
  bindVoiceCapabilitySubscriptions,
  installVoiceCapabilityProjection,
  replayVoiceCapability,
} from "../src/renderer-voice-capability.js";
import {
  applyVoiceGatewayReadiness,
  applySharedVoiceRoutes,
} from "../src/renderer-cpa-live-voice-preference.js";
import {
  CLIENT_OWNED_VOICE_INITIAL_ASSET,
  CLIENT_OWNED_VOICE_SHARED_ASSET,
} from "../src/renderer-client-owned-voice.js";

type Atom = { read(get: (atom: Atom) => unknown): unknown; write?: unknown };
function fixture(name = "voice.realtime", hostId?: string) {
  const gate: Atom = { read: () => true, write: true };
  let permitted = true;
  let loading = false;
  let error = false;
  const atom: Atom = {
    read: (get) => ({
      isLoading: loading,
      isError: error,
      isCapable: permitted && get(gate) === false,
    }),
  };
  const store = {
    get: (atom: Atom): unknown => atom.read(store.get),
    sub: vi.fn((atom: Atom, listener: () => void) => {
      void atom;
      void listener;
      return () => {};
    }),
  };
  const signal = { atom, store };
  const original = () => store.get(atom);
  const subscriber = {
    getSnapshot: original,
    subscribe: (listener: () => void) => store.sub(atom, listener),
    createRender: () => undefined,
  };
  const instance = { getSnapshot: original };
  const notify = vi.fn();
  const subscription = {
    memoizedState: [subscriber, [signal, undefined]],
    next: {
      queue: instance,
      next: {
        memoizedState: { create: () => subscriber.subscribe(notify), deps: [subscriber.subscribe] },
        next: null,
      },
    },
  };
  const family = { scope: { id: Symbol() }, resolve: () => ({ atom: gate }) };
  const key = JSON.stringify({ name, ...(hostId === undefined ? {} : { hostId }) });
  const node = {
    store,
    familyBindings: new Map([[family, new Map([[key, { cacheKey: "owned" }]])]]),
  };
  const chain = new Map([[family.scope.id, node]]);
  const owner = {
    memoizedState: {
      memoizedState: [signal, ["owned", chain, undefined, family, undefined]],
      next: subscription,
    },
    return: null,
  };
  const composer = {
    __reactFiber$fixture: owner,
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ width: 100 }),
    closest: () => null,
  } as unknown as Element;
  return {
    atom,
    gate,
    store,
    family,
    subscriber,
    instance,
    notify,
    original,
    owner,
    composer,
    block: () => {
      permitted = false;
    },
    load: () => {
      loading = true;
    },
    fail: () => {
      error = true;
    },
  };
}
afterEach(() => vi.useRealTimers());

describe("voice capability evaluation", () => {
  it("omits only the inference constraint while leaving native gates and other eligibility unchanged", () => {
    const f = fixture();
    expect(replayVoiceCapability(f.store, f.atom, f.gate)).toEqual({
      isLoading: false,
      isError: false,
      isCapable: true,
    });
    expect(f.store.get(f.gate)).toBe(true);
    expect(f.store.get(f.atom)).toMatchObject({ isCapable: false });
    expect(JSON.stringify(f.store)).not.toMatch(/model_provider/u);
    f.block();
    expect(replayVoiceCapability(f.store, f.atom, f.gate)).toBeNull();
  });
  it.each(["load", "fail"] as const)("fails closed on native %s", (flag) => {
    const f = fixture();
    f[flag]();
    expect(replayVoiceCapability(f.store, f.atom, f.gate)).toBeNull();
  });
  it("rejects a changed replay and an unrelated gate", () => {
    const f = fixture();
    expect(replayVoiceCapability(f.store, f.atom, { read: () => false })).toBeNull();
    let calls = 0;
    const atom = {
      read: () => ({ isLoading: false, isError: false, isCapable: ++calls % 2 === 0 }),
    };
    expect(replayVoiceCapability(f.store, atom, f.gate)).toBeNull();
  });
  it("bounds recursive dependencies", () => {
    const f = fixture();
    const atom: Atom = { read: (get) => get({ read: atom.read }) };
    expect(
      replayVoiceCapability(
        { ...f.store, get: () => ({ isLoading: false, isError: false, isCapable: false }) },
        atom,
        f.gate,
      ),
    ).toBeNull();
  });
});

describe("owned composer subscription", () => {
  it("requires one committed realtime reader for the native overlay starter", () => {
    const f = fixture();
    const binding = bindVoiceCapabilitySubscriptions(
      () => new Set([f.owner]),
      f.family,
      f.family,
      () => true,
      true,
    );
    expect(binding.current()).toBe(false);
    Object.assign(f.owner.memoizedState.next.next, { memoizedState: f.instance.getSnapshot() });
    expect(binding.current()).toBe(true);
    binding.dispose();
    expect(() =>
      bindVoiceCapabilitySubscriptions(
        () => new Set([f.owner, { ...f.owner }]),
        f.family,
        f.family,
        () => true,
        true,
      ),
    ).toThrow();
    expect(f.instance.getSnapshot).toBe(f.original);
  });
  it.each([
    ["voice.realtime", undefined],
    ["voice.thread", "local"],
  ])("projects %s and restores on preference change and disposal", (name, host) => {
    const f = fixture(name, host);
    let allowed = true;
    const binding = bindComposerVoiceCapability(f.composer, f.family, f.family, () => allowed);
    expect(f.instance.getSnapshot()).toMatchObject({ isCapable: true });
    expect(f.instance.getSnapshot()).toBe(f.subscriber.getSnapshot());
    expect(f.notify).toHaveBeenCalledOnce();
    expect(f.store.sub).not.toHaveBeenCalled();
    expect(binding.current()).toBe(true);
    allowed = false;
    expect(f.instance.getSnapshot()).toMatchObject({ isCapable: false });
    binding.dispose();
    expect(f.subscriber.getSnapshot).toBe(f.original);
    expect(f.instance.getSnapshot).toBe(f.original);
    expect(f.notify).toHaveBeenCalledTimes(2);
  });
  it.each([
    ["chatgpt.image-generation", undefined],
    ["voice", undefined],
    ["voice.thread", "remote"],
    ["voice.thread", undefined],
  ])("rejects %s for host %s", (name, host) => {
    const f = fixture(name, host);
    expect(() => bindComposerVoiceCapability(f.composer, f.family, f.family, () => true)).toThrow();
    expect(f.subscriber.getSnapshot).toBe(f.original);
  });
  it("detects replacement of a committed subscription", () => {
    const f = fixture();
    const binding = bindComposerVoiceCapability(f.composer, f.family, f.family, () => true);
    f.owner.memoizedState.next = null as unknown as typeof f.owner.memoizedState.next;
    expect(binding.current()).toBe(false);
    binding.dispose();
  });

  it("does not project a capability on an ancestor outside the Composer", () => {
    const f = fixture();
    Object.assign(f.composer, { __reactFiber$fixture: { return: f.owner, memoizedState: null } });
    expect(() => bindComposerVoiceCapability(f.composer, f.family, f.family, () => true)).toThrow();
    expect(f.subscriber.getSnapshot).toBe(f.original);
  });
});

describe("version and runtime qualification", () => {
  function target() {
    const f = fixture();
    const values = new Map([["home-composer-mode-v1", "work"]]);
    const target = {
      __codexhostCpaLiveVoiceHookV1: {
        enabled: true,
        desktopVersion: "26.1016.61520",
        auditedDesktopVersion: "26.1007.30912",
        auditedAppInitialAsset: "app-initial-6350d04672d0.js",
      },
      __codexhostClientOwnedVoiceV1: { status: "active" },
      __codexhostExternalVoiceLaunchV1: { status: "active" },
      document: {
        querySelectorAll: (selector: string) =>
          selector === "[data-codex-composer-root]" ? [f.composer] : [],
      } as unknown as Document,
      performance: {
        getEntriesByType: () =>
          [CLIENT_OWNED_VOICE_INITIAL_ASSET, CLIENT_OWNED_VOICE_SHARED_ASSET].map((x) => ({
            name: `app://-/assets/${x}`,
          })) as PerformanceEntry[],
      },
      localStorage: { getItem: (key: string) => values.get(key) ?? null },
      setTimeout,
      clearTimeout,
    };
    const route = { hostId: "local", policy: { selectedModel: () => "codex-model" } };
    Object.assign(target, {
      __codexhostHostRoutingV1: { forComposer: () => route, forHost: () => route },
    });
    applyVoiceGatewayReadiness(target, true);
    return {
      f,
      target,
      values,
      importModule: vi.fn(async () => ({ njr: () => {}, tjr: f.family, uBr: f.family })),
    };
  }
  it("requires injection, gateway readiness, Work ownership and both active hooks", async () => {
    vi.useFakeTimers();
    const f = target();
    applyVoiceGatewayReadiness(f.target, false);
    const hook = installVoiceCapabilityProjection(f);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.importModule).not.toHaveBeenCalled();
    applyVoiceGatewayReadiness(f.target, true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(hook.status).toBe("active");
    expect(f.f.instance.getSnapshot()).toMatchObject({ isCapable: true });
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.f.notify).toHaveBeenCalledOnce();
    f.values.set("home-composer-mode-v1", "chat");
    expect(f.f.instance.getSnapshot()).toMatchObject({ isCapable: false });
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.f.instance.getSnapshot).toBe(f.f.original);
    hook.dispose();
  });
  it("projects official Codex Work when the Work tab is selected and composer-mode storage is empty", async () => {
    vi.useFakeTimers();
    const f = target();
    f.values.delete("home-composer-mode-v1");
    const work = {
      textContent: "Work",
      getAttribute: (name: string) => (name === "aria-selected" ? "true" : ""),
    };
    const chat = {
      textContent: "Chat",
      getAttribute: (name: string) => (name === "aria-selected" ? "false" : ""),
    };
    const document = f.target.document as unknown as {
      querySelectorAll: (selector: string) => unknown;
    };
    const composers = document.querySelectorAll;
    document.querySelectorAll = (selector: string) => {
      if (selector === "[data-codex-composer-root]") return composers.call(document, selector);
      if (selector === "[data-chatgpt-composer]") return [];
      return [chat, work];
    };
    const hook = installVoiceCapabilityProjection(f);
    await vi.advanceTimersByTimeAsync(1);
    expect(hook.status).toBe("active");
    expect(f.f.instance.getSnapshot()).toMatchObject({ isCapable: true });
    hook.dispose();
  });

  it("keeps Work Desktop default native, but permits an explicitly owned local external Harness", async () => {
    vi.useFakeTimers();
    const f = target();
    applySharedVoiceRoutes(f.target, {
      chatExperience: "chatgpt",
      chatConnection: "desktop",
      workConnection: "desktop",
    });
    const hook = installVoiceCapabilityProjection(f);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.importModule).not.toHaveBeenCalled();
    const route = { hostId: "local", policy: { selectedModel: () => "codexhost/grok/model" } };
    Object.assign(f.target, {
      __codexhostHostRoutingV1: { forComposer: () => route, forHost: () => route },
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(hook.status).toBe("active");
    hook.dispose();
  });
  it("binds the visible Work composer when Desktop retains a hidden composer root", async () => {
    vi.useFakeTimers();
    const f = target();
    const hidden = { ...f.f.composer, getBoundingClientRect: () => ({ width: 0 }) };
    f.target.document.querySelectorAll = ((selector: string) =>
      selector === "[data-codex-composer-root]"
        ? [hidden, f.f.composer]
        : []) as unknown as Document["querySelectorAll"];
    const hook = installVoiceCapabilityProjection(f);
    await vi.advanceTimersByTimeAsync(1);
    expect(hook.status).toBe("active");
    expect(f.f.instance.getSnapshot()).toMatchObject({ isCapable: true });
    hook.dispose();
  });
  it("leaves native capability unchanged when two visible composers are ambiguous", async () => {
    vi.useFakeTimers();
    const f = target();
    f.target.document.querySelectorAll = ((selector: string) =>
      selector === "[data-codex-composer-root]"
        ? [f.f.composer, fixture().composer]
        : []) as unknown as Document["querySelectorAll"];
    const hook = installVoiceCapabilityProjection(f);
    await vi.advanceTimersByTimeAsync(1);
    expect(hook.status).toBe("unsupported");
    expect(f.f.instance.getSnapshot).toBe(f.f.original);
    hook.dispose();
  });
  it.each(["fetch", "launch", "injection", "gateway"])(
    "restores native capability immediately when %s becomes unavailable",
    async (kind) => {
      vi.useFakeTimers();
      const f = target();
      const hook = installVoiceCapabilityProjection(f);
      await vi.advanceTimersByTimeAsync(1);
      expect(f.f.instance.getSnapshot()).toMatchObject({ isCapable: true });
      if (kind === "fetch") f.target.__codexhostClientOwnedVoiceV1.status = "unsupported";
      if (kind === "launch") f.target.__codexhostExternalVoiceLaunchV1.status = "unsupported";
      if (kind === "injection") f.target.__codexhostCpaLiveVoiceHookV1.enabled = false;
      if (kind === "gateway") applyVoiceGatewayReadiness(f.target, false);
      expect(f.f.instance.getSnapshot()).toMatchObject({ isCapable: false });
      await vi.advanceTimersByTimeAsync(1000);
      expect(f.f.instance.getSnapshot).toBe(f.f.original);
      hook.dispose();
    },
  );

  it("fails closed on unaudited version or assets", async () => {
    vi.useFakeTimers();
    const f = target();
    f.target.__codexhostCpaLiveVoiceHookV1.desktopVersion = "unknown";
    expect(installVoiceCapabilityProjection(f).status).toBe("unsupported");
    f.target.__codexhostCpaLiveVoiceHookV1.desktopVersion = "26.1016.61520";
    f.target.performance.getEntriesByType = () => [];
    const hook = installVoiceCapabilityProjection(f);
    await vi.advanceTimersByTimeAsync(1);
    expect(hook.status).toBe("unsupported");
    expect(f.importModule).not.toHaveBeenCalled();
    hook.dispose();
  });
});
