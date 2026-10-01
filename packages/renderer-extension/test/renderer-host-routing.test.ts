import { installRendererDraftPrewarmPolicyDirect } from "@codexhost/desktop-control";
import { harnessIdSchema, hostThreadIdSchema } from "@codexhost/shared-contracts";
import { afterEach, assert, expect, it, vi } from "vitest";
import { installCurrentRendererAdapter } from "../src/versioned-renderer-adapter.js";

const remoteId = "remote-ssh-discovered:linux";
const piRequest = { harnessId: harnessIdSchema.parse("pi") };
const threadRequest = { threadId: hostThreadIdSchema.parse("thread-test") };
const ready = {
  status: "ready",
  catalog: { models: [], thinkingOptions: [] },
  capabilities: {
    configuration: {
      selectModel: false,
      selectThinkingOption: false,
      selectPermissionMode: false,
      permissionModeScope: "live",
    },
    history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
  },
};

function manager(hostId: string) {
  const nativeSend = vi.fn<
    (method: string, params: unknown, options?: unknown) => Promise<unknown>
  >(async (method, params) => {
    if (method === "codexhost/harness/inspect") return ready;
    if (method === "codexhost/thread/inspect") return { owner: "codex", locked: true };
    if (method === "codexhost/settings/idle-release/set") return params;
    return { threadId: "thread-test", usage: null };
  });
  const requestClient = {
    hostId,
    sendRequest: nativeSend,
    prewarmThreadStart: vi.fn(),
    enqueueRequest: vi.fn(),
    onResult: vi.fn(),
    onError: vi.fn(),
  };
  return {
    nativeSend,
    requestClient,
    getHostId: () => hostId,
    sendRequest(method: string, params: unknown, options?: unknown) {
      return options === undefined
        ? this.requestClient.sendRequest(method, params)
        : this.requestClient.sendRequest(method, params, options);
    },
    prewarmedThreadManager: { discardAllPrewarmedThreads: vi.fn() },
    onNotification: vi.fn(),
    onRequest: vi.fn(),
    dispatchAppServerResponse: vi.fn(),
  };
}

async function setup(initialHostId: string, coMountedHostIds: readonly string[] = []) {
  const local = manager("local");
  const remote = manager(remoteId);
  const managers = new Map([
    ["local", local],
    [remoteId, remote],
  ]);
  const registry = {
    addManager: vi.fn(),
    getForHostId: (hostId: string) => managers.get(hostId),
    waitForManagerForHostId: vi.fn(),
  };
  const fiber = {
    memoizedProps: { executionTargetHostId: initialHostId },
    memoizedState: { memoizedState: registry, next: { memoizedState: local } },
    return: null,
  };
  const editor = {
    __reactFiber$host: fiber,
    parentElement: null,
    matches: () => true,
    querySelectorAll: () => [],
    hidden: false,
  };
  const editors = [editor];
  const listeners = new EventTarget();
  vi.stubGlobal("window", {
    addEventListener: listeners.addEventListener.bind(listeners),
    removeEventListener: listeners.removeEventListener.bind(listeners),
    dispatchEvent: listeners.dispatchEvent.bind(listeners),
    setTimeout,
    clearTimeout,
  });
  vi.stubGlobal("document", {
    querySelectorAll: () => editors,
    querySelector: () => null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    documentElement: {},
  });
  const renderer = {
    async evaluate<T>(expression: string): Promise<T> {
      return await new Function(`return ${expression}`)();
    },
  };
  await installRendererDraftPrewarmPolicyDirect(renderer);
  for (const hostId of coMountedHostIds) {
    editors.push({
      ...editor,
      hidden: true,
      __reactFiber$host: { ...fiber, memoizedProps: { executionTargetHostId: hostId } },
    });
  }
  const adapter = installCurrentRendererAdapter();
  return { local, remote, managers, fiber, editors, adapter, renderer };
}

afterEach(() => {
  window.__codexhostHostRoutingV1?.dispose();
  vi.unstubAllGlobals();
});

it.each(["local", remoteId])(
  "queries both Hosts and follows switches immediately when %s opens first",
  async (hostId) => {
    const fixture = await setup(hostId);
    const { adapter, fiber } = fixture;
    try {
      const local = adapter.modelControl?.clientForHost?.("local");
      const remote = adapter.modelControl?.clientForHost?.(remoteId);
      expect(local).toBeTruthy();
      expect(remote).toBeTruthy();
      await expect(local?.inspectHarness(piRequest)).resolves.toMatchObject({ status: "ready" });
      await expect(remote?.inspectHarness(piRequest)).resolves.toMatchObject({ status: "ready" });
      for (const next of [remoteId, "local", remoteId, "local"]) {
        fiber.memoizedProps.executionTargetHostId = next;
        expect(adapter.modelControl?.currentHostId?.()).toBe(next);
        await expect(adapter.modelControl?.inspectThreadUsage(threadRequest)).resolves.toEqual({
          threadId: "thread-test",
          usage: null,
        });
        expect(adapter.modelControl?.clientForHost?.("local")).toBe(local);
        expect(adapter.modelControl?.clientForHost?.(remoteId)).toBe(remote);
      }
      expect(fixture.remote.nativeSend).not.toHaveBeenCalledWith(
        "codexhost/settings/idle-release/set",
        expect.anything(),
      );
    } finally {
      adapter.dispose();
    }
  },
);

it.each(["local", remoteId])(
  "reuses the validated %s route when reading current Host identity",
  async (hostId) => {
    const { adapter, managers } = await setup(hostId);
    const routing = window.__codexhostHostRoutingV1;
    assert(routing);
    const forComposer = vi.spyOn(routing, "forComposer");
    const hostIdForComposer = vi.spyOn(routing, "hostIdForComposer");
    const forHost = vi.spyOn(routing, "forHost");
    try {
      expect(adapter.modelControl?.currentHostId?.()).toBe(hostId);
      expect(forComposer).toHaveBeenCalledTimes(1);
      expect(hostIdForComposer).not.toHaveBeenCalled();
      if (hostId === "local") expect(forHost).not.toHaveBeenCalled();
      else expect(forHost).toHaveBeenCalledExactlyOnceWith("local");

      managers.delete(hostId);
      expect(adapter.modelControl?.currentHostId?.()).toBe(hostId);
      expect(hostIdForComposer).toHaveBeenCalledTimes(1);
      expect(adapter.status.state).toBe("installing");

      managers.set(hostId, manager(hostId));
      expect(adapter.modelControl?.currentHostId?.()).toBe(hostId);
      expect(adapter.status.state).toBe("ready");
      expect(hostIdForComposer).toHaveBeenCalledTimes(1);
    } finally {
      forComposer.mockRestore();
      hostIdForComposer.mockRestore();
      forHost.mockRestore();
      adapter.dispose();
    }
  },
);

it.each(["local", remoteId])(
  "preserves background discovery priority through every request wrapper on %s",
  async (hostId) => {
    const { adapter, local, remote, fiber, managers } = await setup(hostId);
    try {
      const native = hostId === "local" ? local : remote;
      await adapter.modelControl?.inspectHarness(piRequest, { priority: "background" });
      expect(native.nativeSend).toHaveBeenLastCalledWith("codexhost/harness/inspect", piRequest, {
        priority: "background",
      });

      const client = adapter.modelControl?.clientForHost?.(hostId);
      fiber.memoizedProps.executionTargetHostId = hostId === "local" ? remoteId : "local";
      await client?.inspectHarness(piRequest, { priority: "background" });
      expect(native.nativeSend).toHaveBeenLastCalledWith("codexhost/harness/inspect", piRequest, {
        priority: "background",
      });
      await client?.inspectThread(threadRequest);
      expect(native.nativeSend).toHaveBeenLastCalledWith("codexhost/thread/inspect", threadRequest);
      await client?.inspectHarness(piRequest);
      expect(native.nativeSend).toHaveBeenLastCalledWith("codexhost/harness/inspect", piRequest);

      const replacement = manager(hostId);
      managers.set(hostId, replacement);
      await expect(client?.inspectHarness(piRequest, { priority: "background" })).rejects.toThrow(
        "unavailable",
      );
      await adapter.modelControl
        ?.clientForHost?.(hostId)
        ?.inspectHarness(piRequest, { priority: "background" });
      expect(
        replacement.nativeSend.mock.calls.filter(
          ([method]) => method === "codexhost/harness/inspect",
        ),
      ).toEqual([["codexhost/harness/inspect", piRequest, { priority: "background" }]]);
      if (hostId !== "local") {
        expect(replacement.nativeSend).not.toHaveBeenCalledWith(
          "codexhost/settings/idle-release/set",
          expect.anything(),
        );
      }
    } finally {
      adapter.dispose();
    }
  },
);

it("retires only a disconnected Host and rejects new requests on its captured client", async () => {
  const { adapter, managers } = await setup(remoteId);
  try {
    const local = adapter.modelControl?.clientForHost?.("local");
    const remote = adapter.modelControl?.clientForHost?.(remoteId);
    managers.delete(remoteId);
    expect(adapter.modelControl?.clientForHost?.(remoteId)).toBeNull();
    await expect(remote?.inspectHarness(piRequest)).rejects.toThrow("unavailable");
    await expect(local?.inspectHarness(piRequest)).resolves.toMatchObject({ status: "ready" });
    managers.set(remoteId, manager(remoteId));
    const reconnected = adapter.modelControl?.clientForHost?.(remoteId);
    expect(reconnected).not.toBe(remote);
    await expect(reconnected?.inspectHarness(piRequest)).resolves.toMatchObject({
      status: "ready",
    });
    expect(adapter.modelControl?.clientForHost?.("local")).toBe(local);
  } finally {
    adapter.dispose();
  }
});

it("does not copy an external carrier to a native remote Composer", async () => {
  const { adapter, local, remote, fiber } = await setup("local");
  try {
    expect(adapter.applyAgent("pi")).toBe(true);
    fiber.memoizedProps.executionTargetHostId = remoteId;
    expect(adapter.modelControl?.currentHostId?.()).toBe(remoteId);
    await remote.requestClient.sendRequest("thread/start", { model: "native-model" });
    expect(remote.nativeSend).toHaveBeenCalledWith("thread/start", { model: "native-model" });
    await local.requestClient.sendRequest("thread/start", { model: "native-model" });
    expect(local.nativeSend).toHaveBeenCalledWith("thread/start", { model: "codexhost/pi-native" });
  } finally {
    adapter.dispose();
  }
});

it("retains native registry access during a settings overlay, not a stale connection", async () => {
  const { adapter, editors, managers } = await setup(remoteId);
  try {
    const local = adapter.modelControl?.clientForHost?.("local");
    editors.length = 0;
    expect(adapter.modelControl?.clientForHost?.("local")).toBe(local);
    managers.delete("local");
    expect(adapter.modelControl?.clientForHost?.("local")).toBeNull();
    expect(adapter.modelControl?.clientForHost?.(remoteId)).toBeTruthy();
  } finally {
    adapter.dispose();
  }
});

it("does not let a pending remote request block local requests or replay it on reconnect", async () => {
  const { adapter, remote, managers } = await setup(remoteId);
  try {
    let finish!: (value: unknown) => void;
    remote.nativeSend.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const oldClient = adapter.modelControl?.clientForHost?.(remoteId);
    if (!oldClient) throw new Error("Remote client is unavailable");
    const pending = oldClient.inspectHarness(piRequest);
    await expect(
      adapter.modelControl?.clientForHost?.("local")?.inspectHarness(piRequest),
    ).resolves.toMatchObject({ status: "ready" });
    const replacement = manager(remoteId);
    managers.set(remoteId, replacement);
    expect(adapter.modelControl?.clientForHost?.(remoteId)).not.toBe(oldClient);
    finish(ready);
    await expect(pending).resolves.toMatchObject({ status: "ready" });
    expect(replacement.nativeSend).not.toHaveBeenCalled();
    await expect(oldClient?.inspectHarness(piRequest)).rejects.toThrow("unavailable");
  } finally {
    adapter.dispose();
  }
});

it("resets unsupported-method observations only when the native connection is replaced", async () => {
  const { adapter, remote, fiber } = await setup(remoteId);
  try {
    remote.nativeSend.mockRejectedValueOnce(
      Object.assign(new Error("Method not found"), { code: -32601 }),
    );
    const oldClient = adapter.modelControl?.clientForHost?.(remoteId);
    await expect(oldClient?.inspectHarness(piRequest)).rejects.toThrow("unsupported");
    fiber.memoizedProps.executionTargetHostId = "local";
    adapter.modelControl?.currentHostId?.();
    fiber.memoizedProps.executionTargetHostId = remoteId;
    expect(adapter.modelControl?.clientForHost?.(remoteId)).toBe(oldClient);
    await expect(oldClient?.inspectHarness({ ...piRequest, refresh: true })).rejects.toThrow(
      "unsupported",
    );
    expect(remote.nativeSend).toHaveBeenCalledTimes(1);
    remote.requestClient = manager(remoteId).requestClient;
    const replacement = adapter.modelControl?.clientForHost?.(remoteId);
    expect(replacement).not.toBe(oldClient);
    await expect(replacement?.inspectHarness(piRequest)).resolves.toMatchObject({
      status: "ready",
    });
  } finally {
    adapter.dispose();
  }
});

it("is capability-ready with mixed mounted Hosts but never picks a global command route", async () => {
  const { adapter, editors, local, remote } = await setup("local", [remoteId]);
  const localComposer = editors[0] as unknown as Element;
  const remoteComposer = editors[1] as unknown as Element;
  try {
    expect(adapter.status).toMatchObject({
      state: "ready",
      reason: "ready",
      hook: "request-bridge",
    });
    const status = { ...adapter.status };
    expect(adapter.modelControl?.currentHostId?.(localComposer)).toBe("local");
    expect(adapter.modelControl?.currentHostId?.(remoteComposer)).toBe(remoteId);
    expect(adapter.statusForComposer(localComposer)).toMatchObject({ state: "ready" });
    expect(adapter.statusForComposer(remoteComposer)).toMatchObject({ state: "ready" });
    expect(adapter.status).toEqual(status);
    expect(adapter.modelControl?.currentHostId?.()).toBeNull();
    expect(adapter.status.state).toBe("ready");
    expect(adapter.applyAgent("pi")).toBe(false);
    expect(() => adapter.modelControl?.inspectHarness(piRequest)).toThrow("unavailable");
    expect(window.__codexhostDraftPrewarmPolicyV1).toBeUndefined();
    expect(adapter.applyAgent("pi", undefined, undefined, undefined, localComposer)).toBe(true);
    expect(adapter.applyAgent("codex", undefined, undefined, undefined, remoteComposer)).toBe(true);
    await remote.requestClient.sendRequest("thread/start", { model: "native-model" });
    await local.requestClient.sendRequest("thread/start", { model: "native-model" });
    expect(remote.nativeSend).toHaveBeenCalledWith("thread/start", { model: "native-model" });
    expect(local.nativeSend).toHaveBeenCalledWith("thread/start", { model: "codexhost/pi-native" });
  } finally {
    adapter.dispose();
  }
});

it("shares a validated manager for same-Host main and side chat Composers", async () => {
  const { adapter, editors } = await setup("local", ["local"]);
  try {
    const main = editors[0] as unknown as Element;
    const side = editors[1] as unknown as Element;
    const client = adapter.modelControl?.clientForHost?.("local");
    expect(adapter.modelControl?.currentHostId?.(main)).toBe("local");
    expect(adapter.modelControl?.currentHostId?.(side)).toBe("local");
    expect(adapter.statusForComposer(main).state).toBe("ready");
    expect(adapter.statusForComposer(side).state).toBe("ready");
    expect(adapter.modelControl?.clientForHost?.("local")).toBe(client);
    expect(adapter.modelControl?.currentHostId?.()).toBe("local");
  } finally {
    adapter.dispose();
  }
});

it.each(["disconnect", "replace"])(
  "rejects an actual Composer route retired by %s while retaining its Host identity",
  async (mode) => {
    const { adapter, editors, managers, local } = await setup("local");
    const composer = editors[0] as unknown as Element;
    const routing = window.__codexhostHostRoutingV1;
    assert(routing);
    const original = routing.forComposer(composer);
    assert(original);
    const oldSelect = vi.fn(original.policy.select);
    const staleRoute = { ...original, policy: { ...original.policy, select: oldSelect } };
    const capturedClient = adapter.modelControl?.clientForHost?.("local");
    if (mode === "disconnect") managers.delete("local");
    else managers.set("local", manager("local"));
    // Model obsolete scoped discovery; the current global registry is still
    // authoritative before reporting ready or selecting a carrier.
    const forComposer = vi.spyOn(routing, "forComposer").mockReturnValue(staleRoute);
    const before = { ...adapter.status };
    try {
      expect(adapter.modelControl?.currentHostId?.(composer)).toBe("local");
      expect(adapter.statusForComposer(composer)).toMatchObject({
        state: "installing",
        reason: "draft-routing-policy-unavailable",
        hook: null,
      });
      expect(adapter.applyAgent("pi", undefined, undefined, undefined, composer)).toBe(false);
      expect(oldSelect).not.toHaveBeenCalled();
      expect(adapter.status).toEqual(before);
      await expect(capturedClient?.inspectHarness(piRequest)).rejects.toThrow("unavailable");
      expect(local.nativeSend).not.toHaveBeenCalledWith("codexhost/harness/inspect", piRequest);
    } finally {
      forComposer.mockRestore();
      adapter.dispose();
    }
  },
);

it("does not change global readiness or Usage ownership during scoped Composer lookups", async () => {
  const { adapter, editors, remote, managers } = await setup(remoteId, ["local"]);
  const composer = editors[1] as unknown as Element;
  const routing = window.__codexhostHostRoutingV1;
  assert(routing);
  const forComposer = vi.spyOn(routing, "forComposer");
  // Establish the global Usage owner before introducing a disconnected scoped
  // Composer. Scoped identity/status reads must not reconnect that relay.
  const callbacks = new Set<(notification: unknown) => void>();
  const remove = vi.fn();
  Object.assign(remote, {
    addNotificationCallback: vi.fn(
      (_methods: unknown, callback: (notification: unknown) => void) => {
        callbacks.add(callback);
        return () => {
          callbacks.delete(callback);
          remove();
        };
      },
    ),
  });
  // Refresh the cached client after adding notifications.
  remote.requestClient = { ...remote.requestClient };
  forComposer.mockImplementation((target) => (target ? null : routing.forHost(remoteId)));
  const update = vi.fn();
  const unsubscribe = adapter.modelControl?.subscribeThreadUsage?.(update);
  try {
    await adapter.modelControl?.inspectThreadUsage(threadRequest);
    expect(callbacks.size).toBe(1);
    const status = { ...adapter.status };
    managers.delete("local");
    expect(adapter.modelControl?.currentHostId?.(composer)).toBe("local");
    expect(adapter.statusForComposer(composer).state).toBe("installing");
    expect(adapter.status).toEqual(status);
    expect(remove).not.toHaveBeenCalled();
    expect(callbacks.size).toBe(1);
    for (const callback of callbacks) {
      callback({ method: "turn/completed", params: threadRequest });
    }
    await vi.waitFor(() =>
      expect(update).toHaveBeenCalledWith({ threadId: "thread-test", usage: null }),
    );
  } finally {
    unsubscribe?.();
    forComposer.mockRestore();
    adapter.dispose();
  }
});

it("verifies native remote Codex ownership when that Host does not provide extension APIs", async () => {
  const { adapter, remote } = await setup(remoteId);
  try {
    remote.nativeSend.mockImplementation(async (method) => {
      if (method === "codexhost/thread/inspect")
        throw Object.assign(new Error("Method not found"), { code: -32601 });
      return { thread: { id: "thread-test", modelProvider: "openai", cliVersion: "0.155.1" } };
    });
    await expect(adapter.modelControl?.inspectThread(threadRequest)).resolves.toEqual({
      owner: "codex",
      locked: true,
    });
    expect(remote.nativeSend.mock.calls.map(([method]) => method)).toEqual([
      "codexhost/thread/inspect",
      "thread/read",
    ]);
  } finally {
    adapter.dispose();
  }
});
