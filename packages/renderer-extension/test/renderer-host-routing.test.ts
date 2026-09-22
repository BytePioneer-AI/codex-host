import { installRendererDraftPrewarmPolicyDirect } from "@codexhost/desktop-control";
import { harnessIdSchema, hostThreadIdSchema } from "@codexhost/shared-contracts";
import { afterEach, expect, it, vi } from "vitest";
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
  const nativeSend = vi.fn(async (method: string, params: unknown) => {
    if (method === "codexhost/harness/inspect") return ready;
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
    sendRequest(method: string, params: unknown) {
      return this.requestClient.sendRequest(method, params);
    },
    prewarmedThreadManager: { discardAllPrewarmedThreads: vi.fn() },
    onNotification: vi.fn(),
    onRequest: vi.fn(),
    dispatchAppServerResponse: vi.fn(),
  };
}

async function setup(initialHostId: string) {
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
  const editor = { __reactFiber$host: fiber, parentElement: null, querySelectorAll: () => [] };
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
