import { describe, expect, it, vi } from "vitest";
import { createNativeRemoteManager } from "../src/renderer-native-remote-manager.js";
import type {
  NativeRpcComponents,
  NativeRpcManager,
  NativeOwnedManager,
} from "../src/renderer-native-rpc-contracts.js";
import type { createDraftPrewarmPolicyBridge } from "../src/renderer-draft-prewarm-runtime.js";

describe("native Remote Control preload messages", () => {
  it("delivers preload notifications and approvals once, rejects foreign senders, and detaches on retirement", () => {
    const hostId = "remote-control:windows";
    class RequestClient {
      requestPromises = new Map();
      queuedRequests: unknown[] = [];
      constructor(
        readonly hostId: string,
        readonly dispatchMessage: (type: string, payload: unknown) => unknown,
      ) {}
      getAppServerVersion() {
        return "test";
      }
      setAppServerVersion() {}
      onError() {}
      onResult() {}
      sendRequest() {}
      enqueueRequest() {}
      prewarmThreadStart() {}
    }
    const listeners = new Set<(event: Event) => void>();
    const target = {
      location: { origin: "app://desktop" },
      addEventListener: (_type: string, callback: (event: Event) => void) => {
        listeners.add(callback);
      },
      removeEventListener: (_type: string, callback: (event: Event) => void) => {
        listeners.delete(callback);
      },
    };
    const manager = {
      onNotification: vi.fn(),
      onRequest: vi.fn(),
      sendAppServerResponse: vi.fn(),
      prewarmedThreadManager: {},
      getConversation: vi.fn(),
    } as unknown as NativeOwnedManager;
    const upstream = {
      dup: () => upstream,
      [Symbol.dispose]: vi.fn(),
    } as unknown as NativeRpcManager;
    const components = {
      scope: { get: () => new RequestClient(hostId, vi.fn()) },
      createManager: () => manager,
      isHostForConversation: vi.fn(),
      Manager: { dispose: vi.fn() },
    } as unknown as NativeRpcComponents;
    const policy = { dispose: vi.fn() } as unknown as ReturnType<
      typeof createDraftPrewarmPolicyBridge
    >;
    const remote = createNativeRemoteManager(
      components,
      hostId,
      upstream,
      target,
      () => policy,
      () => ({ rpc: upstream, dispose: vi.fn() }),
      () => ({ ready: Promise.resolve(), dispose: vi.fn() }),
    );
    const notify = {
      type: "mcp-notification",
      hostId,
      method: "turn/completed",
      params: { threadId: "owned" },
    };
    const request = {
      id: "approval-1",
      method: "item/commandExecution/requestApproval",
      params: { threadId: "owned" },
    };
    const emit = (data: unknown, source: unknown = null, origin?: string) => {
      const event = Object.assign(new Event("message"), { data, source, origin });
      for (const callback of listeners) callback(event);
    };
    emit(notify);
    emit({ type: "mcp-request", hostId, request });
    expect(manager.onNotification).toHaveBeenCalledExactlyOnceWith("turn/completed", notify.params);
    expect(manager.onRequest).toHaveBeenCalledExactlyOnceWith(request);
    emit(notify, {});
    emit(notify, target, "https://other.invalid");
    emit({ ...notify, hostId: "remote-control:other" });
    emit({ ...notify, method: "process/outputDelta" }); // bridge owns its frames
    expect(manager.onNotification).toHaveBeenCalledOnce();
    remote.dispose();
    emit(notify);
    expect(listeners.size).toBe(0);
    expect(policy.dispose).toHaveBeenCalledOnce();
    expect(manager.onNotification).toHaveBeenCalledOnce();
  });
});
