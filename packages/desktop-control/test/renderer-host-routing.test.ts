import { runInNewContext } from "node:vm";
import { assert, expect, it, vi } from "vitest";
import {
  installRendererDraftPrewarmPolicy,
  installRendererDraftPrewarmPolicyDirect,
} from "../src/renderer-draft-prewarm-policy.js";
import type { RendererHostRouting as Routing } from "../src/renderer-host-routing.js";

function setup(initialHostId: string) {
  const manager = (hostId: string) => ({
    getHostId: () => hostId,
    sendRequest: vi.fn(async () => ({})),
    requestClient: {
      hostId,
      sendRequest: vi.fn<(method: string, params: unknown) => Promise<unknown>>(async () => ({})),
      prewarmThreadStart: vi.fn(),
      enqueueRequest: vi.fn(),
      onResult: vi.fn(),
      onError: vi.fn(),
    },
    prewarmedThreadManager: { discardAllPrewarmedThreads: vi.fn() },
    onNotification: vi.fn(),
    onRequest: vi.fn(),
    dispatchAppServerResponse: vi.fn(),
  });
  const local = manager("local");
  const remote = manager("remote-ssh-discovered:linux");
  const managers = new Map([
    ["local", local],
    [remote.getHostId(), remote],
  ]);
  const registry = {
    addManager: vi.fn(),
    getForHostId: vi.fn((hostId: string) => managers.get(hostId)),
    waitForManagerForHostId: vi.fn(),
  };
  const fiber = {
    memoizedProps: { executionTargetHostId: initialHostId },
    memoizedState: { memoizedState: registry, next: { memoizedState: local, next: null } },
    return: null,
  };
  const editor = {
    __reactFiber$host: fiber,
    parentElement: null,
    matches: () => true,
    querySelectorAll: () => [],
  };
  const editors = [editor];
  const target: Record<string, unknown> = {};
  const renderer = {
    async evaluate<T>(expression: string): Promise<T> {
      return await runInNewContext(expression, {
        document: { querySelectorAll: () => editors },
        window: target,
        crypto: globalThis.crypto,
        TextEncoder,
        TextDecoder,
        Uint8Array,
        setTimeout,
        clearTimeout,
      });
    },
  };
  return { renderer, target, local, remote, managers, manager, fiber, editors };
}

it.each(["local", "remote-ssh-discovered:linux"])(
  "keeps both Hosts addressable and switches immediately from %s without a Controller poll",
  async (initialHostId) => {
    const fixture = setup(initialHostId);
    await installRendererDraftPrewarmPolicyDirect(fixture.renderer);
    const routing = fixture.target.__codexhostHostRoutingV1 as Routing;
    expect(routing).toBeDefined();
    try {
      expect(routing.forHost("local")?.manager).toBe(fixture.local);
      expect(routing.forHost(fixture.remote.getHostId())?.manager).toBe(fixture.remote);
      fixture.fiber.memoizedProps.executionTargetHostId = fixture.remote.getHostId();
      expect(routing.forComposer()?.manager).toBe(fixture.remote);
      fixture.fiber.memoizedProps.executionTargetHostId = "local";
      expect(routing.forComposer()?.manager).toBe(fixture.local);
      expect(routing.forHost(fixture.remote.getHostId())?.manager).toBe(fixture.remote);
    } finally {
      routing.dispose();
    }
  },
);

it("invalidates only the replaced Host and never revives its direct stale manager", async () => {
  const fixture = setup("local");
  await installRendererDraftPrewarmPolicyDirect(fixture.renderer);
  const routing = fixture.target.__codexhostHostRoutingV1 as Routing;
  expect(routing).toBeDefined();
  try {
    const local = routing.forHost("local");
    const remote = routing.forHost(fixture.remote.getHostId());
    fixture.managers.delete("local");
    expect(routing.forHost("local")).toBeNull();
    expect(() => local?.policy.requestTarget()).toThrow();
    expect(routing.forHost(fixture.remote.getHostId())).toBe(remote);
    const replacement = fixture.manager("local");
    fixture.managers.set("local", replacement);
    expect(routing.forHost("local")?.manager).toBe(replacement);
    expect(routing.forHost(fixture.remote.getHostId())).toBe(remote);
  } finally {
    routing.dispose();
  }
});

it("keeps selections per Host rather than copying a carrier to the newly active Host", async () => {
  const fixture = setup("local");
  const localSend = fixture.local.requestClient.sendRequest;
  const remoteSend = fixture.remote.requestClient.sendRequest;
  await installRendererDraftPrewarmPolicyDirect(fixture.renderer);
  const routing = fixture.target.__codexhostHostRoutingV1 as Routing;
  expect(routing).toBeDefined();
  try {
    routing.forHost("local")?.policy.select("codexhost/pi-native");
    fixture.fiber.memoizedProps.executionTargetHostId = fixture.remote.getHostId();
    routing.forComposer();
    await fixture.remote.requestClient.sendRequest("thread/start", { model: "native-model" });
    expect(remoteSend).toHaveBeenCalledWith("thread/start", { model: "native-model" });
    await fixture.local.requestClient.sendRequest("thread/start", { model: "native-model" });
    expect(localSend).toHaveBeenCalledWith("thread/start", { model: "codexhost/pi-native" });
  } finally {
    routing.dispose();
  }
});

it("does not unpublish the global policy when a scoped Composer cannot be read", async () => {
  const fixture = setup("local");
  await installRendererDraftPrewarmPolicyDirect(fixture.renderer);
  const routing = fixture.target.__codexhostHostRoutingV1 as Routing;
  try {
    const policy = fixture.target.__codexhostDraftPrewarmPolicyV1;
    const editor = fixture.editors[0];
    assert(editor);
    editor.matches = () => {
      throw new Error("Composer was retired");
    };
    expect(routing.forComposer(editor)).toBeNull();
    expect(fixture.target.__codexhostDraftPrewarmPolicyV1).toBe(policy);
    expect(routing.forHost("local")?.policy).toBe(policy);
  } finally {
    routing.dispose();
  }
});

it.each(["wrong-host", "bridge-mismatch", "malformed", "missing"])(
  "refuses a %s registry entry without using the local direct hook",
  async (mode) => {
    const fixture = setup("local");
    await installRendererDraftPrewarmPolicyDirect(fixture.renderer);
    const routing = fixture.target.__codexhostHostRoutingV1 as Routing;
    try {
      const original = routing.forHost("local");
      if (mode === "wrong-host") fixture.managers.set("local", fixture.remote);
      else if (mode === "bridge-mismatch")
        fixture.local.requestClient.hostId = fixture.remote.getHostId();
      else if (mode === "missing") fixture.managers.delete("local");
      else Reflect.deleteProperty(fixture.local, "prewarmedThreadManager");
      expect(routing.hostIdForComposer()).toBe("local");
      expect(routing.forComposer()).toBeNull();
      expect(routing.forHost("local")).toBeNull();
      expect(() => original?.policy.requestTarget()).toThrow("retired");
      expect(routing.forHost(fixture.remote.getHostId())?.manager).toBe(fixture.remote);
    } finally {
      routing.dispose();
    }
  },
);

it("keeps known remote identity when disconnected and does not misidentify it as local", async () => {
  const fixture = setup("remote-ssh-discovered:linux");
  await installRendererDraftPrewarmPolicyDirect(fixture.renderer);
  const routing = fixture.target.__codexhostHostRoutingV1 as Routing;
  try {
    fixture.managers.delete(fixture.remote.getHostId());
    expect(routing.hostIdForComposer()).toBe(fixture.remote.getHostId());
    expect(routing.forComposer()).toBeNull();
    expect(routing.forHost("local")?.manager).toBe(fixture.local);
    expect(routing.forHost("unknown")).toBeNull();
  } finally {
    routing.dispose();
  }
});

it("does not infer local from a direct hook while a registry-backed Composer identity is missing", async () => {
  const fixture = setup("remote-ssh-discovered:linux");
  await installRendererDraftPrewarmPolicyDirect(fixture.renderer);
  const routing = fixture.target.__codexhostHostRoutingV1 as Routing;
  try {
    fixture.fiber.memoizedProps.executionTargetHostId = "";
    expect(routing.hostIdForComposer()).toBeNull();
    expect(routing.forComposer()).toBeNull();
    expect(routing.forHost("local")?.manager).toBe(fixture.local);
    expect(routing.forHost(fixture.remote.getHostId())?.manager).toBe(fixture.remote);
  } finally {
    routing.dispose();
  }
});

it("evaluates the same native Host router through the Inspector transport", async () => {
  const fixture = setup("remote-ssh-discovered:linux");
  const fromId = vi.fn(() => ({
    isDestroyed: () => false,
    getType: () => "window",
    executeJavaScript: (expression: string) => fixture.renderer.evaluate(expression),
  }));
  const inspector = {
    async evaluate<T>(expression: string): Promise<T> {
      return await runInNewContext(expression, {
        process: { mainModule: { require: () => ({ webContents: { fromId } }) } },
      });
    },
  };
  await expect(installRendererDraftPrewarmPolicy(inspector, 17)).resolves.toMatchObject({
    state: "ready",
  });
  const routing = fixture.target.__codexhostHostRoutingV1 as Routing;
  try {
    expect(fromId).toHaveBeenCalledWith(17);
    expect(routing.forHost("local")?.manager).toBe(fixture.local);
    expect(routing.forComposer()?.manager).toBe(fixture.remote);
  } finally {
    routing.dispose();
  }
});

it.each(["direct", "inspector"])(
  "installs %s routing for co-mounted local and hidden remote Composers without a singleton",
  async (transport) => {
    const fixture = setup("local");
    const localEditor = fixture.editors[0];
    assert(localEditor);
    const remoteEditor = {
      ...localEditor,
      hidden: true,
      __reactFiber$host: {
        ...fixture.fiber,
        memoizedProps: { executionTargetHostId: fixture.remote.getHostId() },
      },
    };
    fixture.editors.push(remoteEditor);
    // Fail immediately on the baseline's ambiguous global installation gate,
    // rather than waiting out the real Controller's 60-second mount retry.
    const renderer = {
      async evaluate<T>(expression: string): Promise<T> {
        try {
          return await fixture.renderer.evaluate<T>(expression);
        } catch (error) {
          throw new Error("Mixed Host installation failed", { cause: error });
        }
      },
    };
    const inspector = {
      async evaluate<T>(expression: string): Promise<T> {
        return await runInNewContext(expression, {
          process: {
            mainModule: {
              require: () => ({
                webContents: {
                  fromId: () => ({
                    isDestroyed: () => false,
                    getType: () => "window",
                    executeJavaScript: (script: string) => renderer.evaluate(script),
                  }),
                },
              }),
            },
          },
        });
      },
    };
    try {
      await expect(
        transport === "direct"
          ? installRendererDraftPrewarmPolicyDirect(renderer)
          : installRendererDraftPrewarmPolicy(inspector, 17),
      ).resolves.toEqual({ state: "ready", reason: "owned-request-bridge" });
      const routing = fixture.target.__codexhostHostRoutingV1 as Routing;
      expect(routing.forComposer()).toBeNull();
      expect(fixture.target.__codexhostDraftPrewarmPolicyV1).toBeUndefined();
      expect(routing.forComposer(fixture.editors[0])?.manager).toBe(fixture.local);
      expect(routing.forComposer(remoteEditor)?.manager).toBe(fixture.remote);
      expect(routing.forComposer(fixture.editors[0])).toBe(routing.forHost("local"));
      expect(routing.forComposer(remoteEditor)).toBe(routing.forHost(fixture.remote.getHostId()));
      expect(fixture.target.__codexhostDraftPrewarmPolicyV1).toBeUndefined();
    } finally {
      (fixture.target.__codexhostHostRoutingV1 as Routing | undefined)?.dispose();
    }
  },
);

it("rejects an unavailable Inspector-owned Renderer before executing code", async () => {
  const inspector = {
    async evaluate<T>(expression: string): Promise<T> {
      return await runInNewContext(expression, {
        process: { mainModule: { require: () => ({ webContents: { fromId: () => null } }) } },
      });
    },
  };
  await expect(installRendererDraftPrewarmPolicy(inspector, 17)).rejects.toThrow(
    "Owned Renderer is unavailable",
  );
});
