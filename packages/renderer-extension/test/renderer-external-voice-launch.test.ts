import type { RendererHostRouting } from "@codexhost/desktop-control/renderer-bindings";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AUDITED_CPA_LIVE_VOICE_APP_INITIAL_ASSET,
  AUDITED_CPA_LIVE_VOICE_DESKTOP_VERSION,
  CPA_LIVE_VOICE_HOOK_GLOBAL,
} from "../src/renderer-cpa-live-voice-hook.js";
import {
  CLIENT_OWNED_VOICE_INITIAL_ASSET,
  CLIENT_OWNED_VOICE_SHARED_ASSET,
} from "../src/renderer-client-owned-voice.js";
import {
  installExternalVoiceLaunchHook,
  routeExternalVoiceLaunch,
} from "../src/renderer-external-voice-launch.js";
import { applySharedVoiceRoutes } from "../src/renderer-cpa-live-voice-preference.js";

const carrier = "codexhost/plugin-v1@grok-test-model-permission";
const source = "composer_button_new_thread";
const request = () => ({
  source,
  activeCollaborationMode: {
    mode: "default",
    settings: { model: "gpt-6.1-sol", reasoning_effort: "high", developer_instructions: "keep" },
  },
  projectId: "project-1",
  pageCompanion: null,
});

function routingFixture() {
  const policy = { selectedModel: vi.fn<() => string | null>(() => carrier) };
  const route = { hostId: "local", policy };
  const routing = {
    forComposer: vi.fn(() => route),
    forHost: vi.fn((hostId: string) => (hostId === route.hostId ? route : null)),
  } as unknown as RendererHostRouting;
  return { policy, route, routing };
}

function hookFixture() {
  const { routing, policy } = routingFixture();
  const start = vi.fn(function (this: unknown, ...args: unknown[]) {
    return { receiver: this, args };
  });
  const other = vi.fn();
  // Native services are a plain decoded record containing immutable RPC stubs.
  const runtime = new Proxy(
    { requestRealtimeStart: start, registerRealtimeStarter: other },
    {
      set() {
        throw new Error("Can't assign properties on RPC stubs.");
      },
      defineProperty() {
        throw new Error("Can't define properties on RPC stubs.");
      },
    },
  );
  const services = { realtimeVoiceRuntime: runtime, untouched: {} };
  const names = [AUDITED_CPA_LIVE_VOICE_APP_INITIAL_ASSET, "app-shared-8bd9d0399038.js"];
  const target = {
    [CPA_LIVE_VOICE_HOOK_GLOBAL]: {
      enabled: true,
      auditedDesktopVersion: AUDITED_CPA_LIVE_VOICE_DESKTOP_VERSION,
      auditedAppInitialAsset: AUDITED_CPA_LIVE_VOICE_APP_INITIAL_ASSET,
    },
    __codexhostHostRoutingV1: routing,
    document: {
      querySelectorAll: () => names.map((name) => ({ getAttribute: () => `/assets/${name}` })),
    } as unknown as ParentNode,
    setTimeout,
    clearTimeout,
  };
  const importModule = vi.fn(async () => ({ fN: services }));
  return { policy, services, runtime, start, other, names, target, importModule };
}

const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
afterEach(() => vi.useRealTimers());

describe("native new-voice selection", () => {
  it("keeps the selected Harness on the client-owned-call Desktop build", async () => {
    const f = hookFixture();
    f.names.splice(
      0,
      f.names.length,
      CLIENT_OWNED_VOICE_INITIAL_ASSET,
      CLIENT_OWNED_VOICE_SHARED_ASSET,
    );
    const hook = installExternalVoiceLaunchHook({
      target: f.target,
      importModule: async () => ({ ist: f.services }),
    });
    await settle();
    expect(hook.status).toBe("active");
    const routed = f.services.realtimeVoiceRuntime.requestRealtimeStart(request()) as {
      args: unknown[];
    };
    expect(routed.args[0]).toMatchObject({
      activeCollaborationMode: { settings: { model: carrier } },
    });
    hook.dispose();
  });
  it("does not move Chat-mode Start Voice onto the selected Harness", () => {
    const { routing } = routingFixture();
    const original = { ...request(), productExperience: "chat" };
    expect(routeExternalVoiceLaunch(original, routing)).toBe(original);
  });
  it("keeps Work-mode Start Voice on the selected Harness", () => {
    const { routing } = routingFixture();
    const routed = routeExternalVoiceLaunch(
      { ...request(), productExperience: "work" },
      routing,
    ) as ReturnType<typeof request>;
    expect(routed.activeCollaborationMode.settings.model).toBe(carrier);
  });
  it("snapshots the external route into a separately cloned overlay request", () => {
    const { routing, policy } = routingFixture();
    const original = request();
    const routed = structuredClone(routeExternalVoiceLaunch(original, routing)) as ReturnType<
      typeof request
    >;
    // Overlay's native start builder consumes precisely this settings.model.
    const threadStart = { model: routed.activeCollaborationMode.settings.model };
    expect(threadStart.model).toBe(carrier);
    expect(routed.activeCollaborationMode.settings.developer_instructions).toBe("keep");
    expect(routed.projectId).toBe(original.projectId);
    expect(original.activeCollaborationMode.settings.model).toBe("gpt-6.1-sol");
    policy.selectedModel.mockReturnValue(null);
    expect(threadStart.model).toBe(carrier);
    expect(routeExternalVoiceLaunch(original, routing)).toBe(original);
  });

  it.each(["composer_button_existing_thread", "avatar", "global_hotkey"])(
    "preserves %s and its locator even with an external draft",
    (entry) => {
      const original = {
        ...request(),
        source: entry,
        locator: { hostId: "local", conversationId: "codex-1" },
      };
      const { routing, policy } = routingFixture();
      expect(routeExternalVoiceLaunch(original, routing)).toBe(original);
      expect(policy.selectedModel).not.toHaveBeenCalled();
    },
  );

  it("preserves official requests by identity after clearing external selection", () => {
    const { routing, policy } = routingFixture();
    policy.selectedModel.mockReturnValue(null);
    const original = request();
    expect(routeExternalVoiceLaunch(original, routing)).toBe(original);
  });

  it("does not borrow another Host or ambiguous Composer's draft", () => {
    const { routing, policy } = routingFixture();
    const remote = { ...request(), hostId: "remote-ssh-discovered:linux" };
    expect(routeExternalVoiceLaunch(remote, routing)).toBe(remote);
    vi.mocked(routing.forComposer).mockReturnValue(null);
    const local = request();
    expect(routeExternalVoiceLaunch(local, routing)).toBe(local);
    expect(policy.selectedModel).not.toHaveBeenCalled();
  });

  it("resolves the matching remote Host without using local selection", () => {
    const { routing, route } = routingFixture();
    route.hostId = "remote-ssh-discovered:linux";
    const remote = { ...request(), hostId: route.hostId };
    expect(routeExternalVoiceLaunch(remote, routing)).toMatchObject({
      hostId: route.hostId,
      activeCollaborationMode: { settings: { model: carrier } },
    });
    const local = request();
    expect(routeExternalVoiceLaunch(local, routing)).toBe(local);
  });

  it("constructs default collaboration settings when native launch has none", () => {
    const { routing } = routingFixture();
    expect(
      routeExternalVoiceLaunch({ source, activeCollaborationMode: null }, routing),
    ).toMatchObject({
      activeCollaborationMode: {
        mode: "default",
        settings: { model: carrier, reasoning_effort: null, developer_instructions: null },
      },
    });
  });
});

describe("versioned native voice service hook", () => {
  it("wraps the service reference and forwards the native RPC receiver, callbacks and return value", async () => {
    const fixture = hookFixture();
    const hook = installExternalVoiceLaunchHook(fixture);
    await settle();
    expect(hook.status).toBe("active");
    expect(installExternalVoiceLaunchHook(fixture)).toBe(hook);
    const contextProvider = () => "context";
    const result = fixture.services.realtimeVoiceRuntime.requestRealtimeStart(
      request(),
      "launch-1",
      contextProvider,
    );
    expect(result.receiver).toBe(fixture.runtime);
    expect(result.args).toEqual([
      expect.objectContaining({
        activeCollaborationMode: expect.objectContaining({
          settings: expect.objectContaining({ model: carrier }),
        }),
      }),
      "launch-1",
      contextProvider,
    ]);
    expect(fixture.services.realtimeVoiceRuntime.registerRealtimeStarter).toBe(fixture.other);
    expect(fixture.importModule).toHaveBeenCalledOnce();
    expect(fixture.importModule).toHaveBeenCalledWith("app://-/assets/app-shared-8bd9d0399038.js");
    hook.dispose();
    expect(fixture.services.realtimeVoiceRuntime).toBe(fixture.runtime);
  });

  it("passes official launches unchanged and preserves RPC failures", async () => {
    const fixture = hookFixture();
    const hook = installExternalVoiceLaunchHook(fixture);
    await settle();
    fixture.policy.selectedModel.mockReturnValue(null);
    const original = request();
    fixture.services.realtimeVoiceRuntime.requestRealtimeStart(original);
    expect(fixture.start.mock.calls[0]?.[0]).toBe(original);
    fixture.start.mockImplementation(() => {
      throw new Error("native failure");
    });
    expect(() => fixture.services.realtimeVoiceRuntime.requestRealtimeStart(original)).toThrow(
      "native failure",
    );
    hook.dispose();
  });

  it("does not import mismatched or absent audited assets", async () => {
    vi.useFakeTimers();
    const fixture = hookFixture();
    fixture.names[1] = "app-shared-different.js";
    const hook = installExternalVoiceLaunchHook(fixture);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(hook.status).toBe("unsupported");
    expect(fixture.importModule).not.toHaveBeenCalled();
    expect(fixture.services.realtimeVoiceRuntime).toBe(fixture.runtime);
    hook.dispose();
  });

  it("waits for native services initialization after importing the audited module", async () => {
    vi.useFakeTimers();
    const fixture = hookFixture();
    const module: { fN?: unknown } = {};
    const hook = installExternalVoiceLaunchHook({ ...fixture, importModule: async () => module });
    await settle();
    expect(hook.status).toBe("pending");
    module.fN = fixture.services;
    await vi.advanceTimersByTimeAsync(250);
    expect(hook.status).toBe("active");
    hook.dispose();
  });

  it("does not publish a hook after disposal during module import", async () => {
    const fixture = hookFixture();
    let resolve!: (value: Record<string, unknown>) => void;
    const pending = new Promise<Record<string, unknown>>((done) => {
      resolve = done;
    });
    const hook = installExternalVoiceLaunchHook({ ...fixture, importModule: () => pending });
    hook.dispose();
    resolve({ fN: fixture.services });
    await settle();
    expect(fixture.services.realtimeVoiceRuntime).toBe(fixture.runtime);
  });
});

describe("native Chat service interception", () => {
  it("awaits the native Chat START without entering the overlay's new-thread launcher", async () => {
    const f = hookFixture();
    const chatStart = vi.fn().mockResolvedValue(undefined);
    Object.assign(f.target, {
      __codexhostNativeChatVoiceV1: { status: "active", start: chatStart },
    });
    const hook = installExternalVoiceLaunchHook(f);
    await settle();
    await f.services.realtimeVoiceRuntime.requestRealtimeStart({
      ...request(),
      productExperience: "chat",
    });
    expect(chatStart).toHaveBeenCalledOnce();
    expect(f.start).not.toHaveBeenCalled();
    await f.services.realtimeVoiceRuntime.requestRealtimeStart({
      ...request(),
      productExperience: "work",
    });
    expect(f.start).toHaveBeenCalledOnce();
    expect(f.start.mock.calls[0]?.[0]).toMatchObject({
      activeCollaborationMode: { settings: { model: carrier } },
    });
    hook.dispose();
  });

  it.each(["absent", "disabled", "unsupported"])(
    "rejects native Chat when its binding is %s before the overlay can launch",
    async (status) => {
      const f = hookFixture();
      const chatStart = vi.fn();
      if (status !== "absent")
        Object.assign(f.target, {
          __codexhostNativeChatVoiceV1: { status, start: chatStart },
        });
      const hook = installExternalVoiceLaunchHook(f);
      try {
        await settle();
        await expect(
          f.services.realtimeVoiceRuntime.requestRealtimeStart({
            ...request(),
            productExperience: "chat",
          }),
        ).rejects.toThrow("Native Chat voice is unavailable");
        expect(chatStart).not.toHaveBeenCalled();
        expect(f.start).not.toHaveBeenCalled();
        await f.services.realtimeVoiceRuntime.requestRealtimeStart({
          ...request(),
          productExperience: "work",
        });
        expect(f.start).toHaveBeenCalledOnce();
      } finally {
        hook.dispose();
      }
    },
  );

  it.each(["desktop", "gateway"] as const)(
    "preserves explicit Codex Chat on %s without a native Chat binding",
    async (chatConnection) => {
      const f = hookFixture();
      applySharedVoiceRoutes(f.target, {
        chatExperience: "codex",
        chatConnection,
        workConnection: "gateway",
      });
      const hook = installExternalVoiceLaunchHook(f);
      try {
        await settle();
        await f.services.realtimeVoiceRuntime.requestRealtimeStart({
          ...request(),
          productExperience: "chat",
        });
        expect(f.start).toHaveBeenCalledOnce();
      } finally {
        hook.dispose();
      }
    },
  );

  it("does not fall back to a Grok/Codex overlay when native Chat START rejects", async () => {
    const f = hookFixture();
    Object.assign(f.target, {
      __codexhostNativeChatVoiceV1: {
        status: "active",
        start: vi.fn().mockRejectedValue(new Error("native start failed")),
      },
    });
    const hook = installExternalVoiceLaunchHook(f);
    await settle();
    await expect(
      f.services.realtimeVoiceRuntime.requestRealtimeStart({
        ...request(),
        productExperience: "chat",
      }),
    ).rejects.toThrow("native start failed");
    expect(f.start).not.toHaveBeenCalled();
    hook.dispose();
  });
});
