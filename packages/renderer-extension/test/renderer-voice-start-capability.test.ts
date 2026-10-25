import { describe, expect, it, vi } from "vitest";
import {
  gatewayVoiceStartRequest,
  wrapGatewayVoiceStarter,
} from "../src/renderer-voice-start-capability.js";

const request = {
  source: "composer_button_new_thread",
  productExperience: "work",
  hostId: "local",
};
function fixture() {
  let projected = false;
  let cancelled = false;
  const dispose = vi.fn(() => {
    projected = false;
  });
  const prepare = vi.fn(async (allowed: () => boolean) => {
    projected = allowed();
    return { dispose, current: () => true };
  });
  const start = vi.fn(async () => {
    if (!projected) throw new Error("voice_disabled");
    if (cancelled) throw new Error("cancelled");
    return "existingCall";
  });
  const options = {
    qualifies: () => true,
    ready: async () => true,
    prepare,
    committed: async () => {},
  };
  return {
    start,
    options,
    dispose,
    projected: () => projected,
    cancel: () => {
      cancelled = true;
    },
  };
}
describe("gateway start ownership", () => {
  it("qualifies an existing local Codex chat without changing its native product identity", () => {
    const codex = {
      source: "composer_button_existing_thread",
      productExperience: "codex",
      locator: { hostId: "local" },
    };
    expect(gatewayVoiceStartRequest(codex, true)).toBe(true);
    expect(gatewayVoiceStartRequest(codex, false, true)).toBe(false);
    expect(gatewayVoiceStartRequest({ ...codex, locator: { hostId: "remote" } }, true)).toBe(false);
    expect(gatewayVoiceStartRequest({ ...codex, source: "global_hotkey_new_thread" }, true)).toBe(
      false,
    );
    expect(codex.productExperience).toBe("codex");
  });
  it("qualifies explicit local Work requests and preserves Chat, remote and global starts", () => {
    expect(gatewayVoiceStartRequest(request, true)).toBe(true);
    for (const r of [
      { ...request, productExperience: "chat" },
      { ...request, hostId: "remote" },
      { ...request, source: "global_hotkey_new_thread" },
      { ...request, source: "composer_button_existing_thread", locator: { hostId: "remote" } },
    ])
      expect(gatewayVoiceStartRequest(r, true)).toBe(false);
    expect(gatewayVoiceStartRequest(request, false)).toBe(false);
    expect(
      gatewayVoiceStartRequest(
        { ...request, activeCollaborationMode: { settings: { model: "codexhost/owned" } } },
        false,
      ),
    ).toBe(true);
  });
  it("qualifies explicit local Codex Chat only when its gateway connection is selected", () => {
    const chat = { ...request, productExperience: "chat" };
    expect(gatewayVoiceStartRequest(chat, false, true)).toBe(true);
    expect(gatewayVoiceStartRequest(chat, true, false)).toBe(false);
    expect(gatewayVoiceStartRequest({ ...chat, hostId: "remote" }, true, true)).toBe(false);
    expect(
      gatewayVoiceStartRequest({ ...chat, source: "global_hotkey_new_thread" }, true, true),
    ).toBe(false);
    expect(
      gatewayVoiceStartRequest(
        { ...chat, source: "composer_button_existing_thread", locator: { hostId: "local" } },
        false,
        true,
      ),
    ).toBe(true);
  });
  it("qualifies the second reader before native start and restores it after existingCall startup", async () => {
    const f = fixture();
    await expect(f.start()).rejects.toThrow("voice_disabled");
    const wrapper = wrapGatewayVoiceStarter(f.start, f.options);
    await expect(wrapper.start(request, "context")).resolves.toBe("existingCall");
    expect(f.start).toHaveBeenLastCalledWith(request, "context");
    expect(f.projected()).toBe(false);
    expect(f.dispose).toHaveBeenCalledOnce();
  });
  it("passes unowned starts through without preparing or reading the gateway", async () => {
    const start = vi.fn().mockResolvedValue("native");
    const f = fixture();
    const ready = vi.fn();
    const wrapper = wrapGatewayVoiceStarter(start, { ...f.options, qualifies: () => false, ready });
    await expect(wrapper.start(request)).resolves.toBe("native");
    expect(f.options.prepare).not.toHaveBeenCalled();
    expect(ready).not.toHaveBeenCalled();
  });
  it("fails closed without ready transport and does not fall back to native account creation", async () => {
    const f = fixture();
    const wrapper = wrapGatewayVoiceStarter(f.start, { ...f.options, ready: async () => false });
    await expect(wrapper.start(request)).rejects.toThrow(/gateway/u);
    expect(f.start).not.toHaveBeenCalled();
    expect(f.options.prepare).not.toHaveBeenCalled();
  });
  it("releases the subscription when native workspace or entitlement checks reject", async () => {
    const f = fixture();
    f.start.mockRejectedValue(new Error("workspace_not_ready"));
    const wrapper = wrapGatewayVoiceStarter(f.start, f.options);
    await expect(wrapper.start(request)).rejects.toThrow("workspace_not_ready");
    expect(f.dispose).toHaveBeenCalledOnce();
  });
  it("cancels before invoking native start if cancellation occurs during qualification", async () => {
    const f = fixture();
    let release!: () => void;
    const committed = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    const wrapper = wrapGatewayVoiceStarter(f.start, { ...f.options, committed });
    const result = wrapper.start(request);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    wrapper.cancel();
    release();
    await expect(result).rejects.toThrow(/cancel/u);
    expect(f.start).not.toHaveBeenCalled();
    expect(f.projected()).toBe(false);
  });
  it("allows retry after cancellation while the old native start is still settling", async () => {
    const f = fixture();
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const firstStarted = vi.fn();
    const start = vi
      .fn()
      .mockImplementationOnce(async () => {
        firstStarted();
        await pending;
      })
      .mockResolvedValue("retry");
    const wrapper = wrapGatewayVoiceStarter(start, f.options);
    const first = wrapper.start(request);
    await vi.waitFor(() => expect(firstStarted).toHaveBeenCalledOnce());
    wrapper.cancel();
    await expect(wrapper.start(request)).resolves.toBe("retry");
    finish();
    await first;
  });
  it("rejects replaced subscriptions", async () => {
    const f = fixture();
    const wrapper = wrapGatewayVoiceStarter(f.start, {
      ...f.options,
      prepare: async () => ({ dispose: f.dispose, current: () => false }),
    });
    await expect(wrapper.start(request)).rejects.toThrow(/changed/u);
    expect(f.start).not.toHaveBeenCalled();
  });
});

// Registration is separate from the visible Composer and happens in a different realm.
import {
  installVoiceStartCapabilityHook,
  overlayVoiceStarterFibers,
} from "../src/renderer-voice-start-capability.js";
import { CLIENT_OWNED_VOICE_ASSETS } from "../src/renderer-client-owned-voice.js";

describe("overlay starter registration", () => {
  function registration(assets = CLIENT_OWNED_VOICE_ASSETS[0]) {
    if (!assets) throw new Error("Missing fixture profile");
    const register = vi.fn();
    const unregister = vi.fn();
    const native = new Proxy(
      { registerRealtimeStarter: register, unregisterRealtimeStarter: unregister },
      {
        set() {
          throw new Error("immutable RPC");
        },
      },
    );
    const services = { realtimeVoiceRuntime: native };
    const names = [assets.initial, assets.shared];
    const target = {
      __codexhostCpaLiveVoiceHookV1: {
        enabled: true,
        desktopVersion: assets.version,
        desktopPlatform: assets.platform,
        auditedDesktopVersion: "26.1007.30912",
        auditedAppInitialAsset: "app-initial-6350d04672d0.js",
      },
      location: { href: "app://-/index.html?initialRoute=/avatar-overlay" },
      document: {
        querySelectorAll: () =>
          names.map((name) => ({ getAttribute: () => `app://-/assets/${name}` })),
      } as unknown as Document,
      setTimeout,
      clearTimeout,
    };
    const importModule = vi.fn(async () => ({
      Oit() {},
      ist: services,
      Qot: services,
    }));
    return { register, unregister, native, services, names, target, importModule };
  }
  it.each(CLIENT_OWNED_VOICE_ASSETS)(
    "starts through the $version bridge with the committed overlay capability and restores it",
    async (assets) => {
      const f = registration(assets);
      // This Desktop can omit all resource timing and script asset names.
      f.names.length = 0;
      Object.assign(f.target, { __codexhostClientOwnedVoiceV1: { status: "active" } });
      type Atom = { read(get: (atom: Atom) => unknown): unknown; write?: boolean };
      const gate: Atom = { read: () => true, write: true };
      const atom: Atom = {
        read: (get) => ({ isLoading: false, isError: false, isCapable: !get(gate) }),
      };
      const store = {
        get: (a: Atom): unknown => a.read(store.get),
        sub: (atom: Atom, listener: () => void) => {
          void atom;
          void listener;
          return () => {};
        },
      };
      const signal = { atom, store };
      const original = () => store.get(atom);
      const subscriber = {
        getSnapshot: original,
        subscribe: (listener: () => void) => store.sub(atom, listener),
      };
      const instance = { getSnapshot: original };
      const committed = { memoizedState: original(), queue: instance, next: {} };
      const family = { scope: { id: Symbol() }, resolve: () => ({ atom: gate }) };
      const node = {
        store,
        familyBindings: new Map([
          [family, new Map([['{"name":"voice.realtime"}', { cacheKey: "voice" }]])],
        ]),
      };
      const chain = new Map([[family.scope.id, node]]);
      Object.assign(committed.next, {
        memoizedState: {
          create: () =>
            subscriber.subscribe(() => {
              committed.memoizedState = instance.getSnapshot();
            }),
          deps: [subscriber.subscribe],
        },
      });
      const page = () => {};
      const element = {
        __reactFiber$test: {
          memoizedState: {
            memoizedState: [signal, ["voice", chain, undefined, family, undefined]],
            next: { memoizedState: [subscriber, [signal, undefined]], next: committed },
          },
          return: { type: page, return: null },
        },
      };
      const query = f.target.document.querySelectorAll;
      f.target.document.querySelectorAll = ((selector: string) =>
        selector === "[data-avatar-overlay-native-surface-id]"
          ? [element]
          : query.call(f.target.document, selector)) as Document["querySelectorAll"];
      let reply: ((message: unknown) => void) | undefined;
      const dispatchMessage = vi.fn((type, message) => {
        expect(type).toBe("mcp-request");
        expect(message.request.method).toBe("codexhost/voice/gateway-status");
        reply?.({ hostId: "local", message: { id: message.request.id, result: true } });
      });
      const bridge = {
        subscribe: (_type: string, listener: (message: unknown) => void) => {
          reply = listener;
          return () => {
            reply = undefined;
          };
        },
        dispatchMessage,
      };
      const initialize = vi.fn();
      const importModule = async (url: string) =>
        url.endsWith(assets.shared)
          ? { [assets.services]: f.services, [assets.bridge]: { getInstance: () => bridge } }
          : url.endsWith(assets.overlay)
            ? { AvatarOverlayNativePage: page }
            : {
                [assets.capabilityInit]: initialize,
                [assets.capabilityFamily]: family,
                [assets.inferenceGateFamily]: family,
              };
      const handle = installVoiceStartCapabilityHook({ ...f, importModule });
      try {
        await vi.waitFor(() => expect(handle.status).toBe("active"));
        const start = vi.fn(async () => {
          expect(instance.getSnapshot()).toMatchObject({ isCapable: true });
          expect(store.get(gate)).toBe(true);
          return "existingCall";
        });
        f.services.realtimeVoiceRuntime.registerRealtimeStarter(start, vi.fn());
        const wrappedStart = f.register.mock.calls[0]?.[0];
        if (typeof wrappedStart !== "function") throw new Error("Missing registered starter");
        const launch =
          assets.version === "26.1021.31345"
            ? {
                source: "composer_button_existing_thread",
                productExperience: "codex",
                locator: { hostId: "local" },
              }
            : request;
        await expect(wrappedStart(launch)).resolves.toBe("existingCall");
        expect(start).toHaveBeenCalledOnce();
        expect(start).toHaveBeenCalledWith(launch);
        expect(initialize).toHaveBeenCalledOnce();
        expect(instance.getSnapshot).toBe(original);
      } finally {
        handle.dispose();
      }
    },
  );
  it.each(CLIENT_OWNED_VOICE_ASSETS)(
    "wraps the $version callback without modifying RPC stubs or registration readiness",
    async (assets) => {
      const f = registration(assets);
      const handle = installVoiceStartCapabilityHook(f);
      await vi.waitFor(() => expect(handle.status).toBe("active"));
      const start = vi.fn().mockResolvedValue("native-chat");
      const cancel = vi.fn();
      f.services.realtimeVoiceRuntime.registerRealtimeStarter(start, cancel, true);
      const [wrappedStart, wrappedCancel, workspaceReady] = f.register.mock.calls[0] ?? [];
      expect(workspaceReady).toBe(true);
      expect(wrappedStart).not.toBe(start);
      await wrappedStart({ ...request, productExperience: "chat" });
      expect(start).toHaveBeenCalledOnce();
      await expect(wrappedStart(request)).rejects.toThrow(/gateway/u);
      expect(start).toHaveBeenCalledOnce();
      wrappedCancel("user_cancelled");
      expect(cancel).toHaveBeenCalledWith("user_cancelled");
      f.services.realtimeVoiceRuntime.unregisterRealtimeStarter();
      expect(f.unregister).toHaveBeenCalledOnce();
      handle.dispose();
      expect(f.services.realtimeVoiceRuntime).toBe(f.native);
    },
  );
  it("does not install on the primary page or an unknown version", () => {
    const f = registration();
    f.target.location.href = "app://-/index.html";
    expect(installVoiceStartCapabilityHook(f).status).toBe("disabled");
    expect(f.importModule).not.toHaveBeenCalled();
  });
  it("excludes ancestors outside the exported native overlay page", () => {
    const page = () => {};
    const unrelated = { type: () => {}, return: null };
    const boundary = { type: page, return: unrelated };
    const starter = { type: () => {}, return: boundary };
    const element = { __reactFiber$test: starter };
    const doc = { querySelectorAll: () => [element] } as unknown as Document;
    expect([...overlayVoiceStarterFibers(doc, page)]).toEqual([starter]);
    expect(overlayVoiceStarterFibers(doc, () => {}).size).toBe(0);
  });
});
