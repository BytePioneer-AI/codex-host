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
import {
  CLIENT_OWNED_VOICE_INITIAL_ASSET,
  CLIENT_OWNED_VOICE_SHARED_ASSET,
} from "../src/renderer-client-owned-voice.js";

describe("overlay starter registration", () => {
  function registration() {
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
    const names = [CLIENT_OWNED_VOICE_INITIAL_ASSET, CLIENT_OWNED_VOICE_SHARED_ASSET];
    const target = {
      __codexhostCpaLiveVoiceHookV1: {
        enabled: true,
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
    const importModule = vi.fn(async () => ({ Oit() {}, ist: services }));
    return { register, unregister, native, services, target, importModule };
  }
  it("wraps the registered callback without modifying RPC stubs or registration readiness", async () => {
    const f = registration();
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
  });
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
