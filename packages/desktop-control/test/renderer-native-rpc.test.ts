import { describe, expect, it, vi } from "vitest";
import { runInNewContext } from "node:vm";
import {
  nativeManagerDependencies,
  nativeRpcObjectShape,
  nativeRpcRole,
  withNativeRpcComponents,
} from "../src/renderer-native-rpc-discovery.js";
import { createNativeRpcService } from "../src/renderer-native-rpc-service.js";
import type {
  NativeRpcComponents,
  NativeRpcManager,
  NativeRpcManagerService,
  NativeRpcResult,
  NativeRpcState,
} from "../src/renderer-native-rpc-contracts.js";
import type { createNativeRemoteManager } from "../src/renderer-native-remote-manager.js";

describe("native RPC contract discovery", () => {
  it("evaluates its injected module allowlist and releases handles on unsupported layouts", async () => {
    const command = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === "Runtime.evaluate")
        return { result: { value: runInNewContext(String(params?.expression), {}) } };
      return {};
    });
    const install = vi.fn();
    await expect(withNativeRpcComponents({ command }, install)).resolves.toBe(false);
    expect(install).not.toHaveBeenCalled();
    expect(command).toHaveBeenLastCalledWith(
      "Runtime.releaseObjectGroup",
      expect.objectContaining({ objectGroup: expect.stringContaining("codexhost-native-rpc-") }),
    );
  });
  it("derives dependency bindings from the factory caller after symbols are renamed", () => {
    expect(
      nativeManagerDependencies("$build", [
        "function attach(scope,host){return add($build(scope,host,scope.get(requests,host),owns.bind(null,scope),(read,id)=>read(images,id)))}",
      ]),
    ).toEqual({
      requestDefinition: "requests",
      isHostForConversation: "owns",
      imageDefinition: "images",
    });
    expect(
      nativeManagerDependencies("make", [
        "make(s,h,s.get(r,h),o.bind(null,s),(g,i)=>g(p,i))",
        "make(s,h,s.get(other,h),o.bind(null,s),(g,i)=>g(p,i))",
      ]),
    ).toBeUndefined();
    expect(
      nativeManagerDependencies("make", ["make(s,h,s.get(r,other),o.bind(null,s),(g,i)=>g(p,i))"]),
    ).toBeUndefined();
  });
  it("does not mistake callable RPC members for scope handles or service exports", () => {
    const proxy = new Proxy({}, { get: () => () => undefined, has: () => true });
    expect(nativeRpcObjectShape(proxy)).toEqual({
      scope: false,
      controller: false,
      services: false,
    });
    expect(
      nativeRpcObjectShape({ node: {}, scope: {}, get() {}, set() {}, watch() {} }).scope,
    ).toBe(true);
    expect(
      nativeRpcObjectShape({
        appServerManagers: { subscribe() {} },
        remoteConnections: {},
        applicationMenu: {},
      }).services,
    ).toBe(true);
  });
  it("keeps the controller and RPC wrapper contracts distinct", () => {
    expect(
      nativeRpcRole("collectAppStateSnapshot getReviewPaneSnapshotMetrics registerReplayAdmission"),
    ).toBe("createController");
    expect(
      nativeRpcRole("getWorkInProgress getCachedThreadSearchSnapshot registerReplayAdmission"),
    ).toBe("RpcManager");
    expect(nativeRpcRole("registerReplayAdmission")).toBeUndefined();
  });
});

function rpcResult<T>(promise: Promise<T>): NativeRpcResult<T> {
  return Object.assign(promise, { onRpcBroken: vi.fn(), [Symbol.dispose]: vi.fn() });
}
function fixture() {
  let listener: (state: NativeRpcState) => void = () => {};
  let watcher: (() => void) | undefined;
  const state = { value: "connected" },
    revision = { value: 1 };
  const hostId = "remote-control:device";
  const lease = { onRpcBroken: vi.fn(), [Symbol.dispose]: vi.fn() };
  const service: NativeRpcManagerService = {
    dup() {
      return service;
    },
    onRpcBroken: vi.fn(),
    openAccount: vi.fn(),
    [Symbol.dispose]: vi.fn(),
    subscribe: vi.fn((_host, next) => {
      listener = next;
      return rpcResult(Promise.resolve(lease));
    }),
  };
  const manager: NativeRpcManager = {
    dup() {
      return manager;
    },
    onRpcBroken: vi.fn(),
    [Symbol.dispose]: vi.fn(),
    getCodexHome: vi.fn(() => rpcResult(Promise.resolve("C:\\Users\\tester\\.codex"))),
    sendRequest: vi.fn(() => rpcResult(Promise.resolve({}))),
    getConversation: vi.fn(() => rpcResult(Promise.resolve(null))),
    getWorkInProgress: vi.fn(() => rpcResult(Promise.resolve([]))),
    subscribe: vi.fn(() => rpcResult(Promise.resolve(lease))),
  };
  const scope = {
    node: {
      familyBindings: new Map([
        [
          {},
          new Map([
            [hostId, { value: { state$: state, revision$: revision, appServerVersion$: {} } }],
          ]),
        ],
      ]),
    },
    get: (signal: unknown) => (signal as { value: unknown }).value,
    watch(next: (scope: { get(signal: unknown): unknown }) => void) {
      watcher = () => next(scope);
      watcher();
      return () => {
        watcher = undefined;
      };
    },
  };
  const components = { scope, services: { appServerManagers: service } } as NativeRpcComponents;
  const contexts: ReturnType<typeof createNativeRemoteManager>[] = [];
  const create = vi.fn(() => {
    const context = {
      rpc: { ...manager },
      route: { hostId, manager: {}, policy: {} },
      dispose: vi.fn(),
    } as unknown as ReturnType<typeof createNativeRemoteManager>;
    contexts.push(context);
    return context;
  });
  const adapted = createNativeRpcService(components, create);
  const updates: NativeRpcState[] = [];
  return {
    hostId,
    manager,
    service,
    create,
    contexts,
    adapted,
    updates,
    subscribe: () => adapted.service.subscribe(hostId, (state) => updates.push(state)),
    ready: () => listener({ status: "ready", manager }),
    connection(value: string, nextRevision = revision.value) {
      state.value = value;
      revision.value = nextRevision;
      watcher?.();
    },
  };
}
const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe("native RPC remote service", () => {
  it("leaves SSH and POSIX Remote Control on the native service", async () => {
    const f = fixture();
    const callback = vi.fn();
    f.adapted.service.subscribe("remote-ssh:gateway", callback);
    expect(f.service.subscribe).toHaveBeenCalledWith("remote-ssh:gateway", callback);
    vi.mocked(f.manager.getCodexHome).mockImplementation(() =>
      rpcResult(Promise.resolve("/home/ubuntu/.codex")),
    );
    const pending = f.subscribe();
    f.ready();
    await settle();
    expect(f.create).not.toHaveBeenCalled();
    expect(f.updates.at(-1)).toEqual({ status: "ready", manager: f.manager });
    expect(f.adapted.route(f.hostId)).toBeUndefined();
    (await pending)[Symbol.dispose]();
    f.adapted.service[Symbol.dispose]();
  });
  it("replaces the bridge when a physical connection reuses the native manager", async () => {
    const f = fixture();
    const pending = f.subscribe();
    f.ready();
    await settle();
    const first = f.adapted.route(f.hostId);
    expect(first).toBe(f.contexts[0]?.route);
    f.connection("disconnected");
    expect(f.contexts[0]?.dispose).toHaveBeenCalledOnce();
    expect(f.adapted.route(f.hostId)).toBeNull();
    f.connection("connected", 2);
    await settle();
    expect(f.adapted.route(f.hostId)).toBe(f.contexts[1]?.route);
    expect(f.create).toHaveBeenCalledTimes(2);
    expect(f.manager.sendRequest).not.toHaveBeenCalled(); // no replay of submitted turns
    (await pending)[Symbol.dispose]();
    expect(f.contexts[1]?.dispose).toHaveBeenCalledOnce();
    f.adapted.service[Symbol.dispose]();
  });
  it("cannot publish a stale platform probe after disconnect or lease disposal", async () => {
    const f = fixture();
    let resolve!: (home: string) => void;
    vi.mocked(f.manager.getCodexHome).mockImplementation(() =>
      rpcResult(
        new Promise((done) => {
          resolve = done;
        }),
      ),
    );
    const pending = f.subscribe();
    f.ready();
    f.connection("disconnected");
    resolve("C:\\Users\\tester\\.codex");
    await settle();
    expect(f.create).not.toHaveBeenCalled();
    f.connection("connected", 2);
    pending[Symbol.dispose]();
    resolve("C:\\Users\\tester\\.codex");
    await settle();
    expect(f.create).not.toHaveBeenCalled();
    expect(f.adapted.route(f.hostId)).toBeUndefined();
    f.adapted.service[Symbol.dispose]();
  });
  it("keeps native Codex available after an unsupported contract without retrying", async () => {
    const f = fixture();
    f.create.mockImplementation(() => {
      throw new Error("unsupported Desktop contract");
    });
    const pending = f.subscribe();
    f.ready();
    await settle();
    expect(f.updates.at(-1)).toEqual({ status: "ready", manager: f.manager });
    f.connection("connected");
    await settle();
    expect(f.create).toHaveBeenCalledOnce();
    (await pending)[Symbol.dispose]();
    f.adapted.service[Symbol.dispose]();
  });

  it("does not publish a manager whose interaction subscriptions finish after disconnect", async () => {
    const f = fixture();
    let resolve: () => void = () => {};
    const create = f.create.getMockImplementation();
    if (!create) throw new Error("Missing fixture factory");
    f.create.mockImplementation(() => ({
      ...create(),
      ready: new Promise<void>((done) => {
        resolve = done;
      }),
    }));
    const pending = f.subscribe();
    f.ready();
    await settle();
    expect(f.adapted.route(f.hostId)).toBeNull();
    f.connection("disconnected");
    resolve();
    await settle();
    expect(f.adapted.route(f.hostId)).toBeNull();
    expect(f.contexts[0]?.dispose).toHaveBeenCalledOnce();
    (await pending)[Symbol.dispose]();
    f.adapted.service[Symbol.dispose]();
  });

  it("restores the native service when interaction subscriptions cannot be established", async () => {
    const f = fixture();
    const create = f.create.getMockImplementation();
    if (!create) throw new Error("Missing fixture factory");
    f.create.mockImplementation(() => ({
      ...create(),
      ready: Promise.reject(new Error("Unsupported subscription")),
    }));
    const pending = f.subscribe();
    f.ready();
    await settle();
    expect(f.updates.at(-1)).toEqual({ status: "ready", manager: f.manager });
    expect(f.contexts[0]?.dispose).toHaveBeenCalledOnce();
    (await pending)[Symbol.dispose]();
    f.adapted.service[Symbol.dispose]();
  });
});
